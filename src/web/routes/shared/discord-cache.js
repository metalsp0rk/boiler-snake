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
const { getCommunityById } = require("../../../platform/community");

/**
 * Fluxer PR 10 (spec §Boot Supervisor, roadmap L750-762): a process-wide
 * provider mapping INTEGER community ids to the platform's OutboundClient.
 * features/web boot wires `supervisor.clientForCommunity`; tests inject a
 * fake. Unwired → Fluxer name lookups answer id-only (null), exactly the
 * existing dark-boot doctrine, and NEVER read the Discord cache.
 * @type {null | ((communityId: number) => object|null)}
 */
let communityClientProvider = null;
let warnedUnwiredFluxer = false;

/**
 * Wire (or unwire with null) the per-community OutboundClient provider.
 * @param {((communityId: number) => object|null)|null} fn
 */
function setCommunityClientProvider(fn) {
  communityClientProvider = typeof fn === "function" ? fn : null;
  if (communityClientProvider) warnedUnwiredFluxer = false;
}

/**
 * OutboundClient for an INTEGER community id, or null (never throws — a
 * broken provider degrades to id-only rendering like a cold cache).
 * @param {number} cid
 * @returns {object|null}
 */
function communityClient(cid) {
  if (!communityClientProvider) return null;
  try {
    return communityClientProvider(cid) ?? null;
  } catch (err) {
    console.error(
      `[web] community client lookup failed for ${cid}:`,
      err?.message || err
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fluxer display-name cache (sync read at render time; async warm OFF-path)
// ---------------------------------------------------------------------------

/**
 * `${cid}:${userId}` → { name, bot, at }. A Fluxer member fetch is async, so
 * the request path renders from THIS bounded map (mirrors the discord.js
 * member-cache doctrine: cache-only at render, misses warm in the background
 * and show up on the NEXT render). Entries self-expire on the TTL; the map is
 * entry-capped like guildAccess's caches.
 */
const fluxerNames = new Map();
const FLUXER_NAME_TTL_MS = 6 * 60 * 60 * 1000;
const FLUXER_NAME_MAX = 2000;

function fluxerNameGet(cid, userId) {
  const hit = fluxerNames.get(`${cid}:${userId}`);
  if (!hit) return null;
  if (Date.now() - hit.at > FLUXER_NAME_TTL_MS) {
    fluxerNames.delete(`${cid}:${userId}`);
    return null;
  }
  return hit;
}

function fluxerNameSet(cid, userId, entry) {
  const key = `${cid}:${userId}`;
  fluxerNames.set(key, entry);
  while (fluxerNames.size > FLUXER_NAME_MAX) {
    const oldest = fluxerNames.keys().next().value;
    if (oldest === undefined) break;
    fluxerNames.delete(oldest);
  }
}

/**
 * Interpret a route's `guildId` argument. Post-PR-2 web routes pass the
 * INTEGER communities.id; legacy callers pass the external snowflake string
 * (kept working byte-identically). Returns the integer cid when the argument
 * IS a community id, else null.
 * @param {unknown} guildId
 * @returns {number|null}
 */
function toCommunityId(guildId) {
  if (typeof guildId === "number") {
    return Number.isSafeInteger(guildId) && guildId >= 1 && guildId <= 2_147_483_647
      ? guildId
      : null;
  }
  if (typeof guildId === "string" && /^[1-9][0-9]{0,9}$/.test(guildId.trim())) {
    const n = Number(guildId.trim());
    return Number.isSafeInteger(n) && n <= 2_147_483_647 ? n : null;
  }
  return null;
}

/**
 * Community row for a route argument, tolerating missing rows and store
 * failures (both keep the legacy Discord-cache path).
 * @param {number} cid
 * @returns {{platform: string, instanceKey: string, externalGuildId: string}|null}
 */
function communityRowSafe(cid) {
  try {
    return getCommunityById(cid) ?? null;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget Fluxer name warm. ONE in-flight fetch per (cid,user);
 * failures are logged with ids by OutboundClient itself.
 * @param {number} cid
 * @param {string} userId
 */
function warmFluxerName(cid, userId) {
  const key = `${cid}:${userId}`;
  if (fluxerNames.has(`w:${key}`)) return; // one in-flight attempt per key
  const outbound = communityClient(cid);
  if (!outbound || typeof outbound.fetchUser !== "function") {
    if (!warnedUnwiredFluxer) {
      warnedUnwiredFluxer = true;
      console.warn(
        "[web] fluxer name resolution: no community client wired (features/web boot) — ids stay raw."
      );
    }
    return;
  }
  fluxerNames.set(`w:${key}`, { at: Date.now() });
  Promise.resolve()
    .then(() => outbound.fetchUser(cid, userId))
    .then((user) => {
      if (user && typeof user.id === "string") {
        // isProvenBot compares the bot flag AND outbound.botUserId (spec
        // L760): the bot's own id resolves through the same fetch.
        const bot = Boolean(user.bot) || String(user.id) === String(outbound.botUserId);
        const name = typeof user.username === "string" ? user.username.trim().slice(0, 100) : "";
        fluxerNameSet(cid, userId, { name: name || null, bot, at: Date.now() });
      }
    })
    .catch((err) => {
      // OutboundClient logs the REST failure itself; this catch only keeps
      // the fire-and-forget promise from becoming an unhandled rejection.
      void err;
    })
    .finally(() => {
      fluxerNames.delete(`w:${key}`);
    });
}

/**
 * True only when the cache can PROVE the user is a bot (member.user.bot /
 * member.bot / cached global user). A broken/absent cache object can never
 * prove it ⇒ false (fail-open for the human case, matching slash guards
 * which act on the same cache evidence).
 *
 * Fluxer PR 10: an INTEGER community id whose row is a FLUXER community
 * proves bot-ness from the Fluxer name cache (fetchUser `bot` flag /
 * outbound.botUserId) — NEVER from the Discord cache (spec L760: "does not
 * read the other platform's cache").
 * @param {any} client
 * @param {string|number} guildId
 * @param {string} userId
 * @returns {boolean}
 */
function isProvenBot(client, guildId, userId) {
  const cid = toCommunityId(guildId);
  if (cid != null) {
    const community = communityRowSafe(cid);
    if (community?.platform === "fluxer") {
      try {
        const hit = fluxerNameGet(cid, userId);
        return hit?.bot === true;
      } catch {
        return false;
      }
    }
    if (community) guildId = community.externalGuildId ?? guildId;
  }
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
 *
 * Fluxer PR 10: a route argument that is an INTEGER community id whose row
 * is a FLUXER community resolves from the Fluxer display-name cache and
 * warms misses through `outbound.fetchUser` (fire-and-forget, logged) —
 * never the Discord cache (spec L760). Legacy string-snowflake arguments
 * keep the Discord path byte-identically.
 * @param {(() => any)|null|undefined} getClient
 * @param {string|number} guildId
 * @param {string[]} userIds
 * @returns {Map<string, string|null>}
 */
function resolveMemberNames(getClient, guildId, userIds) {
  const ids = Array.isArray(userIds) ? userIds : userIds ? [...userIds] : [];
  const cid = toCommunityId(guildId);
  const community = cid != null ? communityRowSafe(cid) : null;
  if (community?.platform === "fluxer") {
    // Fluxer surface: the Discord client is not consulted at all.
    const names = new Map();
    for (const userId of ids) {
      const cached = typeof userId === "string" && userId
        ? fluxerNameGet(cid, userId)
        : null;
      names.set(userId, cached?.name ?? null);
      if (cached === null && typeof userId === "string" && userId) {
        try {
          warmFluxerName(cid, userId);
        } catch (err) {
          // Warming is best-effort: a broken provider can't degrade a render.
          console.error(
            `[web] fluxer name warm failed community=${cid}:`,
            err?.message || err
          );
        }
      }
    }
    return names;
  }
  const guildKey =
    community && typeof community.externalGuildId === "string"
      ? community.externalGuildId
      : guildId;

  const names = new Map();
  let client = null;
  try {
    client = typeof getClient === "function" ? getClient() : null;
  } catch {
    client = null;
  }
  const guild = client?.guilds?.cache?.get?.(guildKey) ?? null;
  const members = guild?.members?.cache ?? null;
  const missing = [];
  for (const userId of ids) {
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
  if (missing.length > 0) {
    const queueKey = cid != null ? cid : guildKey;
    const hasLiveFetcher =
      (cid != null) || typeof guild?.members?.fetch === "function";
    if (hasLiveFetcher) {
      try {
        queueMissingMembers(getClient, queueKey, missing);
      } catch (err) {
        // Queueing is best-effort: a broken queue can't degrade a render.
        console.error(
          `[web] member-fetch enqueue failed guild=${guildKey}:`,
          err?.message || err
        );
      }
    }
  }
  return names;
}

/**
 * Member cache as {id,name} suggestion candidates (display-name precedence
 * nickname > display > username — same as resolveMemberNames). Cache-only,
 * never fetches; tolerates missing caches and mid-iteration races.
 * @param {any} guild discord.js Guild (or null)
 * @returns {Array<{id: string, name: string|null}>}
 */
function memberNameCandidates(guild) {
  const out = [];
  try {
    const members = guild?.members?.cache ?? null;
    if (!members || typeof members.values !== "function") return out;
    for (const m of members.values()) {
      const id = m?.id ? String(m.id) : null;
      if (!id) continue;
      const name = String(
        m?.nickname || m?.displayName || m?.user?.username || ""
      ).trim();
      out.push({ id, name: name || null });
    }
  } catch {
    /* cache raced away mid-iteration — partial list is fine */
  }
  return out;
}

module.exports = {
  memberNameCandidates,
  isProvenBot,
  makeCacheNameResolver,
  makeGuildRoleNameResolver,
  resolveMemberNames,
  setCommunityClientProvider,
  communityClient,
};
