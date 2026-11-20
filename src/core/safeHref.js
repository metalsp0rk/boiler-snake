/**
 * #466 (C2-2): the render-time scheme gate for stored, member-influenced
 * hrefs (transcript attachment_urls are built from `a.url || a.proxyURL` —
 * attacker-influenced strings reaching two renderers: the frozen archive
 * builder and the live staff console page).
 *
 * The prior audit's §3 Web item, still open at round 2: both renderers
 * escaped the VALUE but never asked what it WAS. CSP caught the worst
 * cases (`javascript:` navigation, foreign `img-src`), but a clickable
 * phishing `<a href>` always slipped through — §4.1 demands validation AT
 * the HTML boundary, not faith in a downstream net.
 *
 * Allow-list (deliberately tiny):
 *  - absolute http(s) URLs (the CDN classes real attachments carry);
 *  - APP-relative paths (`/t/<tok>/assets/…`, `assets/…` — the transcript
 *    bundle's own media; a single-slash path can never leave this origin
 *    — the browser resolves it here, and traversal normalizes to a 404);
 *  - nothing else: `javascript:`, `data:`, `vbscript:`, weird schemes,
 *    scheme-casing/whitespace tricks and protocol-relative `//host` (the
 *    cross-origin shape) all return null — the CALLER decides how to
 *    render a refusal (both renderers drop to plain text: the name, never
 *    a link).
 */

/**
 * @param {unknown} href
 * @returns {string|null} the href when renderable, else null
 */
/**
 * #837 (B2-9): WHATWG URL resolution percent-decodes each path segment
 * BEFORE dot-segment removal — `/assets/%2e%2e/x` climbs toward the origin
 * root even though no segment LITERALLY reads `..` (verified). So the dot
 * check runs on BOTH spellings: a segment is refused when it is `.`/`..`
 * as stored OR as decoded. A segment whose percent-escapes are invalid
 * (`%zz`) refuses too: decodeURIComponent throwing means no honest
 * resolution exists, and no legitimate renderer needs one.
 *
 * @param {string} pathLike
 * @returns {boolean} true when no segment traverses in stored OR decoded form
 */
function segmentsAreDotFree(pathLike) {
  for (const raw of pathLike.split("/")) {
    if (raw === "." || raw === "..") return false;
    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return false;
    }
    if (decoded === "." || decoded === "..") return false;
  }
  return true;
}

function safeHref(href) {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  if (trimmed === "" || trimmed !== href) return trimmed === "" ? null : safeHref(trimmed);
  if (/^https?:\/\/\S+$/i.test(trimmed)) return trimmed;
  // App-relative: one leading slash (NOT `//` — that is protocol-relative
  // and leaves the origin), conservative path characters, and no `.`/`..`
  // segments (a stored traversal is at best a 404 and at worst an
  // audit-liar — the renderers never need one).
  if (/^\/(?!\/)[A-Za-z0-9._~+@!$&'()*,;=:/%-]+$/.test(trimmed)) {
    return segmentsAreDotFree(trimmed) ? trimmed : null;
  }
  if (/^assets\/[A-Za-z0-9._~+@!$&'()*,;=:/%-]+$/.test(trimmed)) {
    return segmentsAreDotFree(trimmed) ? trimmed : null;
  }
  return null;
}

module.exports = { safeHref };
