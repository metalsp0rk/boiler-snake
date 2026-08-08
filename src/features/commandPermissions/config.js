/**
 * Env / public HTTP config for command-permission OAuth.
 *
 * Accepts either the ticket HTTP pair or PUBLIC_* aliases.
 */

/**
 * @returns {{ port: number|null, publicBaseUrl: string|null }}
 */
function getPublicHttpConfig() {
  const portRaw =
    process.env.PUBLIC_HTTP_PORT || process.env.TICKET_HTTP_PORT;
  const port =
    portRaw != null && String(portRaw).trim() !== ""
      ? Number(portRaw)
      : null;
  const baseRaw =
    process.env.PUBLIC_BASE_URL || process.env.TICKET_PUBLIC_BASE_URL;
  const publicBaseUrl = baseRaw
    ? String(baseRaw).replace(/\/$/, "")
    : null;
  return {
    port: Number.isFinite(port) && port > 0 ? port : null,
    publicBaseUrl,
  };
}

/**
 * OAuth redirect URI registered in the Discord Developer Portal.
 * @returns {string|null}
 */
function getOAuthRedirectUri() {
  if (process.env.OAUTH_REDIRECT_URI) {
    return String(process.env.OAUTH_REDIRECT_URI).replace(/\/$/, "");
  }
  const { publicBaseUrl } = getPublicHttpConfig();
  if (!publicBaseUrl) return null;
  return `${publicBaseUrl}/oauth/command-permissions/callback`;
}

/**
 * @returns {{
 *   ready: boolean,
 *   clientId: string|null,
 *   clientSecret: string|null,
 *   redirectUri: string|null,
 *   port: number|null,
 *   publicBaseUrl: string|null,
 *   missing: string[],
 * }}
 */
function getCommandPermissionOAuthConfig() {
  const clientId = process.env.CLIENT_ID
    ? String(process.env.CLIENT_ID).trim()
    : null;
  const clientSecret = process.env.CLIENT_SECRET
    ? String(process.env.CLIENT_SECRET).trim()
    : null;
  const { port, publicBaseUrl } = getPublicHttpConfig();
  const redirectUri = getOAuthRedirectUri();

  const missing = [];
  if (!clientId) missing.push("CLIENT_ID");
  if (!clientSecret) missing.push("CLIENT_SECRET");
  if (!port) missing.push("PUBLIC_HTTP_PORT or TICKET_HTTP_PORT");
  if (!publicBaseUrl && !process.env.OAUTH_REDIRECT_URI) {
    missing.push("PUBLIC_BASE_URL or TICKET_PUBLIC_BASE_URL (or OAUTH_REDIRECT_URI)");
  }
  if (!redirectUri) missing.push("OAuth redirect URI");

  return {
    ready: missing.length === 0,
    clientId,
    clientSecret,
    redirectUri,
    port,
    publicBaseUrl,
    missing,
  };
}

/**
 * Secret for signing OAuth state (prefer dedicated secret).
 * @returns {string|null}
 */
function getOAuthStateSecret() {
  if (process.env.OAUTH_STATE_SECRET) {
    return String(process.env.OAUTH_STATE_SECRET);
  }
  if (process.env.CLIENT_SECRET) {
    return String(process.env.CLIENT_SECRET);
  }
  return null;
}

module.exports = {
  getPublicHttpConfig,
  getOAuthRedirectUri,
  getCommandPermissionOAuthConfig,
  getOAuthStateSecret,
};
