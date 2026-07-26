const { db, now } = require("../connection");

function createReactionRolePanel(guildId, channelId, messageId, title, description) {
  const t = now();
  db.prepare(`
  INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, title, description, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    guildId,
    channelId,
    messageId,
    title || "Reaction Roles",
    description || "React to get a role. Remove your reaction to drop it (if allowed).",
    t,
    t
  );
}

function getReactionRolePanel(guildId, messageId) {
  return (
    db.prepare(`
  SELECT guild_id, channel_id, message_id, title, description, created_at, updated_at
  FROM reaction_role_panels
  WHERE guild_id=? AND message_id=?
  `).get(guildId, messageId) || null
  );
}

function listReactionRolePanels(guildId) {
  return db.prepare(`
  SELECT guild_id, channel_id, message_id, title, description, created_at, updated_at
  FROM reaction_role_panels
  WHERE guild_id=?
  ORDER BY created_at ASC
  `).all(guildId);
}

function updateReactionRolePanelText(guildId, messageId, title, description) {
  const existing = getReactionRolePanel(guildId, messageId);
  if (!existing) return false;
  const t = now();
  db.prepare(`
  UPDATE reaction_role_panels
  SET title=?, description=?, updated_at=?
  WHERE guild_id=? AND message_id=?
  `).run(
    title != null ? title : existing.title,
    description != null ? description : existing.description,
    t,
    guildId,
    messageId
  );
  return true;
}

function deleteReactionRolePanel(guildId, messageId) {
  const existing = getReactionRolePanel(guildId, messageId);
  if (!existing) {
    return { removed: false, channel_id: null };
  }
  db.prepare(`
  DELETE FROM reaction_role_options
  WHERE guild_id=? AND message_id=?
  `).run(guildId, messageId);
  const result = db.prepare(`
  DELETE FROM reaction_role_panels
  WHERE guild_id=? AND message_id=?
  `).run(guildId, messageId);
  return {
    removed: result.changes > 0,
    channel_id: existing.channel_id,
  };
}

function isReactionRolePanel(guildId, messageId) {
  const row = db.prepare(`
  SELECT 1 AS ok
  FROM reaction_role_panels
  WHERE guild_id=? AND message_id=?
  `).get(guildId, messageId);
  return !!row;
}

function upsertReactionRoleOption(
  guildId,
  messageId,
  emojiKey,
  emojiDisplay,
  roleId,
  minLevel,
  removable
) {
  const t = now();
  db.prepare(`
  INSERT INTO reaction_role_options (
    guild_id, message_id, emoji_key, emoji_display, role_id, min_level, removable, created_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(guild_id, message_id, emoji_key) DO UPDATE SET
    emoji_display=excluded.emoji_display,
    role_id=excluded.role_id,
    min_level=excluded.min_level,
    removable=excluded.removable,
    updated_at=excluded.updated_at
  `).run(
    guildId,
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

function deleteReactionRoleOption(guildId, messageId, emojiKey) {
  const result = db.prepare(`
  DELETE FROM reaction_role_options
  WHERE guild_id=? AND message_id=? AND emoji_key=?
  `).run(guildId, messageId, emojiKey);
  return result.changes > 0;
}

function listReactionRoleOptions(guildId, messageId) {
  return db.prepare(`
  SELECT guild_id, message_id, emoji_key, emoji_display, role_id, min_level, removable, created_at, updated_at
  FROM reaction_role_options
  WHERE guild_id=? AND message_id=?
  ORDER BY created_at ASC
  `).all(guildId, messageId);
}

function getReactionRoleOption(guildId, messageId, emojiKey) {
  return (
    db.prepare(`
  SELECT guild_id, message_id, emoji_key, emoji_display, role_id, min_level, removable, created_at, updated_at
  FROM reaction_role_options
  WHERE guild_id=? AND message_id=? AND emoji_key=?
  `).get(guildId, messageId, emojiKey) || null
  );
}

function countReactionRoleOptions(guildId, messageId) {
  const row = db.prepare(`
  SELECT COUNT(*) AS n
  FROM reaction_role_options
  WHERE guild_id=? AND message_id=?
  `).get(guildId, messageId);
  return Number(row?.n) || 0;
}

/**
 * Lowest min_level among all reaction-role options that grant each role in a guild.
 * @returns {{ role_id: string, min_level: number }[]}
 */
function listReactionRoleLevelRequirements(guildId) {
  return db.prepare(`
  SELECT role_id, MIN(min_level) AS min_level
  FROM reaction_role_options
  WHERE guild_id=?
  GROUP BY role_id
  `).all(guildId);
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
