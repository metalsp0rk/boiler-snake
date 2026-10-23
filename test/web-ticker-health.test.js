/**
 * tickerHealth REGISTRY unit tests — the #217 provider mechanism.
 *
 * The scheduler→registry bridge used to enumerate job names ONCE at web
 * boot; src/features/index.js puts `web` BEFORE `bridge`/`linking`, so the
 * live app rendered NO rows for bridge-relay / bridge-expiry /
 * bridge-relay-ttl / linking-code-expiry — issue #217's "relay worker row
 * on the ticker-health page" was unmet in production even though the bridge
 * backlog aggregate row (fa23540) shipped. Fix: snapshot-time SOURCE
 * PROVIDERS — the registry asks providers for [name, getter] pairs at every
 * snapshot, so late-registered jobs self-heal.
 */

const { describe, it, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const { loadDb } = require("./helpers/env");
const { cleanup: cleanupTempDb } = loadDb();
after(cleanupTempDb);

const {
  registerTickerHealthSource,
  registerTickerHealthProvider,
  snapshotTickerHealth,
  listTickerHealthNames,
  _clearTickerHealthForTests,
} = require("../src/web/data/tickerHealth");
const {
  registerSchedulerJobHealthSources,
} = require("../src/web/data/schedulerJobHealth");

/** Run fn with console.error captured. */
async function withErrorCapture(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    const result = await fn();
    return { lines, result };
  } finally {
    console.error = orig;
  }
}

describe("tickerHealth source providers (#217 late-job class)", () => {
  afterEach(() => _clearTickerHealthForTests());

  it("provider rows appear in every snapshot (evaluated at snapshot time)", async () => {
    let jobs = [["early-job", () => 1000]];
    registerTickerHealthProvider("jobs", () => jobs);
    let rows = await snapshotTickerHealth(2000);
    assert.deepEqual(rows.map((r) => r.name), ["early-job"]);

    // A job registered AFTER registration must show up with NO re-wiring:
    jobs = [...jobs, ["late-job", () => 1500]];
    rows = await snapshotTickerHealth(2000);
    assert.deepEqual(
      rows.map((r) => r.name),
      ["early-job", "late-job"],
      "late provider entry appears in the NEXT snapshot (the #217 self-heal)"
    );
  });

  it("static sources win name collisions; later provider duplicates dedup", async () => {
    registerTickerHealthSource("dup", () => ({ status: "ok", detail: "static" }));
    registerTickerHealthProvider("p1", () => [["dup", () => ({ status: "down" })]]);
    registerTickerHealthProvider("p2", () => [["dup", () => ({ status: "down" })]]);
    const rows = await snapshotTickerHealth(Date.now());
    assert.equal(rows.length, 1, "the name renders exactly once");
    assert.equal(rows[0].status, "ok", "static registration wins");
    assert.deepEqual(listTickerHealthNames(), ["dup"]);
  });

  it("a throwing provider is logged (fixed line) and skipped — other rows survive", async () => {
    registerTickerHealthSource("healthy", () => ({ status: "ok" }));
    registerTickerHealthProvider("boom", () => {
      throw new Error("provider-boom-secret-internals");
    });
    const { lines } = await withErrorCapture(async () => {
      const rows = await snapshotTickerHealth(Date.now());
      assert.deepEqual(
        rows.map((r) => r.name),
        ["healthy"],
        "the failing provider contributes no rows, the good rows survive"
      );
    });
    assert.equal(lines.length, 1, "one console.error line");
    assert.ok(lines[0].includes("[web]"), "namespaced like every other web log");
    assert.ok(lines[0].includes("boom"), "names the failing provider");
    assert.ok(
      !lines[0].includes("provider-boom-secret-internals"),
      "provider error TEXT never reaches the log line (fixed framing, §8.7 style)"
    );
  });

  it("junk provider results (non-array, null, non-pair entries) are skipped", async () => {
    registerTickerHealthProvider("nully", () => null);
    registerTickerHealthProvider("junk", () => "not-an-array");
    registerTickerHealthProvider("short-pairs", () => [["x"], [42, () => 1], () => 1]);
    const rows = await snapshotTickerHealth(Date.now());
    assert.equal(rows.length, 0, "nothing renders from junk providers");
    assert.deepEqual(listTickerHealthNames(), []);
  });

  it("provider registration is replace-per-name (double boot) with guarded unregister", async () => {
    const off1 = registerTickerHealthProvider("p", () => [["a", () => 1]]);
    const off2 = registerTickerHealthProvider("p", () => [["b", () => 1]]);
    let rows = await snapshotTickerHealth(Date.now());
    assert.deepEqual(
      rows.map((r) => r.name),
      ["b"],
      "second registration REPLACED the provider (double boot safe)"
    );

    off1(); // stale off — must not remove the newer provider
    rows = await snapshotTickerHealth(Date.now());
    assert.equal(rows.length, 1, "stale unregister is a no-op");

    off2();
    rows = await snapshotTickerHealth(Date.now());
    assert.equal(rows.length, 0, "current unregister removes the provider");
  });

  it("_clearTickerHealthForTests clears providers too", async () => {
    registerTickerHealthProvider("p", () => [["a", () => 1]]);
    assert.equal((await snapshotTickerHealth(Date.now())).length, 1);
    _clearTickerHealthForTests();
    assert.equal((await snapshotTickerHealth(Date.now())).length, 0);
  });
});

describe("scheduler→health bridge registers late jobs live (#217)", () => {
  afterEach(() => _clearTickerHealthForTests());

  it("jobs registered AFTER the bridge get rows without re-invoking it", async () => {
    // Faithful boot order (src/features/index.js): web boots while the
    // scheduler is EMPTY (gork/bridge/linking start later in the pass).
    // Stub schedulerApi — the bridge only ever calls listNames/getJob.
    const jobs = new Map();
    const schedulerApi = {
      listNames: () => [...jobs.keys()],
      getJob: (name) => jobs.get(name),
    };
    const off = registerSchedulerJobHealthSources(schedulerApi);
    try {
      assert.deepEqual(
        listTickerHealthNames(),
        [],
        "empty scheduler at web boot ⇒ empty registry"
      );

      // Bridge/linking start hooks land AFTERWARDS (the production order):
      jobs.set("bridge-relay", { intervalMs: 250, lastFinishedAt: 900 });
      jobs.set("linking-code-expiry", { intervalMs: 60_000 });

      const rows = await snapshotTickerHealth(1000);
      assert.deepEqual(
        rows.map((r) => r.name).sort(),
        ["bridge-relay", "linking-code-expiry"],
        "the bridge reads scheduler.listNames() at SNAPSHOT time — #217 self-heal"
      );
      const relay = rows.find((r) => r.name === "bridge-relay");
      assert.equal(relay.status, "ok", "fresh stamp derives ok through the live getter");
    } finally {
      off();
    }
    assert.deepEqual(listTickerHealthNames(), [], "unregister removes the provider");
  });
});
