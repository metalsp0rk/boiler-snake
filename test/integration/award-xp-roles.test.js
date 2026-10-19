const { describe, it, before, after } = require("node:test");
const { seedXp } = require("../helpers/xpSeed");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const { assertXp, assertRoleGranted } = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");
const { getDiscordOutbound } = require("../../src/platform/discord/outbound");

describe("integration: awardXp + level roles", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let awardXp;
  let syncMemberRoles;

  after(() => {
    // Close SQLite handles and remove the temp dir created for this env.
    env?.cleanup();
  });

  before(async () => {
    env = await createIntegrationEnv();
    awardXp = require("../../src/services/awardXp").awardXp;
    syncMemberRoles = require("../../src/features/levelRoles/sync").syncMemberRoles;
    // Level L starts at L² * factor; factor 100 → level 1 at 100, level 2 at 400
    env.db.updateGuildSettings(env.communityId, { level_xp_factor: 100 });
    env.db.upsertLevelRole(env.communityId, IDS.roleLevel5, 1, 0);
  });

  it("awardXp writes XP and activity", async () => {
    const uid = "user-award-1";
    const user = env.createUser({ id: uid, username: "awardee" });
    const mem = env.createMember({ guild: env.guild, user });
    env.guild.addMember(mem);

    const result = await awardXp(getDiscordOutbound(env.client), {
      communityId: env.communityId,
      externalGuildId: env.guildId,
      userId: uid,
      delta: 50,
      activityKind: "message",
      member: mem,
      levelXpFactor: 100,
    });
    assert.equal(result.newXp, 50);
    assertXp(env.db, env.communityId, uid, 50);
  });

  it("grants level role when threshold met", async () => {
    const uid = "user-award-2";
    const user = env.createUser({ id: uid, username: "leveler" });
    const mem = env.createMember({ guild: env.guild, user });
    env.guild.addMember(mem);

    const result = await awardXp(getDiscordOutbound(env.client), {
      communityId: env.communityId,
      externalGuildId: env.guildId,
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
    env.db.upsertLevelRole(env.communityId, dropRole, 5, 0); // need level 5, grace 0 days
    mem.roles.cache.set(dropRole, { id: dropRole });
    seedXp(env.db, env.communityId, uid, 50); // low XP → low level

    // First pass: start below_since timer (grace 0 still waits one cycle)
    await syncMemberRoles(getDiscordOutbound(env.client), env.communityId, mem, 0);
    const st = env.db.getRoleDropState(env.communityId, uid, dropRole);
    assert.ok(st?.below_since, "expected drop timer started");

    // Ensure grace elapsed even if same-ms (now - below_since > 0)
    env.db.setRoleBelowSince(env.communityId, uid, dropRole, Date.now() - 1);
    const changes2 = await syncMemberRoles(getDiscordOutbound(env.client), env.communityId, mem, 0);
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
      const result = await awardXp(getDiscordOutbound(env.client), {
        communityId: env.communityId,
        externalGuildId: env.guildId,
        userId: uid,
        delta: 11,
        activityKind: "message",
        member: null,
        levelXpFactor: 100,
      });
      assert.equal(result.newXp, 11);
      assert.equal(result.level, null);
      assertXp(env.db, env.communityId, uid, 11);
    } finally {
      guild.members.fetch = orig;
    }
  });

  // ── #430 (audit XE-3): failed role ops are REPORTED, not just logged ─────

  it("syncMemberRoles returns failed ops (bot below the managed role)", async () => {
    const uid = "user-sync-fail-430";
    const user = env.createUser({ id: uid, username: "stubborn" });
    const mem = env.createMember({ guild: env.guild, user });
    env.guild.addMember(mem);
    // AGENTS item 5 in one line: the bot's role hierarchy rejects the op.
    mem.roles.add = async () => {
      const e = new Error("Missing Permissions");
      e.code = 50013;
      throw e;
    };

    const changes = await syncMemberRoles(
      getDiscordOutbound(env.client),
      env.communityId,
      mem,
      5, // meets the before()-seeded level-1 mapping → an add MUST fire (and fail)
    );
    assert.deepEqual(changes.granted, [], "nothing was granted");
    const f = (changes.failed || []).find((x) => x.roleId === IDS.roleLevel5);
    assert.ok(
      f,
      `roleLevel5 failure reported (RED: old shape had no failed[]) — got ${JSON.stringify(changes)}`,
    );
    assert.equal(f.action, "add");
    assert.match(f.error, /Missing Permissions/);
  });

  it("logLevelRoleChanges posts an all-failures embed (no silent early return)", async () => {
    const { logLevelRoleChanges } = require("../../src/features/logs/auditLog");
    const sends = [];
    const outbound = {
      // #445 resolver shape: fetchChannel must resolve before delivery.
      fetchChannel: async (_communityId, channelId) => ({ id: channelId }),
      sendChannel: async (channelId, payload) => {
        sends.push([channelId, payload]);
        return { ok: true };
      },
    };
    env.db.updateGuildSettings(env.communityId, {
      audit_log_channel_id: "audit-chan-430",
    });

    await logLevelRoleChanges(
      outbound,
      env.communityId,
      { id: "u-430", username: "watcher" },
      {
        granted: [],
        removed: [],
        failed: [{ roleId: IDS.roleLevel5, action: "add", error: "Missing Permissions" }],
      },
      3,
      "admin_grant",
    );

    // RED on old code: empty granted+removed early-returned — the audit
    // channel NEVER saw the total role-sync failure.
    assert.equal(sends.length, 1, "an all-failures sync still posts");
    const embed = sends[0][1].embeds[0];
    const data = typeof embed.toJSON === "function" ? embed.toJSON() : embed;
    assert.equal(data.title, "Level role sync FAILED");
    const failedField = data.fields.find((f) => f.name === "Failed");
    assert.ok(failedField, "Failed field names the victims");
    assert.match(failedField.value, /add .*Missing Permissions/);

    env.db.updateGuildSettings(env.communityId, { audit_log_channel_id: null });
  });
});
