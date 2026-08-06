// src/auditLog.js
// Staff-facing audit log + message log embeds for configured guild channels.

const { EmbedBuilder, AuditLogEvent } = require("discord.js");
const { getGuildSettings } = require("../../db");

// Embed colors
const COLOR_DELETE = 0xe74c3c; // red
const COLOR_BULK_DELETE = 0xc0392b; // darker red
const COLOR_BAN = 0x8b0000; // dark red
const COLOR_HONEYPOT = 0x922b21; // deep red — honeypot-specific bans
const COLOR_KICK = 0xe67e22; // orange
const COLOR_ROLE_ADD = 0x2ecc71; // green
const COLOR_ROLE_REMOVE = 0x95a5a6; // grey
const COLOR_ROLE_MIXED = 0x3498db; // blue
const COLOR_CONFIG = 0x9b59b6; // purple — admin reconfiguration

const CONTENT_TRUNCATE = 1500;
const FIELD_TRUNCATE = 1024;
const BULK_SAMPLE_LIMIT = 15;

// ---------- Message content cache (for verbose deletes) ----------
const MESSAGE_CACHE_MAX = 5000;
const MESSAGE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** @type {Map<string, { content: string, authorId: string, authorTag: string, channelId: string, attachments: { name: string, url: string }[], embedsSummary: string, createdTimestamp: number, cachedAt: number }>} */
const messageCache = new Map();

function cacheMessage(message) {
  if (!message?.id || !message.guild) return;
  if (message.author?.bot) return;

  const attachments = [];
  if (message.attachments?.size) {
    for (const att of message.attachments.values()) {
      attachments.push({ name: att.name || "file", url: att.url || att.proxyURL || "" });
    }
  }

  let embedsSummary = "";
  if (message.embeds?.length) {
    embedsSummary = message.embeds
      .slice(0, 5)
      .map((e, i) => {
        const title = e.title ? truncate(String(e.title), 80) : "(no title)";
        const desc = e.description ? truncate(String(e.description), 120) : "";
        return `${i + 1}. ${title}${desc ? ` — ${desc}` : ""}`;
      })
      .join("\n");
  }

  messageCache.set(message.id, {
    content: message.content || "",
    authorId: message.author?.id || "unknown",
    authorTag: message.author?.tag || message.author?.username || "unknown",
    channelId: message.channel?.id || message.channelId || "unknown",
    attachments,
    embedsSummary,
    createdTimestamp: message.createdTimestamp || Date.now(),
    cachedAt: Date.now(),
  });

  // Bound memory: drop oldest when over cap
  if (messageCache.size > MESSAGE_CACHE_MAX) {
    const overflow = messageCache.size - MESSAGE_CACHE_MAX;
    let n = 0;
    for (const key of messageCache.keys()) {
      messageCache.delete(key);
      n++;
      if (n >= overflow) break;
    }
  }
}

function getCachedMessage(messageId) {
  const entry = messageCache.get(messageId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > MESSAGE_CACHE_TTL_MS) {
    messageCache.delete(messageId);
    return null;
  }
  return entry;
}

function takeCachedMessage(messageId) {
  const entry = getCachedMessage(messageId);
  if (entry) messageCache.delete(messageId);
  return entry;
}

// Periodic sweep so TTL is enforced without waiting for get
setInterval(() => {
  const cutoff = Date.now() - MESSAGE_CACHE_TTL_MS;
  for (const [id, entry] of messageCache.entries()) {
    if (entry.cachedAt < cutoff) messageCache.delete(id);
  }
}, 10 * 60 * 1000).unref?.();

// ---------- Helpers ----------

function truncate(str, max) {
  if (str == null) return "";
  const s = String(str);
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

function userLabel(user) {
  if (!user) return "Unknown";
  const tag = user.tag || user.username || "Unknown";
  return user.id ? `${tag} (\`${user.id}\`)` : tag;
}

function memberLabel(member) {
  if (!member) return "Unknown";
  const u = member.user || member;
  return userLabel(u);
}

/**
 * Resolve the Discord channel for a log stream.
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {"audit"|"message"|"warn"} kind
 * @returns {Promise<object|null>}
 */
async function resolveLogChannel(client, guildId, kind) {
  const settings = getGuildSettings(guildId);
  let channelId = null;
  if (kind === "message") {
    channelId = settings.message_log_channel_id;
  } else if (kind === "warn") {
    // Dedicated warn channel when set; otherwise fall back to general audit log.
    channelId = settings.warn_log_channel_id || settings.audit_log_channel_id;
  } else {
    channelId = settings.audit_log_channel_id;
  }
  if (!channelId) return null;

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return null;
    if (typeof channel.isTextBased === "function" && !channel.isTextBased()) return null;
    if (typeof channel.send !== "function") return null;
    return channel;
  } catch {
    return null;
  }
}

async function sendToLogChannel(client, guildId, kind, payload) {
  const channel = await resolveLogChannel(client, guildId, kind);
  if (!channel) return false;

  try {
    await channel.send(payload);
    return true;
  } catch (err) {
    console.warn(
      `[auditLog] Failed to send ${kind} log in guild ${guildId}:`,
      err?.message || err
    );
    return false;
  }
}

async function sendAuditLog(client, guildId, payload) {
  return sendToLogChannel(client, guildId, "audit", payload);
}

async function sendMessageLog(client, guildId, payload) {
  return sendToLogChannel(client, guildId, "message", payload);
}

async function sendWarnLog(client, guildId, payload) {
  return sendToLogChannel(client, guildId, "warn", payload);
}

/**
 * Wait briefly then fetch a recent audit log entry matching target user + action.
 * @returns {Promise<import('discord.js').GuildAuditLogsEntry|null>}
 */
async function fetchRecentAuditEntry(guild, action, targetId, { maxAgeMs = 5000, delayMs = 400 } = {}) {
  if (!guild || !targetId) return null;

  const tryFetch = async () => {
    try {
      const logs = await guild.fetchAuditLogs({ type: action, limit: 6 });
      const now = Date.now();
      for (const entry of logs.entries.values()) {
        if (entry.target?.id !== targetId && entry.targetId !== targetId) continue;
        const created = entry.createdTimestamp || 0;
        if (maxAgeMs > 0 && now - created > maxAgeMs) continue;
        return entry;
      }
    } catch {
      // Missing View Audit Log or other failure
    }
    return null;
  };

  if (delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
  let entry = await tryFetch();
  if (!entry && delayMs > 0) {
    await new Promise((r) => setTimeout(r, 400));
    entry = await tryFetch();
  }
  return entry;
}

// ---------- Embed builders ----------

function buildMessageDeleteEmbed({
  messageId,
  channelId,
  authorId,
  authorTag,
  content,
  attachments,
  embedsSummary,
  createdTimestamp,
  executor,
}) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_DELETE)
    .setTitle("Message deleted")
    .setTimestamp(new Date());

  const authorText =
    authorId && authorId !== "unknown"
      ? `${authorTag || "Unknown"} (\`${authorId}\`)`
      : authorTag || "Unknown (uncached)";

  embed.addFields(
    { name: "Author", value: authorText, inline: true },
    {
      name: "Channel",
      value: channelId && channelId !== "unknown" ? `<#${channelId}> (\`${channelId}\`)` : "Unknown",
      inline: true,
    },
    { name: "Message ID", value: `\`${messageId || "unknown"}\``, inline: true }
  );

  if (executor) {
    embed.addFields({ name: "Deleted by", value: userLabel(executor), inline: true });
  }

  if (createdTimestamp) {
    embed.addFields({
      name: "Originally sent",
      value: `<t:${Math.floor(createdTimestamp / 1000)}:F> (<t:${Math.floor(createdTimestamp / 1000)}:R>)`,
      inline: false,
    });
  }

  const body = content?.trim() ? truncate(content, CONTENT_TRUNCATE) : "*No text content*";
  embed.addFields({ name: "Content", value: body.slice(0, FIELD_TRUNCATE) });

  if (attachments?.length) {
    const attText = attachments
      .map((a) => (a.url ? `[${a.name}](${a.url})` : a.name))
      .join("\n");
    embed.addFields({ name: "Attachments", value: truncate(attText, FIELD_TRUNCATE) });
  }

  if (embedsSummary) {
    embed.addFields({ name: "Embeds", value: truncate(embedsSummary, FIELD_TRUNCATE) });
  }

  return embed;
}

function buildMessageBulkDeleteEmbed(channel, samples, count) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_BULK_DELETE)
    .setTitle("Messages bulk-deleted")
    .setTimestamp(new Date())
    .addFields(
      {
        name: "Channel",
        value: channel?.id ? `<#${channel.id}> (\`${channel.id}\`)` : "Unknown",
        inline: true,
      },
      { name: "Count", value: String(count), inline: true }
    );

  if (samples?.length) {
    const lines = samples.map((s) => {
      const who = s.authorTag || s.authorId || "?";
      const snippet = s.content?.trim()
        ? truncate(s.content.replace(/\n/g, " "), 80)
        : "(no text)";
      return `• **${who}**: ${snippet}`;
    });
    embed.addFields({
      name: `Sample (up to ${BULK_SAMPLE_LIMIT})`,
      value: truncate(lines.join("\n"), FIELD_TRUNCATE),
    });
  } else {
    embed.addFields({
      name: "Sample",
      value: "*No cached message content available*",
    });
  }

  return embed;
}

function buildBanEmbed({ user, executor, reason, viaBot }) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_BAN)
    .setTitle("Member banned")
    .setTimestamp(new Date())
    .addFields(
      { name: "User", value: userLabel(user), inline: true },
      {
        name: "Banned by",
        value: executor ? userLabel(executor) : "Unknown",
        inline: true,
      }
    );

  if (viaBot) {
    embed.addFields({ name: "Source", value: "Bot (this application)", inline: true });
  }

  embed.addFields({
    name: "Reason",
    value: truncate(reason || "*No reason provided*", FIELD_TRUNCATE),
  });

  if (user?.displayAvatarURL) {
    try {
      embed.setThumbnail(user.displayAvatarURL({ size: 128 }));
    } catch {
      // ignore
    }
  }

  return embed;
}

/**
 * Rich embed for honeypot enforcement (channel post or ban-role grant).
 * @param {object} opts
 * @param {import('discord.js').User} opts.user
 * @param {"channel"|"ban_role"} opts.trigger
 * @param {string} [opts.channelId]
 * @param {string[]} [opts.roleIds]
 * @param {string} [opts.reason]
 * @param {boolean} [opts.banned]
 * @param {boolean|null} [opts.dmSent] true/false when known; null/undefined = not reported
 * @param {string} [opts.error] ban failure message
 */
function buildHoneypotEmbed({
  user,
  trigger,
  channelId,
  roleIds,
  reason,
  banned,
  dmSent,
  error,
}) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_HONEYPOT)
    .setTitle(banned ? "Honeypot ban" : "Honeypot ban failed")
    .setTimestamp(new Date())
    .addFields(
      { name: "User", value: userLabel(user), inline: true },
      {
        name: "Trigger",
        value:
          trigger === "ban_role"
            ? "Ban role granted"
            : trigger === "channel"
              ? "Posted in honeypot channel"
              : truncate(String(trigger || "Unknown"), 64),
        inline: true,
      },
      {
        name: "Ban",
        value: banned ? "Succeeded" : "Failed",
        inline: true,
      }
    );

  if (trigger === "channel" || channelId) {
    embed.addFields({
      name: "Channel",
      value: channelId ? `<#${channelId}> (\`${channelId}\`)` : "Unknown",
      inline: true,
    });
  }

  if (trigger === "ban_role" || (roleIds && roleIds.length)) {
    const roles =
      roleIds?.length
        ? roleIds.map((id) => `<@&${id}> (\`${id}\`)`).join("\n")
        : "Unknown";
    embed.addFields({
      name: "Ban role(s)",
      value: truncate(roles, FIELD_TRUNCATE),
      inline: true,
    });
  }

  if (dmSent === true || dmSent === false) {
    embed.addFields({
      name: "DM",
      value: dmSent ? "Sent" : "Failed / closed",
      inline: true,
    });
  }

  embed.addFields({
    name: "Reason",
    value: truncate(reason || "*No reason provided*", FIELD_TRUNCATE),
  });

  if (error && !banned) {
    embed.addFields({
      name: "Error",
      value: truncate(String(error), FIELD_TRUNCATE),
    });
  }

  if (user?.displayAvatarURL) {
    try {
      embed.setThumbnail(user.displayAvatarURL({ size: 128 }));
    } catch {
      // ignore
    }
  }

  return embed;
}

function buildKickEmbed({ user, executor, reason }) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_KICK)
    .setTitle("Member kicked")
    .setTimestamp(new Date())
    .addFields(
      { name: "User", value: userLabel(user), inline: true },
      {
        name: "Kicked by",
        value: executor ? userLabel(executor) : "Unknown",
        inline: true,
      },
      {
        name: "Reason",
        value: truncate(reason || "*No reason provided*", FIELD_TRUNCATE),
      }
    );

  if (user?.displayAvatarURL) {
    try {
      embed.setThumbnail(user.displayAvatarURL({ size: 128 }));
    } catch {
      // ignore
    }
  }

  return embed;
}

function buildReactionRoleEmbed({
  member,
  user,
  roleId,
  emoji,
  action, // "add" | "remove"
  panelMessageId,
  panelChannelId,
  minLevel,
  removable,
}) {
  const isAdd = action === "add";
  const embed = new EmbedBuilder()
    .setColor(isAdd ? COLOR_ROLE_ADD : COLOR_ROLE_REMOVE)
    .setTitle(isAdd ? "Reaction role granted" : "Reaction role removed")
    .setTimestamp(new Date());

  const who = member ? memberLabel(member) : userLabel(user);
  embed.addFields(
    { name: "Member", value: who, inline: true },
    { name: "Role", value: roleId ? `<@&${roleId}> (\`${roleId}\`)` : "Unknown", inline: true },
    { name: "Emoji", value: emoji ? String(emoji) : "—", inline: true }
  );

  if (panelMessageId) {
    let panelValue = `\`${panelMessageId}\``;
    const guildId = member?.guild?.id;
    if (guildId && panelChannelId) {
      panelValue = `[Jump to panel](https://discord.com/channels/${guildId}/${panelChannelId}/${panelMessageId})`;
    }
    embed.addFields({ name: "Panel", value: panelValue, inline: true });
  }

  if (minLevel != null) {
    embed.addFields({ name: "Min level", value: String(minLevel), inline: true });
  }
  if (removable != null) {
    embed.addFields({
      name: "Removable",
      value: Number(removable) ? "Yes" : "No",
      inline: true,
    });
  }

  return embed;
}

const SOURCE_LABELS = {
  xp_sync: "XP / level sync",
  decay: "XP decay (level→role)",
  decay_reaction_role: "XP decay (reaction role min level)",
};

function buildLevelRoleChangeEmbed({ member, granted = [], removed = [], level, source }) {
  const hasGrant = granted.length > 0;
  const hasRemove = removed.length > 0;
  let color = COLOR_ROLE_MIXED;
  let title = "Level roles updated";
  if (hasGrant && !hasRemove) {
    color = COLOR_ROLE_ADD;
    title = "Level role granted";
  } else if (hasRemove && !hasGrant) {
    color = COLOR_ROLE_REMOVE;
    title = "Level role removed";
  }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setTimestamp(new Date())
    .addFields(
      { name: "Member", value: memberLabel(member), inline: true },
      { name: "Level", value: String(level ?? "?"), inline: true },
      {
        name: "Source",
        value: SOURCE_LABELS[source] || source || "unknown",
        inline: true,
      }
    );

  if (hasGrant) {
    embed.addFields({
      name: "Granted",
      value: truncate(granted.map((id) => `<@&${id}> (\`${id}\`)`).join("\n"), FIELD_TRUNCATE),
    });
  }
  if (hasRemove) {
    embed.addFields({
      name: "Removed",
      value: truncate(removed.map((id) => `<@&${id}> (\`${id}\`)`).join("\n"), FIELD_TRUNCATE),
    });
  }

  return embed;
}

// ---------- High-level log helpers ----------

async function logMessageDelete(client, message) {
  if (!message?.guild) return;

  const cached = takeCachedMessage(message.id) || getCachedMessage(message.id);

  const authorId = message.author?.id || cached?.authorId || "unknown";
  const authorTag =
    message.author?.tag ||
    message.author?.username ||
    cached?.authorTag ||
    "unknown";
  const channelId = message.channel?.id || message.channelId || cached?.channelId || "unknown";
  const content = message.content || cached?.content || "";
  const createdTimestamp = message.createdTimestamp || cached?.createdTimestamp || null;

  let attachments = [];
  if (message.attachments?.size) {
    for (const att of message.attachments.values()) {
      attachments.push({ name: att.name || "file", url: att.url || att.proxyURL || "" });
    }
  } else if (cached?.attachments?.length) {
    attachments = cached.attachments;
  }

  let embedsSummary = "";
  if (message.embeds?.length) {
    embedsSummary = message.embeds
      .slice(0, 5)
      .map((e, i) => {
        const title = e.title ? truncate(String(e.title), 80) : "(no title)";
        const desc = e.description ? truncate(String(e.description), 120) : "";
        return `${i + 1}. ${title}${desc ? ` — ${desc}` : ""}`;
      })
      .join("\n");
  } else if (cached?.embedsSummary) {
    embedsSummary = cached.embedsSummary;
  }

  // Best-effort: who deleted the message
  let executor = null;
  try {
    const entry = await fetchRecentAuditEntry(
      message.guild,
      AuditLogEvent.MessageDelete,
      authorId,
      { maxAgeMs: 8000, delayMs: 350 }
    );
    // MessageDelete audit target is the author; extra.channel may match
    if (entry) {
      const chMatch =
        !entry.extra?.channel?.id ||
        entry.extra.channel.id === channelId ||
        String(entry.extra?.channelId || "") === channelId;
      if (chMatch) executor = entry.executor || null;
    }
  } catch {
    // ignore
  }

  const embed = buildMessageDeleteEmbed({
    messageId: message.id,
    channelId,
    authorId,
    authorTag,
    content,
    attachments,
    embedsSummary,
    createdTimestamp,
    executor,
  });

  await sendMessageLog(client, message.guild.id, { embeds: [embed] });
}

async function logMessageBulkDelete(client, messages, channel) {
  const guild = channel?.guild || messages?.first?.()?.guild || messages?.at?.(0)?.guild;
  if (!guild) return;

  const count = messages?.size ?? messages?.length ?? 0;
  const samples = [];

  const list = messages?.values
    ? [...messages.values()]
    : Array.isArray(messages)
      ? messages
      : [];

  for (const msg of list) {
    if (samples.length >= BULK_SAMPLE_LIMIT) break;
    const cached = takeCachedMessage(msg.id) || getCachedMessage(msg.id);
    samples.push({
      authorId: msg.author?.id || cached?.authorId,
      authorTag: msg.author?.tag || msg.author?.username || cached?.authorTag,
      content: msg.content || cached?.content || "",
    });
  }

  // Also sample pure cache entries for this channel if collection was empty of content
  if (samples.length < BULK_SAMPLE_LIMIT) {
    // nothing more without channel-indexed cache
  }

  const embed = buildMessageBulkDeleteEmbed(channel, samples, count);
  await sendMessageLog(client, guild.id, { embeds: [embed] });
}

async function logBan(client, ban) {
  const guild = ban.guild;
  if (!guild) return;

  const user = ban.user;
  let executor = null;
  let reason = ban.reason || null;
  let viaBot = false;

  const entry = await fetchRecentAuditEntry(guild, AuditLogEvent.MemberBanAdd, user.id, {
    maxAgeMs: 10000,
    delayMs: 400,
  });
  if (entry) {
    executor = entry.executor || null;
    if (entry.reason) reason = entry.reason;
  }

  if (executor?.id && client.user?.id && executor.id === client.user.id) {
    viaBot = true;
  }
  if (reason && /honeypot/i.test(reason)) {
    viaBot = true;
  }

  // Honeypot bans are logged with richer context via logHoneypotTrigger
  // (channel / ban-role, DM status, success/failure). Skip the generic ban embed.
  if (
    reason &&
    /honeypot/i.test(reason) &&
    viaBot &&
    (!executor || executor.id === client.user?.id)
  ) {
    return;
  }

  const embed = buildBanEmbed({ user, executor, reason, viaBot });
  await sendAuditLog(client, guild.id, { embeds: [embed] });
}

/**
 * Staff audit log for a honeypot enforcement action.
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild} guild
 * @param {object} opts See buildHoneypotEmbed
 */
async function logHoneypotTrigger(client, guild, opts) {
  if (!client || !guild?.id) return;
  const embed = buildHoneypotEmbed(opts || {});
  await sendAuditLog(client, guild.id, { embeds: [embed] });
}

async function logKickIfApplicable(client, member) {
  const guild = member?.guild;
  if (!guild) return;

  const entry = await fetchRecentAuditEntry(guild, AuditLogEvent.MemberKick, member.id, {
    maxAgeMs: 5000,
    delayMs: 400,
  });
  if (!entry) return; // voluntary leave or unknown

  const embed = buildKickEmbed({
    user: member.user || member,
    executor: entry.executor || null,
    reason: entry.reason || null,
  });
  await sendAuditLog(client, guild.id, { embeds: [embed] });
}

async function logReactionRoleChange(client, opts) {
  const guildId = opts.member?.guild?.id || opts.guildId;
  if (!guildId || !client) return;

  const embed = buildReactionRoleEmbed(opts);
  await sendAuditLog(client, guildId, { embeds: [embed] });
}

async function logLevelRoleChanges(client, member, { granted = [], removed = [] }, level, source) {
  if (!member?.guild || !client) return;
  if (!granted.length && !removed.length) return;

  const embed = buildLevelRoleChangeEmbed({
    member,
    granted,
    removed,
    level,
    source,
  });
  await sendAuditLog(client, member.guild.id, { embeds: [embed] });
}

/**
 * Format a config value for display in audit embeds.
 */
function formatConfigValue(v) {
  if (v === null || v === undefined) return "*none*";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
  return String(v);
}

/**
 * Build before → after lines for a settings patch.
 * @param {object} before
 * @param {object} after
 * @param {string[]} keys
 * @param {(key: string, value: any) => string} [formatKey]
 */
function diffConfigLines(before, after, keys, formatKey) {
  const lines = [];
  for (const k of keys) {
    const from = before?.[k];
    const to = after?.[k];
    if (from === to) continue;
    const label = formatKey ? formatKey(k, to) : `\`${k}\``;
    lines.push(`${label}: ${formatConfigValue(from)} → **${formatConfigValue(to)}**`);
  }
  return lines;
}

/**
 * Staff audit embed for admin reconfiguration of bot features.
 * @param {object} opts
 * @param {string} opts.title Short title (e.g. "XP settings updated")
 * @param {string} [opts.command] Slash command path (e.g. "/setxp")
 * @param {import('discord.js').User} [opts.actor]
 * @param {string[]|string} [opts.changes] Bullet lines or a single block of text
 * @param {string} [opts.details] Extra freeform details
 */
function buildConfigChangeEmbed({ title, command, actor, changes, details }) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_CONFIG)
    .setTitle(title || "Configuration updated")
    .setTimestamp(new Date());

  if (actor) {
    embed.addFields({ name: "Changed by", value: userLabel(actor), inline: true });
  }
  if (command) {
    embed.addFields({ name: "Command", value: `\`${command}\``, inline: true });
  }

  let changeText = "";
  if (Array.isArray(changes)) {
    changeText = changes.filter(Boolean).map((l) => (l.startsWith("•") || l.startsWith("-") ? l : `• ${l}`)).join("\n");
  } else if (changes) {
    changeText = String(changes);
  }

  if (changeText) {
    embed.addFields({
      name: "Changes",
      value: truncate(changeText, FIELD_TRUNCATE) || "—",
    });
  }
  if (details) {
    embed.addFields({
      name: "Details",
      value: truncate(String(details), FIELD_TRUNCATE),
    });
  }

  return embed;
}

/**
 * Post a config-change audit embed.
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {object} opts Same as buildConfigChangeEmbed
 */
async function logConfigChange(client, guildId, opts) {
  if (!client || !guildId) return;
  const embed = buildConfigChangeEmbed(opts);
  await sendAuditLog(client, guildId, { embeds: [embed] });
}

/**
 * Post a warning issue/void staff embed.
 * Prefers `warn_log_channel_id`; falls back to `audit_log_channel_id`.
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {object} opts Same as buildConfigChangeEmbed
 */
async function logWarnEvent(client, guildId, opts) {
  if (!client || !guildId) return;
  const embed = buildConfigChangeEmbed(opts);
  await sendWarnLog(client, guildId, { embeds: [embed] });
}

module.exports = {
  cacheMessage,
  getCachedMessage,
  takeCachedMessage,
  sendAuditLog,
  sendMessageLog,
  sendWarnLog,
  fetchRecentAuditEntry,
  buildMessageDeleteEmbed,
  buildMessageBulkDeleteEmbed,
  buildBanEmbed,
  buildHoneypotEmbed,
  buildKickEmbed,
  buildReactionRoleEmbed,
  buildLevelRoleChangeEmbed,
  buildConfigChangeEmbed,
  formatConfigValue,
  diffConfigLines,
  logMessageDelete,
  logMessageBulkDelete,
  logBan,
  logHoneypotTrigger,
  logKickIfApplicable,
  logReactionRoleChange,
  logLevelRoleChanges,
  logConfigChange,
  logWarnEvent,
  AuditLogEvent,
  BULK_SAMPLE_LIMIT,
};
