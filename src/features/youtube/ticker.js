const https = require("https");
const { Color } = require("../../core/theme");
const { registerJob } = require("../../core/scheduler");
const {
  normalizeYoutubeName,
  getAllYoutubeChannels,
  getGuildSettings,
  getYoutubeChannelById,
  addYoutubeChannel,
  updateYoutubeChannelLastChecked,
  markYoutubeLiveNotified,
  markYoutubeChannelCheckedAt,
  updateGuildSettings,
} = require("../../db");
const { getDiscordOutbound } = require("../../platform/discord/outbound");

/**
 * Resolve the OutboundClient that posts for one community row
 * (roadmap/fluxer.md § Scheduler jobs: "Row's communityId → client").
 *
 * Accepts the PR 7 supervisor `{ discord, fluxer, clientForCommunity }`, a
 * pre-resolved OutboundClient, or a legacy raw discord.js client (transitional
 * shim so pre-cutover call sites — e.g. the EventSub dispatcher — keep working).
 * Returns null when no ready client exists; callers log and skip the row.
 *
 * @param {object|null} supervisor
 * @param {number} communityId
 * @returns {object|null} OutboundClient
 */
function resolveOutbound(supervisor, communityId) {
  if (!supervisor) return null;
  if (typeof supervisor.clientForCommunity === "function") {
    try {
      return supervisor.clientForCommunity(communityId) ?? null;
    } catch (err) {
      console.error(
        `[youtube] clientForCommunity(${communityId}) threw: ${err?.message || err}`,
      );
      return null;
    }
  }
  if (typeof supervisor.sendChannel === "function") return supervisor;
  if (supervisor.guilds || supervisor.channels || supervisor.users) {
    // Legacy raw discord.js client (pre-PR 7 call site).
    try {
      return getDiscordOutbound(supervisor);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * NormalizedEmbed plain JSON at the send boundary (spec § Embeds and
 * attachments): EmbedBuilder instances are flattened with toJSON() so the
 * payload is platform-agnostic; visible content is unchanged.
 * @param {object} embed EmbedBuilder-like or plain object
 * @returns {object}
 */
function toPlainEmbed(embed) {
  return embed && typeof embed.toJSON === "function" ? embed.toJSON() : embed;
}

/**
 * #441 (audit INT-5): the ONE Google Data API transport. The four former
 * call sites each JSON.parse'd the body with NO status-code check, so a
 * 403 quotaExceeded / 400 invalid-key response parsed "fine" and every
 * caller reported the WRONG cause ("No channel data found") while the
 * whole fleet's notifications silently died until UTC midnight.
 *
 * Contract: never throws; returns { ok:true, data } or
 * { ok:false, status, error } with a CAUSE string that never contains the
 * API key. Callers surface or log that cause — never a bare null reason.
 */
const GOOGLE_API_HOST = "www.googleapis.com";

/** Pure response interpreter — split out so the decision is unit-testable. */
function interpretGoogleResponse(status, rawBody) {
  let data = null;
  try {
    data = JSON.parse(rawBody);
  } catch {
    /* fall through */
  }
  if (status < 200 || status >= 300) {
    const reason =
      data?.error?.message || data?.error?.errors?.[0]?.reason || "api error";
    return { ok: false, status, error: `${status} ${reason}` };
  }
  if (!data || typeof data !== "object") {
    return { ok: false, status, error: `${status} non-JSON response` };
  }
  if (data.error) {
    const reason =
      data.error.message || data.error.errors?.[0]?.reason || "api error";
    return { ok: false, status, error: `${status} ${reason}` };
  }
  return { ok: true, data };
}

/**
 * Identical repeated API failures (quota dying for EVERY channel every
 * tick) must not scream over the logs every 5 minutes — warn once per
 * 30 min per distinct message, quieter lines in between.
 */
const apiIssueLastLogged = new Map();
function logApiIssue(where, message) {
  const k = `${where}|${message}`;
  const nowMs = Date.now();
  const last = apiIssueLastLogged.get(k) || 0;
  if (nowMs - last >= 30 * 60 * 1000) {
    apiIssueLastLogged.set(k, nowMs);
    if (apiIssueLastLogged.size > 128) apiIssueLastLogged.clear();
    console.warn(
      `[youtube] Google API issue (${where}): ${message} — check YOUTUBE_API_KEY / quota (re-warns every 30 min)`,
    );
  } else {
    console.log(`[youtube] Google API issue (${where}): ${message}`);
  }
}

/**
 * GET against the YouTube Data API. `pathname` MUST NOT contain the key —
 * it is appended here and must not leak into any error string.
 * Swappable for tests (setGoogleGetForTests), like lavalink's manager seam.
 */
let googleGet = (pathname) =>
  new Promise((resolve) => {
    const sep = pathname.includes("?") ? "&" : "?";
    const req = https.request(
      {
        hostname: GOOGLE_API_HOST,
        port: 443,
        path: `${pathname}${sep}key=${encodeURIComponent(process.env.YOUTUBE_API_KEY || "")}`,
        method: "GET",
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          resolve(interpretGoogleResponse(res.statusCode || 0, raw));
        });
      },
    );
    req.on("error", (err) => {
      resolve({ ok: false, status: 0, error: String(err?.message || err) });
    });
    req.end();
  });

function setGoogleGetForTests(fn) {
  const previous = googleGet;
  googleGet = fn || previous;
  return previous;
}

async function lookupChannelByName(username) {
  if (!process.env.YOUTUBE_API_KEY) {
    return null;
  }

  try {
    // Search for channels matching this username (burns 100 quota units)
    const res = await googleGet(
      `/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(username)}&maxResults=5`,
    );
    if (!res.ok) {
      logApiIssue(`channel search @${username}`, res.error);
      return null;
    }
    const response = res.data;

    if (response.items && response.items.length > 0) {
      // Find exact or close match
      for (const item of response.items) {
        const channelTitle = item.snippet.channelTitle || "";
        // Exact match or name contains username (case insensitive)
        if (channelTitle.toLowerCase() === username.toLowerCase()) {
          console.log(
            `[youtube] Resolved @${username} to ${item.snippet.channelId}`,
          );

          return {
            id: item.snippet.channelId,
            name: normalizeYoutubeName(channelTitle),
            url: `https://www.youtube.com/channel/${item.snippet.channelId}`,
          };
        }
      }

      // Return first match if no exact match
      const item = response.items[0];
      console.log(
        `[youtube] Used approximate match for @${username}: ${item.snippet.channelTitle}`,
      );

      return {
        id: item.snippet.channelId,
        name: normalizeYoutubeName(item.snippet.channelTitle),
        url: `https://www.youtube.com/channel/${item.snippet.channelId}`,
      };
    }

    console.log(`[youtube] No channel found for @${username}`);
  } catch (err) {
    console.log(
      `[youtube] Could not fetch channel info for @${username}:`,
      err?.message || err,
    );
  }

  return null;
}

// --- YouTube Data API v3 Integration ---

/**
 * #456 (audit H2-14): failures return `{ error: "<cause>" }` instead of a bare
 * null so the DIAGNOSTIC command (/testnotification) can show the staff what
 * actually broke — the cause used to die in a console line. Callers must treat
 * a feed without `items` as "nothing to do" (the tick path already does).
 */
async function fetchYouTubeFeed(channelId) {
  if (!process.env.YOUTUBE_API_KEY) {
    console.warn(
      "[youtube] YOUTUBE_API_KEY not set in environment - YouTube notifications disabled",
    );
    return {
      error: "YOUTUBE_API_KEY is not set on this bot — add it to .env and restart",
    };
  }

  try {
    // Step 1: Get uploads playlist ID
    const chRes = await googleGet(
      `/youtube/v3/channels?part=contentDetails&id=${channelId}`,
    );
    if (!chRes.ok) {
      // #441: quota/key/transport failures name THEMSELVES now — the old
      // code parsed the 403 body and reported "no channel data" instead.
      logApiIssue(`channel lookup ${channelId}`, chRes.error);
      return { error: `YouTube API: ${chRes.error}` };
    }
    const channelResponse = chRes.data;

    if (!channelResponse.items || channelResponse.items.length === 0) {
      console.log(`[youtube] No channel data found for ${channelId}`);
      return {
        error: `no channel data for ${channelId} (deleted channel or wrong id?)`,
      };
    }

    const uploadsPlaylistId =
      channelResponse.items[0].contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) {
      console.log(`[youtube] Channel ${channelId} has no uploads playlist`);
      return { error: `channel ${channelId} has no uploads playlist` };
    }

    // Step 2: Get videos from uploads playlist
    const plRes = await googleGet(
      `/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${uploadsPlaylistId}`,
    );
    if (!plRes.ok) {
      logApiIssue(`playlist items ${uploadsPlaylistId}`, plRes.error);
      return { error: `YouTube API (playlist): ${plRes.error}` };
    }
    const videoResponse = plRes.data;

    // Convert to RSS feed format for compatibility
    // Include liveBroadcastContent if available for accurate live detection
    return {
      title: `YouTube channel ${channelId}`,
      items: (videoResponse.items || []).map((item) => ({
        id: item.snippet.resourceId?.videoId,
        title: item.snippet.title,
        pubDate: item.snippet.publishedAt,
        description: item.snippet.description,
        liveBroadcastContent: item.snippet.liveBroadcastContent, // "none", "live", "upcoming"
        "media:thumbnail": {
          url: item.snippet.thumbnails?.default?.url,
        },
      })),
    };
  } catch (err) {
    console.error(
      `[youtube] Failed to fetch feed for channel ${channelId}:`,
      err?.message || err,
    );
    return { error: String(err?.message || err) };
  }
}

function isLiveVideo(entry) {
  if (!entry) return false;

  // YouTube Data API v3 gives us broadcast content type
  const broadcastContent =
    entry.liveBroadcastContent || entry.snippet?.liveBroadcastContent || "";

  if (broadcastContent === "live" || broadcastContent === "upcoming") {
    return true;
  }

  return false;
}

function isVideoUpload(entry) {
  if (!entry) return false;

  const broadcastContent =
    entry.liveBroadcastContent || entry.snippet?.liveBroadcastContent || "";

  return broadcastContent === "none" || !broadcastContent;
}

function extractVideoInfo(entry) {
  if (!entry) return null;

  const videoId =
    entry["yt:videoId"] ||
    entry.id?.split(":").pop() ||
    entry.snippet?.resourceId?.videoId;
  const title = entry.title || "Untitled Video";
  const published = entry.pubDate
    ? new Date(entry.pubDate).getTime()
    : entry.snippet?.publishedAt
      ? new Date(entry.snippet.publishedAt).getTime()
      : Date.now();

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

/**
 * Optional deps for tests (network stubs). Production uses default implementations.
 * @typedef {object} YoutubeTickerDeps
 * @property {(channelId: string) => Promise<object|null>} [fetchYouTubeFeed]
 *   failure shape: `{ error: string }` (see fetchYouTubeFeed, #456); a feed
 *   without `items` means "nothing to do" on the tick path.
 * @property {(username: string) => Promise<object|null>} [lookupChannelByName]
 * @property {(channelId: string) => Promise<object|null>} [fetchChannelInfo]
 */

/** @type {YoutubeTickerDeps} */
const defaultDeps = {
  fetchYouTubeFeed,
  lookupChannelByName,
  fetchChannelInfo,
};

/**
 * @param {object|null} supervisor PR 7 supervisor (raw client accepted)
 * @param {number} communityId internal community id (row's `community_id`)
 * @param {object} channelData
 * @param {YoutubeTickerDeps} [deps]
 */
async function processChannel(
  supervisor,
  communityId,
  channelData,
  deps = defaultDeps,
) {
  const fetchFeed = deps.fetchYouTubeFeed || fetchYouTubeFeed;
  const resolveName = deps.lookupChannelByName || lookupChannelByName;

  // Per-row routing (spec 576): missing client → log and skip the row.
  const outbound = resolveOutbound(supervisor, communityId);
  if (!outbound) {
    console.warn(
      `[youtube] no ready client for community ${communityId} — skipping`,
    );
    return;
  }

  const settings = getGuildSettings(communityId);

  if (!settings.youtube_notification_channel_id) {
    console.log(
      `[youtube] No notification channel configured for community ${communityId}`,
    );
    return;
  }

  let channelId = channelData.id;
  let channelName = channelData.channel_name;

  // Check if we need to resolve @username
  const hasUnresolvedName = channelName.startsWith("@");
  const needsResolution =
    hasUnresolvedName &&
    !channelId.startsWith("UC") &&
    !channelId.startsWith("HC");

  if (needsResolution) {
    const username = normalizeYoutubeName(channelName);
    console.log(`[youtube] Resolving @${username}...`);

    const resolved = await resolveName(username);
    if (resolved) {
      channelId = resolved.id;
      addYoutubeChannel(communityId, channelId, resolved.name, resolved.url, "");

      console.log(
        `[youtube] Resolved @${username} to ${channelId} (${resolved.name})`,
      );
    } else {
      console.log(`[youtube] Could not resolve @${username}, skipping`);
      return;
    }
  }

  const displayName = hasUnresolvedName
    ? "@" + normalizeYoutubeName(channelName)
    : channelName;

  // Get channel URL
  let channelUrl = channelData.channel_url;
  if (!channelUrl && channelId) {
    channelUrl = `https://www.youtube.com/channel/${channelId}`;
  }

  // Get last-checked time
  const channelWithLastChecked = getYoutubeChannelById(communityId, channelId);
  const lastChecked =
    channelData.last_checked ||
    (channelWithLastChecked ? channelWithLastChecked.last_checked : null);

  console.log(
    `[youtube] Checking ${displayName} (${channelId}) - last checked: ${lastChecked ? new Date(lastChecked).toISOString() : "never"}`,
  );

  const feed = await fetchFeed(channelId);
  // #379: book the wall-clock sweep time regardless of the outcome — a
  // transient feed failure still counts as "checked this interval" so the
  // quota stays exactly what the setting promises; notification state is
  // untouched (retry is the watermark's business, #380).
  markYoutubeChannelCheckedAt(communityId, channelId, Date.now());

  if (!feed) return;

  if (!feed.items || !feed.items.length) {
    // Nothing to notify AND nothing to advance: the old unconditional
    // last_checked=now here jumped the ORDINAL notification window past
    // undelivered neighbours — the #380 burn class in disguise. Cadence
    // lives in last_checked_at now; the notification floor only moves on
    // deliveries.
    console.log(
      `[youtube] No videos found for ${channelName}${feed.error ? ` (${feed.error})` : ""}`,
    );
    return;
  }

  // Sort entries by published date (newest first)
  feed.items.sort((a, b) => {
    const aDate = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const bDate = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return bDate - aDate;
  });

  const lastVideoId =
    channelData.last_video_id ||
    (channelWithLastChecked ? channelWithLastChecked.last_video_id : null);

  // Pass 1 — classify + dedup into a PENDING list. (Audit #380: the old
  // loop sent newest-first and advanced the watermark UNCONDITIONALLY
  // after the loop, so a single failed send — revoked perms, rate-limit
  // burst, deleted notify channel — or a crash mid-loop permanently
  // burned every pending upload: the next tick found them at-or-older
  // than last_checked or hidden behind the pointer and skipped them
  // silently. This is the twitch/github burn class; github's fix is the
  // template: deliver oldest-first, advance state only past DELIVERED
  // items, stop at the first failure, persist per delivery so a crash
  // cannot lose delivered progress.)
  const pending = [];
  for (const entry of feed.items) {
    // Track both live streams and regular uploads
    let notificationType;

    if (isLiveVideo(entry)) {
      notificationType = "live";
    } else if (isVideoUpload(entry)) {
      notificationType = "upload";
    } else {
      continue; // Skip non-video entries
    }

    const info = extractVideoInfo(entry);
    if (!info || !info.videoId) continue;

    // #378: live alerts dedup on their OWN row state, never the shared
    // last_video_id pointer (the live pointer is only ever set after a
    // DELIVERED alert, #380 — a failed live send is retried next tick).
    if (
      notificationType === "live" &&
      info.videoId === (channelData.last_live_id || null)
    ) {
      console.log(
        `[youtube] Skipping ${info.title} - live alert already dispatched for this stream`,
      );
      continue;
    }

    // Skip if we've already notified about this video (using last_video_id as snapshot)
    if (lastVideoId && info.videoId === lastVideoId) {
      console.log(
        `[youtube] Skipping ${info.title} - already notified (matches last_video_id: ${lastVideoId})`,
      );
      continue;
    }

    // For uploads, check if published within the time window. NEVER
    // break: an older pending video must still be retried, and the feed
    // is a fixed ~15-25 item RSS (#380).
    if (notificationType === "upload") {
      if (lastChecked) {
        if (info.published <= lastChecked) {
          console.log(
            `[youtube] Skipping ${info.title} - already checked (published: ${new Date(info.published).toISOString()}, last checked: ${new Date(lastChecked).toISOString()})`,
          );
          continue;
        }
      } else {
        // Never checked before: only notify on videos from the last hour
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        if (info.published <= oneHourAgo) {
          console.log(
            `[youtube] Skipping ${info.title} - published too old (published: ${new Date(info.published).toISOString()}, cutoff: ${new Date(oneHourAgo).toISOString()})`,
          );
          continue;
        }
      }
    }

    pending.push({ info, notificationType });
  }

  // Pass 2 — deliver oldest-first so the ordinal window (last_checked)
  // can only ever advance past videos that actually reached Discord.
  pending.sort((a, b) => a.info.published - b.info.published);

  let delivered = 0;
  let sendFailed = false;
  for (const item of pending) {
    const useSimpleEmbed = item.notificationType === "upload";
    const res = await sendNotification(
      outbound,
      communityId,
      settings.youtube_notification_channel_id,
      channelData,
      item.info,
      channelUrl,
      item.notificationType,
      useSimpleEmbed,
    );
    if (!res || res.ok !== true) {
      sendFailed = true;
      console.error(
        `[youtube] Notification failed for ${channelName} (${item.notificationType} ${item.info.videoId}): ${res?.error || "unknown"} — watermark kept, pending videos retry next tick`,
      );
      break; // keep the watermark where it is; retry the rest next tick
    }
    delivered += 1;

    // Persist PER DELIVERY (crash between sends can never un-deliver a
    // sent alert — the old single end-of-loop write lost everything).
    if (item.notificationType === "live") {
      // #378 + #380: only a DELIVERED live alert marks the stream.
      markYoutubeLiveNotified(communityId, channelId, item.info.videoId);
    } else {
      // Ordinal watermark: advance to the delivered video's publish time
      // (never wall-clock past an undelivered neighbour) and pin the
      // pointer to the delivered video.
      updateYoutubeChannelLastChecked(
        communityId,
        channelId,
        Math.max(lastChecked || 0, item.info.published),
        item.info.videoId,
      );
    }
  }

  if (delivered > 0 && !sendFailed) {
    console.log(
      `[youtube] ${channelName}: ${delivered} notification(s) delivered, watermark at the newest delivered publish`,
    );
  }
}

function createLiveEmbed(channelData, videoInfo, channelUrl) {
  const discord = require("discord.js");

  const embed = new discord.EmbedBuilder()
    .setColor(Color.youtubeLive)
    .setAuthor({
      name: `${channelData.channel_name} just went live!`,
      url: channelUrl,
      iconURL: channelData.thumbnail_url || undefined,
    })
    .setTitle(videoInfo.title)
    .setDescription(`[Watch Live](https://youtu.be/${videoInfo.videoId})`)
    .setThumbnail(channelData.thumbnail_url || undefined)
    .setImage(
      videoInfo.thumbnail
        ? videoInfo.thumbnail.replace(/=s\d+/, "=s1280")
        : undefined,
    )
    .addFields([
      {
        name: "Channel",
        value: `[${channelData.channel_name}](${channelUrl})`,
        inline: true,
      },
      { name: "Video ID", value: videoInfo.videoId, inline: true },
    ])
    .setTimestamp(new Date(videoInfo.published))
    .setFooter({
      text: "YouTube",
      iconURL: "https://www.youtube.com/img/desktop/yt_120x64.png",
    });
  console.log(
    `[createLiveEmbed] Channel thumbnail URL:`,
    channelData.thumbnail_url,
  );

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
    .setColor(Color.youtubeUpload)
    .setAuthor({
      name: `${channelData.channel_name}`,
      url: channelUrl,
      iconURL: channelData.thumbnail_url || undefined,
    })
    .setTitle(videoInfo.title)
    .setDescription(`[Watch Video](https://youtu.be/${videoInfo.videoId})`)
    .setThumbnail(channelData.thumbnail_url || undefined)
    .setImage(
      videoInfo.thumbnail
        ? videoInfo.thumbnail.replace(/=s\d+/, "=s1280")
        : undefined,
    )
    .setTimestamp(new Date(videoInfo.published))
    .setFooter({
      text: "YouTube",
      iconURL: "https://www.youtube.com/img/desktop/yt_120x64.png",
    });
  console.log(
    `[createUploadEmbed] Channel thumbnail URL:`,
    channelData.thumbnail_url,
  );

  return embed;
}

/**
 * Post one notification through the OutboundClient (spec § Scheduler jobs:
 * sendChannel on the row's client — no channel pre-fetch).
 * Returns the delivery result (#380) — callers advance the watermark only
 * past `ok: true` sends; nothing here throws, per the services contract.
 * @param {object} outbound OutboundClient for the row's community
 * @returns {Promise<{ok: true}|{ok: false, error: string}>}
 */
async function sendNotification(
  outbound,
  communityId,
  channelId,
  channelData,
  videoInfo,
  channelUrl,
  notificationType,
  useSimpleEmbed = true,
) {
  try {
    let content = "";
    let embeds = [];

    const settings = getGuildSettings(communityId);
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
        const simpleResult = createSimpleUploadEmbed(
          channelData,
          videoInfo,
          channelUrl,
        );
        content = `${roleMention}${simpleResult.content}`;
        embeds = [];
      } else {
        content = `${roleMention}${channelData.channel_name} uploaded a new video!`;
        embeds = [createUploadEmbed(channelData, videoInfo, channelUrl)];
      }
    }

    // Ping allow-list must permit the mention this content actually builds
    // (audit H11): `parse: []` suppressed every production ping while
    // /testnotification (plain reply, no override) looked fine. Live alerts
    // intentionally @everyone (docs/youtube-notifications.md); upload alerts
    // ping only the configured role, never @everyone (mirrors twitch ticker).
    // #272: the role arm is the STRICT allow-list `{ roles: [id] }` — the
    // live Discord docs make `parse` mutually exclusive with the id lists
    // (`{parse:["roles"], roles:[…]}` is a validation error), and the strict
    // form pins the ping to the listed role: role tokens smuggled into video
    // titles stay plain text. Precedent: eventReminders/service.js.
    const allowedMentions =
      notificationType === "live"
        ? { parse: ["everyone"] }
        : uploadRoleId
          ? { roles: [uploadRoleId] }
          : { parse: [] };

    // OutboundClient.sendChannel replaces client.channels.fetch + channel.send.
    // Embeds are flattened to plain NormalizedEmbed JSON at this boundary.
    const result = await outbound.sendChannel(channelId, {
      content: content,
      allowedMentions,
      embeds: embeds.map(toPlainEmbed),
    });

    if (!result || result.ok !== true) {
      const error = result?.error || "no ready client";
      console.error(
        `[youtube] Failed to send notification for ${videoInfo?.title}: ${error}`,
      );
      return { ok: false, error };
    }

    console.log(
      `[youtube] Sent notification for ${videoInfo.title} in community ${communityId}`,
    );
    return { ok: true };
  } catch (err) {
    const error = err?.message || String(err);
    console.error(
      `[youtube] Failed to send notification for ${videoInfo?.title}:`,
      error,
    );
    return { ok: false, error };
  }
}

/**
 * @param {object|null} supervisor PR 7 supervisor ({discord, fluxer, clientForCommunity});
 *        a raw discord.js client is accepted (legacy shim)
 * @param {YoutubeTickerDeps & { skipApiKeyCheck?: boolean }} [deps]
 */
async function runYoutubeTick(supervisor, deps = defaultDeps) {
  console.log(`[youtube] Running tick`);
  // Check for API key before doing any work (tests may pass skipApiKeyCheck + stubs)
  if (!deps.skipApiKeyCheck && !process.env.YOUTUBE_API_KEY) {
    console.log(
      `[youtube] YouTube Data API v3: YOUTUBE_API_KEY not configured - live notifications disabled`,
    );
    return;
  }

  // #379: honor each community's youtube_polling_interval_minutes — the
  // setting `/setyoutube interval`, the web console, and the docs all
  // advertise — exactly like twitch's eligibility filter. The job itself
  // ticks once a minute (aligned) and rows are swept when DUE.
  // `last_checked_at` is the wall-clock sweep stamp (migration 047);
  // `last_checked` is the ordinal notification window (#380) and is NOT a
  // timer. Never-checked rows (NULL) are always due.
  const nowMs = Date.now();
  const channels = getAllYoutubeChannels().filter((row) => {
    try {
      const settings = getGuildSettings(row.community_id);
      const intervalMs =
        (Number(settings.youtube_polling_interval_minutes) || 5) * 60_000;
      if (
        row.last_checked_at != null &&
        nowMs - row.last_checked_at < intervalMs
      ) {
        return false;
      }
      return true;
    } catch (err) {
      console.error(
        `[youtube] eligibility check failed for ${row.channel_name} (community ${row.community_id}); skipping row:`,
        err?.message || err,
      );
      return false; // a bad row drops itself with a logged cause, never kills the tick (twitch #198 precedent)
    }
  });

  if (!channels.length) {
    console.log(`[youtube] No channels due this pass`);
    return;
  }

  console.log(
    `[youtube] Checking ${channels.length} subscribed channels due this pass`,
  );

  for (const channel of channels) {
    try {
      // processChannel resolves supervisor.clientForCommunity(row.community_id)
      // per row and logs-and-skips rows whose client is not ready (spec 576).
      await processChannel(supervisor, channel.community_id, channel, deps);
    } catch (err) {
      console.error(
        `[youtube] Error processing channel ${channel.channel_name}:`,
        err?.message || err,
      );
    }
  }
}

/**
 * Arm the youtube job. The scheduler job receives the PR 7 supervisor;
 * every tick resolves the client per community row.
 * @param {object|null} supervisor
 */
function startYoutubeTicker(supervisor) {
  if (!process.env.YOUTUBE_API_KEY) {
    console.log(
      "[youtube] Skipping ticker startup - YOUTUBE_API_KEY not configured",
    );
    return;
  }

  registerJob({
    name: "youtube",
    // Base cadence is 1 minute; per-row gating in runYoutubeTick enforces
    // each community's youtube_polling_interval_minutes (#379, twitch's
    // model). The old hardcoded 5-minute sweep ignored the setting entirely.
    intervalMs: 60_000,
    align: true,
    runImmediately: true,
    run: () => runYoutubeTick(supervisor),
  });
}

async function fetchChannelInfo(channelId) {
  if (!process.env.YOUTUBE_API_KEY) return null;

  try {
    const res = await googleGet(`/youtube/v3/channels?part=snippet&id=${channelId}`);
    if (!res.ok) {
      logApiIssue(`channel info ${channelId}`, res.error);
      return null;
    }
    const response = res.data;

    if (response.items && response.items.length > 0) {
      const snippet = response.items[0].snippet;
      const thumbnails = snippet.thumbnails || {};
      console.log(
        `[youtube] fetchChannelInfo raw thumbnails:`,
        JSON.stringify(thumbnails, null, 2),
      );
      return {
        id: channelId,
        name: snippet.title,
        url: `https://www.youtube.com/channel/${channelId}`,
        thumbnail_url:
          thumbnails.default?.url ||
          thumbnails.medium?.url ||
          thumbnails.high?.url ||
          "",
      };
    }
  } catch (err) {
    console.log(
      `[youtube] Could not fetch channel info for ${channelId}:`,
      err?.message || err,
    );
  }

  return null;
}

module.exports = {
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
  processChannel,
  runYoutubeTick,
  defaultDeps,
  // tests (#441): transport seam + pure response interpretation
  interpretGoogleResponse,
  setGoogleGetForTests,
};
