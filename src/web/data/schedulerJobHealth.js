/**
 * Scheduler → ticker-health bridge (roadmap/web-admin.md §8.15 Task 15.6).
 *
 * EVERY recurring job in this repo already funnels through
 * src/core/scheduler.js registerJob() (verified: voice, youtube, twitch,
 * xpCooldownSweep, githubReleases, eventReminders, decay, warningsExpiry,
 * honeypotSweep, messageCacheSweep — the only raw setInterval left is the
 * transient typing indicator in features/gork/trigger.js, which is not a
 * background job). The scheduler therefore already owns honest per-job
 * state (lastStartedAt/lastFinishedAt/inFlight/intervalMs/cron/lastError),
 * so ONE bridge at web boot replaces per-feature last-run stamps entirely.
 *
 * WHY HERE / DIRECTION OF DEPENDENCY: this module lives on the web side and
 * imports the SHARED core scheduler (src/core is shared kernel, not bot
 * feature internals — web already consumes core/theme, core/xpMath,
 * core/auditTrail). Feature code never imports web. The bridge is invoked
 * ONLY from web/server.js startWebServer() behind the PUBLIC_HTTP_PORT gate
 * → dark-by-default holds: no port, no registration, boot unchanged.
 *
 * HONESTY RULES (registry contract, tickerHealth.js header — the bridge
 * NEVER fabricates a status; it only re-exposes scheduler facts):
 *  - job gone (never registered / stopped / feature dark) → null ⇒ unknown
 *    ("not wired").
 *  - INTERVAL jobs: pass intervalMs + lastTickAt; the registry derives
 *    ok/stale (age > 2.5× interval ⇒ stale) — no status leaves this module.
 *  - CRON-ONLY jobs carry intervalMs=null and running=false between fires.
 *    The KNOWN GOTCHA: the registry maps a bare `running:false` to DOWN, so
 *    a raw snapshot passthrough would render a healthy idle cron job as
 *    down. The bridge therefore forwards `running` ONLY while the job is
 *    actually in flight (true ⇒ ok: a tick is executing right now) and
 *    leaves cron rows as UNKNOWN with the last-tick info + a fixed detail
 *    otherwise. No cron parser is invented to guess a cadence.
 *  - never ticked yet: no lastTickAt is fabricated; the row reads unknown
 *    with a fixed "no completed tick yet" detail.
 *  - lastError text NEVER leaves this module (§8.7 fixed strings); a failed
 *    last tick surfaces as the fixed detail "last tick failed".
 *
 * In-memory only, zero DB writes, zero timers here (the provider and its
 * getters re-read the scheduler at snapshot time). Registration replaces
 * one provider ("scheduler-jobs"), so a web-server double boot is safe and
 * jobs appearing AFTER web boot (bridge, linking — the real feature order)
 * get their rows without anyone re-invoking the bridge (#217).
 */

const { registerTickerHealthProvider } = require("./tickerHealth");
const defaultScheduler = require("../../core/scheduler");

/** Fixed bridge details — never interpolated with scheduler internals. */
const DETAIL_LAST_TICK_FAILED = "last tick failed";
const DETAIL_NO_TICK_YET = "registered; no completed tick yet";
const DETAIL_CRON_NO_DERIVED = "cron cadence; no derived status";

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Pure adapter: ONE live scheduler job object (scheduler.getJob shape;
 * snapshot() rows with `running` are accepted too) → registry getter
 * result. Never sets `status`; never leaks lastError text.
 * @param {object|null} job raw job (null ⇒ job not registered)
 * @returns {null | {lastTickAt?: number, intervalMs?: number, running?: true, detail?: string}}
 */
function schedulerJobToTickerResult(job) {
  if (!job || typeof job !== "object") return null;

  const out = {};
  // Same definition of "last tick" the scheduler's own snapshot() uses.
  // STRICT number check first: Number(null) is 0, and a coerced epoch-0
  // "tick" would fake a millennia-stale stamp for a never-ticked job.
  const lastTickAt = job.lastFinishedAt ?? job.lastStartedAt;
  const lastTickMs =
    typeof lastTickAt === "number" && Number.isFinite(lastTickAt)
      ? lastTickAt
      : null;
  if (lastTickMs !== null) out.lastTickAt = lastTickMs;

  const intervalMs = finitePositive(job.intervalMs);
  if (intervalMs !== null) out.intervalMs = intervalMs;

  const inFlight = job.inFlight === true || job.running === true;
  if (inFlight) out.running = true; // ⇒ ok (a tick is executing RIGHT NOW).
  // running:false is DELIBERATELY never forwarded: between cron fires it
  // means "not mid-tick", NOT "dead" — forwarding it would fabricate down.

  const details = [];
  if (job.lastError) details.push(DETAIL_LAST_TICK_FAILED);
  if (lastTickMs === null) {
    details.push(DETAIL_NO_TICK_YET);
  } else if (intervalMs === null && !inFlight) {
    details.push(DETAIL_CRON_NO_DERIVED);
  }
  if (details.length) out.detail = details.join("; ");

  return out;
}

/**
 * Register one snapshot-time provider projecting EVERY registered scheduler
 * job into the health registry. THE NAME SET IS LIVE: the provider re-reads
 * scheduler.listNames() on every snapshot, so jobs registered AFTER web
 * boot finally get rows. THE REAL ORDER (src/features/index.js): web boots
 * BEFORE gork/bridge/linking, so bridge-relay, bridge-expiry,
 * bridge-relay-ttl and linking-code-expiry were invisible to a boot-time
 * enumeration — the live app rendered none of them (issue #217: the relay
 * worker had no ticker-health row). Each getter still re-looks-up
 * scheduler.getJob(name), so re-registered or stopped jobs are reflected
 * with zero bookkeeping. Registration replaces per provider name ⇒ a
 * double-boot of the web server is safe.
 *
 * @param {object} [schedulerApi] scheduler instance seam (default: the
 *   process-wide scheduler features register into; tests inject a fake)
 * @param {(name: string, fn: Function) => Function} [registerProvider]
 *   registry seam (default: registerTickerHealthProvider; test seam)
 * @returns {() => void} unregister helper
 */
function registerSchedulerJobHealthSources(
  schedulerApi = defaultScheduler,
  registerProvider = registerTickerHealthProvider
) {
  // STICKY names: a scheduler job that disappears (stop()) must keep its
  // row as unknown/"not wired" (honesty rule #1 above) — enumerate the
  // CURRENT set every snapshot but never forget a name once seen. A job
  // appearing later (bridge/linking boot after web, #217) self-heals
  // through the same live enumeration.
  const seenNames = new Set();
  return registerProvider("scheduler-jobs", () => {
    for (const name of schedulerApi.listNames()) seenNames.add(name);
    return [...seenNames].map((name) => [
      name,
      () => schedulerJobToTickerResult(schedulerApi.getJob(name)),
    ]);
  });
}

module.exports = {
  DETAIL_LAST_TICK_FAILED,
  DETAIL_NO_TICK_YET,
  DETAIL_CRON_NO_DERIVED,
  schedulerJobToTickerResult,
  registerSchedulerJobHealthSources,
};
