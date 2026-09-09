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
 *  - the method gate runs BEFORE the router: the Express 5 router would
 *    answer method mismatches with its own 405 + Allow header, but the
 *    legacy server answered every non-GET/HEAD with
 *    `405 "Method not allowed"` (plain text) on every path, known or not;
 *    exceptions are POST on the exact path /auth/logout and boot-registered
 *    /g/ mutation routes (registerWebMutation — see makeMethodGate);
 *    everything else still 405s byte-identically;
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
const { registerXpActionsRoutes } = require("./routes/xpActions");
const { registerTicketActionsRoutes } = require("./routes/ticketActions");
const { createSessionMiddleware } = require("./middleware/session");
const {
  createAuthRateLimit,
  createMutationRateLimit,
  createBodyCapMiddleware,
} = require("./middleware/rateLimit");
const { createCsrfMiddleware } = require("./middleware/csrf");
const { createCspMiddleware } = require("./middleware/csp");
const { createStaticMiddleware } = require("./middleware/static");
const { createAuditMiddleware } = require("./middleware/audit");

/**
 * The ONE POST path the method gate makes an exception for without a
 * registry entry (§8.3 logout is a POST). Exact-path match on the RAW url
 * (query stripped, no decoding — same parsing rule as everything else
 * here): /auth/logout/ (trailing slash), /auth/login, tickets, /static,
 * and the OAuth callback keep answering 405 exactly as the Phase 0a
 * oracle asserts.
 */
const LOGOUT_POST_PATH = "/auth/logout";

/**
 * Segment-wise match of a raw path against a mounted mutation template
 * (templates are the literal Express mount paths, e.g.
 * "/g/:guildId/settings/decay"). ":guildId" matches exactly one non-empty
 * segment; every other segment is a byte-exact literal. No decoding, no
 * trailing-slash leniency — same strict parsing doctrine as the rest of
 * app.js, so unregistered junk under /g/ keeps failing to the 405.
 * @param {string} rawPath
 * @param {string} template
 * @returns {boolean}
 */
function matchesMutationPath(rawPath, template) {
  const raw = rawPath.split("/");
  const tpl = template.split("/");
  if (raw.length !== tpl.length) return false;
  for (let i = 0; i < tpl.length; i++) {
    if (tpl[i] === ":guildId") {
      if (raw[i] === "") return false;
      continue;
    }
    if (raw[i] !== tpl[i]) return false;
  }
  return true;
}

/**
 * Method policy — one source of truth, 405-before-everything doctrine
 * preserved from Phase 0a:
 *  - GET/HEAD: always proceed (unchanged).
 *  - POST /auth/logout: proceeds (unchanged 0b exception).
 *  - ANY other non-GET/HEAD: proceeds ONLY if the raw path matches a
 *    mutation route registered via registerWebMutation() at boot (exact
 *    template match). Everything else gets the legacy byte-identical
 *    405 "Method not allowed" BEFORE rate limiters, CSRF, auth, or the
 *    router — unregistered junk never reaches CSRF (which would 403),
 *    and the Phase-1 read-page suites' 405 pins stay byte-exact.
 * @param {Array<{method: string, path: string}>} mutations
 */
function makeMethodGate(mutations) {
  return function methodGate(req, res, next) {
    if (req.method === "GET" || req.method === "HEAD") {
      next();
      return;
    }
    const path = String(req.url || "/").split("?")[0];
    if (req.method === "POST" && path === LOGOUT_POST_PATH) {
      next();
      return;
    }
    for (const m of mutations) {
      if (m.method === req.method && matchesMutationPath(path, m.path)) {
        next();
        return;
      }
    }
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
  };
}

/**
 * Boot-time registration of a web mutation route (Phase 2/3 contract):
 * route modules MUST call this with the EXACT template they mount
 * (e.g. "POST", "/g/:guildId/settings/decay") so the method gate lets it
 * through — the gate runs before CSRF/rate-limit/router by design and
 * byte-405s anything unregistered. Keep the register call and the
 * app.post(...) path in lockstep (subtask suites pin both).
 * @param {{ locals: { webMutations: Array<{method: string, path: string}> } }} app
 * @param {string} method HTTP verb, upper-case
 * @param {string} path Express mount template
 */
function registerWebMutation(app, method, path) {
  const m = { method: String(method).toUpperCase(), path };
  if (!m.path.startsWith("/g/") || !m.path.includes(":guildId")) {
    throw new Error(`mutation mount must be /g/:guildId-scoped: ${m.path}`);
  }
  if (m.method === "GET" || m.method === "HEAD") {
    throw new Error(`mutations must not use ${m.method}: ${m.path}`);
  }
  app.locals.webMutations.push(m);
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
  // Mutation registry (Phase 2/3): route modules add entries via
  // registerWebMutation(app, ...) at mount time; makeMethodGate reads the
  // SAME array reference on every request.
  app.locals.webMutations = [];

  // Phase 0c (subtask 11, §8.7): CSP + per-response script nonce BEFORE any
  // responder, so even the methodGate's 405 and the catch-all 404 carry the
  // policy and nosniff. Headers are set via res.setHeader() — the routes'
  // raw writeHead() framing MERGES them in, which adds headers but never
  // changes a body byte (the Phase 0a oracle only pins bodies + its own
  // headers, so the byte-parity contract survives; verified green).
  app.use(createCspMiddleware());

  app.use(makeMethodGate(app.locals.webMutations));
  // Phase 0b: resolve the session cookie for downstream auth (req.webSession
  // / req.user). Read-only middleware — it never writes the response, so the
  // byte-parity contract above is unaffected. Mounted after methodGate so
  // 405 rejections skip DB work entirely.
  app.use(createSessionMiddleware());
  // Phase 0b audit trail (subtask 09): attaches req.audit — DB-first
  // admin_audit writer with best-effort channel-embed mirror; zero I/O at
  // mount, never writes the response itself (handlers call it post-mutation
  // and a failed insert 500s the request — §8.1-7 fail-closed).
  app.use(createAuditMiddleware());
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
  // Integrations surface (Phase 1 read view subtask 20; Phase 2 writes
  // subtask 26): YouTube/Twitch/reaction-roles/event-reminders/honeypot
  // (§8.6 Integrations row, staff tier; /honeypot exempt = admin). AFTER the
  // guild shell so /g/:guildId guildScope gates first; same shared resolver
  // instance keeps tier math undivided. The *_seam options mirror the
  // settingsData pass-through (tests inject offline fakes; production omits
  // them and the routes use the real service resolvers).
  registerIntegrationsRoutes(app, { guildAccess: options.guildAccess, apiBase: options.apiBase, fetchImpl: options.fetchImpl, botGuilds: options.botGuilds, getClient: options.getClient, integrationsData: options.integrationsData, resolveTwitchUser: options.resolveTwitchUser, lookupYoutubeChannel: options.lookupYoutubeChannel, fetchYoutubeChannelInfo: options.fetchYoutubeChannelInfo, ensureHoneypotWarning: options.ensureHoneypotWarning });
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
  // XP grant action (Phase 3, subtask 28): admin-only grant form + POST (§8.6
  // XP row; /grantxp is ManageGuild-only per AGENTS.md §4). Grants flow
  // EXCLUSIVELY through src/services/awardXp.js — the SAME service the slash
  // calls (award + activity + level→role sync), audit origin 'web'. AFTER the
  // guild shell so /g/:guildId guildScope gates first; same shared resolver
  // instance keeps tier math undivided; getClient stays the cache-only seam.
  registerXpActionsRoutes(app, { guildAccess: options.guildAccess, apiBase: options.apiBase, fetchImpl: options.fetchImpl, botGuilds: options.botGuilds, getClient: options.getClient, services: options.services });
  // Ticket actions (Phase 3, subtask 30): senior-only claim/close/summary-
  // regen forms + POSTs (§8.6 Tickets row "Senior: claim/close/summary
  // regen"). Mutations flow EXCLUSIVELY through the tickets feature's own
  // helpers (facade.claimTicket, close.js softCloseTicket, summary.js
  // summarizeTicket) — the same code the slash handlers run — with audit
  // origin 'web'. AFTER the guild shell so /g/:guildId guildScope gates
  // first; same shared resolver instance keeps tier math undivided;
  // getClient stays the cache-only seam (never a fetch on a request path).
  registerTicketActionsRoutes(app, { guildAccess: options.guildAccess, apiBase: options.apiBase, fetchImpl: options.fetchImpl, botGuilds: options.botGuilds, getClient: options.getClient, services: options.services, ticketActions: options.ticketActions });

  app.use(handleNotFound);
  app.use(handleAppError);
  return app;
}

module.exports = {
  createWebApp,
  registerWebMutation,
  matchesMutationPath,
};
