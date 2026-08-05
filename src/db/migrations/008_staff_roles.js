/**
 * Rename honeypot_exempt_roles → staff_roles.
 *
 * Generalizes the exempt-role store into a single guild-wide staff role list
 * that powers the admin gate (isStaff / requireStaff), honeypot exemption,
 * and future features (tickets, warnings).
 *
 * Idempotent across re-runs:
 * - Fresh DBs: 001 already creates `staff_roles`; nothing to do.
 * - Legacy DBs: rename (or merge if both tables briefly coexist).
 * - After a prior rename, 001 used to re-create an empty `honeypot_exempt_roles`
 *   (IF NOT EXISTS); that empty table is dropped here so re-running migrations
 *   does not try `RENAME TO staff_roles` when `staff_roles` already exists.
 */
function up(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);

  const hasStaff = tables.includes("staff_roles");
  const hasLegacy = tables.includes("honeypot_exempt_roles");

  // Ensure target table exists (covers any path that skipped 001 updates).
  if (!hasStaff) {
    db.exec(`
CREATE TABLE IF NOT EXISTS staff_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);
`);
  }

  if (!hasLegacy) {
    return;
  }

  // Legacy table present: fold rows into staff_roles, then drop legacy.
  // Handles pure rename (staff was empty / just created) and both-exist races
  // after older 001 recreated honeypot_exempt_roles on every boot.
  db.exec(`
INSERT OR IGNORE INTO staff_roles (guild_id, role_id, created_at)
  SELECT guild_id, role_id, created_at FROM honeypot_exempt_roles;
DROP TABLE honeypot_exempt_roles;
`);
}

module.exports = { id: "008_staff_roles", up };
