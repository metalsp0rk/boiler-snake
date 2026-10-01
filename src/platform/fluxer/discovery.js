/**
 * Fluxer instance discovery (roadmap/fluxer.md § Boot — "Discovery").
 *
 * GET {origin}/.well-known/fluxer with NO credential: no Authorization
 * header, no token anywhere in the request. The returned document's
 * `endpoints.api_public` and `endpoints.gateway` are validated against a
 * scheme allow-list BEFORE any caller may attach the bot token to them
 * (spec § Security: "Token is attached only after api_public / gateway
 * pass the scheme allow-list").
 *
 * Rules (spec § Boot, recorded verbatim in the PR 6 bundle):
 * - Require `endpoints.api_public` (http/https) and `endpoints.gateway`
 *   (ws/wss). Anything else — `file:`, `javascript:`, a missing scheme, a
 *   missing field — is a hard failure for THAT instance's login only.
 * - Path prefixes are preserved: api_public `https://example.com/api`
 *   means routes live under `/api`. No sibling hosts are invented.
 * - A different host than the origin is allowed (the hosted service serves
 *   `api` and `api_public` on different hosts).
 * - The document is cached per origin for the process lifetime.
 * - Logging is the two endpoint URLs (query strings stripped). Never the
 *   token, never the discovery body, never a query string.
 *
 * SDK-free by contract: this module must load with the Fluxer SDK absent.
 */

const { normalizeOriginForKey } = require("../../config");

/** Path appended to every discovery origin (Phase 0: there is no /api/v1/instance route). */
const WELL_KNOWN_PATH = "/.well-known/fluxer";

/** Schemes an endpoint URL may use, keyed by endpoint field name. */
const ALLOWED_SCHEMES = {
  api_public: ["http:", "https:"],
  gateway: ["ws:", "wss:"],
};

/**
 * Per-origin document cache for the process lifetime (spec: "Cache the
 * document for the process lifetime. A failed discovery fails that
 * instance's login only."). Keys are normalized origin keys.
 * @type {Map<string, { apiPublic: string, gateway: string, document: unknown }>}
 */
const discoveryCache = new Map();

/**
 * Turn a URL into its canonical string form with the query string and
 * fragment removed and a single trailing slash trimmed. Query strings are
 * never logged and never cached (spec § Boot); path prefixes are kept.
 *
 * @param {URL} url
 * @returns {string}
 */
function canonicalUrlString(url) {
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * Validate one discovery endpoint field against its scheme allow-list.
 * @param {string} originKey normalized origin (for the error message)
 * @param {unknown} value raw document value
 * @param {"api_public"|"gateway"} field field name (named in every message)
 * @returns {string} canonical URL string
 */
function validateEndpoint(originKey, value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `Fluxer discovery for ${originKey} is missing endpoints.${field}`,
    );
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    // Covers a relative value, a bare host ("api.example.com" — no scheme),
    // and anything else URL rejects.
    throw new Error(
      `Fluxer discovery for ${originKey} has an invalid endpoints.${field} URL: ${JSON.stringify(String(value))}`,
    );
  }
  const allowed = ALLOWED_SCHEMES[field];
  if (!allowed.includes(url.protocol)) {
    throw new Error(
      `Fluxer discovery for ${originKey}: endpoints.${field} scheme "${url.protocol}" is not allowed (expected one of: ${allowed.join(", ")})`,
    );
  }
  return canonicalUrlString(url);
}

/**
 * Discover one Fluxer instance's public endpoints.
 *
 * @param {string} origin absolute http(s) origin (validated; scheme-allow-listed)
 * @param {{ fetchImpl?: (url: string, init?: object) => Promise<any> }} [options]
 *   fetchImpl overrides the transport (tests inject a fake; production uses globalThis.fetch)
 * @returns {Promise<{ apiPublic: string, gateway: string, document: unknown }>}
 * @throws {Error} with a specific, field-named message on any rule violation.
 *   Callers turn a rejection into a per-instance login failure — it must
 *   never take Discord down and never call process.exit.
 */
async function discoverInstance(origin, { fetchImpl = globalThis.fetch } = {}) {
  // Security rule (spec § Threat model): never fetch a non-http(s) discovery
  // URL. Checked before normalization so `javascript:`/`file:` origins fail
  // with a discovery-named message.
  let originUrl = null;
  try {
    originUrl = new URL(String(origin));
  } catch {
    // normalizeOriginForKey below throws the specific "not a valid absolute
    // URL" message for anything URL rejects.
  }
  if (originUrl && originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
    throw new Error(
      `Fluxer discovery for ${JSON.stringify(String(origin))}: origin scheme "${originUrl.protocol}" is not allowed (use http: or https:)`,
    );
  }
  // normalizeOriginForKey enforces "absolute URL" and lowercases the host;
  // the http/https scheme rule is enforced by discovery's own allow-list so
  // the error message names the config field.
  const originKey = normalizeOriginForKey(origin);
  const cached = discoveryCache.get(originKey);
  if (cached) return cached;

  if (typeof fetchImpl !== "function") {
    throw new Error(
      `Fluxer discovery for ${originKey}: no fetch implementation available (globalThis.fetch is not defined)`,
    );
  }

  const url = `${originKey}${WELL_KNOWN_PATH}`;
  let response;
  try {
    // Unauthenticated: no Authorization header, no token (spec § Boot).
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch (err) {
    throw new Error(
      `Fluxer discovery for ${originKey} failed: ${err?.message || err}`,
    );
  }

  if (!response || typeof response.status !== "number") {
    throw new Error(
      `Fluxer discovery for ${originKey} failed: malformed HTTP response (no status code)`,
    );
  }
  if (response.ok !== true) {
    throw new Error(
      `Fluxer discovery for ${originKey} failed: ${url} returned HTTP ${response.status}`,
    );
  }

  let document;
  try {
    document = await response.json();
  } catch (err) {
    throw new Error(
      `Fluxer discovery for ${originKey} failed: ${url} did not return JSON (${err?.message || err})`,
    );
  }

  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(
      `Fluxer discovery for ${originKey} failed: document is not a JSON object`,
    );
  }

  const endpoints =
    document.endpoints && typeof document.endpoints === "object"
      ? document.endpoints
      : null;
  if (!endpoints) {
    throw new Error(
      `Fluxer discovery for ${originKey} is missing the "endpoints" object`,
    );
  }

  const apiPublic = validateEndpoint(originKey, endpoints.api_public, "api_public");
  const gateway = validateEndpoint(originKey, endpoints.gateway, "gateway");

  const result = Object.freeze({ apiPublic, gateway, document });
  discoveryCache.set(originKey, result);
  // Info line with the two hosts only (query strings stripped). Never the
  // body, never a token (spec § Boot; the boot test scans every captured
  // console string).
  console.log(
    `[fluxer] ${originKey} discovered api=${apiPublic} gateway=${gateway}`,
  );
  return result;
}

/**
 * Drop the per-origin document cache. Production code never calls this;
 * it exists for tests and for a future re-discovery trigger.
 */
function clearDiscoveryCache() {
  discoveryCache.clear();
}

module.exports = {
  discoverInstance,
  clearDiscoveryCache,
  WELL_KNOWN_PATH,
};
