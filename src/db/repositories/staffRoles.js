/**
 * Staff roles — per-community roster of staff role ids (roadmap/web-admin.md
 * §8.2). `level` is "junior" | "senior" (migration 011 staff_role_levels).
 * added_by records the assigning user (migration 024 staff_roles_added_by).
 */

const { db, now } = require("../connection");

// Lazy require: src/platform/community.js requires the db facade, so a
// top-level require would be a load-time cycle. See src/db/repositories/users.js.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

/** Valid staff levels (mirrors the CHECK-style vocabulary of migration 011). */
const STAFF_LEVELS = Object.freeze(["junior", "senior"]);

/**
 * Normalize a staff level. Anything unrecognized falls back to "senior"
 * (the pre-migration-011 meaning of a staff row).
 * @param {string|null|undefined} level
 * @returns {"junior"|"senior"}
 */
function normalizeStaffLevel(level) {
  const v = String(level || "senior").trim().toLowerCase();
  if (v === "junior" || v === "jr") return "junior";
  if (v === "senior" || v === "sr") return "senior";
  return "senior";
}

/**
 * Insert or update a staff role for a community.
 * @param {number} communityId
 * @param {string} roleId external Discord role id (stays a snowflake)
 * @param {string} [level="senior"]
 * @param {string|null} [addedBy=null] external user id of the assigning user
 */
function addStaffRole(communityId, roleId, level = "senior", addedBy = null) {
  assertCommunityId(communityId);
  const lvl = normalizeStaffLevel(level);
  const addedByValue = addedBy == null ? null : String(addedBy);
  db.prepare(`
  INSERT INTO staff_roles (community_id, role_id, level, created_at, added_by)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(community_id, role_id) DO UPDATE SET
    level=excluded.level,
    added_by=COALESCE(excluded.added_by, staff_roles.added_by)
  `).run(communityId, String(roleId), lvl, now(), addedByValue);
}

/**
 * Change the level of an existing staff role.
 * @param {number} communityId
 * @param {string} roleId
 * @param {string} level
 * @returns {boolean} true when a row changed
 */
function setStaffRoleLevel(communityId, roleId, level) {
  assertCommunityId(communityId);
  const lvl = normalizeStaffLevel(level);
  const info = db.prepare(`
  UPDATE staff_roles SET level=? WHERE community_id=? AND role_id=?
  `).run(lvl, communityId, String(roleId));
  return info.changes > 0;
}

/**
 * @param {number} communityId
 * @param {string} roleId
 * @returns {boolean} true when a row was removed
 */
function removeStaffRole(communityId, roleId) {
  assertCommunityId(communityId);
  const info = db.prepare(`
  DELETE FROM staff_roles WHERE community_id=? AND role_id=?
  `).run(communityId, String(roleId));
  return info.changes > 0;
}

/**
 * List a community's staff roles (senior first, then junior).
 * @param {number} communityId
 * @param {{ level?: "junior"|"senior" }} [opts]
 * @returns {Array<{ role_id: string, level: string, created_at: number, added_by: string|null }>}
 */
function listStaffRoles(communityId, opts = {}) {
  assertCommunityId(communityId);
  if (opts.level) {
    const lvl = normalizeStaffLevel(opts.level);
    return db.prepare(`
    SELECT role_id, level, created_at, added_by
    FROM staff_roles
    WHERE community_id=? AND level=?
    ORDER BY created_at ASC, role_id ASC
    `).all(communityId, lvl);
  }
  return db.prepare(`
  SELECT role_id, level, created_at, added_by
  FROM staff_roles
  WHERE community_id=?
  ORDER BY CASE level WHEN 'senior' THEN 0 ELSE 1 END, created_at ASC, role_id ASC
  `).all(communityId);
}

/**
 * @param {number} communityId
 * @returns {string[]} role ids marked senior
 */
function listSeniorStaffRoles(communityId) {
  assertCommunityId(communityId);
  return listStaffRoles(communityId, { level: "senior" });
}

/**
 * True when any member role id is a staff role of the given level (any
 * level when omitted).
 * @param {number} communityId
 * @param {string[]} memberRoleIds
 * @param {"junior"|"senior"} [level]
 * @returns {boolean}
 */
function memberHasStaffRole(communityId, memberRoleIds, level) {
  assertCommunityId(communityId);
  if (!memberRoleIds?.length) return false;
  const rows = level ? listStaffRoles(communityId, { level }) : listStaffRoles(communityId);
  const staffSet = new Set(rows.map((r) => r.role_id));
  return memberRoleIds.some((id) => staffSet.has(id));
}

/**
 * @param {number} communityId
 * @param {string[]} memberRoleIds
 * @returns {boolean}
 */
function memberHasSeniorStaffRole(communityId, memberRoleIds) {
  assertCommunityId(communityId);
  return memberHasStaffRole(communityId, memberRoleIds, "senior");
}

/**
 * @param {number} communityId
 * @param {string} roleId
 * @returns {object|null} the staff role row
 */
function getStaffRole(communityId, roleId) {
  assertCommunityId(communityId);
  return (
    db.prepare(`
    SELECT role_id, level, created_at, added_by
    FROM staff_roles
    WHERE community_id=? AND role_id=?
    `).get(communityId, String(roleId)) || null
  );
}

module.exports = {
  STAFF_LEVELS,
  normalizeStaffLevel,
  addStaffRole,
  setStaffRoleLevel,
  removeStaffRole,
  listStaffRoles,
  listSeniorStaffRoles,
  memberHasStaffRole,
  memberHasSeniorStaffRole,
  getStaffRole,
};
