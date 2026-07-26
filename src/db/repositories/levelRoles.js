const { db, now } = require("../connection");

function upsertLevelRole(guildId, roleId, levelRequired, dropGraceDays) {
  const t = now();
  db.prepare(`
  INSERT INTO level_roles (guild_id, role_id, level_required, drop_grace_days, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(guild_id, role_id) DO UPDATE SET
  level_required=excluded.level_required,
  drop_grace_days=excluded.drop_grace_days,
  updated_at=excluded.updated_at
  `).run(guildId, roleId, levelRequired, dropGraceDays, t, t);
}

function deleteLevelRole(guildId, roleId) {
  db.prepare(`DELETE FROM level_roles WHERE guild_id=? AND role_id=?`).run(guildId, roleId);
  db.prepare(`DELETE FROM role_drop_state WHERE guild_id=? AND role_id=?`).run(guildId, roleId);
}

function listLevelRoles(guildId) {
  return db.prepare(`
  SELECT role_id, level_required, drop_grace_days
  FROM level_roles
  WHERE guild_id=?
  ORDER BY level_required ASC
  `).all(guildId);
}

function getRoleDropState(guildId, userId, roleId) {
  return db.prepare(`
  SELECT below_since
  FROM role_drop_state
  WHERE guild_id=? AND user_id=? AND role_id=?
  `).get(guildId, userId, roleId);
}

function setRoleBelowSince(guildId, userId, roleId, belowSinceOrNull) {
  const t = now();
  db.prepare(`
  INSERT INTO role_drop_state (guild_id, user_id, role_id, below_since, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(guild_id, user_id, role_id) DO UPDATE SET
  below_since=excluded.below_since,
  updated_at=excluded.updated_at
  `).run(guildId, userId, roleId, belowSinceOrNull, t);
}

module.exports = {
  upsertLevelRole,
  deleteLevelRole,
  listLevelRoles,
  getRoleDropState,
  setRoleBelowSince,
};
