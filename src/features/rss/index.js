/**
 * RSS feed notifications feature (issue #305).
 *
 * Thin module on the load.js contract: command/handler/autocomplete
 * surface comes from ./commands (built there in subtask 07), the boot
 * hook only registers the scheduler tick. Commands: /rss (manage
 * subscriptions) + /setrss (channel/role/interval). Both staff-tier
 * (src/core/commandVisibility.js) and ManageGuild default_member_permissions.
 */

const { commands, handlers, handlerApi, autocomplete } = require("./commands");
const { startRssTicker } = require("./ticker");

/**
 * Boot hook (guarded per-feature by load.js): register the aligned
 * 5-minute scheduler job; per-community interval gating lives in the
 * poller. Idempotent across restarts.
 * @param {object|null} supervisor
 * @param {object} [featureCtx]
 */
function start(supervisor, featureCtx) {
  void featureCtx;
  startRssTicker(supervisor);
}

module.exports = {
  name: "rss",
  commands,
  handlers,
  handlerApi,
  autocomplete,
  start,
};
