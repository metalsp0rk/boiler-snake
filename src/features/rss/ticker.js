/**
 * RSS notifications ticker (issue #305, subtask 08).
 *
 * Fixed-cadence job on the shared scheduler (youtube/twitch posture):
 * the 5-minute wall-clock-aligned tick reads every feed row once and
 * gates polling PER COMMUNITY on rss_polling_interval_minutes plus
 * per-feed backoff inside pollAllFeeds — the job itself stays dumb,
 * overlap-skipping and never-throw logging belong to the scheduler.
 */

const { registerJob } = require("../../core/scheduler");
const { pollAllFeeds } = require("./poller");

/** Repeating cadence of the scheduler job (the per-community interval
 *  gate decides what is actually due on each tick). */
const RSS_TICK_INTERVAL_MS = 5 * 60_000;

/**
 * Register the rss tick. Idempotent: registerJob replaces a live job of
 * the same name (restart-safe feature boot hooks).
 * @param {object|null} supervisor PR 7 supervisor (clientForCommunity routing)
 */
function startRssTicker(supervisor) {
  registerJob({
    name: "rss",
    intervalMs: RSS_TICK_INTERVAL_MS,
    align: true,
    run: async () => {
      await pollAllFeeds({ supervisor });
    },
  });
}

module.exports = {
  RSS_TICK_INTERVAL_MS,
  startRssTicker,
};
