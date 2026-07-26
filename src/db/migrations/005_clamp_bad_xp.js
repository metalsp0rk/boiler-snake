const { MAX_SAFE_XP } = require("../../core/xpMath");

/**
 * One-shot style cleanup: clamp non-finite / out-of-range XP rows.
 * Safe to re-run (no-op when data is clean).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ now: Function }} helpers
 */
function up(db, { now }) {
  // Handles REAL inf/nan, TEXT 'Infinity'/'NaN', values > MAX_SAFE_XP, values < 0.
  // SQLite compares INF > any finite number, so xp > MAX_SAFE_XP catches REAL Infinity.
  db.prepare(`
  UPDATE users
  SET xp = ?, updated_at = ?
  WHERE xp > ?
  OR xp < 0
  OR xp = 'Infinity'
  OR xp = 'inf'
  OR xp = 'INF'
  OR xp = 'NaN'
  OR xp = 'nan'
  `).run(MAX_SAFE_XP, now(), MAX_SAFE_XP);
}

module.exports = { id: "005_clamp_bad_xp", up };
