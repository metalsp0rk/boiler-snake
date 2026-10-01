/**
 * Auth route mounting on Express 5 (roadmap/web-admin.md §8.2 layout:
 * routes/ mounts, auth/ owns logic).
 *
 * GET  /auth/login           — public: sign-in LANDING page (explains the
 *                              console + hands out the ?continue=1 link).
 * GET  /auth/login?continue=1— public: the actual OAuth authorize redirect
 *                              (login start; ?guild=/?next= return targets).
 * GET  /auth/login/callback  — public by design (§8.1 decision 3: only
 *                              /health and OAuth endpoints stay login-free;
 *                              this IS the OAuth endpoint).
 * POST /auth/logout          — destroys the caller's own session; anonymous
 *                              calls are no-ops (idempotent); lands on the
 *                              signed-out landing (SIGNED_OUT_TARGET).
 *
 * The login routes are mounted PUBLIC deliberately: login/callback must
 * resolve without a session, and logout must work even when the session is
 * already dead. Access control lives in the gates downstream (guildScope /
 * requireTier, subtask 07) — never here.
 */

const { createLoginHandlers, createFluxerLoginHandlers } = require("../auth/login");

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

/**
 * Fluxer login routes (roadmap/fluxer.md § Authorize URL, PR 10): one
 * login/callback/logout triple keyed by the instance's 16-hex slug, mounted
 * PUBLIC like the Discord trio (login/callback must resolve without a
 * session; logout must work when the session is already dead).
 *
 * GET  /auth/fluxer/:slug/login        — PKCE + signed-state authorize redirect
 * GET  /auth/fluxer/:slug/callback[/]  — verify, consume, exchange, session
 * POST /auth/fluxer/logout             — clears the FLUXER cookie only (K11)
 *
 * `/auth/fluxer/*` inherits the per-IP/per-user login limiter from app.js's
 * `app.use("/auth", createAuthRateLimit())` prefix mount — no new limiter.
 * Handlers own their error surfaces (entry-point try/catch in auth/login.js),
 * matching registerAuthRoutes' shape: the callback returns its promise so
 * Express 5 forwards any unexpected rejection to the terminal error handler.
 *
 * @param {import("express").Express} app
 * @param {object} [options] dependency overrides forwarded to
 *   createFluxerLoginHandlers ({ fluxerInstances, getCommunityClient,
 *   fetchImpl, ... }) — production threads the getters from features/web;
 *   tests fake a Fluxer instance offline.
 */
function registerFluxerAuthRoutes(app, options = {}) {
  const { startFluxerLogin, handleFluxerLoginCallback, fluxerLogout } =
    createFluxerLoginHandlers(options);

  app.get("/auth/fluxer/:slug/login", startFluxerLogin);
  // Trailing-slash alias registered explicitly (Discord callback precedent):
  // the redirect URI is registered without it, but the router must not 404
  // on a hand-typed slash.
  app.get(
    ["/auth/fluxer/:slug/callback", "/auth/fluxer/:slug/callback/"],
    (req, res) => handleFluxerLoginCallback(req, res)
  );
  app.post("/auth/fluxer/logout", fluxerLogout);
}

module.exports = {
  registerAuthRoutes,
  registerFluxerAuthRoutes,
};
