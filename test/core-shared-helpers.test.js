/**
 * #470 (H1-7): the byte-identical cross-feature helper clusters live in ONE
 * home now — core/{errors,env,embeds,secrets,timing,text} and
 * platform/community. The audit's census (toPlainEmbed ×4, describeError ×2,
 * envPositiveInt ×3, hideToken ×2, sleep ×2, snippet ×3, platformLabel ×3,
 * isCommunityRow ×2) meant a boundary fix landed in "whichever feature
 * tripped". These tests pin the SHARED copies' behavior and scan that the
 * promoted names do not silently regain local definitions.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// #609: this file LOADS src modules whose require chain reaches src/db —
// connection.js opens DB_PATH at REQUIRE time, so bind a private temp DB
// BEFORE anything else loads. Concurrent node --test files sharing one
// ambient DB_PATH race mid-migration (the #470 G2-6 gork flake class).
const { loadDb } = require("./helpers/env");
const { cleanup: cleanupTempDb } = loadDb();
after(cleanupTempDb);

const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

const { describeError } = require("../src/core/errors");
const { envPositiveInt, envNonNegInt } = require("../src/core/env");
const { toPlainEmbed, assertEmbedBudget } = require("../src/core/embeds");
const { hideToken } = require("../src/core/secrets");
const { sleep } = require("../src/core/timing");
const { snippet } = require("../src/core/text");
const { platformLabel, isCommunityRow } = require("../src/platform/community");

describe("core/errors describeError (the github/helix flattener)", () => {
  it("names, codes and the one-level cause read as one line", () => {
    assert.equal(describeError(new TypeError("bad input")), "TypeError: bad input");
    const withCode = Object.assign(new Error("boom"), { code: 40014 });
    assert.equal(describeError(withCode), "Error (40014): boom");
    // code already inside the message must not double up
    assert.equal(
      describeError(Object.assign(new Error("boom 40014"), { code: 40014 })),
      "Error: boom 40014"
    );
    const caused = new Error("outer", { cause: Object.assign(new Error(""), { code: "ECONN" }) });
    assert.equal(describeError(caused), "Error: outer | cause: ECONN");
    assert.equal(describeError(null), "null");
  });
});

describe("core/env envPositiveInt", () => {
  it("floors positives and falls back on everything else", () => {
    process.env.__T470 = "7.9";
    assert.equal(envPositiveInt("__T470", 3), 7);
    process.env.__T470 = "0";
    assert.equal(envPositiveInt("__T470", 3), 3, "zero is not positive");
    process.env.__T470 = "-4";
    assert.equal(envPositiveInt("__T470", 3), 3);
    process.env.__T470 = "soon";
    assert.equal(envPositiveInt("__T470", 3), 3, "NaN must never win");
    delete process.env.__T470;
    assert.equal(envPositiveInt("__T470", 3), 3, "unset falls back");
  });

  it("#837 B2-2: blank is UNSET, never a sneaky zero; the env source is injectable", () => {
    process.env.__T470 = "   ";
    assert.equal(envPositiveInt("__T470", 3), 3, 'blank ("   ") is unset — Number(" ")===0 must not win');
    assert.equal(
      envPositiveInt("__T_KNOB", 9, { __T_KNOB: "12.7" }),
      12,
      "injectable env (the gork deadline math test seam gork's positiveIntIn copy used to own)",
    );
    assert.equal(envPositiveInt("__T_KNOB", 9, {}), 9, "injectable env: unset there does NOT consult process.env");
    delete process.env.__T470;
  });
});

describe("core/env envNonNegInt (#837 B2-2: gork's images.js copy, homed)", () => {
  it("0 is a real value, blank is unset, garbage falls back", () => {
    assert.equal(envNonNegInt("__T470N", 4, { __T470N: "0" }), 0, "0 disables vision — a MEANINGFUL value");
    assert.equal(envNonNegInt("__T470N", 4, { __T470N: "" }), 4, "FOO= is unset, not 'vision off' (the copy's bug)");
    assert.equal(envNonNegInt("__T470N", 4, { __T470N: "  " }), 4, "blank is unset");
    assert.equal(envNonNegInt("__T470N", 4, { __T470N: "-1" }), 4, "negative is not non-negative");
    assert.equal(envNonNegInt("__T470N", 4, { __T470N: "2.9" }), 2, "floors like its positive twin");
    assert.equal(envNonNegInt("__T470N", 4, {}), 4, "unset falls back");
    assert.equal(
      envPositiveInt("__T470N", 4, null),
      4,
      "null env source: knobNumber's null guard — reads nothing, falls back, never throws",
    );
    assert.equal(envNonNegInt("__T470N", 4, undefined), 4, "undefined env source likewise");
  });
});

describe("core/embeds toPlainEmbed", () => {
  it("serializes toJSON-carriers, passes plain values through", () => {
    assert.deepEqual(toPlainEmbed({ toJSON: () => ({ a: 1 }) }), { a: 1 });
    const plain = { description: "x" };
    assert.equal(toPlainEmbed(plain), plain);
    assert.equal(toPlainEmbed(null), null);
  });
});

describe("core/embeds assertEmbedBudget (#837 B2-7: the caps that lived nowhere)", () => {
  it("a compliant embed passes and reports its counted chars", () => {
    const res = assertEmbedBudget({ title: "T", description: "D".repeat(100), footer: { text: "f" } });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.totalChars, 102);
  });

  it("the ACROSS-EMBED total is the real cap (two legal embeds, one illegal message)", () => {
    const big = { description: "d".repeat(4096) };
    const res = assertEmbedBudget([big, { ...big }]);
    assert.equal(res.ok, false, "4096+4096 = 8192 > the 6000 TOTAL cap even though EACH embed is legal");
    assert.match(res.error, /6000 TOTAL/);
    assert.equal(assertEmbedBudget([{ description: "d".repeat(3000) }, { description: "d".repeat(2900) }]).ok, true, "5900 total rides");
  });

  it("per-field caps, the 25-field cap and the 10-embed cap all answer { ok:false, error }", () => {
    assert.match(assertEmbedBudget({ description: "d".repeat(4097) }).error, /description is 4097 chars \(cap 4096\)/);
    assert.match(assertEmbedBudget({ title: "t".repeat(257) }).error, /title is 257/);
    assert.match(
      assertEmbedBudget({ fields: Array.from({ length: 26 }, (_, i) => ({ name: `f${i}`, value: "v" })) }).error,
      /26 fields \(cap 25\)/,
    );
    assert.match(
      assertEmbedBudget({ fields: [{ name: "n".repeat(252), value: "v".repeat(1025) }] }).error,
      /field 1: name is 252.*field 1: value is 1025/,
    );
    assert.match(assertEmbedBudget(Array.from({ length: 11 }, () => ({ description: "x" }))).error, /11 embeds exceeds/);
  });

  it("never throws on junk: EmbedBuilder-style toJSON carriers ride through, garbage counts as zero", () => {
    const carrier = { toJSON: () => ({ title: "built", description: "by the builder" }) };
    assert.equal(assertEmbedBudget([carrier, null, "junk", 7]).ok, true, "carriers serialize, non-objects drop");
    assert.equal(assertEmbedBudget(undefined).ok, true, "no embeds = no violations (a bare content send is fine)");
  });
});

describe("core/secrets hideToken", () => {
  it("the token exists but never rides enumeration", () => {
    const handle = hideToken({ url: "w://x" }, "sup3r-s3cret");
    assert.equal(handle.token, "sup3r-s3cret");
    assert.deepEqual(Object.keys(handle), ["url"]);
    assert.ok(!JSON.stringify(handle).includes("sup3r"));
    handle.token = "swap"; // sloppy CJS does not throw on non-writable assignment…
    assert.equal(handle.token, "sup3r-s3cret", "…but the value is immutable all the same");
  });
});

describe("core/timing sleep", () => {
  it("resolves", async () => {
    const t0 = Date.now();
    await sleep(15);
    assert.ok(Date.now() - t0 >= 10);
  });

  it("#837 B2-3: {unref:true} still resolves (the relay's drain posture)", async () => {
    // The anchor timer is deliberate: an unref'd wait as the ONLY pending
    // work drains the event loop around it — on Node 22 that drains the
    // TEST RUNNER too ("Promise resolution is still pending but the event
    // loop has already resolved" kills the whole file). Same drain
    // semantics that make unref correct for the relay's SIGTERM path:
    // keep a ref'd hold while asserting the unref'd wait still waited.
    const anchor = setTimeout(() => {}, 50);
    const t0 = Date.now();
    await sleep(10, { unref: true });
    assert.ok(Date.now() - t0 >= 5, "an unref'd wait still waits — unref only lifts the keep-alive claim");
    clearTimeout(anchor);
  });
});

describe("core/text snippet", () => {
  it("collapses whitespace, caps at max with one ellipsis", () => {
    assert.equal(snippet("  hello \n world  "), "hello world");
    assert.equal(snippet("a".repeat(80)), "a".repeat(80), "exactly max is whole");
    // truncation keeps TOTAL width = max: 79 chars + the ellipsis
    assert.equal(snippet("a".repeat(81)), "a".repeat(79) + "\u2026");
    assert.equal(snippet("x".repeat(10), 5), "xxxx\u2026");
    assert.equal(snippet(null), "");
  });
});

describe("platform/community shared identity helpers", () => {
  it("platformLabel maps known platforms honestly", () => {
    assert.equal(platformLabel("discord"), "Discord");
    assert.equal(platformLabel("fluxer"), "Fluxer");
    assert.equal(platformLabel("matrix"), "matrix");
    assert.equal(platformLabel(undefined), "unknown");
  });

  it("isCommunityRow shape-gates", () => {
    assert.equal(isCommunityRow({ id: 1, platform: "discord", instanceKey: "discord" }), true);
    assert.equal(isCommunityRow({ id: 1.5, platform: "discord", instanceKey: "d" }), false);
    assert.equal(isCommunityRow({ id: 1, platform: "discord" }), false);
    assert.equal(isCommunityRow(null), false);
  });
});

describe("drift scan: promoted helpers keep ONE home", () => {
  function jsFiles(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "vendor" || e.name === "node_modules") continue;
        out.push(...jsFiles(p));
      } else if (e.name.endsWith(".js")) out.push(p);
    }
    return out;
  }

  // #837 (B2-3/B2-4): the scan used to walk ONLY src/features and only
  // match `^function NAME(`. web/ grew two `snippet` twins under exactly
  // that blind spot, and auditLog's inline `new Promise((r) => setTimeout(
  // ...))` sleeps were invisible to ANY name scan. The law now covers all of
  // src/, every function-valued declaration shape, and inline sleeps.
  const HOMES = {
    toPlainEmbed: ["core/embeds.js"],
    envPositiveInt: ["core/env.js"],
    envNonNegInt: ["core/env.js"],
    hideToken: ["core/secrets.js"],
    snippet: ["core/text.js"],
    platformLabel: ["platform/community.js"],
    isCommunityRow: ["platform/community.js"],
    // #829: permsAllow's two gork copies gated the SAME ViewChannel parity
    // law and diverged on exactly the line that matters — unified
    // fail-closed in core/permissions; a local copy is a DRIFT OFFENDER,
    // not a "deliberate divergence".
    permsAllow: ["core/permissions.js"],
    // #815: splitChunks promoted to core/text for the automod read-back.
    splitChunks: ["core/text.js"],
    // #837: sleep homed in core/timing (the relay's unref'd local copy died
    // when {unref:true} became expressible). describeError keeps TWO
    // documented homes by design — core/errors (display one-liner) and
    // core/lifecycle (stack logger, different contract). Anything else
    // declaring either is drift.
    sleep: ["core/timing.js"],
    describeError: ["core/errors.js", "core/lifecycle.js"],
  };

  /** Function-valued declarations only: `function NAME(` or NAME bound to a
   * function/arrow/object-literal RHS. Local VARIABLES holding text
   * (`const snippet = buildSnippet(entry)`) are not helper copies. */
  const declares = (src, name) =>
    new RegExp(
      `\\bfunction\\s+${name}\\s*\\(|\\b(?:const|let)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:function\\b|\\(|\\{)`
    ).test(src);

  it("all of src/ declares the promoted names ONLY in their homes (B2-4)", () => {
    const offenders = [];
    for (const file of jsFiles(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      const src = fs.readFileSync(file, "utf8");
      for (const [name, homes] of Object.entries(HOMES)) {
        if (homes.includes(rel)) continue;
        if (declares(src, name)) offenders.push(`${rel} re-declares ${name}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("no inline sleep copies anywhere outside core/timing (B2-3)", () => {
    const offenders = [];
    for (const file of jsFiles(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (rel === "core/timing.js") continue;
      const src = fs.readFileSync(file, "utf8");
      // the one-liner shape AND the relay's multi-line unref twin — both are
      // `sleep` wearing no name, which is why every name scan missed them
      if (/new Promise\(\s*\((?:r|resolve)\)\s*=>\s*\{?\s*(?:const t = )?setTimeout\(/.test(src)) {
        offenders.push(`${rel} hand-rolls a sleep instead of core/timing`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
