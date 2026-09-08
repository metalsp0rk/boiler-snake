/**
 * GET /g/:guildId/settings — the Phase 1 read-only guild settings view
 * (roadmap/web-admin.md §8.6 "Settings: guild settings, command channels,
 * logs channels, cooldowns, decay | Staff | per-setting tier | 1 view ·
 * 2 write" — subtask 18).
 *
 * GET ONLY — no POST/PUT/DELETE is registered here (§8.8 Phase 1; writes
 * arrive in Phase 2 subtask 24 with the per-setting tiers). The app-wide
 * methodGate 405s every other verb on this path anyway.
 *
 * Route position: registered AFTER routes/guildShell.js in app.js, so the
 * shell's `/g/:guildId` guildScope already ran (anon ⇒ login redirect,
 * cross-guild/stranger ⇒ generic 404 — §8.6 cross-cutting rule, never 403).
 * requireTier("staff") inside the route is the explicit §8.6 view tier.
 *
 * Data: exclusively src/web/data/settingsData.js (facade-only reads, one
 * bounded query per settings cluster, per-guild cache ≥30 s — §8.6 query
 * budget). The handler itself runs no SQL.
 *
 * Channel labels: cache-only via the optional getClient seam (same pattern
 * as routes/users.js resolveDiscordContext) — a cached channel name decorates
 * the id; nothing is ever fetched on a request path, and the id alone is
 * always a complete rendering.
 */

const { createGuildAccessResolver } = require("../auth/guildAccess");
const { requireTier } = require("../middleware/requireTier");
const { renderShellPage, writeShellHtml } = require("../views/layout");
const { renderSettingsBody } = require("../views/settings");
const { createSettingsData } = require("../data/settingsData");

/**
 * Cache-only channel-name resolver (never network): returns a function
 * channelId → name|null. A missing/throwing client degrades every lookup
 * to null ⇒ the page renders ids, exactly like the slash commands do for
 * uncached channels.
 * @param {(() => any)|null|undefined} getClient
 */
function makeChannelNameResolver(getClient) {
  return function resolveChannelName(channelId) {
    try {
      const client = typeof getClient === "function" ? getClient() : null;
      const name = client?.channels?.cache?.get?.(channelId)?.name;
      if (typeof name !== "string") return null;
      const trimmed = name.trim();
      return trimmed ? trimmed.slice(0, 100) : null;
    } catch {
      return null;
    }
  };
}

/** Shared switcher list (same contract as routes/users.js shellGuilds). */
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
 *   live bot client (cache-only channel names; null in tests/dark boot).
 * @param {{getSettings: Function}} [options.settingsData]
 *   pre-built createSettingsData() instance (tests inject counting/fake
 *   ones; default is a process-wide lazily-built singleton).
 */
function registerSettingsRoutes(app, options = {}) {
  const resolver =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });

  let defaultData = null;
  const getData = () => {
    if (!defaultData) defaultData = createSettingsData();
    return defaultData;
  };
  const settingsData = options.settingsData || {
    getSettings: (guildId) => getData().getSettings(guildId),
  };

  app.get("/g/:guildId/settings", requireTier("staff"), async (req, res, next) => {
    try {
      const guildId = req.guildAccess.guildId;
      // One cached per-guild snapshot (§8.6 floor 30 s). Facade reads happen
      // inside the data module — never here.
      const snapshot = settingsData.getSettings(guildId);
      const document = renderShellPage(req, {
        title: "Settings",
        heading: "Settings",
        subheading:
          "Current guild configuration — values, defaults, and the slash command that owns each (read-only in Phase 1).",
        content: renderSettingsBody({
          snapshot,
          resolveChannelName: makeChannelNameResolver(options.getClient),
        }),
        guilds: await shellGuilds(resolver, req),
      });
      writeShellHtml(req, res, { status: 200, document });
    } catch (err) {
      next(err); // → handleAppError: generic 500, nothing leaked
    }
  });
}

module.exports = {
  registerSettingsRoutes,
};
