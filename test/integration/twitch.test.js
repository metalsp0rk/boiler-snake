const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertReplyContains,
  assertEphemeralReply,
} = require("../helpers/assert");
const {
  exactlyOneSend,
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

describe("integration: twitch", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let processSubscription;
  let runTwitchTick;
  let processNewClips;
  let processNewVods;

  after(() => {
    // Close SQLite handles and remove the temp dir created for this env.
    env?.cleanup();
  });

  before(async () => {
    env = await createIntegrationEnv();
    const ticker = require("../../src/features/twitch/ticker");
    processSubscription = ticker.processSubscription;
    runTwitchTick = ticker.runTwitchTick;
    processNewClips = ticker.processNewClips;
    processNewVods = ticker.processNewVods;
  });

  it("repo: add/get/remove twitch channel", () => {
    const row = env.db.addTwitchChannel(
      env.communityId,
      "111000",
      "tester",
      "Tester",
      "https://static-cdn.jtvnw.net/thumb.png",
    );
    assert.equal(row.broadcaster_id, "111000");
    assert.equal(row.login, "tester");
    assert.equal(row.is_live, 0);

    const fetched = env.db.getTwitchChannel(env.communityId, "TESTER");
    assert.ok(fetched);
    assert.equal(fetched.broadcaster_id, "111000");

    // upsert by login updates display name
    const updated = env.db.addTwitchChannel(
      env.communityId,
      "111000",
      "tester",
      "TesterRenamed",
      null,
    );
    assert.equal(updated.display_name, "TesterRenamed");
    assert.equal(
      updated.profile_image_url,
      "https://static-cdn.jtvnw.net/thumb.png",
    );

    assert.equal(env.db.removeTwitchChannel(env.communityId, "tester"), true);
    assert.equal(env.db.removeTwitchChannel(env.communityId, "tester"), false);
    assert.equal(env.db.getTwitchChannel(env.communityId, "tester"), null);
  });

  it("repo: normalizeTwitchLogin handles urls and @", () => {
    const { normalizeTwitchLogin } = env.db;
    assert.equal(normalizeTwitchLogin("https://twitch.tv/MoistCr1TiKaL"), "moistcr1tikal");
    assert.equal(normalizeTwitchLogin("twitch.tv/foo/videos"), "foo");
    assert.equal(normalizeTwitchLogin("@Bar"), "bar");
    assert.equal(normalizeTwitchLogin("Baz"), "baz");
  });

  it("/twitch add without credentials is rejected", async () => {
    const prevId = process.env.TWITCH_CLIENT_ID;
    const prevSecret = process.env.TWITCH_CLIENT_SECRET;
    delete process.env.TWITCH_CLIENT_ID;
    delete process.env.TWITCH_CLIENT_SECRET;
    try {
      const interaction = await env.runCommand({
        commandName: "twitch",
        subcommand: "add",
        admin: true,
        options: { login: "somechannel" },
      });
      assertEphemeralReply(interaction, /not configured/i);
    } finally {
      if (prevId != null) process.env.TWITCH_CLIENT_ID = prevId;
      if (prevSecret != null) process.env.TWITCH_CLIENT_SECRET = prevSecret;
    }
  });

  it("/settwitch channel sets notification channel", async () => {
    const interaction = await env.runCommand({
      commandName: "settwitch",
      subcommand: "channel",
      admin: true,
      options: { channel: env.channels.notify },
    });
    assertReplyContains(interaction, /notifications will be sent/i);
    assert.equal(
      env.db.getGuildSettings(env.communityId).twitch_notification_channel_id,
      IDS.channelNotify,
    );
  });

  it("/settwitch role sets and clears ping role", async () => {
    const role = { id: IDS.roleExempt, toString: () => `<@&${IDS.roleExempt}>` };
    const interaction = await env.runCommand({
      commandName: "settwitch",
      subcommand: "role",
      admin: true,
      options: { role },
    });
    assertReplyContains(interaction, /will mention/i);
    assert.equal(
      env.db.getGuildSettings(env.communityId).twitch_notify_role_id,
      IDS.roleExempt,
    );

    const cleared = await env.runCommand({
      commandName: "settwitch",
      subcommand: "role",
      admin: true,
      options: {},
    });
    assertReplyContains(cleared, /no longer mention/i);
    assert.equal(
      env.db.getGuildSettings(env.communityId).twitch_notify_role_id,
      null,
    );
  });

  it("/settwitch interval clamps to 1-60 via option constraints", async () => {
    const interaction = await env.runCommand({
      commandName: "settwitch",
      subcommand: "interval",
      admin: true,
      options: { minutes: 3 },
    });
    assertReplyContains(interaction, /3/);
    assert.equal(
      env.db.getGuildSettings(env.communityId).twitch_polling_interval_minutes,
      3,
    );
  });

  it("/settwitch settings shows configuration", async () => {
    const interaction = await env.runCommand({
      commandName: "settwitch",
      subcommand: "settings",
      admin: true,
    });
    assertReplyContains(interaction, /Twitch notification settings/i);
  });

  it("/twitch list shows subscriptions and status", async () => {
    env.db.addTwitchChannel(
      env.communityId,
      "222000",
      "listchan",
      "ListChan",
      "",
    );
    const interaction = await env.runCommand({
      commandName: "twitch",
      subcommand: "list",
      admin: true,
    });
    assertReplyContains(interaction, /ListChan/);
  });

  it("processSubscription sends notification on offline→live transition", async () => {
    env.db.updateGuildSettings(env.communityId, {
      twitch_notification_channel_id: IDS.channelNotify,
      twitch_notify_role_id: null,
    });
    env.db.addTwitchChannel(env.communityId, "333000", "livestreamer", "LiveStreamer", "");
    env.channels.notify.sent.length = 0;

    const sub = env.db.getTwitchChannel(env.communityId, "livestreamer");
    const stream = {
      id: "stream-1",
      user_id: "333000",
      user_login: "livestreamer",
      game_name: "Chess",
      title: "Rating games",
      started_at: new Date().toISOString(),
      viewer_count: 42,
      thumbnail_url: "https://static-cdn.jtvnw.net/broadcast/333000.jpg",
    };

    await processSubscription(fakeSupervisor(env.client), env.communityId, sub, stream);

    assert.ok(
      env.channels.notify.sent.length >= 1,
      `expected notification send, got ${env.channels.notify.sent.length}`,
    );
    const sent = env.channels.notify.sent[env.channels.notify.sent.length - 1];
    assert.match(sent.content, /LiveStreamer/);
    assert.ok(sent.embeds.length === 1);
    // PR 7: tickers post plain NormalizedEmbed JSON (no EmbedBuilder wrapper).
    assert.equal(sent.embeds[0].title, "Rating games");

    const after = env.db.getTwitchChannel(env.communityId, "livestreamer");
    assert.equal(after.is_live, 1);
    assert.equal(after.last_stream_id, "stream-1");
  });

  it("processSubscription does not re-notify same stream id", async () => {
    env.channels.notify.sent.length = 0;
    const sub = env.db.getTwitchChannel(env.communityId, "livestreamer");
    const stream = {
      id: "stream-1",
      user_id: "333000",
      title: "Rating games",
      started_at: new Date().toISOString(),
    };

    await processSubscription(fakeSupervisor(env.client), env.communityId, sub, stream);
    assert.equal(env.channels.notify.sent.length, 0);
  });

  it("processSubscription notifies on new stream id after offline", async () => {
    // go offline
    let sub = env.db.getTwitchChannel(env.communityId, "livestreamer");
    await processSubscription(fakeSupervisor(env.client), env.communityId, sub, undefined);
    sub = env.db.getTwitchChannel(env.communityId, "livestreamer");
    assert.equal(sub.is_live, 0);

    // new stream
    env.channels.notify.sent.length = 0;
    const newStream = {
      id: "stream-2",
      user_id: "333000",
      title: "Second stream",
      started_at: new Date().toISOString(),
    };
    await processSubscription(fakeSupervisor(env.client), env.communityId, sub, newStream);
    assert.ok(env.channels.notify.sent.length >= 1);
    const after = env.db.getTwitchChannel(env.communityId, "livestreamer");
    assert.equal(after.last_stream_id, "stream-2");
  });

  it("processSubscription mentions configured role on go-live", async () => {
    env.db.updateGuildSettings(env.communityId, {
      twitch_notify_role_id: IDS.roleExempt,
    });
    let sub = env.db.getTwitchChannel(env.communityId, "livestreamer");
    // offline first
    await processSubscription(fakeSupervisor(env.client), env.communityId, sub, undefined);
    sub = env.db.getTwitchChannel(env.communityId, "livestreamer");

    env.channels.notify.sent.length = 0;
    const stream = {
      id: "stream-3",
      user_id: "333000",
      title: "Role ping stream",
      started_at: new Date().toISOString(),
    };
    await processSubscription(fakeSupervisor(env.client), env.communityId, sub, stream);

    assert.ok(env.channels.notify.sent.length >= 1);
    const sent = env.channels.notify.sent[env.channels.notify.sent.length - 1];
    assert.match(sent.content, new RegExp(`<@&${IDS.roleExempt}>`));
    assert.deepEqual(sent.allowedMentions, { roles: [IDS.roleExempt] });
  });

  it("processSubscription no-ops without notification channel", async () => {
    env.db.updateGuildSettings(env.communityId, {
      twitch_notification_channel_id: null,
    });
    let sub = env.db.getTwitchChannel(env.communityId, "livestreamer");
    await processSubscription(fakeSupervisor(env.client), env.communityId, sub, undefined);
    sub = env.db.getTwitchChannel(env.communityId, "livestreamer");

    env.channels.notify.sent.length = 0;
    const stream = {
      id: "stream-4",
      user_id: "333000",
      title: "No channel",
      started_at: new Date().toISOString(),
    };
    await processSubscription(fakeSupervisor(env.client), env.communityId, sub, stream);
    assert.equal(env.channels.notify.sent.length, 0);
  });

  it("runTwitchTick no-ops without credentials (default)", async () => {
    const prevId = process.env.TWITCH_CLIENT_ID;
    const prevSecret = process.env.TWITCH_CLIENT_SECRET;
    delete process.env.TWITCH_CLIENT_ID;
    delete process.env.TWITCH_CLIENT_SECRET;
    try {
      await runTwitchTick(fakeSupervisor(env.client));
      assert.ok(true);
    } finally {
      if (prevId != null) process.env.TWITCH_CLIENT_ID = prevId;
      if (prevSecret != null) process.env.TWITCH_CLIENT_SECRET = prevSecret;
    }
  });

  it("runTwitchTick notifies go-live via injected deps", async () => {
    const prevId = process.env.TWITCH_CLIENT_ID;
    const prevSecret = process.env.TWITCH_CLIENT_SECRET;
    process.env.TWITCH_CLIENT_ID = "test-id";
    process.env.TWITCH_CLIENT_SECRET = "test-secret";
    try {
      env.db.updateGuildSettings(env.communityId, {
        twitch_notification_channel_id: IDS.channelNotify,
        twitch_polling_interval_minutes: 1,
      });
      env.db.addTwitchChannel(env.communityId, "555000", "tickchan", "TickChan", "");
      // ensure it is eligible (never checked)
      env.channels.notify.sent.length = 0;

      await runTwitchTick(fakeSupervisor(env.client), {
        resolveUser: async () => null,
        fetchStreams: async (ids) => {
          assert.ok(ids.includes("555000"), `expected 555000 in batch, got ${ids}`);
          return [
            {
              id: "tick-stream-1",
              user_id: "555000",
              user_login: "tickchan",
              title: "Tick stream",
              started_at: new Date().toISOString(),
              viewer_count: 7,
            },
          ];
        },
      });

      assert.ok(
        env.channels.notify.sent.length >= 1,
        "expected go-live notification from runTwitchTick",
      );
      const row = env.db.getTwitchChannel(env.communityId, "tickchan");
      assert.equal(row.is_live, 1);
      assert.equal(row.last_stream_id, "tick-stream-1");
    } finally {
      if (prevId != null) process.env.TWITCH_CLIENT_ID = prevId;
      else delete process.env.TWITCH_CLIENT_ID;
      if (prevSecret != null) process.env.TWITCH_CLIENT_SECRET = prevSecret;
      else delete process.env.TWITCH_CLIENT_SECRET;
    }
  });

  it("runTwitchTick keeps live state when stream fetch fails", async () => {
    const prevId = process.env.TWITCH_CLIENT_ID;
    const prevSecret = process.env.TWITCH_CLIENT_SECRET;
    process.env.TWITCH_CLIENT_ID = "test-id";
    process.env.TWITCH_CLIENT_SECRET = "test-secret";
    try {
      // tickchan is live from the previous test; make it eligible again
      const row = env.db.getTwitchChannel(env.communityId, "tickchan");
      assert.equal(row.is_live, 1);
      env.db.updateTwitchChannelLiveState(env.communityId, "555000", {
        isLive: true,
        lastStreamId: row.last_stream_id,
        lastChecked: Date.now() - 120_000,
      });
      env.channels.notify.sent.length = 0;

      await runTwitchTick(fakeSupervisor(env.client), {
        resolveUser: async () => null,
        fetchStreams: async () => null, // simulate Helix failure
      });

      const after = env.db.getTwitchChannel(env.communityId, "tickchan");
      assert.equal(after.is_live, 1, "live state must survive a failed fetch");
      assert.equal(after.last_stream_id, "tick-stream-1");
      assert.equal(env.channels.notify.sent.length, 0);
    } finally {
      if (prevId != null) process.env.TWITCH_CLIENT_ID = prevId;
      else delete process.env.TWITCH_CLIENT_ID;
      if (prevSecret != null) process.env.TWITCH_CLIENT_SECRET = prevSecret;
      else delete process.env.TWITCH_CLIENT_SECRET;
    }
  });

  it("runTwitchTick skips subscriptions checked within the guild interval", async () => {
    const prevId = process.env.TWITCH_CLIENT_ID;
    const prevSecret = process.env.TWITCH_CLIENT_SECRET;
    process.env.TWITCH_CLIENT_ID = "test-id";
    process.env.TWITCH_CLIENT_SECRET = "test-secret";
    try {
      // Fresh subscription checked right now (within the 1-minute base
      // cadence) must be skipped; a stale one must still be fetched.
      env.db.addTwitchChannel(env.communityId, "666000", "skipchan", "SkipChan", "");
      env.db.updateTwitchChannelLiveState(env.communityId, "666000", {
        isLive: false,
        lastStreamId: null,
        lastChecked: Date.now(),
      });
      env.db.addTwitchChannel(env.communityId, "777000", "stalechan", "StaleChan", "");
      env.db.updateTwitchChannelLiveState(env.communityId, "777000", {
        isLive: false,
        lastStreamId: null,
        lastChecked: Date.now() - 120_000,
      });

      let fetched = [];
      await runTwitchTick(fakeSupervisor(env.client), {
        resolveUser: async () => null,
        fetchStreams: async (ids) => {
          fetched = ids;
          return [];
        },
      });
      assert.ok(fetched.includes("777000"), "stale sub should be polled");
      assert.ok(
        !fetched.includes("666000"),
        "fresh sub within interval should be skipped",
      );
    } finally {
      if (prevId != null) process.env.TWITCH_CLIENT_ID = prevId;
      else delete process.env.TWITCH_CLIENT_ID;
      if (prevSecret != null) process.env.TWITCH_CLIENT_SECRET = prevSecret;
      else delete process.env.TWITCH_CLIENT_SECRET;
    }
  });

  it("runTwitchTick: one throwing login resolve does not abort the pass (#198)", async () => {
    const prevId = process.env.TWITCH_CLIENT_ID;
    const prevSecret = process.env.TWITCH_CLIENT_SECRET;
    process.env.TWITCH_CLIENT_ID = "test-id";
    process.env.TWITCH_CLIENT_SECRET = "test-secret";
    // Pending rows carry a non-numeric broadcaster_id until resolved.
    env.db.addTwitchChannel(env.communityId, "unres-poison", "poisonlogin", "Poison", null);
    env.db.addTwitchChannel(env.communityId, "unres-good", "goodlogin", "Good", null);

    const errors = [];
    const origErr = console.error;
    console.error = (...args) => errors.push(args.map(String).join(" "));
    let fetched = [];
    try {
      await runTwitchTick(fakeSupervisor(env.client), {
        resolveUser: async (login) => {
          if (login === "poisonlogin") {
            throw new Error("simulated Helix resolve outage");
          }
          if (login === "goodlogin") {
            return {
              id: "888500",
              login: "goodlogin",
              display_name: "Good",
              profile_image_url: "",
            };
          }
          return null;
        },
        fetchStreams: async (ids) => {
          fetched = ids;
          return [];
        },
      });

      // The second pending row was still resolved + upgraded…
      const good = env.db.getTwitchChannel(env.communityId, "goodlogin");
      assert.equal(good.broadcaster_id, "888500", "second row never upgraded");
      // …and became eligible for the same tick's stream batch.
      assert.ok(fetched.includes("888500"), `expected 888500 in ${fetched}`);

      // The poisoned row stayed pending and was logged with its login + cause.
      const poison = env.db.getTwitchChannel(env.communityId, "poisonlogin");
      assert.equal(poison.broadcaster_id, "unres-poison", "poison row mutated");
      const lines = errors.filter((l) =>
        l.includes("pending-subscription resolve failed"),
      );
      assert.equal(lines.length, 1, `expected one resolve error: ${errors.join(" | ")}`);
      assert.ok(lines[0].includes("poisonlogin"), `login missing in: ${lines[0]}`);
      assert.ok(
        lines[0].includes("simulated Helix resolve outage"),
        `cause missing in: ${lines[0]}`,
      );
    } finally {
      console.error = origErr;
      env.db.removeTwitchChannel(env.communityId, "poisonlogin");
      env.db.removeTwitchChannel(env.communityId, "goodlogin");
      if (prevId != null) process.env.TWITCH_CLIENT_ID = prevId;
      else delete process.env.TWITCH_CLIENT_ID;
      if (prevSecret != null) process.env.TWITCH_CLIENT_SECRET = prevSecret;
      else delete process.env.TWITCH_CLIENT_SECRET;
    }
  });

  it("runTwitchTick: a bad community id skips its row instead of killing the tick (#198)", async () => {
    const prevId = process.env.TWITCH_CLIENT_ID;
    const prevSecret = process.env.TWITCH_CLIENT_SECRET;
    process.env.TWITCH_CLIENT_ID = "test-id";
    process.env.TWITCH_CLIENT_SECRET = "test-secret";

    // Bad row the write repos would never accept: community id the settings
    // repo rejects (assertCommunityId throws) — the audit's "bad row" shape.
    const now = Date.now();
    env.db.db
      .prepare(
        `INSERT INTO twitch_channels
         (community_id, broadcaster_id, login, display_name, profile_image_url,
          is_live, last_stream_id, last_checked, created_at, updated_at)
         VALUES (-1, '999500', 'badrow', 'BadRow', NULL, 0, NULL, NULL, ?, ?)`,
      )
      .run(now, now);
    env.db.addTwitchChannel(env.communityId, "888501", "isolatedchan", "Isolated", null);

    const errors = [];
    const origErr = console.error;
    console.error = (...args) => errors.push(args.map(String).join(" "));
    let fetched = [];
    try {
      await runTwitchTick(fakeSupervisor(env.client), {
        resolveUser: async () => null,
        fetchStreams: async (ids) => {
          fetched = ids;
          return [];
        },
      });

      // The healthy row was polled; the poisoned one dropped itself out.
      assert.ok(fetched.includes("888501"), `expected 888501 in ${fetched}`);
      assert.ok(!fetched.includes("999500"), "bad row must not reach the batch");

      const lines = errors.filter((l) =>
        l.includes("eligibility check failed"),
      );
      assert.equal(lines.length, 1, `expected one eligibility error: ${errors.join(" | ")}`);
      assert.ok(lines[0].includes("badrow"), `login missing in: ${lines[0]}`);
      assert.ok(lines[0].includes("-1"), `community id missing in: ${lines[0]}`);
      assert.ok(
        lines[0].includes("community id required"),
        `cause missing in: ${lines[0]}`,
      );
    } finally {
      console.error = origErr;
      env.db.db
        .prepare(`DELETE FROM twitch_channels WHERE broadcaster_id = '999500'`)
        .run();
      env.db.removeTwitchChannel(env.communityId, "isolatedchan");
      if (prevId != null) process.env.TWITCH_CLIENT_ID = prevId;
      else delete process.env.TWITCH_CLIENT_ID;
      if (prevSecret != null) process.env.TWITCH_CLIENT_SECRET = prevSecret;
      else delete process.env.TWITCH_CLIENT_SECRET;
    }
  });

  it("go-live embed expands Helix thumbnail template braces", async () => {
    // Regression: Helix returns thumbnail_url as a `{width}x{height}`
    // template; sending it raw made Discord reject EVERY go-live message
    // with 400 "Invalid Form Body".
    env.db.updateGuildSettings(env.communityId, {
      twitch_notification_channel_id: IDS.channelNotify,
    });
    let sub = env.db.getTwitchChannel(env.communityId, "livestreamer");
    await processSubscription(fakeSupervisor(env.client), env.communityId, sub, undefined); // offline first
    sub = env.db.getTwitchChannel(env.communityId, "livestreamer");
    env.channels.notify.sent.length = 0;

    const stream = {
      id: "stream-thumb",
      user_id: "333000",
      title: "Templated thumbnail",
      started_at: new Date().toISOString(),
      thumbnail_url:
        "https://static-cdn.jtvnw.net/previews-ttv/live_user_livestreamer-{width}x{height}.jpg",
    };
    await processSubscription(fakeSupervisor(env.client), env.communityId, sub, stream);

    assert.ok(env.channels.notify.sent.length >= 1);
    const sent = env.channels.notify.sent[env.channels.notify.sent.length - 1];
    const thumb = sent.embeds[0].thumbnail?.url;
    assert.ok(thumb, "embed should carry a thumbnail");
    assert.ok(
      !thumb.includes("{") && !thumb.includes("}"),
      `thumbnail still templated: ${thumb}`,
    );
    assert.match(thumb, /-640x360\.jpg$/);
  });

  // ---------------------------------------------------------------------------
  // #199 (audit §6 P1, docs at-risk surfaces): ticker-level send-shape tests
  // pinning the operator-doc contract (docs/twitch-notifications.md: go-live
  // "Mention: the /settwitch role role only, via allowedMentions"; clip/VOD
  // alerts "never ping the role"). Go-live arms drive the REAL ticker entry
  // (runTwitchTick) with the transport mocked at the channel.send boundary;
  // the shared sendShape helpers assert both sides — content tokens ↔ exact
  // allowedMentions payload — so a suppressed-ping regression can never go
  // green. The EventSub fast path reuses processSubscription → the same
  // sendGoLiveNotification send, so it shares this pinned shape.
  // ---------------------------------------------------------------------------

  async function driveGoLiveViaTick(broadcasterId, login, { roleId }) {
    env.db.updateGuildSettings(env.communityId, {
      twitch_notification_channel_id: IDS.channelNotify,
      twitch_notify_role_id: roleId,
      twitch_polling_interval_minutes: 1,
    });
    // Fresh subscription, never checked → eligible for this tick.
    env.db.addTwitchChannel(env.communityId, broadcasterId, login, `${login}Display`, "");
    env.channels.notify.sent.length = 0;

    const prevId = process.env.TWITCH_CLIENT_ID;
    const prevSecret = process.env.TWITCH_CLIENT_SECRET;
    process.env.TWITCH_CLIENT_ID = "test-id";
    process.env.TWITCH_CLIENT_SECRET = "test-secret";
    try {
      await runTwitchTick(fakeSupervisor(env.client), {
        resolveUser: async () => null,
        fetchStreams: async (ids) =>
          ids.includes(broadcasterId)
            ? [
                {
                  id: `shape-stream-${broadcasterId}`,
                  user_id: broadcasterId,
                  user_login: login,
                  title: "Shape contract stream",
                  started_at: new Date().toISOString(),
                },
              ]
            : [],
      });
    } finally {
      if (prevId != null) process.env.TWITCH_CLIENT_ID = prevId;
      else delete process.env.TWITCH_CLIENT_ID;
      if (prevSecret != null) process.env.TWITCH_CLIENT_SECRET = prevSecret;
      else delete process.env.TWITCH_CLIENT_SECRET;
    }
    return exactlyOneSend(env.channels.notify.sent, `twitch go-live (${login})`);
  }

  it("go-live send pings exactly the configured role (send-shape #199)", async () => {
    const payload = await driveGoLiveViaTick("559101", "shapecast1", {
      roleId: IDS.roleExempt,
    });
    assertPingsRoleOnly(payload, IDS.roleExempt, { label: "twitch go-live alert" });
    assert.equal(payload.embeds.length, 1, "go-live alert carries exactly one embed");
    assert.equal(payload.embeds[0].title, "Shape contract stream");
  });

  it("go-live send without a role builds no mention and allows none (send-shape #199)", async () => {
    const payload = await driveGoLiveViaTick("559102", "shapecast2", { roleId: null });
    assertPingsNobody(payload, { label: "twitch go-live alert (no role)" });
    assert.equal(payload.embeds.length, 1, "go-live alert carries exactly one embed");
  });

  it("clip alerts never ping, even with a notify role configured (send-shape #199)", async () => {
    env.db.updateGuildSettings(env.communityId, {
      twitch_notification_channel_id: IDS.channelNotify,
      twitch_notify_role_id: IDS.roleExempt,
    });
    env.db.addTwitchChannel(env.communityId, "559103", "clipshape", "ClipShape", null);
    env.db.setTwitchChannelMediaFlags(env.communityId, "559103", {
      notifyClips: true,
      notifyVods: false,
    });
    env.channels.notify.sent.length = 0;
    const sub = env.db.getTwitchChannel(env.communityId, "clipshape");
    const wm = sub.last_clip_created_at;
    assert.ok(wm > 0, "enabling the flag seeds the clip watermark");

    await processNewClips(fakeSupervisor(env.client), sub, {
      fetchClips: async () => [
        {
          id: "cshape1",
          url: "https://twitch.tv/c/cshape1",
          title: "Shape clip",
          created_at: new Date(wm + 1000).toISOString(),
          duration: 12,
        },
      ],
    });

    const payload = exactlyOneSend(env.channels.notify.sent, "twitch clip alert");
    assertPingsNobody(payload, { label: "twitch clip alert" });
    assert.equal(payload.embeds.length, 1, "clip alert carries exactly one embed");
    assert.equal(payload.embeds[0].title, "Shape clip");
  });

  it("VOD alerts never ping, even with a notify role configured (send-shape #199)", async () => {
    env.db.updateGuildSettings(env.communityId, {
      twitch_notification_channel_id: IDS.channelNotify,
      twitch_notify_role_id: IDS.roleExempt,
    });
    env.db.addTwitchChannel(env.communityId, "559104", "vodshape", "VodShape", null);
    env.db.setTwitchChannelMediaFlags(env.communityId, "559104", {
      notifyClips: false,
      notifyVods: true,
    });
    env.channels.notify.sent.length = 0;
    const sub = env.db.getTwitchChannel(env.communityId, "vodshape");
    const wm = sub.last_video_created_at;
    assert.ok(wm > 0, "enabling the flag seeds the VOD watermark");

    await processNewVods(fakeSupervisor(env.client), sub, {
      fetchArchives: async () => [
        {
          id: "vshape1",
          title: "Shape VOD",
          created_at: new Date(wm + 1000).toISOString(),
          duration: "PT1H5M",
          view_count: 3,
        },
      ],
    });

    const payload = exactlyOneSend(env.channels.notify.sent, "twitch VOD alert");
    assertPingsNobody(payload, { label: "twitch VOD alert" });
    assert.equal(payload.embeds.length, 1, "VOD alert carries exactly one embed");
    assert.equal(payload.embeds[0].title, "Shape VOD");
  });

  it("denies non-staff /twitch", async () => {
    const interaction = await env.runCommand({
      commandName: "twitch",
      subcommand: "list",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(interaction, /permission/i);
  });
});
