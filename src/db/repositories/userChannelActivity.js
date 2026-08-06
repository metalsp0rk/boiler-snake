/**
 * User channel message activity — daily counters, ignore list, backfill meta.
 * Independent of activity_log / XP cooldowns.
 */

const { db, now } = require("../connection");

const IGNORE_KINDS = Object.freeze(["channel", "category"]);
const BACKFILL_STATUSES = Object.freeze([
  "none",
  "queued",
  "running",
  "done",
  "failed",
  "partial",
  "cancelled",
]);

/**
 * UTC calendar day key from epoch ms.
 * @param {number} [ms]
 * @returns {string} YYYY-MM-DD
 */
function utcDayKey(ms = now()) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) {
    return utcDayKey(now());
  }
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * @param {number} daysAgo
 * @param {number} [fromMs]
 * @returns {string}
 */
function utcDayKeyDaysAgo(daysAgo, fromMs = now()) {
  const ms = Number(fromMs) - Math.max(0, Number(daysAgo) || 0) * 86400000;
  return utcDayKey(ms);
}

/**
 * @param {string} kind
 * @returns {"channel"|"category"}
 */
function normalizeIgnoreKind(kind) {
  const v = String(kind || "")
    .trim()
    .toLowerCase();
  if (v === "category" || v === "cat") return "category";
  return "channel";
}

/**
 * Ensure guild has a collect_from watermark.
 * First touch sets watermark (default: now). Prefer passing the first message's
 * createdTimestamp so the triggering message is not rejected by clock ordering.
 * @param {string} guildId
 * @param {{ collectFromMs?: number }} [opts]
 * @returns {{ guild_id: string, collect_from_ms: number, created_at: number }}
 */
function ensureGuildActivitySettings(guildId, opts = {}) {
  const existing = getGuildActivitySettings(guildId);
  if (existing) return existing;

  const t =
    opts.collectFromMs != null && Number.isFinite(Number(opts.collectFromMs))
      ? Number(opts.collectFromMs)
      : now();
  const created = now();
  db.prepare(
    `
  INSERT INTO guild_activity_settings (guild_id, collect_from_ms, created_at)
  VALUES (?, ?, ?)
  `
  ).run(guildId, t, created);

  return (
    getGuildActivitySettings(guildId) || {
      guild_id: guildId,
      collect_from_ms: t,
      created_at: created,
    }
  );
}

const GUILD_SETTINGS_COLS = `
  guild_id, collect_from_ms, created_at,
  guild_backfill_status, guild_backfill_started_at, guild_backfill_finished_at,
  guild_backfill_error, guild_backfill_channels_done, guild_backfill_channels_total,
  guild_backfill_messages_counted
`;

/**
 * @param {string} guildId
 * @returns {object|null}
 */
function getGuildActivitySettings(guildId) {
  return (
    db
      .prepare(
        `SELECT ${GUILD_SETTINGS_COLS} FROM guild_activity_settings WHERE guild_id=?`
      )
      .get(guildId) || null
  );
}

/**
 * Patch guild activity settings (backfill progress, etc.).
 * @param {string} guildId
 * @param {object} patch
 * @returns {object|null}
 */
function patchGuildActivitySettings(guildId, patch = {}) {
  ensureGuildActivitySettings(guildId);
  const existing = getGuildActivitySettings(guildId);
  if (!existing) return null;

  const next = {
    guild_backfill_status:
      patch.guild_backfill_status !== undefined
        ? patch.guild_backfill_status
        : existing.guild_backfill_status ?? "none",
    guild_backfill_started_at:
      patch.guild_backfill_started_at !== undefined
        ? patch.guild_backfill_started_at
        : existing.guild_backfill_started_at,
    guild_backfill_finished_at:
      patch.guild_backfill_finished_at !== undefined
        ? patch.guild_backfill_finished_at
        : existing.guild_backfill_finished_at,
    guild_backfill_error:
      patch.guild_backfill_error !== undefined
        ? patch.guild_backfill_error
        : existing.guild_backfill_error,
    guild_backfill_channels_done:
      patch.guild_backfill_channels_done !== undefined
        ? patch.guild_backfill_channels_done
        : existing.guild_backfill_channels_done ?? 0,
    guild_backfill_channels_total:
      patch.guild_backfill_channels_total !== undefined
        ? patch.guild_backfill_channels_total
        : existing.guild_backfill_channels_total ?? 0,
    guild_backfill_messages_counted:
      patch.guild_backfill_messages_counted !== undefined
        ? patch.guild_backfill_messages_counted
        : existing.guild_backfill_messages_counted ?? 0,
  };

  db.prepare(
    `
  UPDATE guild_activity_settings SET
    guild_backfill_status=?,
    guild_backfill_started_at=?,
    guild_backfill_finished_at=?,
    guild_backfill_error=?,
    guild_backfill_channels_done=?,
    guild_backfill_channels_total=?,
    guild_backfill_messages_counted=?
  WHERE guild_id=?
  `
  ).run(
    next.guild_backfill_status,
    next.guild_backfill_started_at,
    next.guild_backfill_finished_at,
    next.guild_backfill_error,
    next.guild_backfill_channels_done,
    next.guild_backfill_channels_total,
    next.guild_backfill_messages_counted,
    guildId
  );
  return getGuildActivitySettings(guildId);
}

/**
 * Increment daily counter (live or backfill).
 * @param {string} guildId
 * @param {string} userId
 * @param {string} channelId
 * @param {string} day YYYY-MM-DD
 * @param {number} [n=1]
 */
function incrementDaily(guildId, userId, channelId, day, n = 1) {
  const amount = Math.max(0, Math.floor(Number(n) || 0));
  if (!amount) return;
  db.prepare(
    `
  INSERT INTO user_channel_message_daily (guild_id, user_id, channel_id, day, count)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(guild_id, user_id, channel_id, day)
  DO UPDATE SET count = count + excluded.count
  `
  ).run(guildId, userId, channelId, day, amount);
}

/**
 * @param {string} guildId
 * @param {string} targetId
 * @param {"channel"|"category"} kind
 * @returns {boolean} true if inserted
 */
function addActivityIgnore(guildId, targetId, kind) {
  const k = normalizeIgnoreKind(kind);
  const result = db
    .prepare(
      `
  INSERT OR IGNORE INTO activity_ignore (guild_id, target_id, kind, created_at)
  VALUES (?, ?, ?, ?)
  `
    )
    .run(guildId, targetId, k, now());
  return result.changes > 0;
}

/**
 * @param {string} guildId
 * @param {string} targetId
 * @returns {boolean}
 */
function removeActivityIgnore(guildId, targetId) {
  const result = db
    .prepare(`DELETE FROM activity_ignore WHERE guild_id=? AND target_id=?`)
    .run(guildId, targetId);
  return result.changes > 0;
}

/**
 * @param {string} guildId
 * @returns {{ target_id: string, kind: string, created_at: number }[]}
 */
function listActivityIgnore(guildId) {
  return db
    .prepare(
      `
  SELECT target_id, kind, created_at
  FROM activity_ignore
  WHERE guild_id=?
  ORDER BY kind ASC, created_at ASC
  `
    )
    .all(guildId);
}

/**
 * @param {string} guildId
 * @param {string} targetId
 * @returns {boolean}
 */
function isActivityIgnored(guildId, targetId) {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM activity_ignore WHERE guild_id=? AND target_id=?`
    )
    .get(guildId, targetId);
  return !!row;
}

/**
 * Set of ignored channel ids and category ids for a guild.
 * @param {string} guildId
 * @returns {{ channels: Set<string>, categories: Set<string> }}
 */
function getActivityIgnoreSets(guildId) {
  const rows = listActivityIgnore(guildId);
  const channels = new Set();
  const categories = new Set();
  for (const r of rows) {
    if (r.kind === "category") categories.add(r.target_id);
    else channels.add(r.target_id);
  }
  return { channels, categories };
}

/**
 * Sum counts by channel for a user, optional lower day bound (inclusive).
 * Does not apply ignore rules (service layer filters).
 * @param {string} guildId
 * @param {string} userId
 * @param {{ sinceDay?: string|null }} [opts]
 * @returns {{ channel_id: string, count: number }[]}
 */
function sumByChannel(guildId, userId, opts = {}) {
  const sinceDay = opts.sinceDay || null;
  if (sinceDay) {
    return db
      .prepare(
        `
    SELECT channel_id, SUM(count) AS count
    FROM user_channel_message_daily
    WHERE guild_id=? AND user_id=? AND day >= ?
    GROUP BY channel_id
    HAVING SUM(count) > 0
    ORDER BY count DESC
    `
      )
      .all(guildId, userId, sinceDay)
      .map((r) => ({ channel_id: r.channel_id, count: Number(r.count) || 0 }));
  }
  return db
    .prepare(
      `
  SELECT channel_id, SUM(count) AS count
  FROM user_channel_message_daily
  WHERE guild_id=? AND user_id=?
  GROUP BY channel_id
  HAVING SUM(count) > 0
  ORDER BY count DESC
  `
    )
    .all(guildId, userId)
    .map((r) => ({ channel_id: r.channel_id, count: Number(r.count) || 0 }));
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @param {{ sinceDay?: string|null }} [opts]
 * @returns {number}
 */
function totalPosts(guildId, userId, opts = {}) {
  const sinceDay = opts.sinceDay || null;
  if (sinceDay) {
    const row = db
      .prepare(
        `
    SELECT COALESCE(SUM(count), 0) AS c
    FROM user_channel_message_daily
    WHERE guild_id=? AND user_id=? AND day >= ?
    `
      )
      .get(guildId, userId, sinceDay);
    return Number(row?.c) || 0;
  }
  const row = db
    .prepare(
      `
  SELECT COALESCE(SUM(count), 0) AS c
  FROM user_channel_message_daily
  WHERE guild_id=? AND user_id=?
  `
    )
    .get(guildId, userId);
  return Number(row?.c) || 0;
}

/**
 * Earliest day with any counter for this user (tracking footprint).
 * @param {string} guildId
 * @param {string} userId
 * @returns {string|null}
 */
function earliestTrackedDay(guildId, userId) {
  const row = db
    .prepare(
      `
  SELECT MIN(day) AS d
  FROM user_channel_message_daily
  WHERE guild_id=? AND user_id=?
  `
    )
    .get(guildId, userId);
  return row?.d || null;
}

/**
 * Approximate row / message stats for status command.
 * @param {string} guildId
 * @returns {{ day_rows: number, message_total: number, ignore_count: number }}
 */
function guildActivityStats(guildId) {
  const dayRows =
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM user_channel_message_daily WHERE guild_id=?`
      )
      .get(guildId)?.c ?? 0;
  const messageTotal =
    db
      .prepare(
        `SELECT COALESCE(SUM(count), 0) AS c FROM user_channel_message_daily WHERE guild_id=?`
      )
      .get(guildId)?.c ?? 0;
  const ignoreCount =
    db
      .prepare(`SELECT COUNT(*) AS c FROM activity_ignore WHERE guild_id=?`)
      .get(guildId)?.c ?? 0;
  return {
    day_rows: Number(dayRows) || 0,
    message_total: Number(messageTotal) || 0,
    ignore_count: Number(ignoreCount) || 0,
  };
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @returns {object|null}
 */
function getUserActivityMeta(guildId, userId) {
  return (
    db
      .prepare(
        `
  SELECT guild_id, user_id, tracking_since_ms, backfill_status,
         backfill_started_at, backfill_finished_at, backfill_error,
         backfill_channels_done, backfill_channels_total
  FROM user_activity_meta
  WHERE guild_id=? AND user_id=?
  `
      )
      .get(guildId, userId) || null
  );
}

/**
 * Upsert meta fields.
 * @param {string} guildId
 * @param {string} userId
 * @param {object} patch
 */
function upsertUserActivityMeta(guildId, userId, patch = {}) {
  const existing = getUserActivityMeta(guildId, userId);
  if (!existing) {
    db.prepare(
      `
    INSERT INTO user_activity_meta (
      guild_id, user_id, tracking_since_ms, backfill_status,
      backfill_started_at, backfill_finished_at, backfill_error,
      backfill_channels_done, backfill_channels_total
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      guildId,
      userId,
      patch.tracking_since_ms ?? null,
      patch.backfill_status ?? "none",
      patch.backfill_started_at ?? null,
      patch.backfill_finished_at ?? null,
      patch.backfill_error ?? null,
      patch.backfill_channels_done ?? 0,
      patch.backfill_channels_total ?? 0
    );
    return getUserActivityMeta(guildId, userId);
  }

  const next = {
    tracking_since_ms:
      patch.tracking_since_ms !== undefined
        ? patch.tracking_since_ms
        : existing.tracking_since_ms,
    backfill_status:
      patch.backfill_status !== undefined
        ? patch.backfill_status
        : existing.backfill_status,
    backfill_started_at:
      patch.backfill_started_at !== undefined
        ? patch.backfill_started_at
        : existing.backfill_started_at,
    backfill_finished_at:
      patch.backfill_finished_at !== undefined
        ? patch.backfill_finished_at
        : existing.backfill_finished_at,
    backfill_error:
      patch.backfill_error !== undefined
        ? patch.backfill_error
        : existing.backfill_error,
    backfill_channels_done:
      patch.backfill_channels_done !== undefined
        ? patch.backfill_channels_done
        : existing.backfill_channels_done,
    backfill_channels_total:
      patch.backfill_channels_total !== undefined
        ? patch.backfill_channels_total
        : existing.backfill_channels_total,
  };

  db.prepare(
    `
  UPDATE user_activity_meta SET
    tracking_since_ms=?,
    backfill_status=?,
    backfill_started_at=?,
    backfill_finished_at=?,
    backfill_error=?,
    backfill_channels_done=?,
    backfill_channels_total=?
  WHERE guild_id=? AND user_id=?
  `
  ).run(
    next.tracking_since_ms,
    next.backfill_status,
    next.backfill_started_at,
    next.backfill_finished_at,
    next.backfill_error,
    next.backfill_channels_done,
    next.backfill_channels_total,
    guildId,
    userId
  );
  return getUserActivityMeta(guildId, userId);
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @param {string} channelId
 * @returns {{ oldest_message_id: string|null, complete: number }|null}
 */
function getBackfillCursor(guildId, userId, channelId) {
  return (
    db
      .prepare(
        `
  SELECT oldest_message_id, complete
  FROM user_channel_backfill_cursor
  WHERE guild_id=? AND user_id=? AND channel_id=?
  `
      )
      .get(guildId, userId, channelId) || null
  );
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @param {string} channelId
 * @param {{ oldest_message_id?: string|null, complete?: boolean }} patch
 */
function upsertBackfillCursor(guildId, userId, channelId, patch = {}) {
  const existing = getBackfillCursor(guildId, userId, channelId);
  const complete = patch.complete === true ? 1 : patch.complete === false ? 0 : existing?.complete ?? 0;
  const oldest =
    patch.oldest_message_id !== undefined
      ? patch.oldest_message_id
      : existing?.oldest_message_id ?? null;

  db.prepare(
    `
  INSERT INTO user_channel_backfill_cursor
    (guild_id, user_id, channel_id, oldest_message_id, complete)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(guild_id, user_id, channel_id)
  DO UPDATE SET oldest_message_id=excluded.oldest_message_id, complete=excluded.complete
  `
  ).run(guildId, userId, channelId, oldest, complete);
}

/**
 * True if any user or guild-wide backfill is running/queued.
 * @param {string} guildId
 * @returns {boolean}
 */
function guildHasActiveBackfill(guildId) {
  const settings = getGuildActivitySettings(guildId);
  if (
    settings?.guild_backfill_status === "running" ||
    settings?.guild_backfill_status === "queued"
  ) {
    return true;
  }
  const row = db
    .prepare(
      `
  SELECT 1 AS ok FROM user_activity_meta
  WHERE guild_id=? AND backfill_status IN ('queued', 'running')
  LIMIT 1
  `
    )
    .get(guildId);
  return !!row;
}

/**
 * @param {string} guildId
 * @param {string} channelId
 * @returns {{ oldest_message_id: string|null, complete: number }|null}
 */
function getGuildChannelBackfillCursor(guildId, channelId) {
  return (
    db
      .prepare(
        `
  SELECT oldest_message_id, complete
  FROM guild_channel_backfill_cursor
  WHERE guild_id=? AND channel_id=?
  `
      )
      .get(guildId, channelId) || null
  );
}

/**
 * @param {string} guildId
 * @param {string} channelId
 * @param {{ oldest_message_id?: string|null, complete?: boolean }} patch
 */
function upsertGuildChannelBackfillCursor(guildId, channelId, patch = {}) {
  const existing = getGuildChannelBackfillCursor(guildId, channelId);
  const complete =
    patch.complete === true
      ? 1
      : patch.complete === false
        ? 0
        : existing?.complete ?? 0;
  const oldest =
    patch.oldest_message_id !== undefined
      ? patch.oldest_message_id
      : existing?.oldest_message_id ?? null;

  db.prepare(
    `
  INSERT INTO guild_channel_backfill_cursor
    (guild_id, channel_id, oldest_message_id, complete)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(guild_id, channel_id)
  DO UPDATE SET oldest_message_id=excluded.oldest_message_id, complete=excluded.complete
  `
  ).run(guildId, channelId, oldest, complete);
}

/**
 * Count completed guild-level channel cursors.
 * @param {string} guildId
 * @returns {{ complete: number, total: number }}
 */
function guildChannelBackfillProgress(guildId) {
  const total =
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM guild_channel_backfill_cursor WHERE guild_id=?`
      )
      .get(guildId)?.c ?? 0;
  const complete =
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM guild_channel_backfill_cursor WHERE guild_id=? AND complete=1`
      )
      .get(guildId)?.c ?? 0;
  return { complete: Number(complete) || 0, total: Number(total) || 0 };
}

module.exports = {
  IGNORE_KINDS,
  BACKFILL_STATUSES,
  utcDayKey,
  utcDayKeyDaysAgo,
  normalizeIgnoreKind,
  ensureGuildActivitySettings,
  getGuildActivitySettings,
  patchGuildActivitySettings,
  incrementDaily,
  addActivityIgnore,
  removeActivityIgnore,
  listActivityIgnore,
  isActivityIgnored,
  getActivityIgnoreSets,
  sumByChannel,
  totalPosts,
  earliestTrackedDay,
  guildActivityStats,
  getUserActivityMeta,
  upsertUserActivityMeta,
  getBackfillCursor,
  upsertBackfillCursor,
  guildHasActiveBackfill,
  getGuildChannelBackfillCursor,
  upsertGuildChannelBackfillCursor,
  guildChannelBackfillProgress,
};
