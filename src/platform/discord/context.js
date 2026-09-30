/**
 * Discord CommandContext builder (roadmap/fluxer.md § CommandContext).
 *
 * Turns a discord.js ChatInputCommandInteraction plus the feature context into
 * the platform-neutral CommandContext a contextual handler receives. The
 * router's chat-input arm calls this for handlers registered with
 * `api: "context"`; every other router arm keeps the raw interaction.
 *
 * Synchronous by contract (spec pins it as a plain function): communityId is
 * resolved through the communities registry (sync SQLite), outbound is the
 * cached Discord OutboundClient, and replies lazy-wrap the interaction methods.
 */

const {
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");

const { ensureCommunity } = require("../community");
const {
  missingOptionError,
  normalizeResolvedUser,
  normalizeReplyPayload,
} = require("../context");
const { getDiscordOutbound } = require("./outbound");

/**
 * Map a platform-neutral ReplyPayload onto discord.js message options:
 * - `sensitive: true` → `flags: MessageFlags.Ephemeral` (the flag is the
 *   Discord spelling of "private to the invoker"; the `sensitive` key itself
 *   is stripped — Discord only knows the flag).
 * - plain-object embeds → EmbedBuilder (constructor accepts the data object);
 *   EmbedBuilder-like entries (anything with toJSON) pass through untouched.
 * - plain `{ name, data, contentType? }` files → AttachmentBuilder;
 *   AttachmentBuilder-like entries (anything with setName) pass through.
 * - allowedMentions/components and every other key pass through unchanged.
 *
 * Exported for unit tests; handlers never call it directly.
 *
 * @param {import("../context").ReplyPayload|string} payload
 * @returns {object} payload accepted by interaction.reply/editReply/followUp
 */
function toDiscordPayload(payload) {
  const normalized = normalizeReplyPayload(payload);
  const out = { ...normalized };

  if (out.sensitive === true) out.flags = MessageFlags.Ephemeral;
  // `sensitive` is seam vocabulary; strip it from the Discord payload.
  delete out.sensitive;

  if (Array.isArray(out.embeds)) {
    out.embeds = out.embeds
      .filter((embed) => embed != null)
      .map((embed) =>
        typeof embed.toJSON === "function" ? embed : new EmbedBuilder(embed),
      );
  }

  if (Array.isArray(out.files)) {
    out.files = out.files.map((file) => {
      if (typeof file?.setName === "function") return file; // AttachmentBuilder
      // discord.js v14 infers content type from the filename extension; the
      // `contentType` hint is Fluxer-wire vocabulary (spec OutboundClient)
      // and is intentionally dropped on this adapter.
      const attachment = new AttachmentBuilder(file.data, { name: file.name });
      return attachment;
    });
  }

  return out;
}

/**
 * Read a subcommand name defensively: mocks and bare-bones interactions may
 * lack the option accessor, and discord.js throws when the command has no
 * subcommands. Absent/throwing reads mean "no subcommand".
 *
 * @param {() => unknown} read
 * @returns {string|null}
 */
function readSafely(read) {
  try {
    return read() ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the channel-scoped permission mask as a bigint.
 * Real discord.js exposes `.bitfield` (bigint); test mocks expose only
 * `.has(flag)`, so fall back to OR-ing every named flag the mask reports.
 * No memberPermissions at all → 0n (deny).
 *
 * @param {object} interaction
 * @returns {bigint}
 */
function resolveChannelPermissions(interaction) {
  const memberPermissions = interaction.memberPermissions;
  if (typeof memberPermissions?.bitfield === "bigint") {
    return memberPermissions.bitfield;
  }
  if (typeof memberPermissions?.has === "function") {
    let mask = 0n;
    for (const flag of Object.values(PermissionFlagsBits)) {
      if (memberPermissions.has(flag)) mask |= BigInt(flag);
    }
    return mask;
  }
  return 0n;
}

/**
 * Build the CommandContext for one chat-input interaction.
 *
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} featureCtx the feature context (ctx.client stays the Discord
 *   client until PR 7; this builder only needs it for the outbound adapter)
 * @returns {import("../context").CommandContext}
 */
function buildDiscordCommandContext(interaction, featureCtx) {
  if (!featureCtx?.client) {
    throw new Error(
      `buildDiscordCommandContext: featureCtx.client required for command "/${interaction?.commandName}"`,
    );
  }

  const externalGuildId = String(interaction.guildId);
  const subcommand = readSafely(() => interaction.options.getSubcommand(false));
  const subcommandGroup = readSafely(() =>
    interaction.options.getSubcommandGroup(false),
  );

  /**
   * Shared required-flag logic: mirror discord.js, which throws when a
   * `required: true` option is absent. The wrapper enforces the message even
   * against option accessors that ignore the flag (test mocks).
   *
   * @param {string} method underlying interaction.options method
   * @param {string} name option name
   * @param {boolean} required throw when missing
   * @param {(value: any) => any} transform reshape the raw gateway value
   * @returns {any} the transformed value, or null when absent and optional
   */
  function getOption(method, name, required, transform) {
    const raw = interaction.options[method](name, required);
    if (raw == null) {
      if (required) throw new Error(missingOptionError(name));
      return null;
    }
    return transform(raw);
  }

  const options = {
    getString: (name, required = false) =>
      getOption("getString", name, required, (v) => v),
    getInteger: (name, required = false) =>
      getOption("getInteger", name, required, (v) => v),
    getNumber: (name, required = false) =>
      getOption("getNumber", name, required, (v) => v),
    getBoolean: (name, required = false) =>
      getOption("getBoolean", name, required, (v) => v),
    getUser: (name, required = false) =>
      getOption("getUser", name, required, (v) => normalizeResolvedUser(v)),
    getRole: (name, required = false) =>
      getOption("getRole", name, required, (r) => ({ id: String(r.id) })),
    getChannel: (name, required = false) =>
      getOption("getChannel", name, required, (c) => ({
        id: String(c.id),
        type: c.type ?? null,
      })),
    getSubcommand: () => subcommand,
    getSubcommandGroup: () => subcommandGroup,
  };

  return {
    platform: "discord",
    instanceKey: "discord",
    communityId: ensureCommunity({
      platform: "discord",
      instanceKey: "discord",
      externalGuildId,
    }),
    externalGuildId,
    channelId: String(interaction.channelId),
    userId: String(interaction.user.id),
    user: normalizeResolvedUser(interaction.user),
    commandName: interaction.commandName,
    subcommand,
    subcommandGroup,
    options,
    channelPermissions: resolveChannelPermissions(interaction),
    memberRoleIds: [...(interaction.member?.roles?.cache?.keys?.() ?? [])].map(
      String,
    ),
    guildOwner:
      interaction.guild?.ownerId != null &&
      String(interaction.guild.ownerId) === String(interaction.user?.id),
    // State getters mirror the live interaction (deferred/replied flip as the
    // handler calls defer()/reply(), same as interaction.deferred today).
    get deferred() {
      return Boolean(interaction.deferred);
    },
    get replied() {
      return Boolean(interaction.replied);
    },
    outbound: getDiscordOutbound(featureCtx.client),
    // Discord-only escape hatch (documented, PR 4): the REAL interaction, for
    // the handful of chat-input capabilities CommandContext deliberately does
    // NOT model — currently only modal display (showModal), which Fluxer has
    // no equivalent for (roadmap § CommandContext, line 270). Context-arm
    // handlers must reach it only through the helpers in src/platform/context
    // (e.g. showModalFromContext), never for identity/options/replies, and
    // Fluxer contexts never carry it.
    rawInteraction: interaction,
    reply: (payload) => interaction.reply(toDiscordPayload(payload)),
    editReply: (payload) => interaction.editReply(toDiscordPayload(payload)),
    followUp: (payload) => interaction.followUp(toDiscordPayload(payload)),
    defer: (opts) =>
      interaction.deferReply(
        opts?.sensitive ? { flags: MessageFlags.Ephemeral } : undefined,
      ),
  };
}

module.exports = { buildDiscordCommandContext, toDiscordPayload };
