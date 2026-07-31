/**
 * Scheduled event reminders: configs, offsets, opt-outs, guild default channel.
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "guild_settings",
    "event_reminder_channel_id",
    "event_reminder_channel_id TEXT"
  );

  db.exec(`
CREATE TABLE IF NOT EXISTS event_reminder_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  scheduled_event_id TEXT NOT NULL,
  shortname TEXT NOT NULL,
  role_id TEXT NOT NULL,
  channel_id TEXT,
  message_template TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE (guild_id, scheduled_event_id),
  UNIQUE (guild_id, shortname)
);

CREATE TABLE IF NOT EXISTS event_reminder_offsets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id INTEGER NOT NULL REFERENCES event_reminder_configs(id) ON DELETE CASCADE,
  offset_minutes INTEGER NOT NULL,
  fire_at INTEGER NOT NULL,
  sent_at INTEGER,
  message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_reminder_due
  ON event_reminder_offsets(fire_at) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_event_reminder_offsets_config
  ON event_reminder_offsets(config_id);

CREATE TABLE IF NOT EXISTS event_reminder_optouts (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  opted_out_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
`);
}

module.exports = { id: "006_event_reminders", up };
