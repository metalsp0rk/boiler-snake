/**
 * Message history backfill (best-effort, rate-limited).
 *
 * Live ingest counts messages with createdTimestamp >= guild collect_from_ms.
 * Backfill counts messages strictly older than that watermark so rows never double-count.
 *
 * Modes:
 * - Per-user: scan channels counting only one author (Activity button)
 * - Guild-wide: single pass per channel counting all human authors (/activityconfig backfill all)
 */

const { ChannelType } = require("discord.js");
const {
  ensureGuildActivitySettings,
  getGuildActivitySettings,
  patchGuildActivitySettings,
  incrementDaily,
  utcDayKey,
  upsertUserActivityMeta,
  getUserActivityMeta,
  guildHasActiveBackfill,
  getBackfillCursor,
  upsertBackfillCursor,
  getGuildChannelBackfillCursor,
  upsertGuildChannelBackfillCursor,
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
  const { channels: ignoredChannels, categories } =
    getActivityIgnoreSets(guildId);
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
 * Paginate one channel; count messages older than watermark.
 * @param {object} opts
 * @param {import("discord.js").GuildTextBasedChannel} opts.channel
 * @param {number} opts.watermarkMs
 * @param {string|null} opts.onlyUserId if set, only count this author
 * @param {"user"|"guild"} opts.cursorMode
 * @returns {Promise<{ counted: number, complete: boolean, partial: boolean }>}
 */
async function backfillChannelHistory(opts) {
  const { channel, watermarkMs, onlyUserId = null, cursorMode } = opts;
  const guildId = channel.guildId || channel.guild?.id;
  let counted = 0;
  let pages = 0;
  let before = undefined;
  let complete = false;
  let partial = false;

  // Guild-complete channels are fully ingested for all users — skip both modes
  const guildCursor = getGuildChannelBackfillCursor(guildId, channel.id);
  if (guildCursor?.complete) {
    return { counted: 0, complete: true, partial: false };
  }

  if (cursorMode === "user" && onlyUserId) {
    const cursor = getBackfillCursor(guildId, onlyUserId, channel.id);
    if (cursor?.complete) {
      return { counted: 0, complete: true, partial: false };
    }
    if (cursor?.oldest_message_id) {
      before = cursor.oldest_message_id;
    }
  } else if (cursorMode === "guild") {
    if (guildCursor?.oldest_message_id) {
      before = guildCursor.oldest_message_id;
    }
  }

  while (pages < MAX_PAGES_PER_CHANNEL) {
    const fetchOpts = { limit: PAGE_SIZE };
    if (before) fetchOpts.before = before;

    let batch;
    try {
      batch = await channel.messages.fetch(fetchOpts);
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

    /** @type {Map<string, number>} key userId\0day */
    const bucket = new Map();

    for (const msg of msgs) {
      const ts = msg.createdTimestamp || 0;
      if (ts >= watermarkMs) continue;
      if (msg.author?.bot) continue;
      const authorId = msg.author?.id;
      if (!authorId) continue;
      if (onlyUserId && authorId !== onlyUserId) continue;
      const day = utcDayKey(ts);
      const key = `${authorId}\0${day}`;
      bucket.set(key, (bucket.get(key) || 0) + 1);
    }

    for (const [key, n] of bucket) {
      const [authorId, day] = key.split("\0");
      incrementDaily(guildId, authorId, channel.id, day, n);
      counted += n;
    }

    const oldest = msgs[msgs.length - 1];
    before = oldest?.id;

    if (cursorMode === "user" && onlyUserId) {
      upsertBackfillCursor(guildId, onlyUserId, channel.id, {
        oldest_message_id: before,
        complete: false,
      });
    } else if (cursorMode === "guild") {
      upsertGuildChannelBackfillCursor(guildId, channel.id, {
        oldest_message_id: before,
        complete: false,
      });
    }

    pages += 1;
    await sleep(DELAY_MS);

    if (batch.size < PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  if (pages >= MAX_PAGES_PER_CHANNEL && !complete) {
    partial = true;
  }

  if (complete) {
    if (cursorMode === "user" && onlyUserId) {
      upsertBackfillCursor(guildId, onlyUserId, channel.id, {
        oldest_message_id: before || null,
        complete: true,
      });
    } else if (cursorMode === "guild") {
      upsertGuildChannelBackfillCursor(guildId, channel.id, {
        oldest_message_id: before || null,
        complete: true,
      });
    }
  }

  return { counted, complete, partial };
}

/**
 * Per-user backfill (Activity button).
 * @param {import("discord.js").Guild} guild
 * @param {string} userId
 * @returns {Promise<{ started: boolean, reason?: string }>}
 */
async function startUserBackfill(guild, userId) {
  const guildId = guild.id;
  ensureGuildActivitySettings(guildId);
  const settings = getGuildActivitySettings(guildId);
  const watermarkMs = settings?.collect_from_ms ?? Date.now();

  if (guildHasActiveBackfill(guildId) || guildJobs.has(guildId)) {
    return {
      started: false,
      reason: "A backfill is already running in this server.",
    };
  }

  const meta = getUserActivityMeta(guildId, userId);
  if (
    meta?.backfill_status === "running" ||
    meta?.backfill_status === "queued"
  ) {
    return {
      started: false,
      reason: "Backfill already in progress for this user.",
    };
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
        const result = await backfillChannelHistory({
          channel: ch,
          watermarkMs,
          onlyUserId: userId,
          cursorMode: "user",
        });
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
      console.error("[userActivity] user backfill job failed:", error);
    } finally {
      const status = error ? "failed" : anyPartial ? "partial" : "done";
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
  job.catch((e) =>
    console.error("[userActivity] user backfill unhandled:", e)
  );

  return { started: true };
}

/**
 * Guild-wide single-pass backfill: each channel scanned once for all authors.
 * Prefer this over N× per-user runs.
 * @param {import("discord.js").Guild} guild
 * @returns {Promise<{ started: boolean, reason?: string, channels?: number }>}
 */
async function startGuildBackfill(guild) {
  const guildId = guild.id;
  ensureGuildActivitySettings(guildId);
  const settings = getGuildActivitySettings(guildId);
  const watermarkMs = settings?.collect_from_ms ?? Date.now();

  if (guildHasActiveBackfill(guildId) || guildJobs.has(guildId)) {
    return {
      started: false,
      reason: "A backfill is already running in this server.",
    };
  }

  const channels = listBackfillChannels(guild, guildId);
  patchGuildActivitySettings(guildId, {
    guild_backfill_status: "running",
    guild_backfill_started_at: Date.now(),
    guild_backfill_finished_at: null,
    guild_backfill_error: null,
    guild_backfill_channels_done: 0,
    guild_backfill_channels_total: channels.length,
    guild_backfill_messages_counted: 0,
  });

  const job = (async () => {
    let anyPartial = false;
    let error = null;
    let done = 0;
    let messagesCounted = 0;
    try {
      for (const ch of channels) {
        const result = await backfillChannelHistory({
          channel: ch,
          watermarkMs,
          onlyUserId: null,
          cursorMode: "guild",
        });
        done += 1;
        messagesCounted += result.counted || 0;
        if (result.partial || !result.complete) anyPartial = true;
        patchGuildActivitySettings(guildId, {
          guild_backfill_status: "running",
          guild_backfill_channels_done: done,
          guild_backfill_channels_total: channels.length,
          guild_backfill_messages_counted: messagesCounted,
        });
      }
    } catch (e) {
      error = e?.message || String(e);
      console.error("[userActivity] guild backfill job failed:", error);
    } finally {
      const status = error ? "failed" : anyPartial ? "partial" : "done";
      patchGuildActivitySettings(guildId, {
        guild_backfill_status: status,
        guild_backfill_finished_at: Date.now(),
        guild_backfill_error: error,
        guild_backfill_channels_done: done,
        guild_backfill_channels_total: channels.length,
        guild_backfill_messages_counted: messagesCounted,
      });
      guildJobs.delete(guildId);
    }
  })();

  guildJobs.set(guildId, job);
  job.catch((e) =>
    console.error("[userActivity] guild backfill unhandled:", e)
  );

  return { started: true, channels: channels.length };
}

/** @deprecated use backfillChannelHistory — kept for tests */
async function backfillChannel(channel, userId, watermarkMs) {
  return backfillChannelHistory({
    channel,
    watermarkMs,
    onlyUserId: userId,
    cursorMode: "user",
  });
}

module.exports = {
  PAGE_SIZE,
  MAX_PAGES_PER_CHANNEL,
  DELAY_MS,
  listBackfillChannels,
  startUserBackfill,
  startGuildBackfill,
  backfillChannel,
  backfillChannelHistory,
};
