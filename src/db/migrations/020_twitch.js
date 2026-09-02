/**
 * Twitch stream notifications: subscription table + guild_settings columns.
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS twitch_channels (
    guild_id          TEXT NOT NULL,
    broadcaster_id    TEXT NOT NULL,
    login             TEXT NOT NULL,
    display_name      TEXT NOT NULL,
    profile_image_url TEXT,
    is_live           INTEGER NOT NULL DEFAULT 0,
    last_stream_id    TEXT,
    last_checked      INTEGER,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    PRIMARY KEY (guild_id, broadcaster_id),
    UNIQUE (guild_id, login)
  );
  CREATE INDEX IF NOT EXISTS idx_twitch_channels_broadcaster
    ON twitch_channels(broadcaster_id);
  `);

  addColumnIfMissing(
    "guild_settings",
    "twitch_notification_channel_id",
    "twitch_notification_channel_id TEXT"
  );
  addColumnIfMissing(
    "guild_settings",
    "twitch_notify_role_id",
    "twitch_notify_role_id TEXT"
  );
  addColumnIfMissing(
    "guild_settings",
    "twitch_polling_interval_minutes",
    "twitch_polling_interval_minutes INTEGER NOT NULL DEFAULT 2"
  );
}

module.exports = { id: "020_twitch", up };
