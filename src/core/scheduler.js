/**
 * Named job scheduler for feature tickers.
 *
 * Features register from start(); this module owns timers, overlap
 * skipping, and error logging. Cadence (interval vs cron, alignment to
 * wall-clock boundaries, immediate/delayed first fire) is per job so
 * existing voice/youtube/twitch/github/reminder/decay behavior is preserved.
 *
 * Snapshot rows are the getter shape tickerHealth (web admin) classifies:
 * `{ lastTickAt, intervalMs, running }`.
 *
 * Timer callbacks never throw: a failed run logs
 * `[scheduler] <name> tick failed:` plus the cause.
 */

const nodeCron = require("node-cron");

const OVERLAP_SKIP = "skip";
const OVERLAP_ALLOW = "allow";

/**
 * Milliseconds until the next wall-clock multiple of intervalMs.
 * On an exact boundary, waits a full interval (same as the legacy
 * `interval - (now % interval)` tickers).
 * @param {number} intervalMs
 * @param {number} now
 * @returns {number}
 */
function msToNextBoundary(intervalMs, now) {
  const n = Number(intervalMs);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const rem = now % n;
  return rem === 0 ? n : n - rem;
}

/**
 * @param {object} [deps]
 * @param {() => number} [deps.now]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 * @param {typeof setInterval} [deps.setIntervalFn]
 * @param {typeof clearInterval} [deps.clearIntervalFn]
 * @param {(expr: string, fn: Function) => { stop?: Function }} [deps.cronSchedule]
 * @returns {object}
 */
function createScheduler(deps = {}) {
  const now = deps.now || Date.now;
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;
  const setIntervalFn = deps.setIntervalFn || setInterval;
  const clearIntervalFn = deps.clearIntervalFn || clearInterval;
  const cronSchedule =
    deps.cronSchedule || ((expr, fn) => nodeCron.schedule(expr, fn));

  /** @type {Map<string, object>} */
  const jobs = new Map();

  /**
   * @param {object} spec
   * @param {string} spec.name
   * @param {() => (void|Promise<void>)} spec.run
   * @param {number} [spec.intervalMs]
   * @param {boolean} [spec.align] delay the repeating interval to the next boundary
   * @param {boolean} [spec.runImmediately]
   * @param {number} [spec.delayFirstMs] extra one-shot first fire
   * @param {string} [spec.cron] node-cron expression (local timezone)
   * @param {"skip"|"allow"} [spec.overlap]
   * @param {boolean} [spec.unref] unref timers (default true)
   */
  function registerJob(spec) {
    if (!spec?.name || typeof spec.name !== "string") {
      throw new Error("scheduler.registerJob: name is required");
    }
    if (typeof spec.run !== "function") {
      throw new Error(`scheduler.registerJob: run is required for ${spec.name}`);
    }
    if (jobs.has(spec.name)) stop(spec.name);

    const overlap =
      spec.overlap === OVERLAP_ALLOW ? OVERLAP_ALLOW : OVERLAP_SKIP;
    const unref = spec.unref !== false;
    const job = {
      name: spec.name,
      run: spec.run,
      intervalMs:
        Number.isFinite(spec.intervalMs) && spec.intervalMs > 0
          ? spec.intervalMs
          : null,
      cron: spec.cron || null,
      overlap,
      inFlight: false,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastError: null,
      runCount: 0,
      skipCount: 0,
      timers: [],
      cronTask: null,
      _fire: null,
    };

    const fire = () => {
      if (job.overlap === OVERLAP_SKIP && job.inFlight) {
        job.skipCount += 1;
        console.log(
          `[scheduler] ${job.name}: previous tick still running; skipping`,
        );
        return;
      }
      job.inFlight = true;
      job.lastStartedAt = now();
      job.runCount += 1;
      Promise.resolve()
        .then(() => job.run())
        .then(() => {
          job.lastError = null;
        })
        .catch((err) => {
          job.lastError = err?.message || String(err);
          console.error(
            `[scheduler] ${job.name} tick failed:`,
            job.lastError,
          );
        })
        .finally(() => {
          job.inFlight = false;
          job.lastFinishedAt = now();
        });
    };
    job._fire = fire;

    if (spec.runImmediately) fire();

    if (Number.isFinite(spec.delayFirstMs) && spec.delayFirstMs > 0) {
      const t = setTimeoutFn(fire, spec.delayFirstMs);
      if (unref && typeof t.unref === "function") t.unref();
      job.timers.push({ kind: "timeout", id: t });
    }

    if (job.intervalMs) {
      if (spec.align) {
        const delay = msToNextBoundary(job.intervalMs, now());
        const t = setTimeoutFn(() => {
          fire();
          const iv = setIntervalFn(fire, job.intervalMs);
          if (unref && typeof iv.unref === "function") iv.unref();
          job.timers.push({ kind: "interval", id: iv });
        }, delay);
        if (unref && typeof t.unref === "function") t.unref();
        job.timers.push({ kind: "timeout", id: t });
      } else {
        const iv = setIntervalFn(fire, job.intervalMs);
        if (unref && typeof iv.unref === "function") iv.unref();
        job.timers.push({ kind: "interval", id: iv });
      }
    }

    if (job.cron) {
      job.cronTask = cronSchedule(job.cron, fire);
    }

    jobs.set(job.name, job);
    return job;
  }

  /**
   * Stop one job, or all jobs when name is omitted. In-flight runs are
   * not cancelled.
   * @param {string} [name]
   */
  function stop(name) {
    const targets = name
      ? [jobs.get(name)].filter(Boolean)
      : [...jobs.values()];
    for (const job of targets) {
      for (const t of job.timers) {
        if (t.kind === "timeout") clearTimeoutFn(t.id);
        else clearIntervalFn(t.id);
      }
      job.timers = [];
      if (job.cronTask && typeof job.cronTask.stop === "function") {
        job.cronTask.stop();
      }
      job.cronTask = null;
      jobs.delete(job.name);
    }
  }

  /**
   * Fire a registered job now (tests). Honors overlap skip.
   * @param {string} name
   */
  function runNow(name) {
    const job = jobs.get(name);
    if (!job) throw new Error(`scheduler.runNow: unknown job ${name}`);
    job._fire();
  }

  /** @param {string} name */
  function getJob(name) {
    return jobs.get(name) || null;
  }

  /**
   * One row per job for dashboards / tests.
   * @returns {object[]}
   */
  function snapshot() {
    return [...jobs.values()].map((job) => ({
      name: job.name,
      lastTickAt: job.lastFinishedAt ?? job.lastStartedAt,
      lastStartedAt: job.lastStartedAt,
      lastFinishedAt: job.lastFinishedAt,
      lastError: job.lastError,
      intervalMs: job.intervalMs,
      cron: job.cron,
      running: job.inFlight,
      runCount: job.runCount,
      skipCount: job.skipCount,
    }));
  }

  function listNames() {
    return [...jobs.keys()];
  }

  return {
    registerJob,
    stop,
    runNow,
    getJob,
    snapshot,
    listNames,
  };
}

const defaultScheduler = createScheduler();

module.exports = {
  createScheduler,
  msToNextBoundary,
  OVERLAP_SKIP,
  OVERLAP_ALLOW,
  registerJob: defaultScheduler.registerJob,
  stop: defaultScheduler.stop,
  runNow: defaultScheduler.runNow,
  getJob: defaultScheduler.getJob,
  snapshot: defaultScheduler.snapshot,
  listNames: defaultScheduler.listNames,
};
