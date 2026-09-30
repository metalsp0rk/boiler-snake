const { addXp, logActivity, getGuildSettings } = require("../db");
const { assertCommunityId, getCommunityById } = require("../platform/community");
const { levelFromXp } = require("../core/xpMath");
const { syncMemberRoles } = require("../features/levelRoles/sync");
const { logLevelRoleChanges } = require("../features/logs/auditLog");

// Spec § Outbound client: the Fluxer role-sync skip is logged ONCE per
// community, not once per XP award.
const fluxerSkipLogged = new Set();

/**
 * Unified XP award pipeline used by message, reaction, voice and admin sources.
 *
 * 1. addXp (atomic, clamped)
 * 2. logActivity
 * 3. resolve member (if needed)
 * 4. levelFromXp → syncMemberRoles → audit log
 *
 * Signature per roadmap/fluxer.md § Outbound client (landed in the communities
 * PR — there is no later PR where Fluxer XP receives a Discord Guild):
 * the first argument is an OutboundClient (roadmap/fluxer.md § Outbound
 * client); callers pass `createDiscordOutbound(client)` today, the Fluxer
 * adapter later. Repositories receive the integer `communityId` only.
 *
 * @param {import("../platform/discord/outbound")} outbound  OutboundClient
 * @param {object} opts
 * @param {number} opts.communityId  internal communities.id (asserted)
 * @param {string|null} [opts.externalGuildId]  external id for logs
 * @param {string} opts.userId
 * @param {number} opts.delta XP to add (already validated/gated by caller)
 * @param {string} opts.activityKind activity_log kind (message|reaction|voice_minute|admin_grant)
 * @param {{ id: string, username?: string, roleIds?: string[] }|null} [opts.member] member already in hand
 * @param {number} [opts.levelXpFactor] guild setting; fetched if omitted
 * @param {string} [opts.source] audit source label (default xp_sync)
 * @returns {Promise<{ newXp: number, level: number|null, changes: { granted: string[], removed: string[] }|null }>}
 */
async function awardXp(outbound, {
  communityId,
  externalGuildId = null,
  userId,
  delta,
  activityKind,
  member = null,
  levelXpFactor = null,
  source = "xp_sync",
}) {
  assertCommunityId(communityId);
  const newXp = addXp(communityId, userId, delta);
  logActivity(communityId, userId, activityKind, 1);

  let factor = levelXpFactor;
  if (factor == null) {
    const settings = getGuildSettings(communityId);
    factor = settings.level_xp_factor;
  }
  const level = levelFromXp(newXp, factor);

  // Role-sync gate is platform-scoped (spec lines 423-429). Discord NEVER
  // reads the flag — backfilled 0s must not disable Discord role grants.
  if (outbound?.platform === "fluxer") {
    const row = getCommunityById(communityId);
    if (Number(row?.elevated_permissions) !== 1) {
      if (!fluxerSkipLogged.has(communityId)) {
        fluxerSkipLogged.add(communityId);
        console.log(
          `[fluxer] ${outbound.instanceKey} role sync disabled: elevated_permissions=0 (community ${communityId})`,
        );
      }
      return { newXp, level, changes: null };
    }
  }

  let resolved = member;
  if (!resolved) {
    resolved = await outbound.fetchMember(communityId, userId);
  }

  if (!resolved) {
    return { newXp, level: null, changes: null };
  }

  const changes = await syncMemberRoles(outbound, communityId, resolved, level);
  await logLevelRoleChanges(
    outbound,
    communityId,
    resolved,
    changes,
    level,
    source,
  ).catch(() => {});

  return { newXp, level, changes };
}

module.exports = { awardXp };
