/**
 * GET /g/:guildId/staff + GET /g/:guildId/commands — the Phase 1 read-only
 * staff-roles view and command-visibility sync status (roadmap/web-admin.md
 * §8.6 "Staff & roles: staff_roles CRUD + levels | Staff (view) | Admin |
 * 1 view · 2 write" and "Command visibility: sync status + trigger | Staff
 * (view) | Admin (sync) | 1 view · 3 action" — subtask 19).
 *
 * GET ONLY — no POST/PUT/DELETE is registered here (§8.8 Phase 1).
 * staff_roles writes arrive in Phase 2 (subtask 25, Admin tier) and the
 * sync trigger in Phase 3 (subtask 31, Admin tier); the app-wide methodGate
 * 405s every other verb on these paths in the meantime.
 *
 * Route position: registered AFTER routes/guildShell.js in app.js, so the
 * shell's `/g/:guildId` guildScope already ran (anon ⇒ login redirect,
 * cross-guild/stranger ⇒ generic 404 — §8.6 cross-cutting rule, never 403).
 * requireTier("staff") inside each route is the explicit §8.6 view tier.
 *
 * Data: exclusively src/web/data/staffData.js (facade-only reads; the
 * command-permission OAuth row is whitelist-projected onto status fields
 * so refresh/access token columns can never reach a view — §8.1-9/§8.7).
 * The env view of the sync panel comes from the EXISTING
 * features/commandPermissions/config.js reader, SANITIZED here to
 * { available, ready, redirectUri, missing[] } — env values, CLIENT_ID and
 * CLIENT_SECRET are never handed to a view. NO route here triggers OAuth,
 * token refresh, or a permission sync (that is the Phase 3 action).
 *
 * Role labels: cache-only via the optional getClient seam (same pattern as
 * routes/settings.js makeChannelNameResolver) — a cached role name decorates
 * the id; nothing is ever fetched on a request path, and the id alone is
 * always a complete rendering.
 */

const { createGuildAccessResolver } = require("../auth/guildAccess");
const { requireTier } = require("../middleware/requireTier");
const { renderShellPage, writeShellHtml } = require("../views/layout");
const {
  renderStaffBody,
  renderCommandsBody,
} = require("../views/staff");
const { createStaffData } = require("../data/staffData");

/**
 * Cache-only role-name resolver (never network): guildId → roleId →
 * name|null. A missing/throwing client degrades every lookup to null ⇒ the
 * page renders ids, exactly like the slash /staff list does for unknown
 * roles.
 * @param {(() => any)|null|undefined} getClient
 * @param {string} guildId
 */
function makeRoleNameResolver(getClient, guildId) {
  return function resolveRoleName(roleId) {
    try {
      const client = typeof getClient === "function" ? getClient() : null;
      const name = client?.guilds?.cache?.get?.(guildId)?.roles?.cache?.get?.(
        roleId
      )?.name;
      if (typeof name !== "string") return null;
      const trimmed = name.trim();
      return trimmed ? trimmed.slice(0, 100) : null;
    } catch {
      return null;
    }
  };
}

/**
 * Read + SANITIZE the command-permission OAuth env config (§8.7): the raw
 * reader also returns clientId/clientSecret — NONE of that leaves this
 * function. `missing` entries are env-variable NAMES by construction
 * (e.g. "CLIENT_SECRET"), never values.
 * @param {() => any} oauthConfigFn
 */
function readEnvConfig(oauthConfigFn) {
  try {
    const cfg = oauthConfigFn();
    return {
      available: true,
      ready: !!cfg.ready,
      redirectUri: typeof cfg.redirectUri === "string" ? cfg.redirectUri : null,
      missing: Array.isArray(cfg.missing)
        ? cfg.missing.filter((m) => typeof m === "string").map((m) => m.slice(0, 120))
        : [],
    };
  } catch {
    return { available: false, ready: false, redirectUri: null, missing: [] };
  }
}

/** Shared switcher list (same contract as routes/settings.js shellGuilds). */
async function shellGuilds(resolver, req) {
  const listed = await resolver.listGuilds(req.webSession);
  const guilds = listed.guilds.slice();
  const currentId = req.guildAccess.guildId;
  if (!guilds.some((g) => g.id === currentId)) {
    guilds.unshift({ id: currentId, name: currentId });
  }
  return guilds;
}

/**
 * @param {import("express").Express} app
 * @param {object} [options]
 * @param {{resolve: Function, listGuilds: Function}} [options.guildAccess]
 *   pre-built resolver (app.js passes the SAME instance the guild shell
 *   uses — one tier cache, §8.3); default builds one from the seams below.
 * @param {string} [options.apiBase] @param {typeof fetch} [options.fetchImpl]
 * @param {() => string[]|Promise<string[]>} [options.botGuilds]
 * @param {(() => import("discord.js").Client|null)|null} [options.getClient]
 *   live bot client (cache-only role names; null in tests/dark boot).
 * @param {{getStaffView: Function, getOauthStatus: Function}} [options.staffData]
 *   pre-built createStaffData() instance (tests inject counting/fake ones;
 *   default is a process-wide lazily-built singleton).
 * @param {() => any} [options.oauthConfig] env-config reader; default is
 *   the EXISTING features/commandPermissions/config.js reader.
 */
function registerStaffRoutes(app, options = {}) {
  const resolver =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });

  let defaultData = null;
  const getData = () => {
    if (!defaultData) defaultData = createStaffData();
    return defaultData;
  };
  const staffData = options.staffData || {
    getStaffView: (guildId) => getData().getStaffView(guildId),
    getOauthStatus: (guildId) => getData().getOauthStatus(guildId),
  };

  const oauthConfigFn =
    options.oauthConfig ||
    require("../../features/commandPermissions/config").getCommandPermissionOAuthConfig;

  // ---- staff: staff_roles table view (+ sync panel, §8.6 rows) ------------
  app.get("/g/:guildId/staff", requireTier("staff"), async (req, res, next) => {
    try {
      const guildId = req.guildAccess.guildId;
      const view = staffData.getStaffView(guildId);
      const document = renderShellPage(req, {
        title: "Staff roles",
        heading: "Staff roles",
        subheading:
          "Which roles the bot treats as staff (junior/senior) and the command-visibility sync state — read-only in Phase 1.",
        content: renderStaffBody({
          view,
          resolveRoleName: makeRoleNameResolver(options.getClient, guildId),
          envConfig: readEnvConfig(oauthConfigFn),
        }),
        guilds: await shellGuilds(resolver, req),
      });
      writeShellHtml(req, res, { status: 200, document });
    } catch (err) {
      next(err); // → handleAppError: generic 500, nothing leaked
    }
  });

  // ---- staff: command-visibility sync status page (§8.6 row) --------------
  app.get("/g/:guildId/commands", requireTier("staff"), async (req, res, next) => {
    try {
      const guildId = req.guildAccess.guildId;
      // ONE bounded read — this surface never shows the roles table.
      const view = staffData.getOauthStatus(guildId);
      const document = renderShellPage(req, {
        title: "Command visibility",
        heading: "Command visibility",
        subheading:
          "OAuth authorization + last permission-sync state for the staff-tier slash commands — read-only; triggering stays Admin (Phase 3).",
        content: renderCommandsBody({
          view,
          envConfig: readEnvConfig(oauthConfigFn),
        }),
        guilds: await shellGuilds(resolver, req),
      });
      writeShellHtml(req, res, { status: 200, document });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = {
  registerStaffRoutes,
  makeRoleNameResolver,
  readEnvConfig,
};
