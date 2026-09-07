/**
 * Gork access control: per-guild user blocks + the guild enable switch.
 *
 * - `gork_user_blocks`: users a guild has banned from using gork. Unlike
 *   the per-user cooldown, a block binds staff too (no bypass). Trigger
 *   blocks are invisible to the blocked user (they get the locked
 *   LLM-failure canned reply), so this table is the only record.
 * - `guild_settings.gork_enabled`: master per-guild switch (1 = on by
 *   default, 0 = gork triggers are ignored entirely while every other
 *   gork setting, including the keyword, is preserved).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS gork_user_blocks (
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  `);

  addColumnIfMissing(
    "guild_settings",
    "gork_enabled",
    "gork_enabled INTEGER NOT NULL DEFAULT 1"
  );
}

module.exports = { id: "022_gork_access", up };
