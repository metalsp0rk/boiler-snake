/**
 * Gork daily usage budget gate (roadmap/gork.md §7.17, decisions 30–37).
 *
 * Feature-side glue over the gorkBudget repository:
 * - resolve the effective scope for a trigger message
 *   (channel rule → category rule → guild default, decision 30);
 * - tri-state enforcement (decision 31): -1 blocked, 0 unlimited, 1..1000
 *   successful answers per user per UTC day. Staff are NOT exempt
 *   (decision 35) — this is cost/noise control, not a politeness timer;
 * - terse directed rejection replies (decision 34): ephemerals are
 *   impossible on plain-message triggers, so the reply names the effective
 *   scope + the 00:00 UTC reset, deduped to at most one reply per
 *   user+scope per hour in memory (further triggers bounce silently);
 * - the 🕐 reaction stays cooldown-only; blocked scopes explain themselves
 *   with their own line instead.
 *
 * The gate is check-only (no writes); the increment lives in trigger.js
 * after all reply chunks delivered (decision 32), before the guild queue
 * slot is released, so enqueue AND dequeue can re-check without ever
 * allowing an overage (decision 33).
 */

/** Rejection-reply dedup window (decision 34): 1 per user per scope per hour. */
const REJECT_DEDUP_MS = 3_600_000;
/** Sweep the dedup map once it grows past this many entries (queue.js idiom). */
const REJECT_SWEEP_SIZE = 10_000;
/** ChannelType.GuildCategory (duck-typed walk; keeps discord.js out of this module). */
const CATEGORY_TYPE = 4;

/** LOCKED rejection wording (decision 34): the blocked-scope surface. */
const BLOCKED_SURFACES = {
  channel: "gork isn't available in this channel.",
  category: "gork isn't available in this category.",
  guild: "gork isn't available in this server.",
};

/**
 * Human tri-state rendering for commands/status/labels.
 *
 * @param {unknown} limit
 * @returns {string} "blocked" | "unlimited" | "<n>/day"
 */
function formatDailyLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return "unlimited";
  if (n < 0) return "blocked";
  if (n === 0) return "unlimited";
  return `${n}/day`;
}

/**
 * Duck-typed parent-category id for a message channel (pure).
 * Guild channels: the parent IS the category. Threads: parent is the text
 * channel, so climb one more level. Anything untyped/unnamed → null (the
 * category rule layer simply does not match, same as an unfiled channel).
 *
 * @param {object|null|undefined} channel discord.js channel (or a duck-typed subset)
 * @returns {string|null}
 */
function categoryIdForChannel(channel) {
  let parent = channel?.parent ?? null;
  for (let depth = 0; depth < 2 && parent; depth += 1) {
    if (Number(parent.type) === CATEGORY_TYPE) {
      return parent.id != null ? String(parent.id) : null;
    }
    parent = parent.parent ?? null;
  }
  return null;
}

/** discord.js ChannelType thread values (isThread()-less duck fallback):
 * 10 = news thread, 11 = public thread, 12 = private thread. */
const THREAD_TYPES = new Set([10, 11, 12]);

/**
 * The channel id that budget rules bind for a trigger channel (pure).
 * Threads resolve to their PARENT channel id: when staff set a rule on
 * #general (or kill-switch it with -1), triggers fired in threads under
 * #general must still obey it — a thread is not a budget escape hatch for
 * the channel above it. Plain channels (and duck-typed stubs without any
 * thread evidence) keep their own id. The winning channel counter keys on
 * this resolved id, so one channel shares a single counter across its
 * threads. (Same thread→parent climb the category layer already does.)
 *
 * @param {object|null|undefined} channel discord.js channel (or duck-typed subset)
 * @returns {string|null}
 */
function channelScopeIdFor(channel) {
  if (!channel || channel.id == null) return null;
  const parent = channel.parent ?? null;
  const isThread =
    typeof channel.isThread === "function"
      ? Boolean(channel.isThread())
      : THREAD_TYPES.has(Number(channel.type));
  if (isThread && parent?.id != null) return String(parent.id);
  return String(channel.id);
}

/**
 * Best-effort human label for the winning scope (§7.17.5 names the scope in
 * the rejection: "…reached in #general (5/day)"). Falls back to generic
 * wording when the duck-typed channel cannot supply the name.
 *
 * @param {{ scopeKind: string, scopeId: string }} scope resolveBudget() output
 * @param {object|null|undefined} channel trigger message channel (duck-typed)
 * @returns {string}
 */
function scopeLabel(scope, channel) {
  const kind = scope?.scopeKind;
  if (kind === "guild") return "this server";
  if (kind === "category") {
    const parent = channel?.parent;
    if (parent && String(parent.id) === String(scope.scopeId) && parent.name) {
      return `category "${parent.name}"`;
    }
    if (parent?.parent && String(parent.parent.id) === String(scope.scopeId) && parent.parent.name) {
      return `category "${parent.parent.name}"`; // thread → text channel → category
    }
    return "this category";
  }
  // Direct match on the trigger channel, or (thread triggers) on the parent
  // channel the resolved rule actually bound to — name whichever matches.
  if (channel && String(channel.id) === String(scope.scopeId) && channel.name) {
    return `#${channel.name}`;
  }
  if (channel?.parent && String(channel.parent.id) === String(scope.scopeId) && channel.parent.name) {
    return `#${channel.parent.name}`;
  }
  return "this channel";
}

/**
 * Create the hourly rejection-reply throttle (decision 34: "at most one
 * rejection reply per user per scope per hour (in-memory); further triggers
 * inside that window bounce silently"). Injectable clock like queue.js.
 *
 * @param {object} [options]
 * @param {() => number} [options.now=Date.now] clock returning epoch ms
 * @returns {{
 *   shouldSend: (args: { guildId: string, userId: string, scopeKind: string, scopeId: string }) => boolean,
 *   reset: () => void,
 *   size: () => number
 * }}
 */
function createBudgetRejectThrottle(options) {
  const clock = typeof options?.now === "function" ? options.now : Date.now;
  /** `${guildId}|${userId}|${scopeKind}|${scopeId}` -> last reply ts (ms). */
  const lastReplyAt = new Map();

  /** Drop entries whose window has fully expired once the map grows large. */
  function sweep(nowMs) {
    if (lastReplyAt.size < REJECT_SWEEP_SIZE) return;
    const cutoff = nowMs - REJECT_DEDUP_MS;
    for (const [key, ts] of lastReplyAt) {
      if (ts < cutoff) lastReplyAt.delete(key);
    }
  }

  /**
   * Consume one reply slot for this user+scope: true when the caller may
   * send a rejection reply now, false when a reply already went out within
   * the hour (silent bounce).
   *
   * @param {{ guildId: string, userId: string, scopeKind: string, scopeId: string }} args
   * @returns {boolean}
   */
  function shouldSend(args) {
    const { guildId, userId, scopeKind, scopeId } = args || {};
    if (!guildId || !userId) return false; // fail closed: no identity, no reply
    const nowMs = clock();
    sweep(nowMs);
    const key = `${guildId}|${userId}|${scopeKind}|${scopeId}`;
    const last = lastReplyAt.get(key);
    if (last != null && nowMs - last < REJECT_DEDUP_MS) return false;
    lastReplyAt.set(key, nowMs);
    return true;
  }

  /** Clear all throttle state (test helper). */
  function reset() {
    lastReplyAt.clear();
  }

  return { shouldSend, reset, size: () => lastReplyAt.size };
}

/** Process-wide throttle shared by the enqueue + dequeue rejection sites. */
const budgetRejectThrottle = createBudgetRejectThrottle();

/**
 * Check the daily budget for one trigger (read-only; decision 33 calls this
 * at BOTH enqueue and dequeue). Never throws for budget reasons; a DB read
 * failure rejects the trigger (fail closed — the caller logs it).
 *
 * @param {object} args
 * @param {string} args.guildId
 * @param {string} args.userId
 * @param {object} args.channel trigger message channel (duck-typed: id + parent)
 * @param {string} args.day YYYY-MM-DD UTC of the TRIGGER MESSAGE (decision 36) —
 *   pass the same day through enqueue → dequeue → increment for one message
 * @returns {{ allowed: true, scope: { scopeKind: string, scopeId: string, limit: number } }
 *          | { allowed: false, kind: "blocked" | "over", reply: string, scope: { scopeKind: string, scopeId: string, limit: number } }
 *          | { allowed: false, kind: "error", reply: "", scope: null }}
 */
function checkGorkBudget({ guildId, userId, channel, day }) {
  // Lazy requires keep this module load-order-free for unit tests that stub
  // only what they need.
  const { getGuildSettings, listGorkBudgetRules, getGorkUsage, resolveGorkBudget } =
    require("../../db");
  let scope;
  try {
    const settings = getGuildSettings(guildId);
    scope = resolveGorkBudget(
      listGorkBudgetRules(guildId),
      channelScopeIdFor(channel),
      categoryIdForChannel(channel),
      settings?.gork_daily_limit ?? 0,
    );
  } catch (err) {
    console.error(`[gork] budget resolve failed in ${guildId}:`, err?.message || err);
    return { allowed: false, kind: "error", reply: "", scope: null };
  }

  if (scope.limit < 0) {
    // Blocked scope (-1): kill switch, staff included, own surface (decision 34).
    const kind = scope.scopeKind in BLOCKED_SURFACES ? scope.scopeKind : "channel";
    return { allowed: false, kind: "blocked", reply: BLOCKED_SURFACES[kind], scope };
  }
  if (scope.limit === 0) return { allowed: true, scope }; // unlimited (default)

  let used = 0;
  try {
    used = getGorkUsage(guildId, userId, scope.scopeKind, scope.scopeId, day);
  } catch (err) {
    console.error(`[gork] budget usage read failed in ${guildId}:`, err?.message || err);
    return { allowed: false, kind: "error", reply: "", scope: null };
  }
  if (used >= scope.limit) {
    const label = scopeLabel(scope, channel);
    return {
      allowed: false,
      kind: "over",
      reply: `Daily gork budget reached in ${label} (${scope.limit}/day) — resets 00:00 UTC.`,
      scope,
    };
  }
  return { allowed: true, scope };
}

/**
 * Consume a rejection-reply slot for this user+scope (hourly dedup).
 *
 * @param {object} args
 * @param {string} args.guildId
 * @param {string} args.userId
 * @param {{ scopeKind: string, scopeId: string }} args.scope
 * @returns {boolean} true → send `reply` to the trigger; false → bounce silently
 */
function shouldSendBudgetRejection({ guildId, userId, scope }) {
  if (!scope) return false;
  return budgetRejectThrottle.shouldSend({
    guildId,
    userId,
    scopeKind: scope.scopeKind,
    scopeId: scope.scopeId,
  });
}

/**
 * Count one SUCCESSFUL answer in the winning scope's counter (§7.17.3:
 * exactly once per trigger message, after all reply chunks delivered, before
 * the queue slot is released). Unlimited (0) scopes keep no counter — the
 * winning scope of an unlimited resolution never needs enforcement, and this
 * keeps the default (all-unlimited) config write-free.
 *
 * @param {object} args
 * @param {string} args.guildId
 * @param {string} args.userId
 * @param {{ scopeKind: string, scopeId: string, limit: number }} args.scope winning scope
 * @param {string} args.day YYYY-MM-DD UTC (trigger message's day)
 * @returns {number|null} post-increment count, or null when nothing counted
 */
function recordGorkBudgetUsage({ guildId, userId, scope, day }) {
  if (!scope || !(scope.limit >= 1)) return null;
  const { incrementGorkUsage } = require("../../db");
  return incrementGorkUsage(guildId, userId, scope.scopeKind, scope.scopeId, day);
}

/**
 * Budget label for the Q&A audit embed (§7.17.7: `3/5 in #general`; shown
 * only when the effective limit is >= 1).
 *
 * @param {{ scopeKind: string, scopeId: string, limit: number }} scope
 * @param {number} used post-increment count
 * @param {object|null|undefined} channel trigger message channel (duck-typed)
 * @returns {string|undefined} undefined → field omitted from the embed
 */
function formatBudgetLabel(scope, used, channel) {
  if (!scope || !(scope.limit >= 1)) return undefined;
  return `${used}/${scope.limit} in ${scopeLabel(scope, channel)}`;
}

/** TEST SEAM: clear the process-wide rejection throttle (fresh windows). */
function resetBudgetRejectThrottleForTests() {
  budgetRejectThrottle.reset();
}

module.exports = {
  REJECT_DEDUP_MS,
  BLOCKED_SURFACES,
  formatDailyLimit,
  categoryIdForChannel,
  channelScopeIdFor,
  scopeLabel,
  createBudgetRejectThrottle,
  checkGorkBudget,
  shouldSendBudgetRejection,
  recordGorkBudgetUsage,
  formatBudgetLabel,
  resetBudgetRejectThrottleForTests,
};
