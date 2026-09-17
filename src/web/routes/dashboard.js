/**
 * GET /g/:guildId — the guild dashboard (roadmap/web-admin.md §8.6 row 1:
 * "Dashboard (activity, open tickets, ticker health, now-playing) | Staff |
 * — | 1 (data) / 4 (charts)", subtask 14).
 *
 * GUILD SHELL OWNER: this registrar is mounted FIRST among the /g
 * registrars in app.js, so its guildScope mount (prefix-matched on
 * /g/:guildId) gates EVERY deeper /g/<id>/... route registered after it —
 * exactly once per request. It absorbed the Phase 0c shell placeholder
 * (routes/guildShell.js, deleted in the post-merge cleanup: that module's
 * GET was unreachable behind this one and its second scope mount only
 * re-resolved from the shared TTL cache). Behavior contract preserved
 * EXACTLY (pinned by test/web-views-layout.test.js
 * + test/web-auth-login.test.js):
 *  - the SAME guildScope middleware semantics run first (anon/reauth ⇒
 *    byte-identical login redirect; scoped-out/cross-guild/bad id ⇒ the
 *    generic plain "Not found", never 403 — §8.6 cross-cutting rule);
 *  - the guild switcher still comes from the SAME resolver.listGuilds the
 *    gate decided on (bot∩user; current guild always present), and the
 *    resolver INSTANCE is shared with the shell by publishing it onto the
 *    options object (one TTL cache for both registrars, §8.3);
 *  - requireTier("staff") inside the route per §8.6 (guildScope already
 *    rejects no-tier visitors with 404 — this is the explicit Phase 1
 *    tier-gate, mirroring the usage documented in middleware/requireTier.js).
 *
 * 404 SHAPE DECISION (kept from the shell's header): scoped misses inside
 * /g/* intentionally keep the app-wide plain-text "Not found" — guildScope
 * already answers every deny with it, unmatched /g paths fall through to
 * the app catch-all (same bytes), and unknown/cross-guild/nonexistent must
 * stay indistinguishable. A shell-styled error page exists
 * (views/layout.js renderShellError) for routes that need richer in-shell
 * errors WITHOUT touching that indistinguishability contract.
 *
 * Read-only page (Phase 1): NO mutation routes are registered here. Data
 * comes exclusively from src/web/data/dashboardData.js — facade-only reads,
 * per-guild cache ≥30 s (§8.6 query budget). Handler never calls SQL.
 */

const { createGuildAccessResolver } = require("../auth/guildAccess");
const { createGuildScopeMiddleware } = require("../middleware/guildScope");
const { requireTier } = require("../middleware/requireTier");
const { renderShellPage, writeShellHtml } = require("../views/layout");
const { renderDashboardContent } = require("../views/dashboard/dashboardPage");
const {
  getDefaultDashboardData,
  createDashboardData,
} = require("../data/dashboardData");
const { renderLayout } = require("../views/layout");
const { renderGuildListBody } = require("../views/root");
const { resolveMemberNames } = require("./shared/discord-cache");

/** Root guild-list render cap (resolve() per row is cache-cheap, but stay bounded). */
const MAX_ROOT_GUILDS = 30;

/** Login redirect framing identical to the ticket surface's (anonymous "/"). */
function respondLoginRedirectRoot(res) {
  res.writeHead(302, {
    Location: "/auth/login",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end();
}

/**
 * @param {import("express").Express} app
 * @param {object} [options]
 * @param {{resolve: Function, listGuilds: Function}} [options.guildAccess]
 *   pre-built resolver (tests); default builds one from the seams below —
 *   and PUBLISHES it onto this options object so the register calls that
 *   follow in app.js share the SAME instance (single tier cache, single
 *   Discord read budget).
 * @param {string} [options.apiBase] @param {typeof fetch} [options.fetchImpl]
 * @param {() => Promise<string[]>|string[]} [options.botGuilds]
 * @param {{getDashboard: Function}} [options.dashboardData]
 *   pre-built createDashboardData() instance (tests inject counting/fake
 *   ones; production default is the process-wide lazily-built singleton).
 * @param {Function} [options.getNowPlaying] now-playing provider for the
 *   default data source (boot wiring; ignored when dashboardData is given).
 * @param {Function} [options.getTickerHealth] ticker provider override for
 *   the default data source (default: data/tickerHealth.js registry).
 */
function registerDashboardRoutes(app, options = {}) {
  const resolver =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });
  // Shared-instance wiring (see the JSDoc above): every later /g registrar
  // in app.js re-reads options.guildAccess, so all share this resolver.
  options.guildAccess = resolver;

  const dashboard =
    options.dashboardData ||
    (options.getNowPlaying || options.getTickerHealth
      ? createDashboardData({
          getNowPlaying: options.getNowPlaying,
          getTickerHealth: options.getTickerHealth,
        })
      : getDefaultDashboardData());

  // Security gate FIRST — prefix-matched so it also gates every deeper /g
  // route registered after this one (anon redirect / generic 404s are
  // guildScope's documented behavior).
  app.use("/g/:guildId", createGuildScopeMiddleware({ resolver }));

  // ---- ROOT PAGE = guild list (UX v1.1, §8.15) ----------------------------
  // Replaces the legacy "/" alias of the transcript archive (archive keeps
  // its canonical /t route; the "/" → archive parity tests were retargeted
  // as part of this accepted change). Anonymous ⇒ same login redirect the
  // ticket surface used to give; authenticated ⇒ the viewer's OWN staff
  // guilds (bot∩user ∩ tier-resolvable) — never the bot's full list.
  app.get("/", async (req, res) => {
    if (!req.webSession) {
      respondLoginRedirectRoot(res);
      return;
    }
    try {
      const listed = await resolver.listGuilds(req.webSession);
      if (listed.reauth) {
        respondLoginRedirectRoot(res);
        return;
      }
      const capped = listed.guilds.slice(0, MAX_ROOT_GUILDS);
      const rows = [];
      for (const g of capped) {
        const access = await resolver.resolve(req.webSession, g.id);
        rows.push({
          id: g.id,
          name: g.name,
          tier: access.status === "ok" ? access.tier : null,
        });
      }
      const document = renderLayout({
        title: "Guilds",
        heading: "Your guilds",
        subheading: rows.length
          ? "Pick a guild to open its console."
          : null,
        content: renderGuildListBody({
          rows,
          degraded: !!listed.degraded,
          truncated: listed.guilds.length > capped.length,
        }),
        currentGuildId: null,
        tier: null,
        user: req.user || null,
        csrfToken: req.csrfToken || null,
        nonce: (req.res && req.res.locals ? req.res.locals.cspNonce : "") || "",
      });
      writeShellHtml(req, res, { status: 200, document });
    } catch (err) {
      console.error("[web] root guild list failed:", err?.code || err?.message || err);
      res.writeHead(500, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end("Internal error");
    }
  });

  app.get("/g/:guildId", requireTier("staff"), async (req, res) => {
    const guildId = req.guildAccess.guildId;
    // One cached per-guild snapshot (30 s floor). Sections degrade
    // individually inside; only a programmer error reaches here as a throw,
    // which the app's terminal error middleware turns into the generic 500.
    const data = await dashboard.getDashboard(guildId);

    // UX v1.1 (§8.15): resolve member display names for the rows this
    // snapshot shows — cache-only seam, miss ⇒ raw id labels in the view.
    const nameIds = [
      ...((data && data.tickets && data.tickets.newest) || []).map((t) => t.creatorUserId),
      ...((data && data.activity && data.activity.xpLeaders) || []).map((l) => l.userId),
    ];

    // Switcher from the SAME cached list resolve() just gated against
    // (normally zero network) — the viewed guild always renders even if the
    // degraded read came back empty (shell doctrine: the viewed guild always renders).
    const listed = await resolver.listGuilds(req.webSession);
    const guilds = listed.guilds.slice();
    if (!guilds.some((g) => g.id === guildId)) {
      guilds.unshift({ id: guildId, name: guildId });
    }

    const document = renderShellPage(req, {
      title: "Console",
      heading: "Dashboard",
      subheading:
        "Live guild overview — open tickets, activity, background jobs, now-playing.",
      content: renderDashboardContent(data, {
        guildId,
        names: resolveMemberNames(options.getClient, guildId, nameIds),
      }),
      guilds,
    });
    writeShellHtml(req, res, { status: 200, document });
  });
}

module.exports = {
  registerDashboardRoutes,
};
