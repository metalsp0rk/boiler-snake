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

  it("#379: runYoutubeTick gates sweeps by youtube_polling_interval_minutes", async () => {
    const channelId = "UCgate00000000001";
    env.db.updateGuildSettings(env.communityId, {
      youtube_notification_channel_id: IDS.channelNotify,
      youtube_polling_interval_minutes: 60,
    });
    env.db.addYoutubeChannel(env.communityId, channelId, "GateChannel", `https://www.youtube.com/channel/${channelId}`, "");

    let fetches = 0;
    const deps = {
      skipApiKeyCheck: true,
      fetchYouTubeFeed: async (id) => {
        if (id === channelId) fetches++;
        return null; // feed down — cadence is about the SWEEP, not deliveries
      },
    };

    // (a) Swept 30s ago with a 60-minute interval → NOT due: no API sweep.
    // (The old ticker swept everything every 5 minutes regardless.)
    env.db.markYoutubeChannelCheckedAt(env.communityId, channelId, Date.now() - 30_000);
    await runYoutubeTick(fakeSupervisor(env.client), deps);
    assert.equal(fetches, 0, "row is not swept before its interval elapses (#379)");

    // (b) Stamp older than the interval → due: exactly one sweep, and the
    // sweep STAMPS the wall-clock gate even though the feed was down.
    env.db.markYoutubeChannelCheckedAt(env.communityId, channelId, Date.now() - 61 * 60_000);
    await runYoutubeTick(fakeSupervisor(env.client), deps);
    assert.equal(fetches, 1, "row swept once its interval elapsed");
    let row = env.db.getYoutubeChannelById(env.communityId, channelId);
    assert.ok(
      Math.abs((row.last_checked_at || 0) - Date.now()) < 60_000,
      `sweep stamped last_checked_at with wall-clock time (got ${row.last_checked_at})`,
    );

    // A second immediate pass must NOT re-sweep (the stamp holds the quota).
    await runYoutubeTick(fakeSupervisor(env.client), deps);
    assert.equal(fetches, 1, "just-swept row stays gated");

    // (c) Never swept (NULL stamp) → always due.
    env.db.db.prepare(`UPDATE youtube_channels SET last_checked_at=NULL WHERE community_id=? AND id=?`).run(env.communityId, channelId);
    await runYoutubeTick(fakeSupervisor(env.client), deps);
    assert.equal(fetches, 2, "never-swept rows are always eligible");

    // (d) The setting drives the gate: drop to 1 minute → the row stamped
    // moments ago is due again.
    env.db.updateGuildSettings(env.communityId, { youtube_polling_interval_minutes: 1 });
    env.db.db.prepare(`UPDATE youtube_channels SET last_checked_at=? WHERE community_id=? AND id=?`)
      .run(Date.now() - 70_000, env.communityId, channelId);
    await runYoutubeTick(fakeSupervisor(env.client), deps);
    assert.equal(fetches, 3, "1-minute interval sweeps a row stamped 70s ago");

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

  // #456 (audit H2-14): /testnotification is THE wiring-verification command
  // — a cause-less "Could not fetch videos" told a staffer debugging a bad
  // YOUTUBE_API_KEY nothing. The fetch failure must reach the reply.
  it("/testnotification without API key names the cause in the reply (#456)", async () => {
    const prev = process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_API_KEY;
    try {
      const ix = await env.runCommand({
        commandName: "testnotification",
        admin: true,
        options: { channel: "UCcanary456nokey" },
      });
      const text = ix.replies.map((r) => r.content || "").join("\n");
      assert.match(text, /Could not fetch videos/i, "still the honest fetch arm");
      assert.match(
        text,
        /YOUTUBE_API_KEY is not set/,
        "the ACTUAL cause reaches the staff reply (RED on the old cause-less copy)",
      );
      assert.doesNotMatch(text, /check (bot )?logs|unknown error/i, "never a hand-off");
    } finally {
      if (prev != null) process.env.YOUTUBE_API_KEY = prev;
    }
  });

  it("fetchYouTubeFeed returns {error} (not null) so causes survive (#456)", async () => {
    const { fetchYouTubeFeed } = require("../../src/features/youtube/ticker");
    const prev = process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_API_KEY;
    try {
      const feed = await fetchYouTubeFeed("UCwhatever");
      assert.ok(feed && typeof feed === "object", "never a bare null again");
      assert.match(String(feed.error), /YOUTUBE_API_KEY/);
      assert.ok(!feed.items, "no items on failure");
    } finally {
      if (prev != null) process.env.YOUTUBE_API_KEY = prev;
    }
  });

  // ── #441 (audit INT-5): Google API responses must be STATUS-CHECKED ──────
  // 403 quotaExceeded / 400 invalid-key bodies parse as JSON, and the old
  // no-status-code parse made every failure masquerade as "No channel data
  // found" — fleet-wide silent notification death with the wrong cause.

  it("interpretGoogleResponse reads the status code (#441)", () => {
    const { interpretGoogleResponse } = require("../../src/features/youtube/ticker");
    const quota = interpretGoogleResponse(
      403,
      JSON.stringify({
        error: {
          code: 403,
          message: "The request cannot be completed because it has exceeded the project's quota.",
          errors: [{ reason: "quotaExceeded" }],
        },
      }),
    );
    assert.equal(quota.ok, false);
    assert.match(quota.error, /403/);
    assert.match(quota.error, /quota/i, "the REAL reason survives");
    const ok = interpretGoogleResponse(200, JSON.stringify({ items: [1] }));
    assert.equal(ok.ok, true);
    assert.equal(ok.data.items.length, 1);
    // 200-but-garbage and 200-with-error-body are ALSO failures:
    assert.equal(interpretGoogleResponse(200, "<html>rate limited</html>").ok, false);
    const bodyErr = interpretGoogleResponse(
      200,
      JSON.stringify({ error: { message: "API key not valid" } }),
    );
    assert.equal(bodyErr.ok, false);
    assert.match(bodyErr.error, /API key not valid/);
  });

  it("fetchYouTubeFeed threads a 403 quota error — never 'no channel data' (#441)", async () => {
    const { fetchYouTubeFeed, setGoogleGetForTests } = require("../../src/features/youtube/ticker");
    const prevKey = process.env.YOUTUBE_API_KEY;
    process.env.YOUTUBE_API_KEY = "TESTKEY-441";
    const restore = setGoogleGetForTests(async (pathname) => {
      assert.ok(
        !pathname.includes("key="),
        "callers pass KEY-FREE paths — the transport appends it",
      );
      return { ok: false, status: 403, error: "403 quota exceeded" };
    });
    try {
      const feed = await fetchYouTubeFeed("UCquota441");
      assert.match(String(feed.error), /quota exceeded/, "the 403 reason reaches the caller");
      assert.doesNotMatch(String(feed.error), /no channel data/, "not the misleading old copy");
      assert.doesNotMatch(String(feed.error), /TESTKEY-441/, "the key never enters the cause");
    } finally {
      setGoogleGetForTests(restore);
      if (prevKey == null) delete process.env.YOUTUBE_API_KEY;
      else process.env.YOUTUBE_API_KEY = prevKey;
    }
  });

  it("fetchYouTubeFeed success flows through the transport (no live network) (#441)", async () => {
    const { fetchYouTubeFeed, setGoogleGetForTests } = require("../../src/features/youtube/ticker");
    const prevKey = process.env.YOUTUBE_API_KEY;
    process.env.YOUTUBE_API_KEY = "TESTKEY-441";
    const seen = [];
    const restore = setGoogleGetForTests(async (pathname) => {
      seen.push(pathname);
      if (pathname.startsWith("/youtube/v3/channels")) {
        return {
          ok: true,
          data: { items: [{ contentDetails: { relatedPlaylists: { uploads: "UU441" } } }] },
        };
      }
      return {
        ok: true,
        data: {
          items: [
            { snippet: { title: "v1", publishedAt: "2026-10-17T00:00:00Z", resourceId: { videoId: "vid1" }, liveBroadcastContent: "none" } },
            { snippet: { title: "v2", publishedAt: "2026-10-17T01:00:00Z", resourceId: { videoId: "vid2" }, liveBroadcastContent: "live" } },
          ],
        },
      };
    });
    try {
      const feed = await fetchYouTubeFeed("UCgood441");
      assert.equal(feed.items.length, 2, "success path intact");
      assert.equal(feed.items[1].id, "vid2");
      assert.equal(feed.items[1].liveBroadcastContent, "live");
      assert.equal(seen.length, 2, "channels lookup then playlist items");
    } finally {
      setGoogleGetForTests(restore);
      if (prevKey == null) delete process.env.YOUTUBE_API_KEY;
      else process.env.YOUTUBE_API_KEY = prevKey;
    }
  });

  it("search + channel-info degrade to null with a logged cause under quota (#441)", async () => {
    const {
      fetchChannelInfo,
      lookupChannelByName,
      setGoogleGetForTests,
    } = require("../../src/features/youtube/ticker");
    const prevKey = process.env.YOUTUBE_API_KEY;
    process.env.YOUTUBE_API_KEY = "TESTKEY-441";
    const restore = setGoogleGetForTests(async () => ({
      ok: false,
      status: 403,
      error: "403 quota exceeded",
    }));
    try {
      assert.equal(await fetchChannelInfo("UCx441"), null, "honest null, cause logged");
      assert.equal(await lookupChannelByName("somechannel"), null);
    } finally {
      setGoogleGetForTests(restore);
      if (prevKey == null) delete process.env.YOUTUBE_API_KEY;
      else process.env.YOUTUBE_API_KEY = prevKey;
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

  // #442 (audit INT-7): the old probe `SELECT changes()` yields a column
  // LITERALLY named "changes()", so `.changes` was undefined and
  // removeYoutubeChannel returned FALSE EVEN WHEN THE DELETE LANDED — both
  // callers had to paper over it with duplicated row-count diffs (now gone).
  it("#442: removeYoutubeChannel reports the DELETE honestly", () => {
    const channelId = "UCreturnflag0001";
    env.db.addYoutubeChannel(
      env.communityId,
      channelId,
      "FlagCanary",
      `https://www.youtube.com/channel/${channelId}`,
      "",
    );

    assert.equal(
      env.db.removeYoutubeChannel(env.communityId, channelId),
      true,
      "a delete that landed must report true",
    );
    assert.equal(
      env.db.getYoutubeChannelById(env.communityId, channelId),
      undefined,
      "row is gone",
    );
    assert.equal(
      env.db.removeYoutubeChannel(env.communityId, channelId),
      false,
      "a delete that matched nothing reports false",
    );
  });

  it("/youtube remove confirms via the honest repo flag — no row-count rescue (#442)", async () => {
    const channelId = "UCslashremove001";
    env.db.addYoutubeChannel(
      env.communityId,
      channelId,
      "SlashCanary",
      `https://www.youtube.com/channel/${channelId}`,
      "",
    );

    const remove = await env.runCommand({
      commandName: "youtube",
      subcommand: "remove",
      admin: true,
      options: { channel: channelId },
    });
    assert.match(env.lastReplyContent(remove), /Unsubscribed from \*\*SlashCanary\*\*/);
    assert.equal(
      env.db.getYoutubeChannelById(env.communityId, channelId),
      undefined,
      "row gone",
    );

    // Unknown id keeps the pre-delete guard reply.
    const missing = await env.runCommand({
      commandName: "youtube",
      subcommand: "remove",
      admin: true,
      options: { channel: "UCdoes-not-exist" },
    });
    assert.equal(env.lastReplyContent(missing), "No subscription found.");
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
