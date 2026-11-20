/**
 * EventSub webhook subscription state (roadmap/twitch-notifications.md).
 *
 * Keyed by (type, broadcaster_id) — the EventSub uniqueness constraint —
 * NOT per guild: one Twitch subscription per broadcaster serves every guild
 * that tracks the channel. Rows are bookkeeping for the reconciler:
 *  - `subscription_id` is Twitch's subscription UUID (null until created);
 *  - `status` mirrors Twitch's subscription status / local state:
 *    pending | enabled | verification_pending | revoked:<reason> | error;
 *  - `last_error` carries the last create/delete failure for ops triage.
 *
 * Reads never throw; they return []/null/0 (same idiom as the twitch repo).
 */

const { db, now } = require("../connection");

const VALID_TYPES = new Set(["stream.online", "stream.offline"]);

function isValidType(type) {
  return VALID_TYPES.has(String(type));
}

/** All tracked subscription rows (reconciler sweep input). */
function getTwitchEventsubSubs() {
  return db
    .prepare(
      `SELECT type, broadcaster_id, subscription_id, status, last_error,
              callback_url, secret_fingerprint, created_at, updated_at
       FROM twitch_eventsub_subs
       ORDER BY broadcaster_id, type`,
    )
    .all();
}

/** Tracked rows for one broadcaster (add/remove flows + prune checks). */
function getTwitchEventsubSubsForBroadcaster(broadcasterId) {
  return db
    .prepare(
      `SELECT type, broadcaster_id, subscription_id, status, last_error,
              callback_url, secret_fingerprint, created_at, updated_at
       FROM twitch_eventsub_subs
       WHERE broadcaster_id=?
       ORDER BY type`,
    )
    .all(String(broadcasterId));
}

function getTwitchEventsubSub(type, broadcasterId) {
  if (!isValidType(type)) return null;
  const row = db
    .prepare(
      `SELECT type, broadcaster_id, subscription_id, status, last_error,
              callback_url, secret_fingerprint, created_at, updated_at
       FROM twitch_eventsub_subs
       WHERE type=? AND broadcaster_id=?`,
    )
    .get(String(type), String(broadcasterId));
  return row || null;
}

/**
 * Record a create attempt (or refresh it): insert-or-replace the row with
 * the current subscription id / status. Used by the reconciler after
 * POST /eventsub/subscriptions and after a 409-conflict GET.
 *
 * #824: `callbackUrl` + `secretFingerprint` are the BINDING the row was
 * created with — the only way the reconciler can ever notice a secret
 * rotation. COALESCE keeps the previous binding when a later call omits
 * it (status-only refreshes must not erase the proof).
 *
 * @param {{ type: string, broadcasterId: string, subscriptionId?: string|null,
 *   status?: string, lastError?: string|null,
 *   callbackUrl?: string|null, secretFingerprint?: string|null }} sub
 */
function upsertTwitchEventsubSub({
  type,
  broadcasterId,
  subscriptionId = null,
  status = "pending",
  lastError = null,
  callbackUrl = null,
  secretFingerprint = null,
}) {
  if (!isValidType(type) || !broadcasterId) return null;
  const t = now();
  db.prepare(`
  INSERT INTO twitch_eventsub_subs
    (type, broadcaster_id, subscription_id, status, last_error, callback_url, secret_fingerprint, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(type, broadcaster_id) DO UPDATE SET
    subscription_id=COALESCE(excluded.subscription_id, twitch_eventsub_subs.subscription_id),
    status=excluded.status,
    last_error=excluded.last_error,
    callback_url=COALESCE(excluded.callback_url, twitch_eventsub_subs.callback_url),
    secret_fingerprint=COALESCE(excluded.secret_fingerprint, twitch_eventsub_subs.secret_fingerprint),
    updated_at=excluded.updated_at
  `).run(String(type), String(broadcasterId), subscriptionId, status, lastError, callbackUrl, secretFingerprint, t, t);
  return getTwitchEventsubSub(type, broadcasterId);
}

/** Flip the status (revocation messages, verification transitions). */
function markTwitchEventsubSubStatus(type, broadcasterId, status, lastError = null) {
  if (!getTwitchEventsubSub(type, broadcasterId)) return false;
  const t = now();
  db.prepare(
    `UPDATE twitch_eventsub_subs
     SET status=?, last_error=?, updated_at=?
     WHERE type=? AND broadcaster_id=?`,
  ).run(String(status), lastError, t, String(type), String(broadcasterId));
  return true;
}

function deleteTwitchEventsubSub(type, broadcasterId) {
  if (!isValidType(type)) return false;
  const res = db
    .prepare("DELETE FROM twitch_eventsub_subs WHERE type=? AND broadcaster_id=?")
    .run(String(type), String(broadcasterId));
  return res.changes > 0;
}

module.exports = {
  EVENTSUB_TYPES: [...VALID_TYPES],
  isValidEventsubType: isValidType,
  getTwitchEventsubSubs,
  getTwitchEventsubSubsForBroadcaster,
  getTwitchEventsubSub,
  upsertTwitchEventsubSub,
  markTwitchEventsubSubStatus,
  deleteTwitchEventsubSub,
};
