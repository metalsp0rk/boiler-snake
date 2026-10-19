/**
 * Cooldown map helpers (in-memory, per process).
 */

/**
 * @param {number} communityId
 * @param {string} userId
 * @returns {string}
 */
function key(communityId, userId) {
  return `${communityId}:${userId}`;
}

/**
 * Drop entries older than maxAgeMs so cooldown maps stay bounded.
 * @param {Map<string, number>} map
 * @param {number} maxAgeMs
 */
function sweepCooldownMap(map, maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  for (const [k, ts] of map.entries()) {
    if (ts < cutoff) map.delete(k);
  }
}

/**
 * Returns true if the key is still within the cooldown window (and thus should skip award).
 * When not cooling down, updates the map with nowMs.
 *
 * @param {Map<string, number>} map
 * @param {string} mapKey
 * @param {number} cooldownSec 0 = no cooldown
 * @param {number} [nowMs]
 * @returns {boolean} true if still cooling down
 */
function isOnCooldown(map, mapKey, cooldownSec, nowMs = Date.now()) {
  const cdSec = Math.max(0, Number(cooldownSec) || 0);
  if (cdSec <= 0) return false;
  const last = map.get(mapKey) || 0;
  return nowMs - last < cdSec * 1000;
}

/**
 * Stamp the window for mapKey (#472 XE-7): check and stamp were once one
 * function, so a check that LED TO a failed unit of work still consumed the
 * window — a transient DB fault during an XP award silently skipped the
 * user's next message even though nothing had been awarded. The stamp now
 * belongs to the caller, executed only after the work actually succeeded:
 *
 *   if (isOnCooldown(map, k, sec)) return;
 *   await doTheThing();          // throwing here leaves the window free
 *   markCooldown(map, k);
 *
 * @param {Map<string, number>} map
 * @param {string} mapKey
 * @param {number} [nowMs]
 */
function markCooldown(map, mapKey, nowMs = Date.now()) {
  map.set(mapKey, nowMs);
}

// #429 (audit XE-2): cooldown windows are ADMIN-CONFIGURABLE — the memory
// sweeper must never evict an entry that could still sit inside a legitimate
// window. The configurable max is ONE DAY (message/reaction XP cooldowns);
// every sweeper must evict only past that plus an hour of slack. If you
// raise the config max, raise this with it (and the DB clamp/migration).
const MAX_CONFIG_COOLDOWN_SEC = 86_400;
const COOLDOWN_SWEEP_MAX_AGE_MS = MAX_CONFIG_COOLDOWN_SEC * 1000 + 60 * 60 * 1000;

module.exports = {
  key,
  sweepCooldownMap,
  isOnCooldown,
  markCooldown,
  MAX_CONFIG_COOLDOWN_SEC,
  COOLDOWN_SWEEP_MAX_AGE_MS,
};
