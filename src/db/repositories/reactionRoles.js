const { db, now } = require("../connection");

// Lazy require: src/platform/community.js requires the db facade, so a
// top-level require would be a load-time cycle. See src/db/repositories/users.js.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

function createReactionRolePanel(communityId, channelId, messageId, title, description) {
  assertCommunityId(communityId);
  const t = now();
  db.prepare(`
  INSERT INTO reaction_role_panels (community_id, channel_id, message_id, title, description, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    communityId,
    channelId,
    messageId,
    title || "Reaction Roles",
    description || "React to get a role. Remove your reaction to drop it (if allowed).",
    t,
    t
  );
}

function getReactionRolePanel(communityId, messageId) {
  assertCommunityId(communityId);
  return (
    db.prepare(`
  SELECT community_id, channel_id, message_id, title, description, created_at, updated_at
  FROM reaction_role_panels
  WHERE community_id=? AND message_id=?
  `).get(communityId, messageId) || null
  );
}

function listReactionRolePanels(communityId) {
  assertCommunityId(communityId);
  return db.prepare(`
  SELECT community_id, channel_id, message_id, title, description, created_at, updated_at
  FROM reaction_role_panels
  WHERE community_id=?
  ORDER BY created_at ASC
  `).all(communityId);
}

function updateReactionRolePanelText(communityId, messageId, title, description) {
  assertCommunityId(communityId);
  const existing = getReactionRolePanel(communityId, messageId);
  if (!existing) return false;
  const t = now();
  db.prepare(`
  UPDATE reaction_role_panels
  SET title=?, description=?, updated_at=?
  WHERE community_id=? AND message_id=?
  `).run(
    title != null ? title : existing.title,
    description != null ? description : existing.description,
    t,
    communityId,
    messageId
  );
  return true;
}

function deleteReactionRolePanel(communityId, messageId) {
  assertCommunityId(communityId);
  const existing = getReactionRolePanel(communityId, messageId);
  if (!existing) {
    return { removed: false, channel_id: null };
  }
  db.prepare(`
  DELETE FROM reaction_role_options
  WHERE community_id=? AND message_id=?
  `).run(communityId, messageId);
  const result = db.prepare(`
  DELETE FROM reaction_role_panels
  WHERE community_id=? AND message_id=?
  `).run(communityId, messageId);
  return {
    removed: result.changes > 0,
    channel_id: existing.channel_id,
  };
}

function isReactionRolePanel(communityId, messageId) {
  assertCommunityId(communityId);
  const row = db.prepare(`
  SELECT 1 AS ok
  FROM reaction_role_panels
  WHERE community_id=? AND message_id=?
  `).get(communityId, messageId);
  return !!row;
}

function upsertReactionRoleOption(
  communityId,
  messageId,
  emojiKey,
  emojiDisplay,
  roleId,
  minLevel,
  removable
) {
  assertCommunityId(communityId);
  const t = now();
  db.prepare(`
  INSERT INTO reaction_role_options (
    community_id, message_id, emoji_key, emoji_display, role_id, min_level, removable, created_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(community_id, message_id, emoji_key) DO UPDATE SET
    emoji_display=excluded.emoji_display,
    role_id=excluded.role_id,
    min_level=excluded.min_level,
    removable=excluded.removable,
    updated_at=excluded.updated_at
  `).run(
    communityId,
    messageId,
    emojiKey,
    emojiDisplay,
    roleId,
    Math.max(0, Number(minLevel) || 0),
    removable ? 1 : 0,
    t,
    t
  );
}

function deleteReactionRoleOption(communityId, messageId, emojiKey) {
  assertCommunityId(communityId);
  const result = db.prepare(`
  DELETE FROM reaction_role_options
  WHERE community_id=? AND message_id=? AND emoji_key=?
  `).run(communityId, messageId, emojiKey);
  return result.changes > 0;
}

function listReactionRoleOptions(communityId, messageId) {
  assertCommunityId(communityId);
  return db.prepare(`
  SELECT community_id, message_id, emoji_key, emoji_display, role_id, min_level, removable, created_at, updated_at
  FROM reaction_role_options
  WHERE community_id=? AND message_id=?
  ORDER BY created_at ASC
  `).all(communityId, messageId);
}

function getReactionRoleOption(communityId, messageId, emojiKey) {
  assertCommunityId(communityId);
  return (
    db.prepare(`
  SELECT community_id, message_id, emoji_key, emoji_display, role_id, min_level, removable, created_at, updated_at
  FROM reaction_role_options
  WHERE community_id=? AND message_id=? AND emoji_key=?
  `).get(communityId, messageId, emojiKey) || null
  );
}

function countReactionRoleOptions(communityId, messageId) {
  assertCommunityId(communityId);
  const row = db.prepare(`
  SELECT COUNT(*) AS n
  FROM reaction_role_options
  WHERE community_id=? AND message_id=?
  `).get(communityId, messageId);
  return Number(row?.n) || 0;
}

/**
 * Lowest min_level among all reaction-role options that grant each role in a community.
 * @returns {{ role_id: string, min_level: number }[]}
 */
function listReactionRoleLevelRequirements(communityId) {
  assertCommunityId(communityId);
  return db.prepare(`
  SELECT role_id, MIN(min_level) AS min_level
  FROM reaction_role_options
  WHERE community_id=?
  GROUP BY role_id
  `).all(communityId);
}

module.exports = {
  createReactionRolePanel,
  getReactionRolePanel,
  listReactionRolePanels,
  updateReactionRolePanelText,
  deleteReactionRolePanel,
  isReactionRolePanel,
  upsertReactionRoleOption,
  deleteReactionRoleOption,
  listReactionRoleOptions,
  getReactionRoleOption,
  countReactionRoleOptions,
  listReactionRoleLevelRequirements,
};
