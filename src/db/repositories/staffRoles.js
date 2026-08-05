/**
 * Staff roles — guild-wide multi-role allow-list.
 *
 * Generalized from honeypot_exempt_roles (migration 008).
 * Powers isStaff / requireStaff, honeypot exemption, and future features.
 */

const { db, now } = require("../connection");

function addStaffRole(guildId, roleId) {
  db.prepare(`
  INSERT OR IGNORE INTO staff_roles (guild_id, role_id, created_at)
  VALUES (?, ?, ?)
  `).run(guildId, roleId, now());
}

function removeStaffRole(guildId, roleId) {
  const result = db.prepare(`
  DELETE FROM staff_roles
  WHERE guild_id=? AND role_id=?
  `).run(guildId, roleId);
  return result.changes > 0;
}

function listStaffRoles(guildId) {
  return db.prepare(`
  SELECT role_id
  FROM staff_roles
  WHERE guild_id=?
  ORDER BY created_at ASC
  `).all(guildId);
}

/**
 * True if any of the member's roles is a configured staff role.
 * @param {string} guildId
 * @param {string[]} memberRoleIds
 * @returns {boolean}
 */
function memberHasStaffRole(guildId, memberRoleIds) {
  if (!memberRoleIds?.length) return false;
  const rows = listStaffRoles(guildId);
  if (!rows.length) return false;
  const staffSet = new Set(rows.map((r) => r.role_id));
  return memberRoleIds.some((id) => staffSet.has(id));
}

module.exports = {
  addStaffRole,
  removeStaffRole,
  listStaffRoles,
  memberHasStaffRole,
};
