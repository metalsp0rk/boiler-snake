/**
 * Auth route mounting on Express 5 (roadmap/web-admin.md §8.2 layout:
 * routes/ mounts, auth/ owns logic).
 *
 * GET  /auth/login           — public: authorize redirect (login start).
 * GET  /auth/login/callback  — public by design (§8.1 decision 3: only
 *                              /health and OAuth endpoints stay login-free;
 *                              this IS the OAuth endpoint).
 * POST /auth/logout          — destroys the caller's own session; anonymous
 *                              calls are no-ops (idempotent).
 *
 * The login routes are mounted PUBLIC deliberately: login/callback must
 * resolve without a session, and logout must work even when the session is
 * already dead. Access control lives in the gates downstream (guildScope /
 * requireTier, subtask 07) — never here.
 */

const { createLoginHandlers } = require("../auth/login");

/**
 * @param {import("express").Express} app
 * @param {object} [options] dependency overrides forwarded to
 *   createLoginHandlers ({ apiBase, oauthBase, fetchImpl, botGuilds, ... })
 *   — production passes nothing (live Discord + wired bot-guild provider);
 *   tests fake the Discord API base offline.
 */
function registerAuthRoutes(app, options = {}) {
  const { startLogin, handleLoginCallback, logout } =
    createLoginHandlers(options);

  app.get("/auth/login", startLogin);
  // Trailing-slash alias registered explicitly (routes/oauth.js precedent):
  // Discord's redirect URI is registered without it, but the router must
  // not 404 on a hand-typed slash.
  app.get(
    ["/auth/login/callback", "/auth/login/callback/"],
    // Returning the promise lets Express 5 forward unexpected rejections to
    // the terminal error middleware; the handler catches its own failures.
    (req, res) => handleLoginCallback(req, res)
  );
  app.post("/auth/logout", logout);
}

module.exports = {
  registerAuthRoutes,
};
