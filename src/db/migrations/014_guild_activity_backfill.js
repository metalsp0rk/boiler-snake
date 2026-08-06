/**
 * Guild-wide activity backfill status + per-channel cursors (single-pass all users).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "guild_activity_settings",
    "guild_backfill_status",
    "guild_backfill_status TEXT NOT NULL DEFAULT 'none'"
  );
  addColumnIfMissing(
    "guild_activity_settings",
    "guild_backfill_started_at",
    "guild_backfill_started_at INTEGER"
  );
  addColumnIfMissing(
    "guild_activity_settings",
    "guild_backfill_finished_at",
    "guild_backfill_finished_at INTEGER"
  );
  addColumnIfMissing(
    "guild_activity_settings",
    "guild_backfill_error",
    "guild_backfill_error TEXT"
  );
  addColumnIfMissing(
    "guild_activity_settings",
    "guild_backfill_channels_done",
    "guild_backfill_channels_done INTEGER NOT NULL DEFAULT 0"
  );
  addColumnIfMissing(
    "guild_activity_settings",
    "guild_backfill_channels_total",
    "guild_backfill_channels_total INTEGER NOT NULL DEFAULT 0"
  );
  addColumnIfMissing(
    "guild_activity_settings",
    "guild_backfill_messages_counted",
    "guild_backfill_messages_counted INTEGER NOT NULL DEFAULT 0"
  );

  db.exec(`
CREATE TABLE IF NOT EXISTS guild_channel_backfill_cursor (
  guild_id          TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  oldest_message_id TEXT,
  complete          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, channel_id)
);
`);
}

module.exports = { id: "014_guild_activity_backfill", up };
