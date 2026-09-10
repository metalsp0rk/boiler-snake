/**
 * Primitives shared by the src/web/data page-data builders.
 *
 * These were byte-identical copies across voiceData/settingsData/
 * integrationsData/staffData/dashboardData (textOrNull ×4, numOrNull ×4,
 * guardRead ×4, insertion-ordered cacheSet ×4, the TTL-constant trio ×4).
 * Extracting them keeps the §8.6 invariants (secret-name guards, TTL floors,
 * bounded caches) in ONE auditable place; each builder still owns its own
 * env var, log label, cache TTL clamp, and facade access.
 */

/** §8.6 floor: per-guild data caches never go below 30 s. */
const DEFAULT_CACHE_TTL_MS = 30_000;
const MIN_CACHE_TTL_MS = 30_000;
/** Bounded-cache ceiling (insertion order) so a huge guild set can't grow RAM unbounded. */
const DEFAULT_MAX_ENTRIES = 200;

/**
 * Trimmed non-empty string capped to max (ellipsis on cut), else null.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string|null}
 */
function textOrNull(value, max = 100) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Finite number or null. */
function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Loud, specific, non-throwing read guard (§8.1: a degrading section logs
 * WHY with the error code/name — never a silent drop). Prefix identifies
 * the owning module, e.g. makeGuardRead("voice").
 * @param {string} prefix e.g. "voice"
 * @returns {(read: () => unknown, label: string) => {available: boolean, value: unknown}}
 */
function makeGuardRead(prefix) {
  return function guardRead(read, label) {
    try {
      return { available: true, value: read() };
    } catch (err) {
      console.warn(
        `[web] ${prefix}: ${label} read failed:`,
        err?.code || err?.name || err?.message || "unknown"
      );
      return { available: false, value: null };
    }
  };
}

/**
 * Insertion-ordered Map cache setter: evict oldest beyond maxEntries.
 * Bind with the module's own `cache` Map + resolved maxEntries.
 * @param {Map} cache
 * @param {number} maxEntries
 * @returns {(key: string, entry: unknown) => void}
 */
function makeCacheSet(cache, maxEntries) {
  return function cacheSet(key, entry) {
    cache.set(key, entry);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };
}

/**
 * Shared lavalink availability ladder for the dashboard/voice music cards.
 * Returns the degrade sentinel {status, detail} for the unwired / unconfigured
 * / node-down / no-player rungs, otherwise hands (player, current|null) to
 * onReady for caller-specific shaping — and ANY throw (including inside
 * onReady) degrades to "player read failed": music state must never break a
 * page. detail/status strings are pinned by both page suites — change only
 * with the tests.
 * @param {any} client
 * @param {string} guildId
 * @param {{getManager: Function, isNodeReady: Function}} musicApi
 * @param {(player: any, current: any) => any} onReady
 */
function withMusicPlayer(client, guildId, musicApi, onReady) {
  try {
    if (!client) return { status: "unknown", detail: "no client wired" };
    const manager = musicApi.getManager(client);
    if (!manager) return { status: "unavailable", detail: "lavalink not configured" };
    if (!musicApi.isNodeReady(client)) {
      return { status: "unavailable", detail: "no lavalink node connected" };
    }
    const player = manager.getPlayer?.(guildId) || null;
    if (!player) return { status: "idle", detail: "no active player in this guild" };
    return onReady(player, player.queue?.current || null);
  } catch {
    return { status: "unknown", detail: "player read failed" };
  }
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  MIN_CACHE_TTL_MS,
  DEFAULT_MAX_ENTRIES,
  textOrNull,
  numOrNull,
  makeGuardRead,
  makeCacheSet,
  withMusicPlayer,
};
