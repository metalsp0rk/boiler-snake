const { db, now } = require("../connection");

// Lazy require: src/platform/community.js requires the db facade, so a
// top-level require would be a load-time cycle. See src/db/repositories/users.js.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

function upsertLevelRole(communityId, roleId, levelRequired, dropGraceDays) {
  assertCommunityId(communityId);
  const t = now();
  db.prepare(`
  INSERT INTO level_roles (community_id, role_id, level_required, drop_grace_days, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(community_id, role_id) DO UPDATE SET
  level_required=excluded.level_required,
  drop_grace_days=excluded.drop_grace_days,
  updated_at=excluded.updated_at
  `).run(communityId, roleId, levelRequired, dropGraceDays, t, t);
}

function deleteLevelRole(communityId, roleId) {
  assertCommunityId(communityId);
  db.prepare(`DELETE FROM level_roles WHERE community_id=? AND role_id=?`).run(communityId, roleId);
  db.prepare(`DELETE FROM role_drop_state WHERE community_id=? AND role_id=?`).run(communityId, roleId);
}

function listLevelRoles(communityId) {
  assertCommunityId(communityId);
  return db.prepare(`
  SELECT role_id, level_required, drop_grace_days
  FROM level_roles
  WHERE community_id=?
  ORDER BY level_required ASC
  `).all(communityId);
}

function getRoleDropState(communityId, userId, roleId) {
  assertCommunityId(communityId);
  return db.prepare(`
  SELECT below_since
  FROM role_drop_state
  WHERE community_id=? AND user_id=? AND role_id=?
  `).get(communityId, userId, roleId);
}

function setRoleBelowSince(communityId, userId, roleId, belowSinceOrNull) {
  assertCommunityId(communityId);
  const t = now();
  db.prepare(`
  INSERT INTO role_drop_state (community_id, user_id, role_id, below_since, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(community_id, user_id, role_id) DO UPDATE SET
  below_since=excluded.below_since,
  updated_at=excluded.updated_at
  `).run(communityId, userId, roleId, belowSinceOrNull, t);
}

module.exports = {
  upsertLevelRole,
  deleteLevelRole,
  listLevelRoles,
  getRoleDropState,
  setRoleBelowSince,
};
