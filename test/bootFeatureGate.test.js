/**
 * Boot-level feature-gate tests for issue #190 (audit C7): an INITIAL
 * Discord login rejection must be a HANDLED, TERMINAL endpoint failure —
 * one specific fatal, the dead client released, and the feature layer
 * armed on the surviving endpoint(s) instead of the pre-fix silent zombie
 * (gate waiting forever on a ClientReady that can never fire). Also covers
 * the feature-gate watchdog (specific warning on fake timers, cleared when
 * the gate opens) and the all-endpoints-failed contract (fatal, nothing
 * armed — the drain-and-exit itself is covered in test/processGuards.test.js
 * and the spawned-child integration).
 *
 * DETERMINISM CONTRACT: no network, no sleeps, no wall-clock. The endpoint
 * factories (src/client, src/platform/fluxer/client) and the feature list
 * (src/features) are replaced BEFORE boot.js is required, because boot()
 * destructures them at module load — the real gate/watchdog/terminal logic
 * then runs against fully scripted stubs and fake timers (house pattern
 * from #238/#239 and test/command-permissions-oauth.test.js).
 */
const { describe, it, before, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Events } = require("discord.js");

const { loadDb } = require("./helpers/env");

// CONTRACT (test/registry.test.js): loadDb() must run before every `src/`
// require — boot() pulls the whole feature graph, which opens SQLite at
// require time.
const { cleanup } = loadDb();

const lifecycle = require("../src/core/lifecycle");
// Park the module on its test-safe state BEFORE boot() installs the guards
// with no options: real listeners get registered (that's fine), but the
// drain/fatal exit seam stays the resetForTests no-op (PR #238 lesson).
lifecycle.resetForTests();

const CLIENT_PATH = require.resolve("../src/client");
const FLUXER_CLIENT_PATH = require.resolve("../src/platform/fluxer/client");
const FEATURES_PATH = require.resolve("../src/features");

// Clearly-fake placeholders only (AGENTS.md: never realistic tokens).
const FAKE_DISCORD_TOKEN = "YOUR_FAKE_DISCORD_TOKEN";
const FAKE_FLUXER_JSON = '[{"origin":"https://fluxer.test","token":"YOUR_FAKE_FLUXER_TOKEN"}]';
const CREDENTIAL_VARS = [
  "DISCORD_TOKEN",
  "FLUXER_INSTANCES",
  "FEATURE_GATE_WATCHDOG_MS",
  "FEATURE_GATE_MAX_HOLD_MS",
];

// --------------------------------------------------------------------------
// Scripted stubs (installed into the require cache BEFORE boot is required)
// --------------------------------------------------------------------------

/** Per-test scripted endpoint behavior, mutated by each it(). */
const endpoints = {
  /** last fake Discord client handed to boot() */
  client: null,
  /** createFluxerHandle implementation */
  fluxerImpl: async () => null,
};

function makeFakeDiscordClient() {
  const client = new EventEmitter();
  client.user = { tag: "fake-test-bot" };
  client.destroyCount = 0;
  client.destroy = async () => {
    client.destroyCount += 1;
  };
  client.login = () => client.loginPromise;
  // Controlled login promise: tests resolve/reject it explicitly.
  client.loginPromise = new Promise((resolve, reject) => {
    client.resolveLogin = resolve;
    client.rejectLogin = reject;
  });
  // Never let an unused rejection (e.g. test aborted) escape as unhandled.
  client.loginPromise.catch(() => {});
  return client;
}

function makeFakeFluxerHandle(instanceKey = "https://fluxer.test") {
  return {
    instanceKey,
    label: instanceKey,
    userId: "420000000000000001",
    ready: true,
    rest: { request: async () => null },
    outbound: { fake: "fluxer-outbound" },
    apiOrigin: "https://api.fluxer.test",
    destroy: async () => {},
    onDmMessage: () => () => {},
  };
}

/** Recorded feature-hook calls (reset in beforeEach). */
const featureCalls = { registerEvents: [], start: [] };

/**
 * Fake feature list: one Fluxer-tolerant feature (records what the gate
 * handed it) and one Discord-hard feature that fails fast WITHOUT a client
 * — proving load.js isolates + logs it per feature (the "skip with a
 * logged reason" contract) instead of it killing the boot.
 */
const fakeFeatures = [
  {
    name: "fluxer-side",
    registerEvents(supervisor) {
      featureCalls.registerEvents.push(supervisor);
    },
    start(supervisor) {
      featureCalls.start.push({
        name: "fluxer-side",
        discord: supervisor.discord,
        fluxerCount: supervisor.fluxer.size,
      });
    },
  },
  {
    name: "discord-tier",
    start(supervisor) {
      if (!supervisor.discord) {
        throw new Error("requires supervisor.discord, got null");
      }
      featureCalls.start.push({
        name: "discord-tier",
        discord: supervisor.discord,
        fluxerCount: supervisor.fluxer.size,
      });
    },
  },
];

const realClientModule = require(CLIENT_PATH);
const realFluxerModule = require(FLUXER_CLIENT_PATH);
const originalCreateClient = realClientModule.createClient;
const originalCreateFluxerHandle = realFluxerModule.createFluxerHandle;

realClientModule.createClient = () => {
  endpoints.client = makeFakeDiscordClient();
  return endpoints.client;
};
realFluxerModule.createFluxerHandle = (entry, options) =>
  endpoints.fluxerImpl(entry, options);

// boot() destructures `require("../features")` at module load, so the array
// swap must enter the require cache BEFORE the boot require below.
require.cache[FEATURES_PATH] = {
  id: FEATURES_PATH,
  filename: FEATURES_PATH,
  loaded: true,
  exports: fakeFeatures,
  children: [],
  paths: [],
};

const { boot } = require("../src/platform/boot");

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Run fn with console.log/error/warn captured. Resolves { result, logs }.
 *  fn runs SYNCHRONOUSLY so boot()'s pre-await section (timer arming,
 *  client construction) has completed by the time the caller inspects it. */
function withCaptured(fn) {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const logs = [];
  const capture = (...args) => logs.push(args.join(" "));
  console.log = capture;
  console.error = capture;
  console.warn = capture;
  let started;
  try {
    started = Promise.resolve(fn());
  } catch (err) {
    started = Promise.reject(err);
  }
  return started
    .then(
      (result) => ({ result, logs }),
      (error) => ({ error, logs }),
    )
    .finally(() => Object.assign(console, orig));
}

/**
 * Fake clock: boot's watchdog seam returns plain objects (boot's unref
 * probe skips them); advance() moves a virtual clock — zero wall-clock.
 */
function makeFakeClock() {
  let now = 0;
  let seq = 0;
  const scheduled = [];
  return {
    setTimeoutFn: (fn, ms) => {
      const timer = { id: ++seq, at: now + ms, fn, cleared: false, fired: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => {
      if (timer) timer.cleared = true;
    },
    advance(ms) {
      now += ms;
      for (const timer of [...scheduled].sort((a, b) => a.at - b.at)) {
        if (!timer.cleared && timer.at <= now) {
          timer.cleared = true;
          timer.fired = true;
          const i = scheduled.indexOf(timer);
          if (i >= 0) scheduled.splice(i, 1);
          timer.fn();
        }
      }
    },
    /** armed (uncleared, unfired) timers */
    pendingCount: () => scheduled.filter((t) => !t.cleared).length,
  };
}

/** Let queued microtasks (stub resolutions, .catch chains) run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setEnv(pairs) {
  for (const name of CREDENTIAL_VARS) delete process.env[name];
  for (const [name, value] of Object.entries(pairs)) {
    if (value !== undefined) process.env[name] = value;
  }
}

// --------------------------------------------------------------------------

before(() => {
  for (const name of CREDENTIAL_VARS) delete process.env[name];
});

beforeEach(() => {
  featureCalls.registerEvents.length = 0;
  featureCalls.start.length = 0;
  endpoints.client = null;
  endpoints.fluxerImpl = async () => null;
});

afterEach(() => {
  // Every boot installs the guards; reset between tests so handle-name
  // assertions see only the CURRENT boot's registrations (and the exit
  // seam stays the test-safe no-op).
  lifecycle.resetForTests();
});

after(() => {
  realClientModule.createClient = originalCreateClient;
  realFluxerModule.createFluxerHandle = originalCreateFluxerHandle;
  delete require.cache[FEATURES_PATH];
  cleanup();
});

describe("boot() feature gate — Discord login rejection is terminal (audit C7)", () => {
  it("discord login rejects + fluxer healthy: specific fatal, endpoint nulled, features armed on the survivor", async () => {
    setEnv({ DISCORD_TOKEN: FAKE_DISCORD_TOKEN, FLUXER_INSTANCES: FAKE_FLUXER_JSON });
    const handle = makeFakeFluxerHandle();
    endpoints.fluxerImpl = async () => handle;

    const run = withCaptured(() => boot({ registry: {} }));
    await flush(); // fluxer handle lands; gate must still hold (discord in flight)
    assert.equal(featureCalls.start.length, 0, "gate holds while discord login is in flight");

    endpoints.client.rejectLogin(new Error("An invalid token was provided."));
    const { result, logs } = await run;

    // 1. One loud, specific fatal naming the endpoint decision.
    assert.ok(
      logs.some((l) =>
        l.includes(
          "[boot] discord login failed: An invalid token was provided. " +
            "— endpoint disabled for this process; features arm on the surviving endpoint(s)",
        ),
      ),
      `expected the terminal fatal, got: ${JSON.stringify(logs)}`,
    );
    // 2. The dead client is released and the endpoint reads as unconfigured.
    assert.equal(endpoints.client.destroyCount, 1, "dead client destroyed once");
    assert.equal(result.supervisor.discord, null, "supervisor.discord back to null");
    // 3. The feature layer ARMED on the surviving endpoint (the C7 zombie
    //    is exactly this call never happening).
    assert.equal(result.ok, true, "surviving Fluxer endpoint keeps the boot alive");
    assert.equal(result.exitCode, 0);
    const fluxerStart = featureCalls.start.find((c) => c.name === "fluxer-side");
    assert.ok(fluxerStart, "fluxer-side feature's start() ran");
    assert.equal(fluxerStart.fluxerCount, 1, "surviving handle reached the features");
    assert.equal(fluxerStart.discord, null, "features saw discord === null at start");
    // 4. The Discord-hard feature SKIPPED with a per-feature logged reason
    //    (load.js isolation) instead of killing the boot.
    assert.equal(
      featureCalls.start.find((c) => c.name === "discord-tier"),
      undefined,
      "discord-tier feature did not start",
    );
    assert.ok(logs.some((l) => l.includes("[features] discord-tier.start failed:")));
    assert.ok(logs.some((l) => l.includes("boot continuing with degraded features")));
    // 5. Event registration ran exactly once (pre-login, on the discord branch).
    assert.equal(featureCalls.registerEvents.length, 1);
    // 6. The feature-layer shutdown handles exist (gate really opened).
    const names = lifecycle.shutdownHandleNames();
    assert.ok(names.includes("scheduler"), `scheduler handle missing: ${names}`);
    assert.ok(
      names.includes("member-fetch-queue"),
      `member-fetch-queue handle missing: ${names}`,
    );
    // 7. No all-endpoints-failed fatal — one endpoint survived.
    assert.ok(!logs.some((l) => l.includes("every configured endpoint failed")));
  });

  it("fluxer ready FIRST, discord rejects later: same terminal recovery, start() runs exactly once", async () => {
    setEnv({ DISCORD_TOKEN: FAKE_DISCORD_TOKEN, FLUXER_INSTANCES: FAKE_FLUXER_JSON });
    endpoints.fluxerImpl = async () => makeFakeFluxerHandle();

    const run = withCaptured(() => boot({ registry: {} }));
    await flush();
    // Discord login still in flight (a slow handshake): the gate holds even
    // though fluxer is already up. Then the initial login REJECTS — the
    // terminal path must arm features that fluxer's ready path could not.
    endpoints.client.rejectLogin(new Error("An invalid token was provided."));
    const { result, logs } = await run;

    assert.equal(result.ok, true);
    assert.equal(featureCalls.start.length, 1, "start fires exactly once per process");
    assert.ok(logs.some((l) => l.includes("[boot] discord login failed:")));
  });

  it("discord login success is unchanged: ClientReady keeps ownership of the trigger", async () => {
    setEnv({ DISCORD_TOKEN: FAKE_DISCORD_TOKEN, FLUXER_INSTANCES: FAKE_FLUXER_JSON });
    const handle = makeFakeFluxerHandle();
    endpoints.fluxerImpl = async () => handle;

    const run = withCaptured(() => boot({ registry: {} }));
    await flush();
    // Healthy mixed boot: fluxer is up but the constructed Discord client
    // still owns the gate while its login is in flight (pre-fix contract,
    // pinned so this fix does not start arming features under a pending
    // Discord).
    assert.equal(featureCalls.start.length, 0);

    endpoints.client.emit(Events.ClientReady, endpoints.client);
    endpoints.client.resolveLogin();
    const { result, logs } = await run;

    assert.equal(result.ok, true);
    assert.ok(logs.some((l) => l.includes("Boiler Snake logged in as fake-test-bot")));
    assert.equal(result.supervisor.discord, endpoints.client, "live client kept");
    assert.deepEqual(
      featureCalls.start.map((c) => c.name).sort(),
      ["discord-tier", "fluxer-side"],
      "both features arm when Discord is live",
    );
    assert.ok(!logs.some((l) => l.includes("discord login failed")));
  });
});

describe("boot() all-endpoints-failed contract", () => {
  it("discord rejects + fluxer resolves null: fatal names both outcomes, nothing is armed", async () => {
    setEnv({ DISCORD_TOKEN: FAKE_DISCORD_TOKEN, FLUXER_INSTANCES: FAKE_FLUXER_JSON });
    endpoints.fluxerImpl = async () => null;
    const clock = makeFakeClock();

    const { result, logs } = await withCaptured(async () => {
      const run = boot({
        registry: {},
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
        featureGateWatchdogMs: 60_000,
      });
      endpoints.client.rejectLogin(new Error("An invalid token was provided."));
      return run;
    });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.ok(logs.some((l) => l.includes("[boot] discord login failed:")));
    assert.ok(
      logs.some(
        (l) =>
          l.includes("every configured endpoint failed (2 endpoint(s))") &&
          l.includes("the feature layer was never armed") &&
          l.includes("discord was disabled by a terminal login failure"),
      ),
      `expected the all-failed fatal with the terminal note, got: ${JSON.stringify(logs)}`,
    );
    // NOTHING armed: no feature starts, no scheduler/web handles.
    assert.equal(featureCalls.start.length, 0);
    const names = lifecycle.shutdownHandleNames();
    assert.ok(names.includes("discord") && names.includes("fluxer"));
    assert.ok(!names.includes("scheduler"), `scheduler must NOT arm: ${names}`);
    assert.ok(!names.includes("member-fetch-queue"), `queue must NOT arm: ${names}`);
    // The all-failed fatal owns the outcome: the watchdog was cleared, so
    // even a later clock advance stays silent.
    clock.advance(300_000);
    assert.ok(!logs.some((l) => l.includes("[boot] watchdog")));
  });
});

describe("boot() feature-gate watchdog (issue #190)", () => {
  it("logs exactly what the gate waits on when the window elapses, then arms normally", async () => {
    setEnv({ FLUXER_INSTANCES: FAKE_FLUXER_JSON }); // fluxer-only
    let releaseFluxer;
    endpoints.fluxerImpl = () => new Promise((resolve) => { releaseFluxer = resolve; });
    const clock = makeFakeClock();

    const run = withCaptured(() =>
      boot({
        registry: {},
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
        featureGateWatchdogMs: 60_000,
      }),
    );
    assert.equal(clock.pendingCount(), 1, "watchdog timer armed once");

    clock.advance(30_000);
    // Not yet: no premature noise.
    clock.advance(30_000);
    await flush();
    // The warning lands (sync inside advance).
    releaseFluxer(makeFakeFluxerHandle());
    const { result, logs } = await run;

    assert.ok(
      logs.some(
        (l) =>
          l.includes("[boot] watchdog: feature layer has not started after 60000ms") &&
          l.includes("fluxer handles (0/1 ready, 1 still connecting)"),
      ),
      `expected the specific watchdog warning, got: ${JSON.stringify(logs)}`,
    );
    assert.equal(result.ok, true, "the handle still lands and arms the gate");
  });

  it("is cleared when the gate opens before the window elapses", async () => {
    setEnv({ FLUXER_INSTANCES: FAKE_FLUXER_JSON });
    endpoints.fluxerImpl = async () => makeFakeFluxerHandle();
    const clock = makeFakeClock();

    const { result, logs } = await withCaptured(() =>
      boot({
        registry: {},
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
        featureGateWatchdogMs: 60_000,
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(clock.pendingCount(), 0, "watchdog timer cleared on gate open");
    clock.advance(600_000);
    assert.ok(!logs.some((l) => l.includes("[boot] watchdog")), "stays silent forever after");
  });

  it("discord-only boot stuck pre-ready: watchdog names the discord wait; terminal rejection then ends the boot", async () => {
    setEnv({ DISCORD_TOKEN: FAKE_DISCORD_TOKEN }); // discord-only, login never settles
    const clock = makeFakeClock();

    const run = withCaptured(() =>
      boot({
        registry: {},
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
        featureGateWatchdogMs: 60_000,
      }),
    );
    clock.advance(60_000);
    await flush();
    // The pre-fix C7 state was SILENCE here; the watchdog must speak.
    endpoints.client.rejectLogin(new Error("An invalid token was provided."));
    const { result, logs } = await run;

    assert.ok(
      logs.some(
        (l) =>
          l.includes("[boot] watchdog:") &&
          l.includes("discord login/ClientReady (client constructed, not ready)"),
      ),
      `expected the discord watchdog warning, got: ${JSON.stringify(logs)}`,
    );
    assert.equal(result.ok, false, "terminal with no survivor: reported, features never armed");
    assert.equal(featureCalls.start.length, 0);
  });
});

describe("boot() watchdog window resolution", () => {
  it("resolves explicit option > env > default and rejects junk loudly", () => {
    const { resolveFeatureGateWatchdogMs, DEFAULT_FEATURE_GATE_WATCHDOG_MS } = require("../src/platform/boot");
    assert.equal(resolveFeatureGateWatchdogMs(500), 500);
    assert.equal(resolveFeatureGateWatchdogMs(0), 0, "0 explicitly disables");
    delete process.env.FEATURE_GATE_WATCHDOG_MS;
    assert.equal(resolveFeatureGateWatchdogMs(undefined), DEFAULT_FEATURE_GATE_WATCHDOG_MS);
    process.env.FEATURE_GATE_WATCHDOG_MS = "1500";
    assert.equal(resolveFeatureGateWatchdogMs(undefined), 1500);
    process.env.FEATURE_GATE_WATCHDOG_MS = "0";
    assert.equal(resolveFeatureGateWatchdogMs(undefined), 0);
    const origErr = console.error;
    const junkLogs = [];
    console.error = (...a) => junkLogs.push(a.join(" "));
    process.env.FEATURE_GATE_WATCHDOG_MS = "not-a-number";
    try {
      assert.equal(
        resolveFeatureGateWatchdogMs(undefined),
        DEFAULT_FEATURE_GATE_WATCHDOG_MS,
        "junk env falls back to the default",
      );
    } finally {
      console.error = origErr;
    }
    assert.ok(junkLogs.some((l) => l.includes('FEATURE_GATE_WATCHDOG_MS "not-a-number"')));
    delete process.env.FEATURE_GATE_WATCHDOG_MS;
  });
});

// ---------------------------------------------------------------------------
// #392 (A2-8): the heartbeat re-arms, and a capped boot opens DEGRADED
// ---------------------------------------------------------------------------

describe("boot() heartbeat re-arm + max-hold degraded gate (#392/A2-8)", () => {
  it("a stuck boot KEEPS reporting: the second window is not silent anymore", async () => {
    setEnv({ FLUXER_INSTANCES: FAKE_FLUXER_JSON });
    let releaseFluxer;
    endpoints.fluxerImpl = () => new Promise((resolve) => { releaseFluxer = resolve; });
    const clock = makeFakeClock();

    const run = withCaptured(() =>
      boot({
        registry: {},
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
        featureGateWatchdogMs: 60_000,
      }),
    );

    clock.advance(60_000);
    clock.advance(60_000);
    clock.advance(60_000);
    await flush();
    releaseFluxer(makeFakeFluxerHandle());
    const { logs } = await run;

    const reports = logs.filter((l) => l.includes("[boot] watchdog"));
    assert.equal(
      reports.length,
      3,
      `every window must re-report while the gate is shut (one-shot watchdog logged 1 — the "silent second hour" of issue #392), got: ${JSON.stringify(reports)}`,
    );
    assert.ok(
      reports[0].includes("fluxer handles (0/1 ready, 1 still connecting)"),
      "the first report keeps the exact #190 shape (pin compatibility)",
    );
    assert.ok(
      reports[1].includes("wait report 2") && reports[2].includes("wait report 3"),
      "escalated reports say how many times the wait has been said",
    );
  });

  it("the cap opens the gate DEGRADED: features see the proven null-discard view while the login crawls", async () => {
    setEnv({ DISCORD_TOKEN: FAKE_DISCORD_TOKEN, FLUXER_INSTANCES: FAKE_FLUXER_JSON });
    endpoints.fluxerImpl = async () => makeFakeFluxerHandle();
    const clock = makeFakeClock();

    const run = withCaptured(() =>
      boot({
        registry: {},
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
        featureGateWatchdogMs: 60_000,
        featureGateMaxHoldMs: 120_000,
      }),
    );
    await flush(); // fluxer ready, discord in flight — the pin's holding still applies
    assert.equal(featureCalls.start.length, 0, "below the cap the C7 hold is intact");

    clock.advance(120_000); // cap elapses (heartbeat already reported once at 60s)
    await flush();

    const started = featureCalls.start.map((c) => c.name);
    assert.ok(
      started.includes("fluxer-side"),
      "the live endpoint's features arm AT the cap — web/tickers/bridge are no longer hostages",
    );
    assert.equal(
      started.includes("discord-tier"),
      false,
      "under the hold the client reads as NULL — the discord-tier feature skips on the proven Fluxer-only path",
    );
    assert.equal(featureCalls.start.find((c) => c.name === "fluxer-side").discord, null);
    assert.equal(
      endpoints.client.destroyCount,
      0,
      "the in-flight login is NOT cancelled — it may still land and restore the view",
    );

    endpoints.client.emit(Events.ClientReady, endpoints.client);
    endpoints.client.resolveLogin();
    const { logs } = await run;

    assert.ok(
      logs.some((l) => l.includes("DEGRADED gate open after 120000ms")),
      `expected the DEGRADED notice, got: ${JSON.stringify(logs)}`,
    );
    assert.ok(
      logs.some((l) => l.includes("discord READY after the degraded gate open")),
      "the late arrival is announced, never silently absorbed",
    );
    assert.ok(!logs.some((l) => l.includes("discord login failed")));
  });

  it("the cap retries while handles are connecting — the bound lands one window after they do", async () => {
    setEnv({ DISCORD_TOKEN: FAKE_DISCORD_TOKEN, FLUXER_INSTANCES: FAKE_FLUXER_JSON });
    let releaseFluxer;
    endpoints.fluxerImpl = () => new Promise((resolve) => { releaseFluxer = resolve; });
    const clock = makeFakeClock();

    const run = withCaptured(() =>
      boot({
        registry: {},
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
        featureGateWatchdogMs: 60_000,
        featureGateMaxHoldMs: 60_000,
      }),
    );

    clock.advance(60_000); // cap elapses mid-CONNECT — must NOT force with nothing live
    await flush();
    assert.equal(featureCalls.start.length, 0, "nothing live yet: the zombie contract outranks the cap");

    releaseFluxer(makeFakeFluxerHandle());
    await flush();
    assert.equal(featureCalls.start.length, 0, "fluxer lands but the in-flight discord still holds");

    clock.advance(60_000); // next cap window: retry sees the ready handle → degraded open
    await flush();
    assert.ok(
      featureCalls.start.map((c) => c.name).includes("fluxer-side"),
      "the retry armed the degraded open after the handle landed",
    );

    endpoints.client.rejectLogin(new Error("YOUR_FAKE_TOKEN is invalid"));
    const { logs } = await run;
    assert.ok(logs.some((l) => l.includes("DEGRADED gate open after 60000ms")));
    assert.ok(logs.some((l) => l.includes("[boot] watchdog")), "the heartbeat ran alongside the cap");
  });

  it("FEATURE_GATE_MAX_HOLD_MS garbage falls back to the disabled default with a complaint", async () => {
    setEnv({ FLUXER_INSTANCES: FAKE_FLUXER_JSON, FEATURE_GATE_MAX_HOLD_MS: "soon" });
    let releaseFluxer;
    endpoints.fluxerImpl = () => new Promise((resolve) => { releaseFluxer = resolve; });
    const clock = makeFakeClock();

    const run = withCaptured(() =>
      boot({
        registry: {},
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
        featureGateWatchdogMs: 60_000,
      }),
    );
    // Only the heartbeat is armed (garbage cap → default 0 → no second timer).
    assert.equal(clock.pendingCount(), 1, "the garbage cap did not arm a second timer");
    releaseFluxer(makeFakeFluxerHandle());
    const { logs } = await run;
    assert.ok(
      logs.some((l) => l.includes('FEATURE_GATE_MAX_HOLD_MS "soon" is not a number >= 0')),
      `expected the specific resolver complaint, got: ${JSON.stringify(logs)}`,
    );
  });
});
