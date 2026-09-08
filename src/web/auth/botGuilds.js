/**
 * Bot-guild provider seam (roadmap/web-admin.md §8.3 guild list).
 *
 * The `guilds` OAuth scope returns ALL of the user's guilds — Discord does
 * NOT filter by bot presence (live-docs correction, see
 * .tmp/external-context/discord-oauth/web-login-notes.md §5). The panel
 * lists only guilds the bot can actually serve, so the login callback
 * intersects the user's list with the BOT's guild ids. This module owns
 * that provider:
 *
 *  - production: features/web boot wires it to the discord.js v14 client
 *    (`client.guilds.cache.keyArray()`), re-read at every login;
 *  - tests: `setBotGuildsProvider(() => [...])` fake;
 *  - unwired: resolves to an empty list (login still succeeds with an
 *    empty guild snapshot — guild routing shows nothing until wired) and
 *    logs ONE warning (names/counts only, never ids).
 *
 * Live-read semantics: the cache is only complete after READY; an early
 * login right after boot may see a small/partial list. The session's
 * snapshot is refreshed on next login (and re-checked per TTL by
 * guildAccess, subtask 07).
 */

/** @type {null | (() => string[] | Set<string> | Iterable<string> | Promise<string[] | Set<string> | Iterable<string>>)} */
let provider = null;
let warnedUnwired = false;

/**
 * Wire (or unwire with null) the bot-guild id source.
 * @param {typeof provider} fn
 */
function setBotGuildsProvider(fn) {
  provider = typeof fn === "function" ? fn : null;
  if (provider) warnedUnwired = false;
}

/**
 * Normalize Set / array / iterable-of-strings into a plain string array.
 * Anything un-shapeable degrades to an empty list rather than throwing —
 * an unusable guild list must never break the login redirect chain.
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeBotGuildIds(value) {
  if (!value) return [];
  if (value instanceof Set) return [...value].filter((v) => typeof v === "string");
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  if (typeof value === "object" && typeof value.keyArray === "function") {
    const ids = value.keyArray();
    return Array.isArray(ids) ? ids.filter((v) => typeof v === "string") : [];
  }
  return [];
}

/**
 * Current bot guild ids (awaitable — providers may be sync or async).
 * @returns {Promise<string[]>}
 */
async function getBotGuildIds() {
  if (!provider) {
    if (!warnedUnwired) {
      warnedUnwired = true;
      console.warn(
        "[web] no bot-guild provider wired — login guild intersection will be empty (features/web boot wires this to the Discord client)."
      );
    }
    return [];
  }
  return normalizeBotGuildIds(await provider());
}

/** @private test helper */
function _resetBotGuildsForTests() {
  provider = null;
  warnedUnwired = false;
}

module.exports = {
  setBotGuildsProvider,
  normalizeBotGuildIds,
  getBotGuildIds,
  _resetBotGuildsForTests,
};
