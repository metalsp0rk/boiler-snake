const {
  now,
  listLevelRoles,
  getRoleDropState,
  setRoleBelowSince,
} = require("../../db");
const { assertCommunityId } = require("../../platform/community");

function logRoleError(action, result, { communityId, userId, roleId }) {
  // Don't spam: role ops are rare; this is valuable for self-hosters.
  console.error(
    `[roles] Failed to ${action} role ${roleId} for user ${userId} in community ${communityId}: ${result?.error || result?.code || result}`,
  );
  console.error(
    "[roles] Common cause: the bot's highest role is below the role it is trying to manage, or it lacks Manage Roles permission.",
  );
}

/**
 * Grant when level >= required.
 * Remove only after user has been below required for > drop_grace_days.
 *
 * Transitional PR 2 shape (spec § Outbound client): `member` may be a Discord
 * GuildMember (carries `roles.cache`) or a MemberHandle `{ id, username, bot,
 * roleIds }` (carries `roleIds`). Discord members keep the discord.js role
 * calls exactly as before; MemberHandles go through `outbound.addRole` /
 * `removeRole`. The full OutboundClient sweep (PR 3-5) drops the GuildMember
 * branch.
 *
 * @param {{ addRole: Function, removeRole: Function, platform?: string, instanceKey?: string }} outbound
 * @param {number} communityId  internal communities.id (asserted)
 * @param {{ id: string, roleIds?: string[] }} member  GuildMember or MemberHandle
 * @param {number} level
 * @returns {Promise<{ granted: string[], removed: string[] }>}
 */
async function syncMemberRoles(outbound, communityId, member, level) {
  assertCommunityId(communityId);
  const granted = [];
  const removed = [];
  if (!member?.id) return { granted, removed };

  const userId = member.id;
  const hasDiscordRoles = Boolean(member.roles?.cache);
  let roleIds;
  if (Array.isArray(member.roleIds)) {
    roleIds = member.roleIds;
  } else if (hasDiscordRoles) {
    roleIds = [...member.roles.cache.keys()];
  } else {
    console.warn(
      `[roles] syncMemberRoles: member ${userId} in community ${communityId} has neither roleIds nor roles.cache; skipping role sync`,
    );
    return { granted, removed };
  }

  const mappings = listLevelRoles(communityId);
  if (!mappings.length) return { granted, removed };

  // One role mutation path for both member shapes; never throws (AGENTS.md
  // rule 6 at the service boundary — failures come back as { ok:false }).
  async function setRole(action, roleId) {
    try {
      if (hasDiscordRoles) {
        await (action === "add"
          ? member.roles.add(roleId)
          : member.roles.remove(roleId));
        return { ok: true };
      }
      return action === "add"
        ? await outbound.addRole(communityId, userId, roleId)
        : await outbound.removeRole(communityId, userId, roleId);
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  for (const m of mappings) {
    const roleId = m.role_id;
    const required = m.level_required;
    const graceMs = Math.max(0, m.drop_grace_days) * 24 * 60 * 60 * 1000;

    const hasRole = roleIds.includes(roleId);
    const meets = level >= required;

    if (meets) {
      if (!hasRole) {
        const res = await setRole("add", roleId);
        if (res && res.ok) granted.push(roleId);
        else logRoleError("add", res, { communityId, userId, roleId });
      }
      // clear drop timer regardless
      try {
        setRoleBelowSince(communityId, userId, roleId, null);
      } catch {
        // DB errors should be rare; let them bubble in caller if needed
      }
      continue;
    }

    // below threshold
    const st = getRoleDropState(communityId, userId, roleId);
    const belowSince = st?.below_since ?? null;

    if (!belowSince) {
      // Start timer only if they currently have the role.
      if (hasRole) {
        setRoleBelowSince(communityId, userId, roleId, now());
      }
      continue;
    }

    if (hasRole && (now() - belowSince) > graceMs) {
      const res = await setRole("remove", roleId);
      if (res && res.ok) removed.push(roleId);
      else logRoleError("remove", res, { communityId, userId, roleId });
      setRoleBelowSince(communityId, userId, roleId, null);
    }
  }

  return { granted, removed };
}

module.exports = { syncMemberRoles };
