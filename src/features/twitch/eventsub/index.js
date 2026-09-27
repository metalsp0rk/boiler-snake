/**
 * EventSub fast-path module entry.
 *
 * startEventsub() registers the hourly subscription reconciler (only when
 * configured) and fires one immediate sweep. It is INDEPENDENT of the
 * polling ticker: when disabled, nothing is registered and polling remains
 * the whole feature. The webhook callback route lives on the public web
 * server (src/web/routes/twitchEventsub.js) and calls into ./callback.
 */

const { registerJob } = require("../../../core/scheduler");
const { getEventsubConfig } = require("./config");
const { reconcileEventsubSubscriptions } = require("./subscriptions");

const RECONCILE_INTERVAL_MS = 60 * 60_000;

/**
 * Register the reconciler job if EventSub is configured. Safe to call from
 * the feature's start(); no-op (with a one-line log) when not configured.
 * @param {object} [deps]
 * @returns {boolean} whether the reconciler was registered
 */
function startEventsub(deps = {}) {
  const cfg = getEventsubConfig();
  if (!cfg.enabled) {
    console.log(
      `[twitch] EventSub fast path disabled (missing: ${cfg.missing.join(", ") || "none"}); polling only`,
    );
    return false;
  }
  registerJob({
    name: "twitch-eventsub",
    intervalMs: RECONCILE_INTERVAL_MS,
    run: () => reconcileEventsubSubscriptions(deps),
    runImmediately: true,
    align: false,
  });
  console.log(
    `[twitch] EventSub fast path enabled (callback ${cfg.callbackUrl}, cap ${cfg.maxChannels} channels)`,
  );
  return true;
}

module.exports = {
  RECONCILE_INTERVAL_MS,
  getEventsubConfig,
  startEventsub,
};
