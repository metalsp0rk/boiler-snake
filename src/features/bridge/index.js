/**
 * Bridge feature (roadmap/bridge.md § Architecture).
 *
 * PR 4 surface: `/bridge` (Discord slash, context API) + the pipeline gates
 * in relay.js. PR 5 adds the media spool, the outbound ports, and the
 * at-least-once relay WORKER.
 *
 * PR 7 is the ACTIVATION PR (KD 22 lifted):
 *  - `start: startBridgeLoops` — the relay worker + expiry sweeper are wired
 *    to production boot (load.js boots `feature.start(supervisor, ctx)`;
 *    startBridgeLoops accepts the supervisor as its first argument and falls
 *    back to supervisor-derived outbound seams).
 *  - `registerEvents(supervisor, ctx)` attaches the bridge DM CONSUMER to
 *    every Fluxer handle (spec §10.10 / KD 24: the DM connect path is
 *    Fluxer-only). The client's opt-in `onDmMessage` hook (spec §10.3 delta 1)
 *    emits NormalizedDmMessage objects — already normalized by the adapter,
 *    no second normalization here — and the consumer hands them to
 *    handlers.handleDmMessage. Handles that finish connecting AFTER feature
 *    registration are wired through the supervisor's `onFluxerReady` hook
 *    (src/platform/boot.js), so mixed deployments never miss an instance.
 *
 * `handlerApi: { bridge: "context" }` opts BOTH the Discord slash and the
 * Fluxer prefix path in: the shipped dispatcher (src/platform/fluxer/dispatch.js)
 * routes `!bridge …` guild lines to the same context handler — the ONE entry
 * point (KD 17: no second listener). PR 7 makes that handler speak: the
 * kill-switch check, the `!bridge` verbs, and the credential-burn connect.
 */

const { commands } = require("./commands");
const { handleBridge, handleDmMessage } = require("./handlers");
const { startBridgeLoops } = require("./relay");

/**
 * Attach the bridge DM consumer to one Fluxer handle. Returns true when the
 * handle exposes the `onDmMessage` hook (test doubles without it are skipped,
 * never fatal).
 */
function attachDmConsumer(handle, supervisor) {
  if (!handle || typeof handle.onDmMessage !== "function") return false;
  handle.onDmMessage(async (dm) => {
    try {
      await handleDmMessage(dm, { supervisor });
    } catch (err) {
      // The DM consumer is detached async work: one failure must never kill
      // the gateway stream (AGENTS.md error rule 1).
      console.error(
        `[bridge] DM command handling failed (channel ${dm?.channelId ?? "?"}):`,
        err?.message || err,
      );
    }
  });
  return true;
}

// supervisor → Set<instanceKey> already wired (WeakMap: dies with the supervisor)
const dmAttached = new WeakMap();

/**
 * Feature boot hook (src/features/load.js): attach the DM consumer to every
 * Fluxer handle the supervisor already holds, and to every handle that
 * finishes connecting AFTER registration (late Fluxer logins in mixed
 * deployments — fired by boot's onFluxerReady). Idempotent per supervisor:
 * repeated registerEvents calls never double-wire a handle.
 * @param {object} supervisor platform supervisor { discord, fluxer, clientForCommunity }
 * @param {object} ctx feature context ({ scheduler, registry, ... }) — unused
 */
function registerEvents(supervisor, ctx) {
  void ctx;
  if (!supervisor?.fluxer) return;
  let attached = dmAttached.get(supervisor);
  if (!attached) {
    attached = new Set();
    dmAttached.set(supervisor, attached);
  }
  for (const [instanceKey, handle] of supervisor.fluxer) {
    if (attached.has(instanceKey)) continue;
    if (attachDmConsumer(handle, supervisor)) attached.add(instanceKey);
  }
  if (typeof supervisor.onFluxerReady === "function") {
    supervisor.onFluxerReady((handle) => {
      try {
        // Same dedup as the loop above: a handle is wired at most once, even
        // when registerEvents ran more than once for this supervisor.
        if (attached.has(handle?.instanceKey)) return;
        if (attachDmConsumer(handle, supervisor)) attached.add(handle.instanceKey);
      } catch (err) {
        console.error(
          `[bridge] late Fluxer DM wiring failed for ${handle?.instanceKey}:`,
          err?.message || err,
        );
      }
    });
  }
}

module.exports = {
  name: "bridge",
  commands,
  handlers: {
    bridge: handleBridge,
  },
  handlerApi: {
    bridge: "context",
  },
  // PR 7: the DM consumer wiring (spec §10.10 — live on Fluxer-only boots too).
  registerEvents,
  // PR 7 (KD 22 lifted): the relay worker IS wired to boot — `start` is the
  // key load.js boots. The named export is kept for direct callers/tests.
  start: startBridgeLoops,
  startBridgeLoops,
};
