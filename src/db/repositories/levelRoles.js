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

/**
 * Pending grace-drop timers for one community (#428, audit XE-1): rows the
 * sync started when a member fell below a level-role threshold, joined with
 * the role mapping so a sweeper can decide per-role grace expiry. These are
 * exactly the members the XP-change-driven sync paths can MISS (a user whose
 * XP never changes again — decayed to 0, or decay-exempt with msg_xp=0 —
 * never re-enters syncMemberRoles, so the grace timer would never fire).
 *
 * @param {number} communityId
 * @returns {Array<{user_id: string, role_id: string, below_since: number, level_required: number, drop_grace_days: number}>}
 */
function listPendingRoleDrops(communityId) {
  assertCommunityId(communityId);
  return db
    .prepare(
      `
    SELECT s.user_id, s.role_id, s.below_since, r.level_required, r.drop_grace_days
    FROM role_drop_state s
    JOIN level_roles r
      ON r.community_id = s.community_id AND r.role_id = s.role_id
    WHERE s.community_id = ? AND s.below_since IS NOT NULL
    ORDER BY s.below_since ASC
  `
    )
    .all(communityId);
}

/**
 * Communities with at least one pending drop timer — the sweeper's worklist
 * (avoids ticking every community just to find nothing).
 *
 * @returns {number[]}
 */
function listCommunityIdsWithPendingRoleDrops() {
  return db
    .prepare(
      "SELECT DISTINCT community_id FROM role_drop_state WHERE below_since IS NOT NULL ORDER BY community_id ASC"
    )
    .all()
    .map((r) => r.community_id);
}

module.exports = {
  upsertLevelRole,
  deleteLevelRole,
  listLevelRoles,
  getRoleDropState,
  setRoleBelowSince,
  listPendingRoleDrops,
  listCommunityIdsWithPendingRoleDrops,
};
