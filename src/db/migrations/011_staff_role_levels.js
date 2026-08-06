/**
 * Staff roles: junior | senior level.
 *
 * - junior: staff gate (requireStaff) + honeypot exempt; no automatic ticket channel view
 * - senior: same as junior + ticket channel overwrites
 *
 * Existing rows default to senior (preserve previous ticket visibility).
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "staff_roles",
    "level",
    "level TEXT NOT NULL DEFAULT 'senior'"
  );

  // Normalize any unexpected values
  db.prepare(
    `
    UPDATE staff_roles
    SET level='senior'
    WHERE level IS NULL OR level NOT IN ('junior', 'senior')
  `
  ).run();
}

module.exports = { id: "011_staff_role_levels", up };
