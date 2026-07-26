/**
 * late-added columns on youtube_channels and honeypot_channels.
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "youtube_channels",
    "last_checked",
    "last_checked INTEGER"
  );
  addColumnIfMissing(
    "honeypot_channels",
    "warning_message_id",
    "warning_message_id TEXT"
  );
}

module.exports = { id: "004_youtube_and_honeypot_columns", up };
