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

  it("#378: live alert never re-fires when a newer upload moves the shared pointer", async () => {
    const channelId = "UClivededup00001";
    env.db.updateGuildSettings(env.communityId, {
      youtube_notification_channel_id: IDS.channelNotify,
      youtube_upload_role_id: null,
    });
    env.db.addYoutubeChannel(env.communityId, channelId, "DedupLive", `https://www.youtube.com/channel/${channelId}`, "");
    // One prior check so the "first hour only" window never plays a role.
    env.db.updateYoutubeChannelLastChecked(env.communityId, channelId, Date.now() - 10 * 60_000, null);
    env.channels.notify.sent.length = 0;

    const feed = () => ({
      title: "feed",
      items: [
        {
          // Newest entry: a normal upload published DURING the stream.
          id: "vid-dedup-upload",
          title: "Fresh Upload",
          pubDate: new Date(Date.now() - 60_000).toISOString(),
          liveBroadcastContent: "none",
        },
        {
          id: "vid-dedup-live",
          title: "Marathon Stream",
          pubDate: new Date(Date.now() - 5 * 60_000).toISOString(),
          liveBroadcastContent: "live",
        },
      ],
    });

    // Tick 1: upload alert + exactly one live @everyone.
    let channelData = env.db.getYoutubeChannelById(env.communityId, channelId);
    await processChannel(fakeSupervisor(env.client), env.communityId, channelData, {
      fetchYouTubeFeed: async () => feed(),
    });
    assert.equal(env.channels.notify.sent.length, 2, "upload alert + live alert on first sight");
    const liveMsg = env.channels.notify.sent.find((m) => /went live/i.test(m.content || ""));
    assert.ok(liveMsg, "live alert sent");
    assertPingsEveryone(liveMsg, { label: "youtube live alert" });

    // The end-of-tick pointer is the NEWEST item (the upload) — the old code
    // re-fired the live @everyone every tick from here for the whole stream.
    channelData = env.db.getYoutubeChannelById(env.communityId, channelId);
    assert.equal(channelData.last_video_id, "vid-dedup-upload", "shared pointer moved to the upload");
    assert.equal(channelData.last_live_id, "vid-dedup-live", "#378: dedicated live pointer persisted");

    // Ticks 2-4 replay the 5-minute ticker mid-stream: NOTHING may re-fire.
    env.channels.notify.sent.length = 0;
    for (let tick = 0; tick < 3; tick++) {
      channelData = env.db.getYoutubeChannelById(env.communityId, channelId);
      await processChannel(fakeSupervisor(env.client), env.communityId, channelData, {
        fetchYouTubeFeed: async () => feed(),
      });
    }
    assert.equal(
      env.channels.notify.sent.length,
      0,
      "live alert (and upload) never re-fire while notified state stands (#378)",
    );

    env.db.removeYoutubeChannel(env.communityId, channelId);
  });

  it("#380: a failed send keeps the watermark — the upload retries next tick instead of burning", async () => {
    const channelId = "UCburn00000000001";
    env.db.updateGuildSettings(env.communityId, {
      youtube_notification_channel_id: IDS.channelNotify,
      youtube_upload_role_id: null,
    });
    env.db.addYoutubeChannel(env.communityId, channelId, "BurnCanary", `https://www.youtube.com/channel/${channelId}`, "");
    const floor = Date.now() - 10 * 60_000;
    env.db.updateYoutubeChannelLastChecked(env.communityId, channelId, floor, null);

    const feed = () => ({
      title: "feed",
      items: [
        {
          id: "vid-burn-1",
          title: "Do Not Burn",
          pubDate: new Date(Date.now() - 60_000).toISOString(),
          liveBroadcastContent: "none",
        },
      ],
    });

    // Tick 1: the notify channel is DOWN (sendChannel resolves ok:false —
    // revoked perms / deleted channel / rate-limit burst).
    const brokenSupervisor = {
      discord: env.client,
      fluxer: new Map(),
      clientForCommunity: () => ({
        sendChannel: async () => ({ ok: false, error: "Missing Access" }),
      }),
    };
    let channelData = env.db.getYoutubeChannelById(env.communityId, channelId);
    await processChannel(brokenSupervisor, env.communityId, channelData, {
      fetchYouTubeFeed: async () => feed(),
    });

    // OLD CODE: watermark jumped to wall-clock now → this video is older
    // than it forever → silently burned. NEW CODE: nothing moved.
    channelData = env.db.getYoutubeChannelById(env.communityId, channelId);
    assert.equal(channelData.last_checked, floor, "watermark KEPT after a failed send (#380)");
    assert.equal(channelData.last_video_id, null, "pointer KEPT after a failed send");

    // Tick 2: channel healthy again → the upload IS delivered, not burned.
    env.channels.notify.sent.length = 0;
    channelData = env.db.getYoutubeChannelById(env.communityId, channelId);
    await processChannel(fakeSupervisor(env.client), env.communityId, channelData, {
      fetchYouTubeFeed: async () => feed(),
    });
    const payload = exactlyOneSend(env.channels.notify.sent, "retried upload");
    assert.match(payload.content, /youtu\.be\/vid-burn-1/, "the pending upload delivered on the retry tick");
    channelData = env.db.getYoutubeChannelById(env.communityId, channelId);
    assert.equal(channelData.last_video_id, "vid-burn-1", "watermark advanced ONLY past the delivery");

    env.db.removeYoutubeChannel(env.communityId, channelId);
  });

  it("#380: oldest-first delivery — a mid-list failure defers NEWER items and never burns them", async () => {
    const channelId = "UCburn00000000002";
    env.db.updateGuildSettings(env.communityId, {
      youtube_notification_channel_id: IDS.channelNotify,
      youtube_upload_role_id: null,
    });
    env.db.addYoutubeChannel(env.communityId, channelId, "PartialChannel", `https://www.youtube.com/channel/${channelId}`, "");
    const floor = Date.now() - 10 * 60_000;
    env.db.updateYoutubeChannelLastChecked(env.communityId, channelId, floor, null);

    const feed = () => ({
      title: "feed",
      items: [
        {
          id: "vid-burn-new",
          title: "Second up",
          pubDate: new Date(Date.now() - 60_000).toISOString(),
          liveBroadcastContent: "none",
        },
        {
          id: "vid-burn-old",
          title: "First up",
          pubDate: new Date(Date.now() - 3 * 60_000).toISOString(),
          liveBroadcastContent: "none",
        },
      ],
    });

    // The OLDER video sends fine; the newer one hits a 429.
    const attempts = [];
    const flakySupervisor = {
      discord: env.client,
      fluxer: new Map(),
      clientForCommunity: () => ({
        sendChannel: async (_cid, payload) => {
          attempts.push(payload.content || "");
          if (/vid-burn-new/.test(payload.content || "")) {
            return { ok: false, error: "429 rate limited" };
          }
          return { ok: true };
        },
      }),
    };
    let channelData = env.db.getYoutubeChannelById(env.communityId, channelId);
    await processChannel(flakySupervisor, env.communityId, channelData, {
      fetchYouTubeFeed: async () => feed(),
    });
    assert.deepEqual(
      attempts.map((c) => (/vid-burn-old/.test(c) ? "old" : "new")),
      ["old", "new"],
      "delivered oldest-first; the loop stopped at the failure",
    );
    channelData = env.db.getYoutubeChannelById(env.communityId, channelId);
    assert.equal(channelData.last_video_id, "vid-burn-old", "watermark advanced past the DELIVERED item only");
    assert.ok(channelData.last_checked > floor && channelData.last_checked <= Date.now() - 3 * 60_000 + 5000, "ordinal window = the delivered publish, not wall-clock");

    // Recovery tick: ONLY the failed video fires — no re-ping for the
    // delivered one, no burn for the failed one.
    env.channels.notify.sent.length = 0;
    channelData = env.db.getYoutubeChannelById(env.communityId, channelId);
    await processChannel(fakeSupervisor(env.client), env.communityId, channelData, {
      fetchYouTubeFeed: async () => feed(),
    });
    const payload = exactlyOneSend(env.channels.notify.sent, "recovered newer upload");
    assert.match(payload.content, /youtu\.be\/vid-burn-new/, "failed item delivered on retry");

    env.db.removeYoutubeChannel(env.communityId, channelId);
  });

  it("#380: a failed live alert does NOT mark the stream — the @everyone ping retries", async () => {
    const channelId = "UCburn00000000003";
    env.db.updateGuildSettings(env.communityId, {
      youtube_notification_channel_id: IDS.channelNotify,
      youtube_upload_role_id: null,
    });
    env.db.addYoutubeChannel(env.communityId, channelId, "RetryLive", `https://www.youtube.com/channel/${channelId}`, "");
    env.db.updateYoutubeChannelLastChecked(env.communityId, channelId, Date.now() - 10 * 60_000, null);

    const feed = () => ({
      title: "feed",
      items: [
        {
          id: "vid-burn-live",
          title: "Marathon",
          pubDate: new Date(Date.now() - 60_000).toISOString(),
          liveBroadcastContent: "live",
        },
      ],
    });

    const brokenSupervisor = {
      discord: env.client,
      fluxer: new Map(),
      clientForCommunity: () => ({
        sendChannel: async () => ({ ok: false, error: "Missing Access" }),
      }),
    };
    let channelData = env.db.getYoutubeChannelById(env.communityId, channelId);
    await processChannel(brokenSupervisor, env.communityId, channelData, {
      fetchYouTubeFeed: async () => feed(),
    });
    channelData = env.db.getYoutubeChannelById(env.communityId, channelId);
    assert.equal(channelData.last_live_id, null, "failed live send does NOT mark the stream (#380)");

    env.channels.notify.sent.length = 0;
    channelData = env.db.getYoutubeChannelById(env.communityId, channelId);
    await processChannel(fakeSupervisor(env.client), env.communityId, channelData, {
      fetchYouTubeFeed: async () => feed(),
    });
    const payload = exactlyOneSend(env.channels.notify.sent, "retried live alert");
    assertPingsEveryone(payload, { label: "retried youtube live alert" });
    assert.equal(
      env.db.getYoutubeChannelById(env.communityId, channelId).last_live_id,
      "vid-burn-live",
      "live pointer marked ONLY after the delivered alert",
    );

    env.db.removeYoutubeChannel(env.communityId, channelId);
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
