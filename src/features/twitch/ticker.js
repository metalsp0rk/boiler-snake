const { EmbedBuilder } = require("discord.js");
const { Color } = require("../../core/theme");
const { registerJob } = require("../../core/scheduler");
const {
  getAllTwitchChannels,
  getGuildSettings,
  addTwitchChannel,
  removeTwitchChannel,
  claimTwitchStream,
  claimTwitchOffline,
  updateTwitchChannelClipState,
  updateTwitchChannelVideoState,
} = require("../../db");
const {
  resolveTwitchUser,
  fetchStreams,
  fetchClips,
  fetchArchives,
  expandThumbnailUrl,
  parseTwitchTimestamp,
} = require("./helix");

/** @type {{ resolveUser: Function, fetchStreams: Function }} */
const defaultDeps = { resolveUser: resolveTwitchUser, fetchStreams };

/**
 * Build the go-live embed for a Twitch stream.
 * @param {object} sub stored twitch_channels row
 * @param {object} stream Helix stream object
 */
function createGoLiveEmbed(sub, stream) {
  const displayName = sub.display_name || sub.login;
  const embed = new EmbedBuilder()
    .setColor(Color.twitchLive)
    .setAuthor({
      name: `${displayName} is live!`,
      url: `https://twitch.tv/${sub.login}`,
      iconURL: sub.profile_image_url || undefined,
    })
    .setTitle(stream.title || "Untitled stream")
    .setDescription(`[Watch on Twitch](https://twitch.tv/${sub.login})`)
    .setThumbnail(
      expandThumbnailUrl(stream.thumbnail_url) ||
        sub.profile_image_url ||
        undefined,
    )
    .setTimestamp(new Date(stream.started_at || Date.now()));

  const fields = [];
  if (stream.game_name) {
    fields.push({ name: "Playing", value: stream.game_name, inline: true });
  }
  if (Number.isFinite(stream.viewer_count)) {
    fields.push({
      name: "Viewers",
      value: String(stream.viewer_count),
      inline: true,
    });
  }
  if (fields.length) embed.addFields(fields);

  embed.setFooter({
    text: "Twitch",
    iconURL: "https://upload.wikimedia.org/wikipedia/commons/9/95/Twitch_logo.png",
  });

  return embed;
}

/**
 * Send the go-live notification for one subscription.
 * @param {import("discord.js").Client} client
 * @param {number} communityId internal community id (row's `community_id`)
 * @param {object} sub stored twitch_channels row
 * @param {object} stream Helix stream object
 */
async function sendGoLiveNotification(client, communityId, sub, stream) {
  const settings = getGuildSettings(communityId);
  const notifyChannelId = settings.twitch_notification_channel_id;
  if (!notifyChannelId) {
    console.log(
      `[twitch] No notification channel configured for community ${communityId}`,
    );
    return;
  }

  const channel = await client.channels.fetch(notifyChannelId).catch(() => null);
  if (!channel) {
    console.error(
      `[twitch] Could not find notification channel ${notifyChannelId}`,
    );
    return;
  }

  const roleName = sub.display_name || sub.login;
  const roleId = settings.twitch_notify_role_id;
  const content = roleId
    ? `<@&${roleId}> **${roleName}** is live!`
    : `**${roleName}** is live!`;

  try {
    await channel.send({
      content,
      embeds: [createGoLiveEmbed(sub, stream)],
      // Only allow the configured role to be pinged (never @everyone/@here).
      allowedMentions: roleId
        ? { parse: ["roles"], roles: [roleId] }
        : { parse: [] },
    });
    console.log(
      `[twitch] Sent go-live notification for ${sub.login} in community ${communityId}`,
    );
  } catch (err) {
    console.error(
      `[twitch] Failed to send go-live notification for ${sub.login}:`,
      err?.message || err,
    );
  }
}

/**
 * Process one subscription against a stream lookup.
 *
 * Claim-first: the watermark (last_stream_id / is_live) is read+written
 * synchronously BEFORE the Discord send, so the polling ticker and the
 * EventSub fast path can never both announce the same stream id (Twitch
 * also redelivers, at-least-once).
 *
 * @param {import("discord.js").Client} client
 * @param {number} communityId internal community id (row's `community_id`)
 * @param {object} sub stored twitch_channels row
 * @param {object|undefined} stream matching Helix stream (if any)
 */
async function processSubscription(client, communityId, sub, stream) {
  if (stream) {
    const isNewStream = claimTwitchStream(
      communityId,
      sub.broadcaster_id,
      stream.id,
    );
    if (isNewStream) {
      await sendGoLiveNotification(client, communityId, sub, stream);
    }
  } else {
    const wasLive = claimTwitchOffline(communityId, sub.broadcaster_id);
    if (wasLive) {
      console.log(`[twitch] ${sub.login} went offline`);
    }
  }
}

// ---------------------------------------------------------------------------
// Clips / VODs hooks (Helix polling — EventSub has no clip/VOD topics)
// ---------------------------------------------------------------------------

/** Announce at most this many clips/VODs per subscription per poll. */
const MAX_MEDIA_PER_TICK = 5;
/** Re-query clips a little before the watermark to dodge creation-delay races. */
const CLIP_WINDOW_OVERLAP_MS = 5 * 60_000;

function formatIsoDuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(
    String(iso || ""),
  );
  if (!m) return null;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const s = Math.round(Number(m[3] || 0));
  if (!h && !min && !s) return null;
  const parts = h ? [`${h}h`, `${min}m`] : min ? [`${min}m`] : [];
  if (s || !parts.length) parts.push(`${s}s`);
  return parts.join(" ");
}

/**
 * Build the "new clip" embed for a Helix clip object
 * (id, url, thumbnail_url, title, created_at, duration, view_count, game_name).
 */
function createClipEmbed(sub, clip) {
  const displayName = sub.display_name || sub.login;
  const embed = new EmbedBuilder()
    .setColor(Color.twitchLive)
    .setAuthor({
      name: `${displayName} — new clip`,
      url: clip.url || undefined,
      iconURL: sub.profile_image_url || undefined,
    })
    .setTitle(clip.title || "Untitled clip")
    .setDescription(
      clip.url ? `[Watch clip](${clip.url})` : "_Clip not linkable yet_",
    )
    .setThumbnail(
      expandThumbnailUrl(clip.thumbnail_url) ||
        sub.profile_image_url ||
        undefined,
    )
    .setTimestamp(parseTwitchTimestamp(clip.created_at) ?? Date.now());

  const fields = [];
  if (Number.isFinite(clip.duration)) {
    fields.push({
      name: "Duration",
      value: `${Math.round(clip.duration)}s`,
      inline: true,
    });
  }
  if (Number.isFinite(clip.view_count)) {
    fields.push({ name: "Views", value: String(clip.view_count), inline: true });
  }
  if (clip.game_name) {
    fields.push({ name: "Playing", value: clip.game_name, inline: true });
  }
  if (fields.length) embed.addFields(fields);

  embed.setFooter({
    text: "Twitch",
    iconURL:
      "https://upload.wikimedia.org/wikipedia/commons/9/95/Twitch_logo.png",
  });
  return embed;
}

/**
 * Build the "new VOD" embed for a Helix video object
 * (id, title, created_at, duration ISO8601, view_count, thumbnail_url).
 */
function createVodEmbed(sub, video) {
  const displayName = sub.display_name || sub.login;
  const vodUrl = `https://twitch.tv/videos/${video.id}`;
  const embed = new EmbedBuilder()
    .setColor(Color.twitchLive)
    .setAuthor({
      name: `${displayName} — new VOD`,
      url: vodUrl,
      iconURL: sub.profile_image_url || undefined,
    })
    .setTitle(video.title || "Untitled VOD")
    .setDescription(`[Watch on Twitch](${vodUrl})`)
    .setThumbnail(
      expandThumbnailUrl(video.thumbnail_url) ||
        sub.profile_image_url ||
        undefined,
    )
    .setTimestamp(parseTwitchTimestamp(video.created_at) ?? Date.now());

  const fields = [];
  const duration = formatIsoDuration(video.duration);
  if (duration) {
    fields.push({ name: "Length", value: duration, inline: true });
  }
  if (Number.isFinite(video.view_count)) {
    fields.push({
      name: "Views",
      value: String(video.view_count),
      inline: true,
    });
  }
  if (fields.length) embed.addFields(fields);

  embed.setFooter({
    text: "Twitch",
    iconURL:
      "https://upload.wikimedia.org/wikipedia/commons/9/95/Twitch_logo.png",
  });
  return embed;
}

/**
 * Send a clips/VODs message to the guild's Twitch notify channel.
 * NO role mention (the ping role is for go-live only) with
 * allowedMentions parse-off. Returns false (logged) when delivery failed.
 */
async function sendMediaNotification(client, communityId, sub, content, embed) {
  const settings = getGuildSettings(communityId);
  const notifyChannelId = settings.twitch_notification_channel_id;
  if (!notifyChannelId) return false;

  const channel = await client.channels.fetch(notifyChannelId).catch(() => null);
  if (!channel) {
    console.error(
      `[twitch] Could not find notification channel ${notifyChannelId}`,
    );
    return false;
  }

  try {
    await channel.send({
      content,
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
    return true;
  } catch (err) {
    console.error(
      `[twitch] Failed to send ${content} for ${sub.login}:`,
      err?.message || err,
    );
    return false;
  }
}

/**
 * Poll new clips for one opted-in subscription and announce them.
 *
 * Helix returns clips in VIEW order, not time order — the query is bounded
 * by started_at (watermark − overlap) so the returned window covers the
 * whole gap, and the per-guild created_at watermark does the dedup.
 * Sends up to MAX_MEDIA_PER_TICK per poll (chronological), advances the
 * watermark past ALL fresh clips seen (a clip flood never back-floods
 * Discord forever — the drop is logged), and treats a failed lookup as
 * "unknown" (watermark frozen, retried next tick).
 */
async function processNewClips(client, sub, deps = {}) {
  const fetch = deps.fetchClips || fetchClips;
  let watermark = sub.last_clip_created_at;
  if (watermark == null) {
    // Opt-in should have seeded this; seed now without announcing.
    updateTwitchChannelClipState(sub.community_id, sub.broadcaster_id, {
      lastClipId: sub.last_clip_id,
      lastClipCreatedAt: Date.now(),
    });
    return;
  }
  watermark = Number(watermark);

  const clips = await fetch(sub.broadcaster_id, {
    startedAt: new Date(watermark - CLIP_WINDOW_OVERLAP_MS).toISOString(),
  });
  if (!Array.isArray(clips)) return; // unknown state — retry next tick

  const fresh = clips
    .map((clip) => ({ clip, ts: parseTwitchTimestamp(clip.created_at) }))
    .filter(
      (x) =>
        x.ts != null &&
        x.ts > watermark &&
        typeof x.clip?.id === "string" &&
        x.clip.id,
    )
    .sort((a, b) => a.ts - b.ts);
  if (!fresh.length) return;

  const displayName = sub.display_name || sub.login;
  const toSend = fresh.slice(0, MAX_MEDIA_PER_TICK);
  for (const { clip } of toSend) {
    await sendMediaNotification(
      client,
      sub.community_id,
      sub,
      `**${displayName}** posted a new clip`,
      createClipEmbed(sub, clip),
    );
  }

  // Advance past EVERY fresh clip (even unsent ones) to bound the flood.
  let newest = fresh[fresh.length - 1];
  for (const x of fresh) if (x.ts > newest.ts) newest = x;
  updateTwitchChannelClipState(sub.community_id, sub.broadcaster_id, {
    lastClipId: newest.clip.id,
    lastClipCreatedAt: newest.ts,
  });

  if (fresh.length > toSend.length) {
    console.log(
      `[twitch] ${sub.login}: ${fresh.length} new clips, announced ${toSend.length}, skipped ${fresh.length - toSend.length} (cap ${MAX_MEDIA_PER_TICK}/poll)`,
    );
  }
}

/**
 * Poll new archive VODs for one opted-in subscription and announce them.
 * Watermark = newest video created_at (ms) — created_at is immutable, so
 * processing VODs whose published_at lags can never slip through.
 */
async function processNewVods(client, sub, deps = {}) {
  const fetch = deps.fetchArchives || fetchArchives;
  let watermark = sub.last_video_created_at;
  if (watermark == null) {
    updateTwitchChannelVideoState(sub.community_id, sub.broadcaster_id, {
      lastVideoId: sub.last_video_id,
      lastVideoCreatedAt: Date.now(),
    });
    return;
  }
  watermark = Number(watermark);

  const videos = await fetch(sub.broadcaster_id, { first: 20 });
  if (!Array.isArray(videos)) return; // unknown state — retry next tick

  const fresh = videos
    .map((video) => ({ video, ts: parseTwitchTimestamp(video.created_at) }))
    .filter(
      (x) =>
        x.ts != null && x.ts > watermark && typeof x.video?.id === "string" && x.video.id,
    )
    .sort((a, b) => a.ts - b.ts);
  if (!fresh.length) return;

  const displayName = sub.display_name || sub.login;
  const toSend = fresh.slice(0, MAX_MEDIA_PER_TICK);
  for (const { video } of toSend) {
    await sendMediaNotification(
      client,
      sub.community_id,
      sub,
      `**${displayName}** posted a new VOD`,
      createVodEmbed(sub, video),
    );
  }

  let newest = fresh[fresh.length - 1];
  for (const x of fresh) if (x.ts > newest.ts) newest = x;
  updateTwitchChannelVideoState(sub.community_id, sub.broadcaster_id, {
    lastVideoId: newest.video.id,
    lastVideoCreatedAt: newest.ts,
  });

  if (fresh.length > toSend.length) {
    console.log(
      `[twitch] ${sub.login}: ${fresh.length} new VODs, announced ${toSend.length}, skipped ${fresh.length - toSend.length} (cap ${MAX_MEDIA_PER_TICK}/poll)`,
    );
  }
}

/**
 * Resolve any subscriptions that still lack a numeric broadcaster id.
 * Also heals rows created before a broadcaster renamed their login
 * (the unique (community_id, login) constraint would otherwise leave a
 * stale duplicate row for the same broadcaster).
 * @param {object} [deps]
 */
async function resolvePendingSubscriptions(deps = defaultDeps) {
  const resolveUser = deps.resolveUser || resolveTwitchUser;
  const subs = getAllTwitchChannels();

  for (const sub of subs) {
    if (!/^\d+$/.test(sub.broadcaster_id)) {
      const user = await resolveUser(sub.login);
      if (!user) {
        console.log(`[twitch] Could not resolve login ${sub.login}, skipping`);
        continue;
      }
      addTwitchChannel(
        sub.community_id,
        user.id,
        user.login,
        user.display_name,
        user.profile_image_url,
      );
      if (sub.login !== user.login) {
        removeTwitchChannel(sub.community_id, sub.login);
      }
    }
  }

  // Heal renamed logins: same broadcaster_id, different login than stored.
  const all = getAllTwitchChannels();
  const seen = new Map(); // broadcaster_id -> row
  for (const row of all) {
    if (!/^\d+$/.test(row.broadcaster_id)) continue;
    const existing = seen.get(row.broadcaster_id);
    if (existing && existing.login !== row.login) {
      // Keep the row with the current (most recently written) login.
      removeTwitchChannel(row.community_id, existing.login);
      seen.set(row.broadcaster_id, row);
    } else if (!existing) {
      seen.set(row.broadcaster_id, row);
    }
  }
}

/**
 * One polling pass across all guilds/subscriptions.
 * @param {import("discord.js").Client} client
 * @param {object} [deps]
 */
async function runTwitchTick(client, deps = defaultDeps) {
  const resolveUser = deps.resolveUser || resolveTwitchUser;
  const fetch = deps.fetchStreams || fetchStreams;

  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
    return;
  }

  await resolvePendingSubscriptions(deps);

  // Honor each guild's polling interval: skip subscriptions that were
  // checked more recently than the guild's configured interval.
  const nowMs = Date.now();
  const all = getAllTwitchChannels().filter((s) => {
    if (!/^\d+$/.test(s.broadcaster_id)) return false;
    const settings = getGuildSettings(s.community_id);
    const intervalMs =
      (Number(settings.twitch_polling_interval_minutes) || 2) * 60_000;
    // Never re-check a row that was checked less than a minute ago
    // (the base poll cadence), and honor the guild interval on top.
    if (s.last_checked && nowMs - s.last_checked < Math.max(60_000, intervalMs)) {
      return false;
    }
    return true;
  });
  if (!all.length) return;
  const uniqueIds = [...new Set(all.map((s) => s.broadcaster_id))];

  // Batched Helix /streams lookup (max 100 ids per request).
  const streams = [];
  let fetchOk = true;
  for (let i = 0; i < uniqueIds.length; i += 100) {
    const batch = uniqueIds.slice(i, i + 100);
    const result = await fetch(batch);
    if (result == null) {
      fetchOk = false;
      break;
    }
    streams.push(...result);
  }

  // On a failed/aborted fetch, keep prior live state so a transient API
  // error does not clear is_live and cause a duplicate go-live next tick.
  const fetchFailed = !fetchOk;
  const byUserId = fetchFailed
    ? null
    : new Map(streams.map((s) => [s.user_id, s]));

  for (const sub of all) {
    try {
      if (fetchFailed) {
        console.log(
          `[twitch] Stream fetch failed; skipping state updates for ${sub.login}`,
        );
        continue;
      }
      await processSubscription(
        client,
        sub.community_id,
        sub,
        byUserId.get(sub.broadcaster_id),
      );
    } catch (err) {
      console.error(
        `[twitch] Error processing ${sub.login} (guild ${sub.community_id}):`,
        err?.message || err,
      );
    }
  }

  // Clips/VODs hooks ride the same eligibility gate (guild polling
  // interval) but are independent of the /streams lookup result.
  const mediaSubs = all.filter((s) => s.notify_clips || s.notify_vods);
  for (const sub of mediaSubs) {
    try {
      if (sub.notify_clips) await processNewClips(client, sub, deps);
      if (sub.notify_vods) await processNewVods(client, sub, deps);
    } catch (err) {
      console.error(
        `[twitch] Media poll failed for ${sub.login} (guild ${sub.community_id}):`,
        err?.message || err,
      );
    }
  }
}

/**
 * Start the Twitch polling ticker (aligned to minute boundaries).
 * @param {import("discord.js").Client} client
 */
function startTwitchTicker(client) {
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
    console.log(
      "[twitch] Skipping ticker startup - TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET not configured",
    );
    return;
  }

  registerJob({
    name: "twitch",
    intervalMs: 60_000,
    align: true,
    runImmediately: true,
    run: () => runTwitchTick(client),
  });
}

module.exports = {
  startTwitchTicker,
  runTwitchTick,
  resolvePendingSubscriptions,
  processSubscription,
  processNewClips,
  processNewVods,
  sendGoLiveNotification,
  createGoLiveEmbed,
  createClipEmbed,
  createVodEmbed,
  defaultDeps,
};
