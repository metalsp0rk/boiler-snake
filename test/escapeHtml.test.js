const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// #452 (audit H1-5): five escapeHtml copies / four implementations lived in
// this repo; two escaped only 4 chars (no &#39;) — a latent attribute-
// injection foothold that the "just reuse the local helper" edit invites.
// Everything now imports the ONE core escaper.
const { escapeHtml } = require("../src/core/escapeHtml");

describe("core escapeHtml (#452)", () => {
  it("escapes all five HTML-significant characters", () => {
    assert.equal(
      escapeHtml(`&<>"'`),
      "&amp;&lt;&gt;&quot;&#39;",
      "the apostrophe MUST escape — the drifted copies died on this one",
    );
  });

  it("escapes & first (no double-encoding of its own escape)", () => {
    assert.equal(escapeHtml("&amp;"), "&amp;amp;");
  });

  it("nullish renders as empty string, not the word undefined", () => {
    assert.equal(escapeHtml(undefined), "");
    assert.equal(escapeHtml(null), "");
  });

  it("coerces non-strings", () => {
    assert.equal(escapeHtml(42), "42");
    assert.equal(escapeHtml([1, "<"]), "1,&lt;");
  });

  it("src/ defines escapeHtml EXACTLY once (the core module)", () => {
    const root = path.join(__dirname, "..", "src");
    const defs = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".js")) {
          const src = fs.readFileSync(p, "utf8");
          if (/function\s+escapeHtml\b/.test(src)) defs.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    assert.deepEqual(
      defs,
      [path.join("core", "escapeHtml.js")],
      "no private escapeHtml may return — import core/escapeHtml instead",
    );
  });
});
