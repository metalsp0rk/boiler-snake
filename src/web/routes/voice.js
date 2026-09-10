/**
 * GET /g/:guildId/voice — the Phase 1 read-only voice & music view
 * (roadmap/web-admin.md §8.6 "Voice & Music: now-playing, queue VIEW only |
 * Staff | none (control out of scope) | 1" — subtask 21).
 *
 * GET ONLY — this module registers exactly ONE route and it is a GET.
 * There are NO control endpoints anywhere (skip/pause/stop/seek/…): music
 * control is explicitly OUT of v1 scope (§8.9, locked decision 11), and the
 * test pins that every other verb on this path hits the app-wide 405 gate
 * and that the rendered page contains no guild-scoped <form>/<button>.
 *
 * Route position: registered AFTER routes/guildShell.js in app.js, so the
 * shell's `/g/:guildId` guildScope already ran (anon ⇒ login redirect,
 * cross-guild/stranger ⇒ generic 404 — §8.6 cross-cutting rule, never 403).
 * requireTier("staff") inside the route is the explicit §8.6 view tier.
 *
 * Data: exclusively src/web/data/voiceData.js (bounded facade reads,
 * cache-only runtime providers, per-guild cache ≥30 s — §8.6 query budget;
 * the ≥5 s player-cache the subtask requires is exceeded by the 30 s floor,
 * and cache hits run ZERO provider code, so the request path never fans out
 * to Lavalink per hit). The handler itself runs no SQL.
 *
 * Live state: current connected humans + now-playing/queue read the bot
 * client's caches ONLY through the optional getClient seam (voiceStates
 * cache / lavalink-client player state — the same sources the voice ticker
 * and /music nowplaying use). Unwired, data-less, or a THROWING seam all
 * degrade to honest "unavailable" strings — never a REST fetch, never a
 * player/connection attempt, never a crash.
 */

const { createGuildAccessResolver } = require("../auth/guildAccess");
const { requireTier } = require("../middleware/requireTier");
const { renderShellPage, writeShellHtml } = require("../views/layout");
const { renderVoiceBody } = require("../views/voice");
const { shellGuilds } = require("./shared/shell.js");
const { makeCacheNameResolver } = require("./shared/discord-cache.js");
const {
  createVoiceData,
  makeMusicStateAccessor,
  makeLiveVoiceAccessor,
} = require("../data/voiceData");



/**
 * @param {import("express").Express} app
 * @param {object} [options]
 * @param {{resolve: Function, listGuilds: Function}} [options.guildAccess]
 *   pre-built resolver (app.js passes the SAME instance the guild shell
 *   uses — one tier cache, §8.3); default builds one from the seams below.
 * @param {string} [options.apiBase] @param {typeof fetch} [options.fetchImpl]
 * @param {() => string[]|Promise<string[]>} [options.botGuilds]
 * @param {(() => import("discord.js").Client|null)|null} [options.getClient]
 *   live bot client — the CACHE-ONLY seam for live voice + player state
 *   (null in tests/dark boot ⇒ honest "unavailable" render).
 * @param {((guildId: string) => unknown)|null} [options.getPlayerState]
 *   player-state provider override (boot wiring/tests; default builds
 *   voiceData.makeMusicStateAccessor(getClient) — pure state inspection,
 *   the dashboardData.snapshotMusicPlayer seam pattern, never a connection).
 * @param {((guildId: string) => unknown)|null} [options.getLiveVoice]
 *   live voiceStates provider override (same contract).
 * @param {{getVoice: Function}} [options.voiceData]
 *   pre-built createVoiceData() instance (tests inject counting/fake ones;
 *   default is a process-wide lazily-built singleton).
 */
function registerVoiceRoutes(app, options = {}) {
  const resolver =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });

  let defaultData = null;
  const getData = () => {
    if (!defaultData) {
      defaultData = createVoiceData({
        getMusicState:
          options.getPlayerState || makeMusicStateAccessor(options.getClient),
        getLiveVoice:
          options.getLiveVoice || makeLiveVoiceAccessor(options.getClient),
      });
    }
    return defaultData;
  };
  const voiceData = options.voiceData || {
    getVoice: (guildId) => getData().getVoice(guildId),
  };

  app.get(
    "/g/:guildId/voice",
    requireTier("staff"),
    async (req, res, next) => {
      try {
        const guildId = req.guildAccess.guildId;
        // One cached per-guild snapshot (§8.6 floor 30 s; DB reads AND both
        // runtime providers are skipped on a hit). Facade reads happen
        // inside the data module — never here.
        const snapshot = await voiceData.getVoice(guildId);
        const document = renderShellPage(req, {
          title: "Voice & music",
          heading: "Voice & music",
          subheading:
            "Now-playing, queue and live voice state — read-only; player control lives in Discord only (§8.9).",
          content: renderVoiceBody({
            snapshot,
            resolveChannelName: makeCacheNameResolver(options.getClient, "channels"),
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
  registerVoiceRoutes,
};
