// src/index.js
require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  MessageFlags,
  AttachmentBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
} = require("discord.js");

const {
  getGuildSettings,
  updateGuildSettings,

  addXp,
  getXp,
  topUsers,

  logActivity,

  addAllowedCommandChannel,
  removeAllowedCommandChannel,
  listAllowedCommandChannels,
  normalizeYoutubeName,
  getYoutubeChannels,
  addYoutubeChannel,
  removeYoutubeChannel,

  upsertLevelRole,
  deleteLevelRole,
  listLevelRoles,
  getRoleDropState,
  setRoleBelowSince,

  addHoneypotChannel,
  getHoneypotChannel,
  setHoneypotWarningMessage,
  removeHoneypotChannel,
  listHoneypotChannels,
  isHoneypotChannel,
  addHoneypotExemptRole,
  removeHoneypotExemptRole,
  listHoneypotExemptRoles,
  memberHasHoneypotExemptRole,
  addHoneypotBanRole,
  removeHoneypotBanRole,
  listHoneypotBanRoles,
  isHoneypotBanRole,
  findHoneypotBanRolesAmong,

  createReactionRolePanel,
  getReactionRolePanel,
  listReactionRolePanels,
  updateReactionRolePanelText,
  deleteReactionRolePanel,
  listReactionRoleOptions,
  countReactionRoleOptions,
} = require("./db");

const { renderLeaderboardPng } = require("./renderLeaderboard");
const { renderHoneypotWarningPng } = require("./renderHoneypotWarning");
const { levelFromXp } = require("./xp");
const { syncMemberRoles } = require("./roles");
const { startVoiceTicker } = require("./voiceTicker");
const { startDecayScheduler } = require("./decay");
const { startYoutubeTicker, createSimpleUploadEmbed, fetchChannelInfo, lookupChannelByName, isLiveVideo, isVideoUpload, extractVideoInfo, createLiveEmbed, createUploadEmbed, fetchYouTubeFeed } = require("./youtubeTicker");
const {
  MAX_OPTIONS_PER_PANEL,
  PENDING_EMOJI_TTL_MS,
  NO_PING_MENTIONS,
  buildPanelEmbed,
  refreshPanelMessage,
  deployPanelToChannel,
  handleReactionRoleAdd,
  handleReactionRoleRemove,
  setPendingOptionAdd,
  setPendingOptionRemove,
  clearPendingOptionEmoji,
  handlePendingOptionEmojiMessage,
} = require("./reactionRoles");
const {
  cacheMessage,
  logMessageDelete,
  logMessageBulkDelete,
  logBan,
  logKickIfApplicable,
  logLevelRoleChanges,
  logConfigChange,
  diffConfigLines,
} = require("./auditLog");

const MAX_XP_AWARD = 1_000_000_000;

// Cooldowns (in-memory)
const msgCooldown = new Map();      // key: guildId:userId => lastTs
const reactionCooldown = new Map(); // key: guildId:userId => lastTs

// In-flight honeypot bans to avoid double-processing rapid messages
const honeypotBanning = new Set(); // key: guildId:userId

function key(guildId, userId) {
  return `${guildId}:${userId}`;
}

/**
 * Post a human-facing honeypot warning (embed + modal-style image).
 * No plain-text content — simplistic bots that only scrape `content` see nothing useful.
 * Pins the message when possible and returns the sent Message.
 */
async function postHoneypotWarning(channel) {
  const png = renderHoneypotWarningPng();
  const file = new AttachmentBuilder(png, { name: "honeypot-warning.png" });

  // Image only — no content/embed text for scrapers to parse.
  // All human-facing copy is baked into the PNG.
  const msg = await channel.send({
    files: [file],
  });

  try {
    await msg.pin().catch(() => null);
  } catch {
    // Pin is best-effort (needs Manage Messages)
  }

  return msg;
}

/**
 * Ensure a honeypot channel has a bot warning message. Reuses existing one if still present.
 * Returns a short status string for the admin reply.
 */
async function ensureHoneypotWarning(guild, channelId) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || typeof channel.isTextBased !== "function" || !channel.isTextBased()) {
    return "Channel cannot receive messages — warning not posted.";
  }
  if (typeof channel.send !== "function") {
    return "Channel cannot receive messages — warning not posted.";
  }

  const existing = getHoneypotChannel(guild.id, channelId);
  if (existing?.warning_message_id) {
    const old = await channel.messages.fetch(existing.warning_message_id).catch(() => null);
    if (old) {
      return "Warning notice already present (left in place).";
    }
  }

  try {
    const msg = await postHoneypotWarning(channel);
    setHoneypotWarningMessage(guild.id, channelId, msg.id);
    return "Warning notice posted and pinned (image only — no plain text).";
  } catch (e) {
    console.error(`[honeypot] Failed to post warning in ${guild.id}/${channelId}:`, e?.message || e);
    return `Could not post warning notice: ${e?.message || e}`;
  }
}

/**
 * Shared honeypot ban: DM (optional copy) then guild ban.
 * Uses honeypotBanning to avoid double-processing.
 * @returns {Promise<boolean>} true if a ban was attempted (or already in flight)
 */
async function executeHoneypotBan(guild, user, {
  reason,
  dmText,
  deleteMessage = null,
} = {}) {
  if (!guild || !user?.id) return false;
  if (user.bot) return false;

  const banKey = key(guild.id, user.id);
  if (honeypotBanning.has(banKey)) return true;
  honeypotBanning.add(banKey);

  try {
    const guildName = guild.name;
    const shortReason = reason || "Honeypot trigger";

    // DM first — ban can prevent later contact via the guild
    try {
      await user.send(
        dmText ||
          `You have been **banned** from **${guildName}**.\n\n` +
            `**Reason:** ${shortReason}. ` +
            `If you believe this was a mistake, contact the server staff through another channel.`
      );
    } catch (e) {
      console.warn(
        `[honeypot] Could not DM ${user.id} in ${guild.id}:`,
        e?.message || e
      );
    }

    if (deleteMessage) {
      try {
        if (deleteMessage.deletable) await deleteMessage.delete();
      } catch (e) {
        console.warn(
          `[honeypot] Could not delete message in ${guild.id}:`,
          e?.message || e
        );
      }
    }

    try {
      await guild.members.ban(user.id, {
        reason: `Honeypot: ${shortReason}`,
        deleteMessageSeconds: 0,
      });
      console.log(
        `[honeypot] Banned ${user.tag || user.username} (${user.id}) in ${guildName} (${guild.id}): ${shortReason}`
      );
    } catch (e) {
      console.error(
        `[honeypot] Failed to ban ${user.id} in ${guild.id}:`,
        e?.message || e
      );
    }
  } finally {
    setTimeout(() => honeypotBanning.delete(banKey), 10_000);
  }

  return true;
}

/**
 * If the message is in a honeypot channel, ban the author (unless exempt).
 * Returns true when the message was handled as honeypot traffic (caller should not award XP).
 */
async function handleHoneypotMessage(message) {
  if (!isHoneypotChannel(message.guild.id, message.channel.id)) return false;

  let member = message.member;
  if (!member) {
    member = await message.guild.members.fetch(message.author.id).catch(() => null);
  }

  // Exempt roles (staff, etc.) — leave their message alone
  if (member) {
    const roleIds = [...member.roles.cache.keys()];
    if (memberHasHoneypotExemptRole(message.guild.id, roleIds)) {
      return true;
    }
  }

  await executeHoneypotBan(message.guild, message.author, {
    reason: "Posted in a honeypot channel",
    dmText:
      `You have been **banned** from **${message.guild.name}**.\n\n` +
      `**Reason:** You posted in a restricted channel that is used to catch spam accounts and raids. ` +
      `If you believe this was a mistake, contact the server staff through another channel.`,
    deleteMessage: message,
  });

  return true;
}

/**
 * If the member was granted a honeypot ban role, ban them (unless exempt).
 */
async function handleHoneypotBanRole(oldMember, newMember) {
  if (!newMember?.guild) return;
  if (newMember.user?.bot) return;

  const guildId = newMember.guild.id;
  const oldRoles = oldMember?.roles?.cache ?? new Map();
  const newRoles = newMember.roles?.cache ?? new Map();

  const addedRoleIds = [];
  for (const roleId of newRoles.keys()) {
    if (roleId === guildId) continue; // @everyone
    if (!oldRoles.has(roleId)) addedRoleIds.push(roleId);
  }
  if (!addedRoleIds.length) return;

  const matched = findHoneypotBanRolesAmong(guildId, addedRoleIds);
  if (!matched.length) return;

  const allRoleIds = [...newRoles.keys()];
  if (memberHasHoneypotExemptRole(guildId, allRoleIds)) {
    console.log(
      `[honeypot] Skip ban-role for exempt member ${newMember.id} in ${guildId} ` +
        `(roles: ${matched.join(", ")})`
    );
    return;
  }

  const roleMentions = matched.map((id) => `<@&${id}>`).join(", ");
  await executeHoneypotBan(newMember.guild, newMember.user, {
    reason: `Received honeypot ban role (${matched.join(", ")})`,
    dmText:
      `You have been **banned** from **${newMember.guild.name}**.\n\n` +
      `**Reason:** You were assigned a restricted role that is used to catch spam accounts and raids. ` +
      `If you believe this was a mistake, contact the server staff through another channel.`,
  });

  // Log which roles triggered (console; Discord audit log gets ban reason)
  console.log(
    `[honeypot] Ban-role trigger for ${newMember.id} in ${guildId}: ${roleMentions}`
  );
}

function isAdminOrMod(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

/**
 * Command channel restriction:
 * - If no allowed channels configured => allowed everywhere
 * - If configured => only allowed in those channels
 * - EXCEPTION: /setcommandchannel is allowed anywhere for admins to avoid lockout
 */
function commandsAllowed(interaction) {
  if (interaction.commandName === "setcommandchannel" && isAdminOrMod(interaction)) return true;
  const rows = listAllowedCommandChannels(interaction.guildId);
  if (!rows.length) return true;
  return rows.some(r => r.channel_id === interaction.channelId);
}

function validateXpValue(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) {
    return `${label} XP must be a finite non-negative number.`;
  }
  if (value > MAX_XP_AWARD) {
    return `XP value too large. Maximum value per ${label.toLowerCase()} is ${MAX_XP_AWARD.toLocaleString()}.`;
  }
  return null;
}

// ---------------- Cooldown cleanup ----------------
// Keep memory bounded for long-running bots. We sweep occasionally.
function sweepCooldownMap(map, maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  for (const [k, ts] of map.entries()) {
    if (ts < cutoff) map.delete(k);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildModeration, // bans
    GatewayIntentBits.GuildMembers, // kicks (privileged — enable Server Members Intent in portal)
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember],
});

async function registerCommandsOnAllGuilds(client) {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const clientId = process.env.CLIENT_ID;

  if (!clientId) {
    console.warn("CLIENT_ID not set, skipping command registration");
    return;
  }

  try {
    const guilds = await client.guilds.fetch();
    console.log(`Registering commands to ${guilds.size} guild(s)...`);

    let successCount = 0;
    let failCount = 0;

    for (const [, guild] of guilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(clientId, guild.id), {
          body: require("./register-commands").commands,
        });
        console.log(`✓ Registered to ${guild.name}`);
        successCount++;
      } catch (err) {
        console.error(`✗ Failed to register to ${guild.name}:`, err?.message || err);
        failCount++;
      }
    }

    console.log(`Command registration complete: ${successCount} succeeded, ${failCount} failed`);
  } catch (err) {
    console.error("Error fetching guilds for command registration:", err?.message || err);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`HeisenXP-Bot logged in as ${client.user.tag}`);

  // Uncomment this to update commands
  // await registerCommandsOnAllGuilds(client);

  // Start the per-minute voice XP ticker.
  startVoiceTicker(client);

  // Start scheduled daily decay (4 AM server local time).
  startDecayScheduler(client);

  // Start YouTube RSS feed polling
  // Start YouTube Data API v3 polling for live streams
  startYoutubeTicker(client);

  // Periodic cleanup of cooldown maps so memory stays bounded.
  // We keep a generous window so we don't accidentally delete active entries.
  setInterval(() => {
    // 6 hours is plenty for the cooldowns we use (seconds).
    sweepCooldownMap(msgCooldown, 6 * 60 * 60 * 1000);
    sweepCooldownMap(reactionCooldown, 6 * 60 * 60 * 1000);
  }, 10 * 60 * 1000);
});

// Message XP (+ honeypot enforcement)
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild) return;
    if (message.author?.bot) return;

    // Cache for verbose message-delete logs
    cacheMessage(message);

    // Reaction-role option add/remove: admin is awaiting an emoji message
    const pendingRr = await handlePendingOptionEmojiMessage(message);
    if (pendingRr.handled) return;

    // Honeypot: ban non-exempt users who post in configured channels
    if (await handleHoneypotMessage(message)) return;

    const settings = getGuildSettings(message.guild.id);
    const gain = Number(settings.msg_xp) || 0;
    const cdSec = Math.max(0, Number(settings.msg_cooldown_sec) || 0);
    if (gain <= 0) return;

    const k = key(message.guild.id, message.author.id);
    const last = msgCooldown.get(k) || 0;
    const nowMs = Date.now();
    if (cdSec > 0 && (nowMs - last) < cdSec * 1000) return;

    msgCooldown.set(k, nowMs);

    const newXp = addXp(message.guild.id, message.author.id, gain);
    logActivity(message.guild.id, message.author.id, "message", 1);

    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (member) {
      const lvl = levelFromXp(newXp, settings.level_xp_factor);
      const changes = await syncMemberRoles(member, lvl);
      await logLevelRoleChanges(client, member, changes, lvl, "xp_sync").catch(() => {});
    }
  } catch (e) {
    console.error("[MessageCreate] error:", e?.message || e);
  }
});

// Reaction roles + reaction XP (add)
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (!reaction.message?.guild) return;
    if (user?.bot) return;

    // Ensure partials are resolved
    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    if (reaction.message.partial) {
      try { await reaction.message.fetch(); } catch { /* ignore */ }
    }

    // Reaction-role panels: grant/strip; never award XP on panels
    const rr = await handleReactionRoleAdd(reaction, user);
    if (rr.handled) return;

    const guild = reaction.message.guild;
    const settings = getGuildSettings(guild.id);
    const gain = Number(settings.reaction_xp) || 0;
    const cdSec = Math.max(0, Number(settings.reaction_cooldown_sec) || 0);
    if (gain <= 0) return;

    const k = key(guild.id, user.id);
    const last = reactionCooldown.get(k) || 0;
    const nowMs = Date.now();
    if (cdSec > 0 && (nowMs - last) < cdSec * 1000) return;

    reactionCooldown.set(k, nowMs);

    const newXp = addXp(guild.id, user.id, gain);
    logActivity(guild.id, user.id, "reaction", 1);

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (member) {
      const lvl = levelFromXp(newXp, settings.level_xp_factor);
      const changes = await syncMemberRoles(member, lvl);
      await logLevelRoleChanges(client, member, changes, lvl, "xp_sync").catch(() => {});
    }
  } catch (e) {
    console.error("[ReactionAdd] error:", e?.message || e);
  }
});

// Reaction roles (remove → drop role when removable)
client.on(Events.MessageReactionRemove, async (reaction, user) => {
  try {
    if (!reaction.message?.guild) return;
    if (user?.bot) return;

    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    if (reaction.message.partial) {
      try { await reaction.message.fetch(); } catch { /* ignore */ }
    }

    await handleReactionRoleRemove(reaction, user);
  } catch (e) {
    console.error("[ReactionRemove] error:", e?.message || e);
  }
});

// Message log: single delete
client.on(Events.MessageDelete, async (message) => {
  try {
    if (!message.guild) return;
    // Partial messages may lack content — cache + fetch best-effort
    if (message.partial) {
      try { await message.fetch(); } catch { /* often fails for deletes */ }
    }
    await logMessageDelete(client, message);
  } catch (e) {
    console.error("[MessageDelete] error:", e?.message || e);
  }
});

// Message log: bulk delete
client.on(Events.MessageBulkDelete, async (messages, channel) => {
  try {
    await logMessageBulkDelete(client, messages, channel);
  } catch (e) {
    console.error("[MessageBulkDelete] error:", e?.message || e);
  }
});

// Audit log: bans (honeypot + moderator / Discord UI)
client.on(Events.GuildBanAdd, async (ban) => {
  try {
    await logBan(client, ban);
  } catch (e) {
    console.error("[GuildBanAdd] error:", e?.message || e);
  }
});

// Audit log: kicks only (correlated with Discord audit log)
client.on(Events.GuildMemberRemove, async (member) => {
  try {
    if (!member?.guild) return;
    await logKickIfApplicable(client, member);
  } catch (e) {
    console.error("[GuildMemberRemove] error:", e?.message || e);
  }
});

// Honeypot ban roles: ban when a configured role is granted
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    await handleHoneypotBanRole(oldMember, newMember);
  } catch (e) {
    console.error("[GuildMemberUpdate] honeypot banrole error:", e?.message || e);
  }
});

// Slash commands
client.on(Events.InteractionCreate, async (interaction) => {
  // Handle autocomplete interactions
  if (interaction.isAutocomplete()) {
    const guildId = interaction.guild.id;
    const channels = getYoutubeChannels(guildId);

    const focusedValue = interaction.options.getFocused().toLowerCase();
    // Deduplicate by normalized channel name, keeping first occurrence
    const seenNames = new Set();
    const deduped = channels.filter(c => {
      const normalizedName = normalizeYoutubeName(c.channel_name).toLowerCase();
      if (seenNames.has(normalizedName)) return false;
      seenNames.add(normalizedName);
      return true;
    });

    const filtered = deduped.filter(c =>
      normalizeYoutubeName(c.channel_name).toLowerCase().includes(focusedValue)
    ).slice(0, 25); // Discord limit is 25 choices

    await interaction.respond(
      filtered.map(c => ({ name: "@" + normalizeYoutubeName(c.channel_name), value: c.id }))
    );
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  try {
    if (!commandsAllowed(interaction)) {
      await interaction.reply({
        content: "Commands aren't enabled in this channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildId = interaction.guildId;
    const settings = getGuildSettings(guildId);

    // /xp [user] (ephemeral)
    if (interaction.commandName === "xp") {
      const target = interaction.options.getUser("user") ?? interaction.user;
      const xp = getXp(guildId, target.id);
      const level = levelFromXp(xp, settings.level_xp_factor);

      await interaction.reply({
        content: `${target.username}: **${xp} XP** (Level **${level}**)`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // /leaderboard (PUBLIC) PNG top 10
    if (interaction.commandName === "leaderboard") {
      const rows = topUsers(guildId, 10);
      if (!rows.length) {
        await interaction.reply({
          content: "No leaderboard data yet.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      let members = null;
      try {
        members = await interaction.guild.members.fetch({ user: rows.map(r => r.user_id) });
      } catch {
        members = null;
      }

      const factor = Math.max(1, Number(settings.level_xp_factor) || 100);

      const entries = rows.map((r, idx) => {
        const m = members?.get?.(r.user_id);
        const name = m?.displayName || m?.user?.username || `User ${r.user_id}`;
        const level = levelFromXp(r.xp, factor);
        return { rank: idx + 1, name, xp: r.xp, level };
      });

      const png = renderLeaderboardPng(entries, factor);
      const file = new AttachmentBuilder(png, { name: "heisenxp-leaderboard.png" });

      await interaction.reply({
        content: "**Leaderboard (Top 10)**",
        files: [file],
      });
      return;
    }

    // Admin/mod gate from here down where appropriate
    const admin = isAdminOrMod(interaction);

    // /settings (admin/mod)
    if (interaction.commandName === "settings") {
      if (!admin) {
        await interaction.reply({ content: "You don’t have permission to use this.", flags: MessageFlags.Ephemeral });
        return;
      }

      const chans = listAllowedCommandChannels(guildId);
      const chanText = chans.length
        ? chans.map(r => `<#${r.channel_id}>`).join(", ")
        : "All channels (no restriction set)";

      const roles = listLevelRoles(guildId);
      const roleText = roles.length
        ? roles.map(r => `<@&${r.role_id}> @ Lvl ${r.level_required} (drop after ${r.drop_grace_days}d)`).join("\n")
        : "(none configured)";

      const auditLogCh = settings.audit_log_channel_id
        ? `<#${settings.audit_log_channel_id}>`
        : "Not configured";
      const messageLogCh = settings.message_log_channel_id
        ? `<#${settings.message_log_channel_id}>`
        : "Not configured";

      await interaction.reply({
        content:
          `**HeisenXP-Bot Settings**\n` +
          `**XP:** msg=${settings.msg_xp}, reaction=${settings.reaction_xp}, voice/min=${settings.voice_xp_per_min}\n` +
          `**Cooldowns:** msg=${settings.msg_cooldown_sec}s, reaction=${settings.reaction_cooldown_sec}s\n` +
          `**Decay:** enabled=${!!settings.decay_enabled}, threshold=${settings.decay_min_messages} msgs / ${settings.decay_window_days} days, percent=${Math.round((Number(settings.decay_percent) || 0) * 100)}%\n` +
          `**Level curve factor:** ${settings.level_xp_factor} (Level L starts at L²×factor)\n` +
          `**Logs:** audit=${auditLogCh}, message=${messageLogCh}\n` +
          `**Commands allowed in:** ${chanText}\n` +
          `**Level→Role mappings:**\n${roleText}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // /setlog (admin/mod) — audit log + message log channels
    if (interaction.commandName === "setlog") {
      if (!admin) {
        await interaction.reply({ content: "You don’t have permission to use this.", flags: MessageFlags.Ephemeral });
        return;
      }

      const sub = interaction.options.getSubcommand();

      if (sub === "show") {
        const auditLogCh = settings.audit_log_channel_id
          ? `<#${settings.audit_log_channel_id}> (\`${settings.audit_log_channel_id}\`)`
          : "Not configured";
        const messageLogCh = settings.message_log_channel_id
          ? `<#${settings.message_log_channel_id}> (\`${settings.message_log_channel_id}\`)`
          : "Not configured";
        await interaction.reply({
          content:
            `**Log channels**\n` +
            `• **Audit log** (bans, kicks, role changes): ${auditLogCh}\n` +
            `• **Message log** (deleted messages): ${messageLogCh}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "audit" || sub === "message") {
        const clear = interaction.options.getBoolean("clear") === true;
        const ch = interaction.options.getChannel("channel", false);
        const field = sub === "audit" ? "audit_log_channel_id" : "message_log_channel_id";
        const label = sub === "audit" ? "Audit log" : "Message log";
        const beforeId = settings[field];

        if (clear) {
          // Log while the audit channel still exists (if clearing audit itself)
          await logConfigChange(client, guildId, {
            title: `${label} channel cleared`,
            command: `/setlog ${sub}`,
            actor: interaction.user,
            changes: [
              beforeId
                ? `${label}: <#${beforeId}> → *none*`
                : `${label}: was already unset`,
            ],
          }).catch(() => {});
          updateGuildSettings(guildId, { [field]: null });
          await interaction.reply({
            content: `${label} channel cleared. That log stream is disabled until set again.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!ch) {
          await interaction.reply({
            content: `Provide a \`channel\`, or set \`clear:true\` to disable the ${label.toLowerCase()}.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        updateGuildSettings(guildId, { [field]: ch.id });
        await logConfigChange(client, guildId, {
          title: `${label} channel set`,
          command: `/setlog ${sub}`,
          actor: interaction.user,
          changes: [
            beforeId
              ? `${label}: <#${beforeId}> → <#${ch.id}>`
              : `${label}: *none* → <#${ch.id}>`,
          ],
        }).catch(() => {});
        await interaction.reply({
          content: `${label} will be sent to <#${ch.id}>.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    // /setxp (admin/mod)
    if (interaction.commandName === "setxp") {
      if (!admin) {
        await interaction.reply({ content: "You don’t have permission to use this.", flags: MessageFlags.Ephemeral });
        return;
      }

      const msg = interaction.options.getInteger("message");
      const reaction = interaction.options.getInteger("reaction");
      const voice = interaction.options.getInteger("voice");
      const msgcooldown = interaction.options.getInteger("msgcooldown");
      const reactioncooldown = interaction.options.getInteger("reactioncooldown");

      const errors = [
        validateXpValue(msg, "Message"),
        validateXpValue(reaction, "Reaction"),
        validateXpValue(voice, "Voice"),
      ].filter(Boolean);

      if (errors.length) {
        await interaction.reply({ content: errors.join("\n"), flags: MessageFlags.Ephemeral });
        return;
      }

      const patch = {};
      if (msg !== null) patch.msg_xp = msg;
      if (reaction !== null) patch.reaction_xp = reaction;
      if (voice !== null) patch.voice_xp_per_min = voice;
      if (msgcooldown !== null) patch.msg_cooldown_sec = msgcooldown;
      if (reactioncooldown !== null) patch.reaction_cooldown_sec = reactioncooldown;

      if (!Object.keys(patch).length) {
        await interaction.reply({
          content: "No XP settings provided to update.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const before = settings;
      const updated = updateGuildSettings(guildId, patch);
      const lines = diffConfigLines(before, updated, Object.keys(patch));
      if (lines.length) {
        await logConfigChange(client, guildId, {
          title: "XP settings updated",
          command: "/setxp",
          actor: interaction.user,
          changes: lines,
        }).catch(() => {});
      }

      await interaction.reply({
        content:
          `Updated XP settings:\n` +
          `- msg_xp: **${updated.msg_xp}**\n` +
          `- reaction_xp: **${updated.reaction_xp}**\n` +
          `- voice_xp_per_min: **${updated.voice_xp_per_min}**\n` +
          `- msg_cooldown_sec: **${updated.msg_cooldown_sec}**\n` +
          `- reaction_cooldown_sec: **${updated.reaction_cooldown_sec}**`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // /setdecay (admin/mod)
    if (interaction.commandName === "setdecay") {
      if (!admin) {
        await interaction.reply({ content: "You don’t have permission to use this.", flags: MessageFlags.Ephemeral });
        return;
      }

      const enabled = interaction.options.getBoolean("enabled");
      const messages = interaction.options.getInteger("messages");
      const days = interaction.options.getInteger("days");
      const percent = interaction.options.getNumber("percent"); // 0..95

      const patch = {};

      if (enabled !== null) patch.decay_enabled = enabled ? 1 : 0;
      if (messages !== null) patch.decay_min_messages = Math.max(0, messages);
      if (days !== null) patch.decay_window_days = Math.max(1, days);
      if (percent !== null) patch.decay_percent = Math.max(0, Math.min(0.95, percent / 100));

      if (!Object.keys(patch).length) {
        await interaction.reply({
          content: "No decay settings provided to update.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const before = settings;
      const updated = updateGuildSettings(guildId, patch);
      const lines = diffConfigLines(before, updated, Object.keys(patch), (k, v) => {
        if (k === "decay_enabled") return "`decay_enabled`";
        if (k === "decay_percent") return "`decay_percent`";
        return `\`${k}\``;
      }).map((line) => {
        // Show percent as human % in the after value if we can
        if (line.includes("decay_percent")) {
          const pctBefore = Math.round((Number(before.decay_percent) || 0) * 100);
          const pctAfter = Math.round((Number(updated.decay_percent) || 0) * 100);
          return `\`decay_percent\`: ${pctBefore}% → **${pctAfter}%**`;
        }
        if (line.includes("decay_enabled")) {
          return `\`decay_enabled\`: ${!!before.decay_enabled} → **${!!updated.decay_enabled}**`;
        }
        return line;
      });
      if (lines.length) {
        await logConfigChange(client, guildId, {
          title: "Decay settings updated",
          command: "/setdecay",
          actor: interaction.user,
          changes: lines,
        }).catch(() => {});
      }

      await interaction.reply({
        content:
          `Updated decay settings:\n` +
          `- enabled: **${!!updated.decay_enabled}**\n` +
          `- threshold: **${updated.decay_min_messages} messages** in **${updated.decay_window_days} days**\n` +
          `- percent: **${Math.round((Number(updated.decay_percent) || 0) * 100)}%**`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // /leveltorole (admin/mod)
    if (interaction.commandName === "leveltorole") {
      if (!admin) {
        await interaction.reply({ content: "You don’t have permission to use this.", flags: MessageFlags.Ephemeral });
        return;
      }

      const sub = interaction.options.getSubcommand();

      if (sub === "set") {
        const role = interaction.options.getRole("role", true);
        const level = interaction.options.getInteger("level", true);
        const dropdays = interaction.options.getInteger("dropdays", true);

        upsertLevelRole(guildId, role.id, Math.max(0, level), Math.max(0, dropdays));
        await logConfigChange(client, guildId, {
          title: "Level→role mapping set",
          command: "/leveltorole set",
          actor: interaction.user,
          changes: [
            `Role: ${role} (\`${role.id}\`)`,
            `Level required: **${level}**`,
            `Drop grace: **${dropdays}** day(s)`,
          ],
        }).catch(() => {});

        await interaction.reply({
          content: `Mapped ${role} to **Lvl ${level}** (remove after **${dropdays}** day(s) below).`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "remove") {
        const role = interaction.options.getRole("role", true);
        deleteLevelRole(guildId, role.id);
        await logConfigChange(client, guildId, {
          title: "Level→role mapping removed",
          command: "/leveltorole remove",
          actor: interaction.user,
          changes: [`Role: ${role} (\`${role.id}\`)`],
        }).catch(() => {});

        await interaction.reply({
          content: `Removed mapping for ${role}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "list") {
        const rows = listLevelRoles(guildId);
        if (!rows.length) {
          await interaction.reply({
            content: "No level→role mappings configured.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const lines = rows.map(r => `- <@&${r.role_id}> @ **Lvl ${r.level_required}** (drop after **${r.drop_grace_days}d**)`);
        await interaction.reply({
          content: `**Level→Role mappings:**\n${lines.join("\n")}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    // /setcommandchannel (admin/mod)
    if (interaction.commandName === "setcommandchannel") {
      if (!admin) {
        await interaction.reply({ content: "You don’t have permission to use this.", flags: MessageFlags.Ephemeral });
        return;
      }

      const sub = interaction.options.getSubcommand();

      if (sub === "add") {
        const ch = interaction.options.getChannel("channel", true);
        addAllowedCommandChannel(guildId, ch.id);
        await logConfigChange(client, guildId, {
          title: "Command channel allowed",
          command: "/setcommandchannel add",
          actor: interaction.user,
          changes: [`Channel: <#${ch.id}> (\`${ch.id}\`)`],
        }).catch(() => {});
        await interaction.reply({
          content: `Commands are now allowed in <#${ch.id}>.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "remove") {
        const ch = interaction.options.getChannel("channel", true);
        removeAllowedCommandChannel(guildId, ch.id);
        await logConfigChange(client, guildId, {
          title: "Command channel restriction removed",
          command: "/setcommandchannel remove",
          actor: interaction.user,
          changes: [`Channel: <#${ch.id}> (\`${ch.id}\`)`],
        }).catch(() => {});
        await interaction.reply({
          content: `Removed <#${ch.id}> from allowed command channels.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "list") {
        const rows = listAllowedCommandChannels(guildId);
        if (!rows.length) {
          await interaction.reply({
            content: "No allowed channels configured — commands are allowed in all channels.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const lines = rows.map(r => `- <#${r.channel_id}>`);
        await interaction.reply({
          content: `**Allowed command channels:**\n${lines.join("\n")}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    // /youtube (admin/mod)
    if (interaction.commandName === "youtube") {
      if (!admin) {
        await interaction.reply({ content: "You don't have permission to use this.", flags: MessageFlags.Ephemeral });
        return;
      }

      const sub = interaction.options.getSubcommand();

      if (sub === "add") {
        const url = interaction.options.getString("url", true);

        let channelId = "";
        let channelName = "";

        if (url.includes("youtube.com/@")) {
          const match = url.match(/youtube\.com\/@([^/?]+)/);
          if (match) {
            // Normalize to just the username
            channelId = match[1];
            channelName = "@" + match[1];
            fullUrl = `https://www.youtube.com/@${channelId}`;

            // Resolve @username to numeric ID immediately
            const resolved = await lookupChannelByName(channelId);
            if (resolved) {
              channelId = resolved.id;
              channelName = normalizeYoutubeName(resolved.name);  // Store without @ prefix
              fullUrl = `https://www.youtube.com/channel/${channelId}`;
            }
          }
        } else if (url.startsWith("@")) {
          // Bare @username - normalize to remove leading @
          const username = url.substring(1);
          channelId = username;
          channelName = "@" + username;
          fullUrl = `https://www.youtube.com/@${username}`;

          // Resolve @username to numeric ID immediately  
          const resolved = await lookupChannelByName(username);
          console.log(resolved)
          if (resolved) {
            channelId = resolved.id;
            channelName = normalizeYoutubeName(resolved.name);  // Store without @ prefix
            fullUrl = `https://www.youtube.com/channel/${channelId}`;
          }
        } else if (url.includes("youtube.com/channel/")) {
          const match = url.match(/youtube\.com\/channel\/([^/?]+)/);
          if (match) {
            channelId = match[1];
            channelName = `Channel ID: ${channelId}`;
          }
        } else if (url.startsWith("UC") || url.startsWith("HC")) {
          channelId = url;
          channelName = `Channel ID: ${url}`;
          fullUrl = `https://www.youtube.com/channel/${url}`;
        } else {
          await interaction.reply({
            content: "Invalid YouTube URL. Please use:\n- Full channel URL with @username: `https://www.youtube.com/@SomeChannel`\n- Full channel URL with ID: `https://www.youtube.com/channel/UCxxxxxxxxxxxxx`\n- Numeric channel ID: `UCxxxxxxxxxxxxx`",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const normalizedChannelName = normalizeYoutubeName(channelName);
        let thumbnail = "";
        if (channelId && !channelId.startsWith("@")) {
          const channelInfo = await fetchChannelInfo(channelId);
          console.log(`[youtube] /youtube add - fetchChannelInfo result for ${channelId}:`, JSON.stringify(channelInfo, null, 2));
          if (channelInfo && channelInfo.thumbnail_url) {
            thumbnail = channelInfo.thumbnail_url;
            console.log(`[youtube] Using API thumbnail: ${thumbnail}`);
          } else {
            thumbnail = `https://i.ytimg.com/vi/${channelId}/maxresdefault.jpg`;
            console.log(`[youtube] Using fallback thumbnail: ${thumbnail}`);
          }
        }

        try {
          addYoutubeChannel(guildId, channelId, normalizedChannelName, url, thumbnail);

          let replyMsg = `Subscribed to **@${normalizedChannelName}**. I'll notify when they go live.`;
          if (channelId.startsWith("@")) {
            replyMsg += "\n\nNote: @username detected. I will attempt to resolve the actual channel ID from YouTube.";
          }

          await logConfigChange(client, guildId, {
            title: "YouTube subscription added",
            command: "/youtube add",
            actor: interaction.user,
            changes: [
              `Channel: **@${normalizedChannelName}**`,
              `ID: \`${channelId}\``,
              `URL: ${url}`,
            ],
          }).catch(() => {});

          await interaction.reply({
            content: replyMsg,
            flags: MessageFlags.Ephemeral,
          });
        } catch (err) {
          console.error("[youtube] Add error:", err);
          await interaction.reply({
            content: "Failed to add subscription. Check logs.",
            flags: MessageFlags.Ephemeral,
          });
        }
        return;
      }

      if (sub === "remove") {
        const channelId = interaction.options.getString("channel", true);

        // Get channel by ID
        let foundChannel = null;
        const channels = getYoutubeChannels(guildId);
        for (const c of channels) {
          if (normalizeYoutubeName(c.id) === normalizeYoutubeName(channelId) && c.guild_id === guildId) {
            foundChannel = c;
            break;
          }
        }

        if (!foundChannel) {
          await interaction.reply({
            content: "No subscription found.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const channelsBefore = getYoutubeChannels(guildId).length;

        let removed = false;
        try {
          removed = removeYoutubeChannel(guildId, channelId);
          console.log(`[youtube] Remove debug:`, {
            guildId,
            channelId,
            foundChannel: foundChannel?.channel_name,
            channelsBefore,
            removed,
            error: null
          });
        } catch (err) {
          console.error("[youtube] Remove error:", err);
        }

        const channelsAfter = getYoutubeChannels(guildId).length;
        if (!removed && channelsAfter < channelsBefore) {
          // Actually removed but function returned false - DB issue?
          removed = true;
        }

        if (removed) {
          await logConfigChange(client, guildId, {
            title: "YouTube subscription removed",
            command: "/youtube remove",
            actor: interaction.user,
            changes: [
              `Channel: **${foundChannel.channel_name}**`,
              `ID: \`${foundChannel.id || channelId}\``,
            ],
          }).catch(() => {});
          await interaction.reply({
            content: `Unsubscribed from **${foundChannel.channel_name}**.`,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.reply({
            content: "Failed to unsubscribe.",
            flags: MessageFlags.Ephemeral,
          });
        }
        return;
      }

      if (sub === "list") {
        const channels = getYoutubeChannels(guildId);

        if (!channels.length) {
          await interaction.reply({
            content: "No YouTube channels subscribed.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const guildSettings = getGuildSettings(guildId);
        const notificationChannel = guildSettings.youtube_notification_channel_id
          ? `<#${guildSettings.youtube_notification_channel_id}>`
          : ":white_medium_square: Not configured";

        const lines = channels.map(c => {
          const channelNameDisplay = "@" + normalizeYoutubeName(c.channel_name);
          let info = `- **${channelNameDisplay}**`;

          if (c.id.startsWith("@")) {
            info += ` (*@username detected, resolving at runtime*)\n  URL: <${c.channel_url}>`;
          } else {
            info += `\n  ID: ${c.id}\n  URL: <${c.channel_url}>`;
          }

          return info;
        });

        await interaction.reply({
          content: `**Subscribed Channels (${channels.length}):**\n\nNotification Channel: ${notificationChannel}\n__Channels:__\n${lines.join("\n")}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    // /setyoutube (admin/mod)
    if (interaction.commandName === "setyoutube") {
      if (!admin) {
        await interaction.reply({ content: "You don't have permission to use this.", flags: MessageFlags.Ephemeral });
        return;
      }

      const sub = interaction.options.getSubcommand();

      if (sub === "channel") {
        const ch = interaction.options.getChannel("channel", true);
        const before = settings.youtube_notification_channel_id;
        updateGuildSettings(guildId, { youtube_notification_channel_id: ch.id });
        await logConfigChange(client, guildId, {
          title: "YouTube notification channel set",
          command: "/setyoutube channel",
          actor: interaction.user,
          changes: [
            before
              ? `Channel: <#${before}> → <#${ch.id}>`
              : `Channel: *none* → <#${ch.id}>`,
          ],
        }).catch(() => {});

        await interaction.reply({
          content: `YouTube notifications will be sent to <#${ch.id}>.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "interval") {
        const minutes = interaction.options.getInteger("minutes", true);
        if (minutes < 1 || minutes > 60) {
          await interaction.reply({
            content: "Polling interval must be between 1 and 60 minutes.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const before = settings.youtube_polling_interval_minutes;
        updateGuildSettings(guildId, { youtube_polling_interval_minutes: minutes });
        await logConfigChange(client, guildId, {
          title: "YouTube polling interval set",
          command: "/setyoutube interval",
          actor: interaction.user,
          changes: [`Interval: ${before} → **${minutes}** minute(s)`],
        }).catch(() => {});

        await interaction.reply({
          content: `YouTube polling interval set to **${minutes}** minute(s).`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "uploadrole") {
        const role = interaction.options.getRole("role", false);
        const before = settings.youtube_upload_role_id;
        updateGuildSettings(guildId, { youtube_upload_role_id: role ? role.id : null });
        const afterLabel = role ? `<@&${role.id}>` : "*none*";
        const beforeLabel = before ? `<@&${before}>` : "*none*";
        await logConfigChange(client, guildId, {
          title: "YouTube upload mention role set",
          command: "/setyoutube uploadrole",
          actor: interaction.user,
          changes: [`Role: ${beforeLabel} → ${afterLabel}`],
        }).catch(() => {});

        await interaction.reply({
          content: role
            ? `Upload notifications will mention <@&${role.id}>.`
            : `Upload notifications will no longer mention a role.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    // /testnotification (admin/mod)
    if (interaction.commandName === "testnotification") {
      if (!admin) {
        await interaction.reply({ content: "You don't have permission to use this.", flags: MessageFlags.Ephemeral });
        return;
      }

      const url = interaction.options.getString("channel", true);

      let channelId = "";
      let channelName = "";
      let channelUrl = "";

      if (url.includes("youtube.com/@")) {
        const match = url.match(/youtube\.com\/@([^/?]+)/);
        if (match) {
          channelId = match[1];
          channelName = "@" + match[1];
          channelUrl = `https://www.youtube.com/@${channelId}`;

          const resolved = await lookupChannelByName(channelId);
          if (resolved) {
            channelId = resolved.id;
            channelName = normalizeYoutubeName(resolved.name);
            channelUrl = `https://www.youtube.com/channel/${channelId}`;
          }
        }
      } else if (url.startsWith("@")) {
        const username = url.substring(1);
        channelId = username;
        channelName = "@" + username;
        channelUrl = `https://www.youtube.com/@${username}`;

        const resolved = await lookupChannelByName(username);
        if (resolved) {
          channelId = resolved.id;
          channelName = normalizeYoutubeName(resolved.name);
          channelUrl = `https://www.youtube.com/channel/${channelId}`;
        }
      } else if (url.includes("youtube.com/channel/")) {
        const match = url.match(/youtube\.com\/channel\/([^/?]+)/);
        if (match) {
          channelId = match[1];
          channelName = `Channel ID: ${channelId}`;
          channelUrl = url;
        }
      } else if (url.startsWith("UC") || url.startsWith("HC")) {
        channelId = url;
        channelName = `Channel ID: ${url}`;
        channelUrl = `https://www.youtube.com/channel/${url}`;
      } else {
        await interaction.reply({
          content: "Invalid YouTube URL.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const channels = getYoutubeChannels(guildId);
      let existingChannel = null;
      for (const c of channels) {
        if (normalizeYoutubeName(c.channel_name).toLowerCase() === normalizeYoutubeName(channelName).toLowerCase()) {
          existingChannel = c;
          break;
        }
      }

      if (!existingChannel) {
        let thumbnail = "";
        if (channelId && !channelId.startsWith("@")) {
          const channelInfo = await fetchChannelInfo(channelId);
          console.log(`[youtube] /testnotification add - fetchChannelInfo result for ${channelId}:`, JSON.stringify(channelInfo, null, 2));
          if (channelInfo && channelInfo.thumbnail_url) {
            thumbnail = channelInfo.thumbnail_url;
            console.log(`[youtube] Using API thumbnail: ${thumbnail}`);
          } else {
            thumbnail = `https://i.ytimg.com/vi/${channelId}/maxresdefault.jpg`;
            console.log(`[youtube] Using fallback thumbnail: ${thumbnail}`);
          }
        }
        addYoutubeChannel(guildId, channelId, normalizeYoutubeName(channelName), channelUrl, thumbnail);

        existingChannel = getYoutubeChannels(guildId).find(c =>
          normalizeYoutubeName(c.channel_name) === normalizeYoutubeName(channelName)
        );
      }

      console.log(`[testnotification] Channel data from DB:`, JSON.stringify(existingChannel, null, 2));

      if (!existingChannel || !existingChannel.id) {
        await interaction.reply({
          content: "Could not find or subscribe to the channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const feed = await fetchYouTubeFeed(existingChannel.id);
      if (!feed || !feed.items || !feed.items.length) {
        await interaction.reply({
          content: "Could not fetch videos from this channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const entry = feed.items[0];
      const videoInfo = extractVideoInfo(entry);

      if (!videoInfo || !videoInfo.videoId) {
        await interaction.reply({
          content: "Could not extract video information.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      let isLive, notificationType;
      if (isLiveVideo(entry)) {
        isLive = true;
        notificationType = "live";
      } else if (isVideoUpload(entry)) {
        isLive = false;
        notificationType = "upload";
      } else {
        await interaction.reply({
          content: "Latest video entry type could not be determined.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      console.log(`[testnotification] Channel thumbnail URL:`, existingChannel.thumbnail_url);

      const useSimpleEmbed = interaction.options.getBoolean("simple") || false;

      let content = `Test ${notificationType} notification for **${channelName}**`;
      let embeds = [];

      if (notificationType === "live") {
        embeds = [createLiveEmbed(existingChannel, videoInfo, channelUrl)];
      } else {
        const settings = getGuildSettings(guildId);
        const uploadRoleId = settings.youtube_upload_role_id;

        if (useSimpleEmbed) {
          const simpleResult = createSimpleUploadEmbed(existingChannel, videoInfo, channelUrl);
          let roleMention = "";
          if (uploadRoleId) {
            roleMention = `<@&${uploadRoleId}> `;
          }
          content = `${roleMention}${simpleResult.content}`;
        } else {
          embeds = [createUploadEmbed(existingChannel, videoInfo, channelUrl)];
          let roleMention = "";
          if (uploadRoleId) {
            roleMention = `<@&${uploadRoleId}> `;
          }
          content = `${roleMention}${channelName} uploaded a new video!`;
        }
      }

      await interaction.reply({
        content: content,
        embeds: embeds,
      });
      return;
    }

    // /honeypot (admin/mod) — channel + exempt subcommand groups
    if (interaction.commandName === "honeypot") {
      if (!admin) {
        await interaction.reply({
          content: "You don't have permission to use this.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();

      // /honeypot channel [add|list|del]
      if (group === "channel") {
        if (sub === "add") {
          const ch = interaction.options.getChannel("channel", true);

          if (isHoneypotChannel(guildId, ch.id)) {
            await interaction.reply({
              content: `<#${ch.id}> is already set up as a honeypot channel.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          addHoneypotChannel(guildId, ch.id);
          const warningStatus = await ensureHoneypotWarning(interaction.guild, ch.id);
          await logConfigChange(client, guildId, {
            title: "Honeypot channel added",
            command: "/honeypot channel add",
            actor: interaction.user,
            changes: [`Channel: <#${ch.id}> (\`${ch.id}\`)`],
            details: warningStatus,
          }).catch(() => {});
          await interaction.reply({
            content:
              `Marked <#${ch.id}> as a **honeypot** channel.\n` +
              `Anyone who posts there will be banned immediately (except members with exempt roles).\n` +
              `${warningStatus}\n` +
              `Tip: use \`/honeypot exempt add\` for staff roles so they are not banned by mistake.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (sub === "del") {
          const ch = interaction.options.getChannel("channel", true);
          const { removed, warning_message_id } = removeHoneypotChannel(guildId, ch.id);

          let warningNote = "";
          if (removed && warning_message_id) {
            try {
              const channel = await interaction.guild.channels.fetch(ch.id).catch(() => null);
              if (channel?.messages) {
                const msg = await channel.messages.fetch(warning_message_id).catch(() => null);
                if (msg) {
                  await msg.delete().catch(() => null);
                  warningNote = " Warning notice removed.";
                }
              }
            } catch {
              warningNote = " (Could not delete warning notice — remove it manually if needed.)";
            }
          }

          if (removed) {
            await logConfigChange(client, guildId, {
              title: "Honeypot channel removed",
              command: "/honeypot channel del",
              actor: interaction.user,
              changes: [`Channel: <#${ch.id}> (\`${ch.id}\`)`],
              details: warningNote.trim() || undefined,
            }).catch(() => {});
          }

          await interaction.reply({
            content: removed
              ? `Removed <#${ch.id}> from the honeypot list.${warningNote}`
              : `<#${ch.id}> was not a honeypot channel.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (sub === "list") {
          const rows = listHoneypotChannels(guildId);
          if (!rows.length) {
            await interaction.reply({
              content: "No honeypot channels configured.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const lines = rows.map((r) => `- <#${r.channel_id}>`);
          await interaction.reply({
            content: `**Honeypot channels:**\n${lines.join("\n")}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }

      // /honeypot banrole [add|list|del]
      if (group === "banrole") {
        if (sub === "add") {
          const role = interaction.options.getRole("role", true);

          if (role.id === guildId) {
            await interaction.reply({
              content: "You cannot use @everyone as a honeypot ban role.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          if (role.managed) {
            await interaction.reply({
              content:
                "That role is managed by an integration. Prefer a normal server role for ban-role honeypots.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          if (isHoneypotBanRole(guildId, role.id)) {
            await interaction.reply({
              content: `${role} is already a honeypot ban role.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          addHoneypotBanRole(guildId, role.id);
          await logConfigChange(client, guildId, {
            title: "Honeypot ban role added",
            command: "/honeypot banrole add",
            actor: interaction.user,
            changes: [`Role: ${role} (\`${role.id}\`)`],
          }).catch(() => {});
          await interaction.reply({
            content:
              `Marked ${role} as a **honeypot ban role**.\n` +
              `Anyone who is **granted** this role will be banned immediately ` +
              `(except members with honeypot exempt roles).\n` +
              `Tip: configure \`/honeypot exempt\` for staff first. ` +
              `Members who already have the role are not retroactively banned.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (sub === "del") {
          const role = interaction.options.getRole("role", true);
          const removed = removeHoneypotBanRole(guildId, role.id);
          if (removed) {
            await logConfigChange(client, guildId, {
              title: "Honeypot ban role removed",
              command: "/honeypot banrole del",
              actor: interaction.user,
              changes: [`Role: ${role} (\`${role.id}\`)`],
            }).catch(() => {});
          }
          await interaction.reply({
            content: removed
              ? `Removed ${role} from the honeypot ban-role list.`
              : `${role} was not a honeypot ban role.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (sub === "list") {
          const rows = listHoneypotBanRoles(guildId);
          if (!rows.length) {
            await interaction.reply({
              content: "No honeypot ban roles configured.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const lines = rows.map((r) => `- <@&${r.role_id}>`);
          await interaction.reply({
            content:
              `**Honeypot ban roles** (granting these bans the member):\n${lines.join("\n")}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }

      // /honeypot exempt [add|list|del]
      if (group === "exempt") {
        if (sub === "add") {
          const role = interaction.options.getRole("role", true);
          addHoneypotExemptRole(guildId, role.id);
          await logConfigChange(client, guildId, {
            title: "Honeypot exempt role added",
            command: "/honeypot exempt add",
            actor: interaction.user,
            changes: [`Role: ${role} (\`${role.id}\`)`],
          }).catch(() => {});
          await interaction.reply({
            content:
              `Added ${role} to honeypot exempt roles. Members with this role will not be banned ` +
              `for posting in honeypot channels or receiving honeypot ban roles.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (sub === "del") {
          const role = interaction.options.getRole("role", true);
          const removed = removeHoneypotExemptRole(guildId, role.id);
          if (removed) {
            await logConfigChange(client, guildId, {
              title: "Honeypot exempt role removed",
              command: "/honeypot exempt del",
              actor: interaction.user,
              changes: [`Role: ${role} (\`${role.id}\`)`],
            }).catch(() => {});
          }
          await interaction.reply({
            content: removed
              ? `Removed ${role} from honeypot exempt roles.`
              : `${role} was not on the honeypot exempt list.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (sub === "list") {
          const rows = listHoneypotExemptRoles(guildId);
          if (!rows.length) {
            await interaction.reply({
              content:
                "No honeypot exempt roles configured. Staff who hit honeypots will be banned.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const lines = rows.map((r) => `- <@&${r.role_id}>`);
          await interaction.reply({
            content: `**Honeypot exempt roles:**\n${lines.join("\n")}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }

      // Always answer /honeypot so we never fall through as "handler missing"
      await interaction.reply({
        content:
          `Unknown honeypot subcommand: \`/${interaction.commandName}` +
          `${group ? ` ${group}` : ""} ${sub || ""}\`.\n` +
          `Use \`/honeypot channel add|list|del\`, \`/honeypot banrole add|list|del\`, or \`/honeypot exempt add|list|del\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // /reactionrole (admin/mod) — panel + option groups, plus sync
    if (interaction.commandName === "reactionrole") {
      if (!admin) {
        await interaction.reply({
          content: "You don't have permission to use this.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();

      // /reactionrole panel [create|edit|deploy|delete|list]
      if (group === "panel") {
        if (sub === "create") {
          const ch = interaction.options.getChannel("channel", true);
          const title = interaction.options.getString("title") || "Reaction Roles";
          const description =
            interaction.options.getString("description") ||
            "React to get a role. Remove your reaction to drop it (if allowed).";

          if (typeof ch.isTextBased !== "function" || !ch.isTextBased()) {
            await interaction.reply({
              content: "That channel cannot receive messages.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          if (typeof ch.send !== "function") {
            await interaction.reply({
              content: "That channel cannot receive messages.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const panelStub = {
            title,
            description,
            guild_id: guildId,
            channel_id: ch.id,
            message_id: "pending",
          };
          const embed = buildPanelEmbed(panelStub, []);

          let msg;
          try {
            // Role names may appear later in the embed as mentions — never ping
            msg = await ch.send({ embeds: [embed], allowedMentions: NO_PING_MENTIONS });
          } catch (e) {
            await interaction.reply({
              content: `Could not post panel: ${e?.message || e}`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          createReactionRolePanel(guildId, ch.id, msg.id, title, description);
          await logConfigChange(client, guildId, {
            title: "Reaction-role panel created",
            command: "/reactionrole panel create",
            actor: interaction.user,
            changes: [
              `Channel: <#${ch.id}>`,
              `Message ID: \`${msg.id}\``,
              `Title: ${title}`,
            ],
            details: msg.url,
          }).catch(() => {});
          await interaction.reply({
            content:
              `Created reaction-role panel in <#${ch.id}>.\n` +
              `Message ID: \`${msg.id}\`\n` +
              `Jump: ${msg.url}\n` +
              `Add options with \`/reactionrole option add message_id:${msg.id}\`.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (sub === "edit") {
          const messageId = interaction.options.getString("message_id", true).trim();
          const title = interaction.options.getString("title");
          const description = interaction.options.getString("description");

          if (title == null && description == null) {
            await interaction.reply({
              content: "Provide at least one of `title` or `description` to update.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const panel = getReactionRolePanel(guildId, messageId);
          if (!panel) {
            await interaction.reply({
              content: `No reaction-role panel with message ID \`${messageId}\`.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          updateReactionRolePanelText(guildId, messageId, title, description);
          const updated = getReactionRolePanel(guildId, messageId);
          const result = await refreshPanelMessage(interaction.guild, updated);
          const changeLines = [];
          if (title != null) changeLines.push(`Title: ${panel.title} → **${updated.title}**`);
          if (description != null) {
            changeLines.push(
              `Description updated (${String(panel.description || "").length} → ${String(updated.description || "").length} chars)`
            );
          }
          await logConfigChange(client, guildId, {
            title: "Reaction-role panel edited",
            command: "/reactionrole panel edit",
            actor: interaction.user,
            changes: [`Panel: \`${messageId}\``, ...changeLines],
          }).catch(() => {});
          await interaction.reply({
            content: result.ok
              ? `Updated panel \`${messageId}\`.`
              : `Saved text, but refresh failed: ${result.error}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (sub === "deploy") {
          const messageId = interaction.options.getString("message_id", true).trim();
          const ch = interaction.options.getChannel("channel", true);

          if (typeof ch.isTextBased === "function" && !ch.isTextBased()) {
            await interaction.reply({
              content: "That channel cannot receive messages.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          if (typeof ch.send !== "function") {
            await interaction.reply({
              content: "That channel cannot receive messages.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          // May post + react several times
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          const result = await deployPanelToChannel(interaction.guild, messageId, ch);
          if (!result.ok) {
            await interaction.editReply({ content: result.error });
            return;
          }

          const n = result.optionCount ?? 0;
          let content =
            `Deployed panel from \`${messageId}\` → <#${ch.id}>.\n` +
            `New message ID: \`${result.message.id}\`\n` +
            `Jump: ${result.message.url}\n` +
            `Copied **${n}** option${n === 1 ? "" : "s"} (source panel left in place).`;
          if (result.error) {
            content += `\n⚠️ ${result.error}`;
          }
          await logConfigChange(client, guildId, {
            title: "Reaction-role panel deployed",
            command: "/reactionrole panel deploy",
            actor: interaction.user,
            changes: [
              `Source panel: \`${messageId}\``,
              `New channel: <#${ch.id}>`,
              `New message ID: \`${result.message.id}\``,
              `Options copied: **${n}**`,
            ],
            details: result.message.url,
          }).catch(() => {});
          await interaction.editReply({ content });
          return;
        }

        if (sub === "delete") {
          const messageId = interaction.options.getString("message_id", true).trim();
          const { removed, channel_id } = deleteReactionRolePanel(guildId, messageId);

          let note = "";
          if (removed && channel_id) {
            try {
              const channel = await interaction.guild.channels.fetch(channel_id).catch(() => null);
              if (channel?.messages) {
                const msg = await channel.messages.fetch(messageId).catch(() => null);
                if (msg) {
                  await msg.delete().catch(() => null);
                  note = " Discord message deleted.";
                } else {
                  note = " (Message was already gone.)";
                }
              }
            } catch {
              note = " (Could not delete Discord message — remove it manually if needed.)";
            }
          }

          if (removed) {
            await logConfigChange(client, guildId, {
              title: "Reaction-role panel deleted",
              command: "/reactionrole panel delete",
              actor: interaction.user,
              changes: [
                `Message ID: \`${messageId}\``,
                channel_id ? `Channel: <#${channel_id}>` : null,
              ].filter(Boolean),
              details: note.trim() || undefined,
            }).catch(() => {});
          }

          await interaction.reply({
            content: removed
              ? `Deleted reaction-role panel \`${messageId}\`.${note}`
              : `No reaction-role panel with message ID \`${messageId}\`.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (sub === "list") {
          const panels = listReactionRolePanels(guildId);
          if (!panels.length) {
            await interaction.reply({
              content: "No reaction-role panels configured. Use `/reactionrole panel create`.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const lines = panels.map((p) => {
            const jump = `https://discord.com/channels/${guildId}/${p.channel_id}/${p.message_id}`;
            const n = countReactionRoleOptions(guildId, p.message_id);
            return `- **${p.title}** in <#${p.channel_id}> — \`${p.message_id}\` (${n} option${n === 1 ? "" : "s"}) — [jump](${jump})`;
          });
          await interaction.reply({
            content: `**Reaction-role panels:**\n${lines.join("\n")}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }

      // /reactionrole option [add|remove|list]
      if (group === "option") {
        if (sub === "add") {
          const messageId = interaction.options.getString("message_id", true).trim();
          const role = interaction.options.getRole("role", true);
          const level = interaction.options.getInteger("level") ?? 0;
          const removable = interaction.options.getBoolean("removable");
          const removableFlag = removable === null ? true : removable;

          const panel = getReactionRolePanel(guildId, messageId);
          if (!panel) {
            await interaction.reply({
              content: `No reaction-role panel with message ID \`${messageId}\`.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          if (role.managed) {
            await interaction.reply({
              content: "That role is managed by an integration and cannot be assigned by the bot.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const optCount = countReactionRoleOptions(guildId, messageId);
          if (optCount >= MAX_OPTIONS_PER_PANEL) {
            await interaction.reply({
              content: `This panel already has ${MAX_OPTIONS_PER_PANEL} options (Discord reaction limit). Remove one first.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          // Replace any prior wait session for this admin
          clearPendingOptionEmoji(guildId, interaction.user.id);
          setPendingOptionAdd(guildId, interaction.user.id, {
            messageId,
            roleId: role.id,
            level,
            removable: removableFlag,
            channelId: interaction.channelId,
          });

          const mins = Math.round(PENDING_EMOJI_TTL_MS / 60000);
          await interaction.reply({
            content:
              `**Send the emoji** as your next message in this server (message should be only the emoji).\n` +
              `I'll map it to ${role} on panel \`${messageId}\` (Level ${level}+, ${
                removableFlag ? "removable" : "permanent"
              }).\n` +
              `Type **\`stop\`** to cancel. Expires in ${mins} minutes.`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: NO_PING_MENTIONS,
          });
          return;
        }

        if (sub === "remove") {
          const messageId = interaction.options.getString("message_id", true).trim();

          const panel = getReactionRolePanel(guildId, messageId);
          if (!panel) {
            await interaction.reply({
              content: `No reaction-role panel with message ID \`${messageId}\`.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const optCount = countReactionRoleOptions(guildId, messageId);
          if (optCount === 0) {
            await interaction.reply({
              content: `Panel \`${messageId}\` has no options to remove.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          clearPendingOptionEmoji(guildId, interaction.user.id);
          setPendingOptionRemove(guildId, interaction.user.id, {
            messageId,
            channelId: interaction.channelId,
          });

          const mins = Math.round(PENDING_EMOJI_TTL_MS / 60000);
          await interaction.reply({
            content:
              `**Send the emoji** to remove as your next message (message should be only the emoji).\n` +
              `I'll remove that option from panel \`${messageId}\`.\n` +
              `Type **\`stop\`** to cancel. Expires in ${mins} minutes.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (sub === "list") {
          const messageId = interaction.options.getString("message_id", true).trim();
          const panel = getReactionRolePanel(guildId, messageId);
          if (!panel) {
            await interaction.reply({
              content: `No reaction-role panel with message ID \`${messageId}\`.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const opts = listReactionRoleOptions(guildId, messageId);
          if (!opts.length) {
            await interaction.reply({
              content: `Panel \`${messageId}\` has no options yet.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const lines = opts.map((o) => {
            const rem = Number(o.removable) !== 0 ? "removable" : "permanent";
            return `- ${o.emoji_display} → <@&${o.role_id}> — Level ${o.min_level}+ · ${rem}`;
          });
          await interaction.reply({
            content: `**Options for panel \`${messageId}\`:**\n${lines.join("\n")}`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: NO_PING_MENTIONS,
          });
          return;
        }
      }

      // /reactionrole sync
      if (!group && sub === "sync") {
        const messageId = interaction.options.getString("message_id", true).trim();
        const panel = getReactionRolePanel(guildId, messageId);
        if (!panel) {
          await interaction.reply({
            content: `No reaction-role panel with message ID \`${messageId}\`.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const result = await refreshPanelMessage(interaction.guild, panel);
        if (result.ok) {
          await logConfigChange(client, guildId, {
            title: "Reaction-role panel synced",
            command: "/reactionrole sync",
            actor: interaction.user,
            changes: [`Panel: \`${messageId}\``],
          }).catch(() => {});
        }
        await interaction.reply({
          content: result.ok
            ? `Synced panel \`${messageId}\` (embed + bot reactions).`
            : `Sync failed: ${result.error}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({
        content:
          `Unknown reactionrole subcommand: \`/${interaction.commandName}` +
          `${group ? ` ${group}` : ""} ${sub || ""}\`.\n` +
          `Use \`/reactionrole panel create|edit|deploy|delete|list\`, \`/reactionrole option add|remove|list\`, or \`/reactionrole sync\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Fallback so Discord never times out
    await interaction.reply({
      content: `Unhandled command: \`/${interaction.commandName}\` (handler missing).`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    console.error("Interaction handler error:", err);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "Something went wrong handling that command (check bot logs).",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "Something went wrong handling that command (check bot logs).",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch {
      // If Discord rejects the response (already timed out), nothing else we can do.
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
