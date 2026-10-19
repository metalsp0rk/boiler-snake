/**
 * #470 (H1-8): the web view micro-framework is ONE implementation.
 *
 * The audit found flashFromQuery ×6 (3 bodies), flashBanner ×6 (4 bodies),
 * respondGenericNotFound ×3, num ×3, formatAge ×4, formatTs ×3 — "every copy
 * drifted", so the same timestamp rendered differently per page and every
 * flash tweak needed six edits. The fix single-sourced them; this scan pins
 * that the private copies STAY dead (same source-scan doctrine as
 * test/env-parity.test.js).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const VIEWS = path.join(__dirname, "..", "src", "web", "views");
const WEB = path.join(__dirname, "..", "src", "web");

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "vendor" || e.name === "node_modules" || e.name === "dist") continue;
      out.push(...jsFiles(p));
    } else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

describe("#470 (H1-8): shared view helpers", () => {
  const helpers = require("../src/web/views/_helpers");

  it("exports the canonical five", () => {
    for (const name of ["flashFromQuery", "flashBanner", "num", "formatAge", "formatTs"]) {
      assert.equal(typeof helpers[name], "function", `missing ${name}`);
    }
  });

  it("views do NOT re-declare the shared helpers (drift pin)", () => {
    const offenders = [];
    for (const file of jsFiles(VIEWS)) {
      if (path.basename(file) === "_helpers.js") continue;
      const src = fs.readFileSync(file, "utf8");
      // A local DECLARATION with real logic is a drift; a one-line BINDING
      // that delegates to the canonical function (page frozen tables pinned
      // into opts) is the sanctioned pattern — its exported one-arg shape is
      // contract for the routes and their byte-exact tests.
      const bodies = {};
      for (const name of ["flashFromQuery", "flashBanner", "num", "formatAge", "formatTs"]) {
        const m = src.match(new RegExp(`^function ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}`, "m"));
        if (m) bodies[name] = m[1];
      }
      for (const [name, body] of Object.entries(bodies)) {
        const delegates = /canonical(FlashFromQuery|FlashBanner)\(/.test(body);
        if (delegates && (name === "flashFromQuery" || name === "flashBanner")) continue;
        // settings' {kind,key} flashBanner is a DIFFERENT contract (flag+key
        // lookup) that predates the done/error-slug family — not a copy.
        if (name === "flashBanner" && file.includes("views/settings")) continue;
        offenders.push(`${path.relative(WEB, file)} re-implements ${name}`);
      }
    }
    assert.deepEqual(offenders, [], "shared helpers must be imported from views/_helpers.js");
  });

  it("respondGenericNotFound exists exactly once in src/web", () => {
    const defs = jsFiles(WEB)
      .filter(
        (f) =>
          path.basename(f) !== "genericNotFound.js" &&
          /function respondGenericNotFound\(/.test(fs.readFileSync(f, "utf8"))
      )
      .map((f) => path.relative(WEB, f));
    assert.deepEqual(defs, [], "the generic 404 lives in shared/genericNotFound.js only");
    const shared = require("../src/web/shared/genericNotFound");
    assert.equal(typeof shared.respondGenericNotFound, "function");
  });

  it("flash banner semantics hold the no-echo invariant (§8.7)", () => {
    const doneTable = Object.freeze({ saved: "Saved." });
    const errorTable = Object.freeze({ nope: "Nope." });
    // Junk slugs never render — dropped by the whitelist...
    assert.deepEqual(
      helpers.flashFromQuery({ done: "<script>", error: "hacked" }, { doneTable, errorTable }),
      { done: null, error: null }
    );
    // ...and the banner renders nothing for an unwhitelisted pair regardless.
    assert.equal(
      helpers.flashBanner({ done: "<script>", error: "hacked" }, { doneTable, errorTable })
        .toString(),
      ""
    );
    // Known error wins over known done (same as every historical copy).
    assert.match(
      helpers
        .flashBanner({ done: "saved", error: "nope" }, { doneTable, errorTable })
        .toString(),
      /Nope\./
    );
    // extraError vouches for a composite slug (syncAction's env pattern).
    assert.deepEqual(
      helpers.flashFromQuery(
        { error: "env_a+env_b" },
        { doneTable, errorTable, extraError: (raw) => (raw.startsWith("env_") ? raw : null) }
      ),
      { done: null, error: "env_a+env_b" }
    );
    // With extraBanner wired, an unknown error does NOT fall through to done.
    assert.equal(
      helpers
        .flashBanner(
          { done: "saved", error: "unknown" },
          { doneTable, errorTable, extraBanner: () => "" }
        )
        .toString(),
      ""
    );
    // Without it, the historical fall-through stands (unknown error → done).
    assert.match(
      helpers.flashBanner({ done: "saved", error: "unknown" }, { doneTable, errorTable }).toString(),
      /Saved\./
    );
  });
});
