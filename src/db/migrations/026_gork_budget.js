/**
 * Gork daily usage budget (roadmap §7.17, decisions 30–37): the guild-default
 * limit column plus the per-scope rule table and the DB-backed usage counters.
 *
 * - `guild_settings.gork_daily_limit`: guild-default tri-state limit
 *   (-1 blocked | 0 unlimited (default — opt-in feature) | 1..1000 per
 *   user per UTC day). Clamped in the settings layer on write.
 * - `gork_budget_rules`: channel/category overrides; the most specific scope
 *   wins (channel → category → guild default, decision 30). Ids are TEXT per
 *   the shipped repo convention (see gork_user_blocks/gork_memories), not
 *   INTEGER as the planning-time sketch wrote.
 * - `gork_usage`: per-(user, winning-scope) success counters keyed by the
 *   UTC calendar day (decision 36). DB-backed on purpose: a restart must not
 *   refund budgets (decision 37); old days are pruned lazily on the write
 *   path (no ticker).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS gork_budget_rules (
    guild_id    TEXT NOT NULL,
    scope_kind  TEXT NOT NULL,                -- 'channel' | 'category'
    target_id   TEXT NOT NULL,
    daily_limit INTEGER NOT NULL,             -- -1 blocked | 0 unlimited | 1..1000
    created_by  TEXT,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (guild_id, scope_kind, target_id)
  );

  CREATE TABLE IF NOT EXISTS gork_usage (
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    scope_kind TEXT NOT NULL,                 -- 'channel' | 'category' | 'guild'
    scope_id   TEXT NOT NULL,                 -- channel/category id; '0' = guild default
    day        TEXT NOT NULL,                 -- UTC date 'YYYY-MM-DD'
    count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id, scope_kind, scope_id, day)
  );
  `);

  addColumnIfMissing(
    "guild_settings",
    "gork_daily_limit",
    "gork_daily_limit INTEGER NOT NULL DEFAULT 0"
  );
}

module.exports = { id: "026_gork_budget", up };
