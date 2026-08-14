/**
 * Persistent flag for event reminder configs.
 * When persistent, auto-cleanup is skipped so the config survives recurring event occurrences.
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "event_reminder_configs",
    "persistent",
    "persistent INTEGER NOT NULL DEFAULT 0"
  );
}

module.exports = { id: "017_event_reminder_persistent", up };
