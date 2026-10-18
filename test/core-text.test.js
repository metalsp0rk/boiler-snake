const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeTitle, joinCapped } = require("../src/core/text");

describe("normalizeTitle (gork memory title key)", () => {
  it("trims, collapses whitespace runs to single spaces, and lowercases", () => {
    assert.equal(normalizeTitle("Loves Rust "), "loves rust");
    assert.equal(normalizeTitle("  LoVeS   \t\r RuSt  "), "loves rust");
    assert.equal(normalizeTitle("loves\t\tmulti\nline   rust"), "loves multi line rust");
  });

  it("strips wrapping punctuation from both ends (unicode-aware)", () => {
    assert.equal(normalizeTitle("**Loves Rust!!**"), "loves rust");
    assert.equal(normalizeTitle('"quoted rust"'), "quoted rust");
    assert.equal(normalizeTitle("...rust?!"), "rust");
    assert.equal(normalizeTitle("🎯 loves rust 💪"), "loves rust");
    assert.equal(normalizeTitle("Über die Rust!"), "über die rust");
  });

  it("keeps inner punctuation, digits, and decimal points", () => {
    assert.equal(
      normalizeTitle("Rust 1.85 — my (current) project!"),
      "rust 1.85 — my (current) project"
    );
  });

  it("returns '' when nothing survives (empty / nullish / punctuation-only)", () => {
    assert.equal(normalizeTitle(""), "");
    assert.equal(normalizeTitle(null), "");
    assert.equal(normalizeTitle(undefined), "");
    assert.equal(normalizeTitle("   "), "");
    assert.equal(normalizeTitle("!!! ... ???"), "");
    assert.equal(normalizeTitle("——— ‽"), "");
  });

  it("caps at 80 code units without splitting a surrogate pair", () => {
    assert.equal(normalizeTitle("a".repeat(100)), "a".repeat(80));
    // 41 𝐀 (astral LETTER, 2 code units each) = 82 units; the 80-unit cut
    // must land between whole surrogate pairs (sliceSafe, never 79/81).
    const letter = "\u{1D400}";
    assert.equal(normalizeTitle(letter.repeat(41)), letter.repeat(40));
    assert.equal(normalizeTitle(letter.repeat(41)).length, 80);
  });

  it("treats a pure-emoji title as punctuation-only (empty key)", () => {
    // emoji are neither \p{L} nor \p{N}, so a title of only emoji is fully
    // stripped by the wrapping-punctuation pass → upstream drops the entry
    assert.equal(normalizeTitle("🦀".repeat(3)), "");
  });

  it("stringifies non-string inputs (digits and letters survive)", () => {
    assert.equal(normalizeTitle(42), "42");
    assert.equal(normalizeTitle(false), "false");
    assert.equal(normalizeTitle({ toString: () => "  Title Case  " }), "title case");
  });
});

// ── #446 (audit INT-11): the shared list cap ──────────────────────────────

describe("joinCapped (#446 staff-list cap)", () => {
  const lines = (n, len = 8) =>
    Array.from({ length: n }, (_, i) => `line-${i}-${"x".repeat(len)}`);

  it("returns the plain join when everything fits (no suffix)", () => {
    assert.equal(joinCapped(["a", "b", "c"], 100), "a, b, c");
    assert.equal(joinCapped(["a", "b"], 100, "\n"), "a\nb");
    assert.equal(joinCapped([], 100), "", "empty list → empty string");
    assert.equal(
      joinCapped(["ab", "cd"], "ab, cd".length),
      "ab, cd",
      "exact-fit boundary joins verbatim",
    );
  });

  it("caps with an EXACT hidden count, keeps order, stays under the limit", () => {
    const ls = lines(300);
    const out = joinCapped(ls, 500, "\n");
    assert.ok(out.length <= 500, `observed ${out.length}`);
    const m = out.match(/\n\(\+(\d+) more\)$/);
    assert.ok(m, `suffix with count required: …${out.slice(-40)}`);
    const shown = ls.length - Number(m[1]);
    assert.ok(shown > 0 && shown < ls.length);
    const kept = out.slice(0, out.lastIndexOf("\n(+")).split("\n");
    assert.deepEqual(kept, ls.slice(0, shown), "first N lines verbatim, in order");
  });

  it("a single pathological line is sliced, not dropped", () => {
    const out = joinCapped(["x".repeat(3000)], 1024);
    assert.ok(out.length <= 1024 && out.startsWith("xxx"), out.slice(0, 8));
  });

  it("pathological first line plus others never exceeds the hard ceiling", () => {
    const out = joinCapped(["y".repeat(1500), ...lines(10)], 1000, "\n");
    assert.ok(out.length <= 1000, `observed ${out.length}`);
  });

  it("astral-boundary slicing never emits lone surrogates", () => {
    const out = joinCapped(["🎮".repeat(700)], 1024); // 1400 UTF-16 units > cap
    assert.ok(out.length <= 1024);
    for (let i = 0; i < out.length; i++) {
      const c = out.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const n = out.charCodeAt(i + 1);
        assert.ok(n >= 0xdc00 && n <= 0xdfff, `lone high surrogate at ${i}`);
        i++;
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        assert.fail(`lone low surrogate at ${i}`);
      }
    }
  });
});
