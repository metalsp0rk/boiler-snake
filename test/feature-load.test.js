const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  registerAllFeatureEvents,
  startAllFeatures,
} = require("../src/features/load");

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
