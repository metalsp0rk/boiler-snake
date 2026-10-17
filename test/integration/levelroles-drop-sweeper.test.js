const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const { IDS } = require("../helpers/fixtures");

/**
 * #428 (audit XE-1): the level-role grace drop was only ever evaluated on
 * XP-CHANGE paths (awardXp, decay writes). A user whose XP FREEZES — decayed
 * to 0, or decay-exempt with msg_xp=0 — never re-entered syncMemberRoles, so
 * the below-since timer armed at the last sync would never fire and the
 * member kept the level role FOREVER. These tests pin the time-driven
 * sweeper: XP changes NEVER, the timer alone decides.
 */
function fakeSupervisor(client) {
  const { getDiscordOutbound } = require("../../src/platform/discord/outbound");
  return {
    discord: client,
    fluxer: new Map(),
    clientForCommunity: () => getDiscordOutbound(client),
  };
}

const DAY = 24 * 60 * 60 * 1000;

describe("integration: level-role drop sweeper (#428)", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let runDropSweepForCommunity;
  let communityIdsToSweep;

  before(async () => {
    env = await createIntegrationEnv();
    const sweeper = require("../../src/features/levelRoles/dropSweeper");
    runDropSweepForCommunity = sweeper.runDropSweepForCommunity;
    communityIdsToSweep = sweeper.communityIdsToSweep;
  });

  after(() => {
    env?.cleanup();
  });

  /** Seed a level-5 mapping (grace = graceDays) on a dedicated role id. */
  function seedRole(roleId, graceDays = 1) {
    env.db.upsertLevelRole(env.communityId, roleId, 5, graceDays);
  }

  it("drops the role after grace elapses with XP frozen at 0 (core XE-1)", async () => {
    const role = "role-level5-a";
    seedRole(role, 1);
    env.db.setXp(env.communityId, IDS.member, 0); // frozen: no award, no decay write
    const m = env.members.member;
    await m.roles.add(role);
    env.db.setRoleBelowSince(
      env.communityId,
      IDS.member,
      role,
      Date.now() - 2 * DAY,
    );

    const res = await runDropSweepForCommunity(
      fakeSupervisor(env.client),
      env.communityId,
    );

    assert.equal(res.removed, 1, "sweeper removed exactly the overdue role");
    assert.equal(m.roles.cache.has(role), false, "role is gone from the member");
    assert.equal(
      env.db.getRoleDropState(env.communityId, IDS.member, role).below_since,
      null,
      "sync cleared the fired timer",
    );
    // XP was never touched — the drop is purely time-driven.
    assert.equal(env.db.getUser(env.communityId, IDS.member).xp, 0);
  });

  it("keeps the role while grace is still running", async () => {
    const role = "role-level5-b";
    seedRole(role, 3);
    env.db.setXp(env.communityId, IDS.member, 0);
    const m = env.members.member;
    await m.roles.add(role);
    env.db.setRoleBelowSince(
      env.communityId,
      IDS.member,
      role,
      Date.now() - 60 * 60 * 1000, // 1h into a 3-day grace
    );

    const res = await runDropSweepForCommunity(
      fakeSupervisor(env.client),
      env.communityId,
    );

    assert.equal(res.removed, 0);
    assert.equal(m.roles.cache.has(role), true, "grace period respected");
    assert.ok(
      env.db.getRoleDropState(env.communityId, IDS.member, role).below_since,
      "timer stays armed for the next sweep",
    );
  });

  it("clears the timer (role kept) when the user recovered above threshold", async () => {
    const role = "role-level5-c";
    seedRole(role, 1);
    // Level 5 at default factor 100 needs xp >= 2500.
    env.db.setXp(env.communityId, IDS.member, 3000);
    const m = env.members.member;
    await m.roles.add(role);
    env.db.setRoleBelowSince(
      env.communityId,
      IDS.member,
      role,
      Date.now() - 2 * DAY,
    );

    const res = await runDropSweepForCommunity(
      fakeSupervisor(env.client),
      env.communityId,
    );

    assert.equal(res.removed, 0);
    assert.equal(m.roles.cache.has(role), true, "earned role is kept");
    assert.equal(
      env.db.getRoleDropState(env.communityId, IDS.member, role).below_since,
      null,
      "stale timer cleared by the sync",
    );
  });

  it("un-fetchable member keeps its timer; other users still get swept", async () => {
    const role = "role-level5-d";
    seedRole(role, 1);
    const GHOST = "ghost-428-not-in-guild";
    const armed = Date.now() - 2 * DAY;
    env.db.setXp(env.communityId, GHOST, 0);
    env.db.setRoleBelowSince(env.communityId, GHOST, role, armed);

    // Second user in the SAME sweep who IS fetchable and overdue.
    env.db.setXp(env.communityId, IDS.member2, 0);
    const m2 = env.members.member2;
    await m2.roles.add(role);
    env.db.setRoleBelowSince(env.communityId, IDS.member2, role, armed);

    const res = await runDropSweepForCommunity(
      fakeSupervisor(env.client),
      env.communityId,
    );

    // Partial failure: ghost skipped with its timer kept, member2 swept.
    assert.equal(res.removed, 1);
    assert.equal(
      env.db.getRoleDropState(env.communityId, GHOST, role).below_since,
      armed,
      "ghost timer untouched — it retries on the next daily sweep",
    );
    assert.equal(
      env.db.getRoleDropState(env.communityId, IDS.member2, role).below_since,
      null,
    );
    assert.equal(m2.roles.cache.has(role), false);
  });

  it("communityIdsToSweep lists communities with armed timers only", () => {
    // Ghost timer from the previous test is still armed → listed.
    assert.ok(communityIdsToSweep().includes(env.communityId));
  });

  it("no-ops cleanly when nothing is pending", () => {
    // Detonate every armed timer on this community, then sweep empty.
    for (const p of env.db.listPendingRoleDrops(env.communityId)) {
      env.db.setRoleBelowSince(env.communityId, p.user_id, p.role_id, null);
    }
    assert.deepEqual(communityIdsToSweep(), []);
    return runDropSweepForCommunity(
      fakeSupervisor(env.client),
      env.communityId,
    ).then((res) => {
      assert.deepEqual(res, { swept: 0, removed: 0 });
    });
  });
});
