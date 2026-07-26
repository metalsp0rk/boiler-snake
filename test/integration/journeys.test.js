const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertReplyContains,
  assertEphemeralReply,
  assertXp,
  assertBanned,
  assertRoleGranted,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

describe("integration: cross-feature journeys", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let runDecayForGuild;

  before(async () => {
    env = await createIntegrationEnv();
    runDecayForGuild = require("../../src/features/decay").runDecayForGuild;
  });

  it("journey 1: setxp → message XP → level role → /xp + leaderboard", async () => {
    await env.runCommand({
      commandName: "setxp",
      admin: true,
      options: { message: 100, msgcooldown: 0 },
    });
    env.db.updateGuildSettings(env.guild.id, { level_xp_factor: 100 });
    env.db.upsertLevelRole(env.guild.id, IDS.roleLevel5, 1, 7);

    // clear role first
    env.members.member.roles.cache.delete(IDS.roleLevel5);

    await env.emitMessage({ author: env.users.memberUser });
    assertXp(env.db, env.guild.id, IDS.member, 100);
    assertRoleGranted(env.members.member, IDS.roleLevel5);

    const xpReply = await env.runCommand({
      commandName: "xp",
      admin: false,
      user: env.users.memberUser,
    });
    assertReplyContains(xpReply, "100 XP");

    const lb = await env.runCommand({
      commandName: "leaderboard",
      admin: false,
      user: env.users.memberUser,
    });
    assertReplyContains(lb, "Leaderboard");
    assert.ok(lb.replies[0].files?.length >= 1);
  });

  it("journey 2: command channel lock + admin escape hatch", async () => {
    await env.runCommand({
      commandName: "setcommandchannel",
      subcommand: "add",
      admin: true,
      options: { channel: env.channels.cmds },
    });

    const blocked = await env.runCommand({
      commandName: "xp",
      channelId: IDS.channelGeneral,
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(blocked, /aren't enabled/);

    const escape = await env.runCommand({
      commandName: "setcommandchannel",
      subcommand: "list",
      channelId: IDS.channelGeneral,
      admin: true,
    });
    assertReplyContains(escape, /Allowed|bot-commands|channel/i);

    // cleanup
    await env.runCommand({
      commandName: "setcommandchannel",
      subcommand: "remove",
      admin: true,
      options: { channel: env.channels.cmds },
    });
  });

  it("journey 3: decay reduces idle XP", async () => {
    env.db.setXp(env.guild.id, IDS.member2, 500);
    env.db.updateGuildSettings(env.guild.id, {
      decay_enabled: 1,
      decay_percent: 0.2,
      decay_min_messages: 99,
      decay_window_days: 7,
    });
    await runDecayForGuild(env.client, env.guild.id);
    assertXp(env.db, env.guild.id, IDS.member2, 400);
  });

  it("journey 4: honeypot isolates spam from XP path", async () => {
    env.db.addHoneypotChannel(env.guild.id, IDS.channelHoneypot);
    env.db.updateGuildSettings(env.guild.id, {
      msg_xp: 5,
      msg_cooldown_sec: 0,
    });

    const spammer = env.createUser({ id: "user-spam-j4", username: "spamj4" });
    const spamMem = env.createMember({ guild: env.guild, user: spammer });
    env.guild.addMember(spamMem);
    env.guild._bans.length = 0;

    const beforeSpam = env.db.getXp(env.guild.id, spammer.id);
    const honeyMsg = await env.emitMessage({
      author: spammer,
      member: spamMem,
      channel: env.channels.honeypot,
    });
    assert.equal(honeyMsg.deleted, true);
    assertBanned(env.guild, spammer.id);
    assertXp(env.db, env.guild.id, spammer.id, beforeSpam);

    const legitBefore = env.db.getXp(env.guild.id, IDS.admin);
    await env.emitMessage({
      author: env.users.adminUser,
      member: env.members.adminMember,
      channel: env.channels.general,
    });
    assertXp(env.db, env.guild.id, IDS.admin, legitBefore + 5);
  });
});
