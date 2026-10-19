/**
 * Environment-knob readers (#470 H1-7: three byte-identical copies inside
 * gork — the audit's "a core/env helper seam exists nowhere").
 */

/**
 * Positive-integer env knob: garbage, zero, negatives and NaN all fall back
 * (never silently 0, never a float tick).
 *
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function envPositiveInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

module.exports = { envPositiveInt };
