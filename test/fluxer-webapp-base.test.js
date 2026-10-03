/**
 * Pins for the Fluxer webapp-base wiring (PR #168 review, blocker B1):
 * `normalizeWebappBase` must be imported from the module that exports it.
 * The shipped regression destructured it from ./discovery — a module that
 * exports only discoverInstance/clearDiscoveryCache/WELL_KNOWN_PATH — so
 * the name arrived `undefined`, the call threw a TypeError inside the boot
 * try/catch, and every Fluxer jump link silently degraded to null. These
 * tests drive the exported seam (deriveWebappBaseUrl) directly: the helper
 * dereferences the import binding, so any future bad import throws here.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const client = require("../src/platform/fluxer/client");
const discovery = require("../src/platform/fluxer/discovery");
const jumpUrl = require("../src/core/jumpUrl");

describe("fluxer webapp base derivation (B1 pin)", () => {
  it("import integrity: normalizeWebappBase comes from core/jumpUrl, not discovery", () => {
    assert.equal(
      typeof jumpUrl.normalizeWebappBase,
      "function",
      "src/core/jumpUrl exports the normalizer",
    );
    assert.equal(
      discovery.normalizeWebappBase,
      undefined,
      "src/platform/fluxer/discovery never exported it — destructuring from here is the B1 regression",
    );
  });

  it("normalizes a well-formed endpoints.webapp from the discovery document", () => {
    assert.equal(
      client.deriveWebappBaseUrl(
        { document: { endpoints: { webapp: "https://chat.test/" } } },
        "https://chat.test",
      ),
      "https://chat.test",
    );
  });

  it("absent webapp → null, no warning (legit discovery without the field)", () => {
    const warnings = [];
    const orig = console.warn;
    console.warn = (...a) => warnings.push(a.join(" "));
    try {
      assert.equal(client.deriveWebappBaseUrl({ document: { endpoints: {} } }, "k"), null);
      assert.equal(client.deriveWebappBaseUrl(null, "k"), null);
      assert.equal(client.deriveWebappBaseUrl(undefined, "k"), null);
    } finally {
      console.warn = orig;
    }
    assert.deepEqual(warnings, [], "absent is not an error — no noise");
  });

  it("advertised-but-unusable webapp → null with a specific warning", () => {
    const warnings = [];
    const orig = console.warn;
    console.warn = (...a) => warnings.push(a.join(" "));
    try {
      assert.equal(
        client.deriveWebappBaseUrl(
          { document: { endpoints: { webapp: "not a url" } } },
          "https://chat.test",
        ),
        null,
      );
    } finally {
      console.warn = orig;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[fluxer\] https:\/\/chat\.test discovery exposed an unusable endpoints\.webapp/);
    assert.match(warnings[0], /jump links will be omitted/);
  });
});
