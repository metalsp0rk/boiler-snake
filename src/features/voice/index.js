const { getGuildSettings } = require("../../db");
const { awardXp } = require("../../services/awardXp");

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

    const channelEligible = new Map();

    for (const vs of guild.voiceStates.cache.values()) {
      const channelId = vs.channelId;
      if (!channelId) continue;
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

    for (const [channelId, members] of channelEligible.entries()) {
      if (members.length < 2) continue;

      for (const member of members) {
        try {
          await awardXp(client, {
            guild,
            userId: member.id,
            delta: xpPerMin,
            activityKind: "voice_minute",
            member,
            levelXpFactor: settings.level_xp_factor,
          });
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

function start(client) {
  startVoiceTicker(client);
}

module.exports = {
  name: "voice",
  commands: [],
  handlers: {},
  start,
  startVoiceTicker,
};
