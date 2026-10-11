/**
 * One-time deprecation warnings for the legacy root shims (audit issue #206).
 *
 * Contract under test (src/core/deprecation.js):
 * - first call per name logs exactly one line, format:
 *   `[deprecation] <name> is deprecated and will be removed in v2 — use <replacement>`
 *   and returns true;
 * - every later call for the same name is SILENT and returns false — even
 *   when the warned module itself is re-required (require-cache cleared):
 *   the once-per-process memory lives in the helper, not the shim;
 * - an end-to-end shim (src/xp.js, safe to require: core/xpMath only, no DB
 *   or network) warns on first require, exports the real API, and stays
 *   silent on re-require.
 *
 * Deterministic: no timers, no SQLite, no network, no env mutation.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { warnDeprecated } = require("../src/core/deprecation");

/** Swap console.warn for a collector for the duration of fn. */
function captureWarnings(fn) {
  const orig = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    const result = fn();
    return { lines, result };
  } finally {
    console.warn = orig;
  }
}

describe("core/deprecation warnDeprecated", () => {
  it("logs once per name with the exact message format, silent afterwards", () => {
    const first = captureWarnings(() =>
      warnDeprecated("src/deprecation-selftest.js", "src/core/something"),
    );
    assert.equal(first.result, true);
    assert.deepEqual(first.lines, [
      "[deprecation] src/deprecation-selftest.js is deprecated and will be removed in v2 — use src/core/something",
    ]);

    const second = captureWarnings(() =>
      warnDeprecated("src/deprecation-selftest.js", "src/core/something"),
    );
    assert.equal(second.result, false);
    assert.deepEqual(second.lines, []);
  });

  it("tracks names independently (two shims = two warnings)", () => {
    const { lines } = captureWarnings(() => {
      warnDeprecated("src/deprecation-a.js", "x");
      warnDeprecated("src/deprecation-b.js", "y");
      warnDeprecated("src/deprecation-a.js", "x");
    });
    assert.deepEqual(lines, [
      "[deprecation] src/deprecation-a.js is deprecated and will be removed in v2 — use x",
      "[deprecation] src/deprecation-b.js is deprecated and will be removed in v2 — use y",
    ]);
  });
});

describe("legacy shim end-to-end (src/xp.js)", () => {
  const shimPath = require.resolve("../src/xp.js");

  it("warns once on first require, exports the real API, silent on re-require", () => {
    // Fresh require of the shim (the internal module graph never imports it).
    const first = captureWarnings(() => require(shimPath));
    assert.deepEqual(first.lines, [
      "[deprecation] src/xp.js is deprecated and will be removed in v2 — use src/core/xpMath (levelFromXp)",
    ]);
    // The re-export still works: real levelFromXp, real math.
    assert.equal(typeof first.result.levelFromXp, "function");
    assert.equal(first.result.levelFromXp(400, 100), 2);

    // Re-require with a cold shim module but the SAME helper instance: the
    // shim body re-runs and re-calls warnDeprecated — must stay silent.
    delete require.cache[shimPath];
    const second = captureWarnings(() => require(shimPath));
    assert.deepEqual(second.lines, []);
    assert.equal(typeof second.result.levelFromXp, "function");

    // Leave the module cache in a sane state for any later require.
    delete require.cache[shimPath];
  });
});
