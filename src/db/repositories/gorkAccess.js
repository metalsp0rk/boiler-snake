/**
 * Gork access-control repository: per-community user blocks.
 *
 * Membership-table pattern (same shape as honeypot_ban_roles): INSERT OR
 * IGNORE for idempotent adds, DELETE reporting `changes` for removes.
 * The community enable/disable switch lives on guild_settings
 * (`gork_enabled`), not here.
 */

const { db, now } = require("../connection");

// Lazy require: src/platform/community.js requires the db facade, so a
// top-level require would be a load-time cycle. See src/db/repositories/users.js.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

/**
 * Ban a user from using gork in a community (idempotent).
 *
 * @param {number} communityId
 * @param {string} userId
 * @param {string|null} [createdBy] staff user id who issued the ban (audit)
 * @returns {void}
 */
function addGorkBlock(communityId, userId, createdBy = null) {
  assertCommunityId(communityId);
  db.prepare(`
  INSERT OR IGNORE INTO gork_user_blocks (community_id, user_id, created_by, created_at)
  VALUES (?, ?, ?, ?)
  `).run(communityId, userId, createdBy ?? null, now());
}

/**
 * Remove a gork block.
 *
 * @param {number} communityId
 * @param {string} userId
 * @returns {boolean} true when a block actually existed and was removed
 */
function removeGorkBlock(communityId, userId) {
  assertCommunityId(communityId);
  const result = db.prepare(`
  DELETE FROM gork_user_blocks
  WHERE community_id=? AND user_id=?
  `).run(communityId, userId);
  return result.changes > 0;
}

/**
 * @param {number} communityId
 * @param {string} userId
 * @returns {boolean}
 */
function isGorkBlocked(communityId, userId) {
  assertCommunityId(communityId);
  if (!userId) return false;
  const row = db.prepare(`
  SELECT 1 AS ok
  FROM gork_user_blocks
  WHERE community_id=? AND user_id=?
  `).get(communityId, userId);
  return !!row;
}

/**
 * All blocked users in a community, oldest block first.
 *
 * @param {number} communityId
 * @returns {{ user_id: string, created_by: string|null, created_at: number }[]}
 */
function listGorkBlocks(communityId) {
  assertCommunityId(communityId);
  return db.prepare(`
  SELECT user_id, created_by, created_at
  FROM gork_user_blocks
  WHERE community_id=?
  ORDER BY created_at ASC, user_id ASC
  `).all(communityId);
}

module.exports = {
  addGorkBlock,
  removeGorkBlock,
  isGorkBlocked,
  listGorkBlocks,
};
