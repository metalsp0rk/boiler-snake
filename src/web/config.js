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
  DEFAULT_SESSION_TTL_HOURS,
  DEFAULT_TIER_CACHE_TTL_MS,
  _resetConfigWarningsForTests,
};
