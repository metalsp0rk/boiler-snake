/**
 * Bridge feature (roadmap/bridge.md § Architecture).
 *
 * PR 4 surface: `/bridge` (Discord slash, context API) + the pipeline gates
 * in relay.js. PR 5 adds the media spool, the outbound ports, and the
 * at-least-once relay WORKER: `startBridgeLoops` is exported with the
 * start(supervisor, ctx) shape, and — deliberately — NOT under the `start`
 * key. load.js boots `feature.start(supervisor, ctx)` when present, so
 * naming it `start` here would wire the worker into production boot, which
 * KD 22 forbids until the activation PR (PR 7). The worker code is fully
 * present and unit-tested; nothing in this build calls it.
 *
 * `handlerApi: { bridge: "context" }` also opts the Fluxer prefix path in:
 * the shipped dispatcher (src/platform/fluxer/dispatch.js) routes
 * `!bridge …` guild lines to the same context handler, which replies the
 * "not available on Fluxer yet" line until PR 7 (spec PR plan, PR 4 row).
 */

const { commands } = require("./commands");
const { handleBridge } = require("./handlers");
const { startBridgeLoops } = require("./relay");

module.exports = {
  name: "bridge",
  commands,
  handlers: {
    bridge: handleBridge,
  },
  handlerApi: {
    bridge: "context",
  },
  // PR 7 wires this as the feature `start` hook (KD 22: not in this build).
  startBridgeLoops,
};
