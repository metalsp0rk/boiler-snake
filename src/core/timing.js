/**
 * Timing primitives (#470 H1-7).
 */

/**
 * Resolve after `ms`. Identical private copies in commandPermissions/sync
 * and userActivity/backfill.
 *
 * #837 (B2-3): `unref` option — a wait that must NOT keep the process
 * alive on its own (SIGTERM-drain posture: the bridge relay's backoff
 * sleep lets Node exit while the timer waits, so shutdown is never held
 * hostage by a retry delay). The bridge's local unref'd copy existed
 * only because this helper could not express it; it is retired.
 *
 * @param {number} ms
 * @param {{unref?: boolean}} [opts] unref: true = never block process exit
 * @returns {Promise<void>}
 */
function sleep(ms, { unref = false } = {}) {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    if (unref && typeof t.unref === "function") t.unref();
  });
}

module.exports = { sleep };
