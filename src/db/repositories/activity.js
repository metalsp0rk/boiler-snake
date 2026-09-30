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

module.exports = {
  logActivity,
  countMessagesInWindow,
};
