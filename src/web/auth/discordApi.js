/**
 * Thin Discord OAuth2 REST client for the web login flow
 * (roadmap/web-admin.md §8.3/§8.11; API facts verified against the live
 * v10 docs — see .tmp/external-context/discord-oauth/web-login-notes.md).
 *
 * Why a factory: tests must fake /oauth2/token, /users/@me and
 * /users/@me/guilds OFFLINE (no global fetch monkey-patching of the real
 * app path), so the API base URL and the fetch impl are injected here.
 *
 * Doc-mandated integration facts encoded here:
 *  - the token + revoke endpoints accept ONLY
 *    `application/x-www-form-urlencoded` (JSON body → 400);
 *  - confidential clients authenticate with HTTP Basic
 *    (base64(client_id:client_secret)) — preferred over putting the secret
 *    in the body (keeps it out of request-logging);
 *  - the token exchange must re-send the redirect_uri string BYTE-IDENTICAL
 *    to the authorize request (the caller passes the same value both ways);
 *  - `guilds` scope returns ALL of the user's guilds — the bot∩user
 *    intersection is computed by the caller against the bot guild cache
 *    (discordApi never sees the bot side).
 *
 * SECURITY: tokens are treated as passwords (§8.7). They are returned to
 * the caller in memory only; nothing here logs or persists them.
 */

const DEFAULT_OAUTH_BASE = "https://discord.com";
const DEFAULT_API_BASE = "https://discord.com/api/v10";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} TokenResponse
 * @property {string} accessToken
 * @property {number} expiresAt unix ms ceiling (obtained_at + expires_in)
 * @property {string|null} scopes granted scope string (space-separated)
 */

/**
 * Normalize a URL string: trim + drop any trailing slashes so joined paths
 * never double up (redirect_uri exactness is the CALLER's problem — this
 * function is only for base URLs).
 * @param {string} url
 * @returns {string}
 */
function trimTrailingSlash(url) {
  return String(url).replace(/\/+$/, "");
}

/**
 * Build a Discord API client.
 *
 * @param {object} [options]
 * @param {string} [options.apiBase] REST base (default discord.com/api/v10;
 *   tests point this at their local fake server)
 * @param {string} [options.oauthBase] authorize base (default discord.com)
 * @param {typeof fetch} [options.fetchImpl] fetch override (tests)
 * @param {number} [options.timeoutMs]
 */
function createDiscordApi({
  apiBase = DEFAULT_API_BASE,
  oauthBase = DEFAULT_OAUTH_BASE,
  fetchImpl = null,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const base = trimTrailingSlash(apiBase);
  const authBase = trimTrailingSlash(oauthBase);
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
      const err = new Error(`discord api ${res.status} on ${path}`);
      err.code = "discord_api_status";
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  return {
    /**
     * Authorization URL for "Login with Discord" (§8.3 scopes; prompt is
     * config-resolved, default `consent`).
     *
     * @param {object} params
     * @param {string} params.clientId
     * @param {string} params.redirectUri exact registered URI (also sent on
     *   the token exchange)
     * @param {string[]} params.scopes
     * @param {string} params.state purpose-tagged signed state
     * @param {string} params.prompt 'consent' | 'none'
     * @returns {string}
     */
    buildAuthorizeUrl({ clientId, redirectUri, scopes, state, prompt }) {
      // Scope spaces MUST be %20-encoded (docs example:
      // `identify%20guilds%20guilds.members.read`); URLSearchParams would
      // emit '+' which the docs do not quote as accepted — build scope
      // separately with encodeURIComponent to match the documented form.
      const enc = encodeURIComponent;
      const query = [
        `response_type=${enc("code")}`,
        `client_id=${enc(clientId)}`,
        `scope=${scopes.map(enc).join("%20")}`,
        `redirect_uri=${enc(redirectUri)}`,
        `state=${enc(state)}`,
        `prompt=${enc(prompt)}`,
      ].join("&");
      return `${authBase}/oauth2/authorize?${query}`;
    },

    /**
     * Exchange the single-use authorization code for the user's access
     * token. form-urlencoded + HTTP Basic — never JSON (docs: JSON → 400).
     *
     * @param {object} params
     * @param {string} params.code
     * @param {string} params.redirectUri byte-identical to authorize
     * @param {string} params.clientId
     * @param {string} params.clientSecret
     * @returns {Promise<TokenResponse>}
     */
    async exchangeCode({ code, redirectUri, clientId, clientSecret }) {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      const res = await doFetch(`${base}/oauth2/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(
          json?.error || `discord token exchange HTTP ${res.status}`
        );
        err.code = "discord_token_exchange";
        err.status = res.status;
        throw err;
      }
      if (!json?.access_token || typeof json.access_token !== "string") {
        const err = new Error("discord token response missing access_token");
        err.code = "discord_token_shape";
        throw err;
      }
      const expiresInSec =
        Number.isFinite(Number(json.expires_in)) && Number(json.expires_in) > 0
          ? Number(json.expires_in)
          : 604_800; // documented default lifetime (7 d)
      return {
        accessToken: json.access_token,
        expiresAt: Date.now() + expiresInSec * 1000,
        scopes: typeof json.scope === "string" ? json.scope : null,
      };
    },

    /**
     * `GET /users/@me` — identity under the user's own token (id is the
     * ONLY key we match on; never usernames, §8.3).
     * @param {string} accessToken
     * @returns {Promise<{id: string, username?: string, global_name?: string|null}>}
     */
    getCurrentUser(accessToken) {
      return getApi("/users/@me", accessToken);
    },

    /**
     * `GET /users/@me/guilds` — ALL of the user's guilds (basic partial
     * guild objects; `owner` boolean + `permissions` decimal string are
     * only ever sent here). Intersection with the bot guild list happens
     * in login.js/guildAccess — NOT here.
     * @param {string} accessToken
     * @returns {Promise<Array<object>>}
     */
    async getUserGuilds(accessToken) {
      const list = await getApi("/users/@me/guilds", accessToken);
      return Array.isArray(list) ? list : [];
    },

    /**
     * `GET /users/@me/guilds/{guild.id}/member` — the `guilds.members.read`
     * piece of the §8.3 scope set, for guildAccess (subtask 07).
     * IMPORTANT (live docs): this member object carries `roles` as ROLE IDS
     * ONLY — there is NO computed `permissions` field over REST (that only
     * ever exists in interaction payloads). Resolve effective perms from
     * the ids client-side. Rejects with status 404 when the user is not a
     * member of the guild.
     * @param {string} accessToken
     * @param {string} guildId
     * @returns {Promise<{roles?: string[], joined_at?: string|null, nick?: string|null}>}
     */
    getUserGuildMember(accessToken, guildId) {
      return getApi(
        `/users/@me/guilds/${encodeURIComponent(guildId)}/member`,
        accessToken
      );
    },
  };
}

module.exports = {
  DEFAULT_OAUTH_BASE,
  DEFAULT_API_BASE,
  REQUEST_TIMEOUT_MS,
  createDiscordApi,
};
