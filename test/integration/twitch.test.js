const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertReplyContains,
  assertEphemeralReply,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

describe("integration: twitch", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let processSubscription;
  let runTwitchTick;

  before(async () => {
    env = await createIntegrationEnv();
    const ticker = require("../../src/features/twitch/ticker");
    processSubscription = ticker.processSubscription;
    runTwitchTick = ticker.runTwitchTick;
  });

  it("repo: add/get/remove twitch channel", () => {
    const row = env.db.addTwitchChannel(
      env.guild.id,
      "111000",
      "tester",
      "Tester",
      "https://static-cdn.jtvnw.net/thumb.png",
    );
    assert.equal(row.broadcaster_id, "111000");
    assert.equal(row.login, "tester");
    assert.equal(row.is_live, 0);

    const fetched = env.db.getTwitchChannel(env.guild.id, "TESTER");
    assert.ok(fetched);
    assert.equal(fetched.broadcaster_id, "111000");

    // upsert by login updates display name
    const updated = env.db.addTwitchChannel(
      env.guild.id,
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

    assert.equal(env.db.removeTwitchChannel(env.guild.id, "tester"), true);
    assert.equal(env.db.removeTwitchChannel(env.guild.id, "tester"), false);
    assert.equal(env.db.getTwitchChannel(env.guild.id, "tester"), null);
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
      env.db.getGuildSettings(env.guild.id).twitch_notification_channel_id,
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
      env.db.getGuildSettings(env.guild.id).twitch_notify_role_id,
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
      env.db.getGuildSettings(env.guild.id).twitch_notify_role_id,
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
      env.db.getGuildSettings(env.guild.id).twitch_polling_interval_minutes,
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
      env.guild.id,
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
    env.db.updateGuildSettings(env.guild.id, {
      twitch_notification_channel_id: IDS.channelNotify,
      twitch_notify_role_id: null,
    });
    env.db.addTwitchChannel(env.guild.id, "333000", "livestreamer", "LiveStreamer", "");
    env.channels.notify.sent.length = 0;

    const sub = env.db.getTwitchChannel(env.guild.id, "livestreamer");
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

    await processSubscription(env.client, env.guild.id, sub, stream);

    assert.ok(
      env.channels.notify.sent.length >= 1,
      `expected notification send, got ${env.channels.notify.sent.length}`,
    );
    const sent = env.channels.notify.sent[env.channels.notify.sent.length - 1];
    assert.match(sent.content, /LiveStreamer/);
    assert.ok(sent.embeds.length === 1);
    assert.equal(sent.embeds[0].data.title, "Rating games");

    const after = env.db.getTwitchChannel(env.guild.id, "livestreamer");
    assert.equal(after.is_live, 1);
    assert.equal(after.last_stream_id, "stream-1");
  });

  it("processSubscription does not re-notify same stream id", async () => {
    env.channels.notify.sent.length = 0;
    const sub = env.db.getTwitchChannel(env.guild.id, "livestreamer");
    const stream = {
      id: "stream-1",
      user_id: "333000",
      title: "Rating games",
      started_at: new Date().toISOString(),
    };

    await processSubscription(env.client, env.guild.id, sub, stream);
    assert.equal(env.channels.notify.sent.length, 0);
  });

  it("processSubscription notifies on new stream id after offline", async () => {
    // go offline
    let sub = env.db.getTwitchChannel(env.guild.id, "livestreamer");
    await processSubscription(env.client, env.guild.id, sub, undefined);
    sub = env.db.getTwitchChannel(env.guild.id, "livestreamer");
    assert.equal(sub.is_live, 0);

    // new stream
    env.channels.notify.sent.length = 0;
    const newStream = {
      id: "stream-2",
      user_id: "333000",
      title: "Second stream",
      started_at: new Date().toISOString(),
    };
    await processSubscription(env.client, env.guild.id, sub, newStream);
    assert.ok(env.channels.notify.sent.length >= 1);
    const after = env.db.getTwitchChannel(env.guild.id, "livestreamer");
    assert.equal(after.last_stream_id, "stream-2");
  });

  it("processSubscription mentions configured role on go-live", async () => {
    env.db.updateGuildSettings(env.guild.id, {
      twitch_notify_role_id: IDS.roleExempt,
    });
    let sub = env.db.getTwitchChannel(env.guild.id, "livestreamer");
    // offline first
    await processSubscription(env.client, env.guild.id, sub, undefined);
    sub = env.db.getTwitchChannel(env.guild.id, "livestreamer");

    env.channels.notify.sent.length = 0;
    const stream = {
      id: "stream-3",
      user_id: "333000",
      title: "Role ping stream",
      started_at: new Date().toISOString(),
    };
    await processSubscription(env.client, env.guild.id, sub, stream);

    assert.ok(env.channels.notify.sent.length >= 1);
    const sent = env.channels.notify.sent[env.channels.notify.sent.length - 1];
    assert.match(sent.content, new RegExp(`<@&${IDS.roleExempt}>`));
    assert.deepEqual(sent.allowedMentions, { parse: ["roles"], roles: [IDS.roleExempt] });
  });

  it("processSubscription no-ops without notification channel", async () => {
    env.db.updateGuildSettings(env.guild.id, {
      twitch_notification_channel_id: null,
    });
    let sub = env.db.getTwitchChannel(env.guild.id, "livestreamer");
    await processSubscription(env.client, env.guild.id, sub, undefined);
    sub = env.db.getTwitchChannel(env.guild.id, "livestreamer");

    env.channels.notify.sent.length = 0;
    const stream = {
      id: "stream-4",
      user_id: "333000",
      title: "No channel",
      started_at: new Date().toISOString(),
    };
    await processSubscription(env.client, env.guild.id, sub, stream);
    assert.equal(env.channels.notify.sent.length, 0);
  });

  it("runTwitchTick no-ops without credentials (default)", async () => {
    const prevId = process.env.TWITCH_CLIENT_ID;
    const prevSecret = process.env.TWITCH_CLIENT_SECRET;
    delete process.env.TWITCH_CLIENT_ID;
    delete process.env.TWITCH_CLIENT_SECRET;
    try {
      await runTwitchTick(env.client);
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
      env.db.updateGuildSettings(env.guild.id, {
        twitch_notification_channel_id: IDS.channelNotify,
        twitch_polling_interval_minutes: 1,
      });
      env.db.addTwitchChannel(env.guild.id, "555000", "tickchan", "TickChan", "");
      // ensure it is eligible (never checked)
      env.channels.notify.sent.length = 0;

      await runTwitchTick(env.client, {
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
      const row = env.db.getTwitchChannel(env.guild.id, "tickchan");
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
      const row = env.db.getTwitchChannel(env.guild.id, "tickchan");
      assert.equal(row.is_live, 1);
      env.db.updateTwitchChannelLiveState(env.guild.id, "555000", {
        isLive: true,
        lastStreamId: row.last_stream_id,
        lastChecked: Date.now() - 120_000,
      });
      env.channels.notify.sent.length = 0;

      await runTwitchTick(env.client, {
        resolveUser: async () => null,
        fetchStreams: async () => null, // simulate Helix failure
      });

      const after = env.db.getTwitchChannel(env.guild.id, "tickchan");
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
      env.db.addTwitchChannel(env.guild.id, "666000", "skipchan", "SkipChan", "");
      env.db.updateTwitchChannelLiveState(env.guild.id, "666000", {
        isLive: false,
        lastStreamId: null,
        lastChecked: Date.now(),
      });
      env.db.addTwitchChannel(env.guild.id, "777000", "stalechan", "StaleChan", "");
      env.db.updateTwitchChannelLiveState(env.guild.id, "777000", {
        isLive: false,
        lastStreamId: null,
        lastChecked: Date.now() - 120_000,
      });

      let fetched = [];
      await runTwitchTick(env.client, {
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
