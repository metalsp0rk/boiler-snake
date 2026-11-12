/**
 * banAppeals repository unit suite (#773). Storage law only (mirror of the
 * #772 ban-records battery — same discipline, same header contract):
 * - BAN_APPEAL_STATUSES is asserted against the ACTUAL migration-075 CHECK
 *   text parsed from sqlite_master (code/schema drift is the bug class);
 *   APPEAL_OUTCOMES is the CLOSED decision domain — `filed`/`open` are states
 *   you pass through, never claim destinations;
 * - one appeal per ban cycle is the 075 UNIQUE(ban_record_id) belt: the repo
 *   maps the named index's message to code APPEAL_EXISTS (the raw-text
 *   contract the matcher keys on is pinned here exactly like the sibling
 *   suite pins BAN_NUMBER_RACE's text — the schema file owns the index);
 * - outcome claims follow the claimUnban/resolveAutomodCase law: first-
 *   decision-wins, the loser gets { ok:true, won:false } + the LIVE row and
 *   mutates NOTHING (byte-identical row assertions);
 * - cursors are a PAIR per direction or nothing (half a cursor is a resume-
 *   time lie), last-write-wins, per-direction isolation;
 * - ferry pause is relay-only state with NO status coupling, in either
 *   direction (pausing never decides; deciding never locks the knob);
 * - every community-scoped export runs assertCommunityId (throw = programmer
 *   error); appeal-scoped primitives answer "No such ban appeal." /
 *   {ok:true,won:false,appeal:null} instead of throwing at runtime;
 * - cross-community filings are refused BEFORE the FK (storage integrity,
 *   not feature policy); community deletion cascades appeals away and the
 *   repo reads honestly answer null/won:false afterwards.
 *
 * Division of labor (no duplication): test/migrations-ban-lifecycle-074.test.js
 * owns the 075 SCHEMA law (column order, CHECK accept/reject at raw INSERT,
 * FK unscoped/dangling, cascade, replay idempotence) and
 * test/migrations-ban-appeals-075.test.js owns the pre-075→075 rebuild. This
 * file pins the REPOSITORY surface: its {ok:false} codes, claim semantics,
 * cursor/pause law, and the constraint-text contracts its matchers depend on.
 *
 * Header contract (test/registry.test.js): loadDb() runs ABOVE every src/
 * require; every timestamp the repo accepts is injected (T0 + offsets); the
 * repo-internal now() stamps (attach/open/cursor/pause updated_at) are pinned
 * for EXISTENCE only — never value-compared against the wall clock.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();
after(cleanup);

// ── deterministic clock ─────────────────────────────────────────────────────
const T0 = Date.UTC(2026, 10, 1);
const MIN = 60_000;

let seq = 0;
const uid = (label = "u") => `773-${label}-${++seq}`;

let userSeq = 0;
const userId = () => `88${String(++userSeq).padStart(17, "0")}`;

/** Ban-record seed that must succeed — a broken seed fails loudly. */
function mkBan(communityId, over = {}) {
  const res = db.createBanRecord({
    communityId,
    userId: userId(),
    source: "staff",
    reason: "raid",
    bannedAt: T0,
    ...over,
  });
  assert.equal(res.ok, true, `ban seed failed: ${res.error}`);
  return res.record;
}

/** Appeal seed that must succeed. */
function fileOk(
  communityId,
  banRecordId,
  statement = "I would like to appeal this ban",
  createdAt = T0,
) {
  const res = db.fileAppeal({ communityId, banRecordId, appealStatement: statement, createdAt });
  assert.equal(res.ok, true, `appeal seed failed: ${res.error}`);
  return res.appeal;
}

/** File → attach → open. The claim domain starts at `open`. */
function openOk(communityId, banRecordId, channel = uid("chan")) {
  const appeal = fileOk(communityId, banRecordId);
  assert.equal(db.attachAppealTicketChannel(appeal.id, channel).won, true);
  assert.equal(db.openAppeal(appeal.id).won, true, "seed must reach the claim domain");
  return db.getAppealById(appeal.id);
}

const appealRow = (id) => db.getAppealById(id);

/** Garbage community ids for the assertCommunityId battery (per typeof msg). */
const GARBAGE_CIDS = ["1554590611015729152", null, undefined, NaN, 1.5, 0, -1];

function assertGuarded(label, call) {
  for (const bad of GARBAGE_CIDS) {
    assert.throws(
      () => call(bad),
      { message: `community id required, got ${typeof bad}` },
      `${label} must run assertCommunityId on ${JSON.stringify(bad) ?? String(bad)}`,
    );
  }
}

/** Garbage appeal ids — the runtime {ok:false} answer (never a throw). */
const GARBAGE_APPEAL_IDS = [0, -1, "", "abc", "nope", null, undefined, {}, 1.5];

describe("banAppeals — vocabulary mirrors the 075 CHECK", () => {
  const tableSql = db.db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='ban_appeals'`)
    .get().sql;

  const inList = (clause) =>
    tableSql
      .match(new RegExp(`${clause}\\s+IN \\(([^)]*)\\)`, "i"))[1]
      .split(",")
      .map((s) => s.trim().replace(/'/g, ""));

  it("BAN_APPEAL_STATUSES === the schema's status CHECK, exactly (drift tripwire)", () => {
    assert.deepEqual([...inList("status")], [...db.BAN_APPEAL_STATUSES]);
    assert.ok(Object.isFrozen(db.BAN_APPEAL_STATUSES), "code-side source is frozen");
  });

  it("APPEAL_OUTCOMES is the CLOSED decision domain — filed/open are never claim destinations", () => {
    assert.deepEqual([...db.APPEAL_OUTCOMES], ["granted", "denied", "closed"]);
    assert.ok(Object.isFrozen(db.APPEAL_OUTCOMES));
    for (const outcome of db.APPEAL_OUTCOMES) {
      assert.ok(db.BAN_APPEAL_STATUSES.includes(outcome), "outcomes ride inside the CHECK domain");
    }
    assert.ok(!db.APPEAL_OUTCOMES.includes("filed") && !db.APPEAL_OUTCOMES.includes("open"));
  });

  it("the ferry direction set is exactly the two 075 cursor directions", () => {
    assert.deepEqual([...db.APPEAL_FERRY_DIRECTIONS], ["user", "ticket"]);
    assert.ok(Object.isFrozen(db.APPEAL_FERRY_DIRECTIONS));
  });

  it("the widened ban_records domain keeps its append at the END (stable-id + order law)", () => {
    // The constant↔CHECK mirror is the ban-records file's pin; this one
    // guards the append-only ORDER that #773's `appeal:<banRecordId>` seam
    // inherits from 074's stable-id contract. #809 appended `expired_held`
    // at the END (076) — pinning the WHOLE sequence keeps the law: every
    // earlier status keeps its slot, new vocabulary only ever appends.
    assert.deepEqual(
      [...db.BAN_RECORD_STATUSES],
      [
        "active",
        "expired_unbanned",
        "unbanned_manual",
        "pending_rejoin",
        "welcomed",
        "clemency_granted",
        "expired_held",
      ],
    );
  });
});

describe("banAppeals.fileAppeal — intake round-trip + validation battery", () => {
  const CID = communityKey("773-repo-file");

  it("stores a FILED row with the injected clock and returns the LIVE row", () => {
    const rec = mkBan(CID);
    const res = db.fileAppeal({
      communityId: CID,
      banRecordId: rec.id,
      appealStatement: "  I was misidentified — please review  ",
      createdAt: T0,
    });
    assert.equal(res.ok, true, res.error);
    const appeal = res.appeal;
    assert.deepEqual(appeal, appealRow(appeal.id), "record is the live row");
    assert.equal(appeal.community_id, CID);
    assert.equal(appeal.ban_record_id, rec.id);
    assert.equal(appeal.status, "filed", "intake lands filed until the ticket opens");
    assert.equal(appeal.appeal_statement, "I was misidentified — please review", "statement trims");
    assert.equal(appeal.created_at, T0, "injected clock lands verbatim");
    assert.equal(appeal.updated_at, T0, "the filing instant is the update instant");
    assert.equal(appeal.ferry_paused, 0, "the relay is never paused at rest");
    for (const col of [
      "ticket_channel_id",
      "ferry_user_msg_id",
      "ferry_user_ts",
      "ferry_ticket_msg_id",
      "ferry_ticket_ts",
      "decided_by",
      "decided_at",
      "denial_reason",
    ]) {
      assert.equal(appeal[col], null, `${col} starts absent`);
    }
  });

  it("answers invalid input with SPECIFIC {ok:false,error} — never a throw, never a generic", () => {
    const rec = mkBan(CID);
    const cases = [
      [{ appealStatement: "" }, /needs a written statement/],
      [{ appealStatement: "   " }, /needs a written statement/, "blank statement is absent"],
      [{ appealStatement: null }, /needs a written statement/],
      [{ banRecordId: 0 }, /needs the ban record id/],
      [{ banRecordId: -1 }, /needs the ban record id/],
      [{ banRecordId: "abc" }, /needs the ban record id/],
      [{ banRecordId: null }, /needs the ban record id/],
    ];
    for (const [over, pattern, note] of cases) {
      const res = db.fileAppeal({
        communityId: CID,
        banRecordId: rec.id,
        appealStatement: "fine",
        ...over,
      });
      assert.equal(res.ok, false, note || JSON.stringify(over));
      assert.match(res.error, pattern);
    }
  });

  it("re-checks the 4000-char statement cap (the modal clamps first; no caller stores over-cap)", () => {
    const rec = mkBan(CID);
    const tooLong = db.fileAppeal({
      communityId: CID,
      banRecordId: rec.id,
      appealStatement: "x".repeat(db.MAX_APPEAL_STATEMENT + 1),
    });
    assert.equal(tooLong.ok, false);
    assert.match(tooLong.error, /too long \(max 4000 characters\)/);
    // Boundary: exactly at cap stores fine (the repo must not refuse what
    // the platform just allowed).
    assert.equal(
      db.fileAppeal({
        communityId: CID,
        banRecordId: rec.id,
        appealStatement: "y".repeat(db.MAX_APPEAL_STATEMENT),
      }).ok,
      true,
    );
  });

  it("a nonexistent ban record answers 'No such ban record to appeal.' — an honest read, not an FK crash", () => {
    const res = db.fileAppeal({
      communityId: CID,
      banRecordId: 9_999_999,
      appealStatement: "appealing nothing",
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, "No such ban record to appeal.");
  });

  it("a cross-community record is REFUSED before the FK would sail through (storage integrity law)", () => {
    const other = communityKey("773-repo-file-other");
    const foreign = mkBan(other);
    const res = db.fileAppeal({
      communityId: CID,
      banRecordId: foreign.id,
      appealStatement: "not my community's ban",
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /belongs to another community/);
    // Count THIS record's appeals only — the describe's earlier filings
    // legitimately hold CID rows (per-file DB, shared community).
    const linked = db.db
      .prepare(`SELECT COUNT(*) n FROM ban_appeals WHERE ban_record_id=?`)
      .get(foreign.id).n;
    assert.equal(linked, 0, "the refusal stored nothing");
  });

  it("numeric-string record ids coerce (the appeal:<banRecordId> customId seam arrives as text)", () => {
    const rec = mkBan(CID);
    const res = db.fileAppeal({
      communityId: CID,
      banRecordId: String(rec.id),
      appealStatement: "customId-shaped id",
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.appeal.ban_record_id, rec.id);
  });

  it("storage law only: a CLOSED ban cycle is filable (record-active is feature policy, not schema)", () => {
    const rec = mkBan(CID);
    assert.equal(db.finalizeUnban(rec.id, "expired_unbanned", null, { nowMs: T0 + MIN }).won, true);
    assert.equal(
      db.fileAppeal({ communityId: CID, banRecordId: rec.id, appealStatement: "late appeal" }).ok,
      true,
    );
  });

  it("runs assertCommunityId before anything else", () => {
    assertGuarded("fileAppeal", (bad) =>
      db.fileAppeal({ communityId: bad, banRecordId: 1, appealStatement: "x" }),
    );
  });
});

describe("banAppeals — ONE appeal per ban cycle (the 075 UNIQUE belt)", () => {
  const CID = communityKey("773-repo-cycle");

  it("a second filing for the same record is {ok:false, code:APPEAL_EXISTS} via the REAL UNIQUE", () => {
    const rec = mkBan(CID);
    const first = fileOk(CID, rec.id);
    const dup = db.fileAppeal({
      communityId: CID,
      banRecordId: rec.id,
      appealStatement: "second press of the same button",
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.code, "APPEAL_EXISTS");
    assert.match(dup.error, /one appeal per ban cycle/);
    // The first filing is untouched — a losing race never rewrites history.
    assert.deepEqual(appealRow(first.id), first);
    const rows = db.db
      .prepare(`SELECT id FROM ban_appeals WHERE ban_record_id=?`)
      .all(rec.id);
    assert.equal(rows.length, 1, "exactly one appeal rides the cycle");
  });

  it("the constraint message carries 'ban_appeals.ban_record_id' — the fileAppeal matcher's contract", () => {
    // better-sqlite3 is synchronous in-process, so a live double-press race
    // is untestable here; what this suite CAN pin is the exact substring
    // fileAppeal's catch maps to APPEAL_EXISTS (the 074-guard suite pins the
    // index itself; sibling law: the repo file pins the message contract).
    const rec = mkBan(CID);
    fileOk(CID, rec.id);
    assert.throws(
      () =>
        db.db
          .prepare(
            `INSERT INTO ban_appeals (community_id, ban_record_id, appeal_statement, ferry_paused, created_at, updated_at)
             VALUES (?, ?, 'raw collision', 0, ?, ?)`,
          )
          .run(CID, rec.id, T0, T0),
      (err) => {
        assert.match(
          err.message,
          /UNIQUE constraint failed: ban_appeals\.ban_record_id/,
          "repo matcher substring must ride in the message",
        );
        return true;
      },
    );
  });

  it("a NEW ban cycle gets a NEW appeal (the belt is per-cycle, not per-user)", () => {
    const first = mkBan(CID, { userId: "992000000000000001" });
    fileOk(CID, first.id);
    assert.equal(db.finalizeUnban(first.id, "expired_unbanned", null, { nowMs: T0 + MIN }).won, true);
    const second = db.createBanRecord({
      communityId: CID,
      userId: "992000000000000001",
      source: "staff",
      reason: "round two",
      bannedAt: T0 + 2 * MIN,
    });
    assert.equal(second.ok, true, second.error);
    assert.notEqual(second.record.id, first.id, "ids never reused — appeal:<id> stays stable");
    const res = db.fileAppeal({
      communityId: CID,
      banRecordId: second.record.id,
      appealStatement: "fresh cycle, fresh appeal",
    });
    assert.equal(res.ok, true, res.error);
  });
});

describe("banAppeals.getAppealById / getAppealByTicketChannel", () => {
  const CID = communityKey("773-repo-read");

  it("getAppealById coerces numeric-string ids and null-guards garbage", () => {
    const appeal = fileOk(CID, mkBan(CID).id);
    assert.equal(appealRow(String(appeal.id)).id, appeal.id);
    for (const bad of [0, -1, "abc", null, {}, 1.5, undefined]) {
      assert.equal(db.getAppealById(bad), null, `${JSON.stringify(bad) ?? String(bad)} is null`);
    }
    assert.equal(db.getAppealById(9_999_999), null, "missing id is null, not a throw");
  });

  it("NULL-channel rows are NEVER matched (a filed appeal answers null)", () => {
    const filed = fileOk(CID, mkBan(CID).id);
    assert.equal(filed.ticket_channel_id, null, "fixture: no channel yet");
    assert.equal(db.getAppealByTicketChannel(CID, "4242"), null, "no row owns that channel");
  });

  it("attach → lookup by channel; a same-channel neighbor community reads its OWN row", () => {
    const mine = fileOk(CID, mkBan(CID).id);
    assert.equal(db.attachAppealTicketChannel(mine.id, "shared-channel").won, true);
    assert.equal(db.getAppealByTicketChannel(CID, "shared-channel").id, mine.id);

    const neighbor = communityKey("773-repo-read-b");
    const theirs = fileOk(neighbor, mkBan(neighbor).id);
    assert.equal(db.attachAppealTicketChannel(theirs.id, "shared-channel").won, true);
    assert.equal(db.getAppealByTicketChannel(neighbor, "shared-channel").id, theirs.id);
    assert.equal(db.getAppealByTicketChannel(CID, "shared-channel").id, mine.id, "no cross-community bleed");
  });

  it("two appeals sharing one channel resolve to the HIGHEST id (ORDER BY id DESC LIMIT 1)", () => {
    const older = fileOk(CID, mkBan(CID).id);
    const newer = fileOk(CID, mkBan(CID).id);
    assert.equal(db.attachAppealTicketChannel(older.id, "double-booked").won, true);
    assert.equal(db.attachAppealTicketChannel(newer.id, "double-booked").won, true);
    assert.ok(newer.id > older.id);
    assert.equal(db.getAppealByTicketChannel(CID, "double-booked").id, newer.id);
  });

  it("blank/absent channel ids answer null without touching the DB", () => {
    assert.equal(db.getAppealByTicketChannel(CID, ""), null);
    assert.equal(db.getAppealByTicketChannel(CID, "   "), null);
    assert.equal(db.getAppealByTicketChannel(CID, null), null);
  });

  it("getAppealByTicketChannel runs assertCommunityId (getAppealById is appeal-scoped)", () => {
    assertGuarded("getAppealByTicketChannel", (bad) => db.getAppealByTicketChannel(bad, "4242"));
    assert.equal(db.getAppealById({}), null, "record-scoped garbage answers null, never throws");
  });
});

describe("banAppeals.attachAppealTicketChannel — first attach wins", () => {
  const CID = communityKey("773-repo-attach");

  it("winner stamps the channel; the racing loser gets won:false + the LIVE row and mutates NOTHING", () => {
    const appeal = fileOk(CID, mkBan(CID).id);
    const first = db.attachAppealTicketChannel(appeal.id, "chan-A");
    assert.equal(first.ok, true);
    assert.equal(first.won, true);
    assert.equal(first.appeal.ticket_channel_id, "chan-A");
    assert.ok(Number(first.appeal.updated_at) > 0, "wall-clock stamp: existence pinned, value not");
    assert.equal(first.appeal.status, "filed", "attaching is status-free");

    const snapshot = appealRow(appeal.id);
    const second = db.attachAppealTicketChannel(appeal.id, "chan-B");
    assert.equal(second.won, false, "one ticket per appeal is claim-row law");
    assert.equal(second.appeal.ticket_channel_id, "chan-A", "the loser reads the channel actually on record");
    assert.deepEqual(appealRow(appeal.id), snapshot, "the losing attach wrote NOTHING — chan-B never landed");
  });

  it("missing appeal answers {ok:true, won:false, appeal:null}; malformed ids the {ok:false} answer", () => {
    assert.deepEqual(db.attachAppealTicketChannel(9_999_999, "chan"), {
      ok: true,
      won: false,
      appeal: null,
    });
    for (const bad of GARBAGE_APPEAL_IDS) {
      const res = db.attachAppealTicketChannel(bad, "chan");
      assert.equal(res.ok, false, `${JSON.stringify(bad) ?? String(bad)} must be refused`);
      assert.equal(res.error, "No such ban appeal.");
    }
  });

  it("blank channel ids are a NAMED runtime refusal (a ticket needs its channel)", () => {
    const appeal = fileOk(CID, mkBan(CID).id);
    for (const blank of ["", "   ", null]) {
      const res = db.attachAppealTicketChannel(appeal.id, blank);
      assert.equal(res.ok, false);
      assert.match(res.error, /needs the ticket channel id/);
    }
    assert.equal(appealRow(appeal.id).ticket_channel_id, null, "refusals store nothing");
  });
});

describe("banAppeals.openAppeal — the filed→open transition is legal ONLY from filed", () => {
  const CID = communityKey("773-repo-open");

  it("filed → open (CAS); the second opener loses to the LIVE open row", () => {
    const appeal = fileOk(CID, mkBan(CID).id);
    const first = db.openAppeal(appeal.id);
    assert.equal(first.ok, true);
    assert.equal(first.won, true);
    assert.equal(first.appeal.status, "open");
    assert.ok(Number(first.appeal.updated_at) > 0, "wall-clock stamp: existence pinned, value not");
    // Storage law only: opening does not require a ticket (the FEATURE
    // orders attach→open; the CAS is on status alone).
    assert.equal(first.appeal.ticket_channel_id, null);
    assert.equal(first.appeal.decided_at, null, "opening decides nothing");

    const snapshot = appealRow(appeal.id);
    const second = db.openAppeal(appeal.id);
    assert.equal(second.won, false);
    assert.equal(second.appeal.status, "open");
    assert.deepEqual(appealRow(appeal.id), snapshot, "the loser mutates nothing");
  });

  it("attach-then-open is the normal path (attachment never unlocked the CAS)", () => {
    const appeal = fileOk(CID, mkBan(CID).id);
    db.attachAppealTicketChannel(appeal.id, "chan-open");
    assert.equal(db.openAppeal(appeal.id).won, true);
    assert.equal(appealRow(appeal.id).status, "open");
    assert.equal(appealRow(appeal.id).ticket_channel_id, "chan-open");
  });

  it("decided appeals can never re-open (closed statuses are endings)", () => {
    for (const outcome of db.APPEAL_OUTCOMES) {
      const appeal = openOk(CID, mkBan(CID).id);
      assert.equal(
        db.claimAppealOutcome(appeal.id, { status: outcome, decidedBy: "700000000000000001", nowMs: T0 }).won,
        true,
        `seed claim ${outcome}`,
      );
      const reopen = db.openAppeal(appeal.id);
      assert.equal(reopen.won, false, `${outcome} is terminal`);
      assert.equal(reopen.appeal.status, outcome, "the loser reads the decided truth");
    }
  });

  it("missing appeal → {ok:true, won:false, appeal:null}; garbage ids → {ok:false}", () => {
    assert.deepEqual(db.openAppeal(9_999_999), { ok: true, won: false, appeal: null });
    for (const bad of GARBAGE_APPEAL_IDS) {
      const res = db.openAppeal(bad);
      assert.equal(res.ok, false);
      assert.equal(res.error, "No such ban appeal.");
    }
    const appeal = fileOk(CID, mkBan(CID).id);
    assert.equal(db.openAppeal(String(appeal.id)).won, true, "numeric-string id wins the real row");
  });
});

describe("banAppeals.claimAppealOutcome — first-decision-wins (claimUnban law)", () => {
  const CID = communityKey("773-repo-claim");

  it("two racing claimers → exactly one won; the loser reads the LIVE row and mutates NOTHING", () => {
    const appeal = openOk(CID, mkBan(CID).id);

    const winner = db.claimAppealOutcome(appeal.id, {
      status: "granted",
      decidedBy: "  700000000000000009  ",
      nowMs: T0 + MIN,
    });
    assert.equal(winner.ok, true);
    assert.equal(winner.won, true, "WHERE status='open' makes simultaneous buttons impossible");
    assert.equal(winner.appeal.status, "granted");
    assert.equal(winner.appeal.decided_by, "700000000000000009", "decided_by trims");
    assert.equal(winner.appeal.decided_at, T0 + MIN, "the injected instant IS the record");
    assert.equal(winner.appeal.updated_at, T0 + MIN, "claim stamps both clocks with the one instant");
    assert.equal(winner.appeal.denial_reason, null, "clemency carries no denial reason");

    const snapshot = appealRow(appeal.id);
    const loser = db.claimAppealOutcome(appeal.id, {
      status: "denied",
      decidedBy: "700000000000000010",
      denialReason: "the other button pressed a ms later",
      nowMs: T0 + 2 * MIN,
    });
    assert.equal(loser.ok, true);
    assert.equal(loser.won, false, "first-decision-wins: the second press NEVER decides");
    assert.equal(loser.appeal.status, "granted", "the loser surfaces what ACTUALLY happened");
    assert.equal(loser.appeal.denial_reason, null, "the loser's denial reason wrote NOTHING");
    assert.equal(loser.appeal.decided_by, "700000000000000009", "the first decider stands");
    assert.deepEqual(appealRow(appeal.id), snapshot, "the losing claim is byte-identical churn-free");
  });

  it("all three outcomes land their full decide-record (denied keeps the reason, closed needs no attribution)", () => {
    const denied = openOk(CID, mkBan(CID).id);
    const d = db.claimAppealOutcome(denied.id, {
      status: "denied",
      decidedBy: "700000000000000011",
      denialReason: "  repeated raids  ",
      nowMs: T0 + MIN,
    });
    assert.equal(d.won, true);
    assert.equal(d.appeal.status, "denied");
    assert.equal(d.appeal.denial_reason, "repeated raids", "denial reason trims and lands");
    assert.equal(d.appeal.decided_at, T0 + MIN);

    const plain = openOk(CID, mkBan(CID).id);
    const c = db.claimAppealOutcome(plain.id, { status: "closed", nowMs: T0 + MIN });
    assert.equal(c.won, true);
    assert.equal(c.appeal.status, "closed");
    assert.equal(c.appeal.decided_by, null, "the neutral-notice close is attribution-free by design");
    assert.equal(c.appeal.decided_at, T0 + MIN);

    const granted = openOk(CID, mkBan(CID).id);
    assert.equal(db.claimAppealOutcome(granted.id, { status: "granted", nowMs: T0 + MIN }).won, true);
    assert.equal(appealRow(granted.id).denial_reason, null, "granting clears nothing retroactively");
  });

  it("claims ONLY from open — a filed appeal is not yet decidable (it must pass through open)", () => {
    const filed = fileOk(CID, mkBan(CID).id);
    const res = db.claimAppealOutcome(filed.id, { status: "granted", decidedBy: "700000000000000012" });
    assert.equal(res.ok, true);
    assert.equal(res.won, false);
    assert.equal(res.appeal.status, "filed", "the claimer reads the un-decided truth");
    assert.equal(res.appeal.decided_at, null, "refused claims never stamp");
  });

  it("the outcome domain is CLOSED to the three decided endings — everything else is a named refusal", () => {
    const appeal = openOk(CID, mkBan(CID).id);
    for (const status of ["filed", "open", "ACTIVE", "clemency_granted", "", null, undefined]) {
      const res = db.claimAppealOutcome(appeal.id, { status, nowMs: T0 });
      assert.equal(res.ok, false, `${JSON.stringify(status)} must be refused`);
      assert.match(res.error, /Unknown appeal outcome/);
      assert.match(res.error, /granted, denied, closed/, "the message teaches the domain");
    }
    assert.equal(appealRow(appeal.id).status, "open", "refusals mutate nothing");
  });

  it("denial_reason re-checks the 1000-char cap and refuses BEFORE deciding", () => {
    const appeal = openOk(CID, mkBan(CID).id);
    const tooLong = db.claimAppealOutcome(appeal.id, {
      status: "denied",
      denialReason: "x".repeat(db.MAX_DENIAL_REASON + 1),
    });
    assert.equal(tooLong.ok, false);
    assert.match(tooLong.error, /too long \(max 1000 characters\)/);
    assert.equal(appealRow(appeal.id).status, "open", "an over-cap reason cannot smuggle a decision");
    // Boundary: exactly at cap decides fine.
    assert.equal(
      db.claimAppealOutcome(appeal.id, {
        status: "denied",
        denialReason: "y".repeat(db.MAX_DENIAL_REASON),
        nowMs: T0 + MIN,
      }).won,
      true,
    );
  });

  it("blank decidedBy/denialReason normalize to ABSENT, never empty strings", () => {
    const appeal = openOk(CID, mkBan(CID).id);
    assert.equal(
      db.claimAppealOutcome(appeal.id, {
        status: "denied",
        decidedBy: "   ",
        denialReason: "",
        nowMs: T0,
      }).won,
      true,
    );
    const row = appealRow(appeal.id);
    assert.equal(row.decided_by, null);
    assert.equal(row.denial_reason, null);
  });

  it("missing appeal answers {ok:true, won:false, appeal:null}; garbage ids the {ok:false} answer", () => {
    assert.deepEqual(db.claimAppealOutcome(9_999_999, { status: "granted" }), {
      ok: true,
      won: false,
      appeal: null,
    });
    for (const bad of GARBAGE_APPEAL_IDS) {
      const res = db.claimAppealOutcome(bad, { status: "granted" });
      assert.equal(res.ok, false, `${JSON.stringify(bad) ?? String(bad)} must be refused`);
      assert.equal(res.error, "No such ban appeal.");
    }
    const appeal = openOk(CID, mkBan(CID).id);
    assert.equal(
      db.claimAppealOutcome(String(appeal.id), { status: "closed", nowMs: T0 }).won,
      true,
      "numeric-string id wins the real row",
    );
  });
});

describe("banAppeals cursors — pair law, per-direction isolation, last-write-wins", () => {
  const CID = communityKey("773-repo-cursor");

  it("never-saved reads {ok:true, cursor:null} (boot catch-up starts clean)", () => {
    const appeal = fileOk(CID, mkBan(CID).id);
    assert.deepEqual(db.loadAppealCursor(appeal.id, "user"), { ok: true, cursor: null });
    assert.deepEqual(db.loadAppealCursor(appeal.id, "ticket"), { ok: true, cursor: null });
  });

  it("save→load round-trips the PAIR per direction and never touches the other direction", () => {
    const appeal = openOk(CID, mkBan(CID).id);
    const saved = db.saveAppealCursor(appeal.id, "user", { messageId: "5001", timestampMs: T0 + MIN });
    assert.equal(saved.ok, true);
    assert.equal(saved.won, true, "won here reports row existence, not a claim");

    const raw = appealRow(appeal.id);
    assert.equal(raw.ferry_user_msg_id, "5001");
    assert.equal(raw.ferry_user_ts, T0 + MIN, "the pair rides together — never half a cursor");
    assert.equal(raw.ferry_ticket_msg_id, null, "the ticket direction is untouched");
    assert.equal(raw.ferry_ticket_ts, null);

    assert.deepEqual(db.loadAppealCursor(appeal.id, "user"), {
      ok: true,
      cursor: { messageId: "5001", timestampMs: T0 + MIN },
    });

    assert.equal(db.saveAppealCursor(appeal.id, "ticket", { messageId: "5002", timestampMs: T0 + 2 * MIN }).won, true);
    assert.deepEqual(db.loadAppealCursor(appeal.id, "user").cursor, { messageId: "5001", timestampMs: T0 + MIN });
    assert.deepEqual(db.loadAppealCursor(appeal.id, "ticket").cursor, { messageId: "5002", timestampMs: T0 + 2 * MIN });
  });

  it("numeric messageIds stringify (Discord snowflakes > 2^53 stay exact); timestamps floor to whole ms", () => {
    const appeal = fileOk(CID, mkBan(CID).id);
    assert.equal(db.saveAppealCursor(appeal.id, "user", { messageId: 4001, timestampMs: T0 + 1.9 }).won, true);
    const row = appealRow(appeal.id);
    assert.equal(row.ferry_user_msg_id, "4001");
    assert.equal(row.ferry_user_ts, T0 + 1, "Math.floor — no fractional ms in the DB");
    assert.equal(db.loadAppealCursor(appeal.id, "user").cursor.messageId, "4001");
  });

  it("HALF a cursor is refused and stores nothing (a half cursor is a resume-time lie)", () => {
    const appeal = fileOk(CID, mkBan(CID).id);
    const halves = [
      { messageId: "5100" },
      { timestampMs: T0 },
      { messageId: "  ", timestampMs: T0 },
      { messageId: "5100", timestampMs: 0 },
      { messageId: "5100", timestampMs: -5 },
      { messageId: "5100", timestampMs: "abc" },
      { messageId: "5100", timestampMs: NaN },
      {},
    ];
    for (const cursor of halves) {
      const res = db.saveAppealCursor(appeal.id, "user", cursor);
      assert.equal(res.ok, false, JSON.stringify(cursor));
      assert.match(res.error, /needs both the message id and a positive timestamp/);
    }
    assert.equal(appealRow(appeal.id).ferry_user_msg_id, null, "refused saves wrote NOTHING");
  });

  it("a hand-crafted half row still never surfaces as a cursor (defensive read)", () => {
    const appeal = fileOk(CID, mkBan(CID).id);
    db.db
      .prepare(`UPDATE ban_appeals SET ferry_user_msg_id='5200' WHERE id=?`)
      .run(appeal.id);
    assert.deepEqual(db.loadAppealCursor(appeal.id, "user"), { ok: true, cursor: null });
  });

  it("saves are LAST-WRITE-WINS (single-flow per direction — CAS would only add a wedge)", () => {
    const appeal = openOk(CID, mkBan(CID).id);
    db.saveAppealCursor(appeal.id, "ticket", { messageId: "old", timestampMs: T0 });
    const res = db.saveAppealCursor(appeal.id, "ticket", { messageId: "newer", timestampMs: T0 + MIN });
    assert.equal(res.won, true, "an existing row always accepts the newest pair");
    assert.deepEqual(db.loadAppealCursor(appeal.id, "ticket").cursor, {
      messageId: "newer",
      timestampMs: T0 + MIN,
    });
  });

  it("unknown directions are named refusals on BOTH sides (user|ticket is a closed set)", () => {
    const appeal = fileOk(CID, mkBan(CID).id);
    for (const direction of ["sideways", "USER", "", null]) {
      const save = db.saveAppealCursor(appeal.id, direction, { messageId: "1", timestampMs: T0 });
      assert.equal(save.ok, false);
      assert.match(save.error, /Unknown ferry direction .* — choose one of: user, ticket/);
      const load = db.loadAppealCursor(appeal.id, direction);
      assert.equal(load.ok, false);
      assert.match(load.error, /choose one of: user, ticket/);
    }
  });

  it("gone appeal: save reports won:false (the silent no-op the caller must notice); load answers null", () => {
    assert.deepEqual(db.saveAppealCursor(9_999_999, "user", { messageId: "9", timestampMs: T0 }), {
      ok: true,
      won: false,
      appeal: null,
    });
    assert.deepEqual(db.loadAppealCursor(9_999_999, "ticket"), { ok: true, cursor: null });
    for (const bad of GARBAGE_APPEAL_IDS) {
      assert.equal(db.saveAppealCursor(bad, "user", { messageId: "9", timestampMs: T0 }).error, "No such ban appeal.");
      assert.equal(db.loadAppealCursor(bad, "user").error, "No such ban appeal.");
    }
  });
});

describe("banAppeals.setAppealFerryPaused — relay-only, NO status coupling", () => {
  const CID = communityKey("773-repo-pause");

  it("every honest on/off spelling lands; garbage is a NAMED refusal (never a guessed relay state)", () => {
    const appeal = openOk(CID, mkBan(CID).id);
    for (const on of [true, 1, "1", "on"]) {
      const res = db.setAppealFerryPaused(appeal.id, on);
      assert.equal(res.won, true, `on-spelling ${JSON.stringify(on)}`);
      assert.equal(appealRow(appeal.id).ferry_paused, 1);
    }
    for (const off of [false, 0, "0", "off"]) {
      const res = db.setAppealFerryPaused(appeal.id, off);
      assert.equal(res.won, true, `off-spelling ${JSON.stringify(off)}`);
      assert.equal(appealRow(appeal.id).ferry_paused, 0);
    }
    const snapshot = appealRow(appeal.id);
    for (const bad of ["maybe", null, undefined, {}, 2, -1, NaN]) {
      const res = db.setAppealFerryPaused(appeal.id, bad);
      assert.equal(res.ok, false, `${JSON.stringify(bad) ?? String(bad)} must be refused`);
      assert.match(res.error, /Unknown pause value .* — choose on or off/);
    }
    assert.deepEqual(appealRow(appeal.id), snapshot, "refused values guess NOTHING — the flag stands");
  });

  it("pausing never decides: an open appeal stays open, cursors and decision columns untouched", () => {
    const appeal = openOk(CID, mkBan(CID).id);
    db.saveAppealCursor(appeal.id, "user", { messageId: "6001", timestampMs: T0 + MIN });
    const before = appealRow(appeal.id);

    assert.equal(db.setAppealFerryPaused(appeal.id, true).won, true);
    const after = appealRow(appeal.id);
    assert.equal(after.ferry_paused, 1);
    assert.equal(after.status, "open", "silencing the relay never decides anything");
    assert.equal(after.decided_by, null);
    assert.equal(after.decided_at, null);
    assert.equal(after.denial_reason, null);
    assert.equal(after.ferry_user_msg_id, before.ferry_user_msg_id, "pause is one column — the pair rides");
    assert.ok(Number(after.updated_at) > 0, "wall-clock stamp: existence pinned, value not");
  });

  it("deciding never locks the knob: a decided appeal still toggles (the relay's quiet-time switch is status-free)", () => {
    const appeal = openOk(CID, mkBan(CID).id);
    assert.equal(db.claimAppealOutcome(appeal.id, { status: "granted", decidedBy: "700000000000000013", nowMs: T0 + MIN }).won, true);
    assert.equal(db.setAppealFerryPaused(appeal.id, "on").won, true);
    const row = appealRow(appeal.id);
    assert.equal(row.ferry_paused, 1, "storage answers the knob (the FEATURE stops the relay via the status guard)");
    assert.equal(row.status, "granted", "…and toggling never re-opens the decision");
  });

  it("missing appeal answers {ok:true, won:false, appeal:null}; garbage ids the {ok:false} answer", () => {
    assert.deepEqual(db.setAppealFerryPaused(9_999_999, true), { ok: true, won: false, appeal: null });
    for (const bad of GARBAGE_APPEAL_IDS) {
      assert.equal(db.setAppealFerryPaused(bad, true).error, "No such ban appeal.");
    }
  });
});

describe("banAppeals — the community OWNS the appeal (FK cascade seen through the repo)", () => {
  it("deleting the community empties every repo read (rows ride the 075 cascade)", () => {
    const cid = communityKey("773-repo-cascade");
    const rec = mkBan(cid);
    const appeal = openOk(cid, rec.id, "chan-cascade");

    db.db.prepare(`DELETE FROM communities WHERE id=?`).run(cid);

    assert.equal(db.getAppealById(appeal.id), null, "the appeal rode the cascade");
    assert.equal(db.getAppealByTicketChannel(cid, "chan-cascade"), null);
    assert.equal(db.getBanRecord(rec.id), null, "…and its ban record");
    // Mutators honestly no-op on the gone row instead of resurrecting it.
    assert.equal(db.saveAppealCursor(appeal.id, "user", { messageId: "7001", timestampMs: T0 }).won, false);
    assert.equal(db.claimAppealOutcome(appeal.id, { status: "closed" }).won, false);
    assert.equal(db.setAppealFerryPaused(appeal.id, true).won, false);
    assert.deepEqual(db.loadAppealCursor(appeal.id, "user"), { ok: true, cursor: null });
  });
});

describe("banAppeals — the appeal machine, end to end (injected clock throughout)", () => {
  it("intake → ticket → open → relay cursors → pause → deny: the full deny-record", () => {
    const cid = communityKey("773-repo-walk-deny");
    const rec = mkBan(cid);
    const filed = fileOk(cid, rec.id, "The ban was for a joke that was not funny", T0);
    assert.equal(filed.status, "filed");

    assert.equal(db.attachAppealTicketChannel(filed.id, "appeal-ticket-1").won, true);
    assert.equal(db.openAppeal(filed.id).won, true);

    // Ferry resumes from persisted pairs, per direction.
    assert.equal(db.saveAppealCursor(filed.id, "user", { messageId: "8001", timestampMs: T0 + 5 * MIN }).won, true);
    assert.equal(db.saveAppealCursor(filed.id, "ticket", { messageId: "8002", timestampMs: T0 + 6 * MIN }).won, true);
    assert.equal(db.setAppealFerryPaused(filed.id, true).won, true, "staff takes quiet time");

    const claim = db.claimAppealOutcome(filed.id, {
      status: "denied",
      decidedBy: "700000000000000021",
      denialReason: "pattern of raids — appeal refused",
      nowMs: T0 + 90 * MIN,
    });
    assert.equal(claim.won, true);

    const row = appealRow(filed.id);
    assert.equal(row.status, "denied");
    assert.equal(row.decided_by, "700000000000000021");
    assert.equal(row.decided_at, T0 + 90 * MIN);
    assert.equal(row.denial_reason, "pattern of raids — appeal refused");
    assert.equal(row.created_at, T0, "the intake instant stands");
    assert.equal(row.ferry_paused, 1, "pause is decision-independent state — it rides");
    assert.deepEqual(db.loadAppealCursor(row.id, "user").cursor, {
      messageId: "8001",
      timestampMs: T0 + 5 * MIN,
    });

    // Settled out of every queue: no re-open, no second decision.
    assert.equal(db.openAppeal(row.id).won, false);
    assert.equal(db.claimAppealOutcome(row.id, { status: "granted" }).won, false);
    assert.equal(appealRow(row.id).status, "denied", "one decision per appeal, ever");
  });

  it("clemency walk: granted claim carries no denial reason and survives later pause churn", () => {
    const cid = communityKey("773-repo-walk-grant");
    const appeal = openOk(cid, mkBan(cid).id);
    assert.equal(
      db.claimAppealOutcome(appeal.id, { status: "granted", decidedBy: "700000000000000022", nowMs: T0 + MIN }).won,
      true,
    );
    assert.equal(db.setAppealFerryPaused(appeal.id, "on").won, true);
    const row = appealRow(appeal.id);
    assert.equal(row.status, "granted");
    assert.equal(row.denial_reason, null, "the deny column never fills on the clemency path");
    assert.equal(row.ferry_paused, 1);
  });
});

/* ══ #811: closeAppealOnBanEnd — the ban-ended system close ═════════════════ */

describe("banAppeals.closeAppealOnBanEnd — CAS over BOTH pending shapes (#811)", () => {
  const CID = communityKey("811-repo-close");

  it("files the CAS law: 'filed' → closed with the system decider + reason ride", () => {
    const appeal = fileOk(CID, mkBan(CID).id);
    const res = db.closeAppealOnBanEnd(appeal.id, {
      reason: "Ban ended (the ban expired and was auto-unbanned) — appeal auto-closed",
      nowMs: T0 + MIN,
    });
    assert.deepEqual({ ok: res.ok, won: res.won }, { ok: true, won: true });

    const row = appealRow(appeal.id);
    assert.equal(row.status, "closed");
    assert.equal(row.decided_by, db.APPEAL_BAN_END_DECIDER, "names the mechanism, never a fake user id");
    assert.equal(row.decided_at, T0 + MIN, "the injected clock is the stamp");
    assert.equal(row.updated_at, T0 + MIN);
    assert.match(row.denial_reason, /appeal auto-closed/, "the WHY rides denial_reason for the ticket read");
    assert.equal(row.ferry_paused, 0, "the close does NOT touch the pause knob (state orthogonality)");
  });

  it("the LIVE shape: 'open' → closed (the ferry lane dies with the row)", () => {
    const appeal = openOk(CID, mkBan(CID).id);
    const res = db.closeAppealOnBanEnd(appeal.id, { reason: "lifted outside the bot", nowMs: T0 + MIN });
    assert.equal(res.won, true);
    const row = appealRow(appeal.id);
    assert.equal(row.status, "closed");
    assert.equal(row.decided_by, db.APPEAL_BAN_END_DECIDER);

    // STRUCTURAL ferry stop: the DM relay lane selects ONLY open rows.
    const rec = db.getBanRecord(appeal.ban_record_id);
    assert.deepEqual(db.listOpenAppealsByUser(rec.user_id).filter((a) => a.id === appeal.id), []);
  });

  it("decided/closed rows are UNTOUCHED (won:false + the live row, byte-stable)", () => {
    for (const [status, how] of [
      ["granted", (id) => db.claimAppealOutcome(id, { status: "granted", decidedBy: uid("mod"), nowMs: T0 + MIN })],
      ["denied", (id) => db.claimAppealOutcome(id, { status: "denied", decidedBy: uid("mod"), nowMs: T0 + MIN })],
      ["closed", (id) => db.claimAppealOutcome(id, { status: "closed", decidedBy: uid("mod"), nowMs: T0 + MIN })],
    ]) {
      const appeal = openOk(CID, mkBan(CID).id);
      assert.equal(how(appeal.id).won, true, `seed reaches ${status}`);
      const before = appealRow(appeal.id);

      const res = db.closeAppealOnBanEnd(appeal.id, { reason: "too late", nowMs: T0 + 9 * MIN });
      assert.equal(res.ok, true);
      assert.equal(res.won, false, `${status} is outside the ('filed','open') CAS domain`);
      assert.deepEqual(appealRow(appeal.id), before, "a losing system-close mutates NOTHING");
      assert.equal(res.appeal.status, status, "the loser reports the LIVE truth");
    }
  });

  it("a staff decision landing mid-flight simply WINS the row (one-winner CAS)", () => {
    const appeal = openOk(CID, mkBan(CID).id);
    // Staff deny claims first; the ban-ended pass reads later and lands on a
    // decided row — exactly the race the design promises the staff wins.
    assert.equal(
      db.claimAppealOutcome(appeal.id, { status: "denied", decidedBy: "mod-1", nowMs: T0 + MIN }).won,
      true
    );
    const res = db.closeAppealOnBanEnd(appeal.id, { reason: "ban expired", nowMs: T0 + 2 * MIN });
    assert.equal(res.won, false);
    const row = appealRow(appeal.id);
    assert.equal(row.status, "denied", "no status clobbering");
    assert.equal(row.decided_by, "mod-1", "no attribution clobbering");
    assert.equal(row.denial_reason, null, "no reason clobbering");
  });

  it("two racing ban-ended passes: exactly one winner (the CAS is the arbiter)", () => {
    const appeal = openOk(CID, mkBan(CID).id);
    const first = db.closeAppealOnBanEnd(appeal.id, { reason: "first", nowMs: T0 + MIN });
    const second = db.closeAppealOnBanEnd(appeal.id, { reason: "second", nowMs: T0 + 2 * MIN });
    assert.equal(first.won, true);
    assert.equal(second.won, false, "a repeated ban-end (duplicate event) changes nothing");
    assert.equal(appealRow(appeal.id).denial_reason, "first", "the winner's reason stands");
  });

  it("the reason cap rides MAX_DENIAL_REASON like every other outcome note", () => {
    const appeal = openOk(CID, mkBan(CID).id);
    const long = "x".repeat(db.MAX_DENIAL_REASON + 1);
    const res = db.closeAppealOnBanEnd(appeal.id, { reason: long });
    assert.equal(res.ok, false);
    assert.match(res.error, /too long \(max \d+ characters\)/);
    assert.equal(appealRow(appeal.id).status, "open", "an over-cap refusal stores NOTHING");
  });

  it("null/blank reason is honest: the close lands with denial_reason NULL", () => {
    const appeal = openOk(CID, mkBan(CID).id);
    assert.equal(db.closeAppealOnBanEnd(appeal.id, { reason: null }).won, true);
    assert.equal(appealRow(appeal.id).denial_reason, null);
  });

  it("garbage appeal ids answer the runtime refusal, never throw", () => {
    for (const bad of GARBAGE_APPEAL_IDS) {
      const res = db.closeAppealOnBanEnd(bad, { reason: "x" });
      assert.equal(res.ok, false, `${JSON.stringify(bad) ?? String(bad)} must be refused`);
      assert.equal(res.error, "No such ban appeal.");
    }
  });

  it("a never-existing id is a LOSS, not an error (won:false + null row)", () => {
    const res = db.closeAppealOnBanEnd(999999, { reason: "ghost" });
    assert.equal(res.ok, true);
    assert.equal(res.won, false);
    assert.equal(res.appeal, null);
  });

  it("the system decider constant is frozen-shaped truth: exact string, exported once", () => {
    assert.equal(db.APPEAL_BAN_END_DECIDER, "system:ban-ended");
    // It is NOT a snowflake — attribution reads honestly in every audit grep.
    assert.doesNotMatch(db.APPEAL_BAN_END_DECIDER, /^\d{17,20}$/);
  });
});
