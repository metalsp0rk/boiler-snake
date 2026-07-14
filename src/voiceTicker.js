const { getGuildSettings, addXp, logActivity, getXp } = require("./db");
const { levelFromXp } = require("./xp");
const { syncMemberRoles } = require("./roles");
const { logLevelRoleChanges } = require("./auditLog");

function isMutedOrDeafened(voiceState) {
  return !!(
    voiceState?.selfMute ||
    voiceState?.serverMute ||
    voiceState?.selfDeaf ||
    voiceState?.serverDeaf
  );
}

async function runVoiceTick(client) {
  for (const guild of client.guilds.cache.values()) {
    const guildId = guild.id;
    const settings = getGuildSettings(guildId);
    const xpPerMin = Math.max(0, Number(settings.voice_xp_per_min) || 0);
    if (xpPerMin <= 0) continue;

    // Build channel -> eligible members map by iterating ONLY active voice states.
    const channelEligible = new Map(); // channelId -> Member[]

    for (const vs of guild.voiceStates.cache.values()) {
      const channelId = vs.channelId;
      if (!channelId) continue;

      // Ignore AFK channel if configured
      if (guild.afkChannelId && channelId === guild.afkChannelId) continue;

      const member = vs.member;
      if (!member) continue;
      if (member.user?.bot) continue;

      if (isMutedOrDeafened(vs)) continue;

      let arr = channelEligible.get(channelId);
      if (!arr) {
        arr = [];
        channelEligible.set(channelId, arr);
      }
      arr.push(member);
    }

    // Award only in channels with >= 2 eligible humans.
    for (const [channelId, members] of channelEligible.entries()) {
      if (members.length < 2) continue;

      for (const member of members) {
        try {
          addXp(guildId, member.id, xpPerMin);
          logActivity(guildId, member.id, "voice_minute", 1);

          const xp = getXp(guildId, member.id);
          const lvl = levelFromXp(xp, settings.level_xp_factor);
          const changes = await syncMemberRoles(member, lvl);
          await logLevelRoleChanges(client, member, changes, lvl, "xp_sync").catch(() => {});
        } catch (err) {
          console.error(
            `[voiceTicker] Failed awarding voice XP in guild ${guildId} for user ${member.id} in channel ${channelId}: ${err?.message || err}`
          );
        }
      }
    }
  }
}

function startVoiceTicker(client) {
  const msToNextMinute = 60000 - (Date.now() % 60000);
  setTimeout(() => {
    runVoiceTick(client).catch(() => {});
    setInterval(() => runVoiceTick(client).catch(() => {}), 60000);
  }, msToNextMinute);
}

module.exports = { startVoiceTicker };
