/**
 * #772: banService flow unit suite (test/ban-lifecycle-service.test.js).
 *
 * Pins the LOCKED flow law from banService.js's header contract:
 *  banUser            guards (dup-active → self-ban → staff-subject) →
 *                     ban-time DM FIRST → outbound.banMember → record
 *                     insert AFTER the successful ban. DM failure NEVER
 *                     blocks the ban (K2: logged with ids, returned in
 *                     warnings[], never an apology).
 *  finalizeExpiry     claimUnban CAS first — a loser performs ZERO outbound
 *                     calls; NOT_BANNED (10026) settles `unbanned_manual`
 *                     ok:true (not an error); then the welcome path.
 *  handleExternalUnban manual beats ticker; welcome exactly once per cycle.
 *  handleRejoin       pending_rejoin + unban inside the 30-day window →
 *                     ONE attempt → `welcomed` REGARDLESS of DM outcome.
 *
 * Method (per the service header's injected-deps contract): a recording
 * fake outbound (sendDm/banMember/unbanMember/fetchGuild push into one
 * shared `calls` array → call ORDER is asserted, not hoped at), the four
 * individually-overridable guard seams (automod executor law), an injected
 * `now` clock, an injected console-like `log`, and the REAL temp-DB
 * repositories (loadDb) so the CAS primitives are the shipped ones.
 */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

after(() => cleanup());

const banService = require("../src/features/banLifecycle/banService");
const { DURATION_MIN_MS, DURATION_MAX_MS, REJOIN_WELCOME_WINDOW_DAYS } =
  require("../src/features/banLifecycle/constants");

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY = 86_400_000;

const GUILD = "978100000000000001";
const MOD = "878100000000000012";
const SUB = "878100000000000013";
const ROLE = "678100000000000021";

let seq = 0;
/** Fresh community per test: B-1 numbering and rows never bleed. */
const freshCid = () => communityKey(`9781000000000009${String(++seq).padStart(3, "0")}`);

// ── fakes ────────────────────────────────────────────────────────────────────

function makeLog() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    log: {
      info: (...a) => lines.info.push(a.map(String).join(" ")),
      warn: (...a) => lines.warn.push(a.map(String).join(" ")),
      error: (...a) => lines.error.push(a.map(String).join(" ")),
    },
  };
}

/**
 * Recording world: ONE calls array shared by the outbound and the guard
 * seams, so a test can assert the full observable ordering
 * guards → sendDm → banMember (record-insert is pinned from INSIDE the
 * banMember stub via activeBefore: the row must NOT exist yet at ban time).
 */
function makeWorld({ guards = {}, withManageGuildSeam = true } = {}) {
  const calls = [];
  const ob = {
    dmResult: { ok: true },
    banResult: { ok: true },
    unbanResult: { ok: true },
    async sendDm(userId, payload) {
      calls.push({ op: "sendDm", userId, payload });
      if (ob.dmThrows) throw ob.dmThrows;
      return ob.dmResult;
    },
    async banMember(communityId, userId, reason) {
      calls.push({
        op: "banMember",
        communityId,
        userId: String(userId),
        reason,
        activeBefore: !!db.findActiveBanRecord(communityId, String(userId)),
      });
      return ob.banResult;
    },
    async unbanMember(communityId, userId, reason) {
      calls.push({ op: "unbanMember", communityId, userId: String(userId), reason });
      return ob.unbanResult;
    },
    async fetchGuild(communityId) {
      calls.push({ op: "fetchGuild", communityId });
      return { name: "Fetched Guild" };
    },
  };

  const seamSet = {
    fetchMemberRoleIds: async () => {
      calls.push({ op: "guard:roles" });
      return guards.roles ?? [];
    },
    fetchMemberTopRolePosition: async () => {
      calls.push({ op: "guard:subjectTop" });
      if (guards.subjectTopThrows) throw guards.subjectTopThrows;
      return guards.subjectTop ?? 1;
    },
    fetchBotTopRolePosition: async () => {
      calls.push({ op: "guard:botTop" });
      return guards.botTop ?? 10;
    },
    fetchMemberHasManageGuild: async () => {
      calls.push({ op: "guard:manageGuild" });
      return guards.manageGuild ?? false;
    },
  };
  // The belt-skip posture needs the seam ABSENT (and no client) — the
  // service then logs the gap and defers to the staff_roles+hierarchy law.
  if (!withManageGuildSeam) delete seamSet.fetchMemberHasManageGuild;

  const { lines, log } = makeLog();
  return { calls, ob, seamSet, lines, log };
}

/** Base banUser opts per the service's flat injected-deps contract. */
function banOpts(cid, w, overrides = {}) {
  return {
    communityId: cid,
    userId: SUB,
    moderatorId: MOD,
    reason: "mass raiding",
    source: "staff",
    guildId: GUILD,
    guildName: "Test Guild",
    settings: { ban_dm: 1, welcome_back_dm: 1 },
    now: NOW,
    outbound: w.ob,
    log: w.log,
    ...w.seamSet,
    ...overrides,
  };
}

const ops = (calls) => calls.map((c) => c.op);
const auditRows = (cid, action) =>
  db.listAdminAudit(cid, { limit: 50 }).filter((r) => r.action === action);

// ═══ banUser — ORDER LAW: guards → DM(before ban) → ban → record ═══════════

test("banUser happy path runs guards → DM → banMember → record-insert in that exact order", async () => {
  const cid = freshCid();
  const w = makeWorld();
  const durationMs = 24 * 3_600_000;

  const res = await banService.banUser(banOpts(cid, w, { durationMs }));

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(ops(w.calls), [
    "guard:roles",
    "guard:manageGuild",
    "guard:subjectTop",
    "guard:botTop",
    "sendDm", // DM BEFORE the ban — while the shared-guild DM path exists
    "banMember",
  ]);

  // Record AFTER the successful ban: at banMember time NO row existed…
  const banCall = w.calls.find((c) => c.op === "banMember");
  assert.equal(banCall.activeBefore, false, "no record existed when the ban executed");
  // …and after it, the record is there with the locked shape.
  const row = db.getBanRecord(res.banRecordId);
  assert.ok(row, "record exists post-ban");
  assert.equal(row.status, "active");
  assert.equal(row.ban_number, 1);
  assert.equal(row.user_id, SUB);
  assert.equal(row.moderator_id, MOD);
  assert.equal(row.source, "staff");
  assert.equal(row.reason, "mass raiding");
  assert.equal(row.banned_at, NOW, "injected clock drives banned_at");
  assert.equal(row.expires_at, NOW + durationMs);
  assert.equal(row.ban_dm_sent, 1, "the delivered DM is stamped");
  assert.equal(row.welcome_dm_sent, 0);

  // #773 stable handle + human ref + facts out.
  assert.equal(res.banRecordId, row.id, "banRecordId mirrors the record id (appeal:<id> handle)");
  assert.equal(res.banNumber, "B-1");
  assert.equal(res.expiresAtMs, NOW + durationMs);
  assert.equal(res.banDmSent, true);
  assert.equal(res.banDmSkipped, false);
  assert.deepEqual(res.warnings, []);
  assert.equal(res.status, "active");

  // The ban DM carried BOTH stamps at the computed expiry.
  const dm = w.calls.find((c) => c.op === "sendDm");
  const unix = Math.floor((NOW + durationMs) / 1000);
  assert.ok(dm.payload.content.includes(`<t:${unix}:F>`), ":F in ban DM");
  assert.ok(dm.payload.content.includes(`<t:${unix}:R>`), ":R in ban DM");
  assert.ok(dm.payload.content.includes("**Test Guild**"), "explicit guildName used verbatim");

  // Staff bans own their audit at the COMMAND layer — the service writes
  // the system-origin row only for automod-origin bans.
  assert.deepEqual(auditRows(cid, "banLifecycle.ban").filter((r) => r.origin === "system"), []);
});

test("automod-source bans land exactly one system-origin banLifecycle.ban audit row", async () => {
  const cid = freshCid();
  const w = makeWorld();
  const res = await banService.banUser(
    banOpts(cid, w, { source: "automod", moderatorId: null, durationMs: 3_600_000 }),
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  const rows = auditRows(cid, "banLifecycle.ban").filter((r) => r.origin === "system");
  assert.equal(rows.length, 1, "one system row for the harness ban");
  assert.equal(rows[0].actor_user_id, null, "system rows are unattributed");
  assert.equal(rows[0].target_id, String(res.banRecordId));
});

// ═══ K2: DM law — fails → logged warning, ban STILL runs, no apology ════════

test("a REJECTED sendDm still results in a successful ban + record, with a non-fatal warning (#772 K2)", async () => {
  const cid = freshCid();
  const w = makeWorld();
  w.ob.dmResult = { ok: false, error: "Cannot send messages to this user" };

  const res = await banService.banUser(banOpts(cid, w, { durationMs: 60_000 }));

  assert.equal(res.ok, true, "the ban executes regardless of DM outcome");
  assert.equal(res.banDmSent, false);
  assert.deepEqual(res.warnings, ["Ban DM not delivered: Cannot send messages to this user"]);
  assert.ok(ops(w.calls).includes("banMember"), "ban ran after the failed DM");
  assert.ok(db.findActiveBanRecord(cid, SUB), "the record exists anyway");
  assert.equal(db.findActiveBanRecord(cid, SUB).ban_dm_sent, 0, "undelivered DM never stamps");

  // Never an apology, user-facing or otherwise (K2).
  assert.doesNotMatch(JSON.stringify(res), /sorry|apolog/i);
  // Logged with ids (rule 2).
  assert.ok(
    w.lines.warn.some((l) => l.includes(`[banlifecycle] ban DM failed community=${cid} user=${SUB}`)
      && l.includes("Cannot send messages to this user")),
    `warn log names the cause with ids: ${w.lines.warn}`,
  );
});

test("a THROWING sendDm is handled identically — cause surfaces in warnings[], ban still runs", async () => {
  const cid = freshCid();
  const w = makeWorld();
  w.ob.dmThrows = new Error("Request failed during DM");

  const res = await banService.banUser(banOpts(cid, w));
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings, ["Ban DM not delivered: Request failed during DM"]);
  assert.ok(ops(w.calls).includes("banMember"));
});

test("ban_dm off silences the DM entirely (banDmSkipped) but the ban + record run", async () => {
  const cid = freshCid();
  const w = makeWorld();
  const res = await banService.banUser(
    banOpts(cid, w, { settings: { ban_dm: 0, welcome_back_dm: 1 }, durationMs: 3_600_000 }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.banDmSkipped, true);
  assert.equal(res.banDmSent, false);
  assert.ok(!ops(w.calls).includes("sendDm"), "disabled toggle → total DM silence");
  assert.ok(ops(w.calls).includes("banMember"));
  assert.ok(db.findActiveBanRecord(cid, SUB));
});

// ═══ banMember failure → NO record ══════════════════════════════════════════

test("banMember failure returns the translated Discord cause and stores NO record", async () => {
  const cid = freshCid();
  const w = makeWorld();
  w.ob.banResult = { ok: false, error: "Missing Access", code: 50013 };

  const res = await banService.banUser(banOpts(cid, w, { durationMs: 60_000 }));

  assert.equal(res.ok, false);
  assert.equal(res.code, 50013);
  assert.match(res.error, /Missing Access 50013/);
  assert.match(res.error, /Ban Members/);
  assert.match(res.error, /Nothing was banned\./);
  assert.equal(db.findActiveBanRecord(cid, SUB), null, "no lifecycle row for a failed ban");
  assert.equal(db.db.prepare(`SELECT COUNT(*) AS c FROM ban_records WHERE community_id=?`).get(cid).c, 0);
  assert.ok(w.lines.warn.some((l) => l.includes("ban failed")));
});

// ═══ refusal battery: dup-active / self-ban / staff-subject ═════════════════

test("duplicate-active ban is refused quoting the live record B-n with ZERO outbound", async () => {
  const cid = freshCid();
  const pre = db.createBanRecord({
    communityId: cid,
    userId: SUB,
    moderatorId: MOD,
    source: "staff",
    reason: "first ban",
    bannedAt: NOW - 3_600_000,
    expiresAt: NOW + DAY,
  });
  assert.equal(pre.ok, true, pre.error);

  const w = makeWorld();
  const res = await banService.banUser(banOpts(cid, w));

  assert.equal(res.ok, false);
  assert.match(res.error, /\*\*B-1\*\*/, "refusal quotes the record ref");
  assert.match(res.error, /already banned — see records/);
  assert.match(res.error, /Nothing new was done\./);
  assert.ok(res.error.includes("<t:"), "active-since stamp rendered");
  assert.equal(w.calls.length, 0, "duplicate refusal performs ZERO outbound");
  assert.ok(w.lines.warn.some((l) => l.includes("ban refused (duplicate active)")));
});

test("self-ban refusal: moderator === target never bans", async () => {
  const cid = freshCid();
  const w = makeWorld();
  const res = await banService.banUser(banOpts(cid, w, { moderatorId: SUB }));
  assert.equal(res.ok, false);
  assert.match(res.error, /Refusing to ban yourself/);
  assert.match(res.error, /Nothing was banned\./);
  assert.equal(w.calls.length, 0);
});

test("staff-subject guard: a subject holding a staff_roles role is refused (#729 mirror)", async () => {
  const cid = freshCid();
  db.addStaffRole(cid, ROLE, "senior");
  assert.ok(db.getStaffRole(cid, ROLE), "the staff-role row exists for this community");
  const w = makeWorld({ guards: { roles: [ROLE] } });

  const res = await banService.banUser(banOpts(cid, w));
  assert.equal(res.ok, false);
  assert.ok(res.error.includes(`<@&${ROLE}>`), `names the staff role: ${res.error}`);
  assert.match(res.error, /staff-subject guard/);
  assert.match(res.error, /Nothing was banned\./);
  assert.ok(!ops(w.calls).includes("sendDm") && !ops(w.calls).includes("banMember"),
    "guard refusal runs BEFORE any DM/ban outbound");
});

test("ManageGuild belt: a subject holding Manage Guild IS guild staff — refused", async () => {
  const cid = freshCid();
  const w = makeWorld({ guards: { manageGuild: true } });
  const res = await banService.banUser(banOpts(cid, w));
  assert.equal(res.ok, false);
  assert.match(res.error, /\*\*Manage Guild\*\*/);
  assert.match(res.error, /Nothing was banned\./);
  assert.ok(!ops(w.calls).includes("banMember"));
});

test("hierarchy law: subject top role NOT below the bot's is refused naming both positions", async () => {
  const cid = freshCid();
  const w = makeWorld({ guards: { subjectTop: 10, botTop: 10 } });
  const res = await banService.banUser(banOpts(cid, w));
  assert.equal(res.ok, false);
  assert.match(res.error, /position 10/);
  assert.match(res.error, /not below the bot's highest role/);
  assert.match(res.error, /Nothing was banned\./);
});

test("UNRESOLVABLE hierarchy read FAILS CLOSED: refusal, no ban, no DM", async () => {
  const cid = freshCid();
  const w = makeWorld({ guards: { subjectTopThrows: new Error("roles cache exploded") } });
  const res = await banService.banUser(banOpts(cid, w));
  assert.equal(res.ok, false);
  assert.match(res.error, /Could not check the role hierarchy/);
  assert.match(res.error, /roles cache exploded/, "specific cause carried");
  assert.match(res.error, /refusing to ban <@[\d]+> rather than guess/);
  assert.equal(db.findActiveBanRecord(cid, SUB), null);
  assert.ok(!ops(w.calls).includes("sendDm") && !ops(w.calls).includes("banMember"));
});

test("no client AND no ManageGuild seam → belt logs the gap; staff_roles+hierarchy law still runs", async () => {
  const cid = freshCid();
  const w = makeWorld({ withManageGuildSeam: false });
  const res = await banService.banUser(banOpts(cid, w, { durationMs: DAY }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(
    w.lines.warn.some(
      (l) =>
        l.includes("ManageGuild staff-subject belt skipped") &&
        l.includes(`community=${cid}`) &&
        l.includes(`user=${SUB}`),
    ),
    `belt gap is logged with ids: ${w.lines.warn}`,
  );
  assert.ok(ops(w.calls).includes("banMember"));
});

// ═══ parameter law (services return values, never throw) ════════════════════

test("service-side duration bounds refuse naming **Duration:** + the grammar example, zero outbound", async () => {
  const w = makeWorld();
  const cid = freshCid();

  const floor = await banService.banUser(banOpts(cid, w, { durationMs: DURATION_MIN_MS / 2 }));
  assert.equal(floor.ok, false);
  assert.ok(floor.error.includes("**Duration:**") && floor.error.includes("shorter than the 60s minimum"), floor.error);
  assert.ok(floor.error.includes("24h or 7d") && floor.error.includes("Nothing was banned."));

  const cap = await banService.banUser(banOpts(cid, w, { durationMs: DURATION_MAX_MS + 1 }));
  assert.equal(cap.ok, false);
  assert.ok(cap.error.includes("**Duration:**") && cap.error.includes("longer than the 365d maximum"), cap.error);
  assert.ok(cap.error.includes("24h or 7d") && cap.error.includes("Nothing was banned."));

  for (const durationMs of [0, -5, Number.NaN, "abc"]) {
    const res = await banService.banUser(banOpts(cid, w, { durationMs }));
    assert.equal(res.ok, false, `durationMs ${String(durationMs)} refused`);
    assert.match(res.error, /positive number of milliseconds/);
    assert.match(res.error, /Nothing was banned\./);
  }

  const badExpiry = await banService.banUser(banOpts(cid, w, { expiresAtMs: -1 }));
  assert.equal(badExpiry.ok, false);
  assert.match(badExpiry.error, /positive ms timestamp/);

  assert.equal(w.calls.length, 0, "param refusals touch NOTHING");
});

test("missing reason / unknown source / missing userId each refuse with specific copy", async () => {
  const cid = freshCid();
  const w = makeWorld();

  const noReason = await banService.banUser(banOpts(cid, w, { reason: "   " }));
  assert.equal(noReason.ok, false);
  assert.match(noReason.error, /A ban needs a reason/);

  const badSource = await banService.banUser(banOpts(cid, w, { source: "vigilante" }));
  assert.equal(badSource.ok, false);
  assert.match(badSource.error, /Unknown ban source `vigilante`/);
  assert.match(badSource.error, /staff, automod/);

  const noUser = await banService.banUser(banOpts(cid, w, { userId: "" }));
  assert.equal(noUser.ok, false);
  assert.match(noUser.error, /needs the target user id/);

  assert.equal(w.calls.length, 0);
});

test("a non-integer community id stays a PROGRAMMER error (rejects, not a fake refusal)", async () => {
  const w = makeWorld();
  await assert.rejects(
    () => banService.banUser(banOpts("not-a-community-id", w)),
    /community id required/,
  );
});

// ═══ finalizeExpiry — CAS auto-unban ════════════════════════════════════════

/** Expired ACTIVE row (expiry already due at NOW). */
function seedExpiredActive(cid, { userId = SUB, expiresAt = NOW - 1_000 } = {}) {
  const created = db.createBanRecord({
    communityId: cid,
    userId,
    moderatorId: MOD,
    source: "staff",
    reason: "raiding",
    bannedAt: NOW - 3_600_000,
    expiresAt,
  });
  assert.equal(created.ok, true, created.error);
  return created.record;
}

function expiryDeps(w, cid, overrides = {}) {
  return {
    communityId: cid,
    outbound: w.ob,
    guildName: "Test Guild",
    settings: { ban_dm: 1, welcome_back_dm: 1 },
    log: w.log,
    now: NOW,
    moderatorName: "Mod Alice",
    ...overrides,
  };
}

test("two parallel finalizeExpiry runs: exactly ONE winner, the loser performs ZERO outbound (CAS law)", async () => {
  const cid = freshCid();
  const row = seedExpiredActive(cid);
  const w = makeWorld();
  const deps = expiryDeps(w, cid);

  const results = await Promise.all([
    banService.finalizeExpiry(row.id, deps),
    banService.finalizeExpiry(row.id, deps),
  ]);

  const winners = results.filter((r) => r.ok === true);
  const losers = results.filter((r) => r.ok === false);
  assert.equal(winners.length, 1, "single winner");
  assert.equal(losers.length, 1);

  const win = winners[0];
  assert.equal(win.acted, true);
  assert.equal(win.status, "expired_unbanned");
  assert.equal(win.banNumber, "B-1");
  assert.equal(win.externallyUnbanned, false);
  // §4 guild-side reason: staff name allowed HERE (never in DMs), <t:F> stamp.
  assert.match(
    win.unbanReason,
    /^Expired — auto-unban \(banned <t:\d+:F> by Mod Alice\)$/,
  );

  assert.match(losers[0].error, /already in flight/);
  assert.match(losers[0].error, /performed no Discord call and changed nothing/);

  const unbanCalls = w.calls.filter((c) => c.op === "unbanMember");
  assert.equal(unbanCalls.length, 1, "the CAS loser touched Discord ZERO times");
  assert.equal(unbanCalls[0].reason, win.unbanReason);
  assert.equal(w.calls.filter((c) => c.op === "sendDm").length, 1, "one welcome for one cycle");
  // Unban happened BEFORE the welcome DM.
  assert.ok(
    w.calls.findIndex((c) => c.op === "unbanMember") < w.calls.findIndex((c) => c.op === "sendDm"),
  );

  const live = db.getBanRecord(row.id);
  assert.equal(live.status, "expired_unbanned");
  assert.equal(live.welcome_dm_sent, 1, "the claim IS the welcome stamp");
  assert.equal(live.unban_reason, win.unbanReason);

  const audits = auditRows(cid, "banLifecycle.expiry_unban").filter((r) => r.origin === "system");
  assert.equal(audits.length, 1, "one system audit row per settled expiry");
});

test("finalizeExpiry on an already-settled record: ok:false 'already settled', no outbound, welcome stays ONE", async () => {
  const cid = freshCid();
  const row = seedExpiredActive(cid);
  const w = makeWorld();
  const deps = expiryDeps(w, cid);

  const first = await banService.finalizeExpiry(row.id, deps);
  assert.equal(first.ok, true);

  const again = await banService.finalizeExpiry(row.id, deps);
  assert.equal(again.ok, false);
  assert.match(again.error, /already settled as `expired_unbanned`/);
  assert.match(again.error, /the record is the truth; this pass changed nothing/);
  assert.equal(w.calls.filter((c) => c.op === "unbanMember").length, 1);
  assert.equal(w.calls.filter((c) => c.op === "sendDm").length, 1, "welcome claim is one-shot per cycle");
});

test("NOT_BANNED (10026) settles the row `unbanned_manual` with ok:true — not an error (#772 §4 truth law)", async () => {
  const cid = freshCid();
  const row = seedExpiredActive(cid);
  const w = makeWorld();
  w.ob.unbanResult = { ok: false, code: banService.CODE_NOT_BANNED, error: "Bot or User was not banned" };

  const res = await banService.finalizeExpiry(row.id, expiryDeps(w, cid));

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.status, "unbanned_manual");
  assert.equal(res.externallyUnbanned, true, "honestly reported as an out-of-band lift");
  const live = db.getBanRecord(row.id);
  assert.equal(live.status, "unbanned_manual");
  assert.match(live.unban_reason, /already lifted outside the bot/);
  // The welcome path still runs — the ban ended, the member may return.
  assert.equal(w.calls.filter((c) => c.op === "sendDm").length, 1);
  assert.equal(auditRows(cid, "banLifecycle.external_unban").filter((r) => r.origin === "system").length, 1);
});

test("expiry with a failing welcome DM parks the row `pending_rejoin` (claim spent — rejoin is the retry path)", async () => {
  const cid = freshCid();
  const row = seedExpiredActive(cid);
  const w = makeWorld();
  w.ob.dmResult = { ok: false, error: "Cannot receive messages" };

  const res = await banService.finalizeExpiry(row.id, expiryDeps(w, cid));
  assert.equal(res.ok, true, "the unban itself succeeded — parking is partial-fact reporting");
  assert.equal(res.welcome.attempted, true);
  assert.equal(res.welcome.delivered, false);
  assert.equal(res.welcome.parked, "pending_rejoin");

  const live = db.getBanRecord(row.id);
  assert.equal(live.status, "pending_rejoin");
  assert.equal(live.welcome_dm_sent, 1, "the claim was spent even undelivered");
  assert.ok(w.lines.warn.some((l) => l.includes("welcome DM failed") && l.includes("Cannot receive messages")));
});

test("outbound without unbanMember: the row stays CLAIMED for a lease retry with specific copy", async () => {
  const cid = freshCid();
  const row = seedExpiredActive(cid);
  const w = makeWorld();
  delete w.ob.unbanMember;

  const res = await banService.finalizeExpiry(row.id, expiryDeps(w, cid));
  assert.equal(res.ok, false);
  assert.match(res.error, /the outbound has no unbanMember surface/);
  assert.match(res.error, /stays claimed for a lease retry/);
  const live = db.getBanRecord(row.id);
  assert.equal(live.status, "active", "never half-settled: still active, claim stamped");
  assert.ok(live.unban_claimed_at, "the claim stamp exists for the lease math");
});

// ═══ handleExternalUnban — GuildBanRemove truth ═════════════════════════════

test("external unban settles the active row manual + one welcome; a duplicate event is refused untracked", async () => {
  const cid = freshCid();
  seedExpiredActive(cid, { expiresAt: null });
  const w = makeWorld();
  const opts = {
    communityId: cid,
    userId: SUB,
    outbound: w.ob,
    guildName: "Test Guild",
    settings: { welcome_back_dm: 1 },
    log: w.log,
    now: NOW,
    unbanReason: "appeal upheld by the modteam",
  };

  const res = await banService.handleExternalUnban(opts);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.status, "unbanned_manual");
  assert.equal(res.banNumber, "B-1");
  const live = db.findActiveBanRecord(cid, SUB);
  assert.equal(live, null, "no ACTIVE row remains");
  assert.equal(auditRows(cid, "banLifecycle.external_unban").length, 1);
  assert.equal(w.calls.filter((c) => c.op === "sendDm").length, 1);

  const dup = await banService.handleExternalUnban(opts);
  assert.equal(dup.ok, false);
  assert.match(dup.error, /No active ban record/);
  assert.match(dup.error, /untracked ban/);
  assert.equal(w.calls.filter((c) => c.op === "sendDm").length, 1, "welcome once per ban cycle");
});

// ═══ handleRejoin — one attempt, welcomed regardless, 30-day window ═════════

/**
 * Park a cycle for rejoin at a CONTROLLED unban instant (the repo CAS
 * primitives stamp unban_claimed_at with their own clock, so the window
 * edges are pinned by direct SQL on the fixture — the same columns the
 * service's rejoin lookup reads).
 */
function seedPendingRejoin(cid, userId, unbanAt) {
  const created = db.createBanRecord({
    communityId: cid,
    userId,
    moderatorId: MOD,
    source: "staff",
    reason: "raiding",
    bannedAt: unbanAt - 3_600_000,
    expiresAt: null,
  });
  assert.equal(created.ok, true, created.error);
  db.db
    .prepare(
      `UPDATE ban_records
          SET status='pending_rejoin', welcome_dm_sent=1, unban_claimed_at=?
        WHERE id=?`
    )
    .run(unbanAt, created.record.id);
  return db.getBanRecord(created.record.id);
}

function rejoinOpts(cid, w, userId, overrides = {}) {
  return {
    communityId: cid,
    userId,
    outbound: w.ob,
    guildName: "Test Guild",
    settings: { welcome_back_dm: 1 },
    log: w.log,
    now: NOW,
    db,
    ...overrides,
  };
}

test("rejoin inside the window (29d): ONE welcome attempt, delivered, row → welcomed", async () => {
  const cid = freshCid();
  const row = seedPendingRejoin(cid, SUB, NOW - 29 * DAY);
  const w = makeWorld();

  const res = await banService.handleRejoin(rejoinOpts(cid, w, SUB));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.acted, true);
  assert.equal(res.delivered, true);
  assert.equal(w.calls.filter((c) => c.op === "sendDm").length, 1, "exactly one attempt");

  const live = db.getBanRecord(row.id);
  assert.equal(live.status, "welcomed", "terminal regardless — and it was delivered here");
  assert.equal(live.welcome_dm_sent, 1);
  assert.match(w.calls.find((c) => c.op === "sendDm").payload.content, /unbanned from \*\*Test Guild\*\*/);
  assert.equal(auditRows(cid, "banLifecycle.rejoin_welcome").filter((r) => r.origin === "system").length, 1);

  // A double GuildMemberAdd cannot re-open the welcome (status CAS).
  const again = await banService.handleRejoin(rejoinOpts(cid, w, SUB));
  assert.equal(again.acted, false);
  assert.match(again.reason, /no pending welcome-back record/);
  assert.equal(w.calls.filter((c) => c.op === "sendDm").length, 1);
});

test("rejoin welcome with a FAILING DM: the attempt is made and the row STILL welcomes (one-attempt law)", async () => {
  const cid = freshCid();
  const row = seedPendingRejoin(cid, SUB, NOW - 5 * DAY);
  const w = makeWorld();
  w.ob.dmResult = { ok: false, error: "Cannot send messages to this user" };

  const res = await banService.handleRejoin(rejoinOpts(cid, w, SUB));
  assert.equal(res.ok, true);
  assert.equal(res.acted, true);
  assert.equal(res.delivered, false);
  assert.match(res.note, /welcome attempt made, delivery failed/);
  assert.match(res.note, /record stays welcomed \(one-attempt law\)/);

  assert.equal(db.getBanRecord(row.id).status, "welcomed", "welcomed REGARDLESS of DM outcome");
  assert.ok(w.lines.warn.some((l) => l.includes("rejoin welcome DM failed")));
});

test("rejoin OUTSIDE the 30-day window (31d): log-only skip, the parked row stays truth", async () => {
  const cid = freshCid();
  const row = seedPendingRejoin(cid, SUB, NOW - 31 * DAY);
  const w = makeWorld();

  const res = await banService.handleRejoin(rejoinOpts(cid, w, SUB));
  assert.equal(res.ok, true);
  assert.equal(res.acted, false);
  assert.ok(res.reason.includes(`${REJOIN_WELCOME_WINDOW_DAYS}-day rejoin welcome window`), res.reason);
  assert.equal(db.getBanRecord(row.id).status, "pending_rejoin", "never resurrected outside the window");
  assert.equal(w.calls.length, 0, "window refusal touches no outbound at all");
  assert.ok(w.lines.info.some((l) => l.includes("rejoin welcome skipped (outside the 30-day window)")));
});

test("rejoin with welcome_back_dm OFF stays parked in TOTAL silence (toggle law before any row touch)", async () => {
  const cid = freshCid();
  const row = seedPendingRejoin(cid, SUB, NOW - 1 * DAY);
  const w = makeWorld();

  const res = await banService.handleRejoin(rejoinOpts(cid, w, SUB, { settings: { welcome_back_dm: 0 } }));
  assert.equal(res.ok, true);
  assert.equal(res.acted, false);
  assert.match(res.reason, /welcome_back_dm is off — the pending welcome stays parked/);
  assert.equal(db.getBanRecord(row.id).status, "pending_rejoin");
  assert.equal(w.calls.length, 0);
});

test("rejoin with no parked cycle is an honest no-op", async () => {
  const cid = freshCid();
  const w = makeWorld();
  const res = await banService.handleRejoin(rejoinOpts(cid, w, "878100000000000099"));
  assert.equal(res.ok, true);
  assert.equal(res.acted, false);
  assert.match(res.reason, /no pending welcome-back record/);
  assert.equal(w.calls.length, 0);
});

// ── #809: the identity fingerprint's equality law ────────────────────────────

test("#809 identityReasonMatches — normalized equality, nothing cleverer", () => {
  const { identityReasonMatches } = banService.internals;

  assert.equal(identityReasonMatches("spam", "spam"), true, "exact");
  assert.equal(
    identityReasonMatches("Posted  Slurs AT members", "posted slurs at members"),
    true,
    "case-fold + internal-whitespace collapse: cosmetic drift is NOT a re-ban"
  );
  assert.equal(identityReasonMatches("  padded \n", "padded"), true, "trim on both sides");

  assert.equal(identityReasonMatches("spam", "appeal denied"), false, "a different story IS a re-ban");
  assert.equal(identityReasonMatches("spam spam", "spam"), false, "collapse never erases WORDS");
  assert.equal(
    identityReasonMatches("spam", null),
    false,
    "a live ban whose reason vanished is not our fingerprint — the guard holds and staff look"
  );
  assert.equal(identityReasonMatches("spam", undefined), false, "same via undefined");
});
