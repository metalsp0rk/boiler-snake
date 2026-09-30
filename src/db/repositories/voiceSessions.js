const { db } = require("../connection");

// Lazy require: src/platform/community.js requires the db facade, so a
// top-level require would be a load-time cycle. See src/db/repositories/users.js.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

function upsertVoiceSession(communityId, userId, channelId, joinedAtMs) {
  assertCommunityId(communityId);
  db.prepare(`
  INSERT INTO voice_sessions (community_id, user_id, channel_id, joined_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(community_id, user_id) DO UPDATE SET channel_id=excluded.channel_id, joined_at=excluded.joined_at
  `).run(communityId, userId, channelId, joinedAtMs);
}

function getVoiceSession(communityId, userId) {
  assertCommunityId(communityId);
  return db.prepare(`
  SELECT community_id, user_id, channel_id, joined_at
  FROM voice_sessions
  WHERE community_id=? AND user_id=?
  `).get(communityId, userId);
}

function deleteVoiceSession(communityId, userId) {
  assertCommunityId(communityId);
  db.prepare(`DELETE FROM voice_sessions WHERE community_id=? AND user_id=?`).run(communityId, userId);
}

module.exports = {
  upsertVoiceSession,
  getVoiceSession,
  deleteVoiceSession,
};
