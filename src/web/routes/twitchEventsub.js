/**
 * Twitch EventSub webhook callback route (POST /hooks/twitch).
 *
 * This is a deliberate PUBLIC carve-out from the byte-parity web surface
 * (roadmap/twitch-notifications.md): Twitch posts here, so it can never be
 * login/CSRF-gated — the HMAC-SHA256 signature check inside the handler is
 * the authentication (mirrors how /auth/* stays login-free and the
 * methodGate already exempts POST /auth/logout). The methodGate lets this
 * exact path through via the PUBLIC_POST_PATHS list in app.js.
 *
 * Handler contract (src/features/twitch/eventsub/callback.js):
 *  - reads the drained raw body from req.rawBody (body-cap middleware) for
 *    signature verification — express JSON parsers must never touch it;
 *  - answers challenge → 200 (raw text), notification → 204 (process
 *    after), revocation → 204, bad signature → 403, disabled/unparseable →
 *    404/400.
 */

const { handleTwitchEventsub } = require("../../features/twitch/eventsub/callback");

const EVENTSUB_PATH = "/hooks/twitch";

/**
 * @param {import("express").Express} app
 * @param {{ getClient?: () => object|null }} [options]
 */
function registerTwitchEventsubRoutes(app, options = {}) {
  app.post(EVENTSUB_PATH, (req, res) =>
    // Returning the promise lets Express 5 forward rejections to the error
    // middleware (same parity pattern as the OAuth callback route).
    handleTwitchEventsub(req, res, {
      getClient: typeof options.getClient === "function" ? options.getClient : undefined,
    }),
  );
}

module.exports = {
  EVENTSUB_PATH,
  registerTwitchEventsubRoutes,
};
