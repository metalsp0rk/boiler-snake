const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  registerAllFeatureEvents,
  startAllFeatures,
} = require("../src/features/load");
const lifecycle = require("../src/core/lifecycle");

/** Run fn with console.error captured; returns { result, logs }. */
function withCapturedErrors(fn) {
  const orig = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));
  try {
    return { result: fn(), logs };
  } finally {
    console.error = orig;
  }
}

describe("feature boot hook isolation", () => {
  it("calls each present hook with client and ctx", () => {
    const calls = [];
    const client = { tag: "client" };
    const ctx = { tag: "ctx" };
    const features = [
      { name: "a", registerEvents: (c, x) => calls.push(["a", c, x]) },
      { name: "b", start: (c, x) => calls.push(["b", c, x]) },
      { name: "c" },
    ];

    const { result: r1 } = withCapturedErrors(() =>
      registerAllFeatureEvents(client, features, ctx)
    );
    const { result: r2 } = withCapturedErrors(() =>
      startAllFeatures(client, features, ctx)
    );

    assert.deepEqual(r1, []);
    assert.deepEqual(r2, []);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][1], client);
    assert.equal(calls[0][2], ctx);
  });

  it("a throwing hook does not stop later features and is reported", () => {
    const started = [];
    const features = [
      {
        name: "bad",
        registerEvents: () => {
          throw new Error("boom");
        },
      },
      { name: "good", registerEvents: () => started.push("good") },
    ];

    const { result, logs } = withCapturedErrors(() =>
      registerAllFeatureEvents({}, features, {})
    );

    assert.deepEqual(started, ["good"], "later features still boot");
    assert.deepEqual(result, ["bad.registerEvents"]);
    assert.ok(
      logs.some((l) => l.includes("[features] bad.registerEvents failed:") && l.includes("boom")),
      "log names the feature, hook, and cause"
    );
    assert.ok(logs.some((l) => l.includes("degraded features")));
  });

  it("start hook failures are isolated the same way", () => {
    const features = [
      {
        name: "ticker",
        start: () => {
          throw new Error("no port");
        },
      },
    ];

    const { result, logs } = withCapturedErrors(() =>
      startAllFeatures({}, features, {})
    );

    assert.deepEqual(result, ["ticker.start"]);
    assert.ok(logs.some((l) => l.includes("ticker.start failed:") && l.includes("no port")));
  });
});

describe("#390 (A2-4): partial-start cleanup + honest handle keys", () => {
  it("a hook that throws after registerStop releases exactly what it took (LIFO)", () => {
    lifecycle.resetForTests();
    const stops = [];
    const features = [
      {
        name: "halfway",
        start: (_sup, _ctx, registerStop) => {
          registerStop(() => stops.push("first"));
          registerStop(() => stops.push("second"));
          throw new Error("blew up after binding");
        },
      },
    ];

    const { logs } = withCapturedErrors(() => startAllFeatures({}, features, {}));

    assert.deepEqual(
      stops,
      ["second", "first"],
      "uncommitted resources are stopped LIFO by load.js (pre-#390: they leaked un-stopped)",
    );
    assert.deepEqual(
      lifecycle.shutdownHandleNames(),
      [],
      "nothing un-stopped lingers in the drain (drain complete no longer lies)",
    );
    assert.ok(
      logs.some((l) => l.includes("blew up after binding")),
      "the ORIGINAL error still lands first",
    );
    lifecycle.resetForTests();
  });

  it("a failing partial-stop is logged per item and never masks the hook error", () => {
    lifecycle.resetForTests();
    const stops = [];
    const features = [
      {
        name: "stubby",
        start: (_sup, _ctx, registerStop) => {
          registerStop(() => stops.push("first"));
          registerStop(() => {
            throw new Error("stuck socket");
          });
          throw new Error("hook boom");
        },
      },
    ];

    const { logs } = withCapturedErrors(() => startAllFeatures({}, features, {}));

    assert.deepEqual(stops, ["first"], "the rest of the teardown runs despite one stuck stop");
    assert.ok(
      logs.some((l) => l.includes("partial-stop failed") && l.includes("stuck socket")),
      "the stuck resource is named, not swallowed",
    );
    assert.ok(logs.some((l) => l.includes("hook boom")), "the hook error still leads");
    lifecycle.resetForTests();
  });

  it("seam handles commit on a clean return; keys carry feature+index+hook", () => {
    lifecycle.resetForTests();
    const features = [
      {
        name: "loop",
        start: (_s, _c, registerStop) => {
          registerStop(() => {});
          return { stop: () => {} };
        },
      },
      { start: () => ({ stop: () => {} }) }, // no name at all
    ];

    startAllFeatures({}, features, {});

    assert.deepEqual(
      lifecycle.shutdownHandleNames(),
      ["feature:loop#0:start", "feature:loop#0:start#1", "feature:unknown#1:start"],
      "seam slot + returned handle under a hook-scoped key; the nameless feature gets its OWN key (index)",
    );
    lifecycle.resetForTests();
  });

  it("a start handle can no longer REPLACE the same feature's registerEvents handle", () => {
    lifecycle.resetForTests();
    const features = [
      {
        name: "dual",
        registerEvents: () => ({ stop: () => {} }),
        start: () => ({ stop: () => {} }),
      },
    ];

    registerAllFeatureEvents({}, features, {});
    startAllFeatures({}, features, {});

    assert.deepEqual(
      lifecycle.shutdownHandleNames(),
      ["feature:dual#0:registerEvents", "feature:dual#0:start"],
      "both handles drain (pre-#390 the shared key silently delete-then-set away the events one)",
    );
    lifecycle.resetForTests();
  });

  it("registerStop rejects a non-function with a named complaint", () => {
    lifecycle.resetForTests();
    const features = [{ name: "careless", start: (_s, _c, registerStop) => registerStop(42) }];
    const { result, logs } = withCapturedErrors(() => startAllFeatures({}, features, {}));
    assert.deepEqual(result, ["careless.start"]);
    assert.ok(
      logs.some((l) => l.includes("registerStop(careless.start): stop function required")),
      "the misuse names feature + hook",
    );
    lifecycle.resetForTests();
  });
});
