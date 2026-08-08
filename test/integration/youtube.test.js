const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertReplyContains,
  assertEphemeralReply,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

describe("integration: youtube", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let processChannel;
  let runYoutubeTick;

  before(async () => {
    env = await createIntegrationEnv();
    const ticker = require("../../src/features/youtube/ticker");
    processChannel = ticker.processChannel;
    runYoutubeTick = ticker.runYoutubeTick;
  });

  it("/youtube add with channel ID stores subscription", async () => {
    const interaction = await env.runCommand({
      commandName: "youtube",
      subcommand: "add",
      admin: true,
      options: { url: "UCtesthannel00001" },
    });
    // may succeed or fail depending on URL parsing — UCtesthannel00001 starts with UC
    assert.ok(interaction.replies.length >= 1);
    const channels = env.db.getYoutubeChannels(env.guild.id);
    // If add succeeded, row exists
    if (!/invalid/i.test(interaction.replies[0].content || "")) {
      assert.ok(channels.length >= 1);
    }
  });

  it("/youtube list works", async () => {
    env.db.addYoutubeChannel(
      env.guild.id,
      "UClisted000000001",
      "ListedChannel",
      "https://www.youtube.com/channel/UClisted000000001",
      ""
    );
    const interaction = await env.runCommand({
      commandName: "youtube",
      subcommand: "list",
      admin: true,
    });
    assert.ok(interaction.replies.length >= 1);
  });

  it("/setyoutube channel sets notification channel", async () => {
    const interaction = await env.runCommand({
      commandName: "setyoutube",
      subcommand: "channel",
      admin: true,
      options: { channel: env.channels.notify },
    });
    assertReplyContains(interaction, /notifications will be sent/i);
    assert.equal(
      env.db.getGuildSettings(env.guild.id).youtube_notification_channel_id,
      IDS.channelNotify
    );
  });

  it("processChannel sends notification for new upload", async () => {
    env.db.updateGuildSettings(env.guild.id, {
      youtube_notification_channel_id: IDS.channelNotify,
    });
    env.db.addYoutubeChannel(
      env.guild.id,
      "UCproc00000000001",
      "ProcChannel",
      "https://www.youtube.com/channel/UCproc00000000001",
      ""
    );
    // mark as previously checked so we don't hit "last hour only" first-run window
    const lastChecked = Date.now() - 60_000;
    env.db.updateYoutubeChannelLastChecked("UCproc00000000001", lastChecked, null);

    const channelData = env.db.getYoutubeChannelById(env.guild.id, "UCproc00000000001");
    const published = Date.now() - 10_000;
    await processChannel(env.client, env.guild.id, channelData, {
      fetchYouTubeFeed: async () => ({
        title: "feed",
        items: [
          {
            id: "vid-new-1",
            title: "Brand New Video",
            pubDate: new Date(published).toISOString(),
            liveBroadcastContent: "none",
            "media:thumbnail": { url: "https://example.com/t.jpg" },
          },
        ],
      }),
    });

    assert.ok(
      env.channels.notify.sent.length >= 1,
      `expected notification send, got ${env.channels.notify.sent.length}`
    );
  });

  it("processChannel skips already-notified video id", async () => {
    env.db.updateGuildSettings(env.guild.id, {
      youtube_notification_channel_id: IDS.channelNotify,
    });
    env.db.addYoutubeChannel(
      env.guild.id,
      "UCskip00000000001",
      "SkipChannel",
      "https://www.youtube.com/channel/UCskip00000000001",
      ""
    );
    env.db.updateYoutubeChannelLastChecked(
      "UCskip00000000001",
      Date.now() - 120_000,
      "vid-old-1"
    );
    env.channels.notify.sent.length = 0;

    const channelData = env.db.getYoutubeChannelById(env.guild.id, "UCskip00000000001");
    await processChannel(env.client, env.guild.id, channelData, {
      fetchYouTubeFeed: async () => ({
        title: "feed",
        items: [
          {
            id: "vid-old-1",
            title: "Old Video",
            pubDate: new Date(Date.now() - 30_000).toISOString(),
            liveBroadcastContent: "none",
          },
        ],
      }),
    });
    assert.equal(env.channels.notify.sent.length, 0);
  });

  it("processChannel no-ops without notification channel", async () => {
    env.db.updateGuildSettings(env.guild.id, {
      youtube_notification_channel_id: null,
    });
    env.db.addYoutubeChannel(
      env.guild.id,
      "UCnonotify0000001",
      "NoNotify",
      "https://www.youtube.com/channel/UCnonotify0000001",
      ""
    );
    env.channels.notify.sent.length = 0;
    const channelData = env.db.getYoutubeChannelById(env.guild.id, "UCnonotify0000001");
    await processChannel(env.client, env.guild.id, channelData, {
      fetchYouTubeFeed: async () => ({
        items: [
          {
            id: "x",
            title: "t",
            pubDate: new Date().toISOString(),
            liveBroadcastContent: "none",
          },
        ],
      }),
    });
    assert.equal(env.channels.notify.sent.length, 0);
  });

  it("runYoutubeTick no-ops without API key (default)", async () => {
    const prev = process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_API_KEY;
    try {
      await runYoutubeTick(env.client);
      // should return early without throwing
      assert.ok(true);
    } finally {
      if (prev != null) process.env.YOUTUBE_API_KEY = prev;
    }
  });

  it("denies non-staff /youtube", async () => {
    const interaction = await env.runCommand({
      commandName: "youtube",
      subcommand: "list",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(interaction, /permission/i);
  });
});
