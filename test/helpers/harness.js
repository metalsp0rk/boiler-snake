const { loadDb } = require("./env");
const {
  createClient,
  createGuild,
  createUser,
  createMember,
  createTextChannel,
  createChatInputInteraction,
  createButtonInteraction,
  createMessage,
  createReaction,
  lastReplyContent,
  lastReplyEphemeral,
} = require("./discord");
const { IDS } = require("./fixtures");

/**
 * Full integration environment: temp SQLite, registry, mock Discord graph.
 * Reloads src modules so repositories bind to the temp DB.
 *
 * @param {object} [options]
 * @param {string} [options.guildId]
 * @returns {Promise<object>} env; call `env.cleanup()` in the file's `after()`
 *   hook to close DB handles and remove the temp dir (idempotent, never throws)
 */
async function createIntegrationEnv(options = {}) {
  const { api: db, tmpDir, dbPath, cleanup } = loadDb();

  // Require after loadDb so modules bind to temp SQLite
  const { handleInteraction } = require("../../src/commands/router");
  const { buildDefaultRegistry } = require("../../src/commands/registry");
  const {
    onMessageCreate,
    onMessageReactionAdd,
    onMessageReactionRemove,
  } = require("../../src/bot/pipelines");
  const { normalizeDiscordMessage } = require("../../src/platform/discord/normalize");
  const {
    getDiscordOutbound,
    createDiscordOutbound,
  } = require("../../src/platform/discord/outbound");

  const registry = buildDefaultRegistry();

  const guildId = options.guildId || IDS.guild;
  const client = createClient();
  const guild = createGuild({
    id: guildId,
    afkChannelId: options.afkChannelId || IDS.channelAfk,
  });
  client.addGuild(guild);

  // Fluxer PR 2: repositories are keyed by the INTEGER communities.id.
  // The harness registers the Discord guild as a community at env creation
  // (spec § Repository boundary edge pattern) so every test seeds/reads by
  // `env.communityId` while Discord fixtures keep the snowflake `guildId`.
  const { ensureCommunity, getCommunityById } = require("../../src/platform/community");
  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: guildId,
  });

  const adminUser = createUser({ id: IDS.admin, username: "admin" });
  const memberUser = createUser({ id: IDS.member, username: "member" });
  const member2User = createUser({ id: IDS.member2, username: "member2" });
  const botUser = createUser({ id: IDS.bot, username: "bot", bot: true });

  const adminMember = createMember({ guild, user: adminUser, admin: true });
  const member = createMember({ guild, user: memberUser, admin: false });
  const member2 = createMember({ guild, user: member2User, admin: false });
  // Bot member needs Manage Channels for ticket channel creation preflight
  const { PermissionFlagsBits } = require("discord.js");
  const botMember = createMember({
    guild,
    user: botUser,
    admin: false,
    permissions:
      PermissionFlagsBits.ManageChannels |
      PermissionFlagsBits.ManageRoles |
      PermissionFlagsBits.ViewChannel |
      PermissionFlagsBits.SendMessages,
  });

  guild.addMember(adminMember);
  guild.addMember(member);
  guild.addMember(member2);
  guild.addMember(botMember);
  // discord.js-style shortcut used by tickets openTicketChannel
  guild.members.me = botMember;

  // Common staff / exempt role used by honeypot + ticket tests
  guild.roles.cache.set(IDS.roleExempt, {
    id: IDS.roleExempt,
    name: "Staff",
    position: 1,
    managed: false,
  });
  // Bot role above staff for overwrite hierarchy checks
  guild.roles.cache.set("role-bot", {
    id: "role-bot",
    name: "Bot",
    position: 5,
    managed: false,
  });
  botMember.roles.cache.set("role-bot", { id: "role-bot", position: 5 });
  botMember.roles.highest = { id: "role-bot", position: 5 };

  const channelGeneral = createTextChannel({
    id: IDS.channelGeneral,
    guild,
    name: "general",
  });
  const channelCmds = createTextChannel({
    id: IDS.channelCmds,
    guild,
    name: "bot-commands",
  });
  const channelHoneypot = createTextChannel({
    id: IDS.channelHoneypot,
    guild,
    name: "honeypot",
  });
  const channelLog = createTextChannel({
    id: IDS.channelLog,
    guild,
    name: "mod-log",
  });
  const channelNotify = createTextChannel({
    id: IDS.channelNotify,
    guild,
    name: "yt-notify",
  });
  const channelVoice = createTextChannel({
    id: IDS.channelVoice,
    guild,
    name: "General",
    type: 2,
  });

  for (const ch of [
    channelGeneral,
    channelCmds,
    channelHoneypot,
    channelLog,
    channelNotify,
    channelVoice,
  ]) {
    guild.addChannel(ch);
  }

  const ensureWarning =
    options.ensureHoneypotWarning ||
    (async () => "Warning notice mocked for tests.");

  // Fluxer PR 7 (spec § Supervisor): the integration env gains a supervisor
  // mirror of the mock Discord client. clientForCommunity reads the communities
  // row: platform "discord" → ONE shared Discord OutboundClient over the mock
  // client (cached); "fluxer" → null (tests run no live fluxer instances).
  // Mirrors boot.js clientForCommunity's never-throw contract.
  let discordOutbound = null;
  function clientForCommunity(communityId) {
    let row = null;
    try {
      row = getCommunityById(communityId);
    } catch (err) {
      console.error(
        `[harness] clientForCommunity(${communityId}) failed: ${err?.message || err}`
      );
      return null;
    }
    if (!row) return null;
    if (row.platform === "discord") {
      if (!discordOutbound) discordOutbound = createDiscordOutbound(client);
      return discordOutbound;
    }
    return null; // fluxer rows: no live instances in tests
  }

  const supervisor = {
    discord: client,
    fluxer: new Map(),
    clientForCommunity,
  };

  const ctx = {
    client,
    supervisor,
    registry,
    ensureHoneypotWarning: ensureWarning,
  };

  /**
   * Run a slash command through the real router.
   * @param {object} cmdOpts
   */
  async function runCommand(cmdOpts) {
    const user =
      cmdOpts.user ||
      (cmdOpts.admin === false ? memberUser : adminUser);

    let mem = cmdOpts.member;
    if (!mem) {
      if (user.id === adminUser.id) mem = adminMember;
      else if (user.id === memberUser.id) mem = member;
      else if (user.id === member2User.id) mem = member2;
      else mem = createMember({ guild, user, admin: cmdOpts.admin !== false });
    }

    if (cmdOpts.admin === true) mem.setAdmin?.(true);
    if (cmdOpts.admin === false) mem.setAdmin?.(false);

    const interaction = createChatInputInteraction({
      commandName: cmdOpts.commandName,
      guild: cmdOpts.guild === null ? null : (cmdOpts.guild || guild),
      user,
      member: mem,
      channelId: cmdOpts.channelId || IDS.channelGeneral,
      client,
      admin: cmdOpts.admin !== false,
      options: cmdOpts.options || {},
      subcommand: cmdOpts.subcommand,
      subcommandGroup: cmdOpts.subcommandGroup,
      autocomplete: cmdOpts.autocomplete,
      focused: cmdOpts.focused,
    });

    if (cmdOpts.admin === false) interaction.setAdmin(false);
    if (cmdOpts.admin === true) interaction.setAdmin(true);

    await handleInteraction(interaction, ctx);
    return interaction;
  }

  /**
   * Run a button interaction through the real router.
   * @param {object} btnOpts
   * @param {string} btnOpts.customId
   * @param {boolean} [btnOpts.admin]
   * @param {object} [btnOpts.user]
   * @param {object} [btnOpts.member]
   */
  async function runButton(btnOpts) {
    const user =
      btnOpts.user ||
      (btnOpts.admin === false ? memberUser : adminUser);

    let mem = btnOpts.member;
    if (!mem) {
      if (user.id === adminUser.id) mem = adminMember;
      else if (user.id === memberUser.id) mem = member;
      else if (user.id === member2User.id) mem = member2;
      else mem = createMember({ guild, user, admin: btnOpts.admin !== false });
    }

    if (btnOpts.admin === true) mem.setAdmin?.(true);
    if (btnOpts.admin === false) mem.setAdmin?.(false);

    const interaction = createButtonInteraction({
      customId: btnOpts.customId,
      guild,
      user,
      member: mem,
      client,
      admin: btnOpts.admin !== false,
    });

    if (btnOpts.admin === false) interaction.setAdmin(false);
    if (btnOpts.admin === true) interaction.setAdmin(true);

    await handleInteraction(interaction, ctx);
    return interaction;
  }

  function makeMessage(overrides = {}) {
    const author = overrides.author || memberUser;
    let mem = overrides.member;
    if (!mem) {
      if (author.id === memberUser.id) mem = member;
      else if (author.id === adminUser.id) mem = adminMember;
      else if (author.id === member2User.id) mem = member2;
      else mem = createMember({ guild, user: author });
    }
    return createMessage({
      guild,
      channel: overrides.channel || channelGeneral,
      author,
      member: mem,
      content: overrides.content || "test message",
      id: overrides.id,
      deletable: overrides.deletable,
    });
  }

  async function emitMessage(overrides = {}) {
    const message = makeMessage(overrides);
    // Normalize to the same object (identity contract), so tests asserting on
    // the returned raw mock (e.g. `message.deleted`) keep working.
    await onMessageCreate(
      getDiscordOutbound(client),
      normalizeDiscordMessage(message),
      { gorkClient: client }
    );
    return message;
  }

  async function emitReactionAdd(overrides = {}) {
    const message = overrides.message || makeMessage();
    const user = overrides.user || memberUser;
    const reaction = createReaction({
      message,
      emoji: overrides.emoji,
      partial: overrides.partial,
    });
    await onMessageReactionAdd(client, reaction, user);
    return { reaction, user, message };
  }

  return {
    db,
    tmpDir,
    dbPath,
    cleanup,
    client,
    supervisor,
    guild,
    guildId,
    communityId,
    registry,
    ctx,
    users: { adminUser, memberUser, member2User, botUser },
    members: { adminMember, member, member2 },
    channels: {
      general: channelGeneral,
      cmds: channelCmds,
      honeypot: channelHoneypot,
      log: channelLog,
      notify: channelNotify,
      voice: channelVoice,
    },
    runCommand,
    runButton,
    makeMessage,
    emitMessage,
    emitReactionAdd,
    onMessageCreate: (msg) =>
      onMessageCreate(getDiscordOutbound(client), normalizeDiscordMessage(msg), {
        gorkClient: client,
      }),
    onMessageReactionAdd: (reaction, user) =>
      onMessageReactionAdd(client, reaction, user),
    onMessageReactionRemove: (reaction, user) =>
      onMessageReactionRemove(client, reaction, user),
    lastReplyContent,
    lastReplyEphemeral,
    createChatInputInteraction,
    createMessage,
    createReaction,
    createMember,
    createUser,
    createTextChannel,
    handleInteraction,
    IDS,
  };
}

module.exports = {
  createIntegrationEnv,
};
