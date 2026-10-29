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
 * THE style-src 'unsafe-inline' CONCESSION (deliberate, tracked): the
 * frozen transcript export (src/features/tickets/transcript.js) inlines one
 * <style> element so the file opens offline. Script execution does NOT get
 * the same concession: only 'self' + an exact per-response nonce, so no
 * injected markup can run JS (§8.1-2: templates stay CSP-safe without
 * unsafe-eval/unsafe-hashes). Console views put CSS in /static — do not
 * add inline style attributes to new views unless unavoidable.
 *
 * font-src is omitted on the console, so it falls back to default-src
 * 'self'. Data-URI fonts are blocked there on purpose (the forge bundle
 * serves font files). The raw transcript response is the exception: its
 * writeHead sets font-src 'self' data: so the served export loads the same
 * embedded faces an offline open does. Do not set that globally.
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
 * Console policy. `embedFonts` adds font-src data: for the raw transcript
 * export only. The default string is the console policy.
 * @param {string} nonce
 * @param {{ embedFonts?: boolean }} [options]
 * @returns {string}
 */
function contentSecurityPolicy(nonce, { embedFonts = false } = {}) {
  const directives = [
    "default-src 'self'",
    // §8.15-15.11 profile-card avatars come from Discord's CDN — this
    // is the ONLY cross-origin asset the console loads; the endpoint
    // hands out URLs we construct/validate ourselves, and img cannot
    // read data back.
    "img-src 'self' https://cdn.discordapp.com",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'", // see header comment — tracked concession
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ];
  if (embedFonts) directives.push("font-src 'self' data:");
  return directives.join("; ");
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

    res.setHeader("Content-Security-Policy", contentSecurityPolicy(nonce));
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
  contentSecurityPolicy,
  NONCE_BYTES,
  isAuthSurface,
};
