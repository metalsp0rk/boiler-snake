/**
 * Gork community memory (roadmap §7.16): per-person memory rows plus the two
 * guild settings columns.
 *
 * - `gork_memories`: one row per (guild, person, UTC day, normalized title).
 *   `id` is the rowid alias and doubles as the `/gork memory` `#id` handle
 *   (guild-scoped; rowid reuse after eviction is acceptable — decision 28).
 *   `title` keeps the model's casing for display; `title_key` is the
 *   normalizeTitle() output used as the collision key half (SQLite BINARY
 *   collation is case-sensitive, so the key needs its own column).
 * - `guild_settings.gork_memory_enabled`: master per-guild switch, default
 *   OFF (0) — memory is fully inert until staff turn it on.
 * - `guild_settings.gork_memory_chars`: memory-block char budget, default
 *   12,000; 0 is VALID and means unlimited (enforced in the settings layer).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS gork_memories (
    id INTEGER PRIMARY KEY,                 -- rowid alias = the /gork memory "#id" handle
    guild_id TEXT NOT NULL,
    subject_user_id TEXT NOT NULL,
    mem_date TEXT NOT NULL,                 -- YYYY-MM-DD UTC, server-stamped
    title TEXT NOT NULL,                    -- display (model casing)
    title_key TEXT NOT NULL,                -- normalizeTitle() output (key half)
    body TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'profile',   -- profile|preference|project|relationship|event
    importance INTEGER NOT NULL DEFAULT 3,  -- 1..5
    source_message_ids TEXT NOT NULL DEFAULT '[]', -- JSON array
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    UNIQUE(guild_id, subject_user_id, mem_date, title_key)
  );
  CREATE INDEX IF NOT EXISTS idx_gork_memories_subject
    ON gork_memories(guild_id, subject_user_id);
  `);

  addColumnIfMissing(
    "guild_settings",
    "gork_memory_enabled",
    "gork_memory_enabled INTEGER NOT NULL DEFAULT 0"
  );
  addColumnIfMissing(
    "guild_settings",
    "gork_memory_chars",
    "gork_memory_chars INTEGER NOT NULL DEFAULT 12000"
  );
}

module.exports = { id: "023_gork_memory", up };
