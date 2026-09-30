const { db, now } = require("../connection");

// Lazy require: src/platform/community.js requires the db facade, so a
// top-level require would be a load-time cycle. See src/db/repositories/users.js.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

function addHoneypotChannel(communityId, channelId) {
  assertCommunityId(communityId);
  db.prepare(`
  INSERT OR IGNORE INTO honeypot_channels (community_id, channel_id, created_at)
  VALUES (?, ?, ?)
  `).run(communityId, channelId, now());
}

function getHoneypotChannel(communityId, channelId) {
  assertCommunityId(communityId);
  return (
    db.prepare(`
  SELECT channel_id, warning_message_id
  FROM honeypot_channels
  WHERE community_id=? AND channel_id=?
  `).get(communityId, channelId) || null
  );
}

function setHoneypotWarningMessage(communityId, channelId, messageIdOrNull) {
  assertCommunityId(communityId);
  db.prepare(`
  UPDATE honeypot_channels
  SET warning_message_id=?
  WHERE community_id=? AND channel_id=?
  `).run(messageIdOrNull, communityId, channelId);
}

function removeHoneypotChannel(communityId, channelId) {
  assertCommunityId(communityId);
  const existing = getHoneypotChannel(communityId, channelId);
  const result = db.prepare(`
  DELETE FROM honeypot_channels
  WHERE community_id=? AND channel_id=?
  `).run(communityId, channelId);
  return {
    removed: result.changes > 0,
    warning_message_id: existing?.warning_message_id || null,
  };
}

function listHoneypotChannels(communityId) {
  assertCommunityId(communityId);
  return db.prepare(`
  SELECT channel_id, warning_message_id
  FROM honeypot_channels
  WHERE community_id=?
  ORDER BY created_at ASC
  `).all(communityId);
}

function isHoneypotChannel(communityId, channelId) {
  assertCommunityId(communityId);
  const row = db.prepare(`
  SELECT 1 AS ok
  FROM honeypot_channels
  WHERE community_id=? AND channel_id=?
  `).get(communityId, channelId);
  return !!row;
}

/** True if this message is the bot-posted honeypot warning notice. */
function isHoneypotWarningMessage(communityId, messageId) {
  assertCommunityId(communityId);
  if (!messageId) return false;
  const row = db.prepare(`
  SELECT 1 AS ok
  FROM honeypot_channels
  WHERE community_id=? AND warning_message_id=?
  `).get(communityId, messageId);
  return !!row;
}

/** All honeypot warning notices (for reaction sweeps). */
function listAllHoneypotWarnings() {
  return db.prepare(`
  SELECT community_id, channel_id, warning_message_id
  FROM honeypot_channels
  WHERE warning_message_id IS NOT NULL AND warning_message_id != ''
  `).all();
}

// Exempt-role functions moved to staffRoles.js (migration 008).
// Aliases are re-exported from the db facade.

function addHoneypotBanRole(communityId, roleId) {
  assertCommunityId(communityId);
  db.prepare(`
  INSERT OR IGNORE INTO honeypot_ban_roles (community_id, role_id, created_at)
  VALUES (?, ?, ?)
  `).run(communityId, roleId, now());
}

function removeHoneypotBanRole(communityId, roleId) {
  assertCommunityId(communityId);
  const result = db.prepare(`
  DELETE FROM honeypot_ban_roles
  WHERE community_id=? AND role_id=?
  `).run(communityId, roleId);
  return result.changes > 0;
}

function listHoneypotBanRoles(communityId) {
  assertCommunityId(communityId);
  return db.prepare(`
  SELECT role_id
  FROM honeypot_ban_roles
  WHERE community_id=?
  ORDER BY created_at ASC
  `).all(communityId);
}

function isHoneypotBanRole(communityId, roleId) {
  assertCommunityId(communityId);
  const row = db.prepare(`
  SELECT 1 AS ok
  FROM honeypot_ban_roles
  WHERE community_id=? AND role_id=?
  `).get(communityId, roleId);
  return !!row;
}

/**
 * @param {number} communityId
 * @param {string[]} roleIds
 * @returns {string[]}
 */
function findHoneypotBanRolesAmong(communityId, roleIds) {
  assertCommunityId(communityId);
  if (!roleIds?.length) return [];
  const configured = listHoneypotBanRoles(communityId);
  if (!configured.length) return [];
  const banSet = new Set(configured.map((r) => r.role_id));
  return roleIds.filter((id) => banSet.has(id));
}

module.exports = {
  addHoneypotChannel,
  getHoneypotChannel,
  setHoneypotWarningMessage,
  removeHoneypotChannel,
  listHoneypotChannels,
  isHoneypotChannel,
  isHoneypotWarningMessage,
  listAllHoneypotWarnings,
  addHoneypotBanRole,
  removeHoneypotBanRole,
  listHoneypotBanRoles,
  isHoneypotBanRole,
  findHoneypotBanRolesAmong,
};
