/**
 * Boot-level wiring test for issue #185 (audit C8/C9): boot() must install the
 * process crash net (unhandledRejection / uncaughtException) and the
 * SIGTERM/SIGINT drain, and register the endpoint shutdown handles — while
 * staying completely offline: with NO credentials boot resolves `{ ok:false }`
 * (no endpoint configured), never exits, and starts no timers.
 *
 * The real-process behaviors (escaped rejection keeps the bot alive; SIGTERM
 * drains and exits 0) are covered by test/integration/process-lifecycle.test.js
 * with a spawned child, which is the only honest way to assert on process
 * termination offline.
 */
const { describe, it, after, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT (test/registry.test.js): loadDb() must run before every `src/`
// require — boot() pulls the whole feature graph, which opens SQLite at
// require time. Temp DB + src require-cache reset keeps this isolated.
const { cleanup } = loadDb();

const lifecycle = require("../src/core/lifecycle");
const { boot } = require("../src/platform/boot");

after(cleanup);

const CREDENTIAL_VARS = ["DISCORD_TOKEN", "FLUXER_INSTANCES"];
let savedEnv;

before(() => {
  savedEnv = {};
  for (const name of CREDENTIAL_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  // Leave the test process exactly as we found it (also restores SIGTERM).
  lifecycle.resetForTests();
});

/** Run fn with console.log/error captured; resolves to { result, logs }. */
async function withCaptured(fn) {
  const origLog = console.log;
  const origErr = console.error;
  const logs = [];
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe("boot() installs the process guards (audit C8/C9)", () => {
  let baseCounts;

  beforeEach(() => {
    baseCounts = {
      unhandledRejection: process.listenerCount("unhandledRejection"),
      uncaughtException: process.listenerCount("uncaughtException"),
      SIGTERM: process.listenerCount("SIGTERM"),
      SIGINT: process.listenerCount("SIGINT"),
    };
  });

  it("registers unhandledRejection/uncaughtException + SIGTERM/SIGINT handlers", async () => {
    const { result, logs } = await withCaptured(() => boot());

    assert.equal(lifecycle.isInstalled(), true, "boot must install the lifecycle guards");
    assert.ok(
      process.listenerCount("unhandledRejection") >= baseCounts.unhandledRejection + 1,
      "unhandledRejection handler registered",
    );
    assert.ok(
      process.listenerCount("uncaughtException") >= baseCounts.uncaughtException + 1,
      "uncaughtException handler registered",
    );
    assert.ok(process.listenerCount("SIGTERM") >= baseCounts.SIGTERM + 1, "SIGTERM handler");
    assert.ok(process.listenerCount("SIGINT") >= baseCounts.SIGINT + 1, "SIGINT handler");
    // Offline boot: no credential → resolves, reports, does NOT exit here
    // (index.js owns the exit; boot stays test-safe).
    assert.equal(result.ok, false);
    assert.ok(logs.some((l) => l.includes("every configured endpoint failed")));
  });

  it("is idempotent across repeated boots — no stacked listeners", async () => {
    await withCaptured(() => boot());
    const afterFirst = process.listenerCount("SIGTERM");
    await withCaptured(() => boot());
    assert.equal(
      process.listenerCount("SIGTERM"),
      afterFirst,
      "a second boot() must not stack signal handlers",
    );
  });

  it("registers the endpoint shutdown handles and a manual drain succeeds offline", async () => {
    const bootRun = await withCaptured(() => boot());

    // No features started (no endpoint ready) — only the endpoint handles.
    const names = lifecycle.shutdownHandleNames();
    assert.ok(names.includes("discord"), `discord handle missing: ${names}`);
    assert.ok(names.includes("fluxer"), `fluxer handle missing: ${names}`);

    // Drain runs the real handles (null client / empty fluxer map → no-ops).
    const drain = await withCaptured(() =>
      lifecycle.runShutdown({ reason: "test-drain" }),
    );
    assert.equal(drain.result.timedOut, false);
    assert.deepEqual(drain.result.failed, []);
    const allLogs = [...bootRun.logs, ...drain.logs];
    assert.ok(
      allLogs.some((l) => l.includes("[shutdown] test-drain: draining 2 shutdown handle(s)")),
      `expected drain start log, got: ${JSON.stringify(allLogs.slice(-6))}`,
    );
    assert.ok(allLogs.some((l) => l.includes("drain complete")));
  });
});
