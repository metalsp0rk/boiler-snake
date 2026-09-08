/**
 * GET /g/:guildId/integrations — the Phase 1 read-only integrations view
 * (roadmap/web-admin.md §8.6 "Integrations: YouTube, Twitch, reaction
 * roles, event reminders, honeypot | Staff | per-command tier
 * (/honeypot exempt = Admin) | 1 view · 2 write" — subtask 20).
 *
 * GET ONLY — no POST/PUT/DELETE is registered here (§8.8 Phase 1; writes
 * arrive in Phase 2 subtask 26 with the per-command tiers). The app-wide
 * methodGate 405s every other verb on this path anyway.
 *
 * Route position: registered AFTER routes/guildShell.js in app.js, so the
 * shell's `/g/:guildId` guildScope already ran (anon ⇒ login redirect,
 * cross-guild/stranger ⇒ generic 404 — §8.6 cross-cutting rule, never 403).
 * requireTier("staff") inside the route is the explicit §8.6 view tier.
 *
 * Data: exclusively src/web/data/integrationsData.js (facade-only reads,
 * per-guild cache ≥30 s, §8.6 caps enforced there). The handler itself runs
 * no SQL and reads NO environment values — the data module turns the env
 * gate into "enabled + missing variable NAMES" only (§8.7).
 *
 * Channel/role labels: cache-only via the optional getClient seam (same
 * pattern as routes/settings.js makeChannelNameResolver) — a cached name
 * decorates the id; nothing is ever fetched on a request path, and the id
 * alone is always a complete rendering.
 */

const { createGuildAccessResolver } = require("../auth/guildAccess");
const { requireTier } = require("../middleware/requireTier");
const { renderShellPage, writeShellHtml } = require("../views/layout");
const { renderIntegrationsBody } = require("../views/integrations");
const { createIntegrationsData } = require("../data/integrationsData");

/**
 * Cache-only name resolver (never network) for one discord.js cache store
 * ("channels" | "roles"): returns id → name|null. A missing/throwing client
 * degrades every lookup to null ⇒ the page renders ids, exactly like the
 * slash commands do for uncached entities.
 * @param {(() => any)|null|undefined} getClient
 * @param {"channels"|"roles"} store
 */
function makeCacheNameResolver(getClient, store) {
  return function resolveName(id) {
    try {
      const client = typeof getClient === "function" ? getClient() : null;
      const name = client?.[store]?.cache?.get?.(id)?.name;
      if (typeof name !== "string") return null;
      const trimmed = name.trim();
      return trimmed ? trimmed.slice(0, 100) : null;
    } catch {
      return null;
    }
  };
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
 *   live bot client (cache-only channel/role names; null in tests/dark boot).
 * @param {{getIntegrations: Function}} [options.integrationsData]
 *   pre-built createIntegrationsData() instance (tests inject counting/fake
 *   ones; default is a process-wide lazily-built singleton).
 */
function registerIntegrationsRoutes(app, options = {}) {
  const resolver =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });

  let defaultData = null;
  const getData = () => {
    if (!defaultData) defaultData = createIntegrationsData();
    return defaultData;
  };
  const integrationsData = options.integrationsData || {
    getIntegrations: (guildId) => getData().getIntegrations(guildId),
  };

  app.get(
    "/g/:guildId/integrations",
    requireTier("staff"),
    async (req, res, next) => {
      try {
        const guildId = req.guildAccess.guildId;
        // One cached per-guild snapshot (§8.6 floor 30 s). Facade reads
        // happen inside the data module — never here.
        const snapshot = integrationsData.getIntegrations(guildId);
        const document = renderShellPage(req, {
          title: "Integrations",
          heading: "Integrations",
          subheading:
            "YouTube, Twitch, reaction roles, event reminders and honeypot — current values and the slash commands that own them (read-only in Phase 1).",
          content: renderIntegrationsBody({
            snapshot,
            resolveChannelName: makeCacheNameResolver(options.getClient, "channels"),
            resolveRoleName: makeCacheNameResolver(options.getClient, "roles"),
          }),
          guilds: await shellGuilds(resolver, req),
        });
        writeShellHtml(req, res, { status: 200, document });
      } catch (err) {
        next(err); // → handleAppError: generic 500, nothing leaked
      }
    }
  );
}

module.exports = {
  registerIntegrationsRoutes,
};
