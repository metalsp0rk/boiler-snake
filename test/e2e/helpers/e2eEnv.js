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

  if (!(await mock.healthy())) {
    throw new Error(`[e2e] ${MOCK_MISSING_HINT}\n(target: ${base})`);
  }

  await mock.provision(provisionSpec);

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

  const { boot } = require(path.join(REPO_ROOT, "src/platform/boot"));
  const started = await boot({ featureGateWatchdogMs: 8000 });
  if (!started.ok) {
    throw new Error(
      `[e2e] boot() failed against mock (namespace ${ns}): ${JSON.stringify(started.exitCode)}`,
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
