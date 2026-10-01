const { getGuildSettings } = require("../../db");
const { awardXp } = require("../../services/awardXp");
const { registerJob } = require("../../core/scheduler");
const { getDiscordOutbound } = require("../../platform/discord/outbound");
const { ensureCommunity, getCommunityById } = require("../../platform/community");
// Ticker plumbing lister (PR 7): communities that can receive voice XP are
// exactly the ones with tracked users.
const { listCommunityIdsWithUsers } = require("../../db/repositories/users");

function isMutedOrDeafened(voiceState) {
  return !!(
    voiceState?.selfMute ||
    voiceState?.serverMute ||
    voiceState?.selfDeaf ||
    voiceState?.serverDeaf
  );
}

/**
 * Resolve the raw Discord client behind the supervisor (null when Discord is
 * unconfigured). A legacy raw client passed directly is honored (tests and
 * pre-cutover callers).
 * @param {object|null} supervisor
 * @returns {object|null}
 */
function resolveDiscordClient(supervisor) {
  if (!supervisor) return null;
  if (typeof supervisor.clientForCommunity === "function") {
    return supervisor.discord ?? null;
  }
  if (supervisor.guilds) return supervisor; // legacy raw discord.js client
  return null;
}

/**
 * Resolve the OutboundClient for one community (roadmap/fluxer.md § Scheduler
 * jobs: awardXp receives the OutboundClient, never a Discord Guild).
 * @param {object|null} supervisor
 * @param {number} communityId
 * @returns {object|null}
 */
function resolveOutbound(supervisor, communityId) {
  if (!supervisor) return null;
  if (typeof supervisor.clientForCommunity === "function") {
    try {
      return supervisor.clientForCommunity(communityId) ?? null;
    } catch (err) {
      console.error(
        `[voiceTicker] clientForCommunity(${communityId}) threw: ${err?.message || err}`,
      );
      return null;
    }
  }
  if (typeof supervisor.sendChannel === "function") return supervisor;
  const client = resolveDiscordClient(supervisor);
  if (client) {
    try {
      return getDiscordOutbound(client);
    } catch {
      return null;
    }
  }
  return null;
}

async function runVoiceTick(supervisor) {
  const client = resolveDiscordClient(supervisor);
  if (!client) {
    // Parity with today's null-client path: a Discord-less deployment simply
    // does not run the voice tick (spec § Feature hooks: tolerate null).
    console.log("[voice] Discord client not configured — voice tick skipped");
    return;
  }

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

    // Per-row OutboundClient (spec 574). Missing client → log and skip.
    const outbound = resolveOutbound(supervisor, communityId);
    if (!outbound) {
      console.warn(
        `[voice] no ready client for community ${communityId} — skipping`,
      );
      continue;
    }

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

  // Fluxer communities (spec 574): the voice tick runs ONLY when
  // voice_states_complete is 1. The flag is 0 in every deployment today, so
  // these rows are skipped silently (no per-row log spam). When an adapter
  // flips the flag, the NormalizedVoiceGuild data source ships with the
  // Fluxer gateway adapter; awarding from a guessed payload is forbidden,
  // so we log the readiness signal instead of inventing states.
  for (const communityId of listCommunityIdsWithUsers()) {
    const community = getCommunityById(communityId);
    if (!community || community.platform !== "fluxer") continue;
    if (Number(community.voiceStatesComplete) !== 1) continue;
    console.log(
      `[voice] community ${communityId} has voice_states_complete=1: normalized voice states arrive with the Fluxer gateway adapter — no XP source in PR 7`,
    );
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
