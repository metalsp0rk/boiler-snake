/**
 * staff_roles: added_by provenance column.
 *
 * Roadmap: staff-roles.md §4.1 "Optional columns later" — `added_by TEXT` was
 * deliberately deferred from the MVP; this adds it. Nullable TEXT (actor
 * user id) so pre-existing rows stay NULL ("unknown provenance") instead of
 * being back-filled with a guess. Future re-adds via `/staff role add`
 * refresh it (see the upsert in repositories/staffRoles.js).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing("staff_roles", "added_by", "added_by TEXT");
}

module.exports = { id: "024_staff_roles_added_by", up };
