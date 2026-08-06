const { addXp, logActivity, getGuildSettings } = require("../db");
const { levelFromXp } = require("../core/xpMath");
const { syncMemberRoles } = require("../features/levelRoles/sync");
const { logLevelRoleChanges } = require("../features/logs/auditLog");

/**
 * Unified XP award pipeline used by message, reaction, and voice sources.
 *
 * 1. addXp (atomic, clamped)
 * 2. logActivity
 * 3. resolve member (if needed)
 * 4. levelFromXp → syncMemberRoles → audit log
 *
 * @param {import("discord.js").Client} client
 * @param {object} opts
 * @param {import("discord.js").Guild} opts.guild
 * @param {string} opts.userId
 * @param {number} opts.delta XP to add (already validated/gated by caller)
 * @param {string} opts.activityKind activity_log kind (message|reaction|voice_minute|admin_grant)
 * @param {import("discord.js").GuildMember|null} [opts.member] if already fetched
 * @param {number} [opts.levelXpFactor] guild setting; fetched if omitted
 * @param {string} [opts.source] audit source label (default xp_sync)
 * @returns {Promise<{ newXp: number, level: number|null, changes: { granted: string[], removed: string[] }|null }>}
 */
async function awardXp(client, {
  guild,
  userId,
  delta,
  activityKind,
  member = null,
  levelXpFactor = null,
  source = "xp_sync",
}) {
  const guildId = guild.id;
  const newXp = addXp(guildId, userId, delta);
  logActivity(guildId, userId, activityKind, 1);

  let factor = levelXpFactor;
  if (factor == null) {
    const settings = getGuildSettings(guildId);
    factor = settings.level_xp_factor;
  }

  let resolved = member;
  if (!resolved) {
    resolved = await guild.members.fetch(userId).catch(() => null);
  }

  if (!resolved) {
    return { newXp, level: null, changes: null };
  }

  const level = levelFromXp(newXp, factor);
  const changes = await syncMemberRoles(resolved, level);
  await logLevelRoleChanges(client, resolved, changes, level, source).catch(() => {});

  return { newXp, level, changes };
}

module.exports = { awardXp };
