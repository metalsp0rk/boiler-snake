/**
 * #727 (epic #723): case-context LOOKUP tools — read_warnings /
 * read_staff_notes as the #728 harness wires them.
 *
 * Pinned contract surface:
 *  - GUILD ISOLATION: no guild member row → refused with the specific cause
 *    (`member.fetch` → null is the test posture); a member-read FAILURE
 *    (throw) surfaces its own cause instead of lying about membership.
 *  - JUDGMENT-COMPLETE sets: warnings = non-voided (active AND expired,
 *    matching the default staff `/warn list` view; voided = withdrawn,
 *    disclosed only as `total_including_voided`); notes = live only
 *    (erased tombstones excluded, `total_including_deleted` discloses).
 *  - NO MODE GATE: master switch off, warn mode off, breaker paused —
 *    irrelevant to a read (the executor #729 gates writes). Test-pinned by
 *    running every gate state and still getting ok:true.
 *  - Rows are plain JSON-able, ids as strings — the SAME projector the
 *    bundle's `records` block emits.
 *  - Zero writes (row-count pin) + `[automod]` logging with ids on failure.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

after(() => cleanup());

const lookups = require("../src/features/automod/lookups");
const settingsService = require("../src/features/automod/settings");

const GUILD = "930000000000000002";
const ACTOR = "u-actor-727";
const SUBJECT = "u-subject-727";
const OUTSIDER = "u-outsider-727";

let seq = 0;
const freshCommunity = () => communityKey(`${GUILD}-727-${++seq}`);

/** deps fake: users listed in members resolve; everyone else is 10013. */
function makeDeps({ members = [SUBJECT, ACTOR], throwOnMember = null } = {}) {
  return {
    async getMember(_guildId, userId) {
      if (throwOnMember) throw throwOnMember;
      return members.map(String).includes(String(userId)) ? { id: String(userId) } : null;
    },
  };
}

const rowCount = (table) =>
  Number(db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

async function withCapturedLogs(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    const res = await fn();
    return { res, lines };
  } finally {
    console.error = orig;
  }
}

function seedWarning(communityId, userId, { reason = "spam", past = false } = {}) {
  return db.createWarning({
    communityId,
    externalGuildId: GUILD,
    userId,
    issuerId: ACTOR,
    reason,
    expiresAt: past ? Date.now() - 86400000 : Date.now() + 86400000,
  });
}

describe("read_warnings (lookup tool)", () => {
  it("returns the judgment-complete set: active + expired, voided excluded (count disclosed)", async () => {
    const communityId = freshCommunity();
    seedWarning(communityId, SUBJECT, { reason: "spam" });
    seedWarning(communityId, SUBJECT, { reason: "old spam", past: true }); // expired but NOT voided
    const third = seedWarning(communityId, SUBJECT, { reason: "withdrawn" });
    db.voidWarning(communityId, third.warning_number, {
      voidedBy: ACTOR,
      voidReason: "appeal upheld",
    });

    const res = await lookups.readWarningsForLookup({
      communityId,
      guildId: GUILD,
      userId: SUBJECT,
      actorUserId: ACTOR,
      deps: makeDeps(),
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.count, 2);
    assert.equal(res.warnings.length, 2);
    assert.ok(res.warnings.every((w) => w.voided_at === null));
    assert.ok(res.warnings.some((w) => w.reason === "old spam")); // expired NOT excluded
    assert.equal(res.total_including_voided, 3);
    assert.equal(res.truncated, false);
    assert.equal(res.mode_gated, false);
    assert.equal(res.user_id, SUBJECT);
    assert.equal(res.actor_user_id, ACTOR);
    // projector shape: string ids, W-n refs, JSON round-trip identity
    assert.ok(res.warnings.every((w) => w.user_id === SUBJECT && typeof w.user_id === "string"));
    assert.ok(res.warnings.every((w) => w.warning_ref === `W-${w.warning_number}`));
    assert.deepEqual(JSON.parse(JSON.stringify(res)), res);
    assert.equal(rowCount("warnings"), 3); // seeded only — the lookup wrote nothing
    assert.equal(rowCount("staff_notes"), 0);
  });

  it("refuses users outside the guild (member row missing → nothing read)", async () => {
    const communityId = freshCommunity();
    seedWarning(communityId, OUTSIDER, { reason: "cross-server memory" });
    const { res, lines } = await withCapturedLogs(() =>
      lookups.readWarningsForLookup({
        communityId,
        guildId: GUILD,
        userId: OUTSIDER,
        deps: makeDeps({ members: [SUBJECT] }), // OUTSIDER has no member row
      }),
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /\*\*Outside this server:\*\*/);
    assert.match(res.error, /is not a member of this server/);
    assert.ok(lines.some((l) => l.includes("[automod]") && l.includes(OUTSIDER)));
  });

  it("a member-read FAILURE surfaces its own cause (never a membership lie)", async () => {
    const communityId = freshCommunity();
    const { res, lines } = await withCapturedLogs(() =>
      lookups.readWarningsForLookup({
        communityId,
        guildId: GUILD,
        userId: SUBJECT,
        deps: makeDeps({ throwOnMember: new Error("500 internal server error") }),
      }),
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /Could not verify whether/);
    assert.match(res.error, /500 internal server error/);
    assert.ok(lines.some((l) => l.includes("[automod]") && l.includes(SUBJECT)));
  });

  it("no mode gate: master off + warn mode off + breaker paused — the read still works", async () => {
    const communityId = freshCommunity();
    settingsService.setEnabled(communityId, false);
    settingsService.setMode(communityId, "warn", "off");
    db.setAutomodPause(communityId, { reason: "breaker tripped (test)" });
    seedWarning(communityId, SUBJECT);
    const res = await lookups.readWarningsForLookup({
      communityId,
      guildId: GUILD,
      userId: SUBJECT,
      deps: makeDeps(),
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.count, 1);
    db.clearAutomodPause(communityId);
  });

  it("communityId defaults to the guild's community row (guild-only call shape)", async () => {
    const guildCommunity = communityKey(GUILD); // registers GUILD once
    seedWarning(guildCommunity, SUBJECT, { reason: "via guild id" });
    const res = await lookups.readWarningsForLookup({
      guildId: GUILD,
      userId: SUBJECT,
      deps: makeDeps(),
    });
    assert.equal(res.ok, true, res.error);
    assert.ok(res.warnings.some((w) => w.reason === "via guild id"));
  });

  it("input refusals: no user id, no guild, unregistered guild", async () => {
    const communityId = freshCommunity();
    const deps = makeDeps();
    const noUser = await withCapturedLogs(() =>
      lookups.readWarningsForLookup({ communityId, guildId: GUILD, deps }),
    );
    assert.equal(noUser.res.ok, false);
    assert.match(noUser.res.error, /user id is required/);

    const noGuild = await withCapturedLogs(() =>
      lookups.readWarningsForLookup({ communityId, userId: SUBJECT, deps }),
    );
    assert.equal(noGuild.res.ok, false);
    assert.match(noGuild.res.error, /guildId/);

    const noCommunity = await withCapturedLogs(() =>
      lookups.readWarningsForLookup({
        guildId: "930999999999999998", // never registered
        userId: SUBJECT,
        deps,
      }),
    );
    assert.equal(noCommunity.res.ok, false);
    assert.match(noCommunity.res.error, /no community row/);

    const badCommunity = await withCapturedLogs(() =>
      lookups.readWarningsForLookup({
        communityId: "not-an-int",
        guildId: GUILD,
        userId: SUBJECT,
        deps,
      }),
    );
    assert.equal(badCommunity.res.ok, false);
    assert.match(badCommunity.res.error, /Invalid communityId/);
  });
});

describe("read_staff_notes (lookup tool)", () => {
  it("returns every live note, erases excluded (count disclosed)", async () => {
    const communityId = freshCommunity();
    db.createStaffNote({
      communityId,
      userId: SUBJECT,
      authorId: ACTOR,
      content: "watching the edge",
    });
    const doomed = db.createStaffNote({
      communityId,
      userId: SUBJECT,
      authorId: ACTOR,
      content: "SECRET BODY TO BE ERASED",
    });
    db.softDeleteStaffNote(communityId, doomed.note_number, ACTOR);

    const res = await lookups.readStaffNotesForLookup({
      communityId,
      guildId: GUILD,
      userId: SUBJECT,
      actorUserId: ACTOR,
      deps: makeDeps(),
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.count, 1);
    assert.equal(res.notes[0].content, "watching the edge");
    assert.equal(res.notes[0].note_ref, `N-${res.notes[0].note_number}`);
    assert.equal(res.total_including_deleted, 2);
    assert.equal(res.mode_gated, false);
    assert.ok(!JSON.stringify(res).includes("SECRET BODY"));
    assert.deepEqual(JSON.parse(JSON.stringify(res)), res);
    assert.equal(rowCount("staff_notes"), 2); // seeded only — the lookup wrote nothing
  });

  it("refuses users outside the guild + no-mode-gate holds here too", async () => {
    const communityId = freshCommunity();
    db.createStaffNote({
      communityId,
      userId: OUTSIDER,
      authorId: ACTOR,
      content: "cross-server memory",
    });
    const refused = await withCapturedLogs(() =>
      lookups.readStaffNotesForLookup({
        communityId,
        guildId: GUILD,
        userId: OUTSIDER,
        deps: makeDeps({ members: [] }),
      }),
    );
    assert.equal(refused.res.ok, false);
    assert.match(refused.res.error, /\*\*Outside this server:\*\*/);

    settingsService.setEnabled(communityId, false);
    db.setAutomodPause(communityId, { reason: "breaker tripped (test)" });
    db.createStaffNote({
      communityId,
      userId: SUBJECT,
      authorId: ACTOR,
      content: "still readable while off",
    });
    const stillOn = await lookups.readStaffNotesForLookup({
      communityId,
      guildId: GUILD,
      userId: SUBJECT,
      deps: makeDeps(),
    });
    assert.equal(stillOn.ok, true, stillOn.error);
    assert.equal(stillOn.count, 1);
    db.clearAutomodPause(communityId);
  });
});

describe("lookup surface (for #728 wiring)", () => {
  it("tool names + module surface", () => {
    assert.deepEqual(
      { ...lookups.LOOKUP_TOOL_NAMES },
      { warnings: "read_warnings", notes: "read_staff_notes" },
    );
    assert.equal(typeof lookups.readWarningsForLookup, "function");
    assert.equal(typeof lookups.readStaffNotesForLookup, "function");
    // The mutators are not part of this module's world at all.
    assert.ok(!("createWarning" in lookups));
    assert.ok(!("createStaffNote" in lookups));
  });

  it("no deps seam and no client → specific fail-closed error, never a throw", async () => {
    const communityId = freshCommunity();
    const { res } = await withCapturedLogs(() =>
      lookups.readWarningsForLookup({ communityId, guildId: GUILD, userId: SUBJECT }),
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /Discord client/);
  });
});
