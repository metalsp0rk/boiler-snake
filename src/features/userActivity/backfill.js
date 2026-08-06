/**
 * Per-user message history backfill (best-effort, rate-limited).
 *
 * Live ingest counts messages with createdTimestamp >= guild collect_from_ms.
 * Backfill counts messages strictly older than that watermark so rows never double-count.
 */

const { ChannelType } = require("discord.js");
const {
  ensureGuildActivitySettings,
  getGuildActivitySettings,
  incrementDaily,
  utcDayKey,
  upsertUserActivityMeta,
  getUserActivityMeta,
  guildHasActiveBackfill,
  getBackfillCursor,
  upsertBackfillCursor,
  getActivityIgnoreSets,
  isHoneypotChannel,
} = require("../../db");
const { shouldSkipChannel } = require("./service");

const PAGE_SIZE = 100;
const MAX_PAGES_PER_CHANNEL = 50;
const DELAY_MS = 1100;

/** @type {Map<string, Promise<void>>} */
const guildJobs = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Text/announcement channels eligible for history fetch.
 * @param {import("discord.js").Guild} guild
 * @param {string} guildId
 * @returns {import("discord.js").GuildTextBasedChannel[]}
 */
function listBackfillChannels(guild, guildId) {
  const { channels: ignoredChannels, categories } = getActivityIgnoreSets(guildId);
  const out = [];
  for (const ch of guild.channels.cache.values()) {
    if (!ch) continue;
    const type = ch.type;
    const isText =
      type === ChannelType.GuildText ||
      type === ChannelType.GuildAnnouncement ||
      type === 0 ||
      type === 5;
    if (!isText) continue;
    if (typeof ch.messages?.fetch !== "function") continue;
    if (isHoneypotChannel(guildId, ch.id)) continue;
    if (ignoredChannels.has(ch.id)) continue;
    const catId = ch.parentId || null;
    if (catId && categories.has(catId)) continue;
    if (shouldSkipChannel(guildId, ch.id, catId)) continue;
    out.push(ch);
  }
  return out;
}

/**
 * Count target user's messages in one channel (history older than watermark).
 * @returns {Promise<{ counted: number, complete: boolean, partial: boolean }>}
 */
async function backfillChannel(channel, userId, watermarkMs) {
  const guildId = channel.guildId || channel.guild?.id;
  let counted = 0;
  let pages = 0;
  let before = undefined;
  let complete = false;
  let partial = false;

  const cursor = getBackfillCursor(guildId, userId, channel.id);
  if (cursor?.complete) {
    return { counted: 0, complete: true, partial: false };
  }
  if (cursor?.oldest_message_id) {
    before = cursor.oldest_message_id;
  }

  while (pages < MAX_PAGES_PER_CHANNEL) {
    const opts = { limit: PAGE_SIZE };
    if (before) opts.before = before;

    let batch;
    try {
      batch = await channel.messages.fetch(opts);
    } catch (e) {
      console.error(
        `[userActivity] backfill fetch ${channel.id}:`,
        e?.message || e
      );
      partial = true;
      break;
    }

    if (!batch || batch.size === 0) {
      complete = true;
      break;
    }

    const msgs = [...batch.values()].sort(
      (a, b) => Number(b.id) - Number(a.id)
    );
    let sawOlderThanWatermark = false;
    let hitOnlyNewer = true;

    for (const msg of msgs) {
      const ts = msg.createdTimestamp || 0;
      if (ts >= watermarkMs) {
        // Still in live zone — skip count, keep walking older
        continue;
      }
      hitOnlyNewer = false;
      sawOlderThanWatermark = true;
      if (msg.author?.bot) continue;
      if (msg.author?.id !== userId) continue;
      const day = utcDayKey(ts);
      incrementDaily(guildId, userId, channel.id, day, 1);
      counted += 1;
    }

    const oldest = msgs[msgs.length - 1];
    before = oldest?.id;
    upsertBackfillCursor(guildId, userId, channel.id, {
      oldest_message_id: before,
      complete: false,
    });

    pages += 1;
    await sleep(DELAY_MS);

    // If entire page is newer than watermark and we have more history, continue;
    // if batch smaller than page, end of channel history
    if (batch.size < PAGE_SIZE) {
      complete = true;
      break;
    }

    // Safety: if we never saw anything older and many pages of only-newer, still continue until empty
    if (!sawOlderThanWatermark && hitOnlyNewer && pages >= MAX_PAGES_PER_CHANNEL) {
      partial = true;
      break;
    }
  }

  if (pages >= MAX_PAGES_PER_CHANNEL && !complete) {
    partial = true;
  }

  if (complete) {
    upsertBackfillCursor(guildId, userId, channel.id, {
      oldest_message_id: before || null,
      complete: true,
    });
  }

  return { counted, complete, partial };
}

/**
 * Start (or no-op if busy) a per-user backfill job for a guild.
 * @param {import("discord.js").Guild} guild
 * @param {string} userId
 * @returns {Promise<{ started: boolean, reason?: string }>}
 */
async function startUserBackfill(guild, userId) {
  const guildId = guild.id;
  ensureGuildActivitySettings(guildId);
  const settings = getGuildActivitySettings(guildId);
  const watermarkMs = settings?.collect_from_ms ?? Date.now();

  if (guildHasActiveBackfill(guildId)) {
    return { started: false, reason: "A backfill is already running in this server." };
  }

  const meta = getUserActivityMeta(guildId, userId);
  if (meta?.backfill_status === "running" || meta?.backfill_status === "queued") {
    return { started: false, reason: "Backfill already in progress for this user." };
  }

  if (guildJobs.has(guildId)) {
    return { started: false, reason: "A backfill is already running in this server." };
  }

  const channels = listBackfillChannels(guild, guildId);
  upsertUserActivityMeta(guildId, userId, {
    backfill_status: "running",
    backfill_started_at: Date.now(),
    backfill_finished_at: null,
    backfill_error: null,
    backfill_channels_done: 0,
    backfill_channels_total: channels.length,
    tracking_since_ms: meta?.tracking_since_ms ?? null,
  });

  const job = (async () => {
    let anyPartial = false;
    let error = null;
    let done = 0;
    try {
      for (const ch of channels) {
        const result = await backfillChannel(ch, userId, watermarkMs);
        done += 1;
        if (result.partial || !result.complete) anyPartial = true;
        upsertUserActivityMeta(guildId, userId, {
          backfill_status: "running",
          backfill_channels_done: done,
          backfill_channels_total: channels.length,
        });
      }
    } catch (e) {
      error = e?.message || String(e);
      console.error("[userActivity] backfill job failed:", error);
    } finally {
      const status = error ? "failed" : anyPartial ? "partial" : "done";
      // Earliest tracking: prefer watermark if we only have live, else leave null (UI uses earliest day)
      upsertUserActivityMeta(guildId, userId, {
        backfill_status: status,
        backfill_finished_at: Date.now(),
        backfill_error: error,
        backfill_channels_done: done,
        backfill_channels_total: channels.length,
        tracking_since_ms: null,
      });
      guildJobs.delete(guildId);
    }
  })();

  guildJobs.set(guildId, job);
  // Do not await — runs in background
  job.catch((e) => console.error("[userActivity] backfill unhandled:", e));

  return { started: true };
}

module.exports = {
  PAGE_SIZE,
  MAX_PAGES_PER_CHANNEL,
  DELAY_MS,
  listBackfillChannels,
  startUserBackfill,
  backfillChannel,
};
