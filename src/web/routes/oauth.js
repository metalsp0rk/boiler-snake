/**
 * OAuth callback routes on Express 5 (Phase 0a extraction — the
 * command-permissions slash-visibility flow; roadmap/web-admin.md §8.2
 * generalizes these into purpose-tagged state in Phase 0b).
 *
 * GET /oauth/command-permissions/callback — stays public by design (§8.1
 * decision 3: only /health and OAuth endpoints remain login-free).
 */

const {
  handleCommandPermissionOAuthCallback,
} = require("../../features/commandPermissions/httpCallback");

/**
 * Register the OAuth callback routes on an Express app (no listen side
 * effect). The trailing-slash alias is registered explicitly so router
 * strict/trailing-slash settings can never change the legacy surface.
 * @param {import("express").Express} app
 */
function registerOauthRoutes(app) {
  app.get(
    [
      "/oauth/command-permissions/callback",
      "/oauth/command-permissions/callback/",
    ],
    // Returning the promise lets Express 5 forward rejections to the error
    // middleware (router auto-catches rejected promises) — parity with the
    // legacy `Promise.resolve().then(handleRequest).catch(...)` wrapper.
    (req, res) =>
      handleCommandPermissionOAuthCallback(
        req,
        res,
        new URL(req.url || "/", "http://localhost")
      )
  );
}

module.exports = {
  registerOauthRoutes,
};
