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
} = require("./db");

const { renderLeaderboardPng } = require("./renderLeaderboard");
const { levelFromXp } = require("./xp");
const { syncMemberRoles } = require("./roles");
const { startVoiceTicker } = require("./voiceTicker");
const { startDecayScheduler } = require("./decay");
const { startYoutubeTicker, fetchChannelInfo } = require("./youtubeTicker");

const MAX_XP_AWARD = 1_000_000_000;

// Cooldowns (in-memory)
const msgCooldown = new Map();      // key: guildId:userId => lastTs
const reactionCooldown = new Map(); // key: guildId:userId => lastTs

function key(guildId, userId) {
  return `${guildId}:${userId}`;
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
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once(Events.ClientReady, () => {
  console.log(`HeisenXP-Bot logged in as ${client.user.tag}`);

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

// Message XP
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild) return;
    if (message.author?.bot) return;

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
      await syncMemberRoles(member, lvl);
    }
  } catch (e) {
    console.error("[MessageCreate] error:", e?.message || e);
  }
});

// Reaction XP (add)
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
      await syncMemberRoles(member, lvl);
    }
  } catch (e) {
    console.error("[ReactionAdd] error:", e?.message || e);
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

      await interaction.reply({
        content:
        `**HeisenXP-Bot Settings**\n` +
        `**XP:** msg=${settings.msg_xp}, reaction=${settings.reaction_xp}, voice/min=${settings.voice_xp_per_min}\n` +
        `**Cooldowns:** msg=${settings.msg_cooldown_sec}s, reaction=${settings.reaction_cooldown_sec}s\n` +
        `**Decay:** enabled=${!!settings.decay_enabled}, threshold=${settings.decay_min_messages} msgs / ${settings.decay_window_days} days, percent=${Math.round((Number(settings.decay_percent) || 0) * 100)}%\n` +
        `**Level curve factor:** ${settings.level_xp_factor} (Level L starts at L²×factor)\n` +
        `**Commands allowed in:** ${chanText}\n` +
        `**Level→Role mappings:**\n${roleText}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
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

      const updated = updateGuildSettings(guildId, patch);

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

      const updated = updateGuildSettings(guildId, patch);

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

        await interaction.reply({
          content: `Mapped ${role} to **Lvl ${level}** (remove after **${dropdays}** day(s) below).`,
                                flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "remove") {
        const role = interaction.options.getRole("role", true);
        deleteLevelRole(guildId, role.id);

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
        await interaction.reply({
          content: `Commands are now allowed in <#${ch.id}>.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "remove") {
        const ch = interaction.options.getChannel("channel", true);
        removeAllowedCommandChannel(guildId, ch.id);
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
          }
        } else if (url.startsWith("@")) {
          // Bare @username - normalize to remove leading @
          const username = url.substring(1);
          channelId = username;
          channelName = "@" + username;
          fullUrl = `https://www.youtube.com/@${username}`;
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
          const thumbnail = !channelId || channelId.startsWith("@") 
            ? ""
            : `https://i.ytimg.com/vi/${channelId}/maxresdefault.jpg`;

          try {
            addYoutubeChannel(guildId, channelId, normalizedChannelName, url, thumbnail);
            
            let replyMsg = `Subscribed to **@${normalizedChannelName}**. I'll notify when they go live.`;
          if (channelId.startsWith("@")) {
            replyMsg += "\n\nNote: @username detected. I will attempt to resolve the actual channel ID from YouTube.";
          }
          
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
        updateGuildSettings(guildId, { youtube_notification_channel_id: ch.id });
        
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
        updateGuildSettings(guildId, { youtube_polling_interval_minutes: minutes });
        
        await interaction.reply({
          content: `YouTube polling interval set to **${minutes}** minute(s).`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
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
