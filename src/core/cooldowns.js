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
 * Stamp the window for mapKey. For AWAITED work use
 * {@link reserveCooldown} + {@link releaseCooldownReservation} instead:
 * stamping after an await re-opened the burst race (#894). The
 * stamp-after-success shape this documents (#472 XE-7 — a failed unit of
 * work must not burn the window) is now carried by the release half.
 *
 * @param {Map<string, number>} map
 * @param {string} mapKey
 * @param {number} [nowMs]
 */
function markCooldown(map, mapKey, nowMs = Date.now()) {
  map.set(mapKey, nowMs);
}

/**
 * Reserve the window BEFORE the awaited work (#894, audit r4 F2). The
 * message/reaction pipelines run ONE unit per event CONCURRENTLY (each
 * event is an independent fire-and-forget run), so the XE-7 idiom's
 * stamp-after-success let every burst message clear the gate while the
 * first award was still in flight — the configured cooldown simply did
 * not bind under rapid-fire spam. Reserve-first closes that window;
 * XE-7 fairness survives via {@link releaseCooldownReservation}: work
 * that FAILED puts the window back.
 *
 *   if (isOnCooldown(map, k, sec)) return;
 *   const held = reserveCooldown(map, k);
 *   const res = await doTheThing();
 *   releaseCooldownReservation(map, k, held, res.ok !== false);
 *
 * @param {Map<string, number>} map
 * @param {string} mapKey
 * @param {number} [nowMs]
 * @returns {{ stamp: number, previous: number|undefined }} reservation token
 */
function reserveCooldown(map, mapKey, nowMs = Date.now()) {
  const previous = map.get(mapKey);
  map.set(mapKey, nowMs);
  return { stamp: nowMs, previous };
}

/**
 * Settle a {@link reserveCooldown} reservation. Work that SUCCEEDED keeps
 * the reservation as the window (nothing to do). Work that FAILED (or threw
 * — the caller finalizes with `false` before rethrowing) restores the stamp
 * that was live when the reservation was made, but ONLY while this slot
 * still carries OUR stamp: a losing reservation must never wipe a newer
 * concurrent winner's window (XE-7: no pay, no window — bounded to the
 * loser's own).
 *
 * @param {Map<string, number>} map
 * @param {string} mapKey
 * @param {{ stamp: number, previous: number|undefined }} held reservation token
 * @param {boolean} worked true when the unit of work actually succeeded
 */
function releaseCooldownReservation(map, mapKey, held, worked) {
  if (worked) return;
  if (map.get(mapKey) !== held.stamp) return;
  if (held.previous === undefined) map.delete(mapKey);
  else map.set(mapKey, held.previous);
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
  reserveCooldown,
  releaseCooldownReservation,
  MAX_CONFIG_COOLDOWN_SEC,
  COOLDOWN_SWEEP_MAX_AGE_MS,
};
