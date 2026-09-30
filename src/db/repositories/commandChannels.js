const { db, now } = require("../connection");

// Lazy require: src/platform/community.js requires the db facade, so a
// top-level require would be a load-time cycle. See src/db/repositories/users.js.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

function addAllowedCommandChannel(communityId, channelId) {
  assertCommunityId(communityId);
  db.prepare(`
  INSERT OR IGNORE INTO allowed_command_channels (community_id, channel_id, created_at)
  VALUES (?, ?, ?)
  `).run(communityId, channelId, now());
}

function removeAllowedCommandChannel(communityId, channelId) {
  assertCommunityId(communityId);
  db.prepare(`
  DELETE FROM allowed_command_channels
  WHERE community_id=? AND channel_id=?
  `).run(communityId, channelId);
}

function listAllowedCommandChannels(communityId) {
  assertCommunityId(communityId);
  return db.prepare(`
  SELECT channel_id
  FROM allowed_command_channels
  WHERE community_id=?
  ORDER BY created_at ASC
  `).all(communityId);
}

module.exports = {
  addAllowedCommandChannel,
  removeAllowedCommandChannel,
  listAllowedCommandChannels,
};
