/**
 * #470 (H1-7): the byte-identical cross-feature helper clusters live in ONE
 * home now — core/{errors,env,embeds,secrets,timing,text} and
 * platform/community. The audit's census (toPlainEmbed ×4, describeError ×2,
 * envPositiveInt ×3, hideToken ×2, sleep ×2, snippet ×3, platformLabel ×3,
 * isCommunityRow ×2) meant a boundary fix landed in "whichever feature
 * tripped". These tests pin the SHARED copies' behavior and scan that the
 * promoted names do not silently regain local definitions.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

const { describeError } = require("../src/core/errors");
const { envPositiveInt } = require("../src/core/env");
const { toPlainEmbed } = require("../src/core/embeds");
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
});

describe("core/embeds toPlainEmbed", () => {
  it("serializes toJSON-carriers, passes plain values through", () => {
    assert.deepEqual(toPlainEmbed({ toJSON: () => ({ a: 1 }) }), { a: 1 });
    const plain = { description: "x" };
    assert.equal(toPlainEmbed(plain), plain);
    assert.equal(toPlainEmbed(null), null);
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

  it("src/features declares none of the promoted names locally", () => {
    const offenders = [];
    for (const file of jsFiles(path.join(SRC, "features"))) {
      const src = fs.readFileSync(file, "utf8");
      for (const name of [
        "toPlainEmbed",
        "envPositiveInt",
        "hideToken",
        "snippet",
        "platformLabel",
        "isCommunityRow",
      ]) {
        if (new RegExp(`^function ${name}\\(`, "m").test(src)) {
          offenders.push(`${path.relative(SRC, file)} re-declares ${name}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("describeError/sleep stay single-purpose per home", () => {
    // describeError exists in core (display, THIS module) AND core/lifecycle
    // (stack logger, different contract by design). Feature copies must die.
    const featureCopies = jsFiles(path.join(SRC, "features")).filter((f) =>
      /^function (describeError|sleep)\(/m.test(fs.readFileSync(f, "utf8"))
    );
    assert.deepEqual(
      featureCopies.map((f) => path.relative(SRC, f)),
      // gork permsAllow-style DELIBERATE divergence lives in summarizeRange /
      // tools — those names are not in this list; describeError/sleep had zero
      // semantic divergence, so no feature may keep a copy.
      [],
      "identical clusters were promoted; a new local copy needs a reason"
    );
  });
});
