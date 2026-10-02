/**
 * Bridge feature (roadmap/bridge.md § Architecture).
 *
 * PR 4 surface: `/bridge` (Discord slash, context API) + the pipeline gates
 * in relay.js. NO registerEvents/start hooks: the relay worker, the sweeper,
 * the Fluxer DM hook, and `BRIDGE_ENABLED` arrive with the activation PR
 * (KD 22 — nothing sends before it). The feature is inert until staff create
 * a bridge, and even then the service refuses activation (relay not wired).
 *
 * `handlerApi: { bridge: "context" }` also opts the Fluxer prefix path in:
 * the shipped dispatcher (src/platform/fluxer/dispatch.js) routes
 * `!bridge …` guild lines to the same context handler, which replies the
 * "not available on Fluxer yet" line until PR 7 (spec PR plan, PR 4 row).
 */

const { commands } = require("./commands");
const { handleBridge } = require("./handlers");

module.exports = {
  name: "bridge",
  commands,
  handlers: {
    bridge: handleBridge,
  },
  handlerApi: {
    bridge: "context",
  },
};
