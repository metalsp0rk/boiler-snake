/**
 * One-time deprecation warnings (audit issue #206 / audit-2026-10 §3).
 *
 * The dead legacy shims at `src/*.js` are public API for external scripts
 * (docs/architecture.md § Compat shims), so deleting them needs a major
 * release (the repo is 1.x). Until then every shim logs a specific
 * deprecation line the FIRST time it is required, and stays silent for the
 * rest of the process — warning per-use would spam anyone who kept using
 * them, and warning never would be the silent-drop pattern again.
 *
 * Message format (spot-checked by test/deprecation.test.js):
 *   [deprecation] <name> is deprecated and will be removed in v2 — use <replacement>
 *
 * Removal plan: v2.0 deletes the shim files and this module together.
 */

/** Names already warned about in this process. */
const warned = new Set();

/**
 * Log one `[deprecation]` warning for `name` — once per process, per name.
 * Repeated calls (re-require after a require-cache clear, direct re-calls)
 * are silent so a deprecated API can never spam the log.
 *
 * @param {string} name deprecated entrypoint, e.g. "src/xp.js"
 * @param {string} replacement canonical path/API to switch to
 * @returns {boolean} true when THIS call emitted the warning, false when a
 *   previous call already did (testable seam; callers ignore it)
 */
function warnDeprecated(name, replacement) {
  if (warned.has(name)) return false;
  warned.add(name);
  console.warn(
    `[deprecation] ${name} is deprecated and will be removed in v2 — use ${replacement}`,
  );
  return true;
}

module.exports = { warnDeprecated };
