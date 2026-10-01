/**
 * Thin Fluxer OAuth2 REST client for the web login flow
 * (roadmap/fluxer.md § Authorize URL / § Token exchange and refresh).
 *
 * Mirrors `createDiscordApi` (src/web/auth/discordApi.js) shape for the same
 * reasons: tests fake /oauth2/token, /oauth2/userinfo and the guild list
 * OFFLINE on a local HTTP server (no global fetch monkey-patching), so the
 * API base URL and the fetch impl are injected here.
 *
 * Doc/Phase-0-mandated integration facts encoded here:
 *  - the token endpoint accepts ONLY `application/x-www-form-urlencoded`
 *    (JSON body → 400), confidential-client auth via HTTP Basic
 *    (base64(clientId:clientSecret)) — the secret never enters the body;
 *  - the token exchange re-sends the redirect_uri string BYTE-IDENTICAL to
 *    the authorize request (the caller passes the same value both ways);
 *  - scope spaces are `%20`-encoded (NOT `+`), matching the care taken in
 *    discordApi's buildAuthorizeUrl; scopes are `identify` + `guilds` only —
 *    `guilds.members.read` is not in the registry and fails the grant;
 *  - PKCE is S256 only: `code_challenge` rides on authorize, `code_verifier`
 *    rides on the exchange. Method `plain` is never sent.
 *  - Phase 0 verified: `GET {api}/oauth2/userinfo` (scope identify) returns
 *    `sub` (= the user id); `GET {api}/users/@me/guilds` works with the user
 *    bearer token and `permissions` is a DECIMAL STRING.
 *
 * SECURITY: tokens are treated as passwords (§8.7). They are returned to the
 * caller in memory only; nothing here logs or persists them. Error objects
 * carry machine-readable `code` + `status` + `oauthError` (the OAuth `error`
 * value like `invalid_grant`) — never `error_description`, which can echo
 * request data.
 */

const crypto = require("crypto");

const REQUEST_TIMEOUT_MS = 10_000;
/** Documented Fluxer access-token lifetime: 7 days (expires_in 604800). */
const DEFAULT_ACCESS_EXPIRES_IN_SEC = 604_800;
/** Documented refresh-token horizon: 30 days (refresh_expires_in). */
const DEFAULT_REFRESH_EXPIRES_IN_SEC = 30 * 24 * 60 * 60;

/**
 * Normalize a URL string: trim + drop any trailing slashes so joined paths
 * never double up (base URLs only — redirect_uri exactness is the caller's
 * problem, same rule as discordApi).
 * @param {string} url
 * @returns {string}
 */
function trimTrailingSlash(url) {
  return String(url).replace(/\/+$/, "");
}

/**
 * Slug for a Fluxer instance used in the login URL path: the first 16 hex
 * chars of SHA-256 of the normalized instanceKey (spec § Authorize URL —
 * origins contain slashes and would make a broken route).
 * @param {string} instanceKey
 * @returns {string} 16 lowercase hex chars
 */
function fluxerInstanceSlug(instanceKey) {
  return crypto
    .createHash("sha256")
    .update(String(instanceKey))
    .digest("hex")
    .slice(0, 16);
}

/**
 * @typedef {object} FluxerTokenResponse
 * @property {string} accessToken
 * @property {number} expiresAt unix ms ceiling (now + expires_in)
 * @property {string|null} refreshToken (null when the instance issued none)
 * @property {number|null} refreshExpiresAt unix ms horizon (null with no
 *   refresh token — sessions fall to the 30-day default horizon at the policy layer)
 * @property {string|null} scopes granted scope string (space-separated)
 */

/**
 * Build a Fluxer instance API client.
 *
 * @param {object} options
 * @param {string} options.apiBase discovery `api_public` for THIS instance
 *   (e.g. https://community.example/v1) — required: unlike Discord there is
 *   no single default host.
 * @param {typeof fetch} [options.fetchImpl] fetch override (tests)
 * @param {number} [options.timeoutMs]
 */
function createFluxerApi({ apiBase, fetchImpl = null, timeoutMs = REQUEST_TIMEOUT_MS }) {
  if (typeof apiBase !== "string" || apiBase.trim() === "") {
    throw new TypeError("createFluxerApi: apiBase is required (Fluxer instances have no default host)");
  }
  const base = trimTrailingSlash(apiBase);
  const doFetch =
    fetchImpl || ((input, init) => globalThis.fetch(input, init));

  /**
   * GET `${base}${path}` with the user's Bearer token; JSON in, parsed out.
   * @param {string} path
   * @param {string} accessToken
   * @returns {Promise<any>}
   */
  async function getApi(path, accessToken) {
    const res = await doFetch(`${base}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // Status only — response bodies can echo request data, and a 401 here
      // means "re-auth", not something to surface verbatim.
      const err = new Error(`fluxer api ${res.status} on ${path}`);
      err.code = "fluxer_api_status";
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /**
   * POST /oauth2/token (form-urlencoded + Basic, same live-docs rules as the
   * Discord exchange). Shared by the code exchange and the refresh rotation.
   * @param {Record<string,string>} formParams
   * @param {string} clientId
   * @param {string} clientSecret
   * @returns {Promise<FluxerTokenResponse>}
   */
  async function postToken(formParams, clientId, clientSecret) {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await doFetch(`${base}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams(formParams),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      // OAuth `error` values (invalid_grant, …) are safe to surface; the
      // `error_description` is NOT (it can echo the request).
      const err = new Error(
        json?.error || `fluxer token request HTTP ${res.status}`
      );
      err.code = "fluxer_token_exchange";
      err.status = res.status;
      err.oauthError = typeof json?.error === "string" ? json.error : null;
      throw err;
    }
    if (!json?.access_token || typeof json.access_token !== "string") {
      const err = new Error("fluxer token response missing access_token");
      err.code = "fluxer_token_shape";
      throw err;
    }
    const expiresInSec =
      Number.isFinite(Number(json.expires_in)) && Number(json.expires_in) > 0
        ? Number(json.expires_in)
        : DEFAULT_ACCESS_EXPIRES_IN_SEC; // documented default lifetime (7 d)
    const refreshExpiresInSec =
      Number.isFinite(Number(json.refresh_expires_in)) &&
      Number(json.refresh_expires_in) > 0
        ? Number(json.refresh_expires_in)
        : DEFAULT_REFRESH_EXPIRES_IN_SEC; // documented horizon (30 d)
    const refreshToken =
      typeof json.refresh_token === "string" && json.refresh_token
        ? json.refresh_token
        : null;
    return {
      accessToken: json.access_token,
      expiresAt: Date.now() + expiresInSec * 1000,
      refreshToken,
      // No refresh token ⇒ no refresh horizon (the session policy applies
      // its own 30-day default when this is null).
      refreshExpiresAt: refreshToken
        ? Date.now() + refreshExpiresInSec * 1000
        : null,
      scopes: typeof json.scope === "string" ? json.scope : null,
    };
  }

  return {
    /**
     * Authorization URL for "Login with Fluxer" (spec § Authorize URL block,
     * parameters in the spec's order; scopes are caller-supplied, pinned to
     * ["identify","guilds"] by login.js).
     *
     * @param {object} params
     * @param {string} params.clientId
     * @param {string} params.redirectUri exact registered URI for THIS
     *   instance (also sent, byte-identical, on the token exchange)
     * @param {string[]} params.scopes
     * @param {string} params.state purpose-tagged signed state
     * @param {string} params.prompt 'consent' (the spec pins consent; the
     *   parameter stays explicit so a future knob does not move the URL shape)
     * @param {string} params.codeChallenge base64url SHA-256 of the verifier
     * @returns {string}
     */
    buildAuthorizeUrl({ clientId, redirectUri, scopes, state, prompt, codeChallenge }) {
      // Scope spaces MUST be %20-encoded (docs: `identify%20guilds`);
      // URLSearchParams would emit '+' — build the query by hand exactly
      // like discordApi does for the same reason.
      const enc = encodeURIComponent;
      const query = [
        `response_type=${enc("code")}`,
        `client_id=${enc(clientId)}`,
        `redirect_uri=${enc(redirectUri)}`,
        `scope=${(scopes || []).map(enc).join("%20")}`,
        `state=${enc(state)}`,
        `prompt=${enc(prompt)}`,
        `code_challenge=${enc(codeChallenge)}`,
        `code_challenge_method=S256`,
      ].join("&");
      return `${base}/oauth2/authorize?${query}`;
    },

    /**
     * Exchange the single-use authorization code for the token pair,
     * presenting the PKCE code_verifier stored in the transaction row.
     *
     * @param {object} params
     * @param {string} params.code
     * @param {string} params.redirectUri byte-identical to authorize
     * @param {string} params.clientId
     * @param {string} params.clientSecret
     * @param {string} params.codeVerifier
     * @returns {Promise<FluxerTokenResponse>}
     */
    exchangeCode({ code, redirectUri, clientId, clientSecret, codeVerifier }) {
      return postToken(
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        },
        clientId,
        clientSecret
      );
    },

    /**
     * Rotate a spent token pair (spec § Token exchange and refresh — Fluxer
     * consumes the PRESENTED refresh token and returns a new pair).
     * `invalid_grant` (revoked/expired grant) maps to `fluxer_refresh_denied`
     * so the session policy can mark the session `reauth` without retrying
     * the dead token.
     *
     * @param {object} params
     * @param {string} params.refreshToken
     * @param {string} params.clientId
     * @param {string} params.clientSecret
     * @returns {Promise<FluxerTokenResponse>}
     */
    async refreshToken({ refreshToken, clientId, clientSecret }) {
      try {
        return await postToken(
          { grant_type: "refresh_token", refresh_token: refreshToken },
          clientId,
          clientSecret
        );
      } catch (err) {
        if (err?.code === "fluxer_token_exchange" && err.oauthError === "invalid_grant") {
          const denied = new Error("fluxer refresh denied (invalid_grant)");
          denied.code = "fluxer_refresh_denied";
          denied.status = err.status;
          throw denied;
        }
        throw err;
      }
    },

    /**
     * `GET /oauth2/userinfo` — identity under the user's own token.
     * `sub` is the user id (Phase 0 verified: sub === id).
     * @param {string} accessToken
     * @returns {Promise<{ sub: string, username: string|null }>}
     */
    async getUserInfo(accessToken) {
      const json = await getApi("/oauth2/userinfo", accessToken);
      const raw = json?.sub;
      const sub =
        typeof raw === "string"
          ? raw
          : typeof raw === "number" && Number.isFinite(raw)
            ? String(raw)
            : null;
      if (!sub) {
        const err = new Error("fluxer /oauth2/userinfo returned no sub");
        err.code = "fluxer_userinfo_shape";
        throw err;
      }
      return {
        sub,
        username: typeof json?.username === "string" ? json.username : null,
      };
    },

    /**
     * `GET /users/@me/guilds` — ALL of the user's guilds on this instance
     * (Phase 0 verified path; `owner` boolean + `permissions` decimal string
     * are only ever sent here). The communities-intersection happens in
     * login.js — NOT here. Same non-array→[] contract as Discord's
     * getUserGuilds.
     * @param {string} accessToken
     * @returns {Promise<Array<object>>}
     */
    async listCurrentUserGuilds(accessToken) {
      const list = await getApi("/users/@me/guilds", accessToken);
      return Array.isArray(list) ? list : [];
    },
  };
}

module.exports = {
  REQUEST_TIMEOUT_MS,
  DEFAULT_ACCESS_EXPIRES_IN_SEC,
  DEFAULT_REFRESH_EXPIRES_IN_SEC,
  createFluxerApi,
  fluxerInstanceSlug,
};
