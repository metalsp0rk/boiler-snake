/**
 * CSP + response-hardening middleware (roadmap/web-admin.md §8.7):
 *
 *   default-src 'self';
 *   script-src 'self' 'nonce-<per-response>';   ← no inline scripts/handlers
 *   style-src 'self' 'unsafe-inline';           ← documented concession
 *   object-src 'none'; base-uri 'self'; frame-ancestors 'none'
 *
 * + X-Content-Type-Options: nosniff globally (§8.7 "kept" — routes may still
 *   set it themselves; writeHead overrides the middleware value 1:1, no
 *   duplicates) and Referrer-Policy: no-referrer on the auth surfaces
 *   (/auth/*, /oauth/*) whose handler-set headers already follow it.
 *
 * THE style-src 'unsafe-inline' CONCESSION (deliberate, tracked): the legacy
 * transcript renderer (src/features/tickets/transcript.js) and the archive
 * index ship a per-page <style> block, and those pages must stay
 * byte-identical through Phase 0a's oracle net (test/web-http-net.test.js).
 * Extracting that CSS would change the transcript bytes, so style
 * inlining stays allowed app-wide for now. Script execution does NOT get
 * the same concession: only 'self' + an exact per-response nonce, so no
 * injected markup can run JS (§8.1-2: templates stay CSP-safe without
 * unsafe-eval/unsafe-hashes). New console markup puts CSS in
 * /static/styles.css — do not add inline style attributes to new views
 * unless unavoidable.
 *
 * The nonce is generated FRESH per response (never cached), attached to
 * res.locals.cspNonce for the view layer (views/layout.js puts it on every
 * <script> tag), and only ever appears in this header + that attribute.
 */

const crypto = require("crypto");

/** Nonce length: 128 bits of CSPRG, base64url (no padding, no '+/' chars). */
const NONCE_BYTES = 16;

/** Paths whose responses carry Referrer-Policy: no-referrer (§8.7). */
function isAuthSurface(pathname) {
  return (
    pathname === "/auth" ||
    pathname.startsWith("/auth/") ||
    pathname === "/oauth" ||
    pathname.startsWith("/oauth/")
  );
}

/**
 * @param {object} [options]
 * @param {() => string} [options.generateNonce] override (tests)
 * @returns {(req: any, res: import("http").ServerResponse, next: () => void) => void}
 */
function createCspMiddleware({ generateNonce } = {}) {
  const newNonce =
    generateNonce ||
    (() => crypto.randomBytes(NONCE_BYTES).toString("base64url"));

  return function cspMiddleware(req, res, next) {
    const nonce = newNonce();
    res.locals = res.locals || {};
    res.locals.cspNonce = nonce;

    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}'`,
        "style-src 'self' 'unsafe-inline'", // see header comment — tracked concession
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join("; ")
    );
    // Global nosniff (§8.7). Handlers that writeHead it themselves (the
    // /t surface does) simply restate the same value.
    res.setHeader("X-Content-Type-Options", "nosniff");

    const rawPath = String(req.url || "/").split("?")[0];
    if (isAuthSurface(rawPath)) {
      res.setHeader("Referrer-Policy", "no-referrer");
    }

    next();
  };
}

module.exports = {
  createCspMiddleware,
  NONCE_BYTES,
  isAuthSurface,
};
