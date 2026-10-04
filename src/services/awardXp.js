const { addXp, logActivity, getGuildSettings } = require("../db");
const { assertCommunityId, getCommunityById } = require("../platform/community");
const { levelFromXp } = require("../core/xpMath");
const { syncMemberRoles } = require("../features/levelRoles/sync");
const { logLevelRoleChanges } = require("../features/logs/auditLog");

// Spec § Outbound client: the Fluxer role-sync skip is logged ONCE per
// community, not once per XP award.
const fluxerSkipLogged = new Set();

/**
 * Fan-out seam (roadmap/account-linking.md T4): mirror an XP award to the
 * account linked to (community, user) on the OTHER platform.
 *
 * Lazy require — a top-level require of features/linking/service would be a
 * load-time cycle (the linking service calls back INTO awardXp for the mirror
 * award). NEVER throws into the award caller (AGENTS.md § Error Handling
 * rules 5/6): the primary award has already landed at the call site, so a
 * broken mirror degrades to { awarded: null, warnings: [...] } plus a
 * `[linking]` log line naming the ids.
 *
 * @param {number} communityId source community (integer)
 * @param {string} userId source external user id
 * @param {number} delta the primary award's delta (mirror is sign-preserving)
 * @param {string} activityKind activity kind, forwarded unchanged
 * @returns {Promise<{ awarded: number|null, warnings: string[] }>}
 */
async function fanOutXpMirror(communityId, userId, delta, activityKind) {
  try {
    const linking = require("../features/linking/service");
    return await linking.fanOutLinkedXp(communityId, userId, delta, activityKind);
  } catch (err) {
    const reason = String(err?.message || err);
    console.error(
      `[linking] xp mirror failed for community ${String(communityId)} user ${String(userId)}: ${reason}`,
    );
    return { awarded: null, warnings: [`xp mirror failed: ${reason}`] };
  }
}

/**
 * The primary (pre-fan-out) award pipeline. Split out of awardXp so the
 * fan-out leg runs exactly once per award — on EVERY successful return path,
 * including the Fluxer K8 role-sync skip and the member-fetch miss (the XP
 * row write happened; the mirror must not depend on the role leg).
 *
 * @param {import("../platform/discord/outbound")} outbound OutboundClient
 * @param {object} opts see awardXp (everything except fanOut)
 * @returns {Promise<{ newXp: number, level: number|null, changes: { granted: string[], removed: string[] }|null }>}
 */
async function awardXpPrimary(outbound, {
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
  // NOTE: getCommunityById aliases the column to camelCase `elevatedPermissions`
  // (src/platform/community.js selectById) — reading the snake_case name here
  // made the gate skip even at flag 1 (latent: no pre-T4 test drove a Fluxer
  // award with the flag raised; the K8 mirror tests in test/fluxer-linking-xp
  // pin the correct shape).
  if (outbound?.platform === "fluxer") {
    const row = getCommunityById(communityId);
    if (Number(row?.elevatedPermissions) !== 1) {
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

/**
 * Unified XP award pipeline used by message, reaction, voice, admin and
 * account-link mirror sources.
 *
 * 1. addXp (atomic, clamped)
 * 2. logActivity
 * 3. resolve member (if needed)
 * 4. levelFromXp → syncMemberRoles → audit log
 * 5. fan-out (default on): mirror the delta to the linked counterpart account
 *    via the linking service — reported additively as `linkMirror`.
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
 * @param {boolean} [opts.fanOut=true] mirror to the linked account (T4). THE
 *   LOOP GUARD: the mirror-issued award (source "link_mirror") passes
 *   fanOut:false, so a mirror never fans out again.
 * @returns {Promise<{ newXp: number, level: number|null, changes: { granted: string[], removed: string[] }|null, linkMirror?: { awarded: number|null, warnings: string[] } }>}
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
  fanOut = true,
} = {}) {
  const result = await awardXpPrimary(outbound, {
    communityId,
    externalGuildId,
    userId,
    delta,
    activityKind,
    member,
    levelXpFactor,
    source,
  });

  // Fan-out runs ONLY after the primary award fully succeeded. fanOut:false
  // is the loop guard (roadmap/account-linking.md T4): mirror-issued awards
  // carry source "link_mirror" and stop here, so a→b→a re-mirroring is
  // structurally impossible. linkMirror is additive: absent on fanOut:false
  // calls, so every existing caller's result shape is unchanged.
  if (!fanOut) return result;

  result.linkMirror = await fanOutXpMirror(communityId, userId, delta, activityKind);
  return result;
}

module.exports = { awardXp };
