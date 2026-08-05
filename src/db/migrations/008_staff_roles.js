/**
 * Rename honeypot_exempt_roles → staff_roles.
 *
 * Generalizes the exempt-role store into a single guild-wide staff role list
 * that powers the admin gate (isStaff / requireStaff), honeypot exemption,
 * and future features (tickets, warnings).
 *
 * Idempotent: only runs if the old table exists and the new one does not.
 */
function up(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);

  // Already migrated — nothing to do
  if (tables.includes("staff_roles") && !tables.includes("honeypot_exempt_roles")) {
    return;
  }

  // Old table gone but new one exists — already done by a previous run or manual migration
  if (!tables.includes("honeypot_exempt_roles")) {
    return;
  }

  // Rename the table in-place (SQLite supports RENAME TABLE)
  db.exec(`ALTER TABLE honeypot_exempt_roles RENAME TO staff_roles`);
}

module.exports = { id: "008_staff_roles", up };
