/**
 * CSRF protection (roadmap/web-admin.md §8.7): a per-session token derived as
 * HMAC(HMAC(SESSION_SECRET, scope), sessionId) — NO extra storage anywhere,
 * and the token rotates automatically when the session id rotates on login
 * (§8.3), because it is a pure function of the session id.
 *
 * Double-submit semantics (session-synchronized variant):
 *  - the COOKIE side is the httpOnly `web_session` cookie itself — a
 *    cross-site attacker can have the browser SEND it but can never READ
 *    it, so it can never compute the matching token;
 *  - the SUBMITTED side is read from the `X-CSRF-Token` header (htmx) or the
 *    `_csrf` form field and must equal the derived token;
 *  - equality is compared with crypto.timingSafeEqual over fixed-length hex
 *    (§8.7: no timing-unsafe comparisons for tokens).
 *
 * Enforcement scope (activated per REQUEST, not per mount):
 *  - automatic for every non-GET/HEAD/OPTIONS request whose path is under
 *    /g/ or /auth/ (the design's mutation surfaces, §8.6 cross-cutting rule);
 *  - `req.requireCsrf` (attached by the middleware) and createRequireCsrf()
 *    (standalone factory) are the per-route wiring helpers for mutation
 *    routes OUTSIDE that scope (Phases 1–3);
 *  - requests WITHOUT a live session pass through untouched — anonymous
 *    mutation endpoints (login start, OAuth callback) are gated by their own
 *    defenses instead: per-IP rate limits (middleware/rateLimit.js) plus the
 *    purpose-tagged OAuth state token (subtask 06).
 *
 * Activation note: app.js still answers every non-GET with 405 at its Phase
 * 0a methodGate; this middleware deliberately mounts BEHIND it and depends
 * on nothing there. It starts enforcing the moment routes accept POST (the
 * /auth/logout exception and the /auth/* login routes land in subtask 06).
 */

const crypto = require("crypto");
const { getSessionSecret, getRateLimitConfig } = require("../config");

/** Header the htmx front end sends (§8.7: "form + X-CSRF-Token for htmx"). */
const CSRF_HEADER = "x-csrf-token";
/** Hidden form field name for plain <form method=post> posts. */
const CSRF_FORM_FIELD = "_csrf";
/** Methods that must never mutate state — never token-checked. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Derived tokens are lowercase HMAC-SHA256 hex (64 chars). */
const TOKEN_HEX_RE = /^[0-9a-f]{64}$/i;
/** Key-scope label so the session-adjacent HMAC key is never reused raw. */
const TOKEN_KEY_SCOPE = "web-admin:csrf-token:v1";

/**
 * Session-independent signing key, derived from the shared secret. Computed
 * per call (two HMAC ops — negligible) and NEVER cached: a cache keyed by
 * the secret string would keep raw secret material in memory (§8.7).
 * @param {string} secret
 * @returns {Buffer}
 */
function csrfSigningKey(secret) {
  return crypto.createHmac("sha256", secret).update(TOKEN_KEY_SCOPE).digest();
}

/**
 * Deterministic CSRF token for a session: HMAC(signingKey, sessionId).
 * null when either input is missing (callers fail CLOSED on null).
 * @param {string|null} sessionId
 * @param {string|null} secret
 * @returns {string|null} lowercase hex token
 */
function deriveCsrfToken(sessionId, secret) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (typeof secret !== "string" || secret.length === 0) return null;
  return crypto
    .createHmac("sha256", csrfSigningKey(secret))
    .update(sessionId)
    .digest("hex");
}

/**
 * Timing-safe token comparison (§8.7). Shape-gates the candidate first
 * (fixed-length lowercase hex) so timingSafeEqual only ever sees
 * equal-length buffers; anything else is rejected without comparing.
 * @param {string} expectedHex
 * @param {unknown} provided
 * @returns {boolean}
 */
function tokenMatches(expectedHex, provided) {
  if (typeof provided !== "string") return false;
  const candidate = provided.trim().toLowerCase();
  if (!TOKEN_HEX_RE.test(candidate)) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(candidate, "hex"),
      Buffer.from(expectedHex, "hex")
    );
  } catch {
    return false;
  }
}

/**
 * Generic 403 — the body never says which check failed or what was expected
 * (§8.7 generic bodies; matches the app's text/plain response style).
 * @param {import("http").ServerResponse} res
 */
function denyForbidden(res) {
  res.writeHead(403, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end("Forbidden");
}

/**
 * Default protected scope (§8.6): everything under /g/ or /auth/.
 * @param {string} pathname
 * @returns {boolean}
 */
function defaultIsProtectedPath(pathname) {
  return (
    pathname === "/g" ||
    pathname.startsWith("/g/") ||
    pathname === "/auth" ||
    pathname.startsWith("/auth/")
  );
}

/**
 * Full request path including the Express mount prefix (raw URL fallback for
 * standalone/req-fake use). Never percent-decodes (matches the raw-URL
 * doctrine in routes/transcripts.js).
 * @param {import("http").IncomingMessage & { path?: string, baseUrl?: string }} req
 * @returns {string}
 */
function requestPath(req) {
  const raw =
    typeof req.path === "string" && req.path
      ? req.path
      : new URL(req.url || "/", "http://internal.invalid").pathname;
  return req.baseUrl ? req.baseUrl + raw : raw;
}

/**
 * Parse urlencoded bytes into a plain object (URLSearchParams semantics —
 * no qs nesting; v5 body-parser parity is `extended: false`).
 * @param {Buffer} rawBuf
 * @returns {Record<string, string>}
 */
function formFields(rawBuf) {
  try {
    return Object.fromEntries(new URLSearchParams(rawBuf.toString("utf8")));
  } catch {
    return {};
  }
}

/**
 * Read the token from already-prepared request state, if any:
 * header → parsed body (`req.body` / `req.bodyFields` set by an earlier
 * middleware) → drained raw body (`req.rawBody`).
 * @returns {string|null|undefined} string/null = authoritative, undefined =
 *   body has not been read yet (caller may drain it)
 */
function preparedToken(req) {
  const header = req.headers && req.headers[CSRF_HEADER];
  if (typeof header === "string" && header.trim() !== "") return header;
  for (const source of [req.body, req.bodyFields]) {
    if (source && typeof source === "object") {
      // A parsed body is authoritative: absent field means absent token.
      const value = source[CSRF_FORM_FIELD];
      return typeof value === "string" ? value : null;
    }
  }
  if (Buffer.isBuffer(req.rawBody)) {
    return formFields(req.rawBody)[CSRF_FORM_FIELD] ?? null;
  }
  return undefined;
}

/**
 * Drain the request body up to maxBytes (double-submit form-token read when
 * no body middleware ran first). Never rejects; `tooLarge` means the cap was
 * crossed (the stream is destroyed and the response is answered 413).
 * @param {import("http").IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<{ tooLarge: boolean, buffer: Buffer|null }>}
 */
function drainRawBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        finish({ tooLarge: true, buffer: null });
        if (typeof req.destroy === "function") req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("error", () => finish({ tooLarge: false, buffer: null }));
    req.on("aborted", () => finish({ tooLarge: false, buffer: null }));
    req.on("end", () => finish({ tooLarge: false, buffer: Buffer.concat(chunks) }));
  });
}

/**
 * Deny with the same generic 413 the body-cap middleware emits (kept local
 * so the CSRF guard is standalone-mountable without rateLimit.js).
 * @param {import("http").ServerResponse} res
 */
function denyPayloadTooLarge(res) {
  res.writeHead(413, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end("Payload too large");
}

/**
 * Core guard middleware: verify-or-deny for a request that HAS a session.
 * Anonymous requests pass through (route-level gates own them, see header).
 * Shared by the app-level middleware and the per-route wiring helpers so the
 * semantics can never drift between mount styles.
 *
 * @param {{
 *   getSecret: () => string|null,
 *   getSessionId: (req: any) => string|null,
 *   maxBodyBytes: number,
 * }} deps
 * @returns {(req: any, res: import("http").ServerResponse, next: (err?: unknown) => void) => void}
 */
function createCsrfGuard({ getSecret, getSessionId, maxBodyBytes }) {
  return function csrfGuard(req, res, next) {
    const sessionId = getSessionId(req);
    if (!sessionId) return next();

    const expected = deriveCsrfToken(sessionId, getSecret());
    if (!expected) return denyForbidden(res); // secret unavailable → fail closed

    const finish = (token) =>
      tokenMatches(expected, token) ? next() : denyForbidden(res);

    const prepared = preparedToken(req);
    if (prepared !== undefined) return finish(prepared);

    if (typeof req.on !== "function" || req.readableEnded) {
      return finish(null); // token required but body unreadable → missing
    }

    drainRawBody(req, maxBodyBytes).then(({ tooLarge, buffer }) => {
      if (tooLarge) return denyPayloadTooLarge(res);
      req.rawBody = buffer || Buffer.alloc(0);
      req.bodyFields = formFields(req.rawBody);
      if (req.body === undefined) req.body = req.bodyFields;
      return finish(req.bodyFields[CSRF_FORM_FIELD] ?? null);
    }).catch(() => denyForbidden(res)); // defensive: never a dangling request
    return undefined;
  };
}

/**
 * App-level CSRF middleware factory (pure: all deps injectable, standalone
 * testable). Mount globally AFTER the session middleware (which sets
 * req.webSession). On every request it attaches:
 *  - `req.csrfToken` — the token views/htmx must embed (null for anonymous
 *    or unconfigured secret), and
 *  - `req.requireCsrf` — the same guard, for per-route opt-in outside the
 *    automatic /g/ + /auth/ scope.
 *
 * @param {{
 *   getSecret?: () => string|null,
 *   getSessionId?: (req: any) => string|null,
 *   isProtectedPath?: (pathname: string) => boolean,
 *   maxBodyBytes?: number,
 * }} [options]
 */
function createCsrfMiddleware(options = {}) {
  const getSecret = options.getSecret || (() => getSessionSecret());
  const getSessionId =
    options.getSessionId || ((req) => (req.webSession ? req.webSession.id : null));
  const isProtectedPath =
    options.isProtectedPath || defaultIsProtectedPath;
  const maxBodyBytes =
    options.maxBodyBytes ?? getRateLimitConfig().maxBodyBytes;

  const guard = createCsrfGuard({ getSecret, getSessionId, maxBodyBytes });

  return function csrfMiddleware(req, res, next) {
    req.requireCsrf = guard;
    const sessionId = getSessionId(req);
    req.csrfToken = sessionId ? deriveCsrfToken(sessionId, getSecret()) : null;

    if (SAFE_METHODS.has(req.method)) return next();
    if (!isProtectedPath(requestPath(req))) return next();
    return guard(req, res, next);
  };
}

/**
 * Standalone per-route CSRF guard (the "requireCsrf" wiring helper for
 * Phase 1–3 mutation routes outside the automatic scope):
 *   app.post("/somewhere", createRequireCsrf(), handler)
 * Same session/secret defaults as createCsrfMiddleware; anonymous requests
 * pass (the mount point is always safe when a session exists instead).
 *
 * @param {{
 *   getSecret?: () => string|null,
 *   getSessionId?: (req: any) => string|null,
 *   maxBodyBytes?: number,
 * }} [options]
 */
function createRequireCsrf(options = {}) {
  const getSecret = options.getSecret || (() => getSessionSecret());
  const getSessionId =
    options.getSessionId || ((req) => (req.webSession ? req.webSession.id : null));
  const maxBodyBytes =
    options.maxBodyBytes ?? getRateLimitConfig().maxBodyBytes;
  return createCsrfGuard({ getSecret, getSessionId, maxBodyBytes });
}

module.exports = {
  CSRF_HEADER,
  CSRF_FORM_FIELD,
  SAFE_METHODS,
  deriveCsrfToken,
  tokenMatches,
  createCsrfMiddleware,
  createRequireCsrf,
};
