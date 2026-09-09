/**
 * Fixed-window rate limiting + request body cap (roadmap/web-admin.md §8.7).
 *
 * Why in-memory: the bot is a single process (design §8.2) and the panel is
 * an admin surface. Buckets live in this process only and RESET on restart —
 * an ACCEPTED trade-off (restarts are operator-driven; the buckets are an
 * abuse brake, not the sole security boundary — authn/authz/CSRF are).
 *
 * Keying (§8.7):
 *  - auth endpoints (login + OAuth callback): per client IP AND per user
 *    (the user key applies once the identity is known — live session or the
 *    `req.rateLimitUserHint` the callback route sets mid-token-exchange);
 *  - mutations (all non-GET/HEAD/OPTIONS): per user, falling back to the IP
 *    bucket while anonymous (fail-safe: anonymous floods cannot skip limits);
 *  - IPs enter the bucket map only as SHA-256 hashes, so raw client
 *    addresses never linger in memory or logs; user ids are keys, and
 *    SECRET material is NEVER part of a key or logged anywhere here.
 *
 * Client IP = socket remote address UNLESS WEB_TRUST_PROXY is enabled, in
 * which case the FIRST X-Forwarded-For hop is trusted. Default off → behind
 * a reverse proxy without the flag, every visitor shares one bucket
 * (annoying but fail-safe); set WEB_TRUST_PROXY=1 when nginx/traefik fronts
 * the bot, and make the proxy set X-Forwarded-For.
 *
 * Limits resolve from src/web/config.js (WEB_RATE_LIMIT_* env, sane
 * defaults) at FACTORY creation time — i.e. at app boot.
 */

const crypto = require("crypto");
const {
  getRateLimitConfig,
  isTrustProxyEnabled,
} = require("../config");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Bucket-sweep cadence (map hygiene; windows self-heal without it). */
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
const TOO_MANY_BODY = "Too many requests";
const PAYLOAD_TOO_LARGE_BODY = "Payload too large";

/**
 * @typedef {object} RateOutcome
 * @property {boolean} allowed
 * @property {number} remaining requests left in the window (0 when denied)
 * @property {number} retryAfterSec seconds until the window rolls (0 when allowed)
 */

/**
 * Fixed-window bucket store for ONE limiter (in-memory, per process).
 * A window starts at the bucket's first hit and resets once fully elapsed;
 * hits past the cap are denied until the window rolls. Sweeping drops
 * windows that can never be touched again. The sweep interval is unref'd so
 * it never keeps the bot (or a test process) alive.
 *
 * @param {{
 *   name?: string,
 *   windowMs?: number,
 *   max?: number,
 *   now?: () => number,
 *   sweepIntervalMs?: number,
 *   autoStartSweep?: boolean,
 * }} [options]
 */
function createRateBucketStore(options = {}) {
  const {
    name = "rate",
    windowMs = getRateLimitConfig().windowMs,
    max = 60,
    now = () => Date.now(),
    sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
    autoStartSweep = true,
  } = options;

  /** @type {Map<string, { count: number, windowStart: number }>} */
  const buckets = new Map();
  /** @type {NodeJS.Timeout|null} */
  let timer = null;

  /** Drop buckets whose window has fully elapsed (at = injectable clock). */
  function sweep(at = now()) {
    for (const [key, bucket] of buckets) {
      if (at - bucket.windowStart >= windowMs) buckets.delete(key);
    }
  }

  function ensureSweep() {
    if (timer || !autoStartSweep) return;
    timer = setInterval(() => sweep(), sweepIntervalMs);
    // The bot owns the event loop; a bookkeeping timer must never hold it.
    if (typeof timer.unref === "function") timer.unref();
  }

  /**
   * Register one hit for `key` and report the outcome.
   * @param {string} key
   * @returns {RateOutcome}
   */
  function hit(key) {
    const at = now();
    ensureSweep();
    let bucket = buckets.get(key);
    if (!bucket || at - bucket.windowStart >= windowMs) {
      bucket = { count: 0, windowStart: at };
      buckets.set(key, bucket);
    }
    if (bucket.count >= max) {
      const waitMs = bucket.windowStart + windowMs - at;
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)),
      };
    }
    bucket.count += 1;
    return { allowed: true, remaining: max - bucket.count, retryAfterSec: 0 };
  }

  /** Stop the sweep timer (tests / shutdown). Keeps bucket data intact. */
  function dispose() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    hit,
    sweep,
    dispose,
    get size() {
      return buckets.size;
    },
    /** @internal test seam: exposes the unref assertion on the timer. */
    get timer() {
      return timer;
    },
    name,
    windowMs,
    max,
  };
}

/**
 * Generic 429 — plain text, Retry-After required (§8.7); bodies/headers
 * carry no keys, ids, or addresses.
 * @param {import("http").ServerResponse} res
 * @param {number} retryAfterSec
 */
function sendTooManyRequests(res, retryAfterSec) {
  res.writeHead(429, {
    "Content-Type": "text/plain; charset=utf-8",
    "Retry-After": String(retryAfterSec),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(TOO_MANY_BODY);
}

/**
 * Middleware around ONE bucket. `keyFor(req)` returns the bucket key or
 * null/undefined to skip the check (e.g. the per-user gate for anonymous
 * requests). If a key extractor ever throws, the middleware FAILS OPEN
 * (next()) — a limiter bug must not 5xx the admin panel; keyFor here is
 * total on purpose.
 *
 * @param {{
 *   name?: string,
 *   keyFor?: (req: any) => string|null|undefined,
 *   windowMs?: number,
 *   max?: number,
 *   now?: () => number,
 *   store?: ReturnType<typeof createRateBucketStore>,
 *   skipSafeMethods?: boolean,
 *   sweepIntervalMs?: number,
 * }} options
 */
function createRateLimitMiddleware(options = {}) {
  const {
    name = "rate",
    keyFor,
    windowMs,
    max,
    now = () => Date.now(),
    store,
    skipSafeMethods = false,
    sweepIntervalMs,
  } = options;
  const gate =
    store || createRateBucketStore({ name, windowMs, max, now, sweepIntervalMs });

  return function rateLimitMiddleware(req, res, next) {
    if (skipSafeMethods && SAFE_METHODS.has(req.method)) return next();
    let key = null;
    try {
      key = keyFor ? keyFor(req) : null;
    } catch {
      return next(); // fail-open documented above; never log request material
    }
    if (key === null || key === undefined) return next();
    const outcome = gate.hit(String(key));
    if (outcome.allowed) return next();
    return sendTooManyRequests(res, outcome.retryAfterSec);
  };
}

/**
 * Hashed bucket key for a client address — the raw IP stays out of the map.
 * @param {string} value
 * @returns {string}
 */
function hashKey(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * Client identity for rate limiting. X-Forwarded-For's FIRST hop only, and
 * only when proxy trust is enabled; otherwise the socket address (§8.7).
 * @param {import("http").IncomingMessage} req
 * @param {boolean} [trustProxy] override (tests); default: WEB_TRUST_PROXY
 * @returns {string} may be "" when nothing is known (shared fallback bucket)
 */
function resolveClientIp(req, trustProxy = isTrustProxyEnabled()) {
  if (trustProxy) {
    const header = req.headers && req.headers["x-forwarded-for"];
    const first = typeof header === "string" ? header.split(",")[0].trim() : "";
    if (first) return first;
  }
  return (req.socket && req.socket.remoteAddress) || "";
}

/**
 * Per-IP bucket key (hashed; unknown IPs collapse into one shared bucket —
 * fail-safe, not fail-open).
 * @param {import("http").IncomingMessage} req
 * @param {boolean} [trustProxy]
 * @returns {string}
 */
function ipKey(req, trustProxy) {
  return hashKey(`ip:${resolveClientIp(req, trustProxy) || "unknown"}`);
}

/**
 * Per-user bucket key: the live session user, or the `req.rateLimitUserHint`
 * the login/callback route (subtask 06) sets once the token exchange reveals
 * the Discord id. null = user not (yet) known → user gate skips.
 * @param {any} req
 * @returns {string|null}
 */
function userKey(req) {
  const id = (req.user && req.user.userId) || req.rateLimitUserHint || null;
  return id ? `u:${id}` : null;
}

/**
 * Login + OAuth-callback limiter (§8.7): every request under /auth/* counts
 * against the per-IP bucket AND — once a user identity is known — the
 * per-user bucket. ANY exhausted bucket → 429 + Retry-After. Sequential
 * counting means an attempt that trips the user gate still consumed its IP
 * slot: deliberate (both are abuse signals).
 *
 * @param {{
 *   now?: () => number,
 *   windowMs?: number,
 *   ipMax?: number,
 *   userMax?: number,
 *   sweepIntervalMs?: number,
 * }} [options] overrides (tests); default: config resolution at creation
 */
function createAuthRateLimit(options = {}) {
  const cfg = getRateLimitConfig();
  const windowMs = options.windowMs ?? cfg.windowMs;
  const now = options.now || (() => Date.now());
  const shared = { windowMs, now, sweepIntervalMs: options.sweepIntervalMs };

  const ipGate = createRateLimitMiddleware({
    ...shared,
    name: "auth_ip",
    max: options.ipMax ?? cfg.authMax,
    keyFor: (req) => ipKey(req),
  });
  const userGate = createRateLimitMiddleware({
    ...shared,
    name: "auth_user",
    max: options.userMax ?? cfg.authUserMax,
    keyFor: (req) => userKey(req),
  });

  return function authRateLimit(req, res, next) {
    ipGate(req, res, () => userGate(req, res, next));
  };
}

/**
 * Mutation limiter (§8.7): counts non-safe methods per user (IP fallback
 * while anonymous). Mount app-wide — safe methods return immediately, so the
 * Phase 0a GET surface pays nothing. Runs BEFORE the CSRF check so failed
 * token attempts count against the actor's bucket (brute-force brake).
 *
 * @param {{
 *   now?: () => number,
 *   windowMs?: number,
 *   max?: number,
 *   sweepIntervalMs?: number,
 * }} [options]
 */
function createMutationRateLimit(options = {}) {
  const cfg = getRateLimitConfig();
  return createRateLimitMiddleware({
    name: "mutation",
    windowMs: options.windowMs ?? cfg.windowMs,
    max: options.max ?? cfg.mutationMax,
    now: options.now || (() => Date.now()),
    sweepIntervalMs: options.sweepIntervalMs,
    skipSafeMethods: true,
    keyFor: (req) => userKey(req) || ipKey(req),
  });
}

/**
 * Generic 413 (body cap) — same plain-text style; no sizes/limits echoed.
 * @param {import("http").ServerResponse} res
 */
function denyPayloadTooLarge(res) {
  res.writeHead(413, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(PAYLOAD_TOO_LARGE_BODY);
}

/**
 * Parse urlencoded bytes into a plain object (same helper semantics as
 * middleware/csrf.js — kept local to avoid coupling the two modules).
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
 * Body-size cap middleware (§8.7 "body size caps"). Safe methods pass
 * untouched (GET surface stays byte-identical); declared Content-Length past
 * the cap is denied WITHOUT reading the body; chunked bodies are counted and
 * destroyed past the cap. On success the drained bytes are exposed as
 * `req.rawBody`, urlencoded fields as `req.bodyFields`, and `req.body` is
 * defaulted to the parsed fields when nothing parsed it earlier — so
 * downstream routes (and the CSRF guard) read the token/fields without a
 * second, double-consuming body parser. Mount this BEFORE the CSRF middleware
 * and do NOT mount express body parsers on top of it (the stream is already
 * drained here).
 *
 * @param {{ maxBytes?: number }} [options]
 */
function createBodyCapMiddleware(options = {}) {
  const maxBytes = options.maxBytes ?? getRateLimitConfig().maxBodyBytes;

  return function bodyCapMiddleware(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();

    const headers = req.headers || {};
    const declared = Number(headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return denyPayloadTooLarge(res);
    }

    const chunked = String(headers["transfer-encoding"] || "")
      .toLowerCase()
      .includes("chunked");
    const hasBody = chunked || (Number.isFinite(declared) && declared > 0);
    if (!hasBody || Buffer.isBuffer(req.rawBody)) {
      if (!Buffer.isBuffer(req.rawBody)) req.rawBody = Buffer.alloc(0);
      return next();
    }
    if (typeof req.on !== "function" || req.readableEnded) return next();

    const chunks = [];
    let size = 0;
    let dead = false;

    req.on("data", (chunk) => {
      if (dead) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        dead = true;
        denyPayloadTooLarge(res);
        if (typeof req.destroy === "function") req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("error", () => {
      dead = true; // client aborted — nothing to answer to
    });
    req.on("aborted", () => {
      dead = true;
    });
    req.on("end", () => {
      if (dead) return;
      const rawBody = Buffer.concat(chunks);
      req.rawBody = rawBody;
      req.bodyFields = String(headers["content-type"] || "").startsWith(
        "application/x-www-form-urlencoded"
      )
        ? formFields(rawBody)
        : {};
      if (req.body === undefined) req.body = req.bodyFields;
      return next();
    });
    return undefined;
  };
}

module.exports = {
  DEFAULT_SWEEP_INTERVAL_MS,
  SAFE_METHODS,
  createRateBucketStore,
  createRateLimitMiddleware,
  createAuthRateLimit,
  createMutationRateLimit,
  createBodyCapMiddleware,
  resolveClientIp,
  ipKey,
  userKey,
  sendTooManyRequests,
};
