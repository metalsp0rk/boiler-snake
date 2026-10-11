/**
 * Discord OAuth2 token exchange / refresh for command permissions scope.
 *
 * The `guild_command_permission_oauth` rows are community-keyed (roadmap/
 * fluxer.md § Repository boundary): every storage function here takes the
 * integer `communityId` resolved by the caller at the edge (the OAuth state
 * carries the Discord snowflake; httpCallback.js converts it).
 */

const {
  getCommandPermissionOAuthConfig,
} = require("./config");
const {
  getCommandPermissionOauth,
  upsertCommandPermissionOauth,
  updateCommandPermissionAccessToken,
  deleteCommandPermissionOauth,
} = require("../../db");

const TOKEN_URL = "https://discord.com/api/v10/oauth2/token";
const SCOPE = "applications.commands.permissions.update";
/** Refresh access token this many ms before expiry */
const EXPIRY_SKEW_MS = 60_000;

/**
 * @param {Record<string, string>} form
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {Promise<object>}
 */
async function postToken(form, clientId, clientSecret) {
  const body = new URLSearchParams(form);
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${auth}`,
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      json?.error_description ||
      json?.error ||
      `token exchange HTTP ${res.status}`;
    const err = new Error(String(msg));
    err.code = json?.error || "token_error";
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * Exchange authorization code for tokens and store them.
 * @param {object} opts
 * @param {number} opts.communityId internal communities.id (the OAuth state's
 *   Discord guild id resolved at the callback edge via ensureCommunity)
 * @param {string} opts.code
 * @param {string} [opts.authorizedByUserId]
 * @returns {Promise<{ accessToken: string }>}
 */
async function exchangeAuthorizationCode(opts) {
  const cfg = getCommandPermissionOAuthConfig();
  if (!cfg.ready) {
    throw new Error(`OAuth not configured: missing ${cfg.missing.join(", ")}`);
  }

  const json = await postToken(
    {
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: cfg.redirectUri,
    },
    cfg.clientId,
    cfg.clientSecret
  );

  if (!json.refresh_token || !json.access_token) {
    throw new Error("Token response missing refresh_token or access_token");
  }

  const expiresIn = Number(json.expires_in) || 604800;
  const accessExpiresAt = Date.now() + expiresIn * 1000;

  upsertCommandPermissionOauth(opts.communityId, {
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    accessExpiresAt,
    authorizedByUserId: opts.authorizedByUserId,
  });

  return { accessToken: json.access_token };
}

/**
 * Per-community refresh single-flight (audit §6 P1 #193): concurrent
 * getValidAccessToken callers for the same community must await ONE refresh —
 * Discord rotates refresh tokens, so parallel refreshes race each other and
 * the loser used to poison the stored grant. Module-local map
 * communityId → in-flight promise; entries are removed on settle (both
 * outcomes) so a failed refresh never poisons the next attempt.
 * @type {Map<number, Promise<string>>}
 */
const refreshInFlight = new Map();

/**
 * Access token from a stored row that is still inside its validity window
 * (same skew rule as the fast path).
 * @param {object|null} row row from guild_command_permission_oauth
 * @returns {string|null}
 */
function pickUsableAccessToken(row) {
  if (
    row?.access_token &&
    row.access_expires_at &&
    Number(row.access_expires_at) > Date.now() + EXPIRY_SKEW_MS
  ) {
    return row.access_token;
  }
  return null;
}

/**
 * Ensure a valid access token for a community (refresh if needed).
 *
 * Single-flight: at most ONE refresh per community at a time; later callers
 * join the in-flight refresh instead of issuing a second token POST.
 *
 * @param {number} communityId
 * @returns {Promise<string>} access token
 */
async function getValidAccessToken(communityId) {
  const row = getCommandPermissionOauth(communityId);
  if (!row?.refresh_token) {
    const err = new Error("Guild has not authorized command permission sync");
    err.code = "not_authorized";
    throw err;
  }

  const cached = pickUsableAccessToken(row);
  if (cached) return cached;

  const inFlight = refreshInFlight.get(communityId);
  if (inFlight) return inFlight;

  const run = refreshAccessToken(communityId, row);
  // Detached settle handler (resolves either way, so a rejecting refresh can
  // never surface as an unhandledRejection here): clears ONLY our own entry,
  // never a newer refresh's. `return run` below gives every caller its own
  // handled branch onto the same promise.
  const settle = () => {
    if (refreshInFlight.get(communityId) === run) {
      refreshInFlight.delete(communityId);
    }
  };
  run.then(settle, settle);
  refreshInFlight.set(communityId, run);
  return run;
}

/**
 * One refresh_token grant for one community. Only ever started via the
 * single-flight wrapper in getValidAccessToken.
 *
 * @param {number} communityId
 * @param {object} row the stored row captured BEFORE the refresh started
 *   (its refresh_token is what we send, its updated_at is the race marker)
 * @returns {Promise<string>} access token
 */
async function refreshAccessToken(communityId, row) {
  const cfg = getCommandPermissionOAuthConfig();
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("CLIENT_ID / CLIENT_SECRET required to refresh token");
  }

  const refreshTokenUsed = row.refresh_token;
  const updatedAtBefore = Number(row.updated_at) || 0;

  try {
    const json = await postToken(
      {
        grant_type: "refresh_token",
        refresh_token: refreshTokenUsed,
      },
      cfg.clientId,
      cfg.clientSecret
    );

    if (!json.access_token) {
      throw new Error("Refresh response missing access_token");
    }

    const expiresIn = Number(json.expires_in) || 604800;
    const accessExpiresAt = Date.now() + expiresIn * 1000;
    updateCommandPermissionAccessToken(
      communityId,
      json.access_token,
      accessExpiresAt,
      json.refresh_token || undefined
    );
    return json.access_token;
  } catch (err) {
    if (err.status === 400 || err.status === 401) {
      // Audit §6 P1 #193: a 4xx here does NOT necessarily mean the guild's
      // grant died. Discord rotates refresh tokens, so a refresh issued with
      // a stale copy 400s invalid_grant AFTER a winner's refresh (parallel
      // request, another process, or a fresh /staff syncpermissions consent)
      // already replaced the stored tokens. Deleting then destroys a perfectly
      // good grant. Re-read first: only the token WE used dying means the
      // grant is genuinely revoked.
      const current = getCommandPermissionOauth(communityId);
      if (
        current &&
        (current.refresh_token !== refreshTokenUsed ||
          (Number(current.updated_at) || 0) !== updatedAtBefore)
      ) {
        // A winner's refresh/re-auth won the race — keep the grant and serve
        // the winner's token when it is still valid. If it is already past
        // the skew window the NEXT call refreshes with the winner's refresh
        // token; either way the row stays.
        const winnerToken = pickUsableAccessToken(current);
        if (winnerToken) return winnerToken;
        throw err;
      }
      // Genuine revocation (or the row was already deleted elsewhere — then
      // there is nothing to delete, but re-auth is still required).
      if (current) {
        deleteCommandPermissionOauth(communityId);
      }
      err.code = "reauth_required";
    }
    throw err;
  }
}

/**
 * Build Discord authorize URL for a guild admin.
 * @param {string} state
 * @returns {string}
 */
function buildAuthorizeUrl(state) {
  const cfg = getCommandPermissionOAuthConfig();
  if (!cfg.ready) {
    throw new Error(`OAuth not configured: missing ${cfg.missing.join(", ")}`);
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    scope: SCOPE,
    redirect_uri: cfg.redirectUri,
    state,
    prompt: "consent",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

module.exports = {
  SCOPE,
  exchangeAuthorizationCode,
  getValidAccessToken,
  buildAuthorizeUrl,
};
