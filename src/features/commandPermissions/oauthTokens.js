/**
 * Discord OAuth2 token exchange / refresh for command permissions scope.
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
 * @param {string} opts.guildId
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

  upsertCommandPermissionOauth(opts.guildId, {
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    accessExpiresAt,
    authorizedByUserId: opts.authorizedByUserId,
  });

  return { accessToken: json.access_token };
}

/**
 * Ensure a valid access token for the guild (refresh if needed).
 * @param {string} guildId
 * @returns {Promise<string>} access token
 */
async function getValidAccessToken(guildId) {
  const row = getCommandPermissionOauth(guildId);
  if (!row?.refresh_token) {
    const err = new Error("Guild has not authorized command permission sync");
    err.code = "not_authorized";
    throw err;
  }

  const now = Date.now();
  if (
    row.access_token &&
    row.access_expires_at &&
    Number(row.access_expires_at) > now + EXPIRY_SKEW_MS
  ) {
    return row.access_token;
  }

  const cfg = getCommandPermissionOAuthConfig();
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("CLIENT_ID / CLIENT_SECRET required to refresh token");
  }

  try {
    const json = await postToken(
      {
        grant_type: "refresh_token",
        refresh_token: row.refresh_token,
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
      guildId,
      json.access_token,
      accessExpiresAt,
      json.refresh_token || undefined
    );
    return json.access_token;
  } catch (err) {
    if (err.status === 400 || err.status === 401) {
      deleteCommandPermissionOauth(guildId);
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
