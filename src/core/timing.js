/**
 * Timing primitives (#470 H1-7).
 */

/**
 * Resolve after `ms`. Identical private copies in commandPermissions/sync
 * and userActivity/backfill.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { sleep };
