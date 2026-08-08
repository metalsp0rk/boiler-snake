/**
 * Build Discord application-command permission overwrite payloads.
 */

const ApplicationCommandPermissionType = {
  Role: 1,
  User: 2,
  Channel: 3,
};

const MAX_PERMISSIONS = 100;

/**
 * @param {string[]} roleIds
 * @returns {{ id: string, type: number, permission: boolean }[]}
 */
function buildStaffRoleAllowPermissions(roleIds) {
  const ids = [...new Set((roleIds || []).map(String).filter(Boolean))];
  if (ids.length > MAX_PERMISSIONS) {
    throw new Error(
      `Too many staff roles (${ids.length}); Discord allows max ${MAX_PERMISSIONS} permission overwrites per command`
    );
  }
  return ids.map((id) => ({
    id,
    type: ApplicationCommandPermissionType.Role,
    permission: true,
  }));
}

module.exports = {
  ApplicationCommandPermissionType,
  MAX_PERMISSIONS,
  buildStaffRoleAllowPermissions,
};
