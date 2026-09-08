/**
 * Admin audit trail (roadmap/web-admin.md §8.5): one row per mutating action
 * across every transport — web console ('web'), slash handlers ('slash'),
 * and background/system jobs ('system'). The CHECK on `origin` mirrors the
 * repository-level validation (src/db/repositories/adminAudit.js) so origin
 * labels stay consistent even against direct SQL writes.
 *
 * actor_user_id is nullable for 'system' rows (no Discord user behind the
 * action); target_type/target_id/details_json are optional context columns.
 * idx(guild_id, created_at) backs the guild-scoped audit viewer pages
 * (§8.6) which are LIMIT-capped per the query-budget rule.
 * @param {import("better-sqlite3").Database} db
 */
function up(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  actor_user_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('web', 'slash', 'system')),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_guild_created
  ON admin_audit(guild_id, created_at);
`);
}

module.exports = { id: "024_admin_audit", up };
