/**
 * STE answer style toggle (roadmap §7.20, decision 50).
 *
 * `guild_settings.gork_ste_enabled`: per-guild switch for the STE
 * anti-slop answer-style card (default 0 = off). Off means the system
 * prompt is exactly the pre-7.20 prompt; on appends the byte-locked
 * GORK_STE_CARD between the base prompt and staff rules.
 *
 * Additive column only — `001_base_schema` stays frozen; fresh DBs get
 * the column when this migration runs (gork-settings convention per
 * 021/022/023/026/033).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "guild_settings",
    "gork_ste_enabled",
    "gork_ste_enabled INTEGER NOT NULL DEFAULT 0",
  );
}

module.exports = { id: "031_gork_ste_enabled", up };
