/**
 * Gork (AI keyword Q&A): guild_settings columns.
 *
 * gork_keyword is nullable on purpose: clearing the keyword must store NULL
 * ("NULL = disabled", spec 7.8) — a NOT NULL column would reject that write.
 * The DEFAULT still seeds '@gork' for existing rows (at migration time) and
 * for every new guild row.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "guild_settings",
    "gork_keyword",
    "gork_keyword TEXT DEFAULT '@gork'"
  );
  addColumnIfMissing(
    "guild_settings",
    "gork_context_window",
    "gork_context_window INTEGER NOT NULL DEFAULT 10"
  );
  addColumnIfMissing(
    "guild_settings",
    "gork_extra_rules",
    "gork_extra_rules TEXT NOT NULL DEFAULT ''"
  );
  addColumnIfMissing(
    "guild_settings",
    "gork_search_enabled",
    "gork_search_enabled INTEGER NOT NULL DEFAULT 1"
  );
  addColumnIfMissing(
    "guild_settings",
    "gork_cooldown_sec",
    "gork_cooldown_sec INTEGER NOT NULL DEFAULT 180"
  );
}

module.exports = { id: "021_gork", up };
