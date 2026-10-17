/**
 * Per-guild gork Q&A log channel (audit-log de-cluttering).
 *
 * `guild_settings.gork_log_channel_id`: dedicated channel for the "Gork Q&A"
 * embeds (completed exchanges + failure one-liners). NULL (default) keeps
 * them in the general audit log channel — the gork stream falls back to
 * `audit_log_channel_id`, mirroring the warn stream.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "guild_settings",
    "gork_log_channel_id",
    "gork_log_channel_id TEXT",
  );
}

module.exports = { id: "048_gork_log_channel", up };
