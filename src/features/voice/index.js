const { getGuildSettings } = require("../../db");
const { awardXp } = require("../../services/awardXp");
const { registerJob } = require("../../core/scheduler");
const {
  ensureCommunity,
  listVoiceCompleteFluxerCommunityIds,
} = require("../../platform/community");

// #466 (XE-12): communities whose readiness line has ALREADY printed (the
// log is a flag TRANSITION, not a per-tick heartbeat).
const voiceReadyLogged = new Set();

const {
  resolveDiscordClient: coreResolveDiscordClient,
  resolveOutbound: coreResolveOutbound,
} = require("../../core/outbound");

// #462 (H1-3): ONE core implementation — the drifting per-ticker copies
// and their unreachable raw-client legs are gone. This is just the label bind.
function resolveDiscordClient(supervisor) {
  return coreResolveDiscordClient(supervisor, { label: "voiceTicker" });
}

function resolveOutbound(supervisor, communityId) {
  return coreResolveOutbound(supervisor, communityId, { label: "voiceTicker" });
}

function isMutedOrDeafened(voiceState) {
  return !!(
    voiceState?.selfMute ||
    voiceState?.serverMute ||
    voiceState?.selfDeaf ||
    voiceState?.serverDeaf
  );
}





async function runVoiceTick(supervisor) {
  const client = resolveDiscordClient(supervisor);
  if (!client) {
    // Parity with today's null-client path: a Discord-less deployment simply
    // does not run the voice tick (spec § Feature hooks: tolerate null).
    console.log("[voice] Discord client not configured — voice tick skipped");
    return;
  }

  // #198 (audit §6 P1): per-guild isolation. One poisoned guild — a throwing
  // settings/community read, a bad cache row — must not abort the tick for
  // every other guild. The per-member award loop below already catches;
  // this wrapper covers the whole per-guild body.
  for (const guild of client.guilds.cache.values()) {
    let guildId = null;
    try {
      guildId = guild.id;
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

      // Per-row OutboundClient (spec 574). Missing client → log and skip.
      const outbound = resolveOutbound(supervisor, communityId);
      if (!outbound) {
        console.warn(
          `[voice] no ready client for community ${communityId} — skipping`,
        );
        continue;
      }

      const channelEligible = new Map();

      // Cache is keyed by user id — the id rides along so a bad row's log
      // line names the user even when its payload cannot be read (#198).
      for (const [stateUserId, vs] of guild.voiceStates.cache.entries()) {
        try {
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
        } catch (err) {
          // Per-row isolation inside the guild too: one un-hydratable voice
          // state must not drop the guild's other channels' candidates.
          console.error(
            `[voice] voice-state eligibility failed in guild ${guildId} for user ${stateUserId}: ${err?.message || err}`,
          );
        }
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
    } catch (err) {
      console.error(
        `[voice] voice tick failed for guild ${guildId ?? "(unknown id)"}; continuing tick: ${err?.message || err}`,
      );
    }
  }

  // #466 (XE-12): the readiness signal used to be re-DERIVED every 60s tick
  // by walking every community of every platform (per-row SQL) purely to
  // repeat one console.log per flagged community — log spam arriving exactly
  // when #208 verification flips the flag, for work the database can do in
  // one scoped query. Now: one SQL-scoped read, and the line prints ONCE per
  // flag transition (armed set re-arms if the flag ever drops and returns).
  try {
    const flagged = new Set(listVoiceCompleteFluxerCommunityIds());
    for (const communityId of flagged) {
      if (voiceReadyLogged.has(communityId)) continue;
      voiceReadyLogged.add(communityId);
      console.log(
        `[voice] community ${communityId} has voice_states_complete=1: normalized voice states arrive with the Fluxer gateway adapter — no XP source in PR 7`,
      );
    }
    for (const communityId of [...voiceReadyLogged]) {
      if (!flagged.has(communityId)) voiceReadyLogged.delete(communityId); // flag dropped — re-arm
    }
  } catch (err) {
    // #198 discipline kept: a scan failure never cuts the tick short.
    console.error(`[voice] fluxer voice-state readiness scan failed: ${err?.message || err}`);
  }
}

function startVoiceTicker(supervisor) {
  registerJob({
    name: "voice",
    intervalMs: 60_000,
    align: true,
    run: () => runVoiceTick(supervisor),
  });
}

/**
 * @param {object|null} supervisor PR 7 supervisor ({discord, fluxer, clientForCommunity})
 * @param {object} [featureCtx]
 */
function start(supervisor, featureCtx) {
  void featureCtx;
  startVoiceTicker(supervisor);
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
