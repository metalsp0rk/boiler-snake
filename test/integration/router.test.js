const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertEphemeralReply,
  assertReplyContains,
  assertNoReply,
} = require("../helpers/assert");
const { createChatInputInteraction, createUser } = require("../helpers/discord");
const { IDS } = require("../helpers/fixtures");

describe("integration: router", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;

  before(async () => {
    env = await createIntegrationEnv();
  });

  it("ignores non-command interactions", async () => {
    const interaction = createChatInputInteraction({
      commandName: "xp",
      guild: env.guild,
      user: env.users.memberUser,
      member: env.members.member,
      admin: false,
    });
    interaction.isChatInputCommand = () => false;
    interaction.isAutocomplete = () => false;
    await env.handleInteraction(interaction, env.ctx);
    assertNoReply(interaction);
  });

  it("ignores DMs (no guild)", async () => {
    const interaction = await env.runCommand({
      commandName: "xp",
      guild: null,
      user: env.users.memberUser,
      admin: false,
    });
    // runCommand still builds guild unless null — use handleInteraction directly
    const i = createChatInputInteraction({
      commandName: "xp",
      guild: null,
      user: env.users.memberUser,
      member: null,
      admin: false,
    });
    await env.handleInteraction(i, env.ctx);
    assertNoReply(i);
  });

  it("replies for unknown command", async () => {
    const interaction = await env.runCommand({
      commandName: "notarealcommand",
      admin: true,
    });
    assertEphemeralReply(interaction, /Unhandled command/);
  });

  it("allows commands when no channel allow-list", async () => {
    const interaction = await env.runCommand({
      commandName: "xp",
      admin: false,
      user: env.users.memberUser,
    });
    assertReplyContains(interaction, "XP");
  });

  it("blocks commands outside allow-list", async () => {
    env.db.addAllowedCommandChannel(env.guild.id, IDS.channelCmds);
    const blocked = await env.runCommand({
      commandName: "xp",
      channelId: IDS.channelGeneral,
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(blocked, /aren't enabled/);

    const allowed = await env.runCommand({
      commandName: "xp",
      channelId: IDS.channelCmds,
      admin: false,
      user: env.users.memberUser,
    });
    assertReplyContains(allowed, "XP");

    // cleanup for other tests in file
    env.db.removeAllowedCommandChannel(env.guild.id, IDS.channelCmds);
  });

  it("allows /setcommandchannel for admins even when restricted", async () => {
    env.db.addAllowedCommandChannel(env.guild.id, IDS.channelCmds);
    const interaction = await env.runCommand({
      commandName: "setcommandchannel",
      subcommand: "list",
      channelId: IDS.channelGeneral,
      admin: true,
    });
    assertReplyContains(interaction, /Allowed command channels|allowed in all/i);
    env.db.removeAllowedCommandChannel(env.guild.id, IDS.channelCmds);
  });

  it("autocomplete without handler responds empty", async () => {
    const interaction = createChatInputInteraction({
      commandName: "settings",
      guild: env.guild,
      user: env.users.adminUser,
      member: env.members.adminMember,
      autocomplete: true,
    });
    await env.handleInteraction(interaction, env.ctx);
    assert.equal(interaction.responds.length, 1);
    assert.deepEqual(interaction.responds[0], []);
  });

  it("safeErrorReply when handler throws", async () => {
    const original = env.registry.getHandler("xp");
    env.registry.registerHandler("xp", async () => {
      throw new Error("boom");
    });
    const interaction = await env.runCommand({
      commandName: "xp",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(interaction, /Something went wrong/);
    env.registry.registerHandler("xp", original);
  });
});
