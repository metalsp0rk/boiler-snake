const { db, now } = require("../connection");

// Lazy require: src/platform/community.js requires the db facade, so a
// top-level require would be a load-time cycle. See src/db/repositories/users.js.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

function logActivity(communityId, userId, kind, amount = 1) {
  assertCommunityId(communityId);
  db.prepare(`
  INSERT INTO activity_log (community_id, user_id, kind, amount, created_at)
  VALUES (?, ?, ?, ?, ?)
  `).run(communityId, userId, kind, amount, now());
}

function countMessagesInWindow(communityId, userId, windowDays) {
  assertCommunityId(communityId);
  const since = now() - windowDays * 24 * 60 * 60 * 1000;
  const row = db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS c
  FROM activity_log
  WHERE community_id=? AND user_id=? AND kind='message' AND created_at >= ?
  `).get(communityId, userId, since);
  return row?.c ?? 0;
}

/**
 * Retention prune primitive (audit-2026-10 #192): delete AT MOST `limit`
 * activity_log rows strictly older than `cutoffMs` — one bounded batch for
 * the retention sweeper's LIMIT-batched loop (the full-table delete loop
 * policy lives in src/features/retention/sweeps.js, not here). Served by
 * idx_activity_created_at, the index whose 001 schema comment already
 * justified it as aiding "pruning".
 *
 * Boundary: rows at exactly `cutoffMs` SURVIVE (`created_at < cutoffMs`);
 * the sweeper recomputes the cutoff every pass, so they die on the next one.
 *
 * @param {number} cutoffMs ms epoch; rows with created_at < cutoffMs die
 * @param {number} [limit=500] max rows deleted by this single batch
 * @returns {number} rows deleted by this batch
 */
function deleteActivityLogOlderThan(cutoffMs, limit = 500) {
  if (!Number.isSafeInteger(cutoffMs)) {
    throw new TypeError(
      `deleteActivityLogOlderThan: cutoffMs must be an integer ms epoch, got ${String(cutoffMs)}`
    );
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError(
      `deleteActivityLogOlderThan: limit must be a positive integer, got ${String(limit)}`
    );
  }
  return db
    .prepare(`DELETE FROM activity_log WHERE created_at < ? LIMIT ?`)
    .run(cutoffMs, limit).changes;
}

module.exports = {
  logActivity,
  countMessagesInWindow,
  deleteActivityLogOlderThan,
};
