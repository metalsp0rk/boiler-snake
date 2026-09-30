const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const {
  getGuildSettings,
  updateGuildSettings,
  normalizeYoutubeName,
  getYoutubeChannels,
  addYoutubeChannel,
  removeYoutubeChannel,
} = require("../../db");
const { requireStaffFromContext } = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");
const { discordCommunityId } = require("../../platform/community");
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
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) => {
      const sub = sc
        .setName("remove")
        .setDescription("Unsubscribe from a YouTube channel.");
      sub.addStringOption((opt) =>
        opt
          .setName("channel")
          .setDescription("YouTube channel to unsubscribe from")
          .setRequired(true)
          .setAutocomplete(true),
      );
      return sub;
    })
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("List all subscribed channels."),
    ),

  new SlashCommandBuilder()
    .setName("setyoutube")
    .setDescription("Configure YouTube notification settings (staff).")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommand((sc) => {
      const sub = sc
        .setName("channel")
        .setDescription("Set channel for YouTube notifications.");
      sub.addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Channel to send notifications to")
          .setRequired(true),
      );
      return sub;
    })
    .addSubcommand((sc) => {
      const sub = sc
        .setName("interval")
        .setDescription("Set RSS polling interval.");
      sub.addIntegerOption((opt) =>
        opt
          .setName("minutes")
          .setDescription("Polling interval in minutes (1-60)")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(60),
      );
      return sub;
    })
    .addSubcommand((sc) => {
      const sub = sc
        .setName("uploadrole")
        .setDescription("Set role to mention for video uploads.");
      sub.addRoleOption((opt) =>
        opt
          .setName("role")
          .setDescription(
            "Role to mention when videos are uploaded (leave empty to disable)",
          )
          .setRequired(false),
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
        .setRequired(true),
    )
    .addBooleanOption((opt) =>
      opt
        .setName("simple")
        .setDescription("Use simple text-based embed instead of rich embed")
        .setRequired(false),
    ),
];

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleYoutube(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireStaffFromContext(commandCtx))) return;

  // Repository key: integer community id (resolved by the context builder).
  const communityId = commandCtx.communityId;
  // Display/audit key: the external (Discord) snowflake.
  const guildId = commandCtx.externalGuildId;

  const sub = commandCtx.subcommand;

  if (sub === "add") {
    const url = commandCtx.options.getString("url", true);

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
          channelName = normalizeYoutubeName(resolved.name); // Store without @ prefix
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
      console.log(resolved);
      if (resolved) {
        channelId = resolved.id;
        channelName = normalizeYoutubeName(resolved.name); // Store without @ prefix
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
      await commandCtx.reply({
        content:
          "Invalid YouTube URL. Please use:\n- Full channel URL with @username: `https://www.youtube.com/@SomeChannel`\n- Full channel URL with ID: `https://www.youtube.com/channel/UCxxxxxxxxxxxxx`\n- Numeric channel ID: `UCxxxxxxxxxxxxx`",
        sensitive: true,
      });
      return;
    }

    const normalizedChannelName = normalizeYoutubeName(channelName);
    let thumbnail = "";
    if (channelId && !channelId.startsWith("@")) {
      const channelInfo = await fetchChannelInfo(channelId);
      console.log(
        `[youtube] /youtube add - fetchChannelInfo result for ${channelId}:`,
        JSON.stringify(channelInfo, null, 2),
      );
      if (channelInfo && channelInfo.thumbnail_url) {
        thumbnail = channelInfo.thumbnail_url;
        console.log(`[youtube] Using API thumbnail: ${thumbnail}`);
      } else {
        thumbnail = `https://i.ytimg.com/vi/${channelId}/maxresdefault.jpg`;
        console.log(`[youtube] Using fallback thumbnail: ${thumbnail}`);
      }
    }

    try {
      addYoutubeChannel(
        communityId,
        channelId,
        normalizedChannelName,
        url,
        thumbnail,
      );

      recordSlashAudit({
        communityId,
        actorUserId: commandCtx.userId,
        action: "youtube.channel_add",
        targetType: "youtube_channel",
        targetId: channelId,
        details: { channel_name: normalizedChannelName, url },
      });

      let replyMsg = `Subscribed to **@${normalizedChannelName}**. I'll notify when they go live.`;
      if (channelId.startsWith("@")) {
        replyMsg +=
          "\n\nNote: @username detected. I will attempt to resolve the actual channel ID from YouTube.";
      }

      await logConfigChange(commandCtx.outbound, guildId, {
        title: "YouTube subscription added",
        command: "/youtube add",
        actor: commandCtx.user,
        changes: [
          `Channel: **@${normalizedChannelName}**`,
          `ID: \`${channelId}\``,
          `URL: ${url}`,
        ],
      }).catch(() => {});

      await commandCtx.reply({
        content: replyMsg,
        sensitive: true,
      });
    } catch (err) {
      console.error("[youtube] Add error:", err);
      await commandCtx.reply({
        content: `Failed to add subscription: ${err?.message || err}`,
        sensitive: true,
      });
    }
    return;
  }

  if (sub === "remove") {
    const channelId = commandCtx.options.getString("channel", true);

    // Get channel by ID
    let foundChannel = null;
    const channels = getYoutubeChannels(communityId);
    for (const c of channels) {
      if (
        normalizeYoutubeName(c.id) === normalizeYoutubeName(channelId) &&
        c.community_id === communityId
      ) {
        foundChannel = c;
        break;
      }
    }

    if (!foundChannel) {
      await commandCtx.reply({
        content: "No subscription found.",
        sensitive: true,
      });
      return;
    }

    const channelsBefore = getYoutubeChannels(communityId).length;

    let removed = false;
    let removeErr = null;
    try {
      removed = removeYoutubeChannel(communityId, channelId);
      console.log(`[youtube] Remove debug:`, {
        guildId,
        channelId,
        foundChannel: foundChannel?.channel_name,
        channelsBefore,
        removed,
        error: null,
      });
    } catch (err) {
      removeErr = err;
      console.error("[youtube] Remove error:", err);
    }

    const channelsAfter = getYoutubeChannels(communityId).length;
    if (!removed && channelsAfter < channelsBefore) {
      // Actually removed but function returned false - DB issue?
      removed = true;
    }

    if (removed) {
      recordSlashAudit({
        communityId,
        actorUserId: commandCtx.userId,
        action: "youtube.channel_remove",
        targetType: "youtube_channel",
        targetId: foundChannel.id || channelId,
        details: { channel_name: foundChannel.channel_name },
      });
      await logConfigChange(commandCtx.outbound, guildId, {
        title: "YouTube subscription removed",
        command: "/youtube remove",
        actor: commandCtx.user,
        changes: [
          `Channel: **${foundChannel.channel_name}**`,
          `ID: \`${foundChannel.id || channelId}\``,
        ],
      }).catch(() => {});
      await commandCtx.reply({
        content: `Unsubscribed from **${foundChannel.channel_name}**.`,
        sensitive: true,
      });
    } else {
      await commandCtx.reply({
        content:
          `Failed to unsubscribe${
            removeErr ? `: ${removeErr?.message || removeErr}` : ""
          } (subscription still present).`,
        sensitive: true,
      });
    }
    return;
  }

  if (sub === "list") {
    const channels = getYoutubeChannels(communityId);

    if (!channels.length) {
      await commandCtx.reply({
        content: "No YouTube channels subscribed.",
        sensitive: true,
      });
      return;
    }

    const guildSettings = getGuildSettings(communityId);
    const notificationChannel = guildSettings.youtube_notification_channel_id
      ? `<#${guildSettings.youtube_notification_channel_id}>`
      : "_Not configured_";

    const lines = channels.map((c) => {
      const channelNameDisplay = "@" + normalizeYoutubeName(c.channel_name);
      let info = `• **${channelNameDisplay}**`;

      if (c.id.startsWith("@")) {
        info += ` (*@username detected, resolving at runtime*)\n  URL: <${c.channel_url}>`;
      } else {
        info += `\n  ID: \`${c.id}\`\n  URL: <${c.channel_url}>`;
      }

      return info;
    });

    await commandCtx.reply({
      content:
        `**YouTube subscriptions** (${channels.length})\n` +
        `Notification channel: ${notificationChannel}\n\n` +
        lines.join("\n"),
      sensitive: true,
    });
    return;
  }
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleSetYoutube(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireStaffFromContext(commandCtx))) return;

  const communityId = commandCtx.communityId;
  const guildId = commandCtx.externalGuildId;
  const settings = getGuildSettings(communityId);

  const sub = commandCtx.subcommand;

  if (sub === "channel") {
    const ch = commandCtx.options.getChannel("channel", true);
    const before = settings.youtube_notification_channel_id;
    updateGuildSettings(communityId, { youtube_notification_channel_id: ch.id });
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "youtube.notify_channel_set",
      targetType: "channel",
      targetId: ch.id,
      details: { previous_channel_id: before ?? null },
    });
    await logConfigChange(commandCtx.outbound, guildId, {
      title: "YouTube notification channel set",
      command: "/setyoutube channel",
      actor: commandCtx.user,
      changes: [
        before
          ? `Channel: <#${before}> → <#${ch.id}>`
          : `Channel: *none* → <#${ch.id}>`,
      ],
    }).catch(() => {});

    await commandCtx.reply({
      content: `YouTube notifications will be sent to <#${ch.id}>.`,
      sensitive: true,
    });
    return;
  }

  if (sub === "interval") {
    const minutes = commandCtx.options.getInteger("minutes", true);
    if (minutes < 1 || minutes > 60) {
      await commandCtx.reply({
        content: "Polling interval must be between 1 and 60 minutes.",
        sensitive: true,
      });
      return;
    }
    const before = settings.youtube_polling_interval_minutes;
    updateGuildSettings(communityId, { youtube_polling_interval_minutes: minutes });
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "youtube.polling_interval_set",
      targetType: "guild",
      targetId: guildId,
      details: { previous_minutes: before ?? null, minutes },
    });
    await logConfigChange(commandCtx.outbound, guildId, {
      title: "YouTube polling interval set",
      command: "/setyoutube interval",
      actor: commandCtx.user,
      changes: [`Interval: ${before} → **${minutes}** minute(s)`],
    }).catch(() => {});

    await commandCtx.reply({
      content: `YouTube polling interval set to **${minutes}** minute(s).`,
      sensitive: true,
    });
    return;
  }

  if (sub === "uploadrole") {
    const role = commandCtx.options.getRole("role", false);
    const before = settings.youtube_upload_role_id;
    updateGuildSettings(communityId, {
      youtube_upload_role_id: role ? role.id : null,
    });
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "youtube.upload_role_set",
      targetType: "role",
      targetId: role ? role.id : guildId,
      details: { role_id: role ? role.id : null, previous_role_id: before ?? null },
    });
    const afterLabel = role ? `<@&${role.id}>` : "*none*";
    const beforeLabel = before ? `<@&${before}>` : "*none*";
    await logConfigChange(commandCtx.outbound, guildId, {
      title: "YouTube upload mention role set",
      command: "/setyoutube uploadrole",
      actor: commandCtx.user,
      changes: [`Role: ${beforeLabel} → ${afterLabel}`],
    }).catch(() => {});

    await commandCtx.reply({
      content: role
        ? `Upload notifications will mention <@&${role.id}>.`
        : `Upload notifications will no longer mention a role.`,
      sensitive: true,
    });
    return;
  }
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleTestNotification(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireStaffFromContext(commandCtx))) return;

  const communityId = commandCtx.communityId;

  const url = commandCtx.options.getString("channel", true);

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
    await commandCtx.reply({
      content: "Invalid YouTube URL.",
      sensitive: true,
    });
    return;
  }

  const channels = getYoutubeChannels(communityId);
  let existingChannel = null;
  for (const c of channels) {
    if (
      normalizeYoutubeName(c.channel_name).toLowerCase() ===
      normalizeYoutubeName(channelName).toLowerCase()
    ) {
      existingChannel = c;
      break;
    }
  }

  if (!existingChannel) {
    let thumbnail = "";
    if (channelId && !channelId.startsWith("@")) {
      const channelInfo = await fetchChannelInfo(channelId);
      console.log(
        `[youtube] /testnotification add - fetchChannelInfo result for ${channelId}:`,
        JSON.stringify(channelInfo, null, 2),
      );
      if (channelInfo && channelInfo.thumbnail_url) {
        thumbnail = channelInfo.thumbnail_url;
        console.log(`[youtube] Using API thumbnail: ${thumbnail}`);
      } else {
        thumbnail = `https://i.ytimg.com/vi/${channelId}/maxresdefault.jpg`;
        console.log(`[youtube] Using fallback thumbnail: ${thumbnail}`);
      }
    }
    addYoutubeChannel(
      communityId,
      channelId,
      normalizeYoutubeName(channelName),
      channelUrl,
      thumbnail,
    );

    existingChannel = getYoutubeChannels(communityId).find(
      (c) =>
        normalizeYoutubeName(c.channel_name) ===
        normalizeYoutubeName(channelName),
    );
  }

  console.log(
    `[testnotification] Channel data from DB:`,
    JSON.stringify(existingChannel, null, 2),
  );

  if (!existingChannel || !existingChannel.id) {
    await commandCtx.reply({
      content: "Could not find or subscribe to the channel.",
      sensitive: true,
    });
    return;
  }

  const feed = await fetchYouTubeFeed(existingChannel.id);
  if (!feed || !feed.items || !feed.items.length) {
    await commandCtx.reply({
      content: "Could not fetch videos from this channel.",
      sensitive: true,
    });
    return;
  }

  const entry = feed.items[0];
  const videoInfo = extractVideoInfo(entry);

  if (!videoInfo || !videoInfo.videoId) {
    await commandCtx.reply({
      content: "Could not extract video information.",
      sensitive: true,
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
    await commandCtx.reply({
      content: "Latest video entry type could not be determined.",
      sensitive: true,
    });
    return;
  }

  console.log(
    `[testnotification] Channel thumbnail URL:`,
    existingChannel.thumbnail_url,
  );

  const useSimpleEmbed = commandCtx.options.getBoolean("simple") || false;

  let content = `Test ${notificationType} notification for **${channelName}**`;
  let embeds = [];

  if (notificationType === "live") {
    embeds = [createLiveEmbed(existingChannel, videoInfo, channelUrl)];
  } else {
    const settings = getGuildSettings(communityId);
    const uploadRoleId = settings.youtube_upload_role_id;

    if (useSimpleEmbed) {
      const simpleResult = createSimpleUploadEmbed(
        existingChannel,
        videoInfo,
        channelUrl,
      );
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

  // Public reply (no `sensitive`): matches the previous non-ephemeral
  // interaction.reply. Embeds are the ticker's existing EmbedBuilder outputs
  // (ticker.js stays untouched; the adapter passes toJSON-able embeds through).
  await commandCtx.reply({
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
  const communityId = discordCommunityId(interaction.guild.id);
  if (communityId == null) {
    // No community row registered yet — nothing to suggest.
    await interaction.respond([]);
    return;
  }
  const channels = getYoutubeChannels(communityId);

  const focusedValue = interaction.options.getFocused().toLowerCase();
  // Deduplicate by normalized channel name, keeping first occurrence
  const seenNames = new Set();
  const deduped = channels.filter((c) => {
    const normalizedName = normalizeYoutubeName(c.channel_name).toLowerCase();
    if (seenNames.has(normalizedName)) return false;
    seenNames.add(normalizedName);
    return true;
  });

  const filtered = deduped
    .filter((c) =>
      normalizeYoutubeName(c.channel_name).toLowerCase().includes(focusedValue),
    )
    .slice(0, 25); // Discord limit is 25 choices

  await interaction.respond(
    filtered.map((c) => ({
      name: "@" + normalizeYoutubeName(c.channel_name),
      value: c.id,
    })),
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
  // Router API flag (roadmap/fluxer.md § Handler migration rule): these slash
  // handlers receive a CommandContext. Autocomplete stays on the interaction arm.
  handlerApi: {
    youtube: "context",
    setyoutube: "context",
    testnotification: "context",
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
