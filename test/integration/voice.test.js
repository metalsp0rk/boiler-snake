const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const { assertXp } = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

/**
 * PR 7 fake supervisor: ticker entry points take a supervisor and resolve the
 * OutboundClient per community via clientForCommunity (roadmap/fluxer.md §
 * Scheduler jobs). Discord-only in tests — fluxer rows resolve to null.
 */
function fakeSupervisor(client) {
  const { getDiscordOutbound } = require("../../src/platform/discord/outbound");
  return {
    discord: client,
    fluxer: new Map(),
    clientForCommunity: () => getDiscordOutbound(client),
  };
}

describe("integration: voice tick", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let runVoiceTick;

  after(() => {
    // Close SQLite handles and remove the temp dir created for this env.
    env?.cleanup();
  });

  before(async () => {
    env = await createIntegrationEnv();
    runVoiceTick = require("../../src/features/voice").runVoiceTick;
    env.db.updateGuildSettings(env.communityId, { voice_xp_per_min: 4 });
  });

  function clearVoice() {
    env.guild.voiceStates.cache.clear();
  }

  function putInVoice(member, opts = {}) {
    const channelId = opts.channelId || IDS.channelVoice;
    env.guild.setVoiceState(member.id, {
      channelId,
      member,
      selfMute: !!opts.selfMute,
      serverMute: !!opts.serverMute,
      selfDeaf: !!opts.selfDeaf,
      serverDeaf: !!opts.serverDeaf,
    });
  }

  it("awards XP when two eligible humans share a channel", async () => {
    clearVoice();
    putInVoice(env.members.member);
    putInVoice(env.members.member2);
    const b1 = env.db.getXp(env.communityId, IDS.member);
    const b2 = env.db.getXp(env.communityId, IDS.member2);
    await runVoiceTick(fakeSupervisor(env.client));
    assertXp(env.db, env.communityId, IDS.member, b1 + 4);
    assertXp(env.db, env.communityId, IDS.member2, b2 + 4);
  });

  it("does not award when only one human", async () => {
    clearVoice();
    putInVoice(env.members.member);
    const before = env.db.getXp(env.communityId, IDS.member);
    await runVoiceTick(fakeSupervisor(env.client));
    assertXp(env.db, env.communityId, IDS.member, before);
  });

  it("skips muted members", async () => {
    clearVoice();
    putInVoice(env.members.member, { selfMute: true });
    putInVoice(env.members.member2);
    // only one eligible
    const b1 = env.db.getXp(env.communityId, IDS.member);
    const b2 = env.db.getXp(env.communityId, IDS.member2);
    await runVoiceTick(fakeSupervisor(env.client));
    assertXp(env.db, env.communityId, IDS.member, b1);
    assertXp(env.db, env.communityId, IDS.member2, b2);
  });

  it("skips AFK channel", async () => {
    clearVoice();
    putInVoice(env.members.member, { channelId: IDS.channelAfk });
    putInVoice(env.members.member2, { channelId: IDS.channelAfk });
    const b1 = env.db.getXp(env.communityId, IDS.member);
    await runVoiceTick(fakeSupervisor(env.client));
    assertXp(env.db, env.communityId, IDS.member, b1);
  });

  it("ignores bots for eligibility", async () => {
    clearVoice();
    const botMember = env.createMember({
      guild: env.guild,
      user: env.users.botUser,
    });
    env.guild.addMember(botMember);
    putInVoice(env.members.member);
    putInVoice(botMember);
    const before = env.db.getXp(env.communityId, IDS.member);
    await runVoiceTick(fakeSupervisor(env.client));
    assertXp(env.db, env.communityId, IDS.member, before);
  });

  it("no awards when voice_xp_per_min is 0", async () => {
    env.db.updateGuildSettings(env.communityId, { voice_xp_per_min: 0 });
    clearVoice();
    putInVoice(env.members.member);
    putInVoice(env.members.member2);
    const before = env.db.getXp(env.communityId, IDS.member);
    await runVoiceTick(fakeSupervisor(env.client));
    assertXp(env.db, env.communityId, IDS.member, before);
    env.db.updateGuildSettings(env.communityId, { voice_xp_per_min: 4 });
  });
});
