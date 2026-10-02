/**
 * Bridge expiry sweeper (roadmap/bridge.md §10.10 "Pending expiry").
 *
 * Deletes PENDING bridges past expires_at via the repository's explicit
 * child-then-parent cascade (snapshots, links, outbox, ends, then bridges —
 * FK cascade is documentation only, and an orphan end pins the 1:1 UNIQUE
 * forever). The pending row's code_hash dies with the row: a connect of an
 * expired code reports "expired or unknown" (§10.2), so keeping the hash of a
 * deleted row would buy nothing.
 *
 * Never touches 'active' or 'broken' rows, and never nulls code_hash on an
 * active row — replay of a spent code must keep reporting "already used"
 * (§10.10 Replay). Connect enforces expires_at itself; this sweeper is the
 * garbage collector, not the security check.
 *
 * NOT wired to boot (KD 22): PR 7's startBridgeLoops() passes
 * createSweepJobSpec() to registerJob (src/core/scheduler.js). The 60-second
 * cadence is the spec's; the scheduler owns overlap skipping (overlap: 'skip'
 * is the scheduler default, so a slow sweep cannot stack).
 */

/** Sweeper cadence in ms (spec §10.10: every 60 s). */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * One sweep: find pending rows past expires_at and cascade-delete each.
 * Per-row failures are logged and skipped (AGENTS.md partial-failure rule:
 * one locked row must not abort the sweep). Connect independently rejects
 * expired codes, so a failed delete is a space leak, never a security gap.
 *
 * @param {number} [nowMs=Date.now()] injected clock (tests; scheduler uses default)
 * @returns {{ checked: number, deleted: number, publicIds: string[] }}
 */
function sweepExpiredPendingBridges(nowMs = Date.now()) {
  // Lazy require keeps this module import-safe before the db layer loads.
  const bridges = require("../../db/repositories/bridges");
  const expired = bridges.findExpiredPendingBridges(nowMs);
  const publicIds = [];
  for (const row of expired) {
    let counts = null;
    try {
      counts = bridges.deleteBridgeCascade(row.id);
    } catch (err) {
      console.error(
        `[bridge] expiry sweep: could not delete pending bridge ${row.public_id} (id=${row.id}): ${err?.message || err}`,
      );
      continue;
    }
    if (!counts || !counts.bridges) continue; // vanished under us (disconnect raced) — nothing left to do
    publicIds.push(row.public_id);
  }
  if (publicIds.length > 0) {
    // Spec § Observability: the only expiry log line. Never codes/hashes.
    console.log(`[bridge] expired pending bridges: ${publicIds.length}`);
  }
  return { checked: expired.length, deleted: publicIds.length, publicIds };
}

/**
 * The registerJob spec the activation PR wires into the scheduler.
 * @returns {{ name: string, intervalMs: number, run: () => object }}
 */
function createSweepJobSpec() {
  return {
    name: "bridge-expiry",
    intervalMs: SWEEP_INTERVAL_MS,
    run: () => sweepExpiredPendingBridges(),
  };
}

module.exports = {
  SWEEP_INTERVAL_MS,
  sweepExpiredPendingBridges,
  createSweepJobSpec,
};
