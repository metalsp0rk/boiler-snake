/**
 * Bridge relay backlog → ticker-health source (#217).
 *
 * The relay WORKER already has a scheduler row (bridge-relay liveness via
 * schedulerJobHealth.js), but the scheduler knows nothing about WHAT is
 * behind that heartbeat: per-bridge queue depth and poison-parked copies
 * live only in bridge_outbox. Before this module an operator could see the
 * worker ticking green while copies silently parked — the exact silent-
 * failure class C1 #182 pairs with. This source closes the gap:
 *
 *   queued == 0, parked == 0 → ok    "all relay queues clear"
 *   queued > 0,  parked == 0 → ok    "... queued · worst bridge…" (the
 *                                    worker is alive; depth alone is not
 *                                    staleness — backoff ladders are
 *                                    designed waiting)
 *   parked > 0               → STALE terminal parked copies need the
 *                              staff verdict (/bridge retry) — a green
 *                              heartbeat must never hide them.
 *
 * HONESTY: status derives from DB facts only (no fabricated timestamps —
 * the outbox schema has none, and liveness is the scheduler row's job).
 * The getter may throw; the registry degrades it to unknown/"source
 * failed" exactly like every other source (tickerHealth.js contract).
 *
 * Registered from web/server.js behind the PUBLIC_HTTP_PORT gate, next to
 * the scheduler bridge — dark-by-default holds.
 */

const { registerTickerHealthSource } = require("./tickerHealth");

/** Registry row name (stable; tests + docs cite it). */
const RELAY_BACKLOG_SOURCE = "bridge-relay-backlog";

/** Per-bridge tokens in the detail string before "+N more" overflow. */
const MAX_BRIDGES_IN_DETAIL = 3;

/** Registry caps details at 120 — build inside the cap, never trunc-emit. */
const MAX_DETAIL_LEN = 118;

function pluralCopies(n) {
  return n === 1 ? "copy" : "copies";
}

/**
 * Pure classification of a relayHealthSummary() shape — exported for tests.
 * When the relay worker is NOT running (dark bridge / bridge feature not
 * started) the getter passes `workerRunning:false` and we return null so the
 * registry reads unknown/"not wired" — mirroring schedulerJobHealth, which
 * only surfaces a bridge-relay row once the job exists. We never fabricate a
 * green relay subsystem for a worker that was never started.
 *
 * @param {{ bridges: Array<{publicId: string, queued: number, parked: number}>,
 *           totals: { queued: number, parked: number } }} summary
 * @param {{ workerRunning?: boolean }} [opts]
 * @returns {{ status: string, detail: string } | null}
 */
function bridgeRelayBacklogResult(summary, { workerRunning = true } = {}) {
  if (!workerRunning) return null; // unknown / not wired (honesty rule)

  const bridges = Array.isArray(summary?.bridges) ? summary.bridges : [];
  const totals = summary?.totals ?? {
    queued: bridges.reduce((n, b) => n + (Number(b.queued) || 0), 0),
    parked: bridges.reduce((n, b) => n + (Number(b.parked) || 0), 0),
  };

  if (totals.parked === 0 && totals.queued === 0) {
    return { status: "ok", detail: "all relay queues clear" };
  }

  // Worst-first breakdown tokens (the summary query already ordered them);
  // only bridges WITH backlog appear.
  const listed = bridges
    .filter((b) => Number(b.queued) > 0 || Number(b.parked) > 0)
    .slice(0, MAX_BRIDGES_IN_DETAIL);
  const overflow = bridges.length - listed.length;
  const tokens = listed.map(
    (b) => `${b.publicId} q${Number(b.queued) || 0} p${Number(b.parked) || 0}`,
  );
  const breakdown =
    tokens.join(" · ") + (overflow > 0 ? ` +${overflow} more` : "");

  if (totals.parked > 0) {
    return {
      status: "stale",
      detail: clip(
        `${totals.parked} parked ${pluralCopies(totals.parked)} — /bridge retry · ` +
          `q${totals.queued} p${totals.parked} | ${breakdown}`,
      ),
    };
  }
  return {
    status: "ok",
    detail: clip(`${totals.queued} queued | ${breakdown}`),
  };
}

function clip(text) {
  return text.length > MAX_DETAIL_LEN
    ? `${text.slice(0, MAX_DETAIL_LEN - 1)}…`
    : text;
}

/**
 * Register the backlog row. Idempotent (the registry keys by name); the
 * getter re-reads the DB + the LIVE scheduler job at snapshot time, so no
 * re-registration is needed for queue churn or worker (re)start.
 *
 * @param {{ relayHealthSummary: () => object }} [repo] bridges repository seam
 * @param {{ isWorkerRunning?: () => boolean }} [worker] liveness seam;
 *   default reads the shared scheduler's bridge-relay job (same core kernel
 *   schedulerJobHealth.js consumes — web never fabricates a green relay row
 *   for a worker that was never started).
 * @param {(name: string, getter: Function) => Function} [register]
 * @returns {() => void} unregister helper
 */
function registerBridgeRelayHealthSource(
  repo = require("../../db/repositories/bridges"),
  worker = defaultWorkerSeam(),
  register = registerTickerHealthSource
) {
  return register(RELAY_BACKLOG_SOURCE, () =>
    bridgeRelayBacklogResult(repo.relayHealthSummary(), {
      workerRunning: worker.isWorkerRunning(),
    })
  );
}

/** Default liveness seam: the shared scheduler's bridge-relay job object. */
function defaultWorkerSeam() {
  return {
    isWorkerRunning() {
      const scheduler = require("../../core/scheduler");
      return Boolean(scheduler.getJob?.("bridge-relay"));
    },
  };
}

module.exports = {
  RELAY_BACKLOG_SOURCE,
  MAX_BRIDGES_IN_DETAIL,
  bridgeRelayBacklogResult,
  registerBridgeRelayHealthSource,
};
