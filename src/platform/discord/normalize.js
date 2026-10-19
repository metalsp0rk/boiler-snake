/**
 * Discord message normalizer (roadmap/fluxer.md § Normalized gateway events).
 *
 * `normalizeDiscordMessage` overlays the platform-neutral NormalizedMessage
 * fields onto the raw discord.js Message the gateway delivered — it MUTATES and
 * returns the SAME object (identity contract: features like honeypot set
 * `message.deleted` on the object the pipeline received, and integration tests
 * assert on the raw mock). Every Discord duck field (guild, author, channel,
 * member, delete(), deleted, …) stays readable: features NOT yet migrated keep
 * using them exactly as before.
 *
 * @typedef {import("../context").ResolvedUser} ResolvedUser
 */

const { ensureCommunity } = require("../community");
// #466 (FLX-9): shared adapter utilities (one implementation, five consumers).
const { toNumberOrNull, mapStickerList } = require("../adapterUtils");
const { isSystemMessageType } = require("../normalizedMessageContract");

/**
 * Snowflake → string at the boundary; absent stays null.
 * @param {unknown} value
 * @returns {string|null}
 */
function toIdString(value) {
  return value != null ? String(value) : null;
}

/**
 * Collection/Map/array of ids → string[]. Missing collections become [].
 * Arrays are read as the ids themselves (a second, idempotent pass sees the
 * normalized string arrays, and Array#keys() would yield indices).
 * @param {{ keys?: () => Iterable<unknown> }|unknown[]|null|undefined} collection
 * @returns {string[]}
 */
function collectIds(collection) {
  if (Array.isArray(collection)) return collection.map(String);
  return [...(collection?.keys?.() ?? [])].map(String);
}



/**
 * Overlay the NormalizedMessage fields on a Discord message, in place.
 *
 * Field mapping (spec table, roadmap lines 213–267):
 * - `platform`/`instanceKey` are the constant "discord" identity pair.
 * - `externalGuildId` prefers the guild object, falls back to the raw snowflake.
 * - `communityId` is resolved ONCE here (edges resolve, features consume the
 *   integer); guild-less messages (DMs) get `null`.
 * - `parsePrefix` is ALWAYS null on Discord: a Discord message never enters the
 *   prefix branch, even when the content starts with "!". PR 6's Fluxer adapter
 *   is the only producer of non-null parsePrefix.
 *
 * Idempotent: running it twice on the same object produces the same field
 * values (plain assignment + the idempotent ensureCommunity).
 *
 * Every return satisfies the shared required-field contract enforced at the
 * pipeline boundary by src/platform/normalizedMessageContract.js ("contract
 * 1", issue #201): guild-less (DM) messages carry `externalGuildId: null`
 * EXPLICITLY — that nullability is the modeled DM semantics, not absence.
 *
 * PR 3 (§10.3 item 4) adds the relay-required fields — webhookId,
 * authorDisplayName, type, attachment {id, size, contentType, flags},
 * messageSnapshots, stickers — same field set the Fluxer normalizer fills.
 * Additive: every shipped consumer keeps reading the fields it knows.
 *
 * @param {object} message raw discord.js Message (or a test mock exposing the
 *   same duck fields: id, content, guild, guildId, channel, channelId, author,
 *   mentions, attachments, createdAt/createdTimestamp)
 * @returns {object} the SAME message, with the normalized fields set as own
 *   properties and every Discord duck field left intact
 */
function normalizeDiscordMessage(message) {
  if (!message || typeof message !== "object") {
    throw new TypeError("normalizeDiscordMessage: message required");
  }

  const externalGuildId = toIdString(message.guild?.id ?? message.guildId);

  message.platform = "discord";
  message.instanceKey = "discord";
  message.externalGuildId = externalGuildId;
  message.communityId =
    externalGuildId != null
      ? ensureCommunity({
          platform: "discord",
          instanceKey: "discord",
          externalGuildId,
        })
      : null;
  message.id = String(message.id);
  message.channelId = message.channelId ?? message.channel?.id ?? null;
  message.authorId =
    message.author?.id != null ? String(message.author.id) : null;
  message.authorBot = Boolean(message.author?.bot);
  // #437 (audit F2-1): the userActivity live gate reads `system`; until now
  // NO adapter ever set it (dead check — join/pin/boost lines with a human
  // author were counted). Truth source = discord.js MessageType via the
  // shared contract helper; backfill gates raw messages with the same one.
  message.system = isSystemMessageType(message.type);
  message.content = message.content ?? "";
  message.mentions = {
    users: collectIds(message.mentions?.users),
    roles: collectIds(message.mentions?.roles),
    channels: collectIds(message.mentions?.channels),
    everyone: Boolean(message.mentions?.everyone),
  };

  const attachmentsSource = message.attachments;
  const attachmentList =
    typeof attachmentsSource?.values === "function"
      ? [...attachmentsSource.values()]
      : Array.isArray(attachmentsSource)
        ? attachmentsSource
        : [];
  // Relay-required attachment detail (§10.3 item 4) rides alongside the
  // shipped {name, url} pair — additive, existing consumers unaffected.
  message.attachments = attachmentList.map((a) => ({
    name: a?.name ?? "",
    url: a?.url ?? "",
    id: a?.id != null ? String(a?.id) : null,
    size: toNumberOrNull(a?.size),
    contentType: a?.contentType ?? null,
    flags: toNumberOrNull(a?.flags),
  }));

  message.createdAt =
    message.createdAt instanceof Date
      ? message.createdAt
      : message.createdTimestamp != null
        ? new Date(Number(message.createdTimestamp))
        : null;

  // Relay-required fields (§10.3 item 4). All idempotent: every mapping below
  // reproduces its own normalized output on a second pass.
  //   webhookId: raw truth of the payload (null when absent).
  //   authorDisplayName: guild nickname/Global Display Name, falling back to
  //     the username ("" only when the author object carries neither).
  //   type: numeric message type (null when the payload carries none).
  //   stickers / messageSnapshots: relay reads these for copy composition.
  message.webhookId = message.webhookId != null ? String(message.webhookId) : null;
  message.authorDisplayName =
    message.member?.displayName ??
    message.author?.displayName ??
    message.author?.globalName ??
    message.author?.username ??
    "";
  message.type = typeof message.type === "number" ? message.type : null;
  message.messageSnapshots = Array.isArray(message.messageSnapshots)
    ? [...message.messageSnapshots]
    : typeof message.messageSnapshots?.values === "function"
      ? [...message.messageSnapshots.values()]
      : [];
  message.stickers = mapStickerList(message.stickers);

  // Spec line 215: Discord messages NEVER enter the prefix branch.
  message.parsePrefix = null;

  return message;
}

module.exports = { normalizeDiscordMessage };
