/**
 * Express 5 app factory for the public HTTP surface (roadmap/web-admin.md
 * §8.2). PURE FACTORY: no listen(), no env reads, no module-level state —
 * createWebApp() returns a ready app that server.js (or a test) binds to an
 * ephemeral port itself.
 *
 * Byte-identical mode (Phase 0a contract, test/web-http-net.test.js is the
 * oracle):
 *  - responses go through raw `res.writeHead()/res.end()` only — never
 *    res.send()/res.json() — so Express adds no ETag, charset, or extra
 *    framing versus the legacy node:http handler;
 *  - a GET/HEAD method gate runs BEFORE the router: the Express 5 router
 *    would answer method mismatches with its own 405 + Allow header, but
 *    the legacy server answered every non-GET/HEAD with
 *    `405 "Method not allowed"` (plain text) on every path, known or not;
 *    the single Phase 0b exception is POST on the exact path /auth/logout
 *    (see methodGate) — everything else still 405s byte-identically;
 *  - handlers parse the RAW req.url (never req.query) so the Express 5
 *    "simple" query-parser default and path-to-regexp decoding cannot
 *    change behavior;
 *  - x-powered-by disabled, etag generation off (defense in depth).
 */

const express = require("express");
const { registerTranscriptRoutes } = require("./routes/transcripts");
const { registerOauthRoutes } = require("./routes/oauth");
const { registerAuthRoutes } = require("./routes/auth");
const { registerGuildShellRoutes } = require("./routes/guildShell");
const { registerUsersRoutes } = require("./routes/users");
const { registerModerationRoutes } = require("./routes/moderation");
const { registerSettingsRoutes } = require("./routes/settings");
const { registerStaffRoutes } = require("./routes/staff");
const { registerIntegrationsRoutes } = require("./routes/integrations");
const { registerLeaderboardRoutes } = require("./routes/leaderboard");
const { registerDashboardRoutes } = require("./routes/dashboard");
const { registerVoiceRoutes } = require("./routes/voice");
const { registerSystemRoutes } = require("./routes/system");
const { createSessionMiddleware } = require("./middleware/session");
const {
  createAuthRateLimit,
  createMutationRateLimit,
  createBodyCapMiddleware,
} = require("./middleware/rateLimit");
const { createCsrfMiddleware } = require("./middleware/csrf");
const { createCspMiddleware } = require("./middleware/csp");
const { createStaticMiddleware } = require("./middleware/static");

/**
 * The ONE POST path the legacy method gate makes an exception for (§8.3
 * logout is a POST). Exact-path match on the RAW url (query stripped, no
 * decoding — same parsing rule as everything else here): /auth/logout/
 * (trailing slash), /auth/login, tickets, and the OAuth callback keep
 * answering 405 exactly as the Phase 0a oracle asserts.
 */
const LOGOUT_POST_PATH = "/auth/logout";

/**
 * Legacy dispatch gate: anything but GET/HEAD is rejected before routing
 * (POST /auth/logout is the single audited exception).
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {() => void} next
 */
function methodGate(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD") {
    next();
    return;
  }
  const path = String(req.url || "/").split("?")[0];
  if (req.method === "POST" && path === LOGOUT_POST_PATH) {
    next();
    return;
  }
  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method not allowed");
}

/**
 * Liveness probe (stays public even after Phase 0c login-gating).
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
function handleHealth(req, res) {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(req.method === "HEAD" ? undefined : "ok");
}

/**
 * Catch-all 404 for paths no route claimed (matches the legacy body).
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
function handleNotFound(req, res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

/**
 * Terminal error middleware (arity must stay exactly 4 — Express 5 skips
 * non-4-arg functions). Mirrors the legacy wrapper around handleRequest.
 * @param {Error} err
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {(err: Error) => void} next
 */
function handleAppError(err, req, res, next) {
  console.error("[http] handler error:", err);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Internal error");
}

/**
 * Build the web admin / transcript app (no I/O, no listener).
 * @param {object} [options]
 * @param {string} [options.apiBase] Discord API base for the auth AND guild
 *   access routes (tests point this at a local fake; production unset → real
 *   Discord). OAuth/session surfaces are unaffected; the ticket surface
 *   gates on login + guildAccess (§8.4) but its authenticated responses keep
 *   the Phase 0a byte-parity contract.
 * @param {string} [options.oauthBase]
 * @param {() => string[]|Set<string>} [options.botGuilds] bot-guild provider
 *   override (tests); production wiring lives in features/web boot.
 * @param {{resolve: Function, listGuilds: Function}} [options.guildAccess]
 *   pre-built createGuildAccessResolver() instance for the /g shell AND the
 *   §8.4 ticket gate (tests inject fakes; default builds one from
 *   apiBase/fetchImpl/botGuilds).
 * @returns {import("express").Express}
 */
function createWebApp(options = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  // Phase 0c (subtask 11, §8.7): CSP + per-response script nonce BEFORE any
  // responder, so even the methodGate's 405 and the catch-all 404 carry the
  // policy and nosniff. Headers are set via res.setHeader() — the routes'
  // raw writeHead() framing MERGES them in, which adds headers but never
  // changes a body byte (the Phase 0a oracle only pins bodies + its own
  // headers, so the byte-parity contract survives; verified green).
  app.use(createCspMiddleware());

  app.use(methodGate);
  // Phase 0b: resolve the session cookie for downstream auth (req.webSession
  // / req.user). Read-only middleware — it never writes the response, so the
  // byte-parity contract above is unaffected. Mounted after methodGate so
  // 405 rejections skip DB work entirely.
  app.use(createSessionMiddleware());
  // Phase 0b security middlewares (subtask 08, roadmap §8.7). GET/HEAD pay
  // at most an HMAC here, so the Phase 0a byte-parity contract is untouched;
  // everything below activates the moment a request survives methodGate —
  // today that includes POST /auth/logout, which CSRF-gates like every
  // other mutation (the form/htmx call must send `X-CSRF-Token` or `_csrf`).
  //   1. auth-bucket limiter on /auth/* (per IP + per user) — counts GETs
  //      too, since login/callback are GET routes;
  //   2. body cap: generic 413 past WEB_MAX_BODY_BYTES, then the drained
  //      bytes are exposed as req.rawBody / req.bodyFields (req.body is
  //      defaulted to the parsed fields). CONTRACT for route authors: read
  //      those — do NOT mount express.json/urlencoded on top of this, the
  //      stream is already consumed here;
  //   3. mutation-bucket limiter (per user, IP fallback) on every non-GET —
  //      runs BEFORE CSRF so failed token attempts count against the actor;
  //   4. CSRF: derives req.csrfToken for views/htmx, auto-enforces /g/ and
  //      /auth/ mutations, and attaches req.requireCsrf for route-level
  //      opt-in elsewhere (createRequireCsrf() is the standalone factory).
  app.use("/auth", createAuthRateLimit());
  app.use(createBodyCapMiddleware());
  app.use(createMutationRateLimit());
  app.use(createCsrfMiddleware());
  // Shell assets (vendored htmx, styles.css, app.js) — public, immutable-
  // cached, dotfiles ignored, traversal-gated (src/web/middleware/static.js).
  // Mounted after the method gate so POST /static/* still 405s like the rest
  // of the surface; nothing here carries user data, so login-free is safe.
  app.use("/static", createStaticMiddleware());
  app.get("/health", handleHealth);
  // Login/logout first: they must resolve without (and while rotating) any
  // session, and they are the only writers of the session cookie.
  registerAuthRoutes(app, {
    apiBase: options.apiBase,
    oauthBase: options.oauthBase,
    fetchImpl: options.fetchImpl,
    botGuilds: options.botGuilds,
  });
  registerOauthRoutes(app);
  // Guild shell (Phase 0c): scoped pages, guild switcher, login redirect for
  // anonymous /g/*. The injectable seams keep it offline-testable against
  // the same fake Discord the login routes use (guildScope needs
  // getUserGuilds + getUserGuildMember, bot∩user intersection).
  registerDashboardRoutes(app, options);
  registerGuildShellRoutes(app, {
    guildAccess: options.guildAccess,
    apiBase: options.apiBase,
    fetchImpl: options.fetchImpl,
    botGuilds: options.botGuilds,
  });
  // Ticket surface (Phase 0c, subtask 12): login-mandatory + staff-or-
  // participant gate (§8.4). Gets the SAME resolver seams as the /g shell —
  // an injected guildAccess covers both surfaces, so tests and future
  // wiring never diverge on tier math.
  registerTranscriptRoutes(app, {
    guildAccess: options.guildAccess,
    apiBase: options.apiBase,
    fetchImpl: options.fetchImpl,
    botGuilds: options.botGuilds,
  });
  // Users surface (Phase 1, subtask 15): unified profile + senior Activity tab
  // (§8.6). Registered AFTER the guild shell so /g/:guildId guildScope runs
  // first; same resolver seams as the shell keep tier math undivided.
  registerUsersRoutes(app, { guildAccess: options.guildAccess, apiBase: options.apiBase, fetchImpl: options.fetchImpl, botGuilds: options.botGuilds, getClient: options.getClient });
  // Moderation lists (Phase 1, subtask 17): guild-wide warnings + staff notes
  // (§8.6 Staff row, read-only). Registered after the shell like the other
  // Phase 1 surfaces so /g/:guildId guildScope gates first; same resolver
  // seams keep tier math undivided. Warn/issue/void writes land in Phase 3.
  registerModerationRoutes(app, { guildAccess: options.guildAccess, apiBase: options.apiBase, fetchImpl: options.fetchImpl, botGuilds: options.botGuilds });
  // Settings surface (Phase 1, subtask 18): read-only guild settings view
  // (§8.6 Staff row). Also AFTER the guild shell so /g/:guildId guildScope
  // gates it; same shared resolver instance keeps tier math undivided.
  registerSettingsRoutes(app, { guildAccess: options.guildAccess, apiBase: options.apiBase, fetchImpl: options.fetchImpl, botGuilds: options.botGuilds, getClient: options.getClient, settingsData: options.settingsData });
  // Leaderboard surface (Phase 1, subtask 16): paginated top-XP board +
  // per-user rank/level page (§8.6 XP row, staff tier). AFTER the guild
  // shell so /g/:guildId guildScope gates first; same shared resolver
  // instance keeps tier math undivided. Grant-xp stays Phase 3 / slash.
  registerLeaderboardRoutes(app, { guildAccess: options.guildAccess, apiBase: options.apiBase, fetchImpl: options.fetchImpl, botGuilds: options.botGuilds, getClient: options.getClient });
  // Integrations surface (Phase 1, subtask 20): read-only YouTube/Twitch/
  // reaction-roles/event-reminders/honeypot view (§8.6 Integrations row,
  // staff tier). AFTER the guild shell so /g/:guildId guildScope gates
  // first; same shared resolver instance keeps tier math undivided.
  // Per-command writes (incl. /honeypot exempt = admin) land in Phase 2.
  registerIntegrationsRoutes(app, { guildAccess: options.guildAccess, apiBase: options.apiBase, fetchImpl: options.fetchImpl, botGuilds: options.botGuilds, getClient: options.getClient, integrationsData: options.integrationsData });
  registerStaffRoutes(app, { guildAccess: options.guildAccess, apiBase: options.apiBase, fetchImpl: options.fetchImpl, botGuilds: options.botGuilds, getClient: options.getClient, staffData: options.staffData, oauthConfig: options.oauthConfig });
  // Voice & music surface (Phase 1, subtask 21): read-only now-playing/queue
  // + live-voice snapshot (§8.6 Voice & Music row, staff tier; queue CONTROL
  // out of scope §8.9 — GET-only module, zero control routes). AFTER the
  // guild shell so /g/:guildId guildScope gates first; same shared resolver
  // instance keeps tier math undivided.
  registerVoiceRoutes(app, { guildAccess: options.guildAccess, apiBase: options.apiBase, fetchImpl: options.fetchImpl, botGuilds: options.botGuilds, getClient: options.getClient, getPlayerState: options.getPlayerState, getLiveVoice: options.getLiveVoice, voiceData: options.voiceData });
  // System page + admin_audit viewer (Phase 1, subtask 22): process health,
  // ticker registry, web-surface state, command-permission OAuth summary +
  // the read-only admin_audit trail (§8.6 System row = ADMIN tier; cross-
  // guild ⇒ 404, same-guild staff/senior ⇒ 403). AFTER the guild shell so
  // /g/:guildId guildScope gates first; same shared resolver instance keeps
  // tier math undivided. GET-only — the methodGate 405s every verb else.
  registerSystemRoutes(app, { guildAccess: options.guildAccess, apiBase: options.apiBase, fetchImpl: options.fetchImpl, botGuilds: options.botGuilds, getTickerHealth: options.getTickerHealth, staffData: options.staffData, oauthConfig: options.oauthConfig });

  app.use(handleNotFound);
  app.use(handleAppError);
  return app;
}

module.exports = {
  createWebApp,
};
