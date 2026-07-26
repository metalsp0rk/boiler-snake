const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertEphemeralReply,
  assertReplyContains,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

describe("integration: config commands", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;

  before(async () => {
    env = await createIntegrationEnv();
  });

  it("/setcommandchannel add/list/remove", async () => {
    const ch = env.channels.cmds;
    let interaction = await env.runCommand({
      commandName: "setcommandchannel",
      subcommand: "add",
      admin: true,
      options: { channel: ch },
    });
    assertReplyContains(interaction, "allowed");
    const rows = env.db.listAllowedCommandChannels(env.guild.id);
    assert.ok(rows.some((r) => r.channel_id === ch.id));

    interaction = await env.runCommand({
      commandName: "setcommandchannel",
      subcommand: "list",
      admin: true,
    });
    assertReplyContains(interaction, ch.id);

    interaction = await env.runCommand({
      commandName: "setcommandchannel",
      subcommand: "remove",
      admin: true,
      options: { channel: ch },
    });
    assertReplyContains(interaction, "Removed");
    assert.equal(env.db.listAllowedCommandChannels(env.guild.id).length, 0);
  });

  it("/setdecay updates settings and scales percent", async () => {
    const interaction = await env.runCommand({
      commandName: "setdecay",
      admin: true,
      options: {
        enabled: true,
        messages: 5,
        days: 7,
        percent: 10,
      },
    });
    assertReplyContains(interaction, "Updated decay");
    const s = env.db.getGuildSettings(env.guild.id);
    assert.equal(s.decay_enabled, 1);
    assert.equal(s.decay_min_messages, 5);
    assert.equal(s.decay_window_days, 7);
    assert.ok(Math.abs(s.decay_percent - 0.1) < 1e-9);
  });

  it("/leveltorole set/list/remove", async () => {
    const role = { id: IDS.roleLevel5, toString: () => `<@&${IDS.roleLevel5}>` };
    let interaction = await env.runCommand({
      commandName: "leveltorole",
      subcommand: "set",
      admin: true,
      options: { role, level: 3, dropdays: 2 },
    });
    assertReplyContains(interaction, "Mapped");
    let rows = env.db.listLevelRoles(env.guild.id);
    assert.ok(rows.some((r) => r.role_id === IDS.roleLevel5 && r.level_required === 3));

    interaction = await env.runCommand({
      commandName: "leveltorole",
      subcommand: "list",
      admin: true,
    });
    assertReplyContains(interaction, "Lvl 3");

    interaction = await env.runCommand({
      commandName: "leveltorole",
      subcommand: "remove",
      admin: true,
      options: { role },
    });
    assertReplyContains(interaction, "Removed mapping");
    rows = env.db.listLevelRoles(env.guild.id);
    assert.ok(!rows.some((r) => r.role_id === IDS.roleLevel5));
  });

  it("/setlog audit/message/show", async () => {
    let interaction = await env.runCommand({
      commandName: "setlog",
      subcommand: "audit",
      admin: true,
      options: { channel: env.channels.log },
    });
    assertReplyContains(interaction, /audit|log/i);
    assert.equal(
      env.db.getGuildSettings(env.guild.id).audit_log_channel_id,
      IDS.channelLog
    );

    interaction = await env.runCommand({
      commandName: "setlog",
      subcommand: "message",
      admin: true,
      options: { channel: env.channels.log },
    });
    assert.equal(
      env.db.getGuildSettings(env.guild.id).message_log_channel_id,
      IDS.channelLog
    );

    interaction = await env.runCommand({
      commandName: "setlog",
      subcommand: "show",
      admin: true,
    });
    assertReplyContains(interaction, IDS.channelLog);
  });

  it("config commands deny non-admin", async () => {
    for (const commandName of [
      "setcommandchannel",
      "setdecay",
      "leveltorole",
      "setlog",
    ]) {
      const interaction = await env.runCommand({
        commandName,
        subcommand: commandName === "setlog" ? "show" : commandName === "setcommandchannel" ? "list" : commandName === "leveltorole" ? "list" : undefined,
        admin: false,
        user: env.users.memberUser,
        options: commandName === "setdecay" ? { enabled: true } : {},
      });
      assertEphemeralReply(interaction, /permission/i);
    }
  });
});
