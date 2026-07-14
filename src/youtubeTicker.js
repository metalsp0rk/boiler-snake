const https = require("https");
const { normalizeYoutubeName, getAllYoutubeChannels, getGuildSettings, getYoutubeChannelById, addYoutubeChannel, updateYoutubeChannelLastChecked, updateGuildSettings } = require("./db");

async function lookupChannelByName(username) {
  if (!process.env.YOUTUBE_API_KEY) {
    return null;
  }

  try {
    // Search for channels matching this username
    const response = await new Promise((resolve, reject) => {
      const options = {
        hostname: "www.googleapis.com",
        port: 443,
        path: `/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(username)}&maxResults=5&key=${process.env.YOUTUBE_API_KEY}`,
        method: "GET"
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on("error", reject);
      req.end();
    });

    if (response.items && response.items.length > 0) {
      // Find exact or close match
      for (const item of response.items) {
        const channelTitle = item.snippet.channelTitle || "";
        // Exact match or name contains username (case insensitive)
        if (channelTitle.toLowerCase() === username.toLowerCase()) {
          console.log(`[youtube] Resolved @${username} to ${item.snippet.channelId}`);

          return {
            id: item.snippet.channelId,
            name: normalizeYoutubeName(channelTitle),
            url: `https://www.youtube.com/channel/${item.snippet.channelId}`,
          };
        }
      }

      // Return first match if no exact match
      const item = response.items[0];
      console.log(`[youtube] Used approximate match for @${username}: ${item.snippet.channelTitle}`);

      return {
        id: item.snippet.channelId,
        name: normalizeYoutubeName(item.snippet.channelTitle),
        url: `https://www.youtube.com/channel/${item.snippet.channelId}`,
      };
    }

    console.log(`[youtube] No channel found for @${username}`);
  } catch (err) {
    console.log(`[youtube] Could not fetch channel info for @${username}:`, err?.message || err);
  }

  return null;
}

// --- YouTube Data API v3 Integration ---

async function fetchYouTubeFeed(channelId) {
  if (!process.env.YOUTUBE_API_KEY) {
    console.warn("[youtube] YOUTUBE_API_KEY not set in environment - YouTube notifications disabled");
    return null;
  }

  try {
    // Step 1: Get uploads playlist ID
    const videosXml = require("rss-parser");

    const channelResponse = await new Promise((resolve, reject) => {
      const options = {
        hostname: "www.googleapis.com",
        port: 443,
        path: `/youtube/v3/channels?part=contentDetails&id=${channelId}&key=${process.env.YOUTUBE_API_KEY}`,
        method: "GET"
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on("error", reject);
      req.end();
    });

    if (!channelResponse.items || channelResponse.items.length === 0) {
      console.log(`[youtube] No channel data found for ${channelId}`);
      return null;
    }

    const uploadsPlaylistId = channelResponse.items[0].contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) {
      console.log(`[youtube] Channel ${channelId} has no uploads playlist`);
      return null;
    }

    // Step 2: Get videos from uploads playlist
    const videoResponse = await new Promise((resolve, reject) => {
      const options = {
        hostname: "www.googleapis.com",
        port: 443,
        path: `/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${uploadsPlaylistId}&key=${process.env.YOUTUBE_API_KEY}`,
        method: "GET"
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on("error", reject);
      req.end();
    });

    // Convert to RSS feed format for compatibility
    // Include liveBroadcastContent if available for accurate live detection
    return {
      title: `YouTube channel ${channelId}`,
      items: (videoResponse.items || []).map(item => ({
        id: item.snippet.resourceId?.videoId,
        title: item.snippet.title,
        pubDate: item.snippet.publishedAt,
        description: item.snippet.description,
        liveBroadcastContent: item.snippet.liveBroadcastContent, // "none", "live", "upcoming"
        "media:thumbnail": {
          url: item.snippet.thumbnails?.default?.url
        }
      }))
    };
  } catch (err) {
    console.error(`[youtube] Failed to fetch feed for channel ${channelId}:`, err?.message || err);
    return null;
  }
}

function isLiveVideo(entry) {
  if (!entry) return false;

  // YouTube Data API v3 gives us broadcast content type
  const broadcastContent = entry.liveBroadcastContent || entry.snippet?.liveBroadcastContent || "";

  if (broadcastContent === "live" || broadcastContent === "upcoming") {
    return true;
  }

  return false;
}

function isVideoUpload(entry) {
  if (!entry) return false;

  const broadcastContent = entry.liveBroadcastContent || entry.snippet?.liveBroadcastContent || "";

  return broadcastContent === "none" || !broadcastContent;
}

function extractVideoInfo(entry) {
  if (!entry) return null;

  const videoId = entry["yt:videoId"] || entry.id?.split(":").pop() || entry.snippet?.resourceId?.videoId;
  const title = entry.title || "Untitled Video";
  const published = entry.pubDate ? new Date(entry.pubDate).getTime() :
    entry.snippet?.publishedAt ? new Date(entry.snippet.publishedAt).getTime() :
      Date.now();

  let thumbnail = "";
  if (entry["media:thumbnail"]) {
    thumbnail = Array.isArray(entry["media:thumbnail"])
      ? entry["media:thumbnail"][0].url
      : entry["media:thumbnail"].url;
  } else if (entry.snippet?.thumbnails?.default?.url) {
    thumbnail = entry.snippet.thumbnails.default.url;
  }

  return { videoId, title, published, thumbnail };
}

async function processChannel(client, guildId, channelData) {
  const settings = getGuildSettings(guildId);

  if (!settings.youtube_notification_channel_id) {
    console.log(`[youtube] No notification channel configured for guild ${guildId}`);
    return;
  }

  let channelId = channelData.id;
  let channelName = channelData.channel_name;

  // Check if we need to resolve @username
  const hasUnresolvedName = channelName.startsWith("@");
  const needsResolution = hasUnresolvedName && !channelId.startsWith("UC") && !channelId.startsWith("HC");

  if (needsResolution) {
    const username = normalizeYoutubeName(channelName);
    console.log(`[youtube] Resolving @${username}...`);

    const resolved = await lookupChannelByName(username);
    if (resolved) {
      channelId = resolved.id;
      addYoutubeChannel(guildId, channelId, resolved.name, resolved.url, "");

      console.log(`[youtube] Resolved @${username} to ${channelId} (${resolved.name})`);
    } else {
      console.log(`[youtube] Could not resolve @${username}, skipping`);
      return;
    }
  }

  const displayName = hasUnresolvedName ? "@" + normalizeYoutubeName(channelName) : channelName;

  // Get channel URL
  let channelUrl = channelData.channel_url;
  if (!channelUrl && channelId) {
    channelUrl = `https://www.youtube.com/channel/${channelId}`;
  }

  // Get last-checked time
  const channelWithLastChecked = getYoutubeChannelById(guildId, channelId);
  const lastChecked = channelData.last_checked || (channelWithLastChecked ? channelWithLastChecked.last_checked : null);

  console.log(`[youtube] Checking ${displayName} (${channelId}) - last checked: ${lastChecked ? new Date(lastChecked).toISOString() : 'never'}`);

  const feed = await fetchYouTubeFeed(channelId);
  if (!feed) return;

  if (!feed.items || !feed.items.length) {
    console.log(`[youtube] No videos found for ${channelName}`);
    updateYoutubeChannelLastChecked(channelId, Date.now());
    return;
  }

  // Sort entries by published date (newest first)
  feed.items.sort((a, b) => {
    const aDate = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const bDate = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return bDate - aDate;
  });

  const lastVideoId = channelData.last_video_id || (channelWithLastChecked ? channelWithLastChecked.last_video_id : null);

  // Track if we found any uploads in the time window
  let foundUploadInWindow = false;

  for (const entry of feed.items) {
    // Track both live streams and regular uploads
    let isLive, notificationType;

    if (isLiveVideo(entry)) {
      isLive = true;
      notificationType = "live";
    } else if (isVideoUpload(entry)) {
      isLive = false;
      notificationType = "upload";
    } else {
      continue; // Skip non-video entries
    }

    const info = extractVideoInfo(entry);
    if (!info || !info.videoId) continue;

    // Skip if we've already notified about this video (using last_video_id as snapshot)
    if (lastVideoId && info.videoId === lastVideoId) {
      console.log(`[youtube] Skipping ${info.title} - already notified (matches last_video_id: ${lastVideoId})`);
      continue;
    }

    // For uploads, check if published within the time window
    if (notificationType === "upload") {
      if (lastChecked) {
        if (info.published <= lastChecked) {
          console.log(`[youtube] Skipping ${info.title} - already checked (published: ${new Date(info.published).toISOString()}, last checked: ${new Date(lastChecked).toISOString()})`);
          // Stop processing older videos
          break;
        }
      } else {
        // Never checked before: only notify on videos from the last hour
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        if (info.published <= oneHourAgo) {
          console.log(`[youtube] Skipping ${info.title} - published too old (published: ${new Date(info.published).toISOString()}, cutoff: ${new Date(oneHourAgo).toISOString()})`);
          continue;
        }
      }
    }

    // Check if already notified
    const alreadyNotified = channelData.last_video_id === info.videoId;

    if (alreadyNotified) {
      console.log(`[youtube] Already notified about ${info.title} (${notificationType}) for ${channelName}`);
      // For uploads that were previously notified but are newer than lastChecked, continue
      if (notificationType === "upload") {
        continue;
      }
      // Stop processing older videos if we hit a previously seen one
      break;
    }

    foundUploadInWindow = true;

    const useSimpleEmbed = notificationType === "upload";
    await sendNotification(client, guildId, settings.youtube_notification_channel_id, channelData, info, channelUrl, notificationType, useSimpleEmbed);
  }

  // Update last-checked time and store the most recent video ID
  const newLastVideoId = feed.items[0]?.id || null;
  updateYoutubeChannelLastChecked(channelId, Date.now(), newLastVideoId);
}

function createLiveEmbed(channelData, videoInfo, channelUrl) {
  const discord = require("discord.js");

  const embed = new discord.EmbedBuilder()
    .setColor("#FF0000")
    .setAuthor({
      name: `${channelData.channel_name} just went live!`,
      url: channelUrl,
      iconURL: channelData.thumbnail_url || undefined
    })
    .setTitle(videoInfo.title)
    .setDescription(`[Watch Live](https://youtu.be/${videoInfo.videoId})`)
    .setThumbnail(channelData.thumbnail_url || undefined)
    .setImage(videoInfo.thumbnail ? videoInfo.thumbnail.replace(/=s\d+/, "=s1280") : undefined)
    .addFields([
      { name: "Channel", value: `[${channelData.channel_name}](${channelUrl})`, inline: true },
      { name: "Video ID", value: videoInfo.videoId, inline: true }
    ])
    .setTimestamp(new Date(videoInfo.published))
    .setFooter({
      text: "YouTube Notification",
      iconURL: "https://www.youtube.com/img/desktop/yt_120x64.png"
    });
  console.log(`[createLiveEmbed] Channel thumbnail URL:`, channelData.thumbnail_url);

  return embed;
}

function createSimpleUploadEmbed(channelData, videoInfo, channelUrl) {
  const discord = require("discord.js");

  const channelName = channelData.channel_name || "Unknown Channel";
  const videoTitle = videoInfo.title || "Untitled Video";

  const content = `${channelName} uploaded a new video!\nhttps://youtu.be/${videoInfo.videoId}`;

  return { content, embed: null };
}

function createUploadEmbed(channelData, videoInfo, channelUrl) {
  const discord = require("discord.js");

  const embed = new discord.EmbedBuilder()
    .setColor("#FFA500")
    .setAuthor({
      name: `${channelData.channel_name}`,
      url: channelUrl,
      iconURL: channelData.thumbnail_url || undefined
    })
    .setTitle(videoInfo.title)
    .setDescription(`[Watch Video](https://youtu.be/${videoInfo.videoId})`)
    .setThumbnail(channelData.thumbnail_url || undefined)
    .setImage(videoInfo.thumbnail ? videoInfo.thumbnail.replace(/=s\d+/, "=s1280") : undefined)
    .setTimestamp(new Date(videoInfo.published))
    .setFooter({
      text: "YouTube",
      iconURL: "https://www.youtube.com/img/desktop/yt_120x64.png"
    });
  console.log(`[createUploadEmbed] Channel thumbnail URL:`, channelData.thumbnail_url);

  return embed;
}

async function sendNotification(client, guildId, channelId, channelData, videoInfo, channelUrl, notificationType, useSimpleEmbed = true) {
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      console.error(`[youtube] Could not find notification channel ${channelId}`);
      return;
    }

    let content = "";
    let embeds = [];

    const settings = getGuildSettings(guildId);
    const uploadRoleId = settings.youtube_upload_role_id;

    if (notificationType === "live") {
      content = `@everyone ${channelData.channel_name} just went live!`;
      embeds = [createLiveEmbed(channelData, videoInfo, channelUrl)];
    } else {
      let roleMention = "";
      if (uploadRoleId) {
        roleMention = `<@&${uploadRoleId}> `;
      }

      if (useSimpleEmbed) {
        const simpleResult = createSimpleUploadEmbed(channelData, videoInfo, channelUrl);
        content = `${roleMention}${simpleResult.content}`;
        embeds = [];
      } else {
        content = `${roleMention}${channelData.channel_name} uploaded a new video!`;
        embeds = [createUploadEmbed(channelData, videoInfo, channelUrl)];
      }
    }

    const message = await channel.send({
      content: content,
      allowedMentions: { parse: [] },
      embeds: embeds
    });

    console.log(`[youtube] Sent notification for ${videoInfo.title} in guild ${guildId}`);
  } catch (err) {
    console.error(`[youtube] Failed to send notification for ${videoInfo?.title}:`, err?.message || err);
  }
}

async function runYoutubeTick(client) {
  console.log(`[youtube] Running tick`);
  // Check for API key before doing any work
  if (!process.env.YOUTUBE_API_KEY) {
    console.log(`[youtube] YouTube Data API v3: YOUTUBE_API_KEY not configured - live notifications disabled`);
    return;
  }

  const channels = getAllYoutubeChannels();
  console.log(channels)

  if (!channels.length) {
    console.log(`[youtube] No channels to monitor`);
    return;
  }

  // Deduplicate by normalized name per guild
  // const seenPerGuild = new Map();
  // const deduped = channels.filter(c => {
  //   const normalizedName = normalizeYoutubeName(c.channel_name);
  //   const key = `${c.guild_id}:${normalizedName}`;
  //   if (seenPerGuild.has(key)) return false;
  //   seenPerGuild.set(key, true);
  //   return true;
  // });

  console.log(`[youtube] Checking ${channels.length} subscribed channels (after deduplication)`);

  for (const channel of channels) {
    try {
      await processChannel(client, channel.guild_id, channel);
    } catch (err) {
      console.error(`[youtube] Error processing channel ${channel.channel_name}:`, err?.message || err);
    }
  }
}

function startYoutubeTicker(client) {
  if (!process.env.YOUTUBE_API_KEY) {
    console.log("[youtube] Skipping ticker startup - YOUTUBE_API_KEY not configured");
    return;
  }

  const msToNext5Minutes = 5 * 60000 - (Date.now() % (5 * 60000));

  runYoutubeTick(client).catch(() => { });

  setTimeout(() => {
    runYoutubeTick(client).catch(() => { });

    setInterval(() => {
      runYoutubeTick(client).catch(() => { });
    }, 5 * 60000);
  }, msToNext5Minutes);
}

async function fetchChannelInfo(channelId) {
  if (!process.env.YOUTUBE_API_KEY) return null;

  try {
    const response = await new Promise((resolve, reject) => {
      const options = {
        hostname: "www.googleapis.com",
        port: 443,
        path: `/youtube/v3/channels?part=snippet&id=${channelId}&key=${process.env.YOUTUBE_API_KEY}`,
        method: "GET"
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on("error", reject);
      req.end();
    });

    if (response.items && response.items.length > 0) {
      const snippet = response.items[0].snippet;
      const thumbnails = snippet.thumbnails || {};
      console.log(`[youtube] fetchChannelInfo raw thumbnails:`, JSON.stringify(thumbnails, null, 2));
      return {
        id: channelId,
        name: snippet.title,
        url: `https://www.youtube.com/channel/${channelId}`,
        thumbnail_url: thumbnails.default?.url || thumbnails.medium?.url || thumbnails.high?.url || "",
      };
    }
  } catch (err) {
    console.log(`[youtube] Could not fetch channel info for ${channelId}:`, err?.message || err);
  }

  return null;
}

module.exports = { startYoutubeTicker, createSimpleUploadEmbed, fetchChannelInfo, lookupChannelByName, isLiveVideo, isVideoUpload, extractVideoInfo, createLiveEmbed, createUploadEmbed, createSimpleUploadEmbed, fetchYouTubeFeed };
