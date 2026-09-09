/**
 * Code-point-safe text helpers (roadmap/gork.md §7.15 Fix 4).
 *
 * JS string indices count UTF-16 code units, so slicing at an arbitrary
 * index can split an astral character (any emoji, many scripts) into two
 * lone surrogates — the source of the reported mojibake when gork answers
 * are chunked or truncated. These helpers pull a cut index back off a
 * surrogate-pair split so every piece stays valid UTF-16.
 */

/**
 * Is the code unit at `index` a high (leading) surrogate?
 * @param {string} s
 * @param {number} index
 * @returns {boolean}
 */
function isHighSurrogateAt(s, index) {
  if (index < 0 || index >= s.length) return false;
  const code = s.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Is the code unit at `index` a low (trailing) surrogate?
 * @param {string} s
 * @param {number} index
 * @returns {boolean}
 */
function isLowSurrogateAt(s, index) {
  if (index < 0 || index >= s.length) return false;
  const code = s.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Clamp a slice end so it never lands between the halves of a
 * surrogate pair. `end` clamped to [0, s.length]; moved back by one when
 * s[end-1..end] would split a pair.
 *
 * @param {string} s
 * @param {number} end desired exclusive end index (code units)
 * @returns {number} safe exclusive end index
 */
function safeCutIndex(s, end) {
  const str = s == null ? "" : String(s);
  let cut = Math.floor(Number(end));
  if (!Number.isFinite(cut)) return 0;
  if (cut <= 0) return 0;
  if (cut >= str.length) return str.length;
  if (isHighSurrogateAt(str, cut - 1) && isLowSurrogateAt(str, cut)) {
    return cut - 1;
  }
  return cut;
}

/**
 * Code-point-safe prefix slice: `s.slice(0, safeCutIndex(s, end))`.
 *
 * @param {string} s
 * @param {number} end desired max length in code units
 * @returns {string}
 */
function sliceSafe(s, end) {
  const str = s == null ? "" : String(s);
  return str.slice(0, safeCutIndex(str, end));
}

/**
 * Max code-unit length of a normalized title / title key (roadmap §7.16.1).
 */
const TITLE_KEY_MAX_LEN = 80;

/**
 * Wrapping punctuation strips for the title key. "Punctuation" here means
 * anything that is NOT a Unicode letter or number (\p{L}/\p{N}) — so ASCII
 * symbols, quotes, emoji, and full-width forms all count, and the strip is
 * only ever applied at the two ends (internal punctuation is kept).
 */
const LEADING_NON_LEADERS = /^[^\p{L}\p{N}]+/u;
const TRAILING_NON_LEADERS = /[^\p{L}\p{N}]+$/u;

/**
 * Canonicalize a model-written title into the collision key half of a
 * gork memory (roadmap §7.16.1): SQLite's BINARY collation is case- and
 * byte-sensitive, so "Loves Rust" and "loves rust  " must collapse into one
 * same-day upsert via this shared normalization.
 *
 * Pure: String(raw ?? "") → trim → collapse internal whitespace runs →
 * toLowerCase → strip wrapping punctuation from both ends → sliceSafe 80.
 * Returns "" when nothing survives.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeTitle(raw) {
  const collapsed = String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  const stripped = collapsed
    .replace(LEADING_NON_LEADERS, "")
    .replace(TRAILING_NON_LEADERS, "");
  return sliceSafe(stripped, TITLE_KEY_MAX_LEN);
}

module.exports = {
  isHighSurrogateAt,
  isLowSurrogateAt,
  safeCutIndex,
  sliceSafe,
  normalizeTitle,
};
