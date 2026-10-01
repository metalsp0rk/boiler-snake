/**
 * Fluxer gateway-event normalizer (roadmap/fluxer.md § Normalized gateway
 * events, lines 213–267; field names from the Phase 0 record — law):
 *
 *   MESSAGE_CREATE `d`: id, channel_id, guild_id?, author{...}, content,
 *   timestamp, attachments, mentions (USER OBJECTS), mention_roles (id strings),
 *   mention_channels ({id, name, type, mention_string, ...}), mention_everyone
 *   (bool), member (author's member; `roles` = array of ids).
 *   **There is no `mention_users` field.**
 *
 *   MESSAGE_REACTION_ADD/REMOVE is ONE object:
 *   {user_id, channel_id, message_id, emoji{name, id?, animated?}, guild_id?, member?}
 *
 * The real Fluxer SDK (core package 3.1.0, verified in prod 2026-10-01) emits
 * HYDRATED camelCase model instances for these events (Message: channelId,
 * guildId, createdAt, mentionRoles, attachments as a Collection; reaction
 * payloads: {messageId, channelId, userId, emoji, user, member, reaction}).
 * Every field read below accepts BOTH spellings — camelCase first where the
 * SDK model is the source of truth, snake_case kept for raw-wire payloads,
 * the Phase 0 law, and test fixtures.
 *
 * SDK-free, discord.js-free, sync. Community resolution is ASYNC and belongs
 * to the pipeline/dispatch layer (contract 4) — this module only sets
 * `communityId: null` for the pipeline to fill.
 */

/** Phase 0 pre-K10 fallback order for user ids (spec § Mentions, line 475). */
const USER_ID_KEYS = ["mentions", "mention_users"];

/** SDK model Collection (Map subclass) of attachments → plain array. */
function iterAttachments(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return Array.from(value.values());
  return [];
}

/**
 * Best-effort Date from a gateway timestamp (ISO-8601 string or ms epoch).
 * An unparseable timestamp yields null (spec NormalizedMessage.createdAt).
 *
 * @param {unknown} value
 * @returns {Date|null}
 */
function toDate(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Map the `mentions` array (Phase 0: user objects; plain strings tolerated for
 * hand-built payloads) to ids, filling the id→bot flag map the dispatcher
 * needs for K10 user options (never defaulting bot to false).
 *
 * @param {unknown} value
 * @returns {{ ids: string[], bots: Map<string, boolean> }}
 */
function mapUserMentions(value) {
  const ids = [];
  const bots = new Map();
  if (!Array.isArray(value)) return { ids, bots };
  for (const entry of value) {
    if (typeof entry === "string" || typeof entry === "number") {
      ids.push(String(entry));
      continue;
    }
    if (entry && typeof entry === "object" && entry.id != null) {
      const id = String(entry.id);
      ids.push(id);
      bots.set(id, Boolean(entry.bot));
    }
  }
  return { ids, bots };
}

/**
 * Map an id-array field (mention_roles) tolerating object entries.
 * @param {unknown} value
 * @returns {string[]}
 */
function mapIdArray(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const entry of value) {
    if (typeof entry === "string" || typeof entry === "number") ids.push(String(entry));
    else if (entry && typeof entry === "object" && entry.id != null) ids.push(String(entry.id));
  }
  return ids;
}

/**
 * Normalize one Fluxer MESSAGE_CREATE gateway event into a NormalizedMessage.
 *
 * DMs (no `d.guild_id`) are dropped: v1 features are guild-scoped (spec
 * contract 4 — `null` when `d` has no guild_id).
 *
 * @param {{t?: string, d?: object}|object} raw gateway event `{t, d}` (a bare
 *   `d` payload is accepted too)
 * @param {{instanceKey?: string}} [opts]
 * @returns {object|null} NormalizedMessage, or null for DMs / unusable payloads
 */
function normalizeFluxerMessage(raw, { instanceKey = "fluxer" } = {}) {
  const d = raw && typeof raw === "object" && "d" in raw ? raw.d : raw;
  if (!d || typeof d !== "object") return null;

  // Dual-shape field reads: camelCase = SDK model instance (prod gateway),
  // snake_case = raw wire payload (Phase 0 record, fixtures).
  const guildId = d.guild_id ?? d.guildId;
  const channelId = d.channel_id ?? d.channelId;
  const timestamp = d.timestamp ?? d.createdAt;
  const member = d.member ?? null;

  // Guild gate: DMs are not feature traffic in v1.
  if (guildId == null || guildId === "") return null;
  if (d.id == null || channelId == null) return null;
  if (!d.author || typeof d.author !== "object" || d.author.id == null) return null;

  // Mentions.users: Phase 0 field is `mentions`; the spec's fallback order
  // (line 475) reads the first of mentions / mention_users that is an array.
  let usersSource = undefined;
  for (const key of USER_ID_KEYS) {
    if (Array.isArray(d[key])) {
      usersSource = d[key];
      break;
    }
  }
  const { ids: userIds, bots: mentionBots } = mapUserMentions(usersSource);

  // mention_channels entries carry {id, name, type, ...} (Phase 0): ids go to
  // mentions.channels, numeric types to channelTypes for § Prefix grammar 6.
  const channelIds = [];
  const channelTypes = new Map();
  const rawChannels = Array.isArray(d.mention_channels ?? d.mentionChannels)
    ? (d.mention_channels ?? d.mentionChannels)
    : [];
  for (const entry of rawChannels) {
    if (typeof entry === "string" || typeof entry === "number") {
      channelIds.push(String(entry));
      continue;
    }
    if (entry && typeof entry === "object" && entry.id != null) {
      const id = String(entry.id);
      channelIds.push(id);
      if (typeof entry.type === "number") channelTypes.set(id, entry.type);
    }
  }

  const attachments = iterAttachments(d.attachments)
    .filter((a) => a && typeof a === "object")
    .map((a) => ({ name: a.filename ?? "file", url: a.url ?? "" }));

  return {
    platform: "fluxer",
    instanceKey,
    // Filled ASYNC by the pipeline via ensureCommunity (contract 4).
    communityId: null,
    externalGuildId: String(guildId),
    id: String(d.id),
    channelId: String(channelId),
    authorId: String(d.author.id),
    authorBot: Boolean(d.author.bot),
    content: typeof d.content === "string" ? d.content : (d.content ?? ""),
    mentions: {
      users: userIds,
      roles: mapIdArray(d.mention_roles ?? d.mentionRoles),
      channels: channelIds,
    },
    // Raw author object kept for the context builder's ResolvedUser
    // (username lives only on the gateway payload — contract 6).
    authorRaw: d.author,
    attachments,
    createdAt: toDate(timestamp),
    // Pipeline-added fields (contract 1):
    memberRoleIds: mapIdArray(member?.roles),
    channelTypes,
    memberRaw: member,
    // id→bot flags for resolved mentions (dispatch step 3 — never default false).
    mentionBots,
    // Raw mention user objects (id, username, bot) kept for the same reason as
    // authorRaw: usernames exist only on the gateway payload. Dispatch reads
    // them when resolving a user option from mentions.
    mentionUsersRaw: Array.isArray(usersSource)
      ? usersSource.filter((u) => u && typeof u === "object" && u.id != null)
      : [],
    parsePrefix: null,
  };
}

/**
 * Emoji identity for NormalizedReaction.emojiKey (spec typedef lines 255–263):
 * unicode name for unicode emoji, custom id for custom emoji.
 *
 * @param {object|null|undefined} emoji
 * @returns {string|null}
 */
function emojiKeyOf(emoji) {
  if (!emoji || typeof emoji !== "object") return null;
  if (emoji.id != null && emoji.id !== "") return String(emoji.id);
  if (typeof emoji.name === "string" && emoji.name !== "") return emoji.name;
  return null;
}

/**
 * Normalize one Fluxer MESSAGE_REACTION_ADD/REMOVE payload (ONE object —
 * Phase 0 record) into a NormalizedReaction.
 *
 * A required identity field missing means the reaction pipeline cannot act:
 * log the missing field and return null (spec line 231).
 *
 * @param {{t?: string, d?: object}|object} raw gateway event `{t, d}`
 * @param {{instanceKey?: string}} [opts]
 * @returns {object|null} NormalizedReaction, or null for unusable payloads
 */
function normalizeFluxerReaction(raw, { instanceKey = "fluxer" } = {}) {
  const d = raw && typeof raw === "object" && "d" in raw ? raw.d : raw;
  if (!d || typeof d !== "object") return null;

  // Dual-shape reads (SDK payload: flat camelCase ids + reaction model).
  const messageId = d.message_id ?? d.messageId;
  const channelId = d.channel_id ?? d.channelId;
  const userId = d.user_id ?? d.userId;
  const emoji = d.emoji ?? d.reaction?.emoji ?? null;
  const guildId = d.guild_id ?? d.guildId ?? d.reaction?.guildId ?? null;

  const fields = { message_id: messageId, channel_id: channelId, user_id: userId };
  for (const [field, value] of Object.entries(fields)) {
    if (value == null || value === "") {
      console.error(
        `[fluxer] reaction payload missing required field "${field}" (instance ${instanceKey}, message ${messageId ?? "?"}) — skipped`,
      );
      return null;
    }
  }
  const emojiKey = emojiKeyOf(emoji);
  if (emojiKey == null) {
    console.error(
      `[fluxer] reaction payload missing required field "emoji" (instance ${instanceKey}, message ${messageId}) — skipped`,
    );
    return null;
  }

  return {
    platform: "fluxer",
    instanceKey,
    // Filled by the pipeline (contract 4 / reaction pipeline order).
    communityId: null,
    externalGuildId: guildId != null && guildId !== "" ? String(guildId) : null,
    messageId: String(messageId),
    channelId: String(channelId),
    userId: String(userId),
    userBot: Boolean(d.user?.bot ?? d.member?.user?.bot),
    emojiKey,
  };
}

module.exports = {
  normalizeFluxerMessage,
  normalizeFluxerReaction,
};
