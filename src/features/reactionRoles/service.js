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
const {
  logReactionRoleChange,
  logLevelRoleChanges,
  logConfigChange,
} = require("../logs/auditLog");

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
  const source = getReactionRolePanel(guildId, sourceMessageId);
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

  const options = listReactionRoleOptions(guildId, sourceMessageId);
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
      guildId,
      destChannel.id,
      msg.id,
      source.title,
      source.description,
    );

    for (const opt of options) {
      upsertReactionRoleOption(
        guildId,
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

  const newPanel = getReactionRolePanel(guildId, msg.id);
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
  const requirements = listReactionRoleLevelRequirements(guildId);
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
  const messageId = reaction.message.id;

  if (!isReactionRolePanel(guildId, messageId)) {
    return { handled: false };
  }

  const emojiKey = emojiKeyFromReaction(reaction);
  if (!emojiKey) {
    await stripExtraneousReaction(reaction, user.id);
    return { handled: true };
  }

  const option = resolveReactionRoleOption(guildId, messageId, emojiKey);
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

  const settings = getGuildSettings(guildId);
  const xp = getXp(guildId, user.id);
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
      const panel = getReactionRolePanel(guildId, messageId);
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
  const messageId = reaction.message.id;

  if (!isReactionRolePanel(guildId, messageId)) {
    return { handled: false };
  }

  const emojiKey = emojiKeyFromReaction(reaction);
  if (!emojiKey) return { handled: true };

  const option = resolveReactionRoleOption(guildId, messageId, emojiKey);
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
      const panel = getReactionRolePanel(guildId, messageId);
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
  const panel = getReactionRolePanel(guildId, messageId);
  if (!panel) {
    return {
      ok: false,
      error: `No reaction-role panel with message ID \`${messageId}\`.`,
    };
  }

  enrichParsedEmojiDisplay(guild, parsed);

  const existingOpts = listReactionRoleOptions(guildId, messageId);
  const already = existingOpts.some((o) => o.emoji_key === parsed.key);
  if (!already && existingOpts.length >= MAX_OPTIONS_PER_PANEL) {
    return {
      ok: false,
      error: `This panel already has ${MAX_OPTIONS_PER_PANEL} options (Discord reaction limit). Remove one first.`,
    };
  }

  upsertReactionRoleOption(
    guildId,
    messageId,
    parsed.key,
    parsed.display,
    roleId,
    level,
    removable,
  );

  const updated = getReactionRolePanel(guildId, messageId);
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
  const panel = getReactionRolePanel(guildId, messageId);
  if (!panel) {
    return {
      ok: false,
      hardFail: true,
      error: `No reaction-role panel with message ID \`${messageId}\`.`,
    };
  }

  enrichParsedEmojiDisplay(guild, parsed);

  const removed = deleteReactionRoleOption(guildId, messageId, parsed.key);
  if (!removed) {
    return {
      ok: false,
      hardFail: false,
      error: `No option for ${parsed.display} on panel \`${messageId}\`.`,
      display: parsed.display,
    };
  }

  const updated = getReactionRolePanel(guildId, messageId);
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
