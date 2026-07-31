/**
 * Staff notes: private staff-only notes about guild members.
 * Soft-delete + edit metadata; per-guild sequential note_number.
 * @param {import("better-sqlite3").Database} db
 */
function up(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS staff_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  note_number INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  edited_by TEXT,
  deleted_at INTEGER,
  deleted_by TEXT,
  UNIQUE (guild_id, note_number)
);
CREATE INDEX IF NOT EXISTS idx_staff_notes_user
  ON staff_notes(guild_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_notes_active
  ON staff_notes(guild_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_staff_notes_guild_recent
  ON staff_notes(guild_id, created_at DESC);
`);
}

module.exports = { id: "007_staff_notes", up };
