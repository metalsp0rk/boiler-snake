/**
 * Day-lead index for the retention daily-aggregate prune (issue #396, DB-4).
 *
 * `deleteDailyAggregatesBeforeDay` runs `DELETE … WHERE day < ? LIMIT ?` —
 * globally (no community_id), every hour, against one of the three largest
 * tables. user_channel_message_daily's PK leads with community_id and both
 * secondary indexes do too, so the hourly prune full-scanned the whole
 * table forever: the sweep's own header promises "exactly ONE cheap INDEXED
 * statement" per idle table, and this table broke the promise on every
 * quiet hour (the activity_log sweep correctly rides idx_activity_created_at).
 *
 * idx_ucmd_day(day) turns the hourly idle sweep into a single index-range
 * probe and the expired-row delete into an O(log n + k) range delete.
 *
 * @param {import("better-sqlite3").Database} db
 */
function up(db) {
  db.exec(`
CREATE INDEX IF NOT EXISTS idx_ucmd_day
  ON user_channel_message_daily (day);
`);
}

module.exports = { id: "054_ucmd_day_index", up };
