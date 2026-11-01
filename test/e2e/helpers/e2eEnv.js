/**
 * E2E environment: boots the REAL bot (src/platform/boot) against a running
 * fauxcord mock Discord — real gateway handshake, real router, real SQLite.
 *
 * One namespace per suite file (unique bot token/app/guild/user ids), so
 * files are independent even though they share the mock's SQLite file.
 *
 * Prerequisite: fauxcord must be reachable (default http://127.0.0.1:3100,
 * override with FAUXCORD_URL). Start it with:  scripts/e2e/start-mock.sh
 *
 * Lifecycle contract (node:test):
 *   const env = await createE2eEnv({ ns: 1 });   // before()
 *   await env.cleanup();                          // after()  — drains boot
 *                                                 // handles, then hard-exits
 *                                                 // if anything lingers
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { MockEnv, namespaceIds, DEFAULT_BASE } = require("./mockenv");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const MOCK_MISSING_HINT =
  "fauxcord mock Discord is not reachable — start it with:\n" +
  "  scripts/e2e/start-mock.sh\n" +
  "(override the address with FAUXCORD_URL)";

// #792: the host-global fauxcord mock (one shared port 3100, serialized
// runner pool) blips — restarts mid-suite — and a single failed boot used to
// cancel the whole suite file over it. The harness now waits for the mock to
// come back and retries boot, while a PERMANENT outage still fails fast
// (initial health grace ≈ 5s; a mock that never recovers across retries adds
// only the bounded backoff/health waits below on top).
const INITIAL_HEALTH_GRACE_MS = 5_000;
const HEALTH_RECOVERY_WAIT_MS = 4_000; // per retry: wait for /_mock/health
const BOOT_MAX_RETRIES = 2; // total attempts = BOOT_MAX_RETRIES + 1
const BOOT_BACKOFF_MS = [2_000, 5_000]; // before retry N (1-based)

/**
 * Poll `mock.healthy()` until the deadline. Resolves true once the mock
 * answers /_mock/health, false when the grace elapses (never rejects —
 * a dead mock is an expected branch here, not a test error).
 */
async function waitForHealthy(mock, timeoutMs, { everyMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await mock.healthy()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

/**
 * Create and boot one E2E namespace.
 *
 * @param {{ns: number, guildName?: string, register?: boolean,
 *   users?: Array<{id: string, username: string}>,
 *   channels?: Array<{id: string, name: string}>}} options
 * @returns {Promise<{
 *   ids: object, mock: MockEnv, communityId: number, dbmod: object,
 *   supervisor: object, dataDir: string, cleanup: () => Promise<void>,
 * }>}
 */
async function createE2eEnv(options) {
  const { ns, guildName, register = true, ...provisionSpec } = options;
  if (!Number.isInteger(ns) || ns < 1 || ns > 99) {
    throw new Error(`createE2eEnv: ns must be an integer 1..99, got ${ns}`);
  }
  const base = (process.env.FAUXCORD_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const ids = namespaceIds(ns);
  const mock = new MockEnv({ base, ids });

  // Initial probe with a short grace: a mock mid-restart answers again
  // within seconds; a permanently absent one still fails fast here with
  // the usual MOCK_MISSING_HINT copy (#792).
  if (!(await waitForHealthy(mock, INITIAL_HEALTH_GRACE_MS))) {
    throw new Error(
      `[e2e] ${MOCK_MISSING_HINT}\n(target: ${base}, unhealthy for ${INITIAL_HEALTH_GRACE_MS}ms)`,
    );
  }

  // Provisioning is idempotent (MockEnv#provision removes any previous
  // setup for this token first), so one blip-retry cannot double-provision.
  try {
    await mock.provision(provisionSpec);
  } catch (err) {
    const first = err?.message || err;
    console.warn(
      `[e2e] provision failed (namespace ${ns}): ${first} — ` +
        "waiting for the mock to recover and retrying once",
    );
    if (!(await waitForHealthy(mock, HEALTH_RECOVERY_WAIT_MS))) {
      console.warn(`[e2e] mock still unhealthy (namespace ${ns}) — retrying provision anyway`);
    }
    try {
      await mock.provision(provisionSpec);
    } catch (err2) {
      throw new Error(
        `[e2e] provision failed after 2 attempts (namespace ${ns}): ${err2?.message || err2} ` +
          `(first attempt: ${first})`,
      );
    }
  }

  // Production env BEFORE requiring anything that opens the DB (repo config
  // reads process.env at require time; dotenv never overrides set values).
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `bs-e2e-ns${ns}-`));
  Object.assign(process.env, {
    DB_PATH: path.join(dataDir, "e2e.sqlite"),
    DATA_DIR: dataDir,
    DISCORD_TOKEN: ids.token,
    CLIENT_ID: ids.app,
    DEV_GUILD_ID: ids.guild,
    DISCORD_API_BASE: base,
    FEATURE_GATE_WATCHDOG_MS: "8000",
  });
  delete process.env.FLUXER_INSTANCES;

  // Production wiring, required after env setup.
  const { ensureCommunity } = require(path.join(REPO_ROOT, "src/platform/community"));
  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: ids.guild,
  });
  const dbmod = require(path.join(REPO_ROOT, "src/db"));

  // Fail-fast guard: src/db/connection.js resolves DB_PATH at REQUIRE time.
  // If a suite file (or anything it imports) pulled a src module in BEFORE
  // this point, the singleton is silently bound to the DEV database and the
  // suite reads/writes real dev data. Catch that here instead.
  const boundFile = dbmod.db
    .prepare("PRAGMA database_list")
    .all()
    .find((d) => d.name === "main")?.file;
  if (boundFile && path.resolve(boundFile) !== path.resolve(process.env.DB_PATH)) {
    throw new Error(
      `[e2e] namespace ${ns}: sqlite bound to ${boundFile} — expected ` +
        `${process.env.DB_PATH}. Something required a src/** module before ` +
        "createE2eEnv() set DB_PATH (connection.js resolves the path at " +
        "require time); require src modules lazily inside tests.",
    );
  }

  const { boot } = require(path.join(REPO_ROOT, "src/platform/boot"));
  // Retry contract (#792): a boot where NO endpoint came up leaves nothing
  // behind to unwind — the feature gate never opened (no feature hooks or
  // tickers ran), the dead client is destroyed by boot() itself, and the
  // named shutdown handles are replaced (not stacked) by the next boot().
  // So a healthy retry is just another boot() — and a still-failing one
  // keeps the same terminal semantics as before, now with attempts noted.
  const attempts = BOOT_MAX_RETRIES + 1;
  let started = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    started = await boot({ featureGateWatchdogMs: 8000 });
    if (started.ok) {
      if (attempt > 1) {
        console.warn(
          `[e2e] boot() recovered on attempt ${attempt}/${attempts} (namespace ${ns}) — ` +
            "the mock blipped; continuing",
        );
      }
      break;
    }
    if (attempt === attempts) break;
    const backoffMs = BOOT_BACKOFF_MS[attempt - 1];
    console.warn(
      `[e2e] boot() failed against mock (namespace ${ns}, attempt ${attempt}/${attempts}): ` +
        `${JSON.stringify(started.exitCode)} — backing off ${backoffMs}ms and retrying`,
    );
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    if (!(await waitForHealthy(mock, HEALTH_RECOVERY_WAIT_MS))) {
      console.warn(
        `[e2e] mock still unhealthy (namespace ${ns}, attempt ${attempt}) — retrying boot anyway`,
      );
    }
  }
  if (!started.ok) {
    throw new Error(
      `[e2e] boot() failed against mock (namespace ${ns}) after ${attempts} attempts: ` +
        `${JSON.stringify(started.exitCode)}`,
    );
  }
  const supervisor = started.supervisor;

  // Router gates guild interactions on interaction.guild ⇒ the GUILD_CREATE
  // must have hydrated the gateway cache. READY alone only yields an
  // `unavailable` guild stub — wait for a channel (delivered with
  // GUILD_CREATE) so downstream tests never observe the stub.
  const { poll } = require("./mockenv");
  await poll(() => supervisor.discord?.channels?.cache?.get(ids.general) ?? null, {
    timeoutMs: 8000,
    label: `GUILD_CREATE channels for ${ids.guild}`,
  });

  if (register) {
    const reg = spawnSync(process.execPath, [path.join(REPO_ROOT, "src", "commands", "register.js")], {
      env: process.env,
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (reg.status !== 0) {
      throw new Error(
        `[e2e] register.js failed (namespace ${ns}, exit ${reg.status}):\n` +
          String(reg.stdout || "") + String(reg.stderr || ""),
      );
    }
  }

  let cleanedUp = false;
  /**
   * Drain boot shutdown handles (scheduler, feature tickers, client),
   * remove the temp DB dir, and hard-exit shortly after if stray handles
   * keep the event loop alive (feature tickers are the usual suspect).
   */
  async function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    const { runShutdown } = require(path.join(REPO_ROOT, "src/core/lifecycle"));
    try {
      await runShutdown({ reason: "e2e-suite-file-complete" });
    } catch (err) {
      console.error(`[e2e] runShutdown failed (ns ${ns}):`, err?.message || err);
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`[e2e] temp dir cleanup failed (ns ${ns}):`, err?.message || err);
    }
    // Unref'd: never keeps the process alive itself, but fires (forcing a
    // clean exit code) when lingering handles would otherwise hang the run.
    setTimeout(() => process.exit(process.exitCode || 0), 3000).unref();
  }

  return { ids, mock, communityId, dbmod, supervisor, dataDir, cleanup };
}

module.exports = { createE2eEnv, REPO_ROOT };
