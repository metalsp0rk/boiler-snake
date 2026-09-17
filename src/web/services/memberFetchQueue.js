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

/** guildId -> Map<userId, queuedAtMs> (insertion-ordered = drain order). */
const pending = new Map();
/** guildId -> Map<userId, lastAttemptAtMs> — cooldown ledger. */
const attempted = new Map();
/** getClient thunk captured at first enqueue per guild (used at flush). */
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
 * Queue cache misses for background resolution. Fire-and-forget: returns the
 * number of ids newly queued. Never throws; invalid input is ignored.
 *
 * @param {() => any} getClient client thunk (same one routes already pass to
 *   resolveMemberNames)
 * @param {string} guildId
 * @param {Iterable<string>} userIds the ids missing from the member cache
 * @returns {number} newly-queued id count
 */
function queueMissingMembers(getClient, guildId, userIds) {
  if (typeof guildId !== "string" || !guildId) return 0;
  if (typeof getClient !== "function") return 0;
  let queued = 0;
  const guildPending = pending.get(guildId) ?? new Map();
  for (const userId of userIds ?? []) {
    if (typeof userId !== "string" || !userId) continue;
    if (guildPending.size >= MAX_PENDING_PER_GUILD) break; // bounded: drop the rest
    if (guildPending.has(userId)) continue; // already queued = dedupe
    if (attemptBlockedUntil(guildId, userId) > now()) continue; // cooling down
    guildPending.set(userId, now());
    queued += 1;
  }
  if (guildPending.size > 0) {
    pending.set(guildId, guildPending);
    clients.set(guildId, getClient);
    startTicker();
  }
  return queued;
}

/**
 * Process ONE guild's queue (up to FETCH_BUDGET_PER_FLUSH ids), sequentially.
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

  const getClient = clients.get(guildId);
  let client = null;
  try {
    client = getClient?.() ?? null;
  } catch (err) {
    client = null;
  }
  const members = client?.guilds?.cache?.get?.(guildId)?.members ?? null;
  if (typeof members?.fetch !== "function") {
    // No live fetcher (dark boot / test fake): discard this guild's queue —
    // re-rendered pages re-enqueue when a real client exists.
    pending.delete(guildId);
    clients.delete(guildId);
    return 0;
  }

  const cutoff = now();
  let attemptedCount = 0;
  for (const [userId, queuedAt] of guildPending) {
    if (attemptedCount >= FETCH_BUDGET_PER_FLUSH) break;
    guildPending.delete(userId); // one way or another this id leaves the queue now
    if (attemptBlockedUntil(guildId, userId) > cutoff) continue;
    attemptedCount += 1;
    try {
      // discord.js routes this through its rate-limit-aware rest manager and
      // writes the result into the member cache on success.
      await members.fetch({ user: userId });
      markAttempt(guildId, userId, RETRY_COOLDOWN_MS);
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
    pending.delete(guildId);
    clients.delete(guildId);
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
  flushMemberFetchQueue,
  stopMemberFetchQueue,
  queueStats,
};
