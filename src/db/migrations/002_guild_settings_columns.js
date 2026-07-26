/**
 * Additive guild_settings columns introduced after initial schema.
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "guild_settings",
    "reaction_xp",
    "reaction_xp INTEGER NOT NULL DEFAULT 2"
  );
  addColumnIfMissing(
    "guild_settings",
    "reaction_cooldown_sec",
    "reaction_cooldown_sec INTEGER NOT NULL DEFAULT 10"
  );
  addColumnIfMissing(
    "guild_settings",
    "youtube_upload_role_id",
    "youtube_upload_role_id TEXT"
  );
  addColumnIfMissing(
    "guild_settings",
    "audit_log_channel_id",
    "audit_log_channel_id TEXT"
  );
  addColumnIfMissing(
    "guild_settings",
    "message_log_channel_id",
    "message_log_channel_id TEXT"
  );
}

module.exports = { id: "002_guild_settings_columns", up };
