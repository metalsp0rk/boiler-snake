/**
 * Level-role grace-drop sweeper (#428, audit XE-1).
 *
 * AGENTS item 7 ("Level→role drop: grace days after falling below
 * threshold") was only ever evaluated from XP-CHANGE-triggered paths:
 * awardXp and the decay tick — and the decay tick only for users whose XP
 * row it actually rewrote (`if (!decayed) continue`). A user whose XP
 * FREEZES (decayed down to 0, or decay-exempt with msg_xp=0) never enters
 * syncMemberRoles again, so the below-since timer armed at the last sync
 * is never re-evaluated: the member keeps the level role FOREVER.
 *
 * This sweeper makes the drop TIME-driven instead of XP-driven: once a day
 * (offset away from the decay job) it re-runs the existing sync for every
 * pending timer whose grace has expired. syncMemberRoles itself decides —
 * remove when still below + still holding, clear the timer when conditions
 * changed — so the sweeper adds no second copy of the drop semantics and
 * is idempotent (nothing expired → nothing to do).
 */
const { registerJob } = require("../../core/scheduler");
const {
  getGuildSettings,
  getUser,
  listPendingRoleDrops,
  listCommunityIdsWithPendingRoleDrops,
} = require("../../db");
const { levelFromXp } = require("../../core/xpMath");
const { getCommunityById } = require("../../platform/community");
const { logLevelRoleChanges } = require("../logs/auditLog");
const { syncMemberRoles } = require("./sync");

const DAY_MS = 24 * 60 * 60 * 1000;

/** Community worklist for one scheduler tick. */
function communityIdsToSweep() {
  return listCommunityIdsWithPendingRoleDrops();
}

/**
 * Sweep one community. Same supervisor contract as the decay ticker
 * (clientForCommunity → OutboundClient; supervisor.discord → discord.js
 * client); mirrors runDecayForGuild's resolution and degradation shape:
 * missing edges are logged and skipped, per-user failures never abort the
 * loop (partial failures report partial results).
 *
 * @param {object|null} supervisor
 * @param {number} communityId
 * @param {{ nowMs?: number }} [opts] seam for tests (clock)
 * @returns {Promise<{ swept: number, removed: number }>}
 */
async function runDropSweepForCommunity(supervisor, communityId, opts = {}) {
  const nowMs = Number(opts.nowMs) || Date.now();
  const pending = listPendingRoleDrops(communityId);
  const expired = pending.filter(
    (p) => nowMs - p.below_since > Math.max(0, Number(p.drop_grace_days) || 0) * DAY_MS,
  );
  if (expired.length === 0) return { swept: 0, removed: 0 };

  const community = getCommunityById(communityId);
  if (!community?.externalGuildId) {
    console.error(
      `[levelRoles] drop sweep: no communities row / external guild id for community ${communityId}; skipping`,
    );
    return { swept: 0, removed: 0 };
  }
  const isDiscordRow = community.platform === "discord";

  const outbound =
    supervisor && typeof supervisor.clientForCommunity === "function"
      ? supervisor.clientForCommunity(communityId) ?? null
      : null;
  if (!outbound) {
    console.error(
      `[levelRoles] drop sweep: no ready client for community ${communityId}; skipping`,
    );
    return { swept: 0, removed: 0 };
  }

  const client = supervisor?.discord ?? null;
  let guild = null;
  if (isDiscordRow) {
    if (!client) {
      console.error(
        `[levelRoles] drop sweep: no Discord client for community ${communityId}; skipping`,
      );
      return { swept: 0, removed: 0 };
    }
    guild = await client.guilds.fetch(community.externalGuildId).catch((err) => {
      console.error(
        `[levelRoles] drop sweep: failed to fetch guild ${community.externalGuildId} for community ${communityId}: ${err?.message || err}`,
      );
      return null;
    });
    if (!guild) return { swept: 0, removed: 0 };
  } else if (Number(community.elevatedPermissions) !== 1) {
    // K8: Fluxer role writes are elevated-gated; without elevation the
    // sweep cannot act — skip quietly (timers stay pending, like the decay
    // re-sync arm).
    return { swept: 0, removed: 0 };
  }

  const settings = getGuildSettings(communityId);

  // One sync per user (a user can hold several overdue roles; the sync
  // re-evaluates every mapping for them in one pass).
  const userIds = [...new Set(expired.map((p) => p.user_id))];
  let removed = 0;
  for (const userId of userIds) {
    try {
      const row = getUser(communityId, userId);
      const level = levelFromXp(row?.xp ?? 0, settings.level_xp_factor);

      const member = isDiscordRow
        ? await guild.members.fetch(userId).catch(() => null)
        : await outbound.fetchMember(communityId, userId).catch(() => null);
      if (!member) {
        // Left the guild (or fetch failed): the role is meaningless while
        // they are out; the timer stays armed and self-resolves on rejoin.
        console.warn(
          `[levelRoles] drop sweep: member ${userId} not fetchable in community ${communityId}; timer kept`,
        );
        continue;
      }

      const changes = await syncMemberRoles(outbound, communityId, member, level);
      removed += changes.removed?.length || 0;
      if (changes.granted?.length || changes.removed?.length) {
        await logLevelRoleChanges(
          outbound,
          communityId,
          member,
          changes,
          level,
          "drop-sweeper",
        ).catch(() => {});
        console.log(
          `[levelRoles] drop sweep community ${communityId} user ${userId} (level ${level}): removed ${changes.removed?.length || 0}, granted ${changes.granted?.length || 0}`,
        );
      }
    } catch (err) {
      console.error(
        `[levelRoles] drop sweep failed for user ${userId} in community ${communityId}: ${err?.message || err}`,
      );
    }
  }

  return { swept: userIds.length, removed };
}

/**
 * Register the daily job. Cron intentionally simple and offset from the
 * decay default ("0 4 * * *") so the two role-resync sweeps never race.
 *
 * @param {object} supervisor
 */
function startLevelRoleDropSweeper(supervisor) {
  registerJob({
    name: "levelrole-drop",
    cron: "17 5 * * *",
    run: async () => {
      for (const communityId of communityIdsToSweep()) {
        try {
          await runDropSweepForCommunity(supervisor, communityId);
        } catch (err) {
          console.error(
            `[levelRoles] drop sweep failed for community ${communityId}: ${err?.message || err}`,
          );
        }
      }
    },
  });
}

module.exports = {
  startLevelRoleDropSweeper,
  runDropSweepForCommunity,
  communityIdsToSweep,
};
