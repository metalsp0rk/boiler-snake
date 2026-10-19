/**
 * Global time index for the admin_audit retention delete (issue #468, DB-5).
 *
 * deleteAdminAuditOlderThan runs `DELETE FROM admin_audit WHERE created_at < ?
 * LIMIT ?` — GLOBAL (no community prefix). The only index is the composite
 * idx_admin_audit_guild_created (community_id, created_at): with no
 * community_id predicate the composite cannot range-seek, so every hourly
 * prune scans the whole index. activity_log got its standalone
 * idx_activity_created_at in 001; admin_audit (029) never did — the same
 * asymmetry 040/055 closed for other tables.
 *
 * idx_admin_audit_created_at(created_at) turns the prune into a range seek.
 *
 * @param {import("better-sqlite3").Database} db
 */
function up(db) {
  db.exec(`
CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at
  ON admin_audit (created_at);
`);
}

module.exports = { id: "056_admin_audit_created_at_index", up };
