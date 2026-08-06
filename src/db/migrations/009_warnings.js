/**
 * Warning system: permanent formal disciplinary records + guild DM toggle.
 * Sequential warning_number per guild (W-n); void only (no hard delete).
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "guild_settings",
    "warn_dm_members",
    "warn_dm_members INTEGER NOT NULL DEFAULT 1"
  );

  db.exec(`
CREATE TABLE IF NOT EXISTS warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  warning_number INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  issuer_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  voided_at INTEGER,
  voided_by TEXT,
  void_reason TEXT,
  related_note_id INTEGER REFERENCES staff_notes(id) ON DELETE SET NULL,
  UNIQUE (guild_id, warning_number)
);
CREATE INDEX IF NOT EXISTS idx_warnings_user
  ON warnings(guild_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_warnings_active
  ON warnings(guild_id, user_id) WHERE voided_at IS NULL;
`);
}

module.exports = { id: "009_warnings", up };
