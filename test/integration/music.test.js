const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertReplyContains,
  assertEphemeralReply,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");
const { createFakeLavalinkManager, makeTrack } = require("../helpers/lavalink");

describe("integration: music", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let fake;
  let music;

  before(async () => {
    env = await createIntegrationEnv();
    music = require("../../src/features/music");
    fake = createFakeLavalinkManager();
    music.setManagerForTests(fake);
    music.start(env.client);
  });

  after(() => {
    music.setManagerForTests(null);
  });

  function putInVoice(member, channelId = IDS.channelVoice) {
    const channel =
      channelId === IDS.channelVoice
        ? env.channels.voice
        : { id: channelId };
    env.guild.setVoiceState(member.id, {
      channelId,
      channel,
      member,
    });
  }

  function clearVoice() {
    env.guild.voiceStates.cache.clear();
    fake.players.clear();
  }

  it("/play without VC is denied", async () => {
    clearVoice();
    const interaction = await env.runCommand({
      commandName: "play",
      admin: false,
      options: { query: "never gonna" },
    });
    assertEphemeralReply(interaction, /join a voice channel/i);
  });

  it("/play in VC queues and starts", async () => {
    clearVoice();
    putInVoice(env.members.member);
    const interaction = await env.runCommand({
      commandName: "play",
      admin: false,
      options: { query: "never gonna give you up" },
    });
    assertReplyContains(interaction, /playing/i);
    assertReplyContains(interaction, /never gonna give you up/i);
    const player = fake.getPlayer(env.guild.id);
    assert.ok(player);
    assert.equal(player.connected, true);
    assert.equal(player.playing, true);
    assert.ok(player.queue.current);
  });

  it("/play while bot is in another VC is denied", async () => {
    clearVoice();
    putInVoice(env.members.member);
    await env.runCommand({
      commandName: "play",
      admin: false,
      options: { query: "first track" },
    });
    putInVoice(env.members.member2, "channel-voice-other");
    const interaction = await env.runCommand({
      commandName: "play",
      admin: false,
      user: env.users.member2User,
      member: env.members.member2,
      options: { query: "second track" },
    });
    assertEphemeralReply(interaction, /not in my voice channel/i);
  });

  it("/music skip and stop work", async () => {
    clearVoice();
    putInVoice(env.members.member);
    fake.searchOverride = async (_q, requester) => ({
      loadType: "playlist",
      playlist: { name: "Hits" },
      tracks: [
        makeTrack({ title: "One", requester }),
        makeTrack({ title: "Two", identifier: "id-2", requester }),
      ],
    });
    await env.runCommand({
      commandName: "play",
      admin: false,
      options: { query: "hits playlist" },
    });
    fake.searchOverride = null;

    const skip = await env.runCommand({
      commandName: "music",
      subcommand: "skip",
      admin: false,
    });
    assertEphemeralReply(skip, /skipped/i);
    assert.equal(fake.getPlayer(env.guild.id).queue.current.info.title, "Two");

    const stop = await env.runCommand({
      commandName: "music",
      subcommand: "stop",
      admin: false,
    });
    assertEphemeralReply(stop, /stopped/i);
    assert.equal(fake.getPlayer(env.guild.id), null);
  });

  it("skip button from a user not in the VC is denied", async () => {
    clearVoice();
    putInVoice(env.members.member);
    await env.runCommand({
      commandName: "play",
      admin: false,
      options: { query: "button track" },
    });
    const interaction = await env.runButton({
      customId: "music:skip",
      admin: false,
      user: env.users.member2User,
      member: env.members.member2,
    });
    assertEphemeralReply(interaction, /join a voice channel|not in my voice channel/i);
    assert.ok(fake.getPlayer(env.guild.id)?.playing);
  });

  it("disconnected node returns a friendly error", async () => {
    clearVoice();
    putInVoice(env.members.member);
    fake.useable = false;
    const interaction = await env.runCommand({
      commandName: "play",
      admin: false,
      options: { query: "anything" },
    });
    fake.useable = true;
    assertEphemeralReply(interaction, /lavalink node is down/i);
  });

  it("missing Lavalink config is a friendly error", async () => {
    music.setManagerForTests(null);
    const interaction = await env.runCommand({
      commandName: "play",
      admin: false,
      options: { query: "anything" },
    });
    music.setManagerForTests(fake);
    assertEphemeralReply(interaction, /isn't configured/i);
  });

  it("/music volume shuffle remove seek", async () => {
    clearVoice();
    putInVoice(env.members.member);
    fake.searchOverride = async (_q, requester) => ({
      loadType: "playlist",
      playlist: { name: "Mix" },
      tracks: [
        makeTrack({ title: "A", requester }),
        makeTrack({ title: "B", identifier: "b", requester }),
        makeTrack({ title: "C", identifier: "c", requester }),
      ],
    });
    await env.runCommand({
      commandName: "play",
      admin: false,
      options: { query: "mix" },
    });
    fake.searchOverride = null;

    const vol = await env.runCommand({
      commandName: "music",
      subcommand: "volume",
      admin: false,
      options: { level: 40 },
    });
    assertEphemeralReply(vol, /40%/);
    assert.equal(fake.getPlayer(env.guild.id).volume, 40);

    const shuffle = await env.runCommand({
      commandName: "music",
      subcommand: "shuffle",
      admin: false,
    });
    assertEphemeralReply(shuffle, /shuffled/i);

    const remove = await env.runCommand({
      commandName: "music",
      subcommand: "remove",
      admin: false,
      options: { position: 1 },
    });
    assertEphemeralReply(remove, /removed/i);

    const seek = await env.runCommand({
      commandName: "music",
      subcommand: "seek",
      admin: false,
      options: { timestamp: "1:23" },
    });
    assertEphemeralReply(seek, /1:23/);
    assert.equal(fake.getPlayer(env.guild.id).lastSeek, 83000);
  });
});
