/**
 * Unit tests for buildDiscordCommandContext
 * (src/platform/discord/context.js). loadDb() runs BEFORE src requires
 * (communities table backs the communityId resolution); Discord fakes come
 * from test/helpers/discord. No gateway, no network.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { cleanup } = loadDb();

const {
  buildDiscordCommandContext,
  toDiscordPayload,
} = require("../src/platform/discord/context");
const { ensureCommunity } = require("../src/platform/community");
const { getDiscordOutbound } = require("../src/platform/discord/outbound");
const {
  createClient,
  createGuild,
  createUser,
  createMember,
  createChatInputInteraction,
  lastReplyEphemeral,
} = require("./helpers/discord");
const { IDS } = require("./helpers/fixtures");

after(cleanup);

/**
 * Build a /xp interaction with a fresh client/guild/member per case.
 * @param {{ admin?: boolean, ownerId?: string, options?: object }} [opts]
 */
function setup(opts = {}) {
  const client = createClient();
  const guild = createGuild({ id: IDS.guild });
  if (opts.ownerId) guild.ownerId = opts.ownerId;
  client.addGuild(guild);

  const user = createUser({ id: IDS.member, username: "member" });
  const member = createMember({ guild, user, admin: !!opts.admin });
  const interaction = createChatInputInteraction({
    commandName: "xp",
    guild,
    user,
    member,
    client,
    options: opts.options || {},
  });
  const commandCtx = buildDiscordCommandContext(interaction, {
    client,
    registry: null,
  });
  return { client, guild, user, member, interaction, commandCtx };
}

/** @param {object} interaction */
function lastReply(interaction) {
  return interaction.replies[interaction.replies.length - 1];
}

describe("platform/discord/context — buildDiscordCommandContext", () => {
  it("maps the interaction onto the spec CommandContext fields", () => {
    const target = createUser({ id: IDS.member2, username: "member2", bot: true });
    const { interaction, commandCtx, client } = setup({ options: { user: target } });

    assert.equal(commandCtx.platform, "discord");
    assert.equal(commandCtx.instanceKey, "discord");
    assert.ok(
      Number.isSafeInteger(commandCtx.communityId),
      "communityId is an internal integer, never the snowflake",
    );
    assert.equal(
      commandCtx.communityId,
      ensureCommunity({
        platform: "discord",
        instanceKey: "discord",
        externalGuildId: IDS.guild,
      }),
    );
    assert.equal(commandCtx.externalGuildId, IDS.guild);
    assert.equal(commandCtx.channelId, IDS.channelGeneral);
    assert.equal(commandCtx.userId, IDS.member);
    assert.deepEqual(commandCtx.user, {
      id: IDS.member,
      username: "member",
      bot: false,
    });
    assert.equal(commandCtx.commandName, "xp");
    assert.equal(commandCtx.subcommand, null);
    assert.equal(commandCtx.subcommandGroup, null);
    assert.equal(commandCtx.deferred, false);
    assert.equal(commandCtx.replied, false);
    for (const method of ["reply", "editReply", "followUp", "defer"]) {
      assert.equal(typeof commandCtx[method], "function");
    }
    assert.equal(typeof commandCtx.options.getString, "function");
    assert.equal(commandCtx.outbound.platform, "discord");
    assert.equal(
      commandCtx.outbound,
      getDiscordOutbound(client),
      "outbound is the cached Discord OutboundClient",
    );

    // deferred/replied mirror the live interaction state.
    interaction.deferred = true;
    interaction.replied = true;
    assert.equal(commandCtx.deferred, true);
    assert.equal(commandCtx.replied, true);
  });

  it("normalizes option getters to the platform-neutral shapes", () => {
    const target = createUser({ id: IDS.member2, username: "member2" });
    const { commandCtx } = setup({
      options: {
        user: target,
        limit: 5,
        ratio: 1.5,
        notify: true,
        note: "season wrap",
        role: { id: "role-staff" },
        channel: { id: IDS.channelLog, type: 0 },
      },
    });

    const resolved = commandCtx.options.getUser("user");
    assert.deepEqual(resolved, {
      id: IDS.member2,
      username: "member2",
      bot: false,
    });
    assert.equal("tag" in resolved, false, "ResolvedUser has id/username/bot only");

    assert.equal(commandCtx.options.getInteger("limit"), 5);
    assert.equal(commandCtx.options.getNumber("ratio"), 1.5);
    assert.equal(commandCtx.options.getBoolean("notify"), true);
    assert.equal(commandCtx.options.getString("note"), "season wrap");
    assert.deepEqual(commandCtx.options.getRole("role"), { id: "role-staff" });
    assert.deepEqual(commandCtx.options.getChannel("channel"), {
      id: IDS.channelLog,
      type: 0,
    });

    // Absent optional options read as null (never undefined).
    assert.equal(commandCtx.options.getString("missing"), null);
    assert.equal(commandCtx.options.getInteger("missing"), null);
    assert.equal(commandCtx.options.getUser("missing"), null);
    assert.equal(commandCtx.options.getRole("missing"), null);
    assert.equal(commandCtx.options.getChannel("missing"), null);
    assert.equal(commandCtx.options.getSubcommand(), null);
    assert.equal(commandCtx.options.getSubcommandGroup(), null);
  });

  it("throws the pinned Missing required option message for absent required options", () => {
    const { commandCtx } = setup();
    assert.throws(
      () => commandCtx.options.getString("user", true),
      (err) =>
        err instanceof Error &&
        /^Missing required option: user$/.test(err.message),
    );
    assert.throws(
      () => commandCtx.options.getInteger("limit", true),
      /Missing required option: limit/,
    );
    assert.throws(
      () => commandCtx.options.getUser("user", true),
      /Missing required option: user/,
    );
    // Required getRole/getChannel must not silently return null.
    assert.throws(() => commandCtx.options.getRole("role", true));
    assert.throws(() => commandCtx.options.getChannel("channel", true));
    // Optional reads stay null-safe.
    assert.equal(commandCtx.options.getString("user"), null);
  });

  it("exposes memberRoleIds including the @everyone role (guild id)", () => {
    const { commandCtx, guild } = setup();
    assert.ok(Array.isArray(commandCtx.memberRoleIds));
    assert.ok(commandCtx.memberRoleIds.includes(guild.id));
  });

  it("computes guildOwner by comparing the guild owner id to the invoker", () => {
    assert.equal(setup({ ownerId: IDS.member }).commandCtx.guildOwner, true);
    assert.equal(setup({ ownerId: IDS.admin }).commandCtx.guildOwner, false);
    // Mock guilds carry no ownerId → not owner.
    assert.equal(setup().commandCtx.guildOwner, false);
  });

  it("derives channelPermissions as a bigint mask", () => {
    const manageGuild = BigInt(PermissionFlagsBits.ManageGuild);

    const admin = setup({ admin: true });
    assert.equal(typeof admin.commandCtx.channelPermissions, "bigint");
    assert.equal(admin.commandCtx.channelPermissions & manageGuild, manageGuild);

    const civilian = setup();
    assert.equal(typeof civilian.commandCtx.channelPermissions, "bigint");
    assert.equal(civilian.commandCtx.channelPermissions & manageGuild, 0n);
  });

  it("maps sensitive replies onto MessageFlags.Ephemeral", async () => {
    const { interaction, commandCtx } = setup();
    await commandCtx.reply({ content: "stealth", sensitive: true });
    assert.equal(lastReplyEphemeral(interaction), true);
    const pushed = lastReply(interaction);
    assert.equal(pushed.flags, MessageFlags.Ephemeral);
    assert.equal(pushed.content, "stealth");
    assert.equal(
      "sensitive" in pushed,
      false,
      "sensitive is translated to the flag, never forwarded raw",
    );
  });

  it("accepts plain string replies", async () => {
    const { interaction, commandCtx } = setup();
    await commandCtx.reply("plain");
    assert.equal(lastReply(interaction).content, "plain");
  });

  it("wraps plain embeds in EmbedBuilder and passes legacy builders through", async () => {
    const { interaction, commandCtx } = setup();
    const legacy = new EmbedBuilder().setTitle("Legacy");
    await commandCtx.reply({
      embeds: [
        null,
        legacy,
        {
          title: "Updated XP settings",
          color: 0x9b59b6,
          footer: { text: "Staff only" },
        },
      ],
    });
    const embeds = lastReply(interaction).embeds;
    assert.equal(embeds.length, 2, "null entries are dropped");
    assert.equal(embeds[0], legacy, "EmbedBuilder-like entries pass by reference");
    assert.equal(typeof embeds[1].toJSON, "function", "plain object became an EmbedBuilder");
    assert.equal(embeds[1].toJSON().title, "Updated XP settings");
  });

  it("wraps plain file descriptors in AttachmentBuilder", async () => {
    const { interaction, commandCtx } = setup();
    const data = Buffer.from("PNG");
    await commandCtx.reply({
      files: [{ name: "board.png", data, contentType: "image/png" }],
    });
    const files = lastReply(interaction).files;
    assert.equal(files.length, 1);
    assert.ok(files[0] instanceof AttachmentBuilder);
    assert.equal(files[0].name, "board.png");
  });

  it("passes allowedMentions and components through unchanged", async () => {
    const { interaction, commandCtx } = setup();
    const components = [{ type: 1 }];
    await commandCtx.reply({
      content: "x",
      allowedMentions: { parse: [] },
      components,
    });
    const pushed = lastReply(interaction);
    assert.deepEqual(pushed.allowedMentions, { parse: [] });
    assert.equal(pushed.components, components);
  });

  it("defers when asked (sensitive → ephemeral flag path)", async () => {
    const { interaction, commandCtx } = setup();
    await commandCtx.defer({ sensitive: true });
    assert.equal(interaction.deferred, true);
    assert.equal(commandCtx.deferred, true);
  });

  it("throws a specific error when no Discord client is available", () => {
    // PR 7: the builder resolves featureCtx.supervisor.discord with a
    // featureCtx.client fallback (hand-built test contexts). Neither →
    // specific throw naming the command.
    const guild = createGuild({ id: IDS.guild });
    const user = createUser({ id: IDS.member });
    const interaction = createChatInputInteraction({
      commandName: "grantxp",
      guild,
      user,
    });
    assert.throws(
      () => buildDiscordCommandContext(interaction, { registry: null }),
      /supervisor\.discord \(Discord client\) required for command "\/grantxp"/,
    );
    assert.throws(
      () => buildDiscordCommandContext(interaction, undefined),
      /supervisor\.discord \(Discord client\) required for command "\/grantxp"/,
    );
  });

  it("exports toDiscordPayload for adapter-level tests", () => {
    assert.deepEqual(toDiscordPayload("hi"), { content: "hi" });
    assert.equal(toDiscordPayload({ content: "x", sensitive: true }).flags, MessageFlags.Ephemeral);
  });
});
