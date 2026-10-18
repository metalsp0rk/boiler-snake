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
  if (cdSec <= 0) {
    map.set(mapKey, nowMs);
    return false;
  }
  const last = map.get(mapKey) || 0;
  if (nowMs - last < cdSec * 1000) return true;
  map.set(mapKey, nowMs);
  return false;
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
  MAX_CONFIG_COOLDOWN_SEC,
  COOLDOWN_SWEEP_MAX_AGE_MS,
};
