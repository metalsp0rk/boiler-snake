/**
 * Dedicated staff channel for warning issue/void embeds.
 * When unset, issue/void still fall back to audit_log_channel_id.
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "guild_settings",
    "warn_log_channel_id",
    "warn_log_channel_id TEXT"
  );
}

module.exports = { id: "012_warn_log_channel", up };
