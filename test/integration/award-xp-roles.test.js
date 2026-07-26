const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const { assertXp, assertRoleGranted } = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

describe("integration: awardXp + level roles", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let awardXp;
  let syncMemberRoles;

  before(async () => {
    env = await createIntegrationEnv();
    awardXp = require("../../src/services/awardXp").awardXp;
    syncMemberRoles = require("../../src/features/levelRoles/sync").syncMemberRoles;
    // Level L starts at L² * factor; factor 100 → level 1 at 100, level 2 at 400
    env.db.updateGuildSettings(env.guild.id, { level_xp_factor: 100 });
    env.db.upsertLevelRole(env.guild.id, IDS.roleLevel5, 1, 0);
  });

  it("awardXp writes XP and activity", async () => {
    const uid = "user-award-1";
    const user = env.createUser({ id: uid, username: "awardee" });
    const mem = env.createMember({ guild: env.guild, user });
    env.guild.addMember(mem);

    const result = await awardXp(env.client, {
      guild: env.guild,
      userId: uid,
      delta: 50,
      activityKind: "message",
      member: mem,
      levelXpFactor: 100,
    });
    assert.equal(result.newXp, 50);
    assertXp(env.db, env.guild.id, uid, 50);
  });

  it("grants level role when threshold met", async () => {
    const uid = "user-award-2";
    const user = env.createUser({ id: uid, username: "leveler" });
    const mem = env.createMember({ guild: env.guild, user });
    env.guild.addMember(mem);

    const result = await awardXp(env.client, {
      guild: env.guild,
      userId: uid,
      delta: 100,
      activityKind: "message",
      member: mem,
      levelXpFactor: 100,
    });
    assert.equal(result.level, 1);
    assertRoleGranted(mem, IDS.roleLevel5);
    assert.ok(result.changes?.granted.includes(IDS.roleLevel5));
  });

  it("starts drop grace when below threshold then removes after grace", async () => {
    const uid = "user-award-3";
    const user = env.createUser({ id: uid, username: "dropper" });
    const mem = env.createMember({
      guild: env.guild,
      user,
      roleIds: [IDS.roleLevel5],
    });
    env.guild.addMember(mem);
    // Unique role so other tests' level-1 mapping does not re-grant
    const dropRole = "role-drop-grace";
    env.db.upsertLevelRole(env.guild.id, dropRole, 5, 0); // need level 5, grace 0 days
    mem.roles.cache.set(dropRole, { id: dropRole });
    env.db.setXp(env.guild.id, uid, 50); // low XP → low level

    // First pass: start below_since timer (grace 0 still waits one cycle)
    await syncMemberRoles(mem, 0);
    const st = env.db.getRoleDropState(env.guild.id, uid, dropRole);
    assert.ok(st?.below_since, "expected drop timer started");

    // Ensure grace elapsed even if same-ms (now - below_since > 0)
    env.db.setRoleBelowSince(env.guild.id, uid, dropRole, Date.now() - 1);
    const changes2 = await syncMemberRoles(mem, 0);
    assert.ok(
      changes2.removed.includes(dropRole) || !mem.roles.cache.has(dropRole),
      "expected role removed after grace"
    );
  });

  it("still stores XP when member fetch fails", async () => {
    const uid = "user-award-orphan";
    const guild = env.guild;
    const orig = guild.members.fetch;
    guild.members.fetch = async () => {
      throw new Error("missing");
    };
    try {
      const result = await awardXp(env.client, {
        guild,
        userId: uid,
        delta: 11,
        activityKind: "message",
        member: null,
        levelXpFactor: 100,
      });
      assert.equal(result.newXp, 11);
      assert.equal(result.level, null);
      assertXp(env.db, env.guild.id, uid, 11);
    } finally {
      guild.members.fetch = orig;
    }
  });
});
