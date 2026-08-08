/**
 * Discord slash command visibility sync via OAuth command permissions.
 *
 * No slash commands of its own — used by /staff syncpermissions and HTTP callback.
 */

const { getCommandPermissionOAuthConfig } = require("./config");
const {
  createOAuthState,
  verifyOAuthState,
} = require("./oauthState");
const {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  getValidAccessToken,
  SCOPE,
} = require("./oauthTokens");
const {
  applyGuildCommandPermissions,
  maybeAutoSyncCommandPermissions,
} = require("./sync");
const { buildStaffRoleAllowPermissions } = require("./permissionsPayload");
const {
  handleCommandPermissionOAuthCallback,
} = require("./httpCallback");

function start(_client, _ctx) {
  const cfg = getCommandPermissionOAuthConfig();
  if (!cfg.ready) {
    console.log(
      `[commandPermissions] Visibility sync disabled (missing: ${cfg.missing.join(
        ", "
      )}).`
    );
  } else {
    console.log(
      `[commandPermissions] Visibility sync ready (redirect: ${cfg.redirectUri}).`
    );
  }
}

module.exports = {
  name: "commandPermissions",
  commands: [],
  handlers: {},
  start,
  // re-exports for staffRoles + http server
  getCommandPermissionOAuthConfig,
  createOAuthState,
  verifyOAuthState,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  getValidAccessToken,
  applyGuildCommandPermissions,
  maybeAutoSyncCommandPermissions,
  buildStaffRoleAllowPermissions,
  handleCommandPermissionOAuthCallback,
  SCOPE,
};
