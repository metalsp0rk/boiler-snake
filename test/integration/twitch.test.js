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
const { IDS, uniqueId } = require("../helpers/fixtures");

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

  // ── #447 (audit INT-12): a failed send must NOT burn the go-live ─────────

  it("send failure releases the claim — retry while live lands exactly one ping (#447)", async () => {
    // Point the notify channel at a channel that cannot receive (unknown id
    // → honest send failure), then hit go-live.
    env.db.updateGuildSettings(env.communityId, {
      twitch_notification_channel_id: "channel-nonexistent-447",
      twitch_notify_role_id: null,
    });
    env.channels.notify.sent.length = 0;
    const sub = env.db.getTwitchChannel(env.communityId, "livestreamer");
    const stream = {
      id: "stream-447fail",
      user_id: "333000",
      user_login: "livestreamer",
      title: "Broken send",
      started_at: new Date().toISOString(),
    };

    await processSubscription(fakeSupervisor(env.client), env.communityId, sub, stream);
    assert.equal(env.channels.notify.sent.length, 0, "send failed (unknown channel)");
    assert.notEqual(
      env.db.getTwitchChannel(env.communityId, "livestreamer").last_stream_id,
      "stream-447fail",
      "the watermark is NOT burned by a failed send (RED: old code burned it)",
    );

    // Staff fixed the config; the stream is still live → next tick retries.
    env.db.updateGuildSettings(env.communityId, {
      twitch_notification_channel_id: IDS.channelNotify,
    });
    await processSubscription(fakeSupervisor(env.client), env.communityId, sub, stream);
    assert.equal(env.channels.notify.sent.length, 1, "retry delivers the ping");
    assert.equal(
      env.db.getTwitchChannel(env.communityId, "livestreamer").last_stream_id,
      "stream-447fail",
      "sent = burned",
    );

    await processSubscription(fakeSupervisor(env.client), env.communityId, sub, stream);
    assert.equal(env.channels.notify.sent.length, 1, "no double announce after success");
  });

  it("an unconfigured notify channel never burns the stream — self-heals (#447)", async () => {
    env.db.updateGuildSettings(env.communityId, {
      twitch_notification_channel_id: null,
    });
    env.channels.notify.sent.length = 0;
    const sub = env.db.getTwitchChannel(env.communityId, "livestreamer");
    const stream = {
      id: "stream-447misconfig",
      user_id: "333000",
      title: "During outage",
      started_at: new Date().toISOString(),
    };

    await processSubscription(fakeSupervisor(env.client), env.communityId, sub, stream);
    assert.notEqual(
      env.db.getTwitchChannel(env.communityId, "livestreamer").last_stream_id,
      "stream-447misconfig",
      "misconfiguration must not consume the go-live (RED: old code burned it)",
    );

    env.db.updateGuildSettings(env.communityId, {
      twitch_notification_channel_id: IDS.channelNotify,
    });
    await processSubscription(fakeSupervisor(env.client), env.communityId, sub, stream);
    assert.equal(env.channels.notify.sent.length, 1, "self-heals once configured");
  });

  it("releaseTwitchStreamClaim compare-and-restores — never tramples newer claims (#447)", () => {
    const c1 = env.db.claimTwitchStream(env.communityId, "333000", "cas-1");
    assert.equal(c1.isNew, true);
    const c2 = env.db.claimTwitchStream(env.communityId, "333000", "cas-2");
    assert.equal(c2.isNew, true);
    assert.equal(c2.previousStreamId, "cas-1", "claim hands back the prior watermark");

    // Stale release (the claim it belongs to is already gone) must NOT touch cas-2.
    assert.equal(
      env.db.releaseTwitchStreamClaim(env.communityId, "333000", "cas-1", c1.previousStreamId),
      false,
      "compare-and-release: claimed id no longer current",
    );
    assert.equal(
      env.db.getTwitchChannel(env.communityId, "333000").last_stream_id,
      "cas-2",
      "newer claim intact",
    );
    assert.equal(
      env.db.releaseTwitchStreamClaim(env.communityId, "333000", "cas-2", "cas-1"),
      true,
    );
    assert.equal(
      env.db.getTwitchChannel(env.communityId, "333000").last_stream_id,
      "cas-1",
    );
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

// ---------- per-subscription notification overrides (issue #177) ----------

/**
 * Isolated env (unique guild → unique community) so the guild-wide twitch
 * settings the earlier suite pinned cannot leak into — or from — these
 * override assertions. Ticker arms drive runTwitchTick through the deps
 * seam with numeric broadcaster ids (the tick's numeric-id filter).
 */
describe("integration: twitch per-subscription notification overrides (issue #177)", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let runTwitchTick;
  let processNewClips;
  let resolveTwitchNotifyTargets;

  const OV_ROLE = "role-override-700";

  before(async () => {
    env = await createIntegrationEnv({ guildId: uniqueId("guild-twitch-ov") });
    const ticker = require("../../src/features/twitch/ticker");
    runTwitchTick = ticker.runTwitchTick;
    processNewClips = ticker.processNewClips;
    resolveTwitchNotifyTargets = ticker.resolveTwitchNotifyTargets;
    env.db.updateGuildSettings(env.communityId, {
      twitch_notification_channel_id: IDS.channelNotify,
      twitch_notify_role_id: IDS.roleExempt,
      audit_log_channel_id: IDS.channelLog,
      twitch_polling_interval_minutes: 1,
    });
    for (const ch of Object.values(env.channels)) ch.sent.length = 0;
  });

  after(() => env?.cleanup());

  function clearSends() {
    for (const ch of Object.values(env.channels)) ch.sent.length = 0;
  }

  /** Drive one real ticker tick with the Helix lookup mocked at the seam. */
  async function tickWith(broadcasterId, login, live) {
    const prevId = process.env.TWITCH_CLIENT_ID;
    const prevSecret = process.env.TWITCH_CLIENT_SECRET;
    process.env.TWITCH_CLIENT_ID = "test-id";
    process.env.TWITCH_CLIENT_SECRET = "test-secret";
    try {
      await runTwitchTick(fakeSupervisor(env.client), {
        resolveUser: async () => null,
        fetchStreams: async (ids) =>
          live && ids.includes(broadcasterId)
            ? [
                {
                  id: `ov-stream-${broadcasterId}`,
                  user_id: broadcasterId,
                  user_login: login,
                  title: "Override stream",
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
  }

  /** Config-change embeds posted to the fake audit channel. */
  function auditEmbeds() {
    return env.channels.log.sent
      .map((p) => {
        const e = p && p.embeds && p.embeds[0];
        return e ? (e.toJSON ? e.toJSON() : e) : null;
      })
      .filter(Boolean);
  }

  // ---------- storage + resolver ----------

  it("storage: fresh subs carry NULL overrides; the setter sets/leaves/clears independently (migration 059)", () => {
    env.db.addTwitchChannel(env.communityId, "660100", "ovcast", "OvCast", null);
    let sub = env.db.getTwitchChannel(env.communityId, "ovcast");
    assert.ok("notify_channel_id" in sub, "column exists after migration 059");
    assert.equal(sub.notify_channel_id, null);
    assert.equal(sub.notify_role_id, null);

    sub = env.db.setTwitchChannelNotifyTargets(env.communityId, "660100", {
      channelId: IDS.channelCmds,
      roleId: OV_ROLE,
    });
    assert.equal(sub.notify_channel_id, IDS.channelCmds);
    assert.equal(sub.notify_role_id, OV_ROLE);

    // undefined LEAVES the other field untouched; null clears its own
    sub = env.db.setTwitchChannelNotifyTargets(env.communityId, "660100", {
      channelId: null,
    });
    assert.equal(sub.notify_channel_id, null, "channel cleared");
    assert.equal(sub.notify_role_id, OV_ROLE, "role untouched");

    // blank strings coerce to clear (repo never stores an empty id)
    sub = env.db.setTwitchChannelNotifyTargets(env.communityId, "660100", {
      roleId: "   ",
    });
    assert.equal(sub.notify_role_id, null);

    // no keys → unchanged row returned
    env.db.setTwitchChannelNotifyTargets(env.communityId, "660100", {
      channelId: IDS.channelCmds,
    });
    const same = env.db.setTwitchChannelNotifyTargets(env.communityId, "660100", {});
    assert.equal(same.notify_channel_id, IDS.channelCmds);

    // unknown subscription → null (command surfaces the same via "no match")
    assert.equal(
      env.db.setTwitchChannelNotifyTargets(env.communityId, "999999999", {
        channelId: "x",
      }),
      null,
    );

    // leave ovcast clean for the command suite below
    const reset = env.db.setTwitchChannelNotifyTargets(env.communityId, "660100", {
      channelId: null,
      roleId: null,
    });
    assert.equal(reset.notify_channel_id, null);
    assert.equal(reset.notify_role_id, null);
  });

  it("resolver: the override wins when set; NULL/absent falls back to the guild pair", () => {
    const settings = {
      twitch_notification_channel_id: "GUILD_CH",
      twitch_notify_role_id: "GUILD_ROLE",
    };
    assert.deepEqual(
      resolveTwitchNotifyTargets(
        { notify_channel_id: "SUB_CH", notify_role_id: "SUB_ROLE" },
        settings,
      ),
      { channelId: "SUB_CH", roleId: "SUB_ROLE" },
    );
    assert.deepEqual(resolveTwitchNotifyTargets({}, settings), {
      channelId: "GUILD_CH",
      roleId: "GUILD_ROLE",
    });
    assert.deepEqual(
      resolveTwitchNotifyTargets({ notify_channel_id: "SUB_CH" }, settings),
      { channelId: "SUB_CH", roleId: "GUILD_ROLE" },
    );
    assert.deepEqual(resolveTwitchNotifyTargets(null, null), {
      channelId: null,
      roleId: null,
    });
  });

  // ---------- /twitch notify command ----------

  it("command surface: notify carries an autocomplete channel + optional picker/clear toggles", () => {
    const { commands } = require("../../src/features/twitch/index.js");
    const cmd = commands[0].toJSON();
    const sub = cmd.options.find((o) => o.name === "notify");
    assert.ok(sub, "notify subcommand registered");
    const byName = Object.fromEntries(sub.options.map((o) => [o.name, o]));
    assert.equal(byName.channel.type, 3);
    assert.equal(byName.channel.required, true);
    assert.equal(byName.channel.autocomplete, true);
    assert.equal(byName.discord_channel.type, 7); // channel picker, optional
    assert.equal(byName.discord_channel.required, false);
    assert.equal(byName.role.type, 8); // role picker, optional
    assert.equal(byName.role.required, false);
    assert.equal(byName.clear.type, 5); // boolean, optional
    assert.equal(byName.clear.required, false);
  });

  it("/twitch notify: sets the channel override, audits old→new, and marks /twitch list", async () => {
    const interaction = await env.runCommand({
      commandName: "twitch",
      subcommand: "notify",
      admin: true,
      options: { channel: "ovcast", discord_channel: env.channels.cmds },
    });
    assertReplyContains(interaction, /this sub/i);
    let sub = env.db.getTwitchChannel(env.communityId, "ovcast");
    assert.equal(sub.notify_channel_id, IDS.channelCmds);
    assert.equal(sub.notify_role_id, null, "role override untouched");

    const embed = auditEmbeds().find(
      (e) => e.title === "Twitch per-channel overrides updated",
    );
    assert.ok(embed, "config-change embed lands in the audit channel");
    assert.ok(
      JSON.stringify(embed).includes("*guild default* → <#" + IDS.channelCmds + ">"),
      JSON.stringify(embed),
    );

    const listed = await env.runCommand({
      commandName: "twitch",
      subcommand: "list",
      admin: true,
      options: {},
    });
    assertReplyContains(listed, new RegExp(`→ <#${IDS.channelCmds}>`));
  });

  it("/twitch notify: clear:true XORs the pickers, empty calls guide, unknown subs refuse", async () => {
    const both = await env.runCommand({
      commandName: "twitch",
      subcommand: "notify",
      admin: true,
      options: { channel: "ovcast", discord_channel: env.channels.notify, clear: true },
    });
    assertReplyContains(both, /clear:true/);
    assert.equal(
      env.db.getTwitchChannel(env.communityId, "ovcast").notify_channel_id,
      IDS.channelCmds,
      "nothing persisted on the XOR refusal",
    );

    const empty = await env.runCommand({
      commandName: "twitch",
      subcommand: "notify",
      admin: true,
      options: { channel: "ovcast" },
    });
    assertReplyContains(empty, /Provide a .discord_channel/);

    const ghost = await env.runCommand({
      commandName: "twitch",
      subcommand: "notify",
      admin: true,
      options: { channel: "not-a-sub", discord_channel: env.channels.cmds },
    });
    assertReplyContains(ghost, /No matching subscription/);
  });

  it("/twitch notify: refuses an unresolvable Discord channel with the specific reason (nothing stored)", async () => {
    const interaction = await env.runCommand({
      commandName: "twitch",
      subcommand: "notify",
      admin: true,
      options: {
        channel: "ovcast",
        discord_channel: { id: "990000000000000001", toString: () => "<#990000000000000001>" },
      },
    });
    assertReplyContains(interaction, /couldn.t find/);
    assert.equal(
      env.db.getTwitchChannel(env.communityId, "ovcast").notify_channel_id,
      IDS.channelCmds,
      "prior override survives the refused write",
    );
  });

  it("/twitch notify clear:true resets both overrides and reports the effective guild defaults", async () => {
    env.db.setTwitchChannelNotifyTargets(env.communityId, "660100", {
      roleId: OV_ROLE,
    });
    const interaction = await env.runCommand({
      commandName: "twitch",
      subcommand: "notify",
      admin: true,
      options: { channel: "ovcast", clear: true },
    });
    assertReplyContains(interaction, /cleared/i);
    assertReplyContains(interaction, /guild default/);
    const sub = env.db.getTwitchChannel(env.communityId, "ovcast");
    assert.equal(sub.notify_channel_id, null);
    assert.equal(sub.notify_role_id, null);
    const cleared = auditEmbeds().find(
      (e) => e.title === "Twitch per-channel overrides cleared",
    );
    assert.ok(cleared, "clear lands its own audit entry");

    const listed = await env.runCommand({
      commandName: "twitch",
      subcommand: "list",
      admin: true,
      options: {},
    });
    const reply = interactionReplyText(listed);
    assert.ok(!reply.includes(`→ <#${IDS.channelCmds}>`), "list marker removed");
  });

  /** Plain text of an interaction's last reply (works for content replies). */
  function interactionReplyText(interaction) {
    const replies = interaction.replies || [];
    const last = replies[replies.length - 1];
    const payload = typeof last === "string" ? { content: last } : last || {};
    if (typeof payload === "string") return payload;
    return String(payload.content ?? "");
  }

  // ---------- ticker routing ----------

  it("ticker: an overridden go-live lands ONLY in the override channel; the guild role still pings", async () => {
    env.db.addTwitchChannel(env.communityId, "660200", "ovlive", "OvLive", null);
    env.db.setTwitchChannelNotifyTargets(env.communityId, "660200", {
      channelId: IDS.channelCmds,
    });
    clearSends();
    await tickWith("660200", "ovlive", true);

    const payload = exactlyOneSend(env.channels.cmds.sent, "override go-live");
    assertPingsRoleOnly(payload, IDS.roleExempt, {
      label: "twitch override go-live (guild role fallback)",
    });
    assert.equal(env.channels.notify.sent.length, 0, "guild channel must stay empty");
  });

  it("ticker: the role override replaces the guild ping role for that sub only", async () => {
    env.db.addTwitchChannel(env.communityId, "660300", "ovrole", "OvRole", null);
    env.db.setTwitchChannelNotifyTargets(env.communityId, "660300", {
      channelId: IDS.channelCmds,
      roleId: OV_ROLE,
    });
    clearSends();
    await tickWith("660300", "ovrole", true);

    const payload = exactlyOneSend(env.channels.cmds.sent, "role-override go-live");
    assertPingsRoleOnly(payload, OV_ROLE, {
      label: "twitch override go-live (override role)",
    });
    assert.ok(payload.content.includes(`<@&${OV_ROLE}>`));
    assert.ok(!payload.content.includes(IDS.roleExempt), "guild role must not ride along");
  });

  it("ticker: an override alone (guild default unset) still delivers", async () => {
    env.db.updateGuildSettings(env.communityId, {
      twitch_notification_channel_id: null,
      twitch_notify_role_id: null,
    });
    env.db.addTwitchChannel(env.communityId, "660400", "ovonly", "OvOnly", null);
    env.db.setTwitchChannelNotifyTargets(env.communityId, "660400", {
      channelId: IDS.channelCmds,
    });
    clearSends();
    await tickWith("660400", "ovonly", true);

    const payload = exactlyOneSend(env.channels.cmds.sent, "override-only go-live");
    assertPingsNobody(payload, { label: "twitch override-only go-live" });
  });

  it("ticker: a DELETED override channel fails honestly — claim releases, the fixed route retries", async () => {
    env.db.updateGuildSettings(env.communityId, {
      twitch_notification_channel_id: IDS.channelNotify,
    });
    env.db.addTwitchChannel(env.communityId, "660500", "ovdead", "OvDead", null);
    env.db.setTwitchChannelNotifyTargets(env.communityId, "660500", {
      channelId: "990000000000000002", // not in the fake guild: unresolvable
    });
    clearSends();
    await tickWith("660500", "ovdead", true);

    assert.equal(env.channels.notify.sent.length, 0);
    assert.equal(env.channels.cmds.sent.length, 0);
    let sub = env.db.getTwitchChannel(env.communityId, "ovdead");
    assert.equal(sub.last_stream_id, null, "#447 claim released after the failed send");

    // Fix the route + bypass the one-minute re-check gate, tick again.
    env.db.setTwitchChannelNotifyTargets(env.communityId, "660500", {
      channelId: IDS.channelCmds,
    });
    env.db.db
      .prepare("UPDATE twitch_channels SET last_checked=NULL WHERE community_id=? AND broadcaster_id=?")
      .run(env.communityId, "660500");
    await tickWith("660500", "ovdead", true);

    exactlyOneSend(env.channels.cmds.sent, "recovered go-live");
    sub = env.db.getTwitchChannel(env.communityId, "ovdead");
    assert.equal(sub.last_stream_id, "ov-stream-660500", "claim persisted after success");
  });

  it("ticker: clip alerts honor the channel override too (and still never ping)", async () => {
    env.db.addTwitchChannel(env.communityId, "660600", "ovclips", "OvClips", null);
    env.db.setTwitchChannelMediaFlags(env.communityId, "660600", {
      notifyClips: true,
      notifyVods: false,
    });
    env.db.setTwitchChannelNotifyTargets(env.communityId, "660600", {
      channelId: IDS.channelCmds,
    });
    clearSends();
    const sub = env.db.getTwitchChannel(env.communityId, "ovclips");
    const wm = sub.last_clip_created_at;
    assert.ok(wm > 0, "media flag seeds the clip watermark");

    await processNewClips(fakeSupervisor(env.client), sub, {
      fetchClips: async () => [
        {
          id: "cov1",
          url: "https://twitch.tv/c/cov1",
          title: "Override clip",
          created_at: new Date(wm + 1000).toISOString(),
          duration: 9,
        },
      ],
    });

    const payload = exactlyOneSend(env.channels.cmds.sent, "override clip alert");
    assertPingsNobody(payload, { label: "twitch override clip alert" });
    assert.equal(env.channels.notify.sent.length, 0, "guild channel stays out of it");
  });

  it("non-staff invokers cannot manage overrides", async () => {
    const interaction = await env.runCommand({
      commandName: "twitch",
      subcommand: "notify",
      admin: false,
      user: env.users.memberUser,
      options: { channel: "ovcast", discord_channel: env.channels.cmds },
    });
    assertEphemeralReply(interaction, /permission/i);
    assert.equal(
      env.db.getTwitchChannel(env.communityId, "ovcast").notify_channel_id,
      null,
    );
  });
});

// ---------- go-offline announcements (issue #179) ----------

/**
 * Per-subscription opt-in (default OFF). Watermark discipline mirrors the
 * clip pattern: enabling re-seeds `last_offline_stream_id` to the in-flight
 * stream so a pre-opt-in broadcast never gets a goodnight; recording the
 * announced stream id keeps restart/reconcile replays silent. Every offline
 * arm drives the REAL ticker (go-live tick → offline tick) with the one-
 * minute re-check gate cleared between ticks via direct SQL.
 */
describe("integration: twitch go-offline announcements (issue #179)", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let runTwitchTick;

  before(async () => {
    env = await createIntegrationEnv({ guildId: uniqueId("guild-twitch-off") });
    runTwitchTick = require("../../src/features/twitch/ticker").runTwitchTick;
    env.db.updateGuildSettings(env.communityId, {
      twitch_notification_channel_id: IDS.channelNotify,
      twitch_notify_role_id: IDS.roleExempt,
      audit_log_channel_id: IDS.channelLog,
      twitch_polling_interval_minutes: 1,
    });
    clearSends();
  });

  after(() => env?.cleanup());

  function clearSends() {
    for (const ch of Object.values(env.channels)) ch.sent.length = 0;
  }

  // Production gives every broadcast a NEW stream id; so must the mock —
  // otherwise a "next stream" would be indistinguishable from a suppressed
  // one and the watermark tests would lie.
  let liveSeq = 0;

  function tickWith(broadcasterId, login, live) {
    const prevId = process.env.TWITCH_CLIENT_ID;
    const prevSecret = process.env.TWITCH_CLIENT_SECRET;
    process.env.TWITCH_CLIENT_ID = "test-id";
    process.env.TWITCH_CLIENT_SECRET = "test-secret";
    const streamId = `off-stream-${broadcasterId}-${++liveSeq}`;
    return runTwitchTick(fakeSupervisor(env.client), {
      resolveUser: async () => null,
      fetchStreams: async (ids) =>
        live && ids.includes(broadcasterId)
          ? [
              {
                id: streamId,
                user_id: broadcasterId,
                user_login: login,
                title: "Offline-cycle stream",
                started_at: new Date().toISOString(),
              },
            ]
          : [],
    }).finally(() => {
      if (prevId != null) process.env.TWITCH_CLIENT_ID = prevId;
      else delete process.env.TWITCH_CLIENT_ID;
      if (prevSecret != null) process.env.TWITCH_CLIENT_SECRET = prevSecret;
      else delete process.env.TWITCH_CLIENT_SECRET;
    });
  }

  /** Skip the ≥60s re-check gate between the go-live and offline ticks. */
  function forceRecheck(broadcasterId) {
    env.db.db
      .prepare(
        "UPDATE twitch_channels SET last_checked=NULL WHERE community_id=? AND broadcaster_id=?",
      )
      .run(env.communityId, broadcasterId);
  }

  /** Sent go-offline payloads on a channel (content-gated, embeds ignored). */
  function offlineSends(channel) {
    return (channel.sent || []).filter((p) =>
      String(p?.content || "").includes("went offline"),
    );
  }

  it("storage: flags default off; enabling seeds the watermark to the in-flight stream; disable keeps it", () => {
    env.db.addTwitchChannel(env.communityId, "770000", "offseed", "OffSeed", null);
    let sub = env.db.getTwitchChannel(env.communityId, "offseed");
    assert.ok("notify_offline" in sub, "column exists after migration 060");
    assert.equal(sub.notify_offline, 0);
    assert.equal(sub.last_offline_stream_id, null);
    assert.equal(sub.last_offline_at, null);

    // Put a stream in flight (the go-live claim does this in production).
    const claim = env.db.claimTwitchStream(env.communityId, "770000", "inflight-1");
    assert.equal(claim.isNew, true);

    // Opt-in mid-stream → the in-flight stream is suppressed forever.
    sub = env.db.setTwitchChannelOfflineFlag(env.communityId, "770000", true);
    assert.equal(sub.notify_offline, 1);
    assert.equal(sub.last_offline_stream_id, "inflight-1", "seeded to the in-flight stream");
    assert.ok(Number.isInteger(sub.last_offline_at) && sub.last_offline_at > 0);

    // The stream ends (claim reports the ended id) but stays unannounced.
    const off = env.db.claimTwitchOffline(env.communityId, "770000");
    assert.deepEqual(off, { wasLive: true, previousStreamId: "inflight-1" });

    // Disable keeps the watermark; re-enable with a NEWER stream in flight
    // re-seeds to THAT stream.
    env.db.setTwitchChannelOfflineFlag(env.communityId, "770000", false);
    assert.equal(
      env.db.getTwitchChannel(env.communityId, "770000").last_offline_stream_id,
      "inflight-1",
      "watermark survives disable",
    );
    env.db.claimTwitchStream(env.communityId, "770000", "inflight-2");
    sub = env.db.setTwitchChannelOfflineFlag(env.communityId, "770000", true);
    assert.equal(sub.last_offline_stream_id, "inflight-2", "re-seed on re-enable");

    // Unknown sub → null.
    assert.equal(
      env.db.setTwitchChannelOfflineFlag(env.communityId, "999999999", true),
      null,
    );
  });

  it("repo: the offline claim/release/record trio keeps the stream-id CAS honest", () => {
    env.db.addTwitchChannel(env.communityId, "770001", "offcas", "OffCas", null);
    env.db.claimTwitchStream(env.communityId, "770001", "cas-1");

    // Release refuses while the row is still live.
    assert.equal(env.db.releaseTwitchOfflineClaim(env.communityId, "770001", "cas-1"), false);

    const off = env.db.claimTwitchOffline(env.communityId, "770001");
    assert.deepEqual(off, { wasLive: true, previousStreamId: "cas-1" });
    // Re-arm succeeds on the matching ended stream.
    assert.equal(env.db.releaseTwitchOfflineClaim(env.communityId, "770001", "cas-1"), true);
    assert.equal(env.db.getTwitchChannel(env.communityId, "offcas").is_live, 1);

    // A newer stream supersedes the release…
    env.db.claimTwitchStream(env.communityId, "770001", "cas-2");
    env.db.claimTwitchOffline(env.communityId, "770001");
    assert.equal(
      env.db.releaseTwitchOfflineClaim(env.communityId, "770001", "cas-1"),
      false,
      "CAS on last_stream_id: old stream can't re-arm over the new one",
    );
    // …and a null ended id never releases.
    assert.equal(env.db.releaseTwitchOfflineClaim(env.communityId, "770001", null), false);

    // Record stamps the watermark + timestamp.
    const rec = env.db.recordTwitchOfflineAnnouncement(env.communityId, "770001", "cas-2");
    assert.equal(rec.last_offline_stream_id, "cas-2");
    assert.ok(rec.last_offline_at > 0);
  });

  it("ticker: opt-in while offline → next stream's end announces exactly once; replays stay silent", async () => {
    env.db.addTwitchChannel(env.communityId, "770100", "gocast", "GoCast", null);
    env.db.setTwitchChannelOfflineFlag(env.communityId, "770100", true); // seeds NULL watermark (offline)

    clearSends();
    await tickWith("770100", "gocast", true); // go-live (announced, not under test)
    forceRecheck("770100");
    await tickWith("770100", "gocast", false); // stream ends → goodnight

    const sent = offlineSends(env.channels.notify);
    assert.equal(sent.length, 1, "exactly one goodnight");
    assertPingsNobody({ ...sent[0], allowedMentions: sent[0].allowedMentions }, {
      label: "twitch go-offline announce",
    });
    assert.ok(sent[0].content.includes("**GoCast** went offline"));

    // Another offline tick (reconcile replay): wasLive is gone → silent.
    forceRecheck("770100");
    await tickWith("770100", "gocast", false);
    assert.equal(offlineSends(env.channels.notify).length, 1, "no repeat");

    // Stale-live replay with the SAME ended stream (simulated crash before
    // the state flip landed): the recorded watermark suppresses it.
    env.db.db
      .prepare(
        "UPDATE twitch_channels SET is_live=1, last_checked=NULL WHERE community_id=? AND broadcaster_id=?",
      )
      .run(env.communityId, "770100");
    await tickWith("770100", "gocast", false);
    assert.equal(
      offlineSends(env.channels.notify).length,
      1,
      "watermarked stream id never double-posts",
    );
  });

  it("ticker: a stream already live when the opt-in lands never gets a goodnight", async () => {
    env.db.addTwitchChannel(env.communityId, "770200", "midcast", "MidCast", null);
    clearSends();
    await tickWith("770200", "midcast", true); // live BEFORE opt-in

    env.db.setTwitchChannelOfflineFlag(env.communityId, "770200", true); // seeds in-flight id
    forceRecheck("770200");
    await tickWith("770200", "midcast", false); // that stream ends

    assert.equal(offlineSends(env.channels.notify).length, 0, "pre-opt-in stream suppressed");
    // The NEXT stream (started after the opt-in) does announce:
    forceRecheck("770200");
    await tickWith("770200", "midcast", true);
    forceRecheck("770200");
    await tickWith("770200", "midcast", false);
    assert.equal(offlineSends(env.channels.notify).length, 1, "post-opt-in stream announced");
  });

  it("ticker: the default-off case stays fully silent (log-only go-offline)", async () => {
    env.db.addTwitchChannel(env.communityId, "770300", "quiet", "Quiet", null);
    clearSends();
    await tickWith("770300", "quiet", true);
    forceRecheck("770300");
    await tickWith("770300", "quiet", false);
    assert.equal(offlineSends(env.channels.notify).length, 0);
    assert.equal(env.channels.notify.sent.length, 1, "only the go-live posted");
    // State still flipped: the offline claim consumed cleanly.
    assert.equal(env.db.getTwitchChannel(env.communityId, "quiet").is_live, 0);
  });

  it("ticker: the goodnight honors the /twitch notify channel override (#177 composition)", async () => {
    env.db.addTwitchChannel(env.communityId, "770400", "routed", "Routed", null);
    env.db.setTwitchChannelMediaFlags(env.communityId, "770400", {
      notifyClips: false,
      notifyVods: false,
    });
    env.db.setTwitchChannelNotifyTargets(env.communityId, "770400", {
      channelId: IDS.channelCmds,
    });
    env.db.setTwitchChannelOfflineFlag(env.communityId, "770400", true);

    clearSends();
    await tickWith("770400", "routed", true);
    forceRecheck("770400");
    await tickWith("770400", "routed", false);

    assert.equal(offlineSends(env.channels.cmds).length, 1, "override channel got it");
    assert.equal(offlineSends(env.channels.notify).length, 0, "guild channel stayed out");
  });

  it("ticker: a failed goodnight re-arms the transition and retries once the route is fixed", async () => {
    env.db.addTwitchChannel(env.communityId, "770500", "broken", "Broken", null);
    env.db.setTwitchChannelOfflineFlag(env.communityId, "770500", true);
    clearSends();
    await tickWith("770500", "broken", true); // live on the healthy guild route

    // Route breaks mid-stream (channel deleted → unresolvable id).
    env.db.setTwitchChannelNotifyTargets(env.communityId, "770500", {
      channelId: "990000000000000003",
    });
    forceRecheck("770500");
    await tickWith("770500", "broken", false);

    let sub = env.db.getTwitchChannel(env.communityId, "broken");
    assert.equal(offlineSends(env.channels.notify).length, 0);
    assert.equal(sub.is_live, 1, "transition re-armed for retry (#447 posture)");
    assert.match(sub.last_stream_id, /^off-stream-770500-/, "stream id preserved");
    assert.equal(sub.last_offline_stream_id, null, "watermark NOT recorded on failure");

    // Fix the route: the still-ended stream announces on the next tick.
    env.db.setTwitchChannelNotifyTargets(env.communityId, "770500", {
      channelId: IDS.channelCmds,
    });
    forceRecheck("770500");
    await tickWith("770500", "broken", false);

    assert.equal(offlineSends(env.channels.cmds).length, 1, "retried goodnight landed");
    sub = env.db.getTwitchChannel(env.communityId, "broken");
    assert.equal(sub.is_live, 0);
    assert.equal(
      sub.last_offline_stream_id,
      sub.last_stream_id,
      "the announced stream id became the watermark",
    );
  });

  it("/twitch offline: toggles persist, surface in /twitch list, and audit; misuse refuses", async () => {
    env.db.addTwitchChannel(env.communityId, "770600", "toggled", "Toggled", null);

    const on = await env.runCommand({
      commandName: "twitch",
      subcommand: "offline",
      admin: true,
      options: { channel: "toggled", enabled: true },
    });
    assertReplyContains(on, /goes offline/i);
    assertReplyContains(on, /ALREADY live/i, );
    assert.equal(
      env.db.getTwitchChannel(env.communityId, "770600").notify_offline,
      1,
    );

    const listed = await env.runCommand({
      commandName: "twitch",
      subcommand: "list",
      admin: true,
      options: {},
    });
    assertReplyContains(listed, /\(offline\)/);

    const auditTitles = env.channels.log.sent
      .map((p) => p?.embeds?.[0]?.toJSON?.()?.title || p?.embeds?.[0]?.title)
      .filter(Boolean);
    assert.ok(
      auditTitles.includes("Twitch go-offline announcements enabled"),
      JSON.stringify(auditTitles),
    );

    const off = await env.runCommand({
      commandName: "twitch",
      subcommand: "offline",
      admin: true,
      options: { channel: "toggled", enabled: false },
    });
    assertReplyContains(off, /Stopped announcing/i);
    assert.equal(
      env.db.getTwitchChannel(env.communityId, "770600").notify_offline,
      0,
    );

    const ghost = await env.runCommand({
      commandName: "twitch",
      subcommand: "offline",
      admin: true,
      options: { channel: "not-a-sub", enabled: true },
    });
    assertReplyContains(ghost, /No matching subscription/);

    const nonStaff = await env.runCommand({
      commandName: "twitch",
      subcommand: "offline",
      admin: false,
      user: env.users.memberUser,
      options: { channel: "toggled", enabled: true },
    });
    assertEphemeralReply(nonStaff, /permission/i);
  });
});

// ---------- per-guild go-live message templates (issue #178) ----------

/**
 * Per-guild custom template for the go-live CONTENT LINE (migration 061,
 * guild_settings.twitch_golive_template). Unset = the pre-#178 hardcoded
 * copy (byte-identical). The role mention composes BEFORE the rendered
 * template and never drops. Ticker arms drive the real runTwitchTick with
 * the Helix lookup mocked at the deps seam; command arms run the real
 * router/handler path.
 */
describe("integration: twitch go-live message templates (issue #178)", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let runTwitchTick;

  const TPL = {
    DEFAULT_GOLIVE_TEMPLATE:
      require("../../src/features/twitch/templates").DEFAULT_GOLIVE_TEMPLATE,
    MAX: require("../../src/features/twitch/templates").MAX_GOLIVE_TEMPLATE_LEN,
  };

  before(async () => {
    env = await createIntegrationEnv({ guildId: uniqueId("guild-twitch-tpl") });
    runTwitchTick = require("../../src/features/twitch/ticker").runTwitchTick;
    env.db.updateGuildSettings(env.communityId, {
      twitch_notification_channel_id: IDS.channelNotify,
      twitch_notify_role_id: null,
      audit_log_channel_id: IDS.channelLog,
      twitch_polling_interval_minutes: 1,
    });
    clearSends();
  });

  after(() => env?.cleanup());

  function clearSends() {
    for (const ch of Object.values(env.channels)) ch.sent.length = 0;
  }

  /** Config-change embed titles posted to the fake audit channel. */
  function auditTitles() {
    return env.channels.log.sent
      .map((p) => p?.embeds?.[0]?.toJSON?.()?.title || p?.embeds?.[0]?.title)
      .filter(Boolean);
  }

  /** Fresh subscription (never checked → eligible) at a numeric broadcaster id. */
  function addSub(broadcasterId, login) {
    env.db.addTwitchChannel(env.communityId, broadcasterId, login, `${login}Display`, "");
  }

  /** One real tick with the target broadcaster optionally live (custom shape ok). */
  async function tickWith(broadcasterId, login, streamOrNull) {
    const prevId = process.env.TWITCH_CLIENT_ID;
    const prevSecret = process.env.TWITCH_CLIENT_SECRET;
    process.env.TWITCH_CLIENT_ID = "test-id";
    process.env.TWITCH_CLIENT_SECRET = "test-secret";
    try {
      await runTwitchTick(fakeSupervisor(env.client), {
        resolveUser: async () => null,
        fetchStreams: async (ids) =>
          streamOrNull && ids.includes(broadcasterId)
            ? [{ ...streamOrNull, user_id: broadcasterId }]
            : [],
      });
    } finally {
      if (prevId != null) process.env.TWITCH_CLIENT_ID = prevId;
      else delete process.env.TWITCH_CLIENT_ID;
      if (prevSecret != null) process.env.TWITCH_CLIENT_SECRET = prevSecret;
      else delete process.env.TWITCH_CLIENT_SECRET;
    }
  }

  // ---------- storage (migration 061 + settings repo) ----------

  it("storage: twitch_golive_template round-trips — trim/blank→NULL, over-length keeps the prior value", () => {
    const before = env.db.getGuildSettings(env.communityId);
    assert.ok("twitch_golive_template" in before, "column exists after migration 061");
    assert.equal(before.twitch_golive_template, null, "NULL = built-in default");

    let s = env.db.updateGuildSettings(env.communityId, {
      twitch_golive_template: "  hi {streamer}  ",
    });
    assert.equal(s.twitch_golive_template, "hi {streamer}", "stored trimmed");

    s = env.db.updateGuildSettings(env.communityId, { twitch_golive_template: "   " });
    assert.equal(s.twitch_golive_template, null, "blank restores the default (NULL)");

    s = env.db.updateGuildSettings(env.communityId, {
      twitch_golive_template: "x".repeat(TPL.MAX + 1),
    });
    assert.equal(s.twitch_golive_template, null, "over-length rejected, prior value kept");

    env.db.updateGuildSettings(env.communityId, { twitch_golive_template: "keep me" });
    s = env.db.updateGuildSettings(env.communityId, {
      twitch_golive_template: "x".repeat(TPL.MAX + 1),
    });
    assert.equal(s.twitch_golive_template, "keep me", "prior value survives the refused write");

    s = env.db.updateGuildSettings(env.communityId, { twitch_golive_template: null });
    assert.equal(s.twitch_golive_template, null);
  });

  // ---------- /twitch template command surface ----------

  it("command surface: template carries an optional text (max-length capped) + clear toggle", () => {
    const { commands } = require("../../src/features/twitch/index.js");
    const cmd = commands[0].toJSON();
    const sub = cmd.options.find((o) => o.name === "template");
    assert.ok(sub, "template subcommand registered");
    const byName = Object.fromEntries(sub.options.map((o) => [o.name, o]));
    assert.equal(byName.text.type, 3); // string
    assert.equal(byName.text.required, false);
    assert.equal(byName.text.max_length, TPL.MAX); // Discord-side cap = handler's cap
    assert.match(byName.text.description, /\{streamer\}/);
    assert.match(byName.text.description, /\{uptime\}/);
    assert.equal(byName.clear.type, 5); // boolean
    assert.equal(byName.clear.required, false);
  });

  it("/twitch template (no args): shows the default template + placeholder help", async () => {
    const interaction = await env.runCommand({
      commandName: "twitch",
      subcommand: "template",
      admin: true,
      options: {},
    });
    assertReplyContains(interaction, /\*\*Current template:\*\* \*default\*/);
    assertReplyContains(interaction, new RegExp(
      TPL.DEFAULT_GOLIVE_TEMPLATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ));
    assertReplyContains(interaction, /\{streamer\} \{login\} \{title\} \{game\} \{url\} \{viewers\} \{uptime\}/);
    assertReplyContains(interaction, /clear:true/);
  });

  it("/twitch template text: saves trimmed, marks settings custom, and audits default→custom", async () => {
    const template = "🔴 {streamer} — {game} — {url}";
    const interaction = await env.runCommand({
      commandName: "twitch",
      subcommand: "template",
      admin: true,
      options: { text: `  ${template}  ` },
    });
    assertReplyContains(interaction, /\*\*Go-live template:\*\* saved/);
    assert.equal(
      env.db.getGuildSettings(env.communityId).twitch_golive_template,
      template,
      "trimmed on the way in",
    );

    const listed = await env.runCommand({
      commandName: "twitch",
      subcommand: "template",
      admin: true,
      options: {},
    });
    assertReplyContains(listed, /🔴 \{streamer\}/);

    const settings = await env.runCommand({
      commandName: "settwitch",
      subcommand: "settings",
      admin: true,
    });
    assertReplyContains(settings, /Go-live template: custom/);

    assert.ok(
      auditTitles().includes("Twitch go-live template updated"),
      JSON.stringify(auditTitles()),
    );
  });

  it("/twitch template: over-length is refused with the cause named (nothing stored)", async () => {
    const prior = env.db.getGuildSettings(env.communityId).twitch_golive_template;
    const interaction = await env.runCommand({
      commandName: "twitch",
      subcommand: "template",
      admin: true,
      options: { text: "x".repeat(TPL.MAX + 1) },
    });
    assertReplyContains(interaction, /Could not save the go-live template/);
    assertReplyContains(interaction, new RegExp(`${TPL.MAX + 1} characters`));
    assertReplyContains(interaction, /maximum is 2000/);
    assert.equal(
      env.db.getGuildSettings(env.communityId).twitch_golive_template,
      prior,
      "prior template survives the refused write",
    );
  });

  it("/twitch template: blank text restores the default; clear:true XORs text; set→XOR→clear keeps the record honest", async () => {
    const blanked = await env.runCommand({
      commandName: "twitch",
      subcommand: "template",
      admin: true,
      options: { text: "   " },
    });
    assertReplyContains(blanked, /reset to the default/i);
    assert.equal(env.db.getGuildSettings(env.communityId).twitch_golive_template, null);

    await env.runCommand({
      commandName: "twitch",
      subcommand: "template",
      admin: true,
      options: { text: "keep me" },
    });
    const xor = await env.runCommand({
      commandName: "twitch",
      subcommand: "template",
      admin: true,
      options: { text: "conflict", clear: true },
    });
    assertReplyContains(xor, /clear:true/);
    assertReplyContains(xor, /drop `text`/);
    assert.equal(env.db.getGuildSettings(env.communityId).twitch_golive_template, "keep me");

    const cleared = await env.runCommand({
      commandName: "twitch",
      subcommand: "template",
      admin: true,
      options: { clear: true },
    });
    assertReplyContains(cleared, /reset to the default/i);
    assert.equal(env.db.getGuildSettings(env.communityId).twitch_golive_template, null);
    assert.ok(
      auditTitles().includes("Twitch go-live template reset to default"),
      JSON.stringify(auditTitles()),
    );
  });

  it("non-staff invokers cannot touch the template", async () => {
    const interaction = await env.runCommand({
      commandName: "twitch",
      subcommand: "template",
      admin: false,
      user: env.users.memberUser,
      options: { text: "not allowed" },
    });
    assertEphemeralReply(interaction, /permission/i);
    assert.equal(env.db.getGuildSettings(env.communityId).twitch_golive_template, null);
  });

  // ---------- ticker content line ----------

  it("ticker: unset template emits the EXACT pre-#178 content (with and without the ping role)", async () => {
    env.db.updateGuildSettings(env.communityId, {
      twitch_golive_template: null,
      twitch_notify_role_id: null,
    });
    addSub("771100", "tpldef1");
    clearSends();
    await tickWith("771100", "tpldef1", {
      id: "tpl-stream-1",
      title: "Default copy",
      started_at: new Date().toISOString(),
    });
    let payload = exactlyOneSend(env.channels.notify.sent, "default go-live (no role)");
    assert.equal(payload.content, "**tpldef1Display** is live!", "byte-identical default");
    assertPingsNobody(payload, { label: "default go-live (no role)" });

    env.db.updateGuildSettings(env.communityId, { twitch_notify_role_id: IDS.roleExempt });
    addSub("771101", "tpldef2");
    clearSends();
    await tickWith("771101", "tpldef2", {
      id: "tpl-stream-2",
      title: "Default copy",
      started_at: new Date().toISOString(),
    });
    payload = exactlyOneSend(env.channels.notify.sent, "default go-live (role)");
    assert.equal(
      payload.content,
      `<@&${IDS.roleExempt}> **tpldef2Display** is live!`,
      "byte-identical default with the mention prefix",
    );
    assertPingsRoleOnly(payload, IDS.roleExempt, { label: "default go-live (role)" });
  });

  it("ticker: custom template renders every placeholder and composes after the role mention", async () => {
    env.db.updateGuildSettings(env.communityId, {
      twitch_golive_template: "🔴 {game}: {title} [{viewers}] {url}",
      twitch_notify_role_id: IDS.roleExempt,
    });
    addSub("771200", "tplcast");
    clearSends();
    await tickWith("771200", "tplcast", {
      id: "tpl-stream-3",
      game_name: "Chess",
      title: "Big Game",
      viewer_count: 42,
      started_at: new Date().toISOString(),
    });

    const payload = exactlyOneSend(env.channels.notify.sent, "custom-template go-live");
    assert.equal(
      payload.content,
      `<@&${IDS.roleExempt}> 🔴 Chess: Big Game [42] https://twitch.tv/tplcast`,
    );
    assertPingsRoleOnly(payload, IDS.roleExempt, {
      label: "custom-template go-live (rendered)",
    });
    assert.equal(payload.embeds.length, 1, "the embed is untouched by #178");
    assert.equal(payload.embeds[0].title, "Big Game");
  });

  it("ticker: missing stream fields fall back; unknown placeholders stay literal; never undefined/null", async () => {
    env.db.updateGuildSettings(env.communityId, {
      twitch_golive_template: "{streamer} {title} {game} {viewers} {uptime} {url} {nope}",
      twitch_notify_role_id: null,
    });
    addSub("771300", "tplsparse");
    clearSends();
    await tickWith("771300", "tplsparse", {
      id: "tpl-stream-4", // EventSub-minimal shape: no title/game/viewers/started_at
    });

    const payload = exactlyOneSend(env.channels.notify.sent, "sparse-stream go-live");
    assert.ok(payload.content.includes("Untitled stream"), payload.content);
    assert.ok(payload.content.includes("Unknown"), payload.content);
    assert.ok(payload.content.includes("just went live"), payload.content);
    assert.ok(payload.content.includes("https://twitch.tv/tplsparse"), payload.content);
    assert.ok(payload.content.includes("{nope}"), "unknown placeholder stays as typed");
    assert.ok(!/undefined|null/i.test(payload.content), payload.content);
  });

  it("ticker: a runaway render clamps to 2000 chars and keeps the role mention", async () => {
    env.db.updateGuildSettings(env.communityId, {
      twitch_golive_template: `${"a".repeat(1950)} {title} {url}`,
      twitch_notify_role_id: IDS.roleExempt,
    });
    addSub("771400", "tplclamp");
    clearSends();
    await tickWith("771400", "tplclamp", {
      id: "tpl-stream-5",
      title: "t".repeat(100), // Twitch's real title cap; embed limits stay respected
      started_at: new Date().toISOString(),
    });

    const payload = exactlyOneSend(env.channels.notify.sent, "clamped go-live");
    assert.ok(payload.content.length <= TPL.MAX, `content ${payload.content.length} > cap`);
    assert.ok(payload.content.startsWith(`<@&${IDS.roleExempt}> `), "mention never truncated away");
    assert.ok(payload.content.endsWith("…"), "truncation is visible");
  });
});
