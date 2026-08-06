/**
 * Per-user per-channel daily message counters for staff activity summaries.
 * Separate from activity_log (XP/decay) — counts every human message.
 *
 * @param {import("better-sqlite3").Database} db
 */
function up(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS user_channel_message_daily (
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, channel_id, day)
);

CREATE INDEX IF NOT EXISTS idx_ucmd_user_day
  ON user_channel_message_daily (guild_id, user_id, day);

CREATE INDEX IF NOT EXISTS idx_ucmd_user_channel
  ON user_channel_message_daily (guild_id, user_id, channel_id);

CREATE TABLE IF NOT EXISTS activity_ignore (
  guild_id   TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_activity_ignore_guild
  ON activity_ignore (guild_id);

CREATE TABLE IF NOT EXISTS user_activity_meta (
  guild_id                 TEXT NOT NULL,
  user_id                  TEXT NOT NULL,
  tracking_since_ms        INTEGER,
  backfill_status          TEXT NOT NULL DEFAULT 'none',
  backfill_started_at      INTEGER,
  backfill_finished_at     INTEGER,
  backfill_error           TEXT,
  backfill_channels_done   INTEGER NOT NULL DEFAULT 0,
  backfill_channels_total  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS guild_activity_settings (
  guild_id        TEXT PRIMARY KEY,
  collect_from_ms INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_channel_backfill_cursor (
  guild_id          TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  oldest_message_id TEXT,
  complete          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, channel_id)
);
`);
}

module.exports = { id: "013_user_channel_activity", up };
