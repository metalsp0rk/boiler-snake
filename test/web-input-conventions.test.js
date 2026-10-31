"use strict";

/**
 * Text-input conventions gate (#790).
 *
 * Two invariants the console drifted on before:
 *  1. Every fuzzy typeahead (data-lookup) input must ALSO carry
 *     autocomplete="off" so the browser's autofill dropdown never stacks
 *     on top of our own suggestion list. The attributes now ship as ONE
 *     unit from views/_helpers#lookupAttrs(Mixed); views hand-writing
 *     data-lookup by hand is rejected here.
 *  2. Framework styling parity (forged-graphite): textareas and the
 *     .search-form search field have base paint rules OUTSIDE media
 *     queries (they used to render as bare UA white boxes), and the
 *     form-hosted lookup layout fix (flex-direction: row) exists.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { isSafe } = require("../src/web/views/escape");
const { lookupAttrs, lookupAttrsMixed } = require("../src/web/views/_helpers");

const VIEWS = path.join(__dirname, "..", "src/web/views");
const ASSETS = path.join(__dirname, "..", "src/web/assets");

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

// ── 1. The bundle emitters ──────────────────────────────────────────────────

test("lookupAttrs bundles the typeahead contract with autocomplete=off", () => {
  const out = lookupAttrs("channels", "/g/1/lookups/channels");
  assert.ok(isSafe(out), "bundle is a SafeString");
  // ORDER/ADJACENCY pinned: web-lookups.test.js asserts the rendered
  // `data-lookup="…" data-lookup-url="…"` substring.
  assert.equal(
    String(out),
    ' data-lookup="channels" data-lookup-url="/g/1/lookups/channels" autocomplete="off"'
  );
});

test("lookupAttrsMixed bundles both sources with autocomplete=off", () => {
  const out = lookupAttrsMixed("/g/1/lookups/users", "/g/1/lookups/roles");
  assert.ok(isSafe(out));
  assert.equal(
    String(out),
    ' data-lookup="mixed" data-lookup-users="/g/1/lookups/users" data-lookup-roles="/g/1/lookups/roles" autocomplete="off"'
  );
});

// ── 2. Views must not hand-write the lookup contract ────────────────────────

test("no view hand-writes data-lookup (goes through the helper bundle)", () => {
  const offenders = [];
  for (const file of walk(VIEWS)) {
    if (path.basename(file) === "_helpers.js") continue; // the ONE emitter
    const src = fs.readFileSync(file, "utf8");
    if (/data-lookup[=]/.test(src)) {
      offenders.push(path.relative(VIEWS, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "use lookupAttrs/lookupAttrsMixed from views/_helpers so autocomplete=off ships with the wiring"
  );
});

// ── 3. CSS structure (top-level rules, not media-query one-offs) ────────────

/**
 * Minimal CSS reader: yields { selectors, body, top } per rule. `top` is true
 * when the rule is NOT nested inside an at-rule block (@media etc.).
 * @param {string} css
 */
function readRules(css) {
  const rules = [];
  const stack = []; // at-rule keywords we are nested in
  let buf = "";
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 1;
      continue;
    }
    if (ch === "{") {
      const selector = buf.trim();
      buf = "";
      if (selector.startsWith("@")) {
        stack.push(selector.split(/\s+/)[0]);
        continue; // keep scanning INSIDE the at-rule body; depth tracks via }
      }
      // Leaf rule: find its matching "}", skipping comments.
      let depth = 1;
      let j = i + 1;
      for (; j < css.length && depth > 0; j++) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}") depth--;
        else if (css[j] === "/" && css[j + 1] === "*") {
          const end = css.indexOf("*/", j + 2);
          j = end === -1 ? css.length : end + 1;
        }
      }
      rules.push({
        selectors: selector.split(",").map((s) => s.trim()),
        body: css.slice(i + 1, j - 1).replace(/\/\*[\s\S]*?\*\//g, ""),
        top: stack.length === 0,
      });
      i = j - 1;
      continue;
    }
    if (ch === "}") {
      stack.pop(); // closes an at-rule (leaf "}"s were consumed above)
      buf = "";
      continue;
    }
    buf += ch;
  }
  return rules;
}

function topLevelRule(cssPath, selector) {
  const rules = readRules(fs.readFileSync(cssPath, "utf8")).filter(
    (r) => r.top && r.selectors.includes(selector)
  );
  assert.equal(rules.length, 1, `${path.basename(cssPath)} defines "${selector}" exactly once at top level`);
  return rules[0].body;
}

test("textareas get framework paint at top level (not a media-query one-off)", () => {
  const body = topLevelRule(path.join(ASSETS, "page.css"), ".integ-write-form textarea");
  for (const prop of ["border", "background", "color", "font"]) {
    assert.match(body, new RegExp(`(^|;)\\s*${prop}\\s*:`), `textarea rule declares ${prop}`);
  }
});

test(".search-form search field paints like the filter-form fields", () => {
  const body = topLevelRule(
    path.join(ASSETS, "page.css"),
    '.search-form input[type="search"]'
  );
  for (const prop of ["border", "background", "color", "padding"]) {
    assert.match(body, new RegExp(`(^|;)\\s*${prop}\\s*:`), `search field declares ${prop}`);
  }
});

test("form-hosted lookup hosts keep their row layout", () => {
  const css = path.join(ASSETS, "primitives.css");
  for (const selector of [
    ".search-form.lookup-host",
    ".archive-search.lookup-host",
    ".moderation .filter-form.lookup-host",
  ]) {
    const body = topLevelRule(css, selector);
    assert.match(body, /flex-direction:\s*row/, `${selector} stays a row`);
  }
});
