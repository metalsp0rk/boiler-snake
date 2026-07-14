const cron = require("node-cron");
const {
  allUsersInGuild,
  countMessagesInWindow,
  setXp,
  getGuildSettings,
} = require("./db");
const { levelFromXp } = require("./xp");
const { syncMemberRoles } = require("./roles");
const { syncMemberReactionRoles } = require("./reactionRoles");
const { logLevelRoleChanges } = require("./auditLog");

// Daily at 4 AM server local time.
const DECAY_CRON = "0 4 * * *";

function startDecayScheduler(client) {
  cron.schedule(DECAY_CRON, async () => {
    try {
      for (const guild of client.guilds.cache.values()) {
        await runDecayForGuild(client, guild.id);
      }
    } catch (err) {
      console.error("[decay] scheduler error:", err?.message || err);
    }
  });
}

/**
 * Apply daily XP decay for one guild, then re-check level-gated roles for users who lost XP.
 * - /leveltorole mappings: syncMemberRoles (grant/drop with grace period)
 * - Reaction-role options: syncMemberReactionRoles (strip immediately if below min_level)
 */
async function runDecayForGuild(client, guildId) {
  const settings = getGuildSettings(guildId);
  if (!settings.decay_enabled) return;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const users = allUsersInGuild(guildId);
  for (const u of users) {
    const msgCount = countMessagesInWindow(
      guildId,
      u.user_id,
      settings.decay_window_days
    );

    if (msgCount >= settings.decay_min_messages) continue;

    const pct = Math.min(0.95, Math.max(0, Number(settings.decay_percent) || 0));
    const newXp = Math.floor(u.xp * (1 - pct));
    if (newXp === u.xp) continue;

    const oldLvl = levelFromXp(u.xp, settings.level_xp_factor);
    setXp(guildId, u.user_id, newXp);

    const member = await guild.members.fetch(u.user_id).catch(() => null);
    if (member) {
      const lvl = levelFromXp(newXp, settings.level_xp_factor);
      // Level→role mappings (grace-period drops)
      const levelChanges = await syncMemberRoles(member, lvl);
      await logLevelRoleChanges(client, member, levelChanges, lvl, "decay").catch(() => {});

      // Reaction-claim roles: remove if new level is below the option min_level
      // (audit logged inside sync when logSource is set)
      await syncMemberReactionRoles(member, lvl, {
        client,
        logSource: "decay_reaction_role",
      });

      if (lvl < oldLvl) {
        console.log(
          `[decay] ${guildId}/${u.user_id}: XP ${u.xp}→${newXp} (level ${oldLvl}→${lvl}); roles rechecked`
        );
      }
    }
  }
}

module.exports = { startDecayScheduler, runDecayForGuild };
