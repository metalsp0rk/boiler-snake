/**
 * Cache-only Discord read seams shared by the /g/ surfaces.
 *
 * Doctrine (§8.6): the web layer NEVER calls the Discord API to render — it
 * reads only the live client cache and degrades honestly (null / id-only)
 * on a cold cache so one missing entry can't break a page. These replaced
 * seven forked copies; the guild-scoped vs global store split is real and
 * MUST stay (roles resolve per-guild, channels resolve globally).
 *
 * Resolution is STILL cache-only at render time; misses are handed to the
 * background member-fetch queue (§8.15) so later renders can show names —
 * the request path itself never awaits Discord.
 */

const { queueMissingMembers } = require("../../services/memberFetchQueue");

/**
 * True only when the cache can PROVE the user is a bot (member.user.bot /
 * member.bot / cached global user). A broken/absent cache object can never
 * prove it ⇒ false (fail-open for the human case, matching slash guards
 * which act on the same cache evidence).
 * @param {any} client
 * @param {string} guildId
 * @param {string} userId
 * @returns {boolean}
 */
function isProvenBot(client, guildId, userId) {
  try {
    const guild = client?.guilds?.cache?.get?.(guildId) ?? null;
    const member = guild?.members?.cache?.get?.(userId) ?? null;
    const memberBot = member?.user?.bot === true || member?.bot === true;
    if (memberBot) return true;
    const cachedUser = client?.users?.cache?.get?.(userId) ?? null;
    return cachedUser?.bot === true;
  } catch {
    return false; // a broken cache object can never PROVE a bot
  }
}

/**
 * Name resolver over a GLOBAL client cache store ("channels" | "roles").
 * Trims to a display name, caps at 100 chars, null on miss/cold/broken.
 * @param {(() => any)|null|undefined} getClient
 * @param {"channels"|"roles"} store
 * @returns {(id: string) => string|null}
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

/**
 * Guild-scoped role-name resolver: roles resolve against the GUILD's role
 * cache (guild.roles.cache), NOT the global client.roles.cache — a
 * guild-specific semantic distinct from the global store resolver above.
 * @param {(() => any)|null|undefined} getClient
 * @param {string} guildId
 * @returns {(roleId: string) => string|null}
 */
function makeGuildRoleNameResolver(getClient, guildId) {
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
 * Cache-read display names — bot client cache ONLY, never a network
 * fetch ON a request path (roadmap/web-admin.md §8.6 doctrine). Absent
 * client (dark boot / tests) ⇒ nulls; callers fall back to the raw id
 * exactly like slash does on a member-cache miss. Lifted from
 * routes/leaderboard.js so every surface (dashboard, tickets, moderation,
 * leaderboard) resolves names the same way (UX v1.1, §8.15).
 *
 * Cache misses are queued for OFF-path background resolution
 * (services/memberFetchQueue): the next page render picks the name up once
 * discord.js's rate-limited rest manager has fetched the member. Fake/absent
 * clients (no `members.fetch`) never enqueue, so tests and dark boot are
 * unaffected.
 * @param {(() => any)|null|undefined} getClient
 * @param {string} guildId
 * @param {string[]} userIds
 * @returns {Map<string, string|null>}
 */
function resolveMemberNames(getClient, guildId, userIds) {
  const names = new Map();
  let client = null;
  try {
    client = typeof getClient === "function" ? getClient() : null;
  } catch {
    client = null;
  }
  const guild = client?.guilds?.cache?.get?.(guildId) ?? null;
  const members = guild?.members?.cache ?? null;
  const missing = [];
  for (const userId of userIds) {
    let name = null;
    try {
      const m = members?.get?.(userId) ?? null;
      name = m?.displayName || m?.user?.username || null;
    } catch {
      name = null;
    }
    names.set(userId, name);
    if (name === null && typeof userId === "string" && userId) missing.push(userId);
  }
  if (missing.length > 0 && typeof guild?.members?.fetch === "function") {
    try {
      queueMissingMembers(getClient, guildId, missing);
    } catch (err) {
      // Queueing is best-effort: a broken queue can't degrade a render.
      console.error(
        `[web] member-fetch enqueue failed guild=${guildId}:`,
        err?.message || err
      );
    }
  }
  return names;
}

module.exports = {
  isProvenBot,
  makeCacheNameResolver,
  makeGuildRoleNameResolver,
  resolveMemberNames,
};
