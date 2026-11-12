/**
 * Ban appeals OUTCOME ENGINE unit suite (#773 subtask 11 — the committed
 * battery for src/features/banAppeals/outcomes.js).
 *
 * Division of labor (no duplication):
 * - test/ban-appeals-repo.test.js owns the repository claim law (CAS text,
 *   constraint contracts); this file owns the ENGINE behavior around it:
 *   what runs, in which order, against which seam, and what a loser sees.
 * - test/ban-records-repo.test.js owns claimWelcome/recordWelcomeDmSent
 *   storage law; this file proves the outcome engine SPENDS the cycle's
 *   welcome structurally (the #772 duplicate-DM impossibility from §4).
 *
 * The matrix (subtask 11, 7 points):
 *   1. claim law — racing clemency clicks: exactly one winner; the loser
 *      gets the status-keyed already-decided error and performs ZERO
 *      recorded calls; clemency-then-deny and deny-then-clemency are both
 *      first-decision-wins.
 *   2. welcome suppression — the clemency path leaves ban_records
 *      clemency_granted with welcome_dm_sent SPENT (a follow-up
 *      db.claimWelcome LOSES — the #772 welcome DM is structurally dead),
 *      exactly ONE user DM, spend strictly BEFORE the unban; the settled-row
 *      race spends through the domain CAS; the already-spent variant still
 *      grants and still delivers its one DM.
 *   3. invite policy — the createInvite seam gets EXACTLY (communityId,
 *      channel, {reason}) with the appeal id in the reason; the channel
 *      fallback guild.systemChannel ?? systemChannelId ?? first text-ish
 *      channel is exercised on every leg; the audited policy triple
 *      (max_age 0 / max_uses 0 / unique false) + the minted code are
 *      pinned on the banAppeals.invite_created row via db.listAdminAudit.
 *      (The outbound seam call carries ONLY reason + ids — the policy
 *      constants live in platform/discord/outbound.createInvite, pinned by
 *      test/platform-discord-outbound.test.js, and are MIRRORED into the
 *      audit row, which is what this engine can and must prove.)
 *   4. NOT_BANNED (Discord 10026) is truth, not failure — still grants,
 *      still settles, still invites, still sends the ONE welcome-back DM;
 *      a HARD unban failure is the opposite: decision stands, execution
 *      reported failed, zero invite/DM, ticket kept open.
 *   5. deny — modal customId `ap:deny:m:<id>` + MODAL_FIELD_REASON round
 *      trip; timed bans restate eligibility with the exact <t:F>/<t:R>
 *      tokens computed from the record expiry; permanent bans carry the
 *      no-eligibility phrasing with the timed tokens ABSENT; the staff note
 *      rides escaped-verbatim (raw stays in denial_reason); status/decided_
 *      by/decided_at pinned against the INJECTED clock; the shared close
 *      flow is invoked with the exact close reason, and an unreachable
 *      channel is pinned as its logged skip.
 *   6. plainClose — the ChannelDelete path closes an OPEN appeal with the
 *      neutral DM (no invite / no unban / ban record untouched / decided_by
 *      NULL); decided appeals are benign skips with zero DMs; a plainClose
 *      racing a decision hands the loser the already-decided error.
 *   7. post-decision guards — every arm answers the live row's truth keyed
 *      by status; the button-disable edit is attempted and its failure is
 *      logged, non-fatal; a DM failure is logged with ids, never echoed,
 *      and the already-won claim still reports ok.
 *
 * Error contract (#773 + AGENTS.md): nothing here ever throws — exploding
 * deps answer {ok:false,...} values (or ok:true with warnings where the
 * claim was already won). Determinism law: everything time-shaped rides the
 * injected nowMs (decided_at is pinned to the INJECTED instant); the
 * repo-internal now() stamps (attach/open/audit created_at) are pinned for
 * EXISTENCE only. No timers, no wall-clock field reads.
 *
 * Header contract (test/registry.test.js law): the require of
 * test/helpers/env.js RESOLVES BEFORE any src/ require; loadDb() runs above
 * every engine require (temp DB + require-cache reset); after(cleanup).
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();
after(cleanup);

const outcomes = require("../src/features/banAppeals/outcomes.js");
const {
  AP_DENY_MODAL_PREFIX,
  parseTicketAppealId,
} = require("../src/features/banAppeals/constants.js");
const { tsFull, tsRelative } = require("../src/core/theme.js");

/* ── deterministic clock (every engine-visible instant is injected) ───────── */
const T0 = Date.UTC(2026, 10, 1);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** THE injected now — decided_at is value-pinned against exactly this. */
const NOW = T0 + 5 * MIN;

/* ── stable actors (leak-scanned against every user-side payload) ─────────── */
const MOD_ID = "100000000000000001";
const MOD_OTHER = "300000000000000003";
const SECRET_REASON = "SECRET-BAN-REASON-do-not-leak";
const INVITE_CODE = "INV123";
const INVITE_URL = `https://discord.gg/${INVITE_CODE}`;

let userSeq = 0;
const userId = () => `88${String(++userSeq).padStart(17, "0")}`;

let chanSeq = 0;
const nextChannel = () => `ticket-chan-${++chanSeq}`;

/* ── seeds (broken seeds fail loudly) ──────────────────────────────────────── */

function mkRecord(communityId, { expiresAt = null } = {}) {
  const res = db.createBanRecord({
    communityId,
    userId: userId(),
    moderatorId: MOD_ID,
    source: "staff",
    reason: SECRET_REASON,
    bannedAt: T0 - HOUR,
    expiresAt,
  });
  assert.equal(res.ok, true, `ban seed failed: ${res.error}`);
  return res.record;
}

/** Open an appeal the way intake does: file → attach channel → open. */
function mkOpenAppeal(communityId, { channel = nextChannel(), expiresAt = null } = {}) {
  const record = mkRecord(communityId, { expiresAt });
  const filed = db.fileAppeal({
    communityId,
    banRecordId: record.id,
    appealStatement: "I would like to appeal this ban, please.",
    createdAt: T0,
  });
  assert.equal(filed.ok, true, `appeal seed failed: ${filed.error}`);
  assert.equal(db.attachAppealTicketChannel(filed.appeal.id, channel).ok, true);
  assert.equal(db.openAppeal(filed.appeal.id).won, true);
  return { record, channel, appeal: db.getAppealById(filed.appeal.id) };
}

/* ── recording fake-outbound (the smoke's double discipline, expanded) ──────
 * `calls` is the ONE ordered buffer every seam writes into — order, absence
 * and exact args are all asserted from it. Per-deps buffers make the
 * loser-zero-side-effects proofs airtight: the loser's OWN buffer is empty. */
function makeDeps(overrides = {}) {
  const calls = []; // ordered [name, ...args]
  const dms = []; // { userId, content, allowedMentions }
  const invites = []; // createInvite arg tuples
  const channelNotes = []; // { channelId, payload }
  const softCloses = []; // softCloseTicket opts objects
  const ticketReads = []; // getTicketByChannel arg pairs
  const logs = { info: [], warn: [], error: [] };
  const state = { welcomeFlagAtUnban: null };

  const base = {
    nowMs: NOW,
    log: {
      info: (...a) => logs.info.push(a.join(" ")),
      warn: (...a) => logs.warn.push(a.join(" ")),
      error: (...a) => logs.error.push(a.join(" ")),
    },
    guild: {
      id: "700000000000000077",
      name: "Outcomes Guild",
      systemChannel: { id: "sys-chan-1" },
      channels: { cache: [{ id: "text-9", type: 0 }] },
    },
    // ChannelDelete realism default: the ticket channel is often already gone.
    client: {
      channels: { fetch: async () => null },
      guilds: { cache: { get: () => null } },
    },
    channel: { id: "ticket-chan-stub" },
    getTicketByChannel: (communityIdArg, channelArg) => {
      calls.push(["getTicketByChannel", communityIdArg, channelArg]);
      ticketReads.push([communityIdArg, channelArg]);
      return { id: 4242, ticket_number: 42, status: "open", channel_id: channelArg };
    },
    softCloseTicket: async (opts) => {
      calls.push(["softCloseTicket", opts.closeReason]);
      softCloses.push(opts);
      return { ticket: opts.ticket, warnings: [] };
    },
    // Welcome spend rides the REAL domain CAS / belt stamp (the #772 law the
    // suppression proof depends on — double-faking it would prove nothing).
    claimWelcome: (recordId) => {
      calls.push(["claimWelcome", recordId]);
      return db.claimWelcome(recordId);
    },
    recordWelcomeDmSent: (recordId) => {
      calls.push(["recordWelcomeDmSent", recordId]);
      return db.recordWelcomeDmSent(recordId);
    },
    unbanMember: async (communityIdArg, userIdArg, reasonArg) => {
      calls.push(["unbanMember", communityIdArg, userIdArg, reasonArg]);
      // ORDER LAW witness: read the LIVE row AT CALL TIME — the flag must
      // already be spent when the ban lift runs.
      const row = db.db
        .prepare("SELECT welcome_dm_sent FROM ban_records WHERE user_id=?")
        .get(String(userIdArg));
      state.welcomeFlagAtUnban = row ? row.welcome_dm_sent : null;
      return base.unbanResult || { ok: true };
    },
    createInvite: async (...args) => {
      calls.push(["createInvite", ...args]);
      invites.push(args);
      return (
        base.inviteResult || {
          ok: true,
          invite: { code: INVITE_CODE, url: INVITE_URL },
        }
      );
    },
    sendDm: async (userIdArg, payload) => {
      calls.push(["sendDm", userIdArg]);
      assert.deepEqual(payload.allowedMentions, { parse: [] }, "DM law: parse []");
      dms.push({ userId: userIdArg, ...payload });
      return base.dmResult || { ok: true, id: `dm-${dms.length}` };
    },
    sendChannel: async (channelId, payload) => {
      calls.push(["sendChannel", channelId]);
      channelNotes.push({ channelId, payload });
      return { ok: true, id: "note-1" };
    },
    interaction: {
      update: async (payload) => {
        const comps = payload && Array.isArray(payload.components) ? payload.components.length : "?";
        calls.push(["interaction.update", `components:${comps}`]);
      },
    },
  };
  Object.assign(base, overrides);
  return { deps: base, calls, dms, invites, channelNotes, softCloses, ticketReads, logs, state };
}

/* ── shared assertions ─────────────────────────────────────────────────────── */

/** §6 privacy law: user-side copy carries no ids, no case tokens, no bodies. */
function assertCleanUserCopy(dms, extraLeaks = []) {
  for (const dm of dms) {
    for (const leak of [MOD_ID, MOD_OTHER, SECRET_REASON, ...extraLeaks]) {
      assert.ok(!dm.content.includes(leak), `user copy LEAKED ${leak}: ${dm.content}`);
    }
    assert.ok(!/case/i.test(dm.content), `case-token LEAKED: ${dm.content}`);
    assert.ok(!dm.content.includes("<@!"), `live mention LEAKED: ${dm.content}`);
    assert.deepEqual(dm.allowedMentions, { parse: [] });
  }
}

/** Audit rows for one action + appeal, via the SHIPPED reader. */
function auditFor(communityId, action, appealId) {
  return db
    .listAdminAudit(communityId, { limit: 100 })
    .filter((row) => row.action === action && row.target_id === String(appealId));
}

function details(row) {
  return JSON.parse(row.details_json);
}

const callNames = (calls) => calls.map((c) => c[0]);
const namesOf = (calls, ...names) => callNames(calls).filter((n) => names.includes(n));

/* ═══════════════════════════ 1. CLAIM LAW ══════════════════════════════════ */

describe("outcomes.claim law — the decision IS the claim (first decision wins)", () => {
  const CID = communityKey("773-outcomes-claim");

  it("two racing clemency clicks: exactly one winner, the loser performs ZERO side effects", async () => {
    const { record, appeal } = mkOpenAppeal(CID);
    const A = makeDeps();
    const B = makeDeps();

    // The claim is a synchronous SQLite CAS reached BEFORE the first await —
    // the Promise.all start order deterministically decides who wins the race,
    // while the invariants (one winner / loser silence) hold either way.
    const [ra, rb] = await Promise.all([
      outcomes.grantClemency({ appealId: appeal.id, staffUserId: MOD_ID, deps: A.deps }),
      outcomes.grantClemency({ appealId: appeal.id, staffUserId: MOD_OTHER, deps: B.deps }),
    ]);

    assert.equal(ra.ok, true, `first starter wins the CAS: ${ra.error}`);
    assert.equal(ra.code, "GRANTED");
    assert.equal(rb.ok, false, "the racing twin must lose");
    assert.equal(rb.code, "ALREADY_DECIDED");
    assert.equal(rb.liveStatus, "granted", "the loser surfaces the LIVE row's truth");
    assert.equal(
      rb.error,
      outcomes.alreadyDecidedError("granted"),
      "the loser's reply IS the status-keyed sentence",
    );

    // ZERO side effects on the loser's OWN recording deps — the strongest form.
    assert.deepEqual(B.calls, [], `loser performed calls: ${JSON.stringify(B.calls)}`);
    assert.equal(B.dms.length, 0);
    assert.equal(B.invites.length, 0);

    // Exactly ONE DM across both arms; the row decided exactly once.
    assert.equal(A.dms.length + B.dms.length, 1);
    assert.equal(db.getAppealById(appeal.id).status, "granted");
    assert.equal(db.getAppealById(appeal.id).decided_by, MOD_ID, "the winner's staff id owns the row");
    assert.equal(db.getAppealById(appeal.id).decided_at, NOW, "injected clock — exact");
    assert.equal(db.getBanRecord(record.id).status, "clemency_granted");
  });

  it("clemency first, deny second: the deny click loses with the granted-status copy", async () => {
    const { appeal } = mkOpenAppeal(CID);
    const first = makeDeps();
    assert.equal(
      (await outcomes.grantClemency({ appealId: appeal.id, staffUserId: MOD_ID, deps: first.deps })).ok,
      true,
    );

    const late = makeDeps();
    const res = await outcomes.deny({
      appealId: appeal.id,
      staffUserId: MOD_OTHER,
      reason: "too late",
      deps: late.deps,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "ALREADY_DECIDED");
    assert.equal(res.liveStatus, "granted");
    assert.equal(res.error, outcomes.alreadyDecidedError("granted"));
    assert.deepEqual(late.calls, [], "a losing deny mutates NOTHING");
    assert.equal(db.getAppealById(appeal.id).status, "granted");
    assert.equal(db.getAppealById(appeal.id).denial_reason, null);
  });

  it("deny first, clemency second: symmetric first-decision-wins keyed to `denied`", async () => {
    const { record, appeal } = mkOpenAppeal(CID, { expiresAt: T0 + 2 * DAY });
    const first = makeDeps();
    const denied = await outcomes.deny({
      appealId: appeal.id,
      staffUserId: MOD_ID,
      reason: "pattern of behaviour",
      deps: first.deps,
    });
    assert.equal(denied.ok, true, denied.error);

    const late = makeDeps();
    const res = await outcomes.grantClemency({
      appealId: appeal.id,
      staffUserId: MOD_OTHER,
      deps: late.deps,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "ALREADY_DECIDED");
    assert.equal(res.liveStatus, "denied");
    assert.equal(res.error, outcomes.alreadyDecidedError("denied"));
    assert.deepEqual(late.calls, [], "a losing clemency mutates NOTHING");
    assert.equal(db.getBanRecord(record.id).status, "active", "the ban stands (deny never touches it)");
  });
});

/* ═══════════════════ 2. WELCOME SUPPRESSION (#772 one-DM law) ══════════════ */

describe("outcomes.welcome suppression — exactly ONE DM per clemency", () => {
  const CID = communityKey("773-outcomes-welcome");

  it("ACTIVE row: spends through the belt stamp BEFORE the unban and leaves the flag SPENT", async () => {
    const { record, appeal } = mkOpenAppeal(CID, { expiresAt: T0 + 3 * DAY });
    const D = makeDeps();
    const res = await outcomes.grantClemency({ appealId: appeal.id, staffUserId: MOD_ID, deps: D.deps });

    assert.equal(res.ok, true, res.error);
    // The shipped claimWelcome domain sits OUT of ACTIVE rows (#772 law) — the
    // clemency spend therefore completes through recordWelcomeDmSent. Pin it.
    assert.equal(res.welcome.spent, true);
    assert.equal(res.welcome.via, "welcome_stamp");
    assert.ok(D.calls.some((c) => c[0] === "claimWelcome"), "the domain CAS is still attempted first");
    assert.ok(D.calls.some((c) => c[0] === "recordWelcomeDmSent"), "the belt stamp completed the spend");

    // ORDER LAW: the stamp strictly precedes the ban lift...
    const stampIdx = D.calls.findIndex((c) => c[0] === "recordWelcomeDmSent");
    const unbanIdx = D.calls.findIndex((c) => c[0] === "unbanMember");
    assert.ok(stampIdx >= 0 && unbanIdx >= 0 && stampIdx < unbanIdx, `order: ${callNames(D.calls)}`);
    // ...and the LIVE row read INSIDE the unban fake proves it at call time.
    assert.equal(D.state.welcomeFlagAtUnban, 1, "welcome_dm_sent was ALREADY 1 when unbanMember fired");

    // The row lands clemency_granted with the flag spent...
    assert.equal(db.getBanRecord(record.id).status, "clemency_granted");
    assert.equal(db.getBanRecord(record.id).welcome_dm_sent, 1);
    // ...so the #772 welcome-back DM is STRUCTURALLY unable to fire afterwards:
    assert.equal(db.claimWelcome(record.id).won, false, "the welcome claim is SPENT — the ticker can never win it");
    assert.equal(db.recordWelcomeDmSent(record.id), false, "the status-free stamp agrees: already stamped");

    // Exactly ONE user DM total (the clemency DM itself — welcome + invite).
    assert.equal(D.dms.length, 1);
    assert.equal(D.dms[0].userId, String(record.user_id));
    assert.ok(D.dms[0].content.includes("granted"));
    assert.ok(D.dms[0].content.toLowerCase().includes("welcome back"));
    assert.ok(D.dms[0].content.includes(INVITE_URL));
    assertCleanUserCopy(D.dms);
    assert.deepEqual(res.warnings, [], `unexpected warnings: ${JSON.stringify(res.warnings)}`);
  });

  it("settled-row race (event won the record): spend rides the domain CAS, NEVER unbans against a settled row", async () => {
    const { record, appeal } = mkOpenAppeal(CID);
    assert.equal(db.markUnbannedManual(record.id, "GuildBanRemove").won, true, "the event settles FIRST");

    const D = makeDeps();
    const res = await outcomes.grantClemency({ appealId: appeal.id, staffUserId: MOD_ID, deps: D.deps });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.welcome.via, "claimWelcome", "settled-row spend rides the domain CAS, not the stamp");
    assert.ok(!callNames(D.calls).includes("recordWelcomeDmSent"));

    assert.equal(res.unban.attempted, false, "NEVER unban against a settled record (a newer cycle may own the ban)");
    assert.ok(!callNames(D.calls).includes("unbanMember"));

    // CAS truth: the live status is reported, never overwritten.
    assert.equal(res.recordStatus, "unbanned_manual");
    assert.equal(db.getBanRecord(record.id).status, "unbanned_manual");

    // The clemency DM STILL lands — and it is still the ONLY DM.
    assert.equal(res.dmDelivered, true);
    assert.equal(D.dms.length, 1);
    assertCleanUserCopy(D.dms);
  });

  it("pre-spent welcome (ticker already delivered): via `already`, clemency still grants, DM still lands", async () => {
    const { record, appeal } = mkOpenAppeal(CID);
    assert.equal(db.markUnbannedManual(record.id, "expiry ticker").won, true);
    assert.equal(db.claimWelcome(record.id).won, true, "the ticker claims its welcome");
    assert.equal(db.claimWelcome(record.id).won, false, "single-winner belt (repo law) — the engine will read this");

    const D = makeDeps();
    const res = await outcomes.grantClemency({ appealId: appeal.id, staffUserId: MOD_ID, deps: D.deps });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.welcome.spent, true);
    assert.equal(res.welcome.via, "already", "a stamped live row IS the spend (no second stamp)");
    assert.ok(!callNames(D.calls).includes("recordWelcomeDmSent"));

    assert.equal(res.dmDelivered, true, "the appeal DM is the clemency's own — never suppressed");
    assert.equal(D.dms.length, 1);
    assertCleanUserCopy(D.dms);
  });
});

/* ═══════════════════════ 3. INVITE POLICY + CHANNEL PICK ═══════════════════ */

describe("outcomes.invite policy — exact seam args, channel fallback, audited policy", () => {
  const CID = communityKey("773-outcomes-invite");

  it("createInvite gets EXACTLY (communityId, systemChannel, {reason with the appeal id}); the policy is audited", async () => {
    const { record, appeal } = mkOpenAppeal(CID);
    const D = makeDeps();
    const res = await outcomes.grantClemency({ appealId: appeal.id, staffUserId: MOD_ID, deps: D.deps });
    assert.equal(res.ok, true, res.error);

    // Seam args (the call shape law): engine→outbound carries ids + reason ONLY;
    // the maxAge/maxUses/unique constants are OWNED by outbound.createInvite
    // (pinned in test/platform-discord-outbound.test.js) and MIRRORED here as
    // the audited policy row below — that mirror is this engine's promise.
    assert.equal(D.invites.length, 1);
    assert.deepEqual(D.invites[0], [
      CID,
      "sys-chan-1",
      { reason: `Ban appeal — clemency granted (appeal ${appeal.id})` },
    ]);

    // banAppeals.invite_created via the SHIPPED reader: policy triple + code +
    // channel + attribution, staff-side.
    const rows = auditFor(CID, "banAppeals.invite_created", appeal.id);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.origin, "system");
    assert.equal(row.target_type, "ban_appeal");
    assert.equal(row.actor_user_id, MOD_ID);
    assert.deepEqual(details(row), {
      ban_record_id: record.id,
      channel_id: "sys-chan-1",
      max_age: 0, // audited policy (locked decision 4): PERMANENT
      max_uses: 0, // unlimited
      unique: false, // reuse an existing invite
      invite_code: INVITE_CODE,
    });

    // The outcome audit row carries the honest execution facts.
    const clemency = auditFor(CID, "banAppeals.clemency_granted", appeal.id);
    assert.equal(clemency.length, 1);
    assert.deepEqual(details(clemency[0]), {
      ban_record_id: record.id,
      ban_number: record.ban_number,
      subject_user_id: record.user_id,
      record_status: "clemency_granted",
      not_banned: false,
      welcome_spent: true,
      invite_created: true,
    });
  });

  it("channel fallback: systemChannel ?? systemChannelId ?? first text-ish channel; nothing mintable is a SPECIFIC warning, never a failure", async () => {
    // Leg A: systemChannelId string variant is honored.
    const a = mkOpenAppeal(CID);
    const Da = makeDeps({
      guild: { id: "g-a", name: "Guild A", systemChannel: null, systemChannelId: "sys-id-2", channels: { cache: [] } },
    });
    const ra = await outcomes.grantClemency({ appealId: a.appeal.id, staffUserId: MOD_ID, deps: Da.deps });
    assert.equal(ra.ok, true, ra.error);
    assert.equal(Da.invites[0][1], "sys-id-2");

    // Leg B: no system channel at all → the FIRST text-ish channel in cache order.
    const b = mkOpenAppeal(CID);
    const Db = makeDeps({
      guild: {
        id: "g-b",
        name: "Guild B",
        systemChannel: null,
        channels: {
          cache: [
            { id: "c-folder", type: 4 },
            { id: "c-voice", type: 2 },
            { id: "c-text", type: "GuildText" },
            { id: "c-text2", type: 0 },
          ],
        },
      },
    });
    const rb = await outcomes.grantClemency({ appealId: b.appeal.id, staffUserId: MOD_ID, deps: Db.deps });
    assert.equal(rb.ok, true, rb.error);
    assert.equal(Db.invites[0][1], "c-text", "first text-ish channel (numeric OR name type)");

    // Leg C: nothing mintable → the DM says so SPECIFICALLY; outcome still grants.
    const c = mkOpenAppeal(CID);
    const Dc = makeDeps({ guild: null });
    Dc.deps.client = {
      channels: { fetch: async () => null },
      guilds: { cache: { get: () => null } },
    };
    const rc = await outcomes.grantClemency({ appealId: c.appeal.id, staffUserId: MOD_ID, deps: Dc.deps });
    assert.equal(rc.ok, true, rc.error);
    assert.equal(rc.invite.created, false);
    assert.equal(Dc.invites.length, 0, "no channel → no mint attempt");
    assert.equal(Dc.dms.length, 1);
    assert.ok(
      Dc.dms[0].content.includes("a re-join invite could not be created right now — a staff member can send you one directly"),
      Dc.dms[0].content,
    );
    assert.ok(
      rc.warnings.some((w) => w.includes("no system channel and no text channel is visible to mint the invite in")),
      JSON.stringify(rc.warnings),
    );
    assertCleanUserCopy(Dc.dms);
  });

  it("pickInviteChannel (pure): system first, first text-ish else, null on nothing usable, array cache honored", () => {
    const { pickInviteChannel } = outcomes.internals;
    assert.equal(pickInviteChannel({ systemChannel: { id: "s1" }, channels: { cache: [{ id: "c1", type: 0 }] } }), "s1");
    assert.equal(pickInviteChannel({ systemChannelId: "s2" }), "s2");
    assert.equal(
      pickInviteChannel({ systemChannel: null, channels: { cache: [{ id: "c1", type: 5 }, { id: "c2", type: 0 }] } }),
      "c2",
    );
    assert.equal(pickInviteChannel({ channels: { cache: [{ id: "c1", type: 4 }] } }), null, "no text-ish → null");
    assert.equal(pickInviteChannel({ channels: { cache: [{ id: "a", type: "Text" }, { id: "b", type: 0 }] } }), "a");
    assert.equal(pickInviteChannel(null), null);
  });
});

/* ═══════════════════ 4. NOT_BANNED (10026) — TRUTH, NOT FAILURE ════════════ */

describe("outcomes.unban leg — 10026 still grants; a hard failure is reported, never hidden", () => {
  const CID = communityKey("773-outcomes-notbanned");

  it("NOT_BANNED (the exact outbound 10026 shape) still settles + invites + sends the ONE welcome-back DM", async () => {
    const { record, appeal } = mkOpenAppeal(CID, { expiresAt: T0 + DAY });
    const D = makeDeps({
      unbanResult: {
        ok: false,
        code: "NOT_BANNED",
        error: `unbanMember: user ${record.user_id} is not banned in community ${CID} (Discord: Unknown Ban 10026) — nothing to lift`,
      },
    });
    const res = await outcomes.grantClemency({ appealId: appeal.id, staffUserId: MOD_ID, deps: D.deps });

    assert.equal(res.ok, true, `NOT_BANNED must still grant: ${res.error}`);
    assert.equal(res.code, "GRANTED");
    assert.deepEqual(res.unban, { attempted: true, ok: true, notBanned: true, error: null });

    // Record settle + invite + ONE DM — the full grant runs on the gone ban.
    assert.equal(db.getBanRecord(record.id).status, "clemency_granted");
    assert.equal(D.invites.length, 1);
    assert.equal(D.dms.length, 1);
    assert.ok(D.dms[0].content.toLowerCase().includes("welcome back"), D.dms[0].content);
    assert.ok(D.dms[0].content.includes(INVITE_URL));
    assert.equal(res.ticketClosed, true);
    assert.deepEqual(res.warnings, [], `no warnings on the truth path: ${JSON.stringify(res.warnings)}`);

    // The honesty log line carries the full id set (rule 2).
    assert.ok(
      D.logs.info.some(
        (line) =>
          line.includes("unban answered NOT_BANNED") &&
          line.includes(`community=${CID}`) &&
          line.includes(`appeal=${appeal.id}`) &&
          line.includes(`user=${record.user_id}`),
      ),
      JSON.stringify(D.logs.info),
    );
    assert.equal(details(auditFor(CID, "banAppeals.clemency_granted", appeal.id)[0]).not_banned, true);
    assertCleanUserCopy(D.dms);
  });

  it("hard unban failure: the decision STANDS but execution reports — no invite, no DM, ticket kept open", async () => {
    const { record, appeal } = mkOpenAppeal(CID);
    const D = makeDeps({ unbanResult: { ok: false, error: "Missing Access (50013)" } });
    const res = await outcomes.grantClemency({ appealId: appeal.id, staffUserId: MOD_ID, deps: D.deps });

    assert.equal(res.ok, false);
    assert.equal(res.code, "UNBAN_FAILED");
    assert.equal(res.error, "Missing Access (50013)");
    assert.equal(db.getAppealById(appeal.id).status, "granted", "the decision was claimed before the lift failed");

    assert.equal(D.invites.length, 0, "no invite after a failed lift");
    assert.equal(D.dms.length, 0, "no DM promising a ban that is still on");
    assert.equal(D.softCloses.length, 0, "the ticket stays OPEN — staff can retry");
    // The staff-side ledger posts the partial failure (rule 5) — to the ticket
    // channel, with the specific cause.
    assert.equal(D.channelNotes.length, 1);
    assert.ok(D.channelNotes[0].payload.content.includes("unban failed"), D.channelNotes[0].payload.content);
    assert.equal(D.channelNotes[0].channelId, appeal.ticket_channel_id);

    const audited = details(auditFor(CID, "banAppeals.clemency_granted", appeal.id)[0]);
    assert.equal(audited.unban_failed, true);
    assert.equal(audited.unban_error, "Missing Access (50013)");
    void record;
  });
});

/* ═══════════════════════════════ 5. DENY ═══════════════════════════════════ */

describe("outcomes.deny — modal round-trip, eligibility DM, note law, close flow", () => {
  const CID = communityKey("773-outcomes-deny");

  it("buildDenyReasonModal: customId ap:deny:m:<id>, MODAL_FIELD_REASON round-trip, repo cap, optional Paragraph", () => {
    const modal = outcomes.buildDenyReasonModal(42).toJSON();
    assert.equal(modal.custom_id, `${AP_DENY_MODAL_PREFIX}42`);
    assert.equal(modal.custom_id, "ap:deny:m:42", "the LOCKED customId grammar");
    assert.equal(modal.title, "Deny this appeal");

    const field = modal.components[0].components[0];
    assert.equal(field.custom_id, outcomes.MODAL_FIELD_REASON);
    assert.equal(outcomes.MODAL_FIELD_REASON, "reason", "07's readModalText key");
    assert.equal(field.required, false, "the reason is OPTIONAL (issue §4)");
    assert.equal(field.style, 2, "Paragraph — the only style that can present the 1000-char cap");
    assert.equal(field.max_length, db.MAX_DENIAL_REASON, "cap mirrors the repository (lazy read)");

    // customId round-trip through the shipped parser.
    assert.equal(parseTicketAppealId(modal.custom_id, AP_DENY_MODAL_PREFIX), "42");
  });

  it("timed denial: the ONE DM restates eligibility with the exact <t:F> (<t:R>) tokens; row law pins the injected clock", async () => {
    const expiresAt = T0 + 3 * DAY;
    const { record, appeal } = mkOpenAppeal(CID, { expiresAt });
    const reason = "re-offense pattern after two warnings";
    const D = makeDeps();
    const res = await outcomes.deny({ appealId: appeal.id, staffUserId: MOD_ID, reason, deps: D.deps });

    assert.equal(res.ok, true, res.error);
    assert.equal(res.code, "DENIED");
    assert.equal(res.timed, true);
    assert.equal(res.dmDelivered, true);
    assert.equal(res.ticketClosed, true);
    assert.equal(res.buttonsDisabled, true);
    assert.equal(res.userId, String(record.user_id));
    assert.equal(res.banNumber, `B-${record.ban_number}`);

    // Expected tokens computed FROM the injected data — never re-derived lazily.
    const sec = Math.floor(expiresAt / 1000);
    const dm = D.dms[0];
    assert.equal(D.dms.length, 1);
    assert.equal(dm.userId, String(record.user_id));
    assert.ok(dm.content.includes(`**Appeal:** denied`), dm.content);
    assert.ok(dm.content.includes(`**Eligible again:** <t:${sec}:F> (<t:${sec}:R>)`), dm.content);
    assert.ok(dm.content.includes(tsFull(expiresAt)) && dm.content.includes(tsRelative(expiresAt)));
    assert.ok(dm.content.includes("**Conversation:**"), dm.content);
    assert.ok(dm.content.includes(`**Staff note:**`), dm.content);

    // Row law — decided_at is the INJECTED instant, denial_reason is RAW.
    const row = db.getAppealById(appeal.id);
    assert.equal(row.status, "denied");
    assert.equal(row.decided_by, MOD_ID);
    assert.equal(row.decided_at, NOW, "injected clock — exact");
    assert.equal(row.denial_reason, reason, "stored VERBATIM (escaped at render only)");

    // The SHARED close flow runs with the exact engine reason + passthroughs.
    assert.equal(D.ticketReads.length, 1);
    assert.deepEqual(D.ticketReads[0], [CID, appeal.ticket_channel_id]);
    assert.equal(D.softCloses.length, 1);
    const close = D.softCloses[0];
    assert.equal(close.closedBy, MOD_ID);
    assert.equal(close.closeReason, "Ban appeal decided — appeal denied");
    assert.equal(close.channel, D.deps.channel, "the injected channel duck is passed through");
    assert.equal(close.ticket.ticket_number, 42, "the ticket row from getTicketByChannel is passed through");

    // Buttons disabled via the interaction's own message (components:[] patch).
    assert.ok(D.calls.some((c) => c[0] === "interaction.update" && c[1] === "components:0"));

    assert.deepEqual(
      details(auditFor(CID, "banAppeals.denied", appeal.id)[0]),
      {
        ban_record_id: record.id,
        ban_number: record.ban_number,
        subject_user_id: record.user_id,
        timed: true,
        has_denial_reason: true,
        dm_delivered: true,
      },
    );
    assertCleanUserCopy(D.dms);
  });

  it("permanent denial: the no-eligibility phrasing — timed tokens ABSENT, no staff note", async () => {
    const { appeal } = mkOpenAppeal(CID, { expiresAt: null });
    const D = makeDeps();
    const res = await outcomes.deny({ appealId: appeal.id, staffUserId: MOD_ID, deps: D.deps });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.timed, false);

    const dm = D.dms[0];
    assert.ok(dm.content.includes("**Expiry:** none — this ban has no set end date"), dm.content);
    assert.ok(!dm.content.includes("**Eligible again:**"), dm.content);
    assert.ok(!dm.content.includes("<t:"), `permanent denial carries NO timestamp tokens: ${dm.content}`);
    assert.ok(!dm.content.includes("**Staff note:**"), dm.content);
    assert.equal(details(auditFor(CID, "banAppeals.denied", appeal.id)[0]).timed, false);
    assertCleanUserCopy(D.dms);
  });

  it("staff note: rendered escaped-VERBATIM (planted markup inert), stored RAW in denial_reason", async () => {
    const { appeal } = mkOpenAppeal(CID, { expiresAt: T0 + DAY });
    const reason = "@everyone **shill** <@123456789012345678>";
    const D = makeDeps();
    const res = await outcomes.deny({ appealId: appeal.id, staffUserId: MOD_ID, reason, deps: D.deps });
    assert.equal(res.ok, true, res.error);

    const dm = D.dms[0].content;
    assert.ok(dm.includes("**Staff note:**"), dm);
    assert.ok(dm.includes("\\@everyone"), `note must be escaped-inert: ${dm}`);
    assert.ok(dm.includes("\\*\\*shill\\*\\*"), `markdown must render inert: ${dm}`);
    assert.ok(!/(?<!\\)@everyone/.test(dm), "no UNESCAPED @everyone survives");
    assert.ok(!dm.includes("<@123456789012345678>"), "no live-mention shape survives");

    assert.equal(db.getAppealById(appeal.id).denial_reason, reason, "raw storage; escape at render only");
  });

  it("over-cap reason: REASON_TOO_LONG refused BEFORE the claim; exact-cap decides fine", async () => {
    const over = mkOpenAppeal(CID);
    const D1 = makeDeps();
    const tooLong = await outcomes.deny({
      appealId: over.appeal.id,
      staffUserId: MOD_ID,
      reason: "x".repeat(db.MAX_DENIAL_REASON + 1),
      deps: D1.deps,
    });
    assert.equal(tooLong.ok, false);
    assert.equal(tooLong.code, "REASON_TOO_LONG");
    assert.match(tooLong.error, /too long \(max 1000 characters\)/);
    assert.deepEqual(D1.calls, [], "refused BEFORE the claim — nothing ran");
    assert.equal(db.getAppealById(over.appeal.id).status, "open", "refusal mutated nothing");

    const at = mkOpenAppeal(CID);
    const D2 = makeDeps();
    const boundary = await outcomes.deny({
      appealId: at.appeal.id,
      staffUserId: MOD_ID,
      reason: "y".repeat(db.MAX_DENIAL_REASON),
      deps: D2.deps,
    });
    assert.equal(boundary.ok, true, boundary.error);
    assert.equal(db.getAppealById(at.appeal.id).status, "denied", "exactly at cap decides");
  });

  it("unreachable ticket channel: the close SKIP is pinned in the ledger (and logged), the denial still succeeds", async () => {
    const { appeal } = mkOpenAppeal(CID);
    const D = makeDeps({ channel: undefined }); // ChannelDelete-style absence
    const res = await outcomes.deny({ appealId: appeal.id, staffUserId: MOD_ID, deps: D.deps });

    assert.equal(res.ok, true, res.error);
    assert.equal(res.ticketClosed, false);
    assert.equal(D.softCloses.length, 0, "no close ran — the channel is gone");
    assert.ok(
      res.closeWarnings.some((w) => w.includes("no longer exists — close was skipped")),
      JSON.stringify(res.closeWarnings),
    );
    assert.equal(res.dmDelivered, true, "the denial DM is the user's answer regardless");
    assert.equal(D.dms.length, 1);
  });
});

/* ═══════════════════════ 6. PLAIN CLOSE (ChannelDelete path) ═══════════════ */

describe("outcomes.plainClose — the neutral, ban-untouched path", () => {
  const CID = communityKey("773-outcomes-plain");

  it("ChannelDelete on an OPEN appeal: neutral DM, status closed, decided_by NULL, ban record UNTOUCHED", async () => {
    const { record, appeal, channel } = mkOpenAppeal(CID, { expiresAt: T0 + DAY });
    // ChannelDelete realism: the channel is GONE (client resolves null) — the
    // close leg skips with its note; no message reference — the button leg
    // records its logged skip. Both ride the ledger, never fail it.
    const D = makeDeps({ interaction: undefined, channel: null });
    const res = await outcomes.plainClose({ communityId: CID, ticketChannelId: channel, deps: D.deps });

    assert.equal(res.ok, true, res.error);
    assert.equal(res.code, "CLOSED");
    assert.equal(res.dmDelivered, true);

    // Row law: attribution-FREE on the event path; injected clock pinned.
    const row = db.getAppealById(appeal.id);
    assert.equal(row.status, "closed");
    assert.equal(row.decided_by, null, "the event path claims without attribution (repo law)");
    assert.equal(row.decided_at, NOW);

    // The neutral copy: no decision claimed, the ban stands.
    assert.equal(D.dms.length, 1);
    const dm = D.dms[0];
    assert.ok(dm.content.includes("staff ended the conversation"), dm.content);
    assert.ok(dm.content.includes("without a decision — the ban stands and the relay is closed"), dm.content);

    // THE BAN IS UNTOUCHED — every ban-side seam recorded ZERO calls.
    assert.deepEqual(namesOf(D.calls, "unbanMember", "createInvite", "claimWelcome", "recordWelcomeDmSent"), []);
    const untouched = db.getBanRecord(record.id);
    assert.equal(untouched.status, "active");
    assert.equal(untouched.welcome_dm_sent, 0, "no welcome spend on plain-close");
    assert.equal(untouched.unban_reason, null);

    // ChannelDelete realism: no message reference (skip logged), channel gone
    // (close skipped with its note) — both ride the ledger, never fail it.
    assert.equal(res.buttonsDisabled, false);
    assert.ok(res.warnings.some((w) => w.includes("Header buttons were not disabled")), JSON.stringify(res.warnings));
    assert.ok(D.logs.warn.some((l) => l.includes("outcome button disable skipped")), JSON.stringify(D.logs.warn));
    assert.equal(res.ticketClosed, false);
    assert.ok(res.closeWarnings.some((w) => w.includes("close was skipped")), JSON.stringify(res.closeWarnings));

    assert.deepEqual(
      details(auditFor(CID, "banAppeals.closed", appeal.id)[0]),
      {
        ban_record_id: record.id,
        ban_number: record.ban_number,
        subject_user_id: record.user_id,
        ticket_channel_id: channel,
        dm_delivered: true,
      },
    );
    assertCleanUserCopy(D.dms);
  });

  it("decision-first ordering: a decided appeal gets NO neutral notice (benign skip, zero DMs)", async () => {
    // Granted first (decide → archive ordering), THEN the ChannelDelete arm.
    const granted = mkOpenAppeal(CID);
    const gd = makeDeps();
    assert.equal(
      (await outcomes.grantClemency({ appealId: granted.appeal.id, staffUserId: MOD_ID, deps: gd.deps })).ok,
      true,
    );
    const afterGrant = makeDeps();
    const r1 = await outcomes.plainClose({
      communityId: CID,
      ticketChannelId: granted.channel,
      deps: afterGrant.deps,
    });
    assert.equal(r1.ok, true, r1.error);
    assert.equal(r1.skipped, true, "a decided row is a BENIGN skip (outcomes' skip semantics)");
    assert.equal(r1.code, "NOT_OPEN");
    assert.equal(r1.status, "granted");
    assert.equal(afterGrant.dms.length, 0, "no second notice ever");
    assert.deepEqual(afterGrant.calls, [], "the skip reads the row and stops — no claim, no seams");

    const denied = mkOpenAppeal(CID);
    const dd = makeDeps();
    assert.equal(
      (await outcomes.deny({ appealId: denied.appeal.id, staffUserId: MOD_ID, deps: dd.deps })).ok,
      true,
    );
    const afterDeny = makeDeps();
    const r2 = await outcomes.plainClose({
      communityId: CID,
      ticketChannelId: denied.channel,
      deps: afterDeny.deps,
    });
    assert.equal(r2.skipped, true);
    assert.equal(r2.status, "denied");
    assert.equal(afterDeny.dms.length, 0);
  });

  it("plainClose racing grantClemency on the SAME appeal: first claim wins, the loser says nothing", async () => {
    // Arm 1: the clemency starts first (sync CAS before any await) → it wins.
    const a = mkOpenAppeal(CID);
    const Ga = makeDeps();
    const Pa = makeDeps();
    const [g1, p1] = await Promise.all([
      outcomes.grantClemency({ appealId: a.appeal.id, staffUserId: MOD_ID, deps: Ga.deps }),
      outcomes.plainClose({ communityId: CID, ticketChannelId: a.channel, deps: Pa.deps }),
    ]);
    assert.equal(g1.ok, true, `first starter wins: ${g1.error}`);
    // The neutral arm never even REACHES the claim: grantClemency's claim is
    // synchronous SQL and lands BEFORE plainClose's lenient pre-gate reads the
    // row, so the neutral arm takes the documented benign skip (state check
    // precedes the claim — the same law the decision-first test pins). The
    // decision's DM is the ONLY voice either way.
    assert.equal(p1.ok, true, p1.error);
    assert.equal(p1.skipped, true, "the neutral arm benignly skips");
    assert.equal(p1.code, "NOT_OPEN");
    assert.equal(p1.status, "granted");
    assert.equal(Pa.dms.length, 0, "the loser publishes NO neutral DM — the decision's DM is the answer");
    assert.equal(db.getAppealById(a.appeal.id).status, "granted");
    assert.equal(Ga.dms.length + Pa.dms.length, 1);

    // Arm 2: the plain-close starts first on a fresh appeal → it wins; the
    // clemency click loses with the `closed`-keyed already-decided error.
    const b = mkOpenAppeal(CID);
    const Gb = makeDeps();
    const Pb = makeDeps();
    const [p2, g2] = await Promise.all([
      outcomes.plainClose({ communityId: CID, ticketChannelId: b.channel, deps: Pb.deps }),
      outcomes.grantClemency({ appealId: b.appeal.id, staffUserId: MOD_ID, deps: Gb.deps }),
    ]);
    assert.equal(p2.ok, true, p2.error);
    assert.equal(g2.ok, false);
    assert.equal(g2.code, "ALREADY_DECIDED");
    assert.equal(g2.liveStatus, "closed");
    assert.equal(g2.error, outcomes.alreadyDecidedError("closed"));
    assert.deepEqual(Gb.calls, [], "the losing clemency performed ZERO calls");
    assert.equal(db.getAppealById(b.appeal.id).status, "closed");
    assert.equal(Pb.dms.length + Gb.dms.length, 1, "exactly ONE user-facing DM across the whole race");
  });

  it("target law: NO_TARGET without args, a channel-less deletion is a silent benign skip, a strict id miss refuses", async () => {
    const D = makeDeps();
    const nothing = await outcomes.plainClose({ deps: D.deps });
    assert.equal(nothing.ok, false);
    assert.equal(nothing.code, "NO_TARGET");

    const ghost = await outcomes.plainClose({ communityId: CID, ticketChannelId: "ghost-channel", deps: D.deps });
    assert.equal(ghost.ok, true, "99.9% of deletions bind no appeal — the norm, not a failure");
    assert.equal(ghost.skipped, true);
    assert.equal(ghost.code, "NO_APPEAL");

    const missing = await outcomes.plainClose({ appealId: 9_999_999, deps: D.deps });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "NO_APPEAL", "the direct-id path is STRICT");

    // A garbage id is treated as ABSENT (gate law) → the channel arm demands its pair.
    const garbage = await outcomes.plainClose({ appealId: "not-a-digit", deps: D.deps });
    assert.equal(garbage.code, "NO_TARGET");
  });
});

/* ═══════════════════════ 7. POST-DECISION GUARDS + BELTS ═══════════════════ */

describe("outcomes.post-decision guards — the ferry stops structurally, belts never wedge", () => {
  const CID = communityKey("773-outcomes-post");

  it("after a grant, EVERY arm answers the live row's truth — copy keyed by the live status", async () => {
    const { appeal } = mkOpenAppeal(CID);
    const first = makeDeps();
    assert.equal(
      (await outcomes.grantClemency({ appealId: appeal.id, staffUserId: MOD_ID, deps: first.deps })).ok,
      true,
    );

    const again = makeDeps();
    const g = await outcomes.grantClemency({ appealId: appeal.id, staffUserId: MOD_OTHER, deps: again.deps });
    assert.equal(g.ok, false);
    assert.equal(g.code, "ALREADY_DECIDED");
    assert.equal(g.error, outcomes.alreadyDecidedError("granted"), "status-keyed copy — pinned to the builder");

    const d = makeDeps();
    const dn = await outcomes.deny({ appealId: appeal.id, staffUserId: MOD_OTHER, deps: d.deps });
    assert.equal(dn.code, "ALREADY_DECIDED");
    assert.equal(dn.error, outcomes.alreadyDecidedError("granted"));

    const p = makeDeps();
    const pc = await outcomes.plainClose({ appealId: appeal.id, deps: p.deps });
    assert.equal(pc.ok, true, "plain-close on a decided row keeps the BENIGN skip semantics");
    assert.equal(pc.skipped, true);
    assert.equal(pc.code, "NOT_OPEN");

    assert.deepEqual(again.calls, []);
    assert.deepEqual(d.calls, []);
    assert.deepEqual(p.calls, [], "zero seam calls across all three late arms");

    // A never-opened (filed) row gets the OTHER sentence — the state, not a decision.
    const filed = db.fileAppeal({
      communityId: CID,
      banRecordId: mkRecord(CID).id,
      appealStatement: "filed only",
      createdAt: T0,
    });
    assert.equal(filed.ok, true, filed.error);
    const f = makeDeps();
    const fr = await outcomes.grantClemency({ appealId: filed.appeal.id, staffUserId: MOD_ID, deps: f.deps });
    assert.equal(fr.ok, false);
    assert.equal(fr.code, "ALREADY_DECIDED");
    assert.equal(fr.error, outcomes.alreadyDecidedError("filed"));
    assert.match(fr.error, /no longer open \(its status is `filed`\)/, "non-decided states name the STATE");
    assert.deepEqual(f.calls, []);
  });

  it("button-disable edit failure is attempted, logged with ids, and stays NON-FATAL", async () => {
    const { appeal } = mkOpenAppeal(CID);
    const D = makeDeps({
      interaction: undefined, // force the headerMessage leg
      headerMessage: {
        edit: async () => {
          throw new Error("50027: Message was edited");
        },
      },
    });
    const res = await outcomes.grantClemency({ appealId: appeal.id, staffUserId: MOD_ID, deps: D.deps });

    assert.equal(res.ok, true, "the outcome never dies on a cosmetic edit");
    assert.equal(res.buttonsDisabled, false);
    assert.ok(
      res.warnings.some((w) => w.includes("Header buttons could not be disabled")),
      JSON.stringify(res.warnings),
    );
    assert.ok(
      D.logs.warn.some((l) => l.includes("outcome header edit failed (non-fatal)") && l.includes(`appeal=${appeal.id}`)),
      JSON.stringify(D.logs.warn),
    );
  });

  it("DM failure: logged with the full id set, NEVER echoed — the already-won claim still reports ok", async () => {
    const { record, appeal } = mkOpenAppeal(CID);
    const D = makeDeps({ dmResult: { ok: false, error: "Cannot send messages to this user (50007)" } });
    const res = await outcomes.grantClemency({ appealId: appeal.id, staffUserId: MOD_ID, deps: D.deps });

    assert.equal(res.ok, true, "the claim was already won — the DM failure cannot unwind it");
    assert.equal(res.dmDelivered, false);
    assert.equal(res.dmError, "Cannot send messages to this user (50007)", "the cause rides for the caller's log line");

    assert.ok(
      D.logs.error.some(
        (l) =>
          l.includes("clemency DM failed") &&
          l.includes(`appeal=${appeal.id}`) &&
          l.includes(`user=${record.user_id}`) &&
          l.includes(`ticket=${appeal.ticket_channel_id}`) &&
          l.includes("50007"),
      ),
      JSON.stringify(D.logs.error),
    );
    // K2: the DM cause is NEVER echoed into channel copy — no notes posted at
    // all on this run (a DM failure is not a warning), and nothing leaks.
    assert.equal(D.channelNotes.length, 0);
    assert.ok(!res.warnings.some((w) => w.includes("50007")), JSON.stringify(res.warnings));
    assert.ok(!D.dms.some((dm) => dm.content.includes("50007")));
  });

  it("every exploding seam answers a VALUE, never an exception (the never-throws contract)", async () => {
    const boom = (label) => {
      throw new Error(`boom:${label}`);
    };

    // Appeal reader throws → INTERNAL on all three entries.
    const reader = makeDeps({ getAppealById: () => boom("read") });
    for (const res of [
      await outcomes.grantClemency({ appealId: 1, deps: reader.deps }),
      await outcomes.deny({ appealId: 1, deps: reader.deps }),
      await outcomes.plainClose({ appealId: 1, deps: reader.deps }),
    ]) {
      assert.equal(res.ok, false);
      assert.equal(res.code, "INTERNAL");
      assert.match(res.error, /boom:read/);
    }

    // Claim throws → INTERNAL (and the row stays open — nothing half-ran).
    const decided = mkOpenAppeal(CID);
    const claimer = makeDeps({ claimAppealOutcome: () => boom("claim") });
    const cr = await outcomes.grantClemency({ appealId: decided.appeal.id, staffUserId: MOD_ID, deps: claimer.deps });
    assert.equal(cr.ok, false);
    assert.equal(cr.code, "INTERNAL");
    assert.equal(db.getAppealById(decided.appeal.id).status, "open", "a throwing claim decided NOTHING");

    // Ban record gone after the claim (FK surprise) → NO_RECORD honesty: the
    // decision stands, everything else is impossible and SAYS so.
    const orphan = mkOpenAppeal(CID);
    const noRec = makeDeps({ getBanRecord: () => boom("record") });
    const nr = await outcomes.grantClemency({
      appealId: orphan.appeal.id,
      staffUserId: MOD_ID,
      deps: noRec.deps,
    });
    assert.equal(nr.ok, false);
    assert.equal(nr.code, "NO_RECORD");
    assert.equal(nr.decision, "granted", "the decision IS recorded — the report is honest about the rest");
    assert.equal(db.getAppealById(orphan.appeal.id).status, "granted");
    assert.equal(details(auditFor(CID, "banAppeals.clemency_granted", orphan.appeal.id)[0]).record_missing, true);
    assert.equal(noRec.dms.length, 0, "no user id → no DM, never a fabricated one");

    // Settle / invite / close / audit explosions ride warnings — outcome ok.
    const tough = mkOpenAppeal(CID);
    const T = makeDeps({
      finalizeUnban: () => boom("settle"),
      createInvite: async () => boom("invite"),
      softCloseTicket: async () => boom("close"),
      recordSystemAudit: () => boom("audit"),
    });
    const tr = await outcomes.grantClemency({ appealId: tough.appeal.id, staffUserId: MOD_ID, deps: T.deps });
    assert.equal(tr.ok, true, tr.error);
    assert.ok(tr.warnings.some((w) => w.includes("Record settle failed:") && w.includes("boom:settle")), JSON.stringify(tr.warnings));
    assert.ok(tr.warnings.some((w) => w.includes("Invite not created") && w.includes("boom:invite")), JSON.stringify(tr.warnings));
    assert.ok(tr.warnings.some((w) => w.includes("Ticket close failed") && w.includes("boom:close")), JSON.stringify(tr.warnings));
    assert.ok(T.logs.error.some((l) => l.includes("outcome audit failed") && l.includes("boom:audit")), JSON.stringify(T.logs.error));
    assert.equal(tr.dmDelivered, true, "the ONE DM still runs with the invite-failure copy");
    assert.ok(T.dms[0].content.includes("could not be created"), T.dms[0].content);

    // Unban throwing (not just failing) → UNBAN_FAILED value, never a rejection.
    const hard = mkOpenAppeal(CID);
    const H = makeDeps({
      unbanMember: async () => {
        boom("unban");
      },
    });
    const hr = await outcomes.grantClemency({ appealId: hard.appeal.id, staffUserId: MOD_ID, deps: H.deps });
    assert.equal(hr.ok, false);
    assert.equal(hr.code, "UNBAN_FAILED");
    assert.match(hr.error, /boom:unban/);

    // NO outbound surface at all is a REPORTED failure (rule 6), not a crash.
    const bare = mkOpenAppeal(CID);
    const bareRes = await outcomes.grantClemency({
      appealId: bare.appeal.id,
      staffUserId: MOD_ID,
      deps: {
        nowMs: NOW,
        log: { info() {}, warn() {}, error() {} },
        claimWelcome: (id) => db.claimWelcome(id),
        recordWelcomeDmSent: (id) => db.recordWelcomeDmSent(id),
        getTicketByChannel: () => null,
      },
    });
    assert.equal(bareRes.ok, false);
    assert.equal(bareRes.code, "UNBAN_FAILED", "a missing surface never crashes the outcome");
    assert.match(bareRes.error, /unbanMember/);
    assert.equal(db.getAppealById(bare.appeal.id).status, "granted", "decision stands; execution reported");
  });

  it("garbage gates: nothing is read, nothing is decided", async () => {
    for (const bad of [null, undefined, 0, -1, "abc", "12a", 1.5, Number.NaN]) {
      const D = makeDeps();
      const g = await outcomes.grantClemency({ appealId: bad, deps: D.deps });
      assert.equal(g.ok, false, `${String(bad)} must refuse`);
      assert.equal(g.code, "NO_APPEAL");
      const dn = await outcomes.deny({ appealId: bad, deps: D.deps });
      assert.equal(dn.ok, false);
      assert.equal(dn.code, "NO_APPEAL");
      assert.deepEqual(D.calls, [], `garbage ${String(bad)} touched no seam`);
    }
  });
});

/* ═══════════ 8. closeOnBanEnd — the #811 system auto-close ════════════════ */

describe("outcomes.closeOnBanEnd — the ban-ended system close (#811)", () => {
  const CID = communityKey("811-outcomes-close");

  /** FILED-only seed (ticket never opened) — the dead-pending shape. */
  function mkFiledAppeal(communityId) {
    const record = mkRecord(communityId);
    const filed = db.fileAppeal({
      communityId,
      banRecordId: record.id,
      appealStatement: "please review",
      createdAt: T0,
    });
    assert.equal(filed.ok, true, `filed seed failed: ${filed.error}`);
    return { record, appeal: filed.appeal };
  }

  it("garbage gates: NO_TARGET refuses before any read", async () => {
    for (const bad of [null, undefined, 0, -1, "abc", 1.5]) {
      const D = makeDeps();
      const r1 = await outcomes.closeOnBanEnd({ communityId: bad, banRecordId: 1, deps: D.deps });
      assert.equal(r1.ok, false, `${String(bad)} community must refuse`);
      assert.equal(r1.code, "NO_TARGET");
      const r2 = await outcomes.closeOnBanEnd({ communityId: CID, banRecordId: bad, deps: D.deps });
      assert.equal(r2.ok, false);
      assert.equal(r2.code, "NO_TARGET");
      assert.deepEqual(D.calls, [], `garbage ${String(bad)} touched no seam`);
    }
  });

  it("NO appeal behind the ban (the common case): honest silent skip, zero seams", async () => {
    const record = mkRecord(CID);
    const D = makeDeps();
    const res = await outcomes.closeOnBanEnd({
      communityId: CID,
      banRecordId: record.id,
      cause: "the ban expired and was auto-unbanned",
      deps: D.deps,
    });
    assert.deepEqual({ ok: res.ok, acted: res.acted, skipped: res.skipped }, { ok: true, acted: false, skipped: true });
    assert.deepEqual(D.calls, [], "a ban with no appeal is silence, not noise");
    assert.equal(D.dms.length, 0);
    assert.deepEqual(auditFor(CID, "banAppeals.closed_ban_ended", 0), [], "nothing audited for nothing");
  });

  it("FILED close: CAS lands, NO ticket legs (never had one), audit prior=filed, ZERO user DMs", async () => {
    const { record, appeal } = mkFiledAppeal(CID);
    const D = makeDeps();
    const res = await outcomes.closeOnBanEnd({
      communityId: CID,
      banRecordId: record.id,
      cause: "the ban was lifted outside the bot",
      deps: D.deps,
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.acted, true);
    assert.equal(res.priorStatus, "filed");
    assert.equal(res.ticketClosed, false);

    const row = db.getAppealById(appeal.id);
    assert.equal(row.status, "closed");
    assert.equal(row.decided_by, "system:ban-ended");
    assert.equal(row.decided_at, NOW, "the injected clock rides the CAS");
    assert.match(row.denial_reason, /lifted outside the bot.*auto-closed/s);

    // No channel existed → no note seam, no ticket close seam, NO DM ever.
    assert.deepEqual(namesOf(D.calls, "sendChannel", "softCloseTicket", "sendDm"), []);
    assert.equal(D.dms.length, 0, "the ban-end already speaks — no second lifecycle DM");

    const audited = auditFor(CID, "banAppeals.closed_ban_ended", appeal.id);
    assert.equal(audited.length, 1);
    const det = details(audited[0]);
    assert.equal(det.prior_status, "filed");
    assert.equal(det.cause, "the ban was lifted outside the bot");
    assert.equal(det.ticket_closed, false);
    assert.equal(det.ban_number, record.ban_number);
    assert.equal(det.subject_user_id, record.user_id);
    assert.equal(audited[0].origin, "system", "system action, no fake actor");
  });

  it("OPEN close: note BEFORE the close, shared close flow runs, ferry dies structurally", async () => {
    const { record, appeal, channel } = mkOpenAppeal(CID);
    const D = makeDeps();
    const res = await outcomes.closeOnBanEnd({
      communityId: CID,
      banRecordId: record.id,
      cause: "the ban expired and was auto-unbanned",
      deps: D.deps,
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.acted, true);
    assert.equal(res.priorStatus, "open");
    assert.equal(res.ticketClosed, true);

    // Staff-side note: into the ticket channel, pings stripped, cause quoted.
    assert.equal(D.channelNotes.length, 1);
    assert.equal(D.channelNotes[0].channelId, channel);
    assert.match(D.channelNotes[0].payload.content, /System — ban ended/);
    assert.match(D.channelNotes[0].payload.content, /The ban expired and was auto-unbanned/);
    assert.deepEqual(D.channelNotes[0].payload.allowedMentions, { parse: [] });

    // ORDER law: the note lands BEFORE the channel goes dark on the close.
    const noteAt = D.calls.findIndex((c) => c[0] === "sendChannel");
    const closeAt = D.calls.findIndex((c) => c[0] === "softCloseTicket");
    assert.ok(noteAt >= 0 && closeAt >= 0 && noteAt < closeAt, `note(${noteAt}) < close(${closeAt})`);

    // Shared close flow with the honest reason.
    assert.equal(D.softCloses.length, 1);
    assert.match(D.softCloses[0].closeReason, /Ban ended \(the ban expired and was auto-unbanned\).*auto-closed/s);

    // Ban record UNTOUCHED by the appeal layer (the settle already happened
    // upstream — this engine must never write ban-side).
    assert.deepEqual(namesOf(D.calls, "unbanMember", "claimWelcome", "recordWelcomeDmSent", "createInvite", "sendDm"), []);

    // The row + the ferry lane (structural stop).
    assert.equal(db.getAppealById(appeal.id).status, "closed");
    assert.deepEqual(db.listOpenAppealsByUser(record.user_id).filter((a) => a.id === appeal.id), []);

    const det = details(auditFor(CID, "banAppeals.closed_ban_ended", appeal.id)[0]);
    assert.equal(det.prior_status, "open");
    assert.equal(det.ticket_closed, true);
    assert.equal(det.ticket_channel_id, channel);
  });

  it("a decided appeal is a benign skip: no second close, zero seams", async () => {
    const { record, appeal } = mkOpenAppeal(CID);
    const g = makeDeps();
    assert.equal((await outcomes.grantClemency({ appealId: appeal.id, staffUserId: MOD_ID, deps: g.deps })).ok, true);

    const D = makeDeps();
    const res = await outcomes.closeOnBanEnd({
      communityId: CID, banRecordId: record.id, cause: "the ban expired", deps: D.deps,
    });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, true);
    assert.equal(res.code, "NOT_OPEN");
    assert.equal(res.status, "granted", "the live truth rides the skip");
    assert.deepEqual(D.calls, [], "the skip reads the row and stops — THEIR flow owns the ticket");
  });

  it("CAS LOSS (staff decided mid-flight): silent report of the live truth, zero ticket legs", async () => {
    const { record, appeal } = mkOpenAppeal(CID);
    // Stale read (the row read OPEN), then the CAS answers denied — the
    // exact interleaving: staff denies between our read and our write.
    const stale = { ...db.getAppealById(appeal.id), status: "open" };
    const D = makeDeps({
      getAppealByBanRecord: () => stale,
      closeAppealOnBanEnd: async () => ({ ok: true, won: false, appeal: { status: "denied" } }),
    });
    const res = await outcomes.closeOnBanEnd({
      communityId: CID, banRecordId: record.id, cause: "the ban expired", deps: D.deps,
    });
    assert.equal(res.ok, true, "a CAS loss is a REPORTED outcome, not an error");
    assert.equal(res.acted, false);
    assert.equal(res.code, "ALREADY_DECIDED");
    assert.equal(res.liveStatus, "denied");
    assert.deepEqual(namesOf(D.calls, "sendChannel", "softCloseTicket", "sendDm"), [], "the winner owns the ticket");
    assert.ok(D.logs.info.some((l) => l.includes("ban-ended close LOST the CAS")), JSON.stringify(D.logs.info));
  });

  it("CAS ERROR answers CLAIM_FAILED with its cause (never a silent drop)", async () => {
    const { record, appeal } = mkOpenAppeal(CID);
    const stale = { ...db.getAppealById(appeal.id), status: "open" };
    const D = makeDeps({
      getAppealByBanRecord: () => stale,
      closeAppealOnBanEnd: async () => ({ ok: false, error: "SQLITE_BUSY: database is locked" }),
    });
    const res = await outcomes.closeOnBanEnd({
      communityId: CID, banRecordId: record.id, cause: "x", deps: D.deps,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "CLAIM_FAILED");
    assert.match(res.error, /SQLITE_BUSY/);
    assert.ok(D.logs.error.some((l) => l.includes("ban-ended close CAS failed")));
    assert.equal(db.getAppealById(appeal.id).status, "open", "nothing half-happened");
  });

  it("partial failure law: a throwing ticket note rides warnings, the close still completes", async () => {
    const { record, appeal, channel } = mkOpenAppeal(CID);
    const D = makeDeps({
      sendChannel: async () => {
        throw new Error("channels are on fire");
      },
    });
    const res = await outcomes.closeOnBanEnd({
      communityId: CID, banRecordId: record.id, cause: "the ban expired", deps: D.deps,
    });
    assert.equal(res.ok, true);
    assert.equal(res.acted, true, "the CAS won — the close IS the truth");
    assert.equal(res.ticketClosed, true, "the note failure never cancels the ticket close");
    assert.ok(res.warnings.some((w) => w.includes("Ticket notice failed")), JSON.stringify(res.warnings));
    assert.equal(db.getAppealById(appeal.id).status, "closed");
  });

  it("a throwing softCloseTicket rides closeWarnings; the closed appeal stands", async () => {
    const { record, appeal } = mkOpenAppeal(CID);
    const D = makeDeps({
      softCloseTicket: async () => {
        throw new Error("close pipeline down");
      },
    });
    const res = await outcomes.closeOnBanEnd({
      communityId: CID, banRecordId: record.id, cause: "the ban expired", deps: D.deps,
    });
    assert.equal(res.ok, true);
    assert.equal(res.acted, true);
    assert.equal(res.ticketClosed, false);
    assert.ok(res.closeWarnings.some((w) => w.includes("Ticket close failed")), JSON.stringify(res.closeWarnings));
    assert.equal(db.getAppealById(appeal.id).status, "closed", "the appeal CAS is already durable");
  });

  it("cause fallback: a blank cause still closes with honest generic copy", async () => {
    const { record, appeal } = mkOpenAppeal(CID);
    const D = makeDeps();
    const res = await outcomes.closeOnBanEnd({ communityId: CID, banRecordId: record.id, deps: D.deps });
    assert.equal(res.ok, true);
    assert.equal(res.priorStatus, "open");
    assert.equal(D.channelNotes.length, 1);
    assert.match(D.channelNotes[0].payload.content, /The ban ended/);
    assert.equal(db.getAppealById(appeal.id).status, "closed");
  });
});
