const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertReplyContains,
  assertEphemeralReply,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

const SECRET = "eventsub-integration-secret-0123456789";

/** Minimal IncomingMessage stand-in (headers + drained rawBody bytes). */
function makeReq(messageType, payloadObj, { secret = SECRET, messageId = "msg-1", timestamp, signature } = {}) {
  const body = JSON.stringify(payloadObj);
  const ts = timestamp || new Date().toISOString();
  const sig =
    signature === undefined
      ? "sha256=" +
        crypto.createHmac("sha256", secret).update(messageId + ts + body).digest("hex")
      : signature;
  return {
    headers: {
      "twitch-eventsub-message-id": messageId,
      "twitch-eventsub-message-timestamp": ts,
      "twitch-eventsub-message-signature": sig,
      "twitch-eventsub-message-type": messageType,
    },
    rawBody: Buffer.from(body),
  };
}

function fakeRes() {
  const res = { statusCode: null, headers: null, body: null, headersSent: false };
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
    res.headersSent = true;
  };
  res.end = (body) => {
    res.body = body;
  };
  return res;
}

async function waitFor(cond, label, ms = 1500) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("integration: twitch-eventsub", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let handleTwitchEventsub;
  let verifyEventsubHmac;
  let getEventsubConfig;
  let subs;
  let ticker;
  const prevEnv = {};

  after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
    env?.cleanup();
  });

  before(async () => {
    env = await createIntegrationEnv();
    env.db.updateGuildSettings(env.guild.id, {
      twitch_notification_channel_id: IDS.channelNotify,
    });

    const callback = require("../../src/features/twitch/eventsub/callback");
    handleTwitchEventsub = callback.handleTwitchEventsub;
    verifyEventsubHmac = callback.verifyEventsubHmac;
    getEventsubConfig =
      require("../../src/features/twitch/eventsub/config").getEventsubConfig;
    subs = require("../../src/features/twitch/eventsub/subscriptions");
    ticker = require("../../src/features/twitch/ticker");

    for (const k of [
      "TWITCH_CLIENT_ID",
      "TWITCH_CLIENT_SECRET",
      "TWITCH_EVENTSUB_SECRET",
      "TWITCH_EVENTSUB_CALLBACK_URL",
      "TWITCH_EVENTSUB_MAX_CHANNELS",
      "PUBLIC_BASE_URL",
    ]) {
      prevEnv[k] = process.env[k];
    }
    process.env.TWITCH_CLIENT_ID = "cid";
    process.env.TWITCH_CLIENT_SECRET = "csec";
    process.env.TWITCH_EVENTSUB_SECRET = SECRET;
    process.env.PUBLIC_BASE_URL = "https://bot.example.com";
    delete process.env.TWITCH_EVENTSUB_CALLBACK_URL;
    delete process.env.TWITCH_EVENTSUB_MAX_CHANNELS;
  });

  it("config: enable matrix, callback derivation, cap", () => {
    const ok = getEventsubConfig();
    assert.equal(ok.enabled, true);
    assert.equal(ok.callbackUrl, "https://bot.example.com/hooks/twitch");
    assert.equal(ok.maxChannels, 50);

    process.env.TWITCH_EVENTSUB_CALLBACK_URL = "https://proxy.example.net/twitch-hook";
    assert.equal(
      getEventsubConfig().callbackUrl,
      "https://proxy.example.net/twitch-hook",
    );
    delete process.env.TWITCH_EVENTSUB_CALLBACK_URL;

    process.env.TWITCH_EVENTSUB_SECRET = "short";
    let cfg = getEventsubConfig();
    assert.equal(cfg.enabled, false);
    assert.ok(cfg.missing.some((m) => m.includes("10-100")));
    process.env.TWITCH_EVENTSUB_SECRET = SECRET;

    process.env.PUBLIC_BASE_URL = "http://insecure.example.com";
    cfg = getEventsubConfig();
    assert.equal(cfg.enabled, false);
    assert.ok(cfg.missing.some((m) => m.includes("HTTPS")));
    process.env.PUBLIC_BASE_URL = "https://bot.example.com";

    process.env.TWITCH_EVENTSUB_MAX_CHANNELS = "3";
    assert.equal(getEventsubConfig().maxChannels, 3);
    delete process.env.TWITCH_EVENTSUB_MAX_CHANNELS;

    delete process.env.TWITCH_CLIENT_ID;
    cfg = getEventsubConfig();
    assert.equal(cfg.enabled, false);
    assert.ok(cfg.missing.includes("TWITCH_CLIENT_ID"));
    process.env.TWITCH_CLIENT_ID = "cid";
  });

  it("repo: media flags toggle with watermark seed-once semantics", () => {
    env.db.addTwitchChannel(env.guild.id, "701000", "mediaflag", "MediaFlag", null);

    let row = env.db.setTwitchChannelMediaFlags(env.guild.id, "701000", {
      notifyClips: true,
      notifyVods: false,
    });
    assert.equal(row.notify_clips, 1);
    assert.equal(row.notify_vods, 0);
    assert.ok(row.last_clip_created_at > 0, "watermark seeded on enable");
    const seeded = row.last_clip_created_at;

    // Re-enable must NOT reset the watermark (no history wipe).
    row = env.db.setTwitchChannelMediaFlags(env.guild.id, "701000", {
      notifyClips: true,
      notifyVods: false,
    });
    assert.equal(row.last_clip_created_at, seeded);

    // Disable keeps the watermark for the next opt-in.
    row = env.db.setTwitchChannelMediaFlags(env.guild.id, "701000", {
      notifyClips: false,
      notifyVods: false,
    });
    assert.equal(row.notify_clips, 0);
    assert.equal(row.last_clip_created_at, seeded);

    assert.equal(
      env.db.setTwitchChannelMediaFlags(env.guild.id, "404040", { notifyClips: true }),
      null,
    );
  });

  it("repo: eventsub sub upsert/mark/delete + COALESCE id retention", () => {
    const row = env.db.upsertTwitchEventsubSub({
      type: "stream.online",
      broadcasterId: "702000",
      subscriptionId: "sub-a",
      status: "verification_pending",
    });
    assert.equal(row.status, "verification_pending");

    // Failed retry without an id must keep the old subscription_id.
    env.db.upsertTwitchEventsubSub({
      type: "stream.online",
      broadcasterId: "702000",
      subscriptionId: null,
      status: "error",
      lastError: "HTTP 503",
    });
    let stored = env.db.getTwitchEventsubSub("stream.online", "702000");
    assert.equal(stored.subscription_id, "sub-a");
    assert.equal(stored.status, "error");

    assert.ok(env.db.markTwitchEventsubSubStatus("stream.online", "702000", "enabled"));
    stored = env.db.getTwitchEventsubSub("stream.online", "702000");
    assert.equal(stored.status, "enabled");

    assert.equal(env.db.isValidEventsubType("stream.offline"), true);
    assert.equal(env.db.isValidEventsubType("channel.follow"), false);
    assert.equal(
      env.db.upsertTwitchEventsubSub({ type: "channel.follow", broadcasterId: "1" }),
      null,
    );

    assert.equal(env.db.deleteTwitchEventsubSub("stream.online", "702000"), true);
    assert.equal(env.db.getTwitchEventsubSub("stream.online", "702000"), null);
  });

  it("HMAC: valid passes, tamper/stale/missing fail closed", () => {
    const messageId = "m1";
    const timestamp = new Date().toISOString();
    const rawBody = Buffer.from('{"challenge":"x"}');
    const signature =
      "sha256=" +
      crypto.createHmac("sha256", SECRET).update(messageId + timestamp + rawBody.toString()).digest("hex");

    const base = { secret: SECRET, messageId, timestamp, rawBody, signature };
    assert.equal(verifyEventsubHmac(base), true);
    assert.equal(verifyEventsubHmac({ ...base, rawBody: Buffer.from('{"challenge":"y"}') }), false);
    assert.equal(
      verifyEventsubHmac({ ...base, signature: "sha256=" + "0".repeat(64) }),
      false,
    );
    assert.equal(verifyEventsubHmac({ ...base, signature: signature.slice(7) }), false);
    assert.equal(
      verifyEventsubHmac({
        ...base,
        timestamp: new Date(Date.now() - 11 * 60_000).toISOString(),
      }),
      false,
    );
    assert.equal(verifyEventsubHmac({ ...base, messageId: "" }), false);
    assert.equal(verifyEventsubHmac({ ...base, secret: null }), false);
  });

  it("handler: 404 disabled, 403 bad sig, 200 challenge, 400 bad JSON", async () => {
    const disabled = { getConfig: () => ({ enabled: false, missing: ["everything"] }) };
    let res = fakeRes();
    await handleTwitchEventsub(makeReq("notification", {}), res, disabled);
    assert.equal(res.statusCode, 404);

    const badSig = fakeRes();
    await handleTwitchEventsub(
      makeReq("webhook_callback_verification", { challenge: "c" }, { signature: "sha256=deadbeef" }),
      badSig,
      {},
    );
    assert.equal(badSig.statusCode, 403);

    const chal = fakeRes();
    await handleTwitchEventsub(
      makeReq("webhook_callback_verification", { challenge: "challenge-token-42" }),
      chal,
      {},
    );
    assert.equal(chal.statusCode, 200);
    assert.equal(chal.body, "challenge-token-42");
    assert.match(chal.headers["Content-Type"], /text\/plain/);

    // Valid signature over non-JSON body → 400
    const body = "not json";
    const messageId = "m2";
    const timestamp = new Date().toISOString();
    const res400 = fakeRes();
    await handleTwitchEventsub(
      {
        headers: {
          "twitch-eventsub-message-id": messageId,
          "twitch-eventsub-message-timestamp": timestamp,
          "twitch-eventsub-message-signature":
            "sha256=" +
            crypto.createHmac("sha256", SECRET).update(messageId + timestamp + body).digest("hex"),
          "twitch-eventsub-message-type": "webhook_callback_verification",
        },
        rawBody: Buffer.from(body),
      },
      res400,
      {},
    );
    assert.equal(res400.statusCode, 400);
  });

  it("E2E: stream.online notification announces once, dedups redelivery + poller", async () => {
    env.db.addTwitchChannel(env.guild.id, "7770001", "fastguy", "FastGuy", null);
    env.channels.notify.sent.length = 0;

    const stream = {
      id: "stream-abc",
      user_id: "7770001",
      title: "Speedrunning",
      game_name: "Games",
      viewer_count: 10,
      thumbnail_url: "https://static-cdn.jtvnw.net/b/7770001/{width}x{height}.jpg",
      started_at: new Date().toISOString(),
    };
    const payload = {
      subscription: { id: "sub-fg", type: "stream.online", condition: { broadcaster_user_id: "7770001" } },
      event: {
        id: "stream-abc",
        broadcaster_user_id: "7770001",
        broadcaster_user_login: "fastguy",
        type: "live",
        started_at: stream.started_at,
      },
    };

    const req1 = makeReq("notification", payload);
    const res1 = fakeRes();
    await handleTwitchEventsub(req1, res1, {
      getClient: () => env.client,
      fetchStreams: async () => [stream],
    });
    assert.equal(res1.statusCode, 204);
    await waitFor(() => env.channels.notify.sent.length >= 1, "go-live announce");
    const sent = env.channels.notify.sent[0];
    assert.match(sent.content, /FastGuy/);
    assert.equal(sent.embeds[0].data.title, "Speedrunning");
    let row = env.db.getTwitchChannel(env.guild.id, "fastguy");
    assert.equal(row.is_live, 1);
    assert.equal(row.last_stream_id, "stream-abc");

    // Twitch redelivery (same message id/body) must not double-announce.
    const res2 = fakeRes();
    await handleTwitchEventsub(makeReq("notification", payload), res2, {
      getClient: () => env.client,
      fetchStreams: async () => [stream],
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(env.channels.notify.sent.length, 1, "redelivery deduped by claim");

    // The polling ticker must also stay silent for the claimed stream id.
    await ticker.processSubscription(env.client, env.guild.id, row, stream);
    assert.equal(env.channels.notify.sent.length, 1, "poller deduped by claim");

    // Offline notification flips state back (204 first, then state).
    const offlinePayload = {
      subscription: { id: "sub-fg", type: "stream.offline", condition: { broadcaster_user_id: "7770001" } },
      event: { broadcaster_user_id: "7770001" },
    };
    const res3 = fakeRes();
    await handleTwitchEventsub(makeReq("notification", offlinePayload), res3, {
      getClient: () => env.client,
    });
    assert.equal(res3.statusCode, 204);
    await waitFor(
      () => env.db.getTwitchChannel(env.guild.id, "fastguy").is_live === 0,
      "offline state",
    );
  });

  it("E2E: unknown broadcaster notification is a no-op (204)", async () => {
    env.channels.notify.sent.length = 0;
    const res = fakeRes();
    await handleTwitchEventsub(
      makeReq("notification", {
        subscription: { type: "stream.online", condition: { broadcaster_user_id: "404404" } },
        event: { id: "s1", broadcaster_user_id: "404404", started_at: new Date().toISOString() },
      }),
      res,
      { getClient: () => env.client, fetchStreams: async () => [] },
    );
    assert.equal(res.statusCode, 204);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(env.channels.notify.sent.length, 0);
  });

  it("handler: revocation marks status / user_removed deletes", async () => {
    env.db.upsertTwitchEventsubSub({
      type: "stream.online",
      broadcasterId: "7770002",
      subscriptionId: "sub-rev",
      status: "enabled",
    });
    let res = fakeRes();
    await handleTwitchEventsub(
      makeReq("revocation", {
        subscription: {
          type: "stream.online",
          condition: { broadcaster_user_id: "7770002" },
          status: "authorization_revoked",
        },
      }),
      res,
      {},
    );
    assert.equal(res.statusCode, 204);
    assert.equal(
      env.db.getTwitchEventsubSub("stream.online", "7770002").status,
      "revoked:authorization_revoked",
    );

    res = fakeRes();
    await handleTwitchEventsub(
      makeReq("revocation", {
        subscription: {
          type: "stream.online",
          condition: { broadcaster_user_id: "7770002" },
          status: "user_removed",
        },
      }),
      res,
      {},
    );
    assert.equal(env.db.getTwitchEventsubSub("stream.online", "7770002"), null);
  });

  it("reconciler: creates, idempotent, prunes orphans, honors cap", async () => {
    const cfg = {
      enabled: true,
      secret: SECRET,
      callbackUrl: "https://bot.example.com/hooks/twitch",
      maxChannels: 50,
      missing: [],
    };
    const createdReqs = [];
    const deletedIds = [];
    const fakeCreate = async (req) => {
      createdReqs.push(req);
      return {
        ok: true,
        status: 202,
        subscription: {
          id: `sub-${req.type}-${req.condition.broadcaster_user_id}`,
          status: "webhook_callback_verification_pending",
        },
      };
    };
    const fakeDelete = async (id) => {
      deletedIds.push(id);
      return { ok: true, status: 204 };
    };
    const deps = {
      getConfig: () => cfg,
      createEventsubSubscription: fakeCreate,
      deleteEventsubSubscription: fakeDelete,
      listEventsubSubscriptions: async () => [],
    };

    // 1) Fresh broadcaster → both types created + locally tracked.
    env.db.addTwitchChannel(env.guild.id, "8880001", "recguy", "RecGuy", null);
    const r1 = await subs.ensureBroadcasterSubs("8880001", cfg, deps);
    assert.deepEqual([r1.created, r1.failed], [2, 0]);
    assert.equal(createdReqs.length, 2);
    const on = env.db.getTwitchEventsubSub("stream.online", "8880001");
    assert.equal(on.subscription_id, "sub-stream.online-8880001");
    assert.equal(on.status, "verification_pending");

    // 2) Idempotent: healthy verification_pending rows are left alone.
    const r2 = await subs.ensureBroadcasterSubs("8880001", cfg, deps);
    assert.deepEqual([r2.created, r2.failed], [0, 0]);

    // 3) Orphan local sub (broadcaster not tracked by any guild) is pruned.
    env.db.upsertTwitchEventsubSub({
      type: "stream.offline",
      broadcasterId: "9990001",
      subscriptionId: "orphan-sub",
      status: "enabled",
    });
    const summary = await subs.reconcileEventsubSubscriptions(deps);
    assert.equal(summary.error, undefined);
    assert.ok(deletedIds.includes("orphan-sub"));
    assert.equal(env.db.getTwitchEventsubSub("stream.offline", "9990001"), null);

    // 4) Cap: only the first maxChannels broadcasters get subs.
    env.db.addTwitchChannel(env.guild.id, "8880002", "overcap", "OverCap", null);
    createdReqs.length = 0;
    const capped = await subs.reconcileEventsubSubscriptions({
      ...deps,
      getConfig: () => ({ ...cfg, maxChannels: 1 }),
    });
    assert.equal(capped.tracked >= 2, true);
    assert.equal(capped.wanted, 1);
    assert.equal(createdReqs.length, 0, "already-subscribed first broadcaster only");
    // Over-cap broadcaster's locals (none here) stay pruned = quota freed.
    assert.equal(env.db.getTwitchEventsubSub("stream.online", "8880002"), null);

    // 5) pruneBroadcasterIfUntracked respects still-tracked rows.
    const skip = await subs.pruneBroadcasterIfUntracked("8880001", deps);
    assert.equal(skip.skipped, "still-tracked");
    env.db.removeTwitchChannel(env.guild.id, "recguy");
    const pruned = await subs.pruneBroadcasterIfUntracked("8880001", deps);
    assert.equal(pruned.pruned, true);
    assert.equal(env.db.getTwitchEventsubSub("stream.online", "8880001"), null);
  });

  it("reconciler: create failure keeps subscription id for later prune", async () => {
    const cfg = {
      enabled: true,
      secret: SECRET,
      callbackUrl: "https://bot.example.com/hooks/twitch",
      maxChannels: 50,
      missing: [],
    };
    env.db.upsertTwitchEventsubSub({
      type: "stream.online",
      broadcasterId: "8880009",
      subscriptionId: "keepme",
      status: "error",
      lastError: "earlier transient",
    });
    const r = await subs.ensureBroadcasterSubs("8880009", cfg, {
      createEventsubSubscription: async ({ type }) =>
        type === "stream.online"
          ? { ok: false, status: 503, error: "upstream 503" }
          : { ok: true, status: 202, subscription: { id: "new-sub", status: "webhook_callback_verification_pending" } },
    });
    assert.deepEqual([r.created, r.failed], [1, 1]);
    const row = env.db.getTwitchEventsubSub("stream.online", "8880009");
    assert.equal(row.status, "error");
    assert.equal(row.subscription_id, "keepme");
  });

  it("clips poller: seeds silently, announces once, caps flood", async () => {
    const { processNewClips } = ticker;
    env.db.addTwitchChannel(env.guild.id, "703000", "clipper", "Clipper", null);
    env.db.setTwitchChannelMediaFlags(env.guild.id, "703000", {
      notifyClips: true,
      notifyVods: false,
    });

    // Null watermark (direct update bypassed seeding) → seed only, no send.
    env.db.updateTwitchChannelClipState(env.guild.id, "703000", {
      lastClipId: null,
      lastClipCreatedAt: null,
    });
    env.channels.notify.sent.length = 0;
    let sub = env.db.getTwitchChannel(env.guild.id, "clipper");
    await processNewClips(env.client, sub, {
      fetchClips: async () => {
        throw new Error("must not fetch when watermark is null");
      },
    });
    sub = env.db.getTwitchChannel(env.guild.id, "clipper");
    assert.ok(sub.last_clip_created_at > 0);
    assert.equal(env.channels.notify.sent.length, 0);

    const wm = sub.last_clip_created_at;
    const iso = (ms) => new Date(ms).toISOString();
    const clips = [
      { id: "old", url: "https://twitch.tv/c/old", title: "Old", created_at: iso(wm - 1000) },
      { id: "c1", url: "https://twitch.tv/c/c1", title: "First fresh", created_at: iso(wm + 1000), duration: 30 },
      { id: "c2", url: "https://twitch.tv/c/c2", title: "Second fresh", created_at: iso(wm + 2000) },
    ];
    await processNewClips(env.client, sub, { fetchClips: async () => clips });
    assert.equal(env.channels.notify.sent.length, 2);
    assert.match(env.channels.notify.sent[0].content, /Clipper/);
    assert.equal(env.channels.notify.sent[0].embeds[0].data.title, "First fresh");
    sub = env.db.getTwitchChannel(env.guild.id, "clipper");
    assert.equal(sub.last_clip_id, "c2");
    assert.equal(sub.last_clip_created_at, wm + 2000);

    // Redelivered same clips → nothing new (view-ordered response is fine).
    await processNewClips(env.client, sub, { fetchClips: async () => [...clips].reverse() });
    assert.equal(env.channels.notify.sent.length, 2);

    // Flood cap: 7 fresh → 5 announced, watermark jumps past all 7.
    const many = Array.from({ length: 7 }, (_, i) => ({
      id: `bulk-${i}`,
      url: `https://twitch.tv/c/bulk-${i}`,
      title: `Bulk ${i}`,
      created_at: iso(sub.last_clip_created_at + (i + 1) * 1000),
    }));
    env.channels.notify.sent.length = 0;
    await processNewClips(env.client, sub, { fetchClips: async () => many });
    assert.equal(env.channels.notify.sent.length, 5);
    sub = env.db.getTwitchChannel(env.guild.id, "clipper");
    assert.equal(sub.last_clip_id, "bulk-6");

    // Unknown fetch state (null) → no crash, no state change.
    const before = sub.last_clip_created_at;
    await processNewClips(env.client, sub, { fetchClips: async () => null });
    assert.equal(env.db.getTwitchChannel(env.guild.id, "clipper").last_clip_created_at, before);
    assert.equal(env.channels.notify.sent.length, 5);
  });

  it("vods poller: archives-only announce with created_at watermark", async () => {
    const { processNewVods } = ticker;
    env.db.addTwitchChannel(env.guild.id, "704000", "vodder", "Vodder", null);
    env.db.setTwitchChannelMediaFlags(env.guild.id, "704000", {
      notifyClips: false,
      notifyVods: true,
    });
    env.channels.notify.sent.length = 0;
    let sub = env.db.getTwitchChannel(env.guild.id, "vodder");
    assert.ok(sub.last_video_created_at > 0, "seeded on enable");

    const wm = sub.last_video_created_at;
    const iso = (ms) => new Date(ms).toISOString();
    const videos = [
      { id: "vnew", title: "Marathon", created_at: iso(wm + 5000), duration: "PT2H15M", view_count: 7 },
      { id: "vold", title: "Ancient", created_at: iso(wm - 5000) },
    ];
    await processNewVods(env.client, sub, { fetchArchives: async () => videos });
    assert.equal(env.channels.notify.sent.length, 1);
    const embed = env.channels.notify.sent[0].embeds[0].data;
    assert.equal(embed.title, "Marathon");
    assert.ok(
      embed.fields.some((f) => f.name === "Length" && f.value === "2h 15m"),
      "ISO duration formatted",
    );
    sub = env.db.getTwitchChannel(env.guild.id, "vodder");
    assert.equal(sub.last_video_id, "vnew");

    // Same videos again → silent.
    await processNewVods(env.client, sub, { fetchArchives: async () => videos });
    assert.equal(env.channels.notify.sent.length, 1);

    // Media notifications never ping the notify role.
    env.db.updateGuildSettings(env.guild.id, { twitch_notify_role_id: IDS.roleExempt });
    await processNewVods(env.client, sub, {
      fetchArchives: async () => [{ id: "v2", title: "Newest", created_at: iso(wm + 99999) }],
    });
    const last = env.channels.notify.sent[env.channels.notify.sent.length - 1];
    assert.deepEqual(last.allowedMentions, { parse: [] });
    env.db.updateGuildSettings(env.guild.id, { twitch_notify_role_id: null });
  });

  it("runTwitchTick: media pollers only run for opted-in subscriptions", async () => {
    env.db.addTwitchChannel(env.guild.id, "705000", "plainsub", "PlainSub", null);
    const polledClips = [];
    const polledVods = [];
    await ticker.runTwitchTick(env.client, {
      fetchStreams: async () => [],
      fetchClips: async (broadcasterId) => {
        polledClips.push(broadcasterId);
        return [];
      },
      fetchArchives: async (broadcasterId) => {
        polledVods.push(broadcasterId);
        return [];
      },
    });
    assert.ok(!polledClips.includes("705000"), "plain sub never media-polled");
    assert.ok(!polledVods.includes("705000"), "plain sub never media-polled");
    assert.ok(polledClips.includes("703000"), "clip-opted sub polls clips");
    assert.ok(polledVods.includes("704000"), "vod-opted sub polls vods");
    assert.ok(!polledVods.includes("703000"), "clip-only sub does not poll vods");
  });

  it("/twitch clips + /twitch vod toggle flags, list shows them, member denied", async () => {
    env.db.addTwitchChannel(env.guild.id, "706000", "flagman", "FlagMan", null);

    const denied = await env.runCommand({
      commandName: "twitch",
      subcommand: "clips",
      admin: false,
      options: { channel: "flagman", enabled: true },
    });
    assertEphemeralReply(denied, /staff|permission|manage/i);

    const on = await env.runCommand({
      commandName: "twitch",
      subcommand: "clips",
      admin: true,
      options: { channel: "flagman", enabled: true },
    });
    assertReplyContains(on, /announce new \*\*clips\*\*/);
    let row = env.db.getTwitchChannel(env.guild.id, "flagman");
    assert.equal(row.notify_clips, 1);
    assert.ok(row.last_clip_created_at > 0);

    const vod = await env.runCommand({
      commandName: "twitch",
      subcommand: "vod",
      admin: true,
      options: { channel: "FLAGMAN", enabled: true },
    });
    assertReplyContains(vod, /announce new \*\*VODs\*\*/);
    row = env.db.getTwitchChannel(env.guild.id, "flagman");
    assert.equal(row.notify_vods, 1);

    const list = await env.runCommand({ commandName: "twitch", subcommand: "list", admin: true });
    assertReplyContains(list, /FlagMan/);

    const off = await env.runCommand({
      commandName: "twitch",
      subcommand: "clips",
      admin: true,
      options: { channel: "flagman", enabled: false },
    });
    assertReplyContains(off, /Stopped announcing/);
    assert.equal(env.db.getTwitchChannel(env.guild.id, "flagman").notify_clips, 0);

    const missing = await env.runCommand({
      commandName: "twitch",
      subcommand: "clips",
      admin: true,
      options: { channel: "nosuchchan", enabled: true },
    });
    assertEphemeralReply(missing, /No matching subscription/);
  });
});
