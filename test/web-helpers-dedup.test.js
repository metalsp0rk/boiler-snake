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

  it("#608: the promoted families live here too", () => {
    for (const name of ["channelRef", "section", "pagerFor"]) {
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

/**
 * #608: the next census tier — channelRef / section / pager families.
 *
 * Census verdict (the issue's step 1):
 *  - channelRef: integrations ≡ settings were byte-identical; voice differed
 *    ONLY in the zero-state string. Promoted with `missingHtml` — every
 *    page renders its historical bytes.
 *  - section: settings/integrations/voice differed only in the appended
 *    panel class and which opts they read. Promoted with `cls`; options a
 *    page never passed render empty fragments — byte-neutral by the same
 *    mechanism the old copies already relied on.
 *  - pager: moderation ≡ system (byte-identical markup, different filter
 *    vocabulary) → engine promoted as pagerFor, each page's pageHref stays
 *    page-side inside hrefFor. users' append-only pager (no prev, optional
 *    total) is NOT a twin — renamed pagerAppend with a census comment.
 *  - NOT promoted (same-name-different-contract, documented): pill ×3
 *    (state-pill / integ-pill / voice-pill vocabularies), pageHref ×3
 *    (per-page query shapes), leaderboard's pageHref/boardPager (query
 *    template, no <p class="pager">), tickets' <nav class="pager"> markup.
 */
describe("#608: promoted helper families", () => {
  const helpers = require("../src/web/views/_helpers");
  const { html } = require("../src/web/views/escape");

  it("views do NOT re-declare the promoted engine names (drift pin)", () => {
    const offenders = [];
    for (const file of jsFiles(VIEWS)) {
      if (path.basename(file) === "_helpers.js") continue;
      const src = fs.readFileSync(file, "utf8");
      for (const name of ["channelRef", "section", "pagerFor", "pager"]) {
        // Function-declaration copies are forbidden outright. const-binding
        // delegations are the sanctioned pattern (H1-8 doctrine) — pinned
        // to actually delegate to the promoted engine below.
        if (new RegExp(`^function ${name}\\(`, "m").test(src)) {
          offenders.push(`${path.relative(WEB, file)} declares function ${name}`);
        }
        const binding = src.match(new RegExp(`^const ${name} = ([\\s\\S]{0,200}?)\\n(?=\\S|\\n)`, "m"));
        if (binding) {
          const delegates = /sharedChannelRef\(|sharedSection\(|pagerFor\(/.test(binding[1]);
          if (!delegates) {
            offenders.push(`${path.relative(WEB, file)} binds ${name} WITHOUT delegating`);
          }
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "promoted engines live in views/_helpers.js; pages may only bind delegating one-liners"
    );
  });

  it("channelRef: id source-of-truth, cached name decorates, page-chosen zero-state", () => {
    // zero-state defaults to the settings/integrations wording…
    assert.match(helpers.channelRef(null).toString(), /not configured/);
    // …and voice passes its em-dash instead (documented copy difference).
    assert.equal(
      helpers.channelRef(null, null, html`<em class="muted">\u2014</em>`).toString().trim(),
      "<em class=\"muted\">\u2014</em>",
    );
    const decorated = helpers.channelRef("42", () => "general").toString();
    assert.match(decorated, /<code class="channel-id">42<\/code>/);
    assert.match(decorated, /\(general\)/);
    // no resolver ⇒ id alone (never fabricate a name)
    assert.doesNotMatch(helpers.channelRef("42").toString(), /channel-name/);
  });

  it("section: cls appends to the shared base, hint/notice render in order", () => {
    const bare = helpers.section("T", html`<p>b</p>`).toString();
    assert.match(bare, /class="panel settings-panel"/);
    // settings bytes: no cls → no trailing space in the class attribute
    assert.doesNotMatch(bare, /settings-panel "/);
    const full = helpers
      .section("T", html`<p id="body">b</p>`, {
        cls: "voice-panel",
        hint: "the hint",
        notice: "the notice",
      })
      .toString();
    assert.match(full, /class="panel settings-panel voice-panel"/);
    assert.ok(
      full.indexOf("setting-admin-hint") < full.indexOf("the notice"),
      `hint renders before notice, got: ${full}`,
    );
    assert.ok(full.indexOf("the notice") < full.indexOf('id="body"'), "notice renders before body");
    // voice-shaped call: notice without hint renders NO hint element (bytes)
    const noHint = helpers.section("T", html`b`, { cls: "x-panel", notice: "n" }).toString();
    assert.doesNotMatch(noHint, /setting-admin-hint/);
  });

  it("pagerFor: prev/next boundaries match both historical copies byte-wise", () => {
    const hrefFor = (o) => `/base?o=${o}`;
    const first = helpers
      .pagerFor({ hrefFor, offset: 0, pageSize: 10, total: 30, shown: 10 })
      .toString();
    assert.doesNotMatch(first, /pager-prev/);
    assert.match(first, /showing 1\u201310 of 30/);
    assert.match(first, /o=10/);
    const middle = helpers
      .pagerFor({ hrefFor, offset: 10, pageSize: 10, total: 30, shown: 10 })
      .toString();
    assert.match(middle, /o=0">\u2190 prev/);
    assert.match(middle, /o=20">next \u2192/);
    const last = helpers
      .pagerFor({ hrefFor, offset: 20, pageSize: 10, total: 30, shown: 10 })
      .toString();
    assert.doesNotMatch(last, /pager-next/);
    assert.match(last, /showing 21\u201330 of 30/);
    const empty = helpers
      .pagerFor({ hrefFor, offset: 0, pageSize: 10, total: 0, shown: 0 })
      .toString();
    assert.match(empty, /showing 0\u20130 of 0/);
    // moderation byte-exactness quirk: pageSize undefined → prev href carries
    // a NaN offset (the page's pageHref drops it) — the wrapper reproduces
    // the historical copy exactly; issue #621 owns the real fix.
    const offsets = [];
    helpers.pagerFor({
      hrefFor: (o) => {
        offsets.push(o);
        return "/x";
      },
      offset: 10,
      pageSize: undefined,
      total: 99,
      shown: 10,
    });
    assert.ok(
      offsets.some((o) => Number.isNaN(o)),
      `undefined pageSize feeds NaN through to the PREV href offset, as the old copy did (calls: ${JSON.stringify(offsets.map(String))})`,
    );
  });
});
