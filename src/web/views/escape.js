/**
 * Escaped-by-default template helpers for the web admin console views
 * (roadmap/web-admin.md §8.2: "views/ — layout, components,
 * escaped-by-default templates"; §8.7 CSP with no inline handlers).
 *
 * THE CONTRACT (memorize before writing a view):
 *  - `html` is a tagged template. EVERY interpolated value is HTML-escaped
 *    (& < > " ') unless it is a {@link SafeString} — markup produced by a
 *    previous `html` call or an explicit {@link raw}/{@link esc}.
 *  - Nesting is safe: `html` returns a SafeString, so fragments composed
 *    with `html` interpolate WITHOUT double-escaping.
 *  - `null`, `undefined` and `false` render as "" (plain falsy conditionals
 *    like `${cond ? html`…` : ""}` work).
 *  - Arrays render element-by-element through the same rules (list markup).
 *  - There is NO way to make `html` swallow markup inside an interpolated
 *    string: user data can never smuggle markup, attributes, or event
 *    handlers into the document (XSS probes are pinned in
 *    test/web-views-layout.test.js).
 *  - Quote-bearing CONSTANT markup snippets (e.g. `aria-current="page"`)
 *    must go through `raw('…')` — the escaper escapes quotes on purpose
 *    (one conservative escape set for text AND attribute positions).
 *
 * The single escape set (& < > " ') is deliberate: it is safe in PCDATA and
 * in double/single-quoted attribute positions, so view authors cannot pick
 * the wrong context-sensitive escaper by accident.
 */

/**
 * Brand for "already-escaped, safe to embed" markup. Extends String so it
 * interpolates/compares like a string everywhere while keeping an
 * unforgeable instanceof identity (a plain user string can never BE one).
 */
class SafeString extends String {}

/**
 * Escape the five HTML-significant characters. Chain of literal replaces —
 * no regex/class tricks to get wrong, & first so its own escape is not
 * double-encoded.
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** True when `value` is marked safe (html/raw/esc output), false otherwise. */
function isSafe(value) {
  return value instanceof SafeString;
}

/**
 * Explicitly mark ALREADY-TRUSTED markup as safe (own constants, external
 * renderers like the transcript HTML). NEVER wrap request/user data in this.
 * @param {unknown} value
 * @returns {SafeString}
 */
function raw(value) {
  return new SafeString(value == null ? "" : String(value));
}

/**
 * Escape a plain value once and mark the RESULT safe (idempotent:
 * esc(esc(x)) === esc(x) — safe when a value may pass through several
 * layers that each call esc()).
 * @param {unknown} value
 * @returns {SafeString}
 */
function esc(value) {
  if (isSafe(value)) return /** @type {SafeString} */ (value);
  return new SafeString(escapeHtml(value == null ? "" : value));
}

/**
 * Render one interpolated value under the escaped-by-default policy.
 * @param {unknown} value
 * @returns {string}
 */
function renderValue(value) {
  if (value == null || value === false) return "";
  if (isSafe(value)) return String(value);
  if (Array.isArray(value)) return value.map(renderValue).join("");
  return escapeHtml(value);
}

/**
 * Tagged template literal with escaped-by-default interpolation.
 *
 *   const row = html`<td>${guild.name}</td>`;            // escaped
 *   const table = html`<tbody>${rows.map(rowOf)}</tbody>`; // raw markup, nested safe
 *
 * @param {TemplateStringsArray | string[]} strings
 * @param {...unknown} values
 * @returns {SafeString}
 */
function html(strings, ...values) {
  const parts = [strings[0]];
  for (let i = 0; i < values.length; i += 1) {
    parts.push(renderValue(values[i]), strings[i + 1]);
  }
  return new SafeString(parts.join(""));
}

module.exports = {
  SafeString,
  escapeHtml,
  isSafe,
  raw,
  esc,
  html,
};
