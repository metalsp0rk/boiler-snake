const { getGuildSettings } = require("../../db");
const { awardXp } = require("../../services/awardXp");
const { registerJob } = require("../../core/scheduler");
const { getDiscordOutbound } = require("../../platform/discord/outbound");
const { ensureCommunity } = require("../../platform/community");

function isMutedOrDeafened(voiceState) {
  return !!(
    voiceState?.selfMute ||
    voiceState?.serverMute ||
    voiceState?.selfDeaf ||
    voiceState?.serverDeaf
  );
}

async function runVoiceTick(client) {
  const outbound = getDiscordOutbound(client);
  for (const guild of client.guilds.cache.values()) {
    const guildId = guild.id;
    // Edge resolution: the ticker iterates Discord guilds, so this is the
    // entry point where the snowflake becomes the internal community id.
    const communityId = ensureCommunity({
      platform: "discord",
      instanceKey: "discord",
      externalGuildId: guildId,
    });
    const settings = getGuildSettings(communityId);
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
          await awardXp(outbound, {
            communityId,
            externalGuildId: guildId,
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
  registerJob({
    name: "voice",
    intervalMs: 60_000,
    align: true,
    run: () => runVoiceTick(client),
  });
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
  runVoiceTick,
  isMutedOrDeafened,
};
