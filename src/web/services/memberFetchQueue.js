/**
 * Lazy member-fetch queue (roadmap/web-admin.md §8.15, "names not ids" C).
 *
 * The console resolves display names from the discord.js member cache ONLY —
 * never on the request path (rate limits, page latency). That cache is sparse
 * because we don't subscribe to the privileged GuildMembers intent, so DB-
 * driven lists (XP history, warnings, tickets) show raw ids for members the
 * bot has not witnessed since boot.
 *
 * This service closes the gap OFF the request path: routes hand their cache
 * misses to `queueMissingMembers()`; a slow background ticker drains the
 * queue one guild per tick using `guild.members.fetch({ user })` — discord.js
 * queues those requests through its own rest manager, which already honors
 * per-route rate limits. Successes land in the member cache, so the NEXT
 * render of the page shows the name. Pages themselves never wait or fail.
 *
 * Guardrails (§8.1 "bounded, logged, never silent"):
 *  - per (guild,user) attempt cooldown — a page that renders 100 times in
 *    five minutes must not fan out 100 fetches for the same missing id;
 *  - negative cache — members the API says don't exist in the guild (left
 *    the server, deleted) are remembered for a day so their ids stop
 *    re-queueing on every dashboard view;
 *  - bounded pending size per guild — pathological id dumps drop instead of
 *    growing memory;
 *  - every failure logs with guild/user ids (AGENTS.md error handling);
 *  - the ticker wraps itself and unrefs (a dead tick can't kill the loop,
 *    the timer can't hold the process open).
 */

/** How often the ticker drains (one guild per tick). */
const FLUSH_INTERVAL_MS = 2000;
/** Minimum gap between fetch attempts for the same (guild, user). */
const RETRY_COOLDOWN_MS = 10 * 60 * 1000;
/** "Unknown Member" (10007): they are not in this guild — stop asking for a while. */
const MISSING_MEMBER_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Max ids fetched per guild per flush. */
const FETCH_BUDGET_PER_FLUSH = 60;
/** Max queued ids per guild; anything beyond the cap is dropped (counted). */
const MAX_PENDING_PER_GUILD = 1000;
/** Discord REST error code for "Unknown Member". */
const UNKNOWN_MEMBER = 10007;

/** guildId -> Map<userId, queuedAtMs> (insertion-ordered = drain order).
 *  Keys are String(communityId) for the canonical numeric queue (Fluxer PR 10,
 *  spec L762: "Change the key to String(communityId)") and legacy external
 *  snowflake strings for Discord callers that pass snowflakes directly. */
const pending = new Map();
/** guildId -> Map<userId, lastAttemptAtMs> — cooldown ledger. */
const attempted = new Map();
/** guildId -> getClient thunk captured at first enqueue (Discord drains). */
const clients = new Map();
/** guildId -> "next guild to drain" round-robin cursor. */
let cursor = 0;
let timer = null;

function now() {
  return Date.now();
}

function ledger(guildMap) {
  const map = guildMap ?? new Map();
  return map;
}

/**
 * Cooldown bookkeeping for one (guild,user) attempt.
 */
function markAttempt(guildId, userId, cooldownMs) {
  const g = ledger(attempted.get(guildId));
  attempted.set(guildId, g);
  g.set(userId, now() + cooldownMs); // store "blocked until", pruned on drain
}

function attemptBlockedUntil(guildId, userId) {
  return attempted.get(guildId)?.get(userId) ?? 0;
}

/**
 * Canonical queue key for a community id (Fluxer PR 10, spec L762: the
 * function "takes a number"). Returns the integer for a safe integer in the
 * communities.id range; anything else (strings — including legacy snowflakes,
 * floats, ranges) yields null so the caller fails LOUD.
 * @param {unknown} communityId
 * @returns {number|null}
 */
function toQueueCommunityId(communityId) {
  if (typeof communityId !== "number") return null;
  return Number.isSafeInteger(communityId) &&
    communityId >= 1 &&
    communityId <= 2_147_483_647
    ? communityId
    : null;
}

/**
 * Queue cache misses for background resolution by INTEGER community id
 * (Fluxer PR 10, spec §Boot): keys are String(communityId), and the drain
 * resolves the platform's client through the community registry BEFORE any
 * cache read. The canonical argument is a NUMBER; ids that are neither a
 * safe-integer number nor a non-empty string log and return 0 so a missed
 * call site is loud. Non-empty STRING ids keep the pre-PR-10 Discord
 * contract: they are drained as EXTERNAL snowflakes through the discord.js
 * client (the contract pinned by test/web-member-fetch-queue.test.js).
 *
 * @param {() => any} getClient client thunk (Discord drains use it; Fluxer
 *   drains resolve the OutboundClient from the community registry)
 * @param {number|string} communityId INTEGER communities.id (canonical) or
 *   a legacy external snowflake string
 * @param {Iterable<string>} userIds the ids missing from the member cache
 * @returns {number} newly-queued id count
 */
function queueMissingMembers(getClient, communityId, userIds) {
  const cid = toQueueCommunityId(communityId);
  if (cid != null) return enqueue(String(cid), getClient, userIds);
  if (typeof communityId === "string" && communityId) {
    // Legacy external-snowflake caller (the pre-PR-10 Discord contract,
    // pinned by test/web-member-fetch-queue.test.js — a hard-0 here would
    // turn the §8.15 suite red). Route to the external queue.
    return queueMissingMembersExternal(getClient, communityId, userIds);
  }
  // Spec L762: "returns 0 ... after logging, so a missed call site is loud."
  console.warn(
    `[web] member-fetch queue: communityId=${JSON.stringify(
      communityId
    )} is not a number/string id — ids dropped (pass the INTEGER communities.id)`
  );
  return 0;
}

/**
 * Legacy external-snowflake queue (pre-PR-10 Discord contract, byte-identical
 * semantics): keyed by the snowflake string, drained through the discord.js
 * client's guild.members cache. Used by routes that pass external guild ids to
 * the cache seam (see routes/shared/discord-cache.resolveMemberNames).
 *
 * @param {() => any} getClient client thunk
 * @param {string} externalGuildId Discord snowflake
 * @param {Iterable<string>} userIds
 * @returns {number} newly-queued id count
 */
function queueMissingMembersExternal(getClient, externalGuildId, userIds) {
  if (typeof externalGuildId !== "string" || !externalGuildId) return 0;
  if (typeof getClient !== "function") return 0;
  return enqueue(externalGuildId, getClient, userIds);
}

/** Shared enqueue: dedupe + cooldown + bounded per-key pending. */
function enqueue(key, getClient, userIds) {
  let queued = 0;
  const guildPending = pending.get(key) ?? new Map();
  for (const userId of userIds ?? []) {
    if (typeof userId !== "string" || !userId) continue;
    if (guildPending.size >= MAX_PENDING_PER_GUILD) break; // bounded: drop the rest
    if (guildPending.has(userId)) continue; // already queued = dedupe
    if (attemptBlockedUntil(key, userId) > now()) continue; // cooling down
    guildPending.set(userId, now());
    queued += 1;
  }
  if (guildPending.size > 0) {
    pending.set(key, guildPending);
    clients.set(key, getClient);
    startTicker();
  }
  return queued;
}

/**
 * Process ONE guild/community's queue (up to FETCH_BUDGET_PER_FLUSH ids),
 * sequentially. Resolves the target BEFORE any cache read (spec L762):
 *  - numeric key  → communities row: a FLUXER row warms names through
 *    `outbound.fetchUser` (never the Discord cache); a DISCORD row fetches
 *    through the discord.js client at the row's EXTERNAL guild id;
 *  - string key   → legacy external snowflake, discord.js member fetch.
 * A queue whose community row vanished (deleted) is dropped with a warning.
 * Returns ids actually attempted. Exported for tests; the ticker calls it.
 * @returns {Promise<number>}
 */
async function flushMemberFetchQueue() {
  const guildIds = [...pending.keys()];
  if (guildIds.length === 0) return 0;

  // Round-robin one guild per tick so a single chatty guild cannot starve
  // the others of fetch bandwidth.
  cursor = (cursor + 1) % guildIds.length;
  const guildId = guildIds[cursor];
  const guildPending = pending.get(guildId);
  if (!guildPending || guildPending.size === 0) {
    pending.delete(guildId);
    clients.delete(guildId);
    return 0;
  }

  const dropQueue = () => {
    pending.delete(guildId);
    clients.delete(guildId);
  };

  // Resolve platform + external id BEFORE touching any cache (spec L762).
  let cid = null;
  let platform = "discord";
  let externalId = guildId;
  let outbound = null;
  if (/^[1-9][0-9]{0,9}$/.test(guildId)) {
    cid = Number(guildId);
    let row = null;
    try {
      row = require("../../platform/community").getCommunityById(cid);
    } catch {
      row = null;
    }
    if (!row) {
      console.warn(
        `[web] member fetch: community ${guildId} has no registry row — dropping queued ids`
      );
      dropQueue();
      return 0;
    }
    platform = row.platform ?? "discord";
    externalId = row.externalGuildId;
    if (platform === "fluxer") {
      const cacheSeam = require("../routes/shared/discord-cache");
      outbound = cacheSeam.communityClient(cid);
      if (!outbound || typeof outbound.fetchUser !== "function") {
        // Spec §Supervisor: missing client = logged skip, not a silent drop.
        console.warn(
          `[web] member fetch: no fluxer client for community ${guildId} — dropping queued ids`
        );
        dropQueue();
        return 0;
      }
    }
  }

  let members = null;
  if (platform !== "fluxer") {
    const getClient = clients.get(guildId);
    let client = null;
    try {
      client = getClient?.() ?? null;
    } catch {
      client = null;
    }
    members = client?.guilds?.cache?.get?.(externalId)?.members ?? null;
    if (typeof members?.fetch !== "function") {
      // No live fetcher (dark boot / test fake): discard this guild's queue —
      // re-rendered pages re-enqueue when a real client exists.
      dropQueue();
      return 0;
    }
  }

  const cutoff = now();
  let attemptedCount = 0;
  for (const [userId, queuedAt] of guildPending) {
    if (attemptedCount >= FETCH_BUDGET_PER_FLUSH) break;
    guildPending.delete(userId); // one way or another this id leaves the queue now
    if (attemptBlockedUntil(guildId, userId) > cutoff) continue;
    attemptedCount += 1;
    try {
      if (outbound) {
        // Fluxer: the user-facing display name comes from fetchUser; the
        // OutboundClient logs REST failures itself and returns null — treat
        // null as a transient miss (retry on the next cooldown).
        const user = await outbound.fetchUser(cid, userId);
        if (user) {
          markAttempt(guildId, userId, RETRY_COOLDOWN_MS);
        } else {
          markAttempt(guildId, userId, RETRY_COOLDOWN_MS);
          console.warn(
            `[web] fluxer member fetch: user ${userId} community ${guildId} unresolvable — retry later`
          );
        }
      } else {
        // discord.js routes this through its rate-limit-aware rest manager and
        // writes the result into the member cache on success.
        await members.fetch({ user: userId });
        markAttempt(guildId, userId, RETRY_COOLDOWN_MS);
      }
    } catch (err) {
      if (err?.code === UNKNOWN_MEMBER) {
        markAttempt(guildId, userId, MISSING_MEMBER_COOLDOWN_MS);
        console.warn(
          `[web] member fetch: user ${userId} not in guild ${guildId} (left/deleted) — id will stay raw for ~24h`
        );
      } else {
        // Transient (rate limit, network, 5xx): cool down briefly, retry later.
        markAttempt(guildId, userId, RETRY_COOLDOWN_MS);
        console.error(
          `[web] member fetch failed guild=${guildId} user=${userId}:`,
          err?.message || err
        );
      }
    }
  }

  if (guildPending.size === 0) {
    dropQueue();
  }
  pruneLedgers();
  return attemptedCount;
}

/** Drop expired cooldown entries and empty guild maps (bounded memory). */
function pruneLedgers() {
  const t = now();
  for (const [guildId, g] of attempted) {
    for (const [userId, blockedUntil] of g) {
      if (blockedUntil <= t) g.delete(userId);
    }
    if (g.size === 0) attempted.delete(guildId);
  }
}

function startTicker() {
  if (timer) return;
  timer = setInterval(() => {
    // Detached async work: own catch (AGENTS.md — one failure can't kill the loop).
    flushMemberFetchQueue().catch((err) => {
      console.error("[web] member-fetch tick failed:", err?.message || err);
    });
  }, FLUSH_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

/** Stop the ticker and clear all state. Tests/shutdown only. */
function stopMemberFetchQueue() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  pending.clear();
  attempted.clear();
  clients.clear();
  cursor = 0;
}

/** Pending counts for diagnostics/tests: guildId -> number. */
function queueStats() {
  const out = {};
  for (const [guildId, map] of pending) out[guildId] = map.size;
  return out;
}

module.exports = {
  queueMissingMembers,
  queueMissingMembersExternal,
  flushMemberFetchQueue,
  stopMemberFetchQueue,
  queueStats,
};
