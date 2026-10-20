/**
 * guild_settings.gork_role_id — role-mention invocation for gork (issue #174).
 *
 * Guilds that give the bot a real role (e.g. a "gork" role) can configure it
 * here so mentioning that role anywhere in a message triggers gork,
 * alongside the text keyword. NULL = role path not configured — the ONLY
 * pre-migration state, so existing guilds keep keyword-only behavior with a
 * byte-identical trigger.
 *
 * Nullable on purpose (same reasoning as 021's gork_keyword): clearing the
 * role must store NULL, and the stored value is a plain role-id string —
 * no FK (Discord role ids are external, and the trigger degrades gracefully
 * when the role is deleted).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing("guild_settings", "gork_role_id", "gork_role_id TEXT");
}

module.exports = { id: "058_gork_role_id", up };
