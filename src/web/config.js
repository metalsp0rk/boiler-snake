/**
 * Web HTTP configuration (roadmap/web-admin.md §8.10).
 *
 * Owns the PUBLIC_HTTP_PORT / PUBLIC_BASE_URL (and legacy TICKET_* alias)
 * reads for the HTTP surface. Delegates to commandPermissions/config so the
 * alias precedence (PUBLIC_* wins over TICKET_*) and port normalization
 * (invalid → null) stay defined in exactly one place — Phase 0b adds the
 * session/auth knobs (SESSION_SECRET, WEB_* caches) beside these.
 */

const {
  getPublicHttpConfig,
} = require("../features/commandPermissions/config");

/**
 * @returns {{ port: number|null, publicBaseUrl: string|null }}
 */
function getHttpConfig() {
  return getPublicHttpConfig();
}

/**
 * Public URL for a transcript token (null if base URL unset).
 * @param {string} token
 * @returns {string|null}
 */
function transcriptPublicUrl(token) {
  const { publicBaseUrl } = getHttpConfig();
  if (!publicBaseUrl || !token) return null;
  return `${publicBaseUrl}/t/${token}`;
}

// ---------------------------------------------------------------------------
// Session / auth knobs (roadmap/web-admin.md §8.3, §8.10). Resolved live from
// env so tests flip values without re-requiring the module.
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const DEFAULT_SESSION_TTL_HOURS = 12;
const DEFAULT_TIER_CACHE_TTL_MS = 60_000;

/** One-shot guard for the CLIENT_SECRET-fallback warning (per process boot). */
let warnedSecretFallback = false;

/**
 * Signing secret for session-adjacent payloads (CSRF/state signing lands in
 * subtasks 06/09). SESSION_SECRET is dedicated and preferred; the fallback to
 * CLIENT_SECRET mirrors the OAUTH_STATE_SECRET precedent in
 * commandPermissions/config.js and warns exactly ONCE per boot. Values are
 * NEVER logged (§8.7).
 * @returns {string|null} null when neither var is configured
 */
function getSessionSecret() {
  const dedicated = process.env.SESSION_SECRET
    ? String(process.env.SESSION_SECRET).trim()
    : "";
  if (dedicated) return dedicated;

  const client = process.env.CLIENT_SECRET
    ? String(process.env.CLIENT_SECRET).trim()
    : "";
  if (client) {
    if (!warnedSecretFallback) {
      warnedSecretFallback = true;
      console.warn(
        "[web] SESSION_SECRET is not set; falling back to CLIENT_SECRET for session signing. Set a dedicated SESSION_SECRET (e.g. `openssl rand -hex 32`)."
      );
    }
    return client;
  }
  return null;
}

/**
 * Sliding session TTL in ms (WEB_SESSION_TTL_HOURS, default 12; §8.3). The
 * absolute 7 d cap is enforced in auth/sessions.js, not here. Invalid values
 * (NaN, ≤0, empty) fall back to the default.
 * @returns {number}
 */
function getSessionTtlMs() {
  const raw = process.env.WEB_SESSION_TTL_HOURS;
  const hours =
    raw == null || String(raw).trim() === "" ? NaN : Number(raw);
  const value =
    Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SESSION_TTL_HOURS;
  return Math.round(value * HOUR_MS);
}

/**
 * Tier-resolution cache TTL in ms (WEB_TIER_CACHE_TTL_MS, default 60000;
 * §8.3/§8.10) — the revocation-latency bound for guildAccess (subtask 07).
 * @returns {number}
 */
function getTierCacheTtlMs() {
  const raw = process.env.WEB_TIER_CACHE_TTL_MS;
  const value =
    raw == null || String(raw).trim() === "" ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : DEFAULT_TIER_CACHE_TTL_MS;
}

/**
 * Secure-cookie rule (§8.3/§8.10): Secure flag iff the RESOLVED base URL is
 * https. Unset or unparseable base URL → false (dev over http keeps the
 * console usable; production is nudged by warnIfInsecurePublicBaseUrl).
 * @returns {boolean}
 */
function isSecureBaseUrl() {
  const { publicBaseUrl } = getHttpConfig();
  if (!publicBaseUrl) return false;
  try {
    return new URL(publicBaseUrl).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Boot-time HTTPS validation (§8.7): a non-localhost `http://`
 * PUBLIC_BASE_URL is a loud warning (Secure-cookie caveat documented in
 * docs/setup.md — Phase 4). Silent for https, loopback dev URLs, and when
 * the base URL is unset. Returns whether a warning was emitted.
 * @returns {boolean}
 */
function warnIfInsecurePublicBaseUrl() {
  const { publicBaseUrl } = getHttpConfig();
  if (!publicBaseUrl) return false;

  let url;
  try {
    url = new URL(publicBaseUrl);
  } catch {
    console.warn(
      "[web] PUBLIC_BASE_URL is not a valid URL; HTTPS/Secure-cookie validation skipped."
    );
    return false;
  }
  if (url.protocol !== "http:") return false;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const isLoopback =
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    /^127\./.test(host);
  if (isLoopback) return false;

  console.warn(
    `[web] PUBLIC_BASE_URL is plain HTTP for a non-localhost host (${publicBaseUrl}). Session cookies will NOT carry Secure; put TLS / a reverse proxy in front and use https (roadmap/web-admin.md §8.7).`
  );
  return true;
}

// ---------------------------------------------------------------------------
// Web login (Discord OAuth2) knobs (roadmap/web-admin.md §8.3, §8.10)
// ---------------------------------------------------------------------------

/** §8.3 login scopes: profile + the user's guild list + member reads (07). */
const LOGIN_SCOPES = Object.freeze(["identify", "guilds", "guilds.members.read"]);
const DEFAULT_LOGIN_PROMPT = "consent";
const LOGIN_PROMPTS = Object.freeze(["consent", "none"]);

/**
 * Redirect URI for the web login flow.
 *
 * OPERATOR NOTE: this exact string must be registered in the Discord
 * Developer Portal (OAuth2 → Redirects). Discord matches redirect URIs
 * byte-exactly (scheme, host, port, path, trailing slashes); the token
 * exchange must resend the identical string, which is why both the
 * authorize URL and the callback exchange resolve it HERE, live, from the
 * same base URL (getOAuthRedirectUri precedent in commandPermissions).
 *
 * @returns {string|null} null when PUBLIC_BASE_URL (or the explicit
 *   WEB_LOGIN_REDIRECT_URI override) is unset
 */
function getLoginRedirectUri() {
  const explicit = process.env.WEB_LOGIN_REDIRECT_URI
    ? String(process.env.WEB_LOGIN_REDIRECT_URI).trim().replace(/\/$/, "")
    : "";
  if (explicit) return explicit;
  const { publicBaseUrl } = getHttpConfig();
  if (!publicBaseUrl) return null;
  return `${publicBaseUrl}/auth/login/callback`;
}

/**
 * Everything the login routes need, resolved live from env (tests flip
 * values without re-requiring). Never log or echo secret VALUES — `missing`
 * lists var NAMES only.
 * @returns {{
 *   ready: boolean,
 *   clientId: string|null,
 *   clientSecret: string|null,
 *   redirectUri: string|null,
 *   prompt: string,
 *   scopes: string[],
 *   missing: string[],
 * }}
 */
function getWebLoginConfig() {
  const clientId = process.env.CLIENT_ID
    ? String(process.env.CLIENT_ID).trim()
    : null;
  const clientSecret = process.env.CLIENT_SECRET
    ? String(process.env.CLIENT_SECRET).trim()
    : null;
  const redirectUri = getLoginRedirectUri();

  const promptRaw = process.env.WEB_LOGIN_PROMPT
    ? String(process.env.WEB_LOGIN_PROMPT).trim().toLowerCase()
    : "";
  // prompt=consent by default (fresh consent screen per login); operators
  // may pick "none" for silent re-auth. Anything else falls back to default.
  const prompt = LOGIN_PROMPTS.includes(promptRaw)
    ? promptRaw
    : DEFAULT_LOGIN_PROMPT;

  const missing = [];
  if (!clientId) missing.push("CLIENT_ID");
  if (!clientSecret) missing.push("CLIENT_SECRET");
  if (!redirectUri) missing.push("PUBLIC_BASE_URL (or WEB_LOGIN_REDIRECT_URI)");

  return {
    ready: missing.length === 0,
    clientId,
    clientSecret,
    redirectUri,
    prompt,
    scopes: [...LOGIN_SCOPES],
    missing,
  };
}

// ---------------------------------------------------------------------------
// Rate limiting / body cap / reverse-proxy trust (roadmap/web-admin.md §8.7,
// §8.10 — subtask 08). Resolved live from env like the session knobs above;
// the middleware factories snapshot the values at creation (boot) time, so
// changing these vars takes an app restart — matching the bot's lifecycle.
// ---------------------------------------------------------------------------

/** Fixed window length for every web rate bucket. */
const DEFAULT_RATE_WINDOW_MS = 60_000;
/** Login + OAuth callback requests per client IP per window. */
const DEFAULT_AUTH_RATE_MAX = 30;
/** Login + OAuth callback requests per resolved user per window. */
const DEFAULT_AUTH_USER_RATE_MAX = 10;
/** Non-GET (mutation) requests per user per window. */
const DEFAULT_MUTATION_RATE_MAX = 120;
/** Max accepted request body size in bytes (generic 413 beyond it). */
const DEFAULT_MAX_BODY_BYTES = 65_536;

/**
 * Parse a positive integer env value; invalid (NaN, ≤0, empty) → fallback.
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function readPositiveIntEnv(raw, fallback) {
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

/**
 * Fixed-window rate-limit budget + body cap (§8.7). Defaults are sized for a
 * human admin (120 mutations/min, 30 auth hits/min per IP) while still
 * capping scripted abuse.
 * @returns {{
 *   windowMs: number,
 *   authMax: number,
 *   authUserMax: number,
 *   mutationMax: number,
 *   maxBodyBytes: number,
 * }}
 */
function getRateLimitConfig() {
  return {
    windowMs: readPositiveIntEnv(
      process.env.WEB_RATE_LIMIT_WINDOW_MS,
      DEFAULT_RATE_WINDOW_MS
    ),
    authMax: readPositiveIntEnv(
      process.env.WEB_RATE_LIMIT_AUTH_MAX,
      DEFAULT_AUTH_RATE_MAX
    ),
    authUserMax: readPositiveIntEnv(
      process.env.WEB_RATE_LIMIT_AUTH_USER_MAX,
      DEFAULT_AUTH_USER_RATE_MAX
    ),
    mutationMax: readPositiveIntEnv(
      process.env.WEB_RATE_LIMIT_MUTATION_MAX,
      DEFAULT_MUTATION_RATE_MAX
    ),
    maxBodyBytes: readPositiveIntEnv(
      process.env.WEB_MAX_BODY_BYTES,
      DEFAULT_MAX_BODY_BYTES
    ),
  };
}

/**
 * Reverse-proxy trust (§8.7): X-Forwarded-For is honored ONLY when
 * WEB_TRUST_PROXY is truthy. Default OFF → the socket address is the client
 * identity, which is correct for a directly exposed bot and fails safe
 * behind an unconfigured proxy (visitors share one bucket instead of forged
 * headers winning). Operators running behind nginx/traefik/etc. MUST set
 * WEB_TRUST_PROXY=1 (documented in .env.example).
 * @returns {boolean}
 */
function isTrustProxyEnabled() {
  const raw = String(process.env.WEB_TRUST_PROXY || "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** @private test helper (mirrors oauthState._resetNoncesForTests) */
function _resetConfigWarningsForTests() {
  warnedSecretFallback = false;
}

module.exports = {
  getHttpConfig,
  transcriptPublicUrl,
  getSessionSecret,
  getSessionTtlMs,
  getTierCacheTtlMs,
  isSecureBaseUrl,
  warnIfInsecurePublicBaseUrl,
  getRateLimitConfig,
  isTrustProxyEnabled,
  getLoginRedirectUri,
  getWebLoginConfig,
  LOGIN_SCOPES,
  DEFAULT_LOGIN_PROMPT,
  LOGIN_PROMPTS,
  DEFAULT_SESSION_TTL_HOURS,
  DEFAULT_TIER_CACHE_TTL_MS,
  DEFAULT_RATE_WINDOW_MS,
  DEFAULT_AUTH_RATE_MAX,
  DEFAULT_AUTH_USER_RATE_MAX,
  DEFAULT_MUTATION_RATE_MAX,
  DEFAULT_MAX_BODY_BYTES,
  _resetConfigWarningsForTests,
};
