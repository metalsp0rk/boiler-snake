const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require("discord.js");
const {
  getGuildSettings,
  updateGuildSettings,
  normalizeYoutubeName,
  getYoutubeChannels,
  addYoutubeChannel,
  removeYoutubeChannel,
} = require("../../db");
const { isStaff } = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");
const {
  startYoutubeTicker,
  createSimpleUploadEmbed,
  fetchChannelInfo,
  lookupChannelByName,
  isLiveVideo,
  isVideoUpload,
  extractVideoInfo,
  createLiveEmbed,
  createUploadEmbed,
  fetchYouTubeFeed,
} = require("./ticker");

const staffPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
      .setName("youtube")
      .setDescription("Manage YouTube channel subscriptions (staff).")
      .setDefaultMemberPermissions(staffPerms)
      .addSubcommand((sc) =>
        sc
          .setName("add")
          .setDescription("Subscribe to a YouTube channel.")
          .addStringOption((opt) =>
            opt
              .setName("url")
              .setDescription("YouTube channel URL or @username")
              .setRequired(true)
          )
      )
      .addSubcommand((sc) => {
        const sub = sc.setName("remove").setDescription("Unsubscribe from a YouTube channel.");
        sub.addStringOption((opt) =>
          opt
            .setName("channel")
            .setDescription("YouTube channel to unsubscribe from")
            .setRequired(true)
            .setAutocomplete(true)
        );
        return sub;
      })
      .addSubcommand((sc) =>
        sc.setName("list").setDescription("List all subscribed channels.")
      ),

  new SlashCommandBuilder()
      .setName("setyoutube")
      .setDescription("Configure YouTube notification settings (staff).")
      .setDefaultMemberPermissions(staffPerms)
      .addSubcommand((sc) => {
        const sub = sc.setName("channel").setDescription("Set channel for YouTube notifications.");
        sub.addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel to send notifications to")
            .setRequired(true)
        );
        return sub;
      })
      .addSubcommand((sc) => {
        const sub = sc.setName("interval").setDescription("Set RSS polling interval.");
        sub.addIntegerOption((opt) =>
          opt
            .setName("minutes")
            .setDescription("Polling interval in minutes (1-60)")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(60)
        );
        return sub;
      })
      .addSubcommand((sc) => {
        const sub = sc.setName("uploadrole").setDescription("Set role to mention for video uploads.");
        sub.addRoleOption((opt) =>
          opt
            .setName("role")
            .setDescription("Role to mention when videos are uploaded (leave empty to disable)")
            .setRequired(false)
        );
        return sub;
      }),

  new SlashCommandBuilder()
      .setName("testnotification")
      .setDescription("Send a test notification for a YouTube channel (staff).")
      .setDefaultMemberPermissions(staffPerms)
      .addStringOption((opt) =>
        opt
          .setName("channel")
          .setDescription("YouTube channel URL to test")
          .setRequired(true)
      )
      .addBooleanOption((opt) =>
        opt
          .setName("simple")
          .setDescription("Use simple text-based embed instead of rich embed")
          .setRequired(false)
      ),
];

async function handleYoutube(interaction, ctx) {
  const { client } = ctx;
  const guildId = interaction.guildId;
  const settings = getGuildSettings(guildId);
  const admin = isStaff(interaction);

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

async function handleSetYoutube(interaction, ctx) {
  const { client } = ctx;
  const guildId = interaction.guildId;
  const settings = getGuildSettings(guildId);
  const admin = isStaff(interaction);

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

async function handleTestNotification(interaction, ctx) {
  const { client } = ctx;
  const guildId = interaction.guildId;
  const settings = getGuildSettings(guildId);
  const admin = isStaff(interaction);

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

async function handleYoutubeAutocomplete(interaction) {
  if (!interaction.guild) {
  await interaction.respond([]);
  return;
  }
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

function start(client) {
  startYoutubeTicker(client);
}

module.exports = {
  name: "youtube",
  commands,
  handlers: {
    youtube: handleYoutube,
    setyoutube: handleSetYoutube,
    testnotification: handleTestNotification,
  },
  autocomplete: {
    youtube: handleYoutubeAutocomplete,
  },
  start,
  startYoutubeTicker,
  createSimpleUploadEmbed,
  fetchChannelInfo,
  lookupChannelByName,
  isLiveVideo,
  isVideoUpload,
  extractVideoInfo,
  createLiveEmbed,
  createUploadEmbed,
  fetchYouTubeFeed,
};
