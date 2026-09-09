/**
 * Staff roles — guild-wide multi-role allow-list with junior | senior levels.
 *
 * Generalized from honeypot_exempt_roles (migration 008).
 * Level (migration 011):
 *   - junior: isStaff / honeypot exempt only
 *   - senior: junior + ticket channel visibility overwrites
 * added_by (migration 024): actor user id recorded when the role is added;
 * NULL on rows created before the column existed.
 */

const { db, now } = require("../connection");

const STAFF_LEVELS = Object.freeze(["junior", "senior"]);

/**
 * @param {string|null|undefined} level
 * @returns {"junior"|"senior"}
 */
function normalizeStaffLevel(level) {
  const v = String(level || "senior")
    .trim()
    .toLowerCase();
  if (v === "junior" || v === "jr") return "junior";
  if (v === "senior" || v === "sr") return "senior";
  return "senior";
}

/**
 * Add (or re-add) a staff role.
 *
 * Upsert keeps `added_by` provenance sane:
 * - fresh insert → added_by = actor (or NULL when the caller has none,
 *   e.g. the `/honeypot exempt` wrapper),
 * - re-add with an actor → provenance refreshes to the acting admin,
 * - re-add without an actor → COALESCE preserves existing provenance
 *   instead of clobbering it with NULL.
 *
 * @param {string} guildId
 * @param {string} roleId
 * @param {string} [level="senior"]
 * @param {string|null} [addedBy=null] actor user id who added the role
 */
function addStaffRole(guildId, roleId, level = "senior", addedBy = null) {
  const lvl = normalizeStaffLevel(level);
  const actor = addedBy == null ? null : String(addedBy);
  db.prepare(`
  INSERT INTO staff_roles (guild_id, role_id, level, created_at, added_by)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(guild_id, role_id) DO UPDATE SET
    level=excluded.level,
    added_by=COALESCE(excluded.added_by, added_by)
  `).run(guildId, roleId, lvl, now(), actor);
}

/**
 * @param {string} guildId
 * @param {string} roleId
 * @param {string} level
 * @returns {boolean} true if a row was updated
 */
function setStaffRoleLevel(guildId, roleId, level) {
  const lvl = normalizeStaffLevel(level);
  const result = db
    .prepare(
      `
    UPDATE staff_roles SET level=? WHERE guild_id=? AND role_id=?
  `
    )
    .run(lvl, guildId, roleId);
  return result.changes > 0;
}

function removeStaffRole(guildId, roleId) {
  const result = db
    .prepare(
      `
  DELETE FROM staff_roles
  WHERE guild_id=? AND role_id=?
  `
    )
    .run(guildId, roleId);
  return result.changes > 0;
}

/**
 * @param {string} guildId
 * @param {object} [opts]
 * @param {"junior"|"senior"} [opts.level] filter to one level
 * @returns {{ role_id: string, level: string, created_at: number, added_by: string|null }[]}
 */
function listStaffRoles(guildId, opts = {}) {
  if (opts.level) {
    const lvl = normalizeStaffLevel(opts.level);
    return db
      .prepare(
        `
      SELECT role_id, level, created_at, added_by
      FROM staff_roles
      WHERE guild_id=? AND level=?
      ORDER BY level DESC, created_at ASC
    `
      )
      .all(guildId, lvl);
  }
  return db
    .prepare(
      `
    SELECT role_id, level, created_at, added_by
    FROM staff_roles
    WHERE guild_id=?
    ORDER BY CASE level WHEN 'senior' THEN 0 ELSE 1 END, created_at ASC
  `
    )
    .all(guildId);
}

/**
 * Roles that receive ticket channel visibility overwrites.
 * @param {string} guildId
 * @returns {{ role_id: string, level: string, created_at: number }[]}
 */
function listSeniorStaffRoles(guildId) {
  return listStaffRoles(guildId, { level: "senior" });
}

/**
 * True if any of the member's roles is a configured staff role (any level).
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

/**
 * True if any of the member's roles is a senior staff role.
 * @param {string} guildId
 * @param {string[]} memberRoleIds
 * @returns {boolean}
 */
function memberHasSeniorStaffRole(guildId, memberRoleIds) {
  if (!memberRoleIds?.length) return false;
  const rows = listSeniorStaffRoles(guildId);
  if (!rows.length) return false;
  const seniorSet = new Set(rows.map((r) => r.role_id));
  return memberRoleIds.some((id) => seniorSet.has(id));
}

/**
 * @param {string} guildId
 * @param {string} roleId
 * @returns {{ role_id: string, level: string, created_at: number, added_by: string|null }|null}
 */
function getStaffRole(guildId, roleId) {
  return (
    db
      .prepare(
        `
      SELECT role_id, level, created_at, added_by
      FROM staff_roles
      WHERE guild_id=? AND role_id=?
    `
      )
      .get(guildId, roleId) || null
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
