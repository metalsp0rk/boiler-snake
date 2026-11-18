/**
 * Config-change level-role reconcile (#828).
 *
 * #428 made the grace-drop TIME-driven only for users whose timer is
 * ALREADY armed. A member of the frozen class (XP never changes again:
 * decayed to 0, or decay-exempt with msg_xp=0) falls below a level-role
 * threshold the moment an ADMIN moves it — `/leveltorole set` raising
 * `level_required`, or `/setxp factor:` raising `level_xp_factor` (the
 * curve is L² × factor, so one factor edit shifts EVERY threshold at
 * once). Nothing armed their timers at that moment: `below_since` stayed
 * NULL forever, the daily sweeper never saw them, and stale level-role
 * authority persisted silently (AGENTS item 7 unenforced). The mirror
 * gap: lowering a threshold never GRANTED the role to a qualifying frozen
 * member either — grant rode the same XP-change paths.
 *
 * This module runs ONE reconcile pass per community over `users`, invoking
 * the existing `syncMemberRoles` per member (issue #828 fix sketch, first
 * option). syncMemberRoles keeps ALL the semantics — grant when meeting
 * the threshold, arm the grace timer for holders below it, XE-10 clear for
 * lapsed holders, and it never arms users who don't hold the role (which
 * is why this is a member pass and not a blind SQL arm: a blind arm would
 * strand timers on non-holders until grace expiry and poison future manual
 * grants, exactly the dead state #472 (XE-10) removed).
 *
 * Cost shape matches the decay tick (allUsersInCommunity + one member
 * fetch per user, sequential): decay already does this every day for every
 * active community; this fires only on the rare admin mutation.
 *
 * Scheduling is parameterless for call sites (slash AND web) because the
 * supervisor binds once at feature boot (`start()`); before boot — and in
 * web-only test surfaces — scheduling is a logged no-op.
 */
const { getGuildSettings } = require("../../db");
// Community-scoped enumeration is not facade-exported by design (#207):
// require the repository directly, exactly like the decay tick.
const { allUsersInCommunity } = require("../../db/repositories/users");
const { levelFromXp } = require("../../core/xpMath");
const { getCommunityById } = require("../../platform/community");
const { logLevelRoleChanges } = require("../logs/auditLog");
const { syncMemberRoles } = require("./sync");

/** Supervisor bound by the levelRoles feature boot hook (`start`). */
let boundSupervisor = null;

/** Communities with a pass in flight (one pass at a time per community). */
const inFlight = new Set();

/**
 * Bind the runtime supervisor (called from the feature `start` hook; tests
 * bind a fake). Re-binding replaces the previous supervisor.
 *
 * @param {object|null} supervisor { discord, clientForCommunity }
 */
function bindSupervisor(supervisor) {
  boundSupervisor = supervisor ?? null;
}

/**
 * One reconcile pass: every tracked user in the community, member fetched,
 * syncMemberRoles re-evaluated. Same edge-resolution and degradation shape
 * as the drop sweeper / decay re-sync arm: missing edges are logged and
 * skipped (never throw), per-user failures never abort the loop (partial
 * failures report partial results — AGENTS rule 5).
 *
 * @param {object|null} supervisor { discord, clientForCommunity }
 * @param {number} communityId
 * @param {string} [source] trigger label for logs/audit
 * @returns {Promise<{skipped: string|null, checked: number, granted: number, removed: number, failed: number}>}
 */
async function reconcileLevelRoles(supervisor, communityId, source = "reconcile") {
  const done = (extra = {}) => ({
    skipped: null,
    checked: 0,
    granted: 0,
    removed: 0,
    failed: 0,
    ...extra,
  });

  if (!communityId) return done({ skipped: "no-community" });
  if (inFlight.has(communityId)) return done({ skipped: "in-flight" });
  inFlight.add(communityId);
  try {
    const community = getCommunityById(communityId);
    if (!community?.externalGuildId) {
      console.error(
        `[levelRoles] reconcile (${source}): no communities row / external guild id for community ${communityId}; skipping`,
      );
      return done({ skipped: "no-community-row" });
    }
    const isDiscordRow = community.platform === "discord";

    const outbound =
      supervisor && typeof supervisor.clientForCommunity === "function"
        ? supervisor.clientForCommunity(communityId) ?? null
        : null;
    if (!outbound) {
      console.error(
        `[levelRoles] reconcile (${source}): no ready client for community ${communityId}; skipping`,
      );
      return done({ skipped: "no-client" });
    }

    const client = supervisor?.discord ?? null;
    let guild = null;
    if (isDiscordRow) {
      if (!client) {
        console.error(
          `[levelRoles] reconcile (${source}): no Discord client for community ${communityId}; skipping`,
        );
        return done({ skipped: "no-discord-client" });
      }
      guild = await client.guilds.fetch(community.externalGuildId).catch((err) => {
        console.error(
          `[levelRoles] reconcile (${source}): failed to fetch guild ${community.externalGuildId} for community ${communityId}: ${err?.message || err}`,
        );
        return null;
      });
      if (!guild) return done({ skipped: "guild-fetch-failed" });
    } else if (Number(community.elevatedPermissions) !== 1) {
      // K8: Fluxer role writes are elevated-gated; without elevation the
      // pass cannot act (timers stay as-is, same posture as the sweeper).
      return done({ skipped: "fluxer-not-elevated" });
    }

    const settings = getGuildSettings(communityId);
    const users = allUsersInCommunity(communityId);
    const out = done();
    for (const u of users) {
      try {
        const level = levelFromXp(u.xp, settings.level_xp_factor);
        const member = isDiscordRow
          ? await guild.members.fetch(u.user_id).catch(() => null)
          : await outbound.fetchMember(communityId, u.user_id).catch(() => null);
        if (!member) continue; // left / unfetchable: nothing to reconcile
        out.checked += 1;
        const changes = await syncMemberRoles(outbound, communityId, member, level);
        out.granted += changes.granted?.length || 0;
        out.removed += changes.removed?.length || 0;
        out.failed += changes.failed?.length || 0;
        if (changes.granted?.length || changes.removed?.length || changes.failed?.length) {
          await logLevelRoleChanges(
            outbound,
            communityId,
            member,
            changes,
            level,
            `reconcile:${source}`,
          ).catch(() => {});
        }
      } catch (err) {
        console.error(
          `[levelRoles] reconcile (${source}) failed for user ${u.user_id} in community ${communityId}: ${err?.message || err}`,
        );
      }
    }
    console.log(
      `[levelRoles] reconcile (${source}) community ${communityId}: checked ${out.checked}, granted ${out.granted}, removed ${out.removed}, failed ${out.failed}`,
    );
    return out;
  } finally {
    inFlight.delete(communityId);
  }
}

/**
 * Fire-and-forget the pass (AGENTS rule 1: detached async work carries its
 * own catch — one reconcile can never take down the command/web handler
 * that scheduled it, and the router's response lifecycle is untouched).
 *
 * @param {number} communityId
 * @param {string} [source] trigger label for logs
 * @returns {boolean} true when the pass was actually scheduled
 */
function scheduleLevelRoleReconcile(communityId, source = "reconcile") {
  if (!boundSupervisor) {
    // Pre-boot / web-only test surface: the config write already landed;
    // reconcile simply doesn't exist here. Loud by design — silence was
    // the audit's complaint.
    console.warn(
      `[levelRoles] reconcile (${source}) not scheduled for community ${communityId}: no supervisor bound (feature not started?)`,
    );
    return false;
  }
  // queueMicrotask so the caller's reply/redirect lands before a minutes-
  // long pass starts hogging the event loop with sequential REST calls.
  queueMicrotask(() => {
    reconcileLevelRoles(boundSupervisor, communityId, source).catch((err) => {
      console.error(
        `[levelRoles] reconcile (${source}) crashed for community ${communityId}: ${err?.message || err}`,
      );
    });
  });
  return true;
}

/** Test seam: whether a pass is currently running for the community. */
function isReconcileInFlight(communityId) {
  return inFlight.has(communityId);
}

module.exports = {
  bindSupervisor,
  reconcileLevelRoles,
  scheduleLevelRoleReconcile,
  isReconcileInFlight,
};
