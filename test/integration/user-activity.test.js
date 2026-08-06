const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertEphemeralReply,
  assertReplyContains,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");
const { parseButtonCustomId } = require("../../src/features/userinfo");

describe("integration: user activity", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;

  before(async () => {
    env = await createIntegrationEnv();
    env.db.updateGuildSettings(env.guild.id, {
      msg_xp: 5,
      msg_cooldown_sec: 60,
    });
  });

  it("message pipeline records channel activity independent of XP cooldown", async () => {
    const uid = IDS.member;
    // first message: XP + count
    await env.emitMessage({
      author: env.users.memberUser,
      channel: env.channels.general,
    });
    // second within cooldown: no XP, still counts
    await env.emitMessage({
      author: env.users.memberUser,
      channel: env.channels.general,
    });

    const rows = env.db.sumByChannel(env.guild.id, uid, {});
    const general = rows.find((r) => r.channel_id === IDS.channelGeneral);
    assert.ok(general);
    assert.ok(general.count >= 2);

    // XP only once due to cooldown
    assert.equal(env.db.getXp(env.guild.id, uid), 5);
  });

  it("does not count bots or honeypot channels", async () => {
    env.db.addHoneypotChannel(env.guild.id, IDS.channelHoneypot);
    const before = env.db.totalPosts(env.guild.id, IDS.bot, {});

    await env.emitMessage({
      author: env.users.botUser,
      channel: env.channels.general,
    });
    assert.equal(env.db.totalPosts(env.guild.id, IDS.bot, {}), before);

    // honeypot path bans/deletes — still should not leave activity for member on hp
    const memBefore = env.db.totalPosts(env.guild.id, IDS.member2, {});
    await env.emitMessage({
      author: env.users.member2User,
      channel: env.channels.honeypot,
      member: env.members.member2,
    });
    // may or may not record before honeypot handler depending on order — pipeline
    // records AFTER honeypot return, so honeypot messages are not counted
    assert.equal(env.db.totalPosts(env.guild.id, IDS.member2, {}), memBefore);
  });

  it("ignored channel is not counted", async () => {
    env.db.addActivityIgnore(env.guild.id, IDS.channelCmds, "channel");
    const uid = "user-act-ignore";
    const user = env.createUser({ id: uid, username: "ig" });
    const mem = env.createMember({
      guild: env.guild,
      user,
      admin: false,
    });
    env.guild.addMember(mem);

    await env.emitMessage({
      author: user,
      channel: env.channels.cmds,
      member: mem,
    });
    assert.equal(env.db.totalPosts(env.guild.id, uid, {}), 0);

    await env.emitMessage({
      author: user,
      channel: env.channels.general,
      member: mem,
    });
    assert.ok(env.db.totalPosts(env.guild.id, uid, {}) >= 1);
  });

  it("/activityconfig ignore list and status (admin)", async () => {
    const add = await env.runCommand({
      commandName: "activityconfig",
      subcommandGroup: "ignore",
      subcommand: "add",
      admin: true,
      options: {
        kind: "channel",
        target: env.channels.log,
      },
    });
    assertEphemeralReply(add, /ignoring/i);

    const list = await env.runCommand({
      commandName: "activityconfig",
      subcommandGroup: "ignore",
      subcommand: "list",
      admin: true,
    });
    assertEphemeralReply(list, /ignore list|channel/i);

    const status = await env.runCommand({
      commandName: "activityconfig",
      subcommand: "status",
      admin: true,
    });
    assertEphemeralReply(status, /Activity tracking|Live collect/i);
  });

  it("/activityconfig denies non-admin", async () => {
    const interaction = await env.runCommand({
      commandName: "activityconfig",
      subcommand: "status",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(interaction, /permission/i);
  });

  it("Activity button requires senior staff; admin can open", async () => {
    // seed some counts
    env.db.ensureGuildActivitySettings(env.guild.id);
    env.db.incrementDaily(
      env.guild.id,
      IDS.member,
      IDS.channelGeneral,
      env.db.utcDayKey(),
      12
    );

    // junior staff role only
    env.db.addStaffRole(env.guild.id, IDS.roleExempt, "junior");
    const juniorUser = env.createUser({
      id: "user-junior-act",
      username: "junior",
    });
    const juniorMem = env.createMember({
      guild: env.guild,
      user: juniorUser,
      roleIds: [IDS.roleExempt],
      admin: false,
    });
    env.guild.addMember(juniorMem);

    const denied = await env.runButton({
      customId: `ui:a:${IDS.member}`,
      admin: false,
      user: juniorUser,
      member: juniorMem,
    });
    assertEphemeralReply(denied, /senior/i);

    const ok = await env.runButton({
      customId: `ui:a:${IDS.member}`,
      admin: true,
    });
    // update or reply with activity embed
    const last = ok.replies[ok.replies.length - 1] || ok.updates?.[ok.updates.length - 1];
    // harness may use update path
    const payload = ok.updates?.length
      ? ok.updates[ok.updates.length - 1]
      : ok.replies[ok.replies.length - 1];
    assert.ok(payload);
    const text = JSON.stringify(payload);
    assert.match(text, /Activity|Top channels|general|12/i);
  });

  it("parses extended userinfo activity button ids", () => {
    assert.deepEqual(parseButtonCustomId(`ui:a:${IDS.member}`), {
      view: "a",
      userId: IDS.member,
      win: "a",
    });
    assert.deepEqual(parseButtonCustomId(`ui:aw:30:ch:${IDS.member}`), {
      view: "a",
      userId: IDS.member,
      win: "30",
    });
    assert.deepEqual(parseButtonCustomId(`ui:ap:ca:7:${IDS.member}`), {
      view: "c",
      userId: IDS.member,
      win: "7",
    });
  });
});
