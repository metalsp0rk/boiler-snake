/**
 * Warnings post-MVP: optional expiry, evidence fields, guild default expiry days.
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "guild_settings",
    "warn_expiry_days",
    "warn_expiry_days INTEGER NOT NULL DEFAULT 0"
  );

  addColumnIfMissing("warnings", "expires_at", "expires_at INTEGER");
  addColumnIfMissing(
    "warnings",
    "evidence_message_url",
    "evidence_message_url TEXT"
  );
  addColumnIfMissing("warnings", "evidence_text", "evidence_text TEXT");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_warnings_expires
      ON warnings(expires_at)
      WHERE voided_at IS NULL AND expires_at IS NOT NULL;
  `);
}

module.exports = { id: "017_warn_post_mvp", up };
