/**
 * Per-guild `/gork summarize` cooldown gate (roadmap/gork.md §7.21.5,
 * proposed decision 57): one posted rundown per guild per
 * `GORK_SUMMARIZE_GUILD_COOLDOWN_MS` (10 minutes, fixed constant — NOT
 * per-guild configurable, constants-first like the rest of gork).
 *
 * Keys are internal integer community ids (Fluxer PR2); the in-memory Map
 * treats them as opaque values, so callers pass `communities.id` integers.
 *
 * Contract:
 * - **Arms on SUCCESS only.** The gate never decides when to arm: the handler
 *   (subtask 08) calls `armSummarizeGuildCooldown(communityId)` at the moment
 *   the rundown embed lands — mirroring decision 32's success-only counting,
 *   so usage errors, empty ranges, and failed generations never lock a guild
 *   out of an immediate retry.
 * - While armed, the handler replies with the minutes remaining
 *   (`summarizeCooldownMinutesRemaining(remainingMs)` — rounds UP so a
 *   still-blocked guild is never told "0 minutes").
 * - State is in-memory (per process) only; a bot restart clears it (accepted
 *   per §7.21.5: queue + daily budget still bound abuse).
 * - The gate NEVER throws and holds NO timers — timestamp comparison only,
 *   mirroring queue.js's sweep-free timestamp style. Expired entries are
 *   deleted lazily on read, so the Map self-cleans; its size is naturally
 *   bounded by the number of guilds the bot is in (guild-level keys, unlike
 *   queue.js's per-user keys, so no size sweep is needed).
 * - A missing/invalid `communityId` fails OPEN (check reports "not armed",
 *   arm is a no-op): the cooldown is an abuse limiter, not a security gate,
 *   and the caller's guards (requireStaff, `interaction.guildId` →
 *   `ensureCommunity`) already own that identity check.
 *
 * The clock is injectable (`createSummarizeCooldownGate({ now })`) so tests
 * fast-forward time deterministically — same seam as queue.js; the
 * module-level singleton mirrors budget.js's throttle + `*ForTests` reset.
 *
 * Intended usage (handlers.js, subtask 08):
 *
 * ```js
 * const remainingMs = checkSummarizeGuildCooldown(communityId);
 * if (remainingMs > 0) {
 *   // reply with summarizeCooldownMinutesRemaining(remainingMs) and stop
 * }
 * // ...generate + post the rundown embed...
 * armSummarizeGuildCooldown(communityId); // ONLY after the post succeeded
 * ```
 */

const { GORK_SUMMARIZE_GUILD_COOLDOWN_MS } = require("./constants");

/**
 * Normalize a community id into a Map key. Accepts the integer community id
 * (plus string/bigint for tolerant callers/tests); anything else (incl.
 * null/undefined/"") is identity-less.
 *
 * @param {unknown} communityId
 * @returns {string|null} normalized key, or null when there is no identity
 */
function normalizeCommunityId(communityId) {
  if (typeof communityId === "string") return communityId === "" ? null : communityId;
  if (typeof communityId === "number" || typeof communityId === "bigint") {
    // 0 / 0n carry no identity (no community id is 0) — same "nothing there"
    // case as the empty string, not a community keyed as "0".
    return communityId ? String(communityId) : null;
  }
  return null;
}

/**
 * Minutes remaining for the "still on cooldown" reply: rounds UP so the
 * guild never sees "0 minutes" while the window is still running.
 *
 * @param {number} remainingMs value from checkCooldown (0 = not armed)
 * @returns {number} whole minutes for the reply (0 when not armed)
 */
function summarizeCooldownMinutesRemaining(remainingMs) {
  const ms = Number(remainingMs);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / 60000);
}

/**
 * Create an independent cooldown gate instance. Production code uses the
 * module-level singleton wrappers below; tests create fresh instances with a
 * fake clock.
 *
 * @param {object} [options]
 * @param {() => number} [options.now=Date.now] clock returning epoch ms
 * @returns {{
 *   checkCooldown: (communityId: unknown) => number,
 *   armCooldown: (communityId: unknown) => void,
 *   reset: () => void
 * }}
 */
function createSummarizeCooldownGate(options = {}) {
  const clock = typeof options.now === "function" ? options.now : Date.now;

  /** communityId key -> armedAtMs (epoch ms). One ts per guild: re-arming refreshes, never stacks. */
  const armedAt = new Map();

  /**
   * Remaining cooldown for a community.
   *
   * @param {unknown} communityId
   * @returns {number} remaining ms (>0 → reply with minutes remaining);
   *   0 when not armed, expired, or communityId is invalid (fail open).
   */
  function checkCooldown(communityId) {
    const key = normalizeCommunityId(communityId);
    if (key === null) return 0;
    const armedMs = armedAt.get(key);
    if (armedMs === undefined) return 0;
    // Clamp into [0, window]: a backward system-clock jump can never inflate
    // the reply past the configured cooldown.
    const remainingMs = Math.min(
      GORK_SUMMARIZE_GUILD_COOLDOWN_MS,
      Math.max(0, armedMs + GORK_SUMMARIZE_GUILD_COOLDOWN_MS - clock()),
    );
    if (remainingMs <= 0) {
      armedAt.delete(key); // lazy GC of expired entries on read
      return 0;
    }
    return remainingMs;
  }

  /**
   * Start (or refresh) the community's cooldown window. Call ONLY when the
   * rundown embed post succeeded — never on usage errors, empty ranges, or
   * failed generations (§7.21.5). Invalid communityId is a silent no-op.
   *
   * @param {unknown} communityId
   */
  function armCooldown(communityId) {
    const key = normalizeCommunityId(communityId);
    if (key === null) return;
    armedAt.set(key, clock());
  }

  /**
   * Clear all in-memory state. Test helper; production code relies on
   * process-lifetime state (a restart clearing it is accepted, §7.21.5).
   */
  function reset() {
    armedAt.clear();
  }

  return { checkCooldown, armCooldown, reset };
}

/** Process-wide gate used by the /gork summarize handler. */
const defaultGate = createSummarizeCooldownGate();

/**
 * Singleton wrapper — see the gate's `checkCooldown`.
 *
 * @param {unknown} communityId
 * @returns {number} remaining ms, 0 when allowed
 */
function checkSummarizeGuildCooldown(communityId) {
  return defaultGate.checkCooldown(communityId);
}

/**
 * Singleton wrapper — see the gate's `armCooldown`. ARM ON SUCCESS ONLY.
 *
 * @param {unknown} communityId
 */
function armSummarizeGuildCooldown(communityId) {
  defaultGate.armCooldown(communityId);
}

/** TEST SEAM: clear the process-wide gate (fresh windows). */
function resetSummarizeGuildCooldownForTests() {
  defaultGate.reset();
}

module.exports = {
  GORK_SUMMARIZE_GUILD_COOLDOWN_MS,
  createSummarizeCooldownGate,
  checkSummarizeGuildCooldown,
  armSummarizeGuildCooldown,
  summarizeCooldownMinutesRemaining,
  resetSummarizeGuildCooldownForTests,
};
