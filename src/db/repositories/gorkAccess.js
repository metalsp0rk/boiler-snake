/**
 * Gork access-control repository: per-guild user blocks.
 *
 * Membership-table pattern (same shape as honeypot_ban_roles): INSERT OR
 * IGNORE for idempotent adds, DELETE reporting `changes` for removes.
 * The guild enable/disable switch lives on guild_settings (`gork_enabled`),
 * not here.
 */

const { db, now } = require("../connection");

/**
 * Ban a user from using gork in a guild (idempotent).
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {string|null} [createdBy] staff user id who issued the ban (audit)
 * @returns {void}
 */
function addGorkBlock(guildId, userId, createdBy = null) {
  db.prepare(`
  INSERT OR IGNORE INTO gork_user_blocks (guild_id, user_id, created_by, created_at)
  VALUES (?, ?, ?, ?)
  `).run(guildId, userId, createdBy ?? null, now());
}

/**
 * Remove a gork block.
 *
 * @param {string} guildId
 * @param {string} userId
 * @returns {boolean} true when a block actually existed and was removed
 */
function removeGorkBlock(guildId, userId) {
  const result = db.prepare(`
  DELETE FROM gork_user_blocks
  WHERE guild_id=? AND user_id=?
  `).run(guildId, userId);
  return result.changes > 0;
}

/**
 * @param {string} guildId
 * @param {string} userId
 * @returns {boolean}
 */
function isGorkBlocked(guildId, userId) {
  if (!guildId || !userId) return false;
  const row = db.prepare(`
  SELECT 1 AS ok
  FROM gork_user_blocks
  WHERE guild_id=? AND user_id=?
  `).get(guildId, userId);
  return !!row;
}

/**
 * All blocked users in a guild, oldest block first.
 *
 * @param {string} guildId
 * @returns {{ user_id: string, created_by: string|null, created_at: number }[]}
 */
function listGorkBlocks(guildId) {
  return db.prepare(`
  SELECT user_id, created_by, created_at
  FROM gork_user_blocks
  WHERE guild_id=?
  ORDER BY created_at ASC, user_id ASC
  `).all(guildId);
}

module.exports = {
  addGorkBlock,
  removeGorkBlock,
  isGorkBlocked,
  listGorkBlocks,
};
