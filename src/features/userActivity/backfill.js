/**
 * Message history backfill (best-effort, rate-limited).
 *
 * Live ingest counts messages with createdTimestamp >= guild collect_from_ms.
 * Backfill counts messages strictly older than that watermark so rows never double-count.
 *
 * Modes:
 * - Per-user: scan channels counting only one author (Activity button)
 * - Guild-wide: single pass per channel counting all human authors (/activityconfig backfill all)
 * - Cancel: cooperative stop between pages/channels (/activityconfig backfill cancel)
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
  db,
} = require("../../db");
const { shouldSkipChannel } = require("./service");

const PAGE_SIZE = 100;
/** Default pages per channel when not overridden (100 msgs/page → ~5k). */
const MAX_PAGES_PER_CHANNEL = 50;
/** Absolute floor / ceiling for the max_pages option. */
const MIN_PAGES_PER_CHANNEL = 1;
const ABS_MAX_PAGES_PER_CHANNEL = 500;
const DELAY_MS = 1100;

/**
 * Active job per guild.
 * @type {Map<string, { promise: Promise<void>, kind: "guild"|"user", userId: string|null, cancelled: boolean }>}
 */
const guildJobs = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Clamp max pages per channel for a backfill run.
 * @param {number|null|undefined} value
 * @returns {number}
 */
function normalizeMaxPagesPerChannel(value) {
  if (value == null || !Number.isFinite(Number(value))) {
    return MAX_PAGES_PER_CHANNEL;
  }
  const n = Math.floor(Number(value));
  if (n < MIN_PAGES_PER_CHANNEL) return MIN_PAGES_PER_CHANNEL;
  if (n > ABS_MAX_PAGES_PER_CHANNEL) return ABS_MAX_PAGES_PER_CHANNEL;
  return n;
}

/**
 * @param {string} guildId
 * @returns {boolean}
 */
function isBackfillCancelled(guildId) {
  return guildJobs.get(guildId)?.cancelled === true;
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
 * @param {number} [opts.maxPagesPerChannel]
 * @param {() => boolean} [opts.isCancelled]
 * @returns {Promise<{ counted: number, complete: boolean, partial: boolean, cancelled?: boolean }>}
 */
async function backfillChannelHistory(opts) {
  const {
    channel,
    watermarkMs,
    onlyUserId = null,
    cursorMode,
    isCancelled = () => false,
  } = opts;
  const maxPages = normalizeMaxPagesPerChannel(opts.maxPagesPerChannel);
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

  while (pages < maxPages) {
    if (isCancelled()) {
      return { counted, complete: false, partial: true, cancelled: true };
    }

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

    if (isCancelled()) {
      return { counted, complete: false, partial: true, cancelled: true };
    }

    if (batch.size < PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  if (pages >= maxPages && !complete) {
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
 * @param {string} guildId
 * @returns {string|null} userId if a per-user job is marked running in DB
 */
function findRunningUserBackfill(guildId) {
  const row = db
    .prepare(
      `
  SELECT user_id FROM user_activity_meta
  WHERE guild_id=? AND backfill_status IN ('queued', 'running')
  LIMIT 1
  `
    )
    .get(guildId);
  return row?.user_id || null;
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

  /** @type {{ promise: Promise<void>, kind: "user", userId: string, cancelled: boolean }} */
  const jobState = {
    promise: null,
    kind: "user",
    userId,
    cancelled: false,
  };

  const job = (async () => {
    let anyPartial = false;
    let error = null;
    let done = 0;
    let cancelled = false;
    try {
      for (const ch of channels) {
        if (jobState.cancelled) {
          cancelled = true;
          break;
        }
        const result = await backfillChannelHistory({
          channel: ch,
          watermarkMs,
          onlyUserId: userId,
          cursorMode: "user",
          isCancelled: () => jobState.cancelled,
        });
        if (result.cancelled) {
          cancelled = true;
          break;
        }
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
      const status = cancelled
        ? "cancelled"
        : error
          ? "failed"
          : anyPartial
            ? "partial"
            : "done";
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

  jobState.promise = job;
  guildJobs.set(guildId, jobState);
  job.catch((e) =>
    console.error("[userActivity] user backfill unhandled:", e)
  );

  return { started: true };
}

/**
 * Guild-wide single-pass backfill: each channel scanned once for all authors.
 * Prefer this over N× per-user runs.
 * @param {import("discord.js").Guild} guild
 * @param {{ maxPagesPerChannel?: number }} [opts]
 * @returns {Promise<{ started: boolean, reason?: string, channels?: number, maxPagesPerChannel?: number }>}
 */
async function startGuildBackfill(guild, opts = {}) {
  const guildId = guild.id;
  ensureGuildActivitySettings(guildId);
  const settings = getGuildActivitySettings(guildId);
  const watermarkMs = settings?.collect_from_ms ?? Date.now();
  const maxPagesPerChannel = normalizeMaxPagesPerChannel(
    opts.maxPagesPerChannel
  );

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

  /** @type {{ promise: Promise<void>, kind: "guild", userId: null, cancelled: boolean }} */
  const jobState = {
    promise: null,
    kind: "guild",
    userId: null,
    cancelled: false,
  };

  const job = (async () => {
    let anyPartial = false;
    let error = null;
    let done = 0;
    let messagesCounted = 0;
    let cancelled = false;
    try {
      for (const ch of channels) {
        if (jobState.cancelled) {
          cancelled = true;
          break;
        }
        const result = await backfillChannelHistory({
          channel: ch,
          watermarkMs,
          onlyUserId: null,
          cursorMode: "guild",
          maxPagesPerChannel,
          isCancelled: () => jobState.cancelled,
        });
        if (result.cancelled) {
          cancelled = true;
          break;
        }
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
      const status = cancelled
        ? "cancelled"
        : error
          ? "failed"
          : anyPartial
            ? "partial"
            : "done";
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

  jobState.promise = job;
  guildJobs.set(guildId, jobState);
  job.catch((e) =>
    console.error("[userActivity] guild backfill unhandled:", e)
  );

  return {
    started: true,
    channels: channels.length,
    maxPagesPerChannel,
  };
}

/**
 * Request cancel of the in-process backfill for a guild (guild-wide or per-user).
 * Cooperative: stops after the current page fetch / sleep at latest.
 * Also clears stale "running" DB rows if no in-memory job (e.g. after restart).
 *
 * @param {string} guildId
 * @returns {{ cancelled: boolean, kind?: "guild"|"user"|null, reason?: string }}
 */
function cancelBackfill(guildId) {
  const job = guildJobs.get(guildId);
  if (job) {
    job.cancelled = true;
    return {
      cancelled: true,
      kind: job.kind,
      reason:
        "Cancel requested. The job will stop after the current page (usually within ~1–2s).",
    };
  }

  // Stale status after process restart: nothing to stop in memory
  ensureGuildActivitySettings(guildId);
  const settings = getGuildActivitySettings(guildId);
  const guildRunning =
    settings?.guild_backfill_status === "running" ||
    settings?.guild_backfill_status === "queued";
  const runningUserId = findRunningUserBackfill(guildId);

  if (!guildRunning && !runningUserId) {
    return {
      cancelled: false,
      kind: null,
      reason: "No backfill is running in this server.",
    };
  }

  if (guildRunning) {
    patchGuildActivitySettings(guildId, {
      guild_backfill_status: "cancelled",
      guild_backfill_finished_at: Date.now(),
      guild_backfill_error: "Cancelled (no active worker — process may have restarted).",
    });
  }
  if (runningUserId) {
    upsertUserActivityMeta(guildId, runningUserId, {
      backfill_status: "cancelled",
      backfill_finished_at: Date.now(),
      backfill_error: "Cancelled (no active worker — process may have restarted).",
    });
  }

  return {
    cancelled: true,
    kind: guildRunning ? "guild" : "user",
    reason:
      "Cleared stale running status (no in-process job). Safe to start a new backfill.",
  };
}

/**
 * @param {string} guildId
 * @returns {{ active: boolean, kind: "guild"|"user"|null, userId: string|null, cancelling: boolean }}
 */
function getBackfillJobInfo(guildId) {
  const job = guildJobs.get(guildId);
  if (job) {
    return {
      active: true,
      kind: job.kind,
      userId: job.userId,
      cancelling: job.cancelled,
    };
  }
  return { active: false, kind: null, userId: null, cancelling: false };
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
  MIN_PAGES_PER_CHANNEL,
  ABS_MAX_PAGES_PER_CHANNEL,
  DELAY_MS,
  normalizeMaxPagesPerChannel,
  listBackfillChannels,
  startUserBackfill,
  startGuildBackfill,
  cancelBackfill,
  getBackfillJobInfo,
  isBackfillCancelled,
  backfillChannel,
  backfillChannelHistory,
};
