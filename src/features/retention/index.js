/**
 * Retention feature module (audit-2026-10 §2/§6 P1, issue #192).
 *
 * Housekeeping-only feature: no commands, no gateway listeners — just the
 * periodic retention sweep registered on the shared core scheduler, exactly
 * the linking code-sweeper shape (`armSweeper` idempotency guard, a
 * never-throwing run body, a failed arm logged and retried on the next
 * start()). Sweeps themselves: src/features/retention/sweeps.js; knobs:
 * config.js.
 *
 * Cadence: HOURLY with an immediate boot sweep (the web-session prune runs
 * boot + periodic for the same reason — a restart should do real pruning,
 * and an idle sweep is one cheap indexed statement per table). The batch
 * cap bounds a huge backlog; hourly cadence drains
 * ≈480k rows/day/table (batchRows 500 × maxBatchesPerTable 40 = 20k per sweep
 * × 24 — #468 DB-8: the old text said 80k, off by 6×),
 * far above any real steady-state rate.
 *
 * Dark-safe by construction: every table's sweep can be disabled by its own
 * env knob; with all knobs off this feature touches nothing.
 */

const { registerJob } = require("../../core/scheduler");
const { runRetentionSweeps } = require("./sweeps");

/** Sweep cadence (rows here age in DAYS; an hour is generous). */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Job name on the shared core scheduler (web job-health bridge lists it). */
const SWEEP_JOB = "retentionSweeps";

let sweeperArmed = false;

/**
 * Arm the retention sweeper once per process.
 * @returns {boolean} true when this call armed the job
 */
function armSweeper() {
  if (sweeperArmed) return false;
  sweeperArmed = true;
  try {
    registerJob({
      name: SWEEP_JOB,
      intervalMs: SWEEP_INTERVAL_MS,
      runImmediately: true,
      // runRetentionSweeps never throws (per-table try/catch inside,
      // AGENTS.md rule 1) — one bad sweep can never kill the scheduler tick.
      run: () => runRetentionSweeps(),
    });
    return true;
  } catch (err) {
    sweeperArmed = false; // allow a later start() to retry
    console.error("[retention] sweeper job registration failed:", err?.message || err);
    return false;
  }
}

/**
 * Feature boot hook (src/features/load.js): arm the sweep job. Idempotent —
 * repeated start() calls never double-register.
 *
 * @param {object|null} supervisor platform supervisor (unused — DB-only job)
 * @param {object} [ctx] feature context (unused)
 */
function start(supervisor, ctx) {
  void supervisor;
  void ctx;
  armSweeper();
}

/**
 * Feature event hook: retention has no gateway listeners; no-op kept so
 * load.js's hook walk is a pure pass-through (same as linking at T2).
 *
 * @param {object|null} supervisor
 * @param {object} [ctx]
 */
function registerEvents(supervisor, ctx) {
  void supervisor;
  void ctx;
}

module.exports = {
  name: "retention",

  // --- boot hooks ---
  registerEvents,
  start,

  // --- module surface (tests / docs / ops tooling) ---
  runRetentionSweeps,
  retentionConfig: require("./config").retentionConfig,

  // exposed for tests / docs
  SWEEP_JOB,
  SWEEP_INTERVAL_MS,
  armSweeper,
};
