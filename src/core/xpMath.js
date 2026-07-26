const { MAX_SAFE_XP, MAX_XP_AWARD } = require("./constants");

/**
 * Level from total XP: floor(sqrt(xp / factor)).
 * @param {number} xp
 * @param {number} levelXpFactor
 * @returns {number}
 */
function levelFromXp(xp, levelXpFactor) {
  const factor = Math.max(1, Number(levelXpFactor) || 100);
  return Math.floor(Math.sqrt(Math.max(0, xp) / factor));
}

/**
 * Clamp any value to a safe finite integer delta (can be negative).
 * - Non-finite -> 0
 * - Too large magnitude -> +/- MAX_SAFE_XP
 * - Coerces to integer
 * @param {unknown} n
 * @returns {number}
 */
function clampDelta(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x === 0) return 0;
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  const clampedAbs = Math.min(Math.floor(abs), MAX_SAFE_XP);
  return sign * clampedAbs;
}

/**
 * Clamp an XP total to a safe finite integer in [0, MAX_SAFE_XP].
 * - Non-finite -> MAX_SAFE_XP
 * - Coerces to integer
 * @param {unknown} n
 * @returns {number}
 */
function clampXpTotal(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return MAX_SAFE_XP;
  if (x <= 0) return 0;
  return Math.min(Math.floor(x), MAX_SAFE_XP);
}

/**
 * Validate an admin-supplied XP config value (null/undefined = unset).
 * @param {unknown} value
 * @param {string} label
 * @returns {string|null} error message or null if ok
 */
function validateXpValue(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) {
    return `${label} XP must be a finite non-negative number.`;
  }
  if (value > MAX_XP_AWARD) {
    return `XP value too large. Maximum value per ${label.toLowerCase()} is ${MAX_XP_AWARD.toLocaleString()}.`;
  }
  return null;
}

module.exports = {
  levelFromXp,
  clampDelta,
  clampXpTotal,
  validateXpValue,
  MAX_SAFE_XP,
  MAX_XP_AWARD,
};
