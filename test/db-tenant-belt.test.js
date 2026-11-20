/**
 * #838 (C2-6): every id-keyed claim/finalize primitive in the five new repos
 * binds `AND community_id=?` — cross-tenant safety is a DATABASE law, not
 * just handler belts. The law asserted here for every mutator:
 *
 *   - a caller from ANOTHER community never wins (won:false / ok:false);
 *   - the foreign row answers as ABSENT (null / the missing-row error) —
 *     existence is never leaked to a probing tenant;
 *   - the probe mutates NOTHING (the owned row stays byte-stable);
 *   - the owning community still wins its own CAS afterwards;
 *   - a garbage communityId is a PROGRAMMER error: assertCommunityId throws
 *     (the posture every writer in this family already documented).
 *
 * Header contract (test/registry.test.js): loadDb() above every src/ require.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();
after(cleanup);

const T0 = Date.UTC(2026, 10, 19);

describe("#838 (C2-6): community-bound claim/finalize — the tenancy belt", () => {
  const A = communityKey("838-owner");
  const B = communityKey("838-intruder");

  let seq = 0;
  const uid = (p) => `838-${p}-${++seq}`;

  const mkBan = (communityId) => {
    const res = db.createBanRecord({
      communityId,
      userId: uid("ban"),
      source: "staff",
      reason: "raid",
      bannedAt: T0,
      expiresAt: T0 + 100 * 60_000,
    });
    assert.equal(res.ok, true, res.error);
    return res.record;
  };

  const openAppealUnder = (communityId) => {
    const ban = mkBan(communityId);
    const filed = db.fileAppeal({
      communityId,
      banRecordId: ban.id,
      appealStatement: "second chance",
      createdAt: T0,
    });
    assert.equal(filed.ok, true, filed.error);
    const att = db.attachAppealTicketChannel(communityId, filed.appeal.id, uid("chan"));
    assert.equal(att.won, true, att.error);
    const opened = db.openAppeal(communityId, filed.appeal.id);
    assert.equal(opened.won, true, opened.error);
    return opened.appeal;
  };

  const suggestedAction = (communityId) => {
    const res = db.insertAutomodActionSuggestion({
      communityId,
      guildId: uid("guild"),
      subjectUserId: uid("subj"),
      caseId: 900 + seq++,
      action: "warn",
      mode: "suggest",
    });
    assert.equal(res.ok, true, res.error);
    return res.row;
  };

  const freshCase = (communityId) => {
    const res = db.createAutomodCase({ communityId, referrerUserId: uid("ref") });
    assert.equal(res.ok, true, res.error);
    return res.case;
  };

  it("banRecords: six mutators refuse a foreign caller, leak nothing, mutate nothing", () => {
    const rec = mkBan(A);
    const before = db.getBanRecord(rec.id);

    const probes = [
      db.claimUnban(B, rec.id, T0),
      db.finalizeUnban(B, rec.id, "expired_unbanned", null, { nowMs: T0 }),
      db.markUnbannedManual(B, rec.id, "sneaky"),
      db.markExpiryHeld(B, rec.id, "sneaky", { nowMs: T0 }),
      db.noteExpiryAttempt(B, rec.id, { nowMs: T0 }),
      db.markExpiryFailed(B, rec.id, "sneaky", { nowMs: T0 }),
    ];
    for (const res of probes) {
      assert.equal(res.ok, true, `shape stays ok:true: ${res.error}`);
      assert.equal(res.won, false, "the foreign caller never wins");
      assert.equal(res.record, null, "the foreign row answers as ABSENT");
    }
    assert.deepEqual(db.getBanRecord(rec.id), before, "the probes mutated NOTHING (not even expiry_attempts)");

    // The owner still wins its own row.
    assert.equal(db.claimUnban(A, rec.id, T0).won, true, "the owning community claims normally");
  });

  it("banAppeals: attach/open/claim/reopen answer absence to the intruder", () => {
    const appeal = openAppealUnder(A);
    const before = db.getAppealById(appeal.id);

    const attach = db.attachAppealTicketChannel(B, appeal.id, uid("steal"));
    assert.deepEqual([attach.ok, attach.won, attach.appeal], [true, false, null]);
    // filed→open already done by the owner; the foreign probe reads absence, not the live row
    const open = db.openAppeal(B, appeal.id);
    assert.deepEqual([open.ok, open.won, open.appeal], [true, false, null]);
    const claim = db.claimAppealOutcome(B, appeal.id, { status: "denied", decidedBy: "intruder" });
    assert.deepEqual([claim.ok, claim.won, claim.appeal], [true, false, null]);
    const reopen = db.reopenAppealAfterFailedExecution(B, appeal.id);
    assert.deepEqual([reopen.ok, reopen.won, reopen.appeal], [true, false, null]);

    assert.deepEqual(db.getAppealById(appeal.id), before, "no probe touched the row");

    // The owner's decision still lands.
    const mine = db.claimAppealOutcome(A, appeal.id, { status: "granted", decidedBy: "mod" });
    assert.equal(mine.won, true, mine.error);
  });

  it("automodCaseActions: claim/dismiss/finalize refuse outsiders with the MISSING answer", () => {
    const sug = suggestedAction(A);
    for (const res of [
      db.claimAutomodSuggestion(B, sug.id, "intruder"),
      db.dismissAutomodSuggestion(B, sug.id, "intruder"),
      db.recordAutomodActionResult(B, sug.id, { state: "executed", resultText: "nope" }),
    ]) {
      assert.equal(res.ok, false, "claims of a foreign row are ERRORS (never a fake dedupe)");
      assert.match(res.error, /No auto-mod action row #/);
      assert.equal(res.row, undefined, "no row of another tenant is ever returned");
    }
    assert.equal(db.getAutomodAction(sug.id).state, "suggested", "untouched");

    assert.equal(db.claimAutomodSuggestion(A, sug.id, "mod").ok, true, "owner claims fine");
  });

  it("automodCases: incident-summary/reveal/resolve refuse a foreign communityId", () => {
    const kase = freshCase(A);
    assert.deepEqual(
      db.setAutomodCaseIncidentSummary(B, kase.id, "forged summary"),
      { ok: false, error: `No auto-mod case row #${kase.id}.` },
    );
    const reveal = db.revealAutomodCaseReporter(B, kase.id, "intruder");
    assert.equal(reveal.ok, false);
    assert.match(reveal.error, /No auto-mod case row/);
    const resolve = db.resolveAutomodCase(B, kase.id, "recommended", "intruder");
    assert.equal(resolve.ok, false);
    assert.match(resolve.error, /No auto-mod case row/);

    const live = db.getAutomodCaseById(kase.id);
    assert.equal(live.incident_summary, kase.incident_summary ?? null, "summary NOT written");
    assert.equal(live.revealed_at, null, "not revealed");
    assert.equal(live.resolved_at, null, "not resolved");

    // owner paths still work end-to-end
    assert.equal(db.revealAutomodCaseReporter(A, kase.id, "mod").revealed, true);
    assert.equal(db.resolveAutomodCase(A, kase.id, "recommended", "mod").won, true);
  });

  it("insertTicketReport: filing into ANOTHER tenant's ticket is 'Ticket not found.'", () => {
    const ticket = db.createTicket({
      communityId: A,
      creatorUserId: uid("creator"),
      channelId: uid("chan"),
      reason: "838 fixture",
    });
    const foreign = db.insertTicketReport({
      communityId: B,
      ticketId: ticket.id,
      kind: "user",
      subjectUserId: uid("subject"),
    });
    assert.equal(foreign.ok, false);
    assert.match(foreign.error, /Ticket not found/);
    assert.equal(db.getTicketReport(ticket.id), null, "no row leaked into the foreign ticket");

    const mine = db.insertTicketReport({
      communityId: A,
      ticketId: ticket.id,
      kind: "user",
      subjectUserId: uid("subject"),
    });
    assert.equal(mine.ok, true, mine.error);
  });

  it("setAutomodCaseStatus refuses a foreign community (and stays the CAS it became)", () => {
    const kase = freshCase(B);
    assert.equal(kase.status, "recorded", "fresh cases start recorded");
    // case_number is PER-COMMUNITY: the scoped getAutomodCase(A, n) cannot
    // see B's row — a foreign community simply has no such case number.
    const probe = db.setAutomodCaseStatus(A, kase.case_number, "processing");
    // A owns cases from earlier probes; assert against a number NO tenant
    // owns so the answer is unambiguous.
    const absent = db.setAutomodCaseStatus(A, 987_654, "processing");
    assert.equal(absent.ok, false);
    assert.match(absent.error, /No auto-mod case A-987654 in this community\./);
    if (!probe.ok) assert.match(probe.error, /in this community\./, "refused via the scoped read");
    assert.equal(db.getAutomodCaseById(kase.id).status, "recorded", "B's row untouched");
  });

  it("garbage communityId is a PROGRAMMER error: every belt throws, never guesses", () => {
    const rec = mkBan(A);
    // typeof/number messages come from the single assertCommunityId source.
    assert.throws(() => db.claimUnban(null, rec.id, T0), /community/i);
    assert.throws(() => db.claimAutomodSuggestion(undefined, 1, "x"), /community/i);
    assert.throws(() => db.openAppeal(1.5, 1), /community/i);
    assert.throws(
      () => db.insertTicketReport({ communityId: null, ticketId: 1, kind: "user", subjectUserId: "u" }),
      /community/i,
    );
  });
});
