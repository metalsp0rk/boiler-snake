/**
 * Gork rate limiting: per-user cooldown + per-guild FIFO concurrency queue.
 *
 * Implements the locked runtime behavior from roadmap/gork.md §7.6
 * (design decision 13):
 *
 * - Per-user cooldown: 180s per user per guild by default, guild-overridable
 *   via `gork_cooldown_sec` (0-3600; 0 = disabled). Staff (caller passes
 *   `staff: true`) bypass the cooldown entirely. A cooldown hit is reported
 *   to the caller, which reacts to the trigger with a clock emoji (no reply,
 *   no LLM call).
 * - Per-guild concurrency: exactly 1 in-flight gork request per guild;
 *   further triggers are queued FIFO (up to 5 waiting); when the queue is
 *   full, new triggers are dropped with a distinct signal the trigger layer
 *   uses for the locked queue-full canned reply.
 *
 * State is in-memory only (per process). No Discord client, no database, no
 * dependencies. The clock is injectable (`now`) so tests can fast-forward
 * time deterministically.
 *
 * Intended usage (trigger.js):
 *
 * ```js
 * const { createGorkQueue } = require("./queue");
 * const gorkQueue = createGorkQueue(); // once at feature boot
 *
 * // Inline, in the onMessageCreate pipeline step (fast checks only):
 * const cd = gorkQueue.checkCooldown({
 *   communityId,
 *   userId,
 *   cooldownSec: settings.gork_cooldown_sec,
 *   staff: isStaff,
 * });
 * if (!cd.allowed) {
 *   // cooldown hit -> react with a clock emoji on the trigger, no reply
 *   await message.react("🕐").catch(() => {});
 *   return;
 * }
 *
 * const slot = gorkQueue.admit({ communityId });
 * if (slot.dropped) {
 *   // send the locked queue-full canned reply, then return
 *   return;
 * }
 *
 * channel.sendTyping(); // immediately, also while queued; refresh every 8s
 *
 * // Detached so the pipeline never stalls:
 * void (async () => {
 *   try {
 *     if (slot.queued) await slot.turn; // wait for our FIFO slot
 *     // ...build context, run the LLM job (60s timeout), send reply, audit...
 *   } catch (err) {
 *     // ...send the locked LLM-failure canned reply...
 *   } finally {
 *     gorkQueue.release({ communityId }); // exactly once per admitted slot
 *   }
 * })();
 * ```
 *
 * `slot.turn` resolves when the request may start (immediately when
 * `queued` is false). `release` hands the in-flight slot to the head of the
 * FIFO (starting the next queued request) or frees it when none are waiting.
 *
 * Queue entries and Map keys are keyed by the INTEGER community id (the
 * internal `communities.id`), not the Discord snowflake.
 */

const DEFAULT_COOLDOWN_SEC = 180;
const MAX_COOLDOWN_SEC = 3600;
const DEFAULT_MAX_WAITING = 5;
/** Sweep the cooldown map once it grows past this many entries. */
const COOLDOWN_SWEEP_SIZE = 10000;

/**
 * Clamp a configured cooldown to the spec'd range (0-3600s; 0 = disabled).
 * Non-finite input degrades to 0, mirroring src/core/cooldowns.js.
 *
 * @param {unknown} sec
 * @returns {number} cooldown in seconds (0 = disabled)
 */
function normalizeCooldownSec(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_COOLDOWN_SEC, Math.max(0, n));
}

/**
 * Drop stale entries so the cooldown map stays bounded in long-running
 * processes. Entries older than the max possible cooldown can never block
 * a trigger again, so deleting them is safe.
 *
 * @param {Map<string, number>} cooldowns
 * @param {() => number} clock
 */
function sweepCooldowns(cooldowns, clock) {
  if (cooldowns.size < COOLDOWN_SWEEP_SIZE) return;
  const cutoff = clock() - MAX_COOLDOWN_SEC * 1000;
  for (const [mapKey, lastAtMs] of cooldowns) {
    if (lastAtMs < cutoff) cooldowns.delete(mapKey);
  }
}

/**
 * Create a gork rate limiter (per-user cooldown + per-guild FIFO queue).
 * Create one instance per process at feature boot.
 *
 * @param {object} [options]
 * @param {() => number} [options.now=Date.now] clock returning epoch ms
 * @param {number} [options.maxWaiting=5] max waiting (queued) requests per guild
 * @returns {{
 *   checkCooldown: (args: { communityId: number, userId: string, cooldownSec?: number, staff?: boolean }) =>
 *     ({ allowed: true } | { allowed: false, reason: "cooldown", retryAfterMs: number }),
 *   admit: (args: { communityId: number }) =>
 *     { queued: boolean | null, position: number | null, dropped: boolean, turn: Promise<void> | null },
 *   release: (args: { communityId: number }) => void,
 *   runExclusive: <T>(communityId: number, fn: () => T | Promise<T>) =>
 *     Promise<{ dropped: boolean, result?: T, error?: unknown }>,
 *   waitingCount: (args: { communityId: number }) => number,
 *   reset: () => void
 * }}
 */
function createGorkQueue(options) {
  const { now, maxWaiting } = options || {};
  const clock = typeof now === "function" ? now : Date.now;
  const cap = Number(maxWaiting);
  const maxWaitingPerCommunity =
    Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : DEFAULT_MAX_WAITING;

  /** `${communityId}:${userId}` -> last allowed trigger ts (epoch ms). */
  const cooldowns = new Map();
  /** communityId -> { running: boolean, waiting: { resolve: () => void }[] } (FIFO). */
  const communities = new Map();

  /**
   * Get (or lazily create) the queue state for a community.
   *
   * @param {number|string} communityId
   * @returns {{ running: boolean, waiting: { resolve: () => void }[] }}
   */
  function communityState(communityId) {
    let st = communities.get(communityId);
    if (!st) {
      st = { running: false, waiting: [] };
      communities.set(communityId, st);
    }
    return st;
  }

  /**
   * Check the per-user per-community cooldown. The timestamp is recorded when
   * the trigger is allowed (trigger time anchors the next window); hits do
   * not extend the window.
   *
   * @param {object} args
   * @param {number} args.communityId internal communities id (accepts legacy `guildId` alias)
   * @param {string} args.userId
   * @param {number} [args.cooldownSec] guild setting `gork_cooldown_sec` (0-3600; 0 = disabled). Pass the stored guild value; use DEFAULT_COOLDOWN_SEC (180) as the fallback.
   * @param {boolean} [args.staff] staff bypass the cooldown entirely
   * @returns {{ allowed: true } | { allowed: false, reason: "cooldown", retryAfterMs: number }}
   */
  function checkCooldown(args = {}) {
    // TODO(fluxer-pr5): drop the guildId alias once all callers pass communityId.
    const { guildId, userId, staff } = args;
    const communityId = args.communityId ?? guildId;
    if (!communityId || !userId) {
      // Fail closed: missing identity means the trigger must not run.
      return { allowed: false, reason: "cooldown", retryAfterMs: 0 };
    }
    if (staff) return { allowed: true };

    const mapKey = `${communityId}:${userId}`;
    const cooldownSec = normalizeCooldownSec(args.cooldownSec);
    sweepCooldowns(cooldowns, clock);
    const nowMs = clock();
    if (cooldownSec <= 0) {
      cooldowns.set(mapKey, nowMs);
      return { allowed: true };
    }
    const windowMs = cooldownSec * 1000;
    const lastAtMs = cooldowns.get(mapKey);
    if (lastAtMs == null) {
      // Never triggered before (a 0 would read as "epoch 0" and wrongly
      // cooldown a fresh user under a non-epoch clock).
      cooldowns.set(mapKey, nowMs);
      return { allowed: true };
    }
    const elapsedMs = nowMs - lastAtMs;
    if (elapsedMs < windowMs) {
      return { allowed: false, reason: "cooldown", retryAfterMs: windowMs - elapsedMs };
    }
    cooldowns.set(mapKey, nowMs);
    return { allowed: true };
  }

  /**
   * Admit a gork request for a community.
   *
   * Returns the FIFO position and a `turn` promise that resolves when the
   * request may start (immediately when `queued` is false). Exactly 1
   * request is in-flight per community: while the slot is taken, new admits
   * queue FIFO (up to `maxWaiting` waiting); beyond that they are dropped.
   *
   * @param {{ communityId: number }} args accepts legacy `guildId` alias
   * @returns {{ queued: boolean | null, position: number | null, dropped: boolean, turn: Promise<void> | null }}
   *   - `{ queued: false, position: 0, dropped: false, turn }` - go now
   *   - `{ queued: true, position: 1..N, dropped: false, turn }` - queued FIFO
   *   - `{ queued: null, position: null, dropped: true, turn: null }` - queue full
   */
  function admit(args = {}) {
    // TODO(fluxer-pr5): drop the guildId alias once all callers pass communityId.
    const communityId = args.communityId ?? args.guildId;
    if (!communityId) return { queued: null, position: null, dropped: true, turn: null };
    const st = communityState(communityId);
    if (!st.running) {
      st.running = true;
      return { queued: false, position: 0, dropped: false, turn: Promise.resolve() };
    }
    if (st.waiting.length >= maxWaitingPerCommunity) {
      return { queued: null, position: null, dropped: true, turn: null };
    }
    let resolveTurn;
    const turn = new Promise((resolve) => {
      resolveTurn = resolve;
    });
    st.waiting.push({ resolve: resolveTurn });
    return { queued: true, position: st.waiting.length, dropped: false, turn };
  }

  /**
   * Release the in-flight slot for a community: hands it to the head of the
   * FIFO (starting the next queued request) or frees it when none are
   * waiting. Calling release with no in-flight request is a safe no-op.
   *
   * Must be called exactly once per admitted slot (in a `finally` block).
   *
   * @param {{ communityId: number }} args accepts legacy `guildId` alias
   */
  function release(args = {}) {
    // TODO(fluxer-pr5): drop the guildId alias once all callers pass communityId.
    const communityId = args.communityId ?? args.guildId;
    if (!communityId) return;
    const st = communities.get(communityId);
    if (!st || !st.running) return;
    const next = st.waiting.shift();
    if (next) {
      // Slot passes directly to the next waiter; `running` stays true.
      next.resolve();
    } else {
      st.running = false;
    }
  }

  /**
   * Convenience wrapper: admit, wait for the FIFO turn, run `fn`, release.
   *
   * Never throws or rejects for queue-internal reasons: a dropped request
   * resolves to `{ dropped: true }`, and a rejecting `fn` resolves to
   * `{ dropped: false, result: undefined, error }` after the slot has been
   * released.
   *
   * @template T
   * @param {number} communityId
   * @param {() => T | Promise<T>} fn
   * @returns {Promise<{ dropped: boolean, result?: T, error?: unknown }>}
   */
  async function runExclusive(communityId, fn) {
    const slot = admit({ communityId });
    if (slot.dropped) {
      return { dropped: true, result: undefined, error: undefined };
    }
    try {
      await slot.turn;
      const result = await fn();
      return { dropped: false, result, error: undefined };
    } catch (error) {
      return { dropped: false, result: undefined, error };
    } finally {
      release({ communityId });
    }
  }

  /**
   * Number of requests currently waiting (queued) in a community's FIFO.
   *
   * @param {{ communityId: number }} args accepts legacy `guildId` alias
   * @returns {number}
   */
  function waitingCount(args = {}) {
    // TODO(fluxer-pr5): drop the guildId alias once all callers pass communityId.
    const communityId = args.communityId ?? args.guildId;
    if (!communityId) return 0;
    const st = communities.get(communityId);
    return st ? st.waiting.length : 0;
  }

  /**
   * Clear all in-memory state (cooldowns + queues). Test helper; production
   * code relies on process-lifetime state (tests create fresh instances).
   */
  function reset() {
    cooldowns.clear();
    communities.clear();
  }

  return {
    checkCooldown,
    admit,
    release,
    runExclusive,
    waitingCount,
    reset,
  };
}

module.exports = {
  createGorkQueue,
  DEFAULT_COOLDOWN_SEC,
  MAX_COOLDOWN_SEC,
  DEFAULT_MAX_WAITING,
};
