/**
 * Environment-knob readers (#470 H1-7: three byte-identical copies inside
 * gork — the audit's "a core/env helper seam exists nowhere"). #837 (B2-2)
 * finished the job: gork's `envNonNegInt` copy and the injectable-env
 * `positiveIntIn` reader are homed here too — one set of parse rules for
 * "knob → number", with the env source injectable for tests (the gork
 * deadline math is only testable that way).
 */

/**
 * Parse one knob to a Number, with ONE rule for the unset shapes:
 * undefined/null/blank-string is NEVER a number — it is UNSET.
 * (Number("") and Number("  ") are 0, which once made `FOO=` a legitimate
 * zero for non-negative knobs — an unset knob silently disabling vision.
 * #837: blank reads NaN here, so every helper falls back identically.)
 *
 * @param {Record<string, string|undefined>|null|undefined} env
 * @param {string} name
 * @returns {number} parsed number or NaN (never throws)
 */
function knobNumber(env, name) {
  const raw = env == null ? undefined : env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Positive-integer env knob: garbage, zero, negatives and NaN all fall back
 * (never silently 0, never a float tick).
 *
 * @param {string} name
 * @param {number} fallback
 * @param {Record<string,string|undefined>} [env] injectable source (tests)
 * @returns {number}
 */
function envPositiveInt(name, fallback, env = process.env) {
  const n = knobNumber(env, name);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Non-negative-integer env knob: 0 is a valid, MEANINGFUL value (e.g.
 * `GORK_VISION_MAX_IMAGES=0` turns vision off) — but blank/unset is still
 * UNSET and falls back (#837: the gork copy read `FOO=` as 0, silently
 * disabling the feature it was asked to leave at its default).
 *
 * @param {string} name
 * @param {number} fallback
 * @param {Record<string,string|undefined>} [env] injectable source (tests)
 * @returns {number}
 */
function envNonNegInt(name, fallback, env = process.env) {
  const n = knobNumber(env, name);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

module.exports = { envPositiveInt, envNonNegInt, knobNumber };
