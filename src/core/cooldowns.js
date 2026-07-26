/**
 * Cooldown map helpers (in-memory, per process).
 */

/**
 * @param {string} guildId
 * @param {string} userId
 * @returns {string}
 */
function key(guildId, userId) {
  return `${guildId}:${userId}`;
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

module.exports = {
  key,
  sweepCooldownMap,
  isOnCooldown,
};
