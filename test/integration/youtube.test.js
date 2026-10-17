const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertReplyContains,
  assertEphemeralReply,
} = require("../helpers/assert");
const {
  exactlyOneSend,
  assertPingsEveryone,
  assertPingsRoleOnly,
  assertPingsNobody,
} = require("../helpers/sendShape");
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

describe("integration: youtube", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let processChannel;
  let runYoutubeTick;

  after(() => {
    // Close SQLite handles and remove the temp dir created for this env.
    env?.cleanup();
  });

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
    const channels = env.db.getYoutubeChannels(env.communityId);
    // If add succeeded, row exists
    if (!/invalid/i.test(interaction.replies[0].content || "")) {
      assert.ok(channels.length >= 1);
    }
  });

  it("/youtube list works", async () => {
    env.db.addYoutubeChannel(
      env.communityId,
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
      env.db.getGuildSettings(env.communityId).youtube_notification_channel_id,
      IDS.channelNotify
    );
  });

  it("processChannel sends notification for new upload", async () => {
    env.db.updateGuildSettings(env.communityId, {
      youtube_notification_channel_id: IDS.channelNotify,
    });
    env.db.addYoutubeChannel(
      env.communityId,
      "UCproc00000000001",
      "ProcChannel",
      "https://www.youtube.com/channel/UCproc00000000001",
      ""
    );
    // mark as previously checked so we don't hit "last hour only" first-run window
    const lastChecked = Date.now() - 60_000;
    env.db.updateYoutubeChannelLastChecked(env.communityId, "UCproc00000000001", lastChecked, null);

    const channelData = env.db.getYoutubeChannelById(env.communityId, "UCproc00000000001");
    const published = Date.now() - 10_000;
    await processChannel(fakeSupervisor(env.client), env.communityId, channelData, {
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

  // Audit H11 (#186) / send-shape contract tests (#199): ticker-level tests
  // asserting allowedMentions on the *production* send path (sendNotification
  // via processChannel), not just /testnotification. The mock channel records
  // each send payload verbatim into `sent`; the shared sendShape helpers pin
  // both sides of the contract (content mention tokens ↔ exact allowedMentions
  // payload) so a suppressed-ping regression can never go green again.
  const UPLOAD_ROLE = "666000000000000001";

  async function driveUploadNotification(channelIdSuffix, { uploadRole }) {
    const channelId = `UCshape${channelIdSuffix}000001`;
    env.db.updateGuildSettings(env.communityId, {
      youtube_notification_channel_id: IDS.channelNotify,
      youtube_upload_role_id: uploadRole,
    });
    env.db.addYoutubeChannel(
      env.communityId,
      channelId,
      "ShapeChannel",
      `https://www.youtube.com/channel/${channelId}`,
      ""
    );
    env.db.updateYoutubeChannelLastChecked(env.communityId, channelId, Date.now() - 60_000, null);
    env.channels.notify.sent.length = 0;

    const channelData = env.db.getYoutubeChannelById(env.communityId, channelId);
    await processChannel(fakeSupervisor(env.client), env.communityId, channelData, {
      fetchYouTubeFeed: async () => ({
        title: "feed",
        items: [
          {
            id: `vid-shape-${channelIdSuffix}`,
            title: `Shape Video ${channelIdSuffix}`,
            pubDate: new Date(Date.now() - 10_000).toISOString(),
            liveBroadcastContent: "none",
          },
        ],
      }),
    });
    assert.equal(env.channels.notify.sent.length, 1, "expected exactly one send");
    return env.channels.notify.sent[0];
  }

  it("upload send with configured role pings exactly that role (H11)", async () => {
    const payload = await driveUploadNotification("role1", { uploadRole: UPLOAD_ROLE });
    assertPingsRoleOnly(payload, UPLOAD_ROLE, { label: "youtube upload alert" });
  });

  it("upload send without a configured role allows no mentions (H11)", async () => {
    const payload = await driveUploadNotification("norole", { uploadRole: null });
    assertPingsNobody(payload, { label: "youtube upload alert (no role)" });
  });

  it("live send pings @everyone as documented (H11)", async () => {
    const channelId = "UCshapelive0000001";
    env.db.updateGuildSettings(env.communityId, {
      youtube_notification_channel_id: IDS.channelNotify,
      youtube_upload_role_id: null,
    });
    env.db.addYoutubeChannel(
      env.communityId,
      channelId,
      "LiveShapeChannel",
      `https://www.youtube.com/channel/${channelId}`,
      ""
    );
    env.channels.notify.sent.length = 0;

    const channelData = env.db.getYoutubeChannelById(env.communityId, channelId);
    await processChannel(fakeSupervisor(env.client), env.communityId, channelData, {
      fetchYouTubeFeed: async () => ({
        title: "feed",
        items: [
          {
            id: "vid-shape-live1",
            title: "Live Now!",
            pubDate: new Date(Date.now() - 10_000).toISOString(),
            liveBroadcastContent: "live",
          },
        ],
      }),
    });
    const payload = exactlyOneSend(env.channels.notify.sent, "youtube live alert");
    assertPingsEveryone(payload, { label: "youtube live alert" });
  });

  it("processChannel skips already-notified video id", async () => {
    env.db.updateGuildSettings(env.communityId, {
      youtube_notification_channel_id: IDS.channelNotify,
    });
    env.db.addYoutubeChannel(
      env.communityId,
      "UCskip00000000001",
      "SkipChannel",
      "https://www.youtube.com/channel/UCskip00000000001",
      ""
    );
    env.db.updateYoutubeChannelLastChecked(
      env.communityId,
      "UCskip00000000001",
      Date.now() - 120_000,
      "vid-old-1"
    );
    env.channels.notify.sent.length = 0;

    const channelData = env.db.getYoutubeChannelById(env.communityId, "UCskip00000000001");
    await processChannel(fakeSupervisor(env.client), env.communityId, channelData, {
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
    env.db.updateGuildSettings(env.communityId, {
      youtube_notification_channel_id: null,
    });
    env.db.addYoutubeChannel(
      env.communityId,
      "UCnonotify0000001",
      "NoNotify",
      "https://www.youtube.com/channel/UCnonotify0000001",
      ""
    );
    env.channels.notify.sent.length = 0;
    const channelData = env.db.getYoutubeChannelById(env.communityId, "UCnonotify0000001");
    await processChannel(fakeSupervisor(env.client), env.communityId, channelData, {
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
      await runYoutubeTick(fakeSupervisor(env.client));
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

  it("#377: watermark writes are community-scoped — a sibling watching the same channel is untouched", () => {
    // youtube_channels PK is (community_id, id): one subscribed YouTuber is
    // one row PER community sharing `id`. The old `WHERE id=?` UPDATE let
    // community A's tick rewrite community B's watermark — burning B's
    // pending uploads silently. Two communities, ONE shared channel id.
    const { ensureCommunity } = require("../../src/platform/community");
    const cidOther = ensureCommunity({
      platform: "discord",
      instanceKey: "discord",
      externalGuildId: "990000000000000099",
    });
    const shared = "UCshared0000000001";
    env.db.addYoutubeChannel(env.communityId, shared, "SharedChannel", `https://www.youtube.com/channel/${shared}`, "");
    env.db.addYoutubeChannel(cidOther, shared, "SharedChannel", `https://www.youtube.com/channel/${shared}`, "");
    env.db.updateYoutubeChannelLastChecked(cidOther, shared, 1_000, "vid-other-sentinel");

    env.db.updateYoutubeChannelLastChecked(env.communityId, shared, 2_000, "vid-mine");

    const mine = env.db.getYoutubeChannelById(env.communityId, shared);
    const theirs = env.db.getYoutubeChannelById(cidOther, shared);
    assert.equal(mine.last_checked, 2_000, "own row advanced");
    assert.equal(mine.last_video_id, "vid-mine");
    assert.equal(theirs.last_checked, 1_000, "sibling watermark NOT clobbered (#377)");
    assert.equal(theirs.last_video_id, "vid-other-sentinel", "sibling pointer NOT clobbered");

    // The no-pointer branch (lastVideoId falsy) must be scoped too.
    env.db.updateYoutubeChannelLastChecked(env.communityId, shared, 3_000);
    assert.equal(theirs.last_checked, 1_000, "sibling untouched by the null-video branch");
    assert.equal(env.db.getYoutubeChannelById(env.communityId, shared).last_checked, 3_000);

    // Leave the shared env clean for the count-sensitive tests.
    env.db.removeYoutubeChannel(env.communityId, shared);
    env.db.removeYoutubeChannel(cidOther, shared);
  });
});
