/**
 * Bridge kill switch + paused-notice latch (roadmap/bridge.md §10.2 "BRIDGE_ENABLED=0"
 * + "Rollout Plan" + "Observability", PR 7 activation).
 *
 * BRIDGE_ENABLED semantics are pinned by the spec and MUST NOT drift:
 *  - Read at CALL time — never cached. The three read points are the Rollout
 *    row: command time (handlers), at enqueue (relay enqueue functions), and at
 *    the top of each worker iteration (relay tick). No restart is needed to
 *    pause or resume; a flip takes effect on the next read.
 *  - Unset / empty → ON. `0`, `false`, `off` (case-insensitive, trimmed) → OFF.
 *    Anything else → ON (the switch only ever turns the relay OFF through its
 *    documented off-values).
 *  - NOT per-community: one flag governs the whole process (Rollout: "It is
 *    not per-community").
 *
 * The paused NOTICE (spec §10.10: kind `paused`, "one latched notice per
 * direction per incident") is built here so the sentence lives in exactly one
 * file, and the latch (createPauseLatch) gives the relay worker its per-incident
 * memory: a long disable window notifies each (bridge, direction) ONCE; when
 * the switch flips back on the incident ends, so a later disable notifies
 * again. `endIncident` is what makes "per incident" true — re-enabling resets.
 *
 * This module imports NOTHING: the switch has to answer on every surface,
 * including a Fluxer-only process where no Discord module ever loads, and it
 * must never drag discord.js into the bridge module graph (AGENTS.md / §10.13).
 */

/** Values that mean OFF (spec: `BRIDGE_ENABLED=0` rejects commands, stops
 *  enqueue, stops sending). Compared against the trimmed lowercased value. */
const OFF_VALUES = Object.freeze(new Set(["0", "false", "off"]));

/**
 * True when the bridge relay is allowed to act. Reads the environment on EVERY
 * call (the spec forbids caching the flag).
 *
 * @param {NodeJS.ProcessEnv} [env] env source (tests inject; default process.env)
 * @returns {boolean}
 */
function isBridgeEnabled(env = process.env) {
  const raw = env ? env.BRIDGE_ENABLED : undefined;
  if (raw == null) return true; // unset = ON (Rollout: "Unset = on")
  const value = String(raw).trim().toLowerCase();
  if (value === "") return true; // empty = unset
  return !OFF_VALUES.has(value);
}

/**
 * The verbatim §10.10 paused notice for one bridge. `publicId` is the handle —
 * the only bridge identifier allowed in a public channel message (§10.2
 * "Replies"); codes, tokens, and bodies never appear here.
 *
 * @param {string} publicId bridge handle (b_…)
 * @returns {string}
 */
function buildPausedNotice(publicId) {
  return (
    `Bridge ${publicId} is paused on this process (BRIDGE_ENABLED=0). ` +
    "Messages posted while it is paused are not copied."
  );
}

/**
 * Per-incident pause latch (spec "Observability": queue-full / spool-full /
 * paused notices are "latched once per direction per incident").
 *
 * One latch instance lives per worker (created in createRelayWorker). The
 * worker calls beginIncident() at the top of a tick that finds the relay
 * disabled, endIncident() on the first tick that finds it enabled again, and
 * shouldNote(bridgeId, direction) before sending a paused notice. The FIRST
 * shouldNote for a (bridge, direction) inside an incident returns true — once.
 * After endIncident + a new beginIncident, the same pair notifies again.
 *
 * @returns {{
 *   beginIncident: () => void,
 *   endIncident: () => void,
 *   shouldNote: (bridgeId: string|number, direction: string) => boolean,
 * }}
 */
function createPauseLatch() {
  let active = false;
  let incident = 0;
  /** @type {Map<string, number>} "bridgeId|direction" → incident that notified it */
  const noted = new Map();
  return {
    beginIncident() {
      if (!active) {
        active = true;
        incident += 1;
      }
    },
    endIncident() {
      active = false;
    },
    shouldNote(bridgeId, direction) {
      if (!active) return false;
      const key = `${String(bridgeId)}|${String(direction)}`;
      if (noted.get(key) === incident) return false;
      noted.set(key, incident); // the claim is the latch: one notice per incident
      return true;
    },
  };
}

module.exports = {
  isBridgeEnabled,
  buildPausedNotice,
  createPauseLatch,
};
