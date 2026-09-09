const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeTitle } = require("../src/core/text");

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
