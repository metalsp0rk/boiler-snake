/**
 * Per-event mute for scheduled event reminders (independent of guild-wide opt-out).
 * @param {import("better-sqlite3").Database} db
 */
function up(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS event_reminder_event_optouts (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scheduled_event_id TEXT NOT NULL,
  muted_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, scheduled_event_id)
);
CREATE INDEX IF NOT EXISTS idx_er_event_optouts_user
  ON event_reminder_event_optouts(guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_er_event_optouts_event
  ON event_reminder_event_optouts(guild_id, scheduled_event_id);
`);
}

module.exports = { id: "015_event_reminder_event_optouts", up };
