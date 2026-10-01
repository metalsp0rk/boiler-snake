// src/reactionRoles.js
// Bot-managed reaction role panels: embed + emoji options with min level + removable flag.

const { EmbedBuilder } = require("discord.js");
const {
  getReactionRolePanel,
  createReactionRolePanel,
  listReactionRoleOptions,
  getReactionRoleOption,
  isReactionRolePanel,
  upsertReactionRoleOption,
  deleteReactionRoleOption,
  countReactionRoleOptions,
  listReactionRoleLevelRequirements,
  getXp,
  getGuildSettings,
} = require("../../db");
const { levelFromXp } = require("../../core/xpMath");
const { Color } = require("../../core/theme");
const { getDiscordOutbound } = require("../../platform/discord/outbound");
const { ensureCommunity } = require("../../platform/community");

/**
 * Fluxer PR 2 Discord edge: external snowflake → internal INTEGER community id
 * (create-on-sight). All repo calls in this module are community-keyed.
 * @param {string} guildId external Discord guild id
 * @returns {number} communities.id
 */
function communityIdFor(guildId) {
  return ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: String(guildId),
  });
}
const {
  logReactionRoleChange,
  logLevelRoleChanges,
  logConfigChange,
} = require("../logs/auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");

const MAX_OPTIONS_PER_PANEL = 20;
/** How long admins have to send an emoji after option add/remove. */
const PENDING_EMOJI_TTL_MS = 5 * 60 * 1000;

/** Never ping @everyone / @here / roles / users from panel text or embeds. */
const NO_PING_MENTIONS = { parse: [] };

// guildId:userId → pending option add/remove session (in-memory)
// session.action: "add" | "remove"
const pendingOptionEmoji = new Map();

function pendingOptionKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function setPendingOptionEmoji(guildId, userId, session) {
  pendingOptionEmoji.set(pendingOptionKey(guildId, userId), {
    ...session,
    expiresAt: Date.now() + PENDING_EMOJI_TTL_MS,
  });
}

/** @deprecated use setPendingOptionEmoji — kept for call-site clarity */
function setPendingOptionAdd(guildId, userId, session) {
  setPendingOptionEmoji(guildId, userId, { ...session, action: "add" });
}

function setPendingOptionRemove(guildId, userId, session) {
  setPendingOptionEmoji(guildId, userId, { ...session, action: "remove" });
}

function getPendingOptionEmoji(guildId, userId) {
  const k = pendingOptionKey(guildId, userId);
  const session = pendingOptionEmoji.get(k);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    pendingOptionEmoji.delete(k);
    return null;
  }
  return session;
}

/** Push expiry forward while the admin is still actively retrying. */
function touchPendingOptionEmoji(guildId, userId) {
  const k = pendingOptionKey(guildId, userId);
  const session = pendingOptionEmoji.get(k);
  if (!session) return;
  session.expiresAt = Date.now() + PENDING_EMOJI_TTL_MS;
  pendingOptionEmoji.set(k, session);
}

function clearPendingOptionEmoji(guildId, userId) {
  pendingOptionEmoji.delete(pendingOptionKey(guildId, userId));
}

// Aliases used by older call sites
const getPendingOptionAdd = getPendingOptionEmoji;
const clearPendingOptionAdd = clearPendingOptionEmoji;
const touchPendingOptionAdd = touchPendingOptionEmoji;

function hasPendingOptionEmoji(guildId, userId) {
  return !!getPendingOptionEmoji(guildId, userId);
}

// Custom emoji: <:name:id> or <a:name:id>
const CUSTOM_EMOJI_RE = /^<(a)?:([a-zA-Z0-9_]+):(\d+)>$/;
// Discord snowflake-ish id alone
const SNOWFLAKE_RE = /^\d{17,20}$/;

/**
 * Discord has no slash-command emoji picker — admins type/paste a string.
 * Accept a small set of common shortcodes (with or without :colons:) so
 * inputs like `+1` / `:+1:` / `:thumbsup:` become real unicode reactions.
 */
const EMOJI_SHORTCODES = {
  "+1": "👍",
  "-1": "👎",
  thumbsup: "👍",
  thumbsdown: "👎",
  thumbup: "👍",
  thumbdown: "👎",
  heart: "❤️",
  hearts: "💕",
  fire: "🔥",
  star: "⭐",
  stars: "🌟",
  tada: "🎉",
  party: "🎉",
  eyes: "👀",
  smile: "😄",
  grinning: "😀",
  joy: "😂",
  rofl: "🤣",
  thinking: "🤔",
  wave: "👋",
  clap: "👏",
  ok: "👌",
  ok_hand: "👌",
  100: "💯",
  rocket: "🚀",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  x: "❌",
  cross: "❌",
  warning: "⚠️",
  skull: "💀",
  game: "🎮",
  video_game: "🎮",
  musical_note: "🎵",
  megaphone: "📣",
  bell: "🔔",
  lock: "🔒",
  unlock: "🔓",
  purple_heart: "💜",
  blue_heart: "💙",
  green_heart: "💚",
  yellow_heart: "💛",
  orange_heart: "🧡",
  black_heart: "🖤",
  pray: "🙏",
  muscle: "💪",
  brain: "🧠",
  trophy: "🏆",
  medal: "🏅",
  first_place: "🥇",
  second_place: "🥈",
  third_place: "🥉",
};

const EMOJI_INPUT_HELP =
  "Send a message that is **only** a unicode emoji (e.g. 👍) or a server custom emoji, " +
  "or a known shortcode (`+1`, `:fire:`).\n" +
  "Type **`stop`** to cancel.";

function logRoleError(action, err, { guildId, userId, roleId }) {
  console.error(
    `[reactionRoles] Failed to ${action} role ${roleId} for user ${userId} in guild ${guildId}: ${err?.message || err}`,
  );
  console.error(
    "[reactionRoles] Common cause: the bot's highest role is below the role it is trying to manage, or it lacks Manage Roles permission.",
  );
}

/**
 * Resolve `:shortcode:` or bare aliases like `+1` to unicode, or null.
 */
function resolveEmojiShortcode(raw) {
  let name = String(raw).trim();
  if (!name) return null;
  if (name.length >= 3 && name.startsWith(":") && name.endsWith(":")) {
    name = name.slice(1, -1);
  }
  if (!name) return null;
  // Prefer exact key (e.g. "+1"), then lowercase (thumbsup)
  if (Object.prototype.hasOwnProperty.call(EMOJI_SHORTCODES, name)) {
    return EMOJI_SHORTCODES[name];
  }
  const lower = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(EMOJI_SHORTCODES, lower)) {
    return EMOJI_SHORTCODES[lower];
  }
  return null;
}

/**
 * True if string is only ASCII word-ish chars (likely a failed shortcode / label, not an emoji).
 */
function looksLikePlainTextLabel(s) {
  // Allow only if entirely within common shortcode charset and no actual emoji codepoints
  return /^[a-zA-Z0-9_+\-:]+$/.test(s) && !/[^\u0000-\u007f]/.test(s);
}

/**
 * Parse admin emoji input into { key, display, reactIdent }.
 * - Unicode: key/display/react are the character(s)
 * - Custom: key is id, display is <:name:id>, reactIdent is id for message.react()
 * - Shortcodes: +1, :thumbsup: → unicode
 * Returns null if invalid.
 */
function parseEmojiInput(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const custom = s.match(CUSTOM_EMOJI_RE);
  if (custom) {
    const animated = !!custom[1];
    const name = custom[2];
    const id = custom[3];
    const display = animated ? `<a:${name}:${id}>` : `<:${name}:${id}>`;
    return { key: id, display, reactIdent: id, isCustom: true, name, animated };
  }

  // name:id shorthand (common paste form without brackets)
  const bare = s.match(/^([a-zA-Z0-9_]+):(\d{17,20})$/);
  if (bare) {
    const name = bare[1];
    const id = bare[2];
    const display = `<:${name}:${id}>`;
    return {
      key: id,
      display,
      reactIdent: id,
      isCustom: true,
      name,
      animated: false,
    };
  }

  if (SNOWFLAKE_RE.test(s)) {
    return {
      key: s,
      display: s,
      reactIdent: s,
      isCustom: true,
      name: null,
      animated: false,
    };
  }

  // Reject half-parsed markdown
  if (s.includes("<") || s.includes(">")) return null;

  // Shortcodes / aliases before treating as literal unicode
  const fromShort = resolveEmojiShortcode(s);
  if (fromShort) {
    return {
      key: fromShort,
      display: fromShort,
      reactIdent: fromShort,
      isCustom: false,
      name: null,
      animated: false,
    };
  }

  // Plain labels that aren't known shortcodes (e.g. "gamer", unknown ":foo:") → invalid
  if (looksLikePlainTextLabel(s)) {
    return null;
  }

  // Unicode / default emoji (may be multi-codepoint, e.g. ❤️ or 🏴󠁧󠁢󠁥󠁮󠁧󠁿)
  return {
    key: s,
    display: s,
    reactIdent: s,
    isCustom: false,
    name: null,
    animated: false,
  };
}

/**
 * Stable key from a Discord.js MessageReaction / reaction emoji.
 */
function emojiKeyFromReaction(reaction) {
  const emoji = reaction?.emoji;
  if (!emoji) return null;
  if (emoji.id) return String(emoji.id);
  // Unicode: prefer name (discord.js sets this for unicode)
  if (emoji.name) return emoji.name;
  return null;
}

/**
 * Normalize unicode emoji keys for comparison (strip VS16, etc.).
 * Custom emoji snowflake IDs are left unchanged.
 */
function normalizeEmojiKey(key) {
  if (key == null) return "";
  const s = String(key);
  if (/^\d{17,20}$/.test(s)) return s;
  // Variation selector-16 (emoji presentation), zero-width joiner kept for ZWJ sequences
  return s.replace(/\uFE0F/g, "");
}

/**
 * Resolve a panel option for a reaction key, with unicode normalization fallback.
 */
function resolveReactionRoleOption(guildId, messageId, emojiKey) {
  if (!emojiKey) return null;
  const direct = getReactionRoleOption(guildId, messageId, emojiKey);
  if (direct) return direct;

  const norm = normalizeEmojiKey(emojiKey);
  if (norm && norm !== emojiKey) {
    const byNorm = getReactionRoleOption(guildId, messageId, norm);
    if (byNorm) return byNorm;
  }

  const options = listReactionRoleOptions(guildId, messageId);
  for (const opt of options) {
    if (normalizeEmojiKey(opt.emoji_key) === norm) return opt;
    if (opt.emoji_display && normalizeEmojiKey(opt.emoji_display) === norm)
      return opt;
  }
  return null;
}

/**
 * Build the panel embed from DB panel + options.
 */
function buildPanelEmbed(panel, options) {
  const lines = [];
  if (options?.length) {
    for (const opt of options) {
      const lvl = Number(opt.min_level) || 0;
      const removable = Number(opt.removable) !== 0;
      const bits = [
        `${opt.emoji_display} → <@&${opt.role_id}> — Level ${lvl}+`,
      ];
      if (!removable) bits.push("· permanent");
      lines.push(bits.join(" "));
    }
  } else {
    lines.push(
      "_No roles configured yet. An admin can add options with `/reactionrole option add`._",
    );
  }

  const descParts = [];
  if (panel.description) descParts.push(panel.description);
  descParts.push("");
  descParts.push(lines.join("\n"));

  const embed = new EmbedBuilder()
    .setTitle(panel.title || "Reaction Roles")
    .setDescription(descParts.join("\n").slice(0, 4096))
    .setFooter({
      text: "React to claim · remove reaction to drop (where allowed)",
    })
    .setColor(Color.brand);

  return embed;
}

/**
 * Fetch the Discord message for a panel, if still present.
 */
async function fetchPanelMessage(guild, panel) {
  if (!guild || !panel) return null;
  const channel = await guild.channels
    .fetch(panel.channel_id)
    .catch(() => null);
  if (!channel || typeof channel.messages?.fetch !== "function") return null;
  return channel.messages.fetch(panel.message_id).catch(() => null);
}

/**
 * Copy a panel (title, description, options) into a new message in destChannel.
 * Source panel is left unchanged.
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} sourceMessageId
 * @param {import('discord.js').GuildTextBasedChannel} destChannel
 * @returns {Promise<{ ok: boolean, error?: string, message?: import('discord.js').Message, panel?: object, optionCount?: number }>}
 */
async function deployPanelToChannel(guild, sourceMessageId, destChannel) {
  if (!guild || !sourceMessageId || !destChannel) {
    return {
      ok: false,
      error: "Missing guild, source message ID, or destination channel.",
    };
  }

  const guildId = guild.id;
  const communityId = communityIdFor(guildId);
  const source = getReactionRolePanel(communityId, sourceMessageId);
  if (!source) {
    return {
      ok: false,
      error: `No reaction-role panel with message ID \`${sourceMessageId}\`.`,
    };
  }

  if (
    typeof destChannel.isTextBased === "function" &&
    !destChannel.isTextBased()
  ) {
    return { ok: false, error: "That channel cannot receive messages." };
  }
  if (typeof destChannel.send !== "function") {
    return { ok: false, error: "That channel cannot receive messages." };
  }

  const options = listReactionRoleOptions(communityId, sourceMessageId);
  const embed = buildPanelEmbed(source, options);

  let msg;
  try {
    msg = await destChannel.send({
      embeds: [embed],
      allowedMentions: NO_PING_MENTIONS,
    });
  } catch (err) {
    return { ok: false, error: `Could not post panel: ${err?.message || err}` };
  }

  try {
    createReactionRolePanel(
      communityId,
      destChannel.id,
      msg.id,
      source.title,
      source.description,
    );

    for (const opt of options) {
      upsertReactionRoleOption(
        communityId,
        msg.id,
        opt.emoji_key,
        opt.emoji_display,
        opt.role_id,
        opt.min_level,
        Number(opt.removable) !== 0,
      );
    }
  } catch (err) {
    // Best-effort cleanup of the orphan Discord message
    try {
      await msg.delete();
    } catch {
      // ignore
    }
    return {
      ok: false,
      error: `Posted message but failed to save config: ${err?.message || err}`,
    };
  }

  const newPanel = getReactionRolePanel(communityId, msg.id);
  const refresh = await refreshPanelMessage(guild, newPanel);
  if (!refresh.ok) {
    return {
      ok: true,
      message: msg,
      panel: newPanel,
      optionCount: options.length,
      error: `Deployed, but finishing reactions/embed failed: ${refresh.error}`,
    };
  }

  return {
    ok: true,
    message: msg,
    panel: newPanel,
    optionCount: options.length,
  };
}

/**
 * Rewrite embed and ensure bot reactions match configured options.
 * @returns {{ ok: boolean, error?: string }}
 */
async function refreshPanelMessage(guild, panel) {
  if (!panel) return { ok: false, error: "Panel not found." };

  const options = listReactionRoleOptions(panel.guild_id, panel.message_id);
  const message = await fetchPanelMessage(guild, panel);
  if (!message) {
    return {
      ok: false,
      error:
        "Panel message is missing (deleted?). Remove the panel with `/reactionrole panel delete` or re-create it.",
    };
  }

  const embed = buildPanelEmbed(panel, options);
  try {
    // Embeds list roles as <@&id> for display only — suppress notifications
    await message.edit({
      embeds: [embed],
      content: null,
      allowedMentions: NO_PING_MENTIONS,
    });
  } catch (err) {
    return {
      ok: false,
      error: `Could not edit panel message: ${err?.message || err}`,
    };
  }

  // Ensure configured reactions are present
  const wantedKeys = new Set(options.map((o) => o.emoji_key));
  for (const opt of options) {
    const parsed =
      parseEmojiInput(opt.emoji_display) || parseEmojiInput(opt.emoji_key);
    const reactIdent = parsed?.reactIdent || opt.emoji_key;
    try {
      const existing = message.reactions.cache.find((r) => {
        const k = emojiKeyFromReaction(r);
        return k === opt.emoji_key;
      });
      if (!existing || !existing.me) {
        await message.react(reactIdent);
      }
    } catch (err) {
      console.error(
        `[reactionRoles] Failed to react with ${opt.emoji_display} on ${panel.message_id}:`,
        err?.message || err,
      );
    }
  }

  // Remove reactions that are no longer configured (everyone, not just the bot).
  // Requires Manage Messages. Falls back to removing only the bot's reaction.
  try {
    // Prefer a fresh reaction list when possible
    if (typeof message.reactions?.fetch === "function") {
      try {
        await message.reactions.fetch();
      } catch {
        // cache-only path
      }
    }

    const wantedNorm = new Set([...wantedKeys].map(normalizeEmojiKey));
    for (const reaction of message.reactions.cache.values()) {
      const key = emojiKeyFromReaction(reaction);
      if (!key) continue;
      if (wantedKeys.has(key) || wantedNorm.has(normalizeEmojiKey(key)))
        continue;

      try {
        // Wipe this emoji from the message entirely
        await reaction.remove();
      } catch (err) {
        // Fallback: at least drop the bot's own reaction
        if (reaction.me && guild.client?.user?.id) {
          await reaction.users.remove(guild.client.user.id).catch(() => null);
        }
        console.warn(
          `[reactionRoles] Could not remove unconfigured reaction ${key} on ${panel.message_id}:`,
          err?.message || err,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[reactionRoles] Cleanup of stale reactions failed:`,
      err?.message || err,
    );
  }

  return { ok: true };
}

/**
 * Remove one user's reaction. Requires Manage Messages (or the user themselves).
 */
async function removeUserReaction(reaction, userId) {
  if (!reaction || !userId) return false;
  try {
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        // continue with best effort
      }
    }
    await reaction.users.remove(userId);
    return true;
  } catch (err) {
    console.warn(
      `[reactionRoles] Could not remove reaction for ${userId}:`,
      err?.message || err,
      "(bot needs Manage Messages on the panel channel)",
    );
    return false;
  }
}

/**
 * Remove an unconfigured emoji from a panel message entirely.
 * Prefer wiping the reaction (all users); fall back to removing just this user.
 */
async function stripExtraneousReaction(reaction, userId) {
  if (!reaction) return false;

  try {
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        /* ignore */
      }
    }
    // Full wipe — correct for emojis that should never appear on the panel
    await reaction.remove();
    return true;
  } catch (err) {
    console.warn(
      `[reactionRoles] reaction.remove() failed (need Manage Messages?):`,
      err?.message || err,
    );
  }

  return removeUserReaction(reaction, userId);
}

async function tryDmUser(user, content) {
  try {
    await user.send(content);
  } catch {
    // DMs closed / blocked — ignore
  }
}

/**
 * Role mentions (<@&id>) do not resolve in DMs — use a plain name for user-facing DMs.
 * @param {import('discord.js').Guild} guild
 * @param {string} roleId
 * @returns {Promise<string>}
 */
async function roleNameForDm(guild, roleId) {
  if (!guild || !roleId) return "that role";
  let role = guild.roles.cache.get(roleId);
  if (!role) {
    role = await guild.roles.fetch(roleId).catch(() => null);
  }
  if (role?.name) return `**${role.name}**`;
  return `role \`${roleId}\``;
}

/**
 * After XP loss (e.g. decay): remove reaction-claim roles whose min level the member no longer meets.
 * Uses the lowest min_level among all panel options that grant each role.
 * Does not re-add roles or touch reactions on the panel message.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {number} level current level after XP change
 * @returns {Promise<{ removed: string[] }>} role IDs removed
 */
async function syncMemberReactionRoles(
  member,
  level,
  { client = null, logSource = null } = {},
) {
  const guildId = member.guild.id;
  const requirements = listReactionRoleLevelRequirements(
    communityIdFor(guildId),
  );
  if (!requirements.length) return { removed: [] };

  const lvl = Number(level) || 0;
  const removed = [];

  for (const row of requirements) {
    const roleId = row.role_id;
    const minLevel = Number(row.min_level) || 0;
    if (lvl >= minLevel) continue;
    if (!member.roles.cache.has(roleId)) continue;

    try {
      await member.roles.remove(roleId);
      removed.push(roleId);
      console.log(
        `[reactionRoles] Removed role ${roleId} from ${member.id} in ${guildId} ` +
          `(level ${lvl} < min ${minLevel} after XP change)`,
      );
    } catch (err) {
      logRoleError("remove", err, { guildId, userId: member.id, roleId });
    }
  }

  // Staff audit log (batched per user)
  if (removed.length && logSource) {
    const c = client || member.client;
    if (c) {
      await logLevelRoleChanges(
        c,
        member,
        { granted: [], removed },
        lvl,
        logSource,
      ).catch(() => {});
    }
  }

  return { removed };
}

/**
 * Resolve guild for a reaction (partials / uncached message).
 */
function guildFromReaction(reaction) {
  if (reaction?.message?.guild) return reaction.message.guild;
  const gid = reaction?.message?.guildId;
  if (gid && reaction.client?.guilds?.cache) {
    return reaction.client.guilds.cache.get(gid) || null;
  }
  return null;
}

/**
 * Handle MessageReactionAdd for reaction-role panels.
 * @returns {Promise<{ handled: boolean }>} handled=true means skip reaction XP
 */
async function handleReactionRoleAdd(reaction, user) {
  if (user?.bot) return { handled: false };

  // Ensure message is as complete as possible for panel lookup
  if (reaction?.message?.partial) {
    try {
      await reaction.message.fetch();
    } catch {
      /* ignore */
    }
  }

  const guild = guildFromReaction(reaction);
  if (!guild || !reaction?.message?.id) return { handled: false };

  const guildId = guild.id;
  const communityId = communityIdFor(guildId);
  const messageId = reaction.message.id;

  if (!isReactionRolePanel(communityId, messageId)) {
    return { handled: false };
  }

  const emojiKey = emojiKeyFromReaction(reaction);
  if (!emojiKey) {
    await stripExtraneousReaction(reaction, user.id);
    return { handled: true };
  }

  const option = resolveReactionRoleOption(communityId, messageId, emojiKey);
  if (!option) {
    // Unconfigured reaction on a managed panel → strip entirely
    await stripExtraneousReaction(reaction, user.id);
    return { handled: true };
  }

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    await removeUserReaction(reaction, user.id);
    return { handled: true };
  }

  const settings = getGuildSettings(communityId);
  const xp = getXp(communityId, user.id);
  const level = levelFromXp(xp, settings.level_xp_factor);
  const minLevel = Number(option.min_level) || 0;

  if (level < minLevel) {
    await removeUserReaction(reaction, user.id);
    const roleLabel = await roleNameForDm(guild, option.role_id);
    await tryDmUser(
      user,
      `You need **Level ${minLevel}** to claim ${roleLabel} in **${guild.name}**. ` +
        `(You are currently Level ${level}.)`,
    );
    return { handled: true };
  }

  if (!member.roles.cache.has(option.role_id)) {
    try {
      await member.roles.add(option.role_id);
      const panel = getReactionRolePanel(communityId, messageId);
      await logReactionRoleChange(reaction.client, {
        member,
        user,
        roleId: option.role_id,
        emoji: option.emoji_display || emojiKey,
        action: "add",
        panelMessageId: messageId,
        panelChannelId: panel?.channel_id || reaction.message.channelId,
        minLevel,
        removable: option.removable,
      }).catch(() => {});
    } catch (err) {
      logRoleError("add", err, {
        guildId,
        userId: user.id,
        roleId: option.role_id,
      });
      await removeUserReaction(reaction, user.id);
      await tryDmUser(
        user,
        `I couldn't assign that role in **${guild.name}**. Staff may need to fix the bot's role permissions.`,
      );
    }
  }

  return { handled: true };
}

/**
 * Handle MessageReactionRemove for reaction-role panels.
 * @returns {Promise<{ handled: boolean }>}
 */
async function handleReactionRoleRemove(reaction, user) {
  if (user?.bot) return { handled: false };

  if (reaction?.message?.partial) {
    try {
      await reaction.message.fetch();
    } catch {
      /* ignore */
    }
  }

  const guild = guildFromReaction(reaction);
  if (!guild || !reaction?.message?.id) return { handled: false };

  const guildId = guild.id;
  const communityId = communityIdFor(guildId);
  const messageId = reaction.message.id;

  if (!isReactionRolePanel(communityId, messageId)) {
    return { handled: false };
  }

  const emojiKey = emojiKeyFromReaction(reaction);
  if (!emojiKey) return { handled: true };

  const option = resolveReactionRoleOption(communityId, messageId, emojiKey);
  if (!option) return { handled: true };

  // Only strip role when removable is set
  if (Number(option.removable) === 0) {
    return { handled: true };
  }

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return { handled: true };

  if (member.roles.cache.has(option.role_id)) {
    try {
      await member.roles.remove(option.role_id);
      const panel = getReactionRolePanel(communityId, messageId);
      await logReactionRoleChange(reaction.client, {
        member,
        user,
        roleId: option.role_id,
        emoji: option.emoji_display || emojiKey,
        action: "remove",
        panelMessageId: messageId,
        panelChannelId: panel?.channel_id || reaction.message.channelId,
        minLevel: option.min_level,
        removable: option.removable,
      }).catch(() => {});
    } catch (err) {
      logRoleError("remove", err, {
        guildId,
        userId: user.id,
        roleId: option.role_id,
      });
    }
  }

  return { handled: true };
}

// ---------------------------------------------------------------------------
// Fluxer (PR 9): OutboundClient-shaped entries (roadmap/fluxer.md § Outbound
// client). These mirror the Discord handlers above against a NormalizedReaction
// (normalizeFluxerReaction output) and the Fluxer wire. The Discord functions
// are untouched. Services return {ok:false, error}; they never reply to the
// platform and never invent REST surfaces (reactions: addReaction /
// removeUserReaction / removeEmojiReaction — spec 406; the elevated role legs
// go through addRole/removeRole and self-gate on K8 `elevated_permissions=0`).
// ---------------------------------------------------------------------------

/**
 * Resolve (create-on-sight) the integer community id for a Fluxer
 * NormalizedReaction. The pipeline resolves it first; direct callers may not.
 * @param {object} normalizedReaction
 * @returns {number|null}
 */
function resolveFluxerReactionCommunity(normalizedReaction) {
  if (Number.isSafeInteger(normalizedReaction?.communityId)) {
    return normalizedReaction.communityId;
  }
  if (normalizedReaction?.externalGuildId == null) return null;
  try {
    const id = ensureCommunity({
      platform: "fluxer",
      instanceKey: normalizedReaction.instanceKey ?? "fluxer",
      externalGuildId: String(normalizedReaction.externalGuildId),
    });
    normalizedReaction.communityId = id;
    return id;
  } catch (err) {
    console.error(
      `[reactionRoles] Fluxer community resolve failed (message ${
        normalizedReaction?.messageId ?? "?"
      }): ${err?.message || err}`,
    );
    return null;
  }
}

/**
 * Strip one user's reaction from a panel (Fluxer twin of stripExtraneousReaction
 * → removeUserReaction per the PR 9 bundle: user-scoped, reactions are never
 * elevated). Mirrors the Discord warning shape on failure.
 * @returns {Promise<boolean>} true when the DELETE was accepted
 */
async function stripExtraneousReactionFluxer(
  outbound,
  { channelId, messageId, emojiKey, userId },
) {
  if (!outbound || !messageId || !emojiKey) return false;
  try {
    const res = await outbound.removeUserReaction(
      channelId,
      messageId,
      emojiKey,
      userId,
    );
    if (!res.ok) {
      console.warn(
        `[reactionRoles] Could not remove reaction ${emojiKey} for ${userId} on ${messageId}:`,
        res.error,
        "(bot needs Manage Messages on the panel channel)",
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(
      `[reactionRoles] Could not remove reaction ${emojiKey} for ${userId} on ${messageId}:`,
      err?.message || err,
      "(bot needs Manage Messages on the panel channel)",
    );
    return false;
  }
}

/**
 * Role label for Fluxer DM copy (Fluxer twin of roleNameForDm — role mentions
 * do not resolve in DMs, so the plain name goes into the text).
 * @returns {Promise<string>}
 */
async function roleNameForDmFluxer(outbound, communityId, roleId) {
  if (!roleId) return "that role";
  try {
    const roles = await outbound.fetchRoles(communityId);
    const role = roles.find((r) => String(r.id) === String(roleId));
    if (role?.name) return `**${role.name}**`;
  } catch {
    // fall through to the id form (fetchRoles already logged the cause)
  }
  return `role \`${roleId}\``;
}

/** Best-effort Fluxer DM (mirrors tryDmUser: DMs closed/blocked are ignored). */
async function tryDmFluxer(outbound, userId, content) {
  try {
    await outbound.sendDm(userId, { content });
  } catch {
    // DMs closed / blocked — ignore (same policy as the Discord twin)
  }
}

/**
 * Plain JSON embed for a Fluxer send site (no EmbedBuilder on the wire —
 * strip the class at the send site with toJSON(), PR 9 bundle).
 * @param {object} embed EmbedBuilder instance or plain NormalizedEmbed
 * @returns {object}
 */
function toPlainEmbed(embed) {
  return embed && typeof embed.toJSON === "function" ? embed.toJSON() : embed;
}

/**
 * Deploy a panel to a Fluxer channel: post the embed through sendChannel,
 * persist panel + options, then seed each option reaction with addReaction
 * (spec 406: panels use addReaction instead of message.react — NOT elevated,
 * so this ships at flag 0). Partial success is reported, not swallowed:
 * `failed` collects one entry per option whose reaction PUT failed.
 *
 * @param {object} outbound OutboundClient (Fluxer)
 * @param {number} communityId INTEGER communities.id
 * @param {string} channelId
 * @param {{ embedPayload: object, options: Array<{ emoji_key: string, emoji_display?: string, role_id: string, min_level?: number, removable?: number|boolean }> }} args
 * @returns {Promise<{ ok: boolean, messageId?: string, failed?: Array<{ emojiKey: string|null, error: string }>, error?: string }>}
 */
async function deployPanelFluxer(
  outbound,
  communityId,
  channelId,
  { embedPayload, options } = {},
) {
  if (!outbound) {
    return { ok: false, error: "deployPanelFluxer: outbound OutboundClient required." };
  }
  if (channelId == null || String(channelId) === "") {
    return { ok: false, error: "deployPanelFluxer: a channel id is required." };
  }
  if (!embedPayload) {
    return {
      ok: false,
      error: "deployPanelFluxer: an embedPayload is required (build it with buildPanelEmbed(...).toJSON()).",
    };
  }

  const ch = String(channelId);
  const optList = Array.isArray(options) ? options : [];

  let sent;
  try {
    // Same no-ping policy as the Discord deploy (role names render as mentions
    // in the embed text — never ping).
    sent = await outbound.sendChannel(ch, {
      embeds: [toPlainEmbed(embedPayload)],
      allowedMentions: NO_PING_MENTIONS,
    });
  } catch (err) {
    sent = { ok: false, error: String(err?.message || err) };
  }
  if (!sent.ok) {
    return { ok: false, error: `Could not post panel: ${sent.error}` };
  }
  const messageId = sent.id;

  // Persist panel + options (repos are community-keyed; mirrors the Discord
  // deployPanelToChannel write set).
  try {
    createReactionRolePanel(
      communityId,
      ch,
      messageId,
      embedPayload.title || "Reaction Roles",
      embedPayload.description ?? null,
    );
    for (const opt of optList) {
      upsertReactionRoleOption(
        communityId,
        messageId,
        opt.emoji_key,
        opt.emoji_display ?? opt.emoji_key,
        opt.role_id,
        opt.min_level ?? 0,
        Number(opt.removable ?? 1) !== 0,
      );
    }
  } catch (err) {
    // No deleteMessage on OutboundClient (PR 9 scope): name the orphan.
    console.error(
      `[reactionRoles] Posted panel message ${messageId} in community ${communityId} ` +
        `but failed to save config: ${err?.message || err} ` +
        `(message left in place — OutboundClient has no deleteMessage)`,
    );
    return {
      ok: false,
      error: `Posted message but failed to save config: ${err?.message || err}`,
    };
  }

  // Seed the option reactions. Reactions are not elevated (spec 406), so this
  // runs at flag 0 too. Per-option failures are collected (warnings pattern),
  // never a silent drop.
  const failed = [];
  for (const opt of optList) {
    const key = opt.emoji_key;
    if (!key) {
      failed.push({ emojiKey: null, error: "option has no emoji_key" });
      continue;
    }
    let res;
    try {
      res = await outbound.addReaction(ch, messageId, key);
    } catch (err) {
      res = { ok: false, error: String(err?.message || err) };
    }
    if (!res.ok) {
      console.error(
        `[reactionRoles] Failed to react with ${opt.emoji_display || key} on ${messageId}:`,
        res.error,
      );
      failed.push({ emojiKey: key, error: res.error });
    }
  }

  return { ok: true, messageId, failed };
}

/**
 * Fluxer twin of refreshPanelMessage: rewrite the embed text (editMessage) and
 * re-issue every configured option reaction (addReaction is idempotent, so
 * "ensure present" needs no reaction-list diff — there is no reaction-list
 * surface on OutboundClient, spec 375–397).
 *
 * Where the Discord flow needs a single-message fetch (panel presence, reaction
 * enumeration) OutboundClient exposes only fetchMessages (history pages) — no
 * fetchMessage. Those legs are DEGRADED with named log lines; the presence
 * probe scans one history page with fetchMessages and never treats a scan miss
 * as "deleted" (the panel may simply predate the page).
 *
 * @param {object} outbound OutboundClient (Fluxer)
 * @param {number} communityId INTEGER communities.id
 * @param {object} panel panel row (message_id + channel_id required)
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function refreshPanelMessageFluxer(outbound, communityId, panel) {
  if (!panel) return { ok: false, error: "Panel not found." };
  const messageId = panel.message_id;
  const channelId = panel.channel_id;
  if (!messageId || !channelId) {
    return { ok: false, error: "Panel row is missing its channel/message id." };
  }

  const options = listReactionRoleOptions(communityId, messageId);

  // Presence: one history page (the only sanctioned surface). Inconclusive is
  // logged, never fatal — there is no single-message fetch to confirm.
  try {
    const page = await outbound.fetchMessages(String(channelId), { limit: 100 });
    if (!page.ok) {
      console.warn(
        `[reactionRoles] Panel ${messageId} presence check inconclusive: ${page.error}`,
      );
    } else if (!page.messages.some((m) => String(m.id) === String(messageId))) {
      console.log(
        `[reactionRoles] Panel ${messageId} presence check skipped: not in the first history page ` +
          `(OutboundClient has no single-message fetch — message may predate the page)`,
      );
    }
  } catch (err) {
    console.warn(
      `[reactionRoles] Panel ${messageId} presence check failed:`,
      err?.message || err,
    );
  }

  const warnings = [];

  // Embed text (Discord twin: message.edit → Fluxer: editMessage).
  const embed = toPlainEmbed(buildPanelEmbed(panel, options));
  let editRes;
  try {
    editRes = await outbound.editMessage(
      { communityId, channelId: String(channelId), messageId: String(messageId) },
      { embeds: [embed], allowedMentions: NO_PING_MENTIONS },
    );
  } catch (err) {
    editRes = { ok: false, error: String(err?.message || err) };
  }
  if (!editRes.ok) {
    warnings.push(`Could not edit panel message: ${editRes.error}`);
  }

  // Ensure configured reactions (idempotent PUT per option).
  for (const opt of options) {
    const parsed =
      parseEmojiInput(opt.emoji_display) || parseEmojiInput(opt.emoji_key);
    const reactIdent = parsed?.reactIdent || opt.emoji_key;
    let res;
    try {
      res = await outbound.addReaction(String(channelId), String(messageId), reactIdent);
    } catch (err) {
      res = { ok: false, error: String(err?.message || err) };
    }
    if (!res.ok) {
      console.error(
        `[reactionRoles] Failed to react with ${opt.emoji_display} on ${messageId}:`,
        res.error,
      );
      warnings.push(`Failed to react with ${opt.emoji_display}: ${res.error}`);
    }
  }

  // Stale-reaction cleanup would need to enumerate current reactions; no
  // reaction-list surface exists (spec lists per-emoji removes only).
  console.log(
    `[reactionRoles] Stale reaction cleanup skipped: OutboundClient has no ` +
      `reaction-list surface (community ${communityId}, message ${messageId})`,
  );

  return warnings.length
    ? { ok: false, error: warnings.join("; ") }
    : { ok: true };
}

/**
 * Handle a Fluxer MESSAGE_REACTION_ADD (NormalizedReaction) for reaction-role
 * panels. Mirrors handleReactionRoleAdd exactly: panel gate, option resolve,
 * unconfigured reactions stripped, min-level check against the member's XP,
 * role grant through outbound.addRole. On the configured-option path the panel's
 * option reaction is (re-)issued with addReaction first — reactions are NOT
 * elevated (spec 406) so they ship at flag 0; only the role leg gates.
 *
 * @param {object} outbound OutboundClient (Fluxer)
 * @param {object} normalizedReaction normalizeFluxerReaction output
 * @returns {Promise<{ handled: boolean, ok?: boolean, code?: string, error?: string }>}
 *   handled=true means the caller must skip reaction XP.
 */
async function handleReactionRoleAddFluxer(outbound, normalizedReaction) {
  if (!normalizedReaction) return { handled: false };
  if (normalizedReaction.userBot) return { handled: false };

  const communityId = resolveFluxerReactionCommunity(normalizedReaction);
  const messageId = normalizedReaction.messageId;
  if (communityId == null || !messageId) return { handled: false };

  if (!isReactionRolePanel(communityId, messageId)) {
    return { handled: false };
  }

  const channelId = normalizedReaction.channelId;
  const userId = normalizedReaction.userId;
  const emojiKey = normalizedReaction.emojiKey;
  if (!emojiKey) {
    // The normalizer drops payloads without an emoji; a reaction we cannot
    // name cannot be stripped — name the skip, keep the event consumed.
    console.warn(
      `[reactionRoles] Fluxer reaction on panel ${messageId} carries no emojiKey — cannot strip (message ${messageId})`,
    );
    return { handled: true };
  }

  const option = resolveReactionRoleOption(communityId, messageId, emojiKey);
  if (!option) {
    // Unconfigured reaction on a managed panel → strip the user's reaction.
    await stripExtraneousReactionFluxer(outbound, {
      channelId,
      messageId,
      emojiKey,
      userId,
    });
    return { handled: true };
  }

  // Panel option reaction (not elevated — spec 406). A failure is logged with
  // the specific cause and never aborts the role leg.
  let reactRes;
  try {
    reactRes = await outbound.addReaction(channelId, messageId, emojiKey);
  } catch (err) {
    reactRes = { ok: false, error: String(err?.message || err) };
  }
  if (!reactRes.ok) {
    console.error(
      `[reactionRoles] Failed to react with ${option.emoji_display || emojiKey} on ${messageId}:`,
      reactRes.error,
    );
  }

  const member = await outbound.fetchMember(communityId, userId);
  if (!member) {
    await stripExtraneousReactionFluxer(outbound, {
      channelId,
      messageId,
      emojiKey,
      userId,
    });
    return { handled: true };
  }

  const settings = getGuildSettings(communityId);
  const xp = getXp(communityId, userId);
  const level = levelFromXp(xp, settings.level_xp_factor);
  const minLevel = Number(option.min_level) || 0;

  if (level < minLevel) {
    await stripExtraneousReactionFluxer(outbound, {
      channelId,
      messageId,
      emojiKey,
      userId,
    });
    let guildName = `community ${communityId}`;
    try {
      const guild = await outbound.fetchGuild(communityId);
      if (guild?.name) guildName = guild.name;
    } catch {
      // keep the community-id label
    }
    const roleLabel = await roleNameForDmFluxer(outbound, communityId, option.role_id);
    await tryDmFluxer(
      outbound,
      userId,
      `You need **Level ${minLevel}** to claim ${roleLabel} in **${guildName}**. ` +
        `(You are currently Level ${level}.)`,
    );
    return { handled: true };
  }

  const hasRole =
    Array.isArray(member.roleIds) &&
    member.roleIds.map(String).includes(String(option.role_id));

  if (!hasRole) {
    let res;
    try {
      res = await outbound.addRole(communityId, userId, option.role_id);
    } catch (err) {
      res = { ok: false, error: String(err?.message || err) };
    }

    if (res.ok) {
      // Fluxer console audit (audit embeds are Discord-client-side).
      console.log(
        `[reactionRoles] Granted role ${option.role_id} to ${userId} in community ${communityId} ` +
          `(panel ${messageId}, emoji ${option.emoji_display || emojiKey}, min level ${minLevel}, ` +
          `removable ${Number(option.removable) ? "yes" : "no"})`,
      );
      return { handled: true, ok: true };
    }

    if (res.code === "elevated_disabled") {
      // K8 gate: ONE informative line; the user's reaction STAYS (flag 0 keeps
      // the panel claim, the grant resumes when elevated_permissions flips to 1).
      console.log(
        `[reactionRoles] role grant deferred: elevated_permissions=0 ` +
          `(community ${communityId}, user ${userId})`,
      );
      return { handled: true, ok: false, code: "elevated_disabled", error: res.error };
    }

    // HTTP/permission failure — mirror the Discord catch exactly: log the
    // specific cause, strip the user's reaction, DM the cause.
    logRoleError("add", res, {
      guildId: normalizedReaction.externalGuildId ?? communityId,
      userId,
      roleId: option.role_id,
    });
    await stripExtraneousReactionFluxer(outbound, {
      channelId,
      messageId,
      emojiKey,
      userId,
    });
    let guildName = `community ${communityId}`;
    try {
      const guild = await outbound.fetchGuild(communityId);
      if (guild?.name) guildName = guild.name;
    } catch {
      // keep the community-id label
    }
    await tryDmFluxer(
      outbound,
      userId,
      `I couldn't assign that role in **${guildName}**. Staff may need to fix the bot's role permissions.`,
    );
    return { handled: true, ok: false, error: res.error };
  }

  return { handled: true, ok: true };
}

/**
 * Handle a Fluxer MESSAGE_REACTION_REMOVE (un-react) for reaction-role panels.
 * Mirrors handleReactionRoleRemove: panel gate, option resolve, role dropped
 * only when the option is removable, then the user's reaction is stripped from
 * the panel (reactions are never elevated — the K8 gate skips ONLY the role leg).
 *
 * @param {object} outbound OutboundClient (Fluxer)
 * @param {object} normalizedReaction normalizeFluxerReaction output
 * @returns {Promise<{ handled: boolean, ok?: boolean, code?: string, error?: string }>}
 */
async function handleReactionRoleRemoveFluxer(outbound, normalizedReaction) {
  if (!normalizedReaction) return { handled: false };
  if (normalizedReaction.userBot) return { handled: false };

  const communityId = resolveFluxerReactionCommunity(normalizedReaction);
  const messageId = normalizedReaction.messageId;
  if (communityId == null || !messageId) return { handled: false };

  if (!isReactionRolePanel(communityId, messageId)) {
    return { handled: false };
  }

  const channelId = normalizedReaction.channelId;
  const userId = normalizedReaction.userId;
  const emojiKey = normalizedReaction.emojiKey;
  if (!emojiKey) return { handled: true };

  const option = resolveReactionRoleOption(communityId, messageId, emojiKey);
  if (!option) return { handled: true };

  // Only strip the role when removable is set (Discord parity).
  if (Number(option.removable) === 0) {
    return { handled: true };
  }

  const member = await outbound.fetchMember(communityId, userId);
  if (!member) return { handled: true };

  const hasRole =
    Array.isArray(member.roleIds) &&
    member.roleIds.map(String).includes(String(option.role_id));

  let roleRes = { ok: true };
  if (hasRole) {
    try {
      roleRes = await outbound.removeRole(communityId, userId, option.role_id);
    } catch (err) {
      roleRes = { ok: false, error: String(err?.message || err) };
    }

    if (roleRes.ok) {
      // Fluxer console audit (audit embeds are Discord-client-side).
      console.log(
        `[reactionRoles] Removed role ${option.role_id} from ${userId} in community ${communityId} ` +
          `(panel ${messageId}, emoji ${option.emoji_display || emojiKey})`,
      );
    } else if (roleRes.code === "elevated_disabled") {
      console.log(
        `[reactionRoles] role removal deferred: elevated_permissions=0 ` +
          `(community ${communityId}, user ${userId})`,
      );
    } else {
      logRoleError("remove", roleRes, {
        guildId: normalizedReaction.externalGuildId ?? communityId,
        userId,
        roleId: option.role_id,
      });
    }
  }

  // Un-react cleanup: the user's reaction comes off the panel. Reactions are
  // not elevated, so this runs at flag 0 too.
  await stripExtraneousReactionFluxer(outbound, {
    channelId,
    messageId,
    emojiKey,
    userId,
  });

  if (!roleRes.ok) {
    return {
      handled: true,
      ok: false,
      ...(roleRes.code != null ? { code: roleRes.code } : {}),
      error: roleRes.error,
    };
  }
  return { handled: true, ok: true };
}

/**
 * Validate that an emoji is usable by the bot in this guild.
 * Returns an error string, or null if OK.
 */
function validateEmojiForGuild(guild, parsed) {
  if (!parsed) {
    return `That doesn't look like an emoji.\n${EMOJI_INPUT_HELP}`;
  }
  if (!parsed.isCustom) return null;

  // Prefer guild emoji cache
  const emoji = guild.emojis.cache.get(parsed.key);
  if (!emoji) {
    return (
      "That custom emoji is not available in this server (or the bot can't access it).\n" +
      "Use an emoji from **this** server, or a unicode emoji.\n" +
      EMOJI_INPUT_HELP
    );
  }
  return null;
}

/**
 * Enrich custom emoji display from guild cache when possible.
 */
function enrichParsedEmojiDisplay(guild, parsed) {
  if (!parsed?.isCustom) return parsed;
  const ge = guild.emojis.cache.get(parsed.key);
  if (ge) {
    parsed.display = ge.animated
      ? `<a:${ge.name}:${ge.id}>`
      : `<:${ge.name}:${ge.id}>`;
  }
  return parsed;
}

/**
 * Persist an option and refresh the panel embed + bot reactions.
 * @returns {Promise<{ ok: boolean, error?: string, display?: string }>}
 */
async function applyReactionRoleOption(
  guild,
  { messageId, parsed, roleId, level, removable },
) {
  const guildId = guild.id;
  const communityId = communityIdFor(guildId);
  const panel = getReactionRolePanel(communityId, messageId);
  if (!panel) {
    return {
      ok: false,
      error: `No reaction-role panel with message ID \`${messageId}\`.`,
    };
  }

  enrichParsedEmojiDisplay(guild, parsed);

  const existingOpts = listReactionRoleOptions(communityId, messageId);
  const already = existingOpts.some((o) => o.emoji_key === parsed.key);
  if (!already && existingOpts.length >= MAX_OPTIONS_PER_PANEL) {
    return {
      ok: false,
      error: `This panel already has ${MAX_OPTIONS_PER_PANEL} options (Discord reaction limit). Remove one first.`,
    };
  }

  upsertReactionRoleOption(
    communityId,
    messageId,
    parsed.key,
    parsed.display,
    roleId,
    level,
    removable,
  );

  const updated = getReactionRolePanel(communityId, messageId);
  const result = await refreshPanelMessage(guild, updated);
  if (!result.ok) {
    return {
      ok: false,
      error: `Saved option, but panel refresh failed: ${result.error}`,
      display: parsed.display,
    };
  }
  return { ok: true, display: parsed.display };
}

/**
 * Remove an option by emoji and refresh the panel.
 * @returns {Promise<{ ok: boolean, error?: string, display?: string, hardFail?: boolean }>}
 */
async function removeReactionRoleOptionByEmoji(guild, { messageId, parsed }) {
  const guildId = guild.id;
  const communityId = communityIdFor(guildId);
  const panel = getReactionRolePanel(communityId, messageId);
  if (!panel) {
    return {
      ok: false,
      hardFail: true,
      error: `No reaction-role panel with message ID \`${messageId}\`.`,
    };
  }

  enrichParsedEmojiDisplay(guild, parsed);

  const removed = deleteReactionRoleOption(communityId, messageId, parsed.key);
  if (!removed) {
    return {
      ok: false,
      hardFail: false,
      error: `No option for ${parsed.display} on panel \`${messageId}\`.`,
      display: parsed.display,
    };
  }

  const updated = getReactionRolePanel(communityId, messageId);
  const result = await refreshPanelMessage(guild, updated);
  if (!result.ok) {
    return {
      ok: false,
      hardFail: false,
      error: `Removed option from DB, but panel refresh failed: ${result.error}`,
      display: parsed.display,
    };
  }
  return { ok: true, display: parsed.display };
}

async function deleteAdminEmojiMessage(message) {
  try {
    if (message.deletable) await message.delete();
  } catch (err) {
    console.warn(
      `[reactionRoles] Could not delete emoji config message:`,
      err?.message || err,
    );
  }
}

async function sendChannelConfirm(channel, content) {
  try {
    if (channel && typeof channel.send === "function") {
      await channel.send({ content, allowedMentions: NO_PING_MENTIONS });
    }
  } catch {
    // ignore
  }
}

/**
 * Handle MessageCreate while an admin is awaiting an emoji for option add or remove.
 * @returns {Promise<{ handled: boolean }>} handled=true → skip XP / honeypot path for this message
 */
async function handlePendingOptionEmojiMessage(message) {
  if (!message.guild || message.author?.bot) return { handled: false };

  const guildId = message.guild.id;
  const userId = message.author.id;
  const session = getPendingOptionEmoji(guildId, userId);
  if (!session) return { handled: false };

  const action = session.action === "remove" ? "remove" : "add";
  const content = (message.content || "").trim();

  // Cancel
  if (content.toLowerCase() === "stop") {
    clearPendingOptionEmoji(guildId, userId);
    try {
      await message.reply({
        content: "Cancelled — no longer waiting for an emoji.",
        allowedMentions: NO_PING_MENTIONS,
      });
    } catch {
      // ignore
    }
    return { handled: true };
  }

  const parsed = parseEmojiInput(content);
  // Add requires usable guild emoji; remove only needs a parseable emoji key
  const emojiErr =
    action === "add"
      ? validateEmojiForGuild(message.guild, parsed)
      : parsed
        ? null
        : `That doesn't look like an emoji.\n${EMOJI_INPUT_HELP}`;

  if (emojiErr) {
    touchPendingOptionEmoji(guildId, userId);
    const waitingFor =
      action === "add"
        ? `for <@&${session.roleId}> on panel \`${session.messageId}\``
        : `to remove from panel \`${session.messageId}\``;
    try {
      await message.reply({
        content: `${emojiErr}\n\n_Still waiting for an emoji ${waitingFor}. Send an emoji, or type \`stop\` to cancel._`,
        allowedMentions: NO_PING_MENTIONS,
      });
    } catch {
      // ignore
    }
    return { handled: true };
  }

  if (action === "remove") {
    const removed = await removeReactionRoleOptionByEmoji(message.guild, {
      messageId: session.messageId,
      parsed,
    });

    if (!removed.ok) {
      if (removed.hardFail) {
        clearPendingOptionEmoji(guildId, userId);
      } else {
        touchPendingOptionEmoji(guildId, userId);
      }
      try {
        await message.reply({
          content: removed.hardFail
            ? `${removed.error}\n_No longer waiting for an emoji._`
            : `${removed.error}\n\n_Still waiting — try another emoji, or type \`stop\` to cancel._`,
          allowedMentions: NO_PING_MENTIONS,
        });
      } catch {
        // ignore
      }
      return { handled: true };
    }

    clearPendingOptionEmoji(guildId, userId);
    const channel = message.channel;
    await deleteAdminEmojiMessage(message);
    await sendChannelConfirm(
      channel,
      `Removed ${removed.display} from panel \`${session.messageId}\`.`,
    );
    // Emoji-confirmation flow: human actor, bot transport → origin 'slash'.
    recordSlashAudit({
      guildId,
      actorUserId: userId,
      action: "reaction_roles.option_remove",
      targetType: "reaction_role_panel",
      targetId: session.messageId,
      details: { emoji: removed.display },
    });
    await logConfigChange(message.client, guildId, {
      title: "Reaction-role option removed",
      command: "/reactionrole option remove",
      actor: message.author,
      changes: [`Panel: \`${session.messageId}\``, `Emoji: ${removed.display}`],
    }).catch(() => {});
    return { handled: true };
  }

  // action === "add"
  const applied = await applyReactionRoleOption(message.guild, {
    messageId: session.messageId,
    parsed,
    roleId: session.roleId,
    level: session.level,
    removable: session.removable,
  });

  if (!applied.ok) {
    const hardFail =
      applied.error?.includes("No reaction-role panel") ||
      applied.error?.includes("already has");
    if (hardFail) {
      clearPendingOptionEmoji(guildId, userId);
    } else {
      touchPendingOptionEmoji(guildId, userId);
    }
    try {
      await message.reply({
        content: hardFail
          ? `${applied.error}\n_No longer waiting for an emoji._`
          : `${applied.error}\n\n_Still waiting — try another emoji, or type \`stop\` to cancel._`,
        allowedMentions: NO_PING_MENTIONS,
      });
    } catch {
      // ignore
    }
    return { handled: true };
  }

  clearPendingOptionEmoji(guildId, userId);

  const remText = session.removable ? "removable" : "permanent (not removable)";
  const channel = message.channel;
  await deleteAdminEmojiMessage(message);
  await sendChannelConfirm(
    channel,
    `Configured ${applied.display} → <@&${session.roleId}> ` +
      `(Level ${session.level}+, ${remText}) on panel \`${session.messageId}\`.`,
  );
  recordSlashAudit({
    guildId,
    actorUserId: userId,
    action: "reaction_roles.option_add",
    targetType: "reaction_role_panel",
    targetId: session.messageId,
    details: {
      role_id: session.roleId,
      emoji: applied.display,
      min_level: session.level,
      removable: session.removable ? 1 : 0,
    },
  });
  await logConfigChange(message.client, guildId, {
    title: "Reaction-role option added",
    command: "/reactionrole option add",
    actor: message.author,
    changes: [
      `Panel: \`${session.messageId}\``,
      `Emoji: ${applied.display}`,
      `Role: <@&${session.roleId}> (\`${session.roleId}\`)`,
      `Min level: **${session.level}**`,
      `Removable: **${session.removable ? "yes" : "no"}**`,
    ],
  }).catch(() => {});

  return { handled: true };
}

/** @deprecated alias */
const handlePendingOptionAddMessage = handlePendingOptionEmojiMessage;

module.exports = {
  MAX_OPTIONS_PER_PANEL,
  PENDING_EMOJI_TTL_MS,
  NO_PING_MENTIONS,
  EMOJI_INPUT_HELP,
  parseEmojiInput,
  resolveEmojiShortcode,
  emojiKeyFromReaction,
  normalizeEmojiKey,
  resolveReactionRoleOption,
  buildPanelEmbed,
  fetchPanelMessage,
  deployPanelToChannel,
  refreshPanelMessage,
  handleReactionRoleAdd,
  handleReactionRoleRemove,
  deployPanelFluxer,
  refreshPanelMessageFluxer,
  handleReactionRoleAddFluxer,
  handleReactionRoleRemoveFluxer,
  stripExtraneousReactionFluxer,
  syncMemberReactionRoles,
  stripExtraneousReaction,
  validateEmojiForGuild,
  setPendingOptionEmoji,
  setPendingOptionAdd,
  setPendingOptionRemove,
  getPendingOptionEmoji,
  getPendingOptionAdd,
  clearPendingOptionEmoji,
  clearPendingOptionAdd,
  hasPendingOptionEmoji,
  applyReactionRoleOption,
  removeReactionRoleOptionByEmoji,
  handlePendingOptionEmojiMessage,
  handlePendingOptionAddMessage,
};
