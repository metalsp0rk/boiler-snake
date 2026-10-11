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

  it("a throwing guild does not abort the tick for the other guilds (#198)", async () => {
    clearVoice();
    putInVoice(env.members.member);
    putInVoice(env.members.member2);

    // Poisoned guild B: a real communities/settings row (so the per-guild
    // body gets PAST the settings read and into the throwing work — the
    // audit's "throwing repo call / bad row" shape), but touching its
    // voice-state cache blows up.
    const poisonGuildId = "910000000000000001";
    const { ensureCommunity } = require("../../src/platform/community");
    const communityB = ensureCommunity({
      platform: "discord",
      instanceKey: "discord",
      externalGuildId: poisonGuildId,
    });
    env.db.updateGuildSettings(communityB, { voice_xp_per_min: 6 });
    const poisonGuild = {
      id: poisonGuildId,
      afkChannelId: null,
      get voiceStates() {
        throw new Error("simulated voiceStates cache blow-up");
      },
    };

    // Map iteration follows insertion order: put B FIRST so a throw in its
    // body used to abort the tick BEFORE guild A was ever processed.
    const guilds = env.client.guilds.cache;
    const saved = [...guilds.entries()];
    guilds.clear();
    guilds.set(poisonGuildId, poisonGuild);
    for (const [id, g] of saved) guilds.set(id, g);

    const errors = [];
    const origErr = console.error;
    console.error = (...args) => errors.push(args.map(String).join(" "));
    try {
      const b1 = env.db.getXp(env.communityId, IDS.member);
      const b2 = env.db.getXp(env.communityId, IDS.member2);

      await runVoiceTick(fakeSupervisor(env.client)); // must resolve, not reject

      // Guild A still processed both members despite guild B blowing up first.
      assertXp(env.db, env.communityId, IDS.member, b1 + 4);
      assertXp(env.db, env.communityId, IDS.member2, b2 + 4);

      // The failure is logged with the poisoned guild id and the specific cause.
      const lines = errors.filter((l) => l.includes("[voice]"));
      assert.equal(
        lines.length,
        1,
        `expected exactly one [voice] error, got: ${errors.join(" | ")}`,
      );
      assert.ok(
        lines[0].includes(poisonGuildId),
        `guild id missing in: ${lines[0]}`,
      );
      assert.ok(
        lines[0].includes("simulated voiceStates cache blow-up"),
        `cause missing in: ${lines[0]}`,
      );
    } finally {
      console.error = origErr;
      guilds.clear();
      for (const [id, g] of saved) guilds.set(id, g);
    }
  });

  it("one member's award throw does not skip the rest of the channel (#198)", async () => {
    clearVoice();
    putInVoice(env.members.member);
    putInVoice(env.members.member2);
    putInVoice(env.members.adminMember);

    const b1 = env.db.getXp(env.communityId, IDS.member);
    const b2 = env.db.getXp(env.communityId, IDS.member2);
    const b3 = env.db.getXp(env.communityId, IDS.admin);

    // Poison member's voice-state ROW (the audit's "bad row"): reading its
    // member throws. The other two voice states must still be evaluated and
    // the two clean members still awarded.
    const states = env.guild.voiceStates.cache;
    states.set(IDS.member, {
      channelId: IDS.channelVoice,
      get member() {
        throw new Error("simulated member hydration failure");
      },
    });

    const errors = [];
    const origErr = console.error;
    console.error = (...args) => errors.push(args.map(String).join(" "));
    try {
      await runVoiceTick(fakeSupervisor(env.client)); // resolves, not rejects

      // The bad row is logged with the guild id, the user id (cache key —
      // readable even when the row is not) and the specific cause…
      const lines = errors.filter((l) => l.includes("[voice]"));
      assert.equal(
        lines.length,
        1,
        `expected exactly one [voice] error, got: ${errors.join(" | ")}`,
      );
      assert.ok(lines[0].includes(env.guildId), `guild id missing in: ${lines[0]}`);
      assert.ok(
        lines[0].includes(IDS.member),
        `user id missing in: ${lines[0]}`,
      );
      assert.ok(
        lines[0].includes("simulated member hydration failure"),
        `cause missing in: ${lines[0]}`,
      );

      // …and the two clean members still earned XP (poisoned one did not).
      assertXp(env.db, env.communityId, IDS.member, b1);
      assertXp(env.db, env.communityId, IDS.member2, b2 + 4);
      assertXp(env.db, env.communityId, IDS.admin, b3 + 4);
    } finally {
      console.error = origErr;
      clearVoice();
    }
  });
});
