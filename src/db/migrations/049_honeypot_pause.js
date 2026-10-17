/**
 * Honeypot mass-ban safety valve state (#440, audit F2-4).
 *
 * `guild_settings.honeypot_paused_at` / `honeypot_pause_reason`:
 * the breaker counts honeypot BAN attempts in a rolling window; over the
 * cap it PERSISTS the pause here so a process restart can NEVER silently
 * re-arm enforcement on the one irreversible feature. Enforcement (both
 * platform arms) refuses to ban while `honeypot_paused_at` is set; only an
 * administrator's `/honeypot resume` clears it. NULL = enforcement active.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing("guild_settings", "honeypot_paused_at", "honeypot_paused_at INTEGER");
  addColumnIfMissing(
    "guild_settings",
    "honeypot_pause_reason",
    "honeypot_pause_reason TEXT",
  );
}

module.exports = { id: "049_honeypot_pause", up };
