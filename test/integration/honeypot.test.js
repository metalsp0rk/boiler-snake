const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertBanned,
  assertNotBanned,
  assertReplyContains,
  assertEphemeralReply,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

describe("integration: honeypot", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let handleHoneypotBanRole;
  let executeHoneypotBan;

  before(async () => {
    env = await createIntegrationEnv();
    const hp = require("../../src/features/honeypot");
    handleHoneypotBanRole = hp.handleHoneypotBanRole;
    executeHoneypotBan = hp.executeHoneypotBan;
  });

  it("/honeypot channel add/list", async () => {
    const interaction = await env.runCommand({
      commandName: "honeypot",
      subcommandGroup: "channel",
      subcommand: "add",
      admin: true,
      options: { channel: env.channels.honeypot },
    });
    assertReplyContains(interaction, /honeypot/i);
    assert.ok(env.db.isHoneypotChannel(env.guild.id, IDS.channelHoneypot));

    const list = await env.runCommand({
      commandName: "honeypot",
      subcommandGroup: "channel",
      subcommand: "list",
      admin: true,
    });
    assertReplyContains(list, IDS.channelHoneypot);
  });

  it("/honeypot denies non-admin", async () => {
    const interaction = await env.runCommand({
      commandName: "honeypot",
      subcommandGroup: "channel",
      subcommand: "list",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(interaction, /permission/i);
  });

  it("ban-role grant triggers ban", async () => {
    env.db.addHoneypotBanRole(env.guild.id, IDS.roleBan);
    const user = env.createUser({ id: "user-banrole-1", username: "raider" });
    const oldMember = env.createMember({ guild: env.guild, user, roleIds: [] });
    const newMember = env.createMember({
      guild: env.guild,
      user,
      roleIds: [IDS.roleBan],
    });
    env.guild.addMember(newMember);
    env.guild._bans.length = 0;
    await handleHoneypotBanRole(oldMember, newMember);
    assertBanned(env.guild, user.id);
  });

  it("ban-role skips exempt members", async () => {
    env.db.addHoneypotBanRole(env.guild.id, IDS.roleBan);
    env.db.addHoneypotExemptRole(env.guild.id, IDS.roleExempt);
    const user = env.createUser({ id: "user-banrole-exempt", username: "staff2" });
    const oldMember = env.createMember({ guild: env.guild, user, roleIds: [IDS.roleExempt] });
    const newMember = env.createMember({
      guild: env.guild,
      user,
      roleIds: [IDS.roleExempt, IDS.roleBan],
    });
    env.guild._bans.length = 0;
    await handleHoneypotBanRole(oldMember, newMember);
    assertNotBanned(env.guild, user.id);
  });

  it("executeHoneypotBan DMs, deletes, bans", async () => {
    const user = env.createUser({ id: "user-exec-ban", username: "spam" });
    const message = env.makeMessage({ author: user });
    env.guild._bans.length = 0;
    await executeHoneypotBan(env.guild, user, {
      reason: "test ban",
      deleteMessage: message,
      trigger: "channel",
      channelId: IDS.channelHoneypot,
    });
    assert.equal(message.deleted, true);
    assert.ok(user.sends.length >= 1);
    assertBanned(env.guild, user.id);
  });
});
