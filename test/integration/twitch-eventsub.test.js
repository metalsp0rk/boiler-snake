const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertReplyContains,
  assertEphemeralReply,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

const SECRET = "eventsub-integration-secret-0123456789";

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

let reqSeq = 0;

/** Minimal IncomingMessage stand-in (headers + drained rawBody bytes).
 *  #836: message ids DEFAULT unique per delivery — that is Twitch's real
 *  contract (and what the B1-7 replay nonce keys on). Tests that want the
 *  SAME id (a replay) say so explicitly; tests that exercise the CLAIM-level
 *  dedup must NOT collide with the nonce on an incidental shared id. */
function makeReq(messageType, payloadObj, { secret = SECRET, messageId = `msg-${++reqSeq}`, timestamp, signature } = {}) {
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
    env.db.updateGuildSettings(env.communityId, {
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

  // #836 (B1-7): the replay nonce store is module state; makeReq defaults
  // to ONE message id across tests — without this reset every later
  // notification would dedup against an earlier test's delivery.
  beforeEach(() => {
    require("../../src/features/twitch/eventsub/callback")._resetSeenMessageIdsForTests();
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
    env.db.addTwitchChannel(env.communityId, "701000", "mediaflag", "MediaFlag", null);

    let row = env.db.setTwitchChannelMediaFlags(env.communityId, "701000", {
      notifyClips: true,
      notifyVods: false,
    });
    assert.equal(row.notify_clips, 1);
    assert.equal(row.notify_vods, 0);
    assert.ok(row.last_clip_created_at > 0, "watermark seeded on enable");
    const seeded = row.last_clip_created_at;

    // Re-enable must NOT reset the watermark (no history wipe).
    row = env.db.setTwitchChannelMediaFlags(env.communityId, "701000", {
      notifyClips: true,
      notifyVods: false,
    });
    assert.equal(row.last_clip_created_at, seeded);

    // Disable keeps the watermark for the next opt-in.
    row = env.db.setTwitchChannelMediaFlags(env.communityId, "701000", {
      notifyClips: false,
      notifyVods: false,
    });
    assert.equal(row.notify_clips, 0);
    assert.equal(row.last_clip_created_at, seeded);

    assert.equal(
      env.db.setTwitchChannelMediaFlags(env.communityId, "404040", { notifyClips: true }),
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

  it("#824 repo: the binding columns are recorded and COALESCE-survive status-only upserts", () => {
    const fp = subs.eventsubSecretFingerprint("secret-one");
    const row = env.db.upsertTwitchEventsubSub({
      type: "stream.offline",
      broadcasterId: "702001",
      subscriptionId: "sub-b",
      status: "verification_pending",
      callbackUrl: "https://old.example.com/hooks/twitch",
      secretFingerprint: fp,
    });
    assert.equal(row.callback_url, "https://old.example.com/hooks/twitch");
    assert.equal(row.secret_fingerprint, fp);

    // A status-only refresh (revocation marks, retry flips) must NOT erase
    // the proof — the rotation check needs the binding to outlive it.
    env.db.markTwitchEventsubSubStatus("stream.offline", "702001", "enabled");
    let stored = env.db.getTwitchEventsubSub("stream.offline", "702001");
    assert.equal(stored.secret_fingerprint, fp);
    assert.equal(stored.callback_url, "https://old.example.com/hooks/twitch");

    env.db.upsertTwitchEventsubSub({
      type: "stream.offline",
      broadcasterId: "702001",
      status: "enabled",
    });
    stored = env.db.getTwitchEventsubSub("stream.offline", "702001");
    assert.equal(stored.secret_fingerprint, fp, "omitted binding rides the COALESCE");

    // A rotated create DOES replace it.
    const fp2 = subs.eventsubSecretFingerprint("secret-two");
    env.db.upsertTwitchEventsubSub({
      type: "stream.offline",
      broadcasterId: "702001",
      status: "enabled",
      callbackUrl: "https://new.example.com/hooks/twitch",
      secretFingerprint: fp2,
    });
    stored = env.db.getTwitchEventsubSub("stream.offline", "702001");
    assert.equal(stored.secret_fingerprint, fp2);
    assert.notEqual(fp, fp2, "the fingerprint is a hash of the secret, never the secret");
    assert.ok(!stored.secret_fingerprint.includes("secret"));
  });

  it("#824 needsCreate/subBindingIsStale: an unproven or superseded binding is never trusted", () => {
    const cfg = {
      secret: "secret-live",
      callbackUrl: "https://bot.example.com/hooks/twitch",
    };
    const fpLive = subs.eventsubSecretFingerprint("secret-live");
    assert.match(fpLive, /^[0-9a-f]{64}$/, "sha256 hex — the secret itself is never stored");

    const fresh = {
      status: "enabled",
      subscription_id: "s",
      callback_url: cfg.callbackUrl,
      secret_fingerprint: fpLive,
    };
    assert.equal(subs.needsCreate(fresh, cfg), false, "a proven binding stays alone");

    assert.equal(subs.needsCreate({ ...fresh, secret_fingerprint: "ff" }, cfg), true, "rotated secret");
    assert.equal(
      subs.needsCreate({ ...fresh, callback_url: "https://elsewhere.example/hook" }, cfg),
      true,
      "moved callback",
    );
    assert.equal(
      subs.needsCreate({ status: "enabled", subscription_id: "s" }, cfg),
      true,
      "pre-#824 row: NO recorded binding = UNPROVEN = recreate once, proof lands",
    );
    assert.equal(
      subs.needsCreate({ ...fresh, status: "verification_pending" }, cfg),
      false,
      "in-flight + proven stays alone",
    );
    assert.equal(
      subs.needsCreate({ ...fresh, status: "pending" }, cfg),
      false,
      "pending WITH an id and a proven binding waits",
    );
    assert.equal(
      subs.needsCreate({ status: "pending", subscription_id: "s" }, cfg),
      true,
      "pending + stale binding rebinds even with an id",
    );
    assert.equal(subs.needsCreate({ status: "error", subscription_id: "s" }, cfg), true);
    assert.equal(subs.needsCreate(fresh, { secret: null, callbackUrl: null }), false,
      "an incomplete config judges nothing (it never reaches the reconciler)");
    assert.equal(subs.needsCreate(null, cfg), true, "no row, no mercy");
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

  it("#836 B1-7: a signed replay of the SAME message id never re-processes; challenge retries are exempt", async () => {
    let dispatched = 0;
    const deps = {
      onNotification: async () => {
        dispatched += 1;
      },
    };
    const settle = async () => {
      for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
    };

    const body = { subscription: { id: "sub-x" }, event: { broadcaster_user_id: "7770091" } };

    // First delivery: processed.
    const req = makeReq("notification", body, { messageId: "replay-1" });
    const r1 = fakeRes();
    await handleTwitchEventsub(req, r1, deps);
    assert.equal(r1.statusCode, 204);
    await settle();
    assert.equal(dispatched, 1);

    // BYTE-IDENTICAL replay inside the age window (valid HMAC — the
    // signature proves the sender, not freshness): ACKED, never dispatched.
    const r2 = fakeRes();
    await handleTwitchEventsub(makeReq("notification", body, { messageId: "replay-1" }), r2, deps);
    assert.equal(r2.statusCode, 204, "a replay is silently ACKED (204), not 4xx — Twitch stops retrying");
    await settle();
    assert.equal(dispatched, 1, "the replay never reaches dispatch");

    // A DIFFERENT message id processes normally (the store is per-id).
    await handleTwitchEventsub(makeReq("notification", body, { messageId: "replay-2" }), fakeRes(), deps);
    await settle();
    assert.equal(dispatched, 2, "next id rides free");

    // CHALLENGE RETRY exemption: the same id must answer the challenge
    // EVERY time — Twitch retries when the first response is lost, and a
    // deduped 204 there strands the subscription verification.
    for (const attempt of [1, 2]) {
      const chal = fakeRes();
      await handleTwitchEventsub(
        makeReq("webhook_callback_verification", { challenge: "retry-me" }, { messageId: "chal-dup" }),
        chal,
        deps,
      );
      assert.equal(chal.statusCode, 200, `challenge attempt ${attempt} re-answers`);
      assert.equal(chal.body, "retry-me");
    }

    // 403s never poison the store: a bad-signature delivery of an id the
    // attacker invented must not block the REAL delivery of that id later.
    const poisoned = makeReq("notification", body, { messageId: "poison-1", signature: "sha256=nope" });
    const rp = fakeRes();
    await handleTwitchEventsub(poisoned, rp, deps);
    assert.equal(rp.statusCode, 403);
    await handleTwitchEventsub(makeReq("notification", body, { messageId: "poison-1" }), fakeRes(), deps);
    await settle();
    assert.equal(dispatched, 3, "the legitimate delivery of the same id still processes");
  });

  it("E2E: stream.online notification announces once, dedups redelivery + poller", async () => {
    env.db.addTwitchChannel(env.communityId, "7770001", "fastguy", "FastGuy", null);
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
    // PR 7: tickers post plain NormalizedEmbed JSON (no EmbedBuilder wrapper).
    assert.equal(sent.embeds[0].title, "Speedrunning");
    let row = env.db.getTwitchChannel(env.communityId, "fastguy");
    assert.equal(row.is_live, 1);
    assert.equal(row.last_stream_id, "stream-abc");

    // Twitch redelivery (same body, FRESH message id — the shape that
    // survives a bot restart, when the #836 in-memory nonce store is
    // empty) must not double-announce: the CLAIM ledger is the deep layer.
    const res2 = fakeRes();
    await handleTwitchEventsub(makeReq("notification", payload, { messageId: "e2e-redelivery" }), res2, {
      getClient: () => env.client,
      fetchStreams: async () => [stream],
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(env.channels.notify.sent.length, 1, "redelivery deduped by claim");

    // The polling ticker must also stay silent for the claimed stream id.
    await ticker.processSubscription(fakeSupervisor(env.client), env.communityId, row, stream);
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
      () => env.db.getTwitchChannel(env.communityId, "fastguy").is_live === 0,
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
    env.db.addTwitchChannel(env.communityId, "8880001", "recguy", "RecGuy", null);
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
    env.db.addTwitchChannel(env.communityId, "8880002", "overcap", "OverCap", null);
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
    env.db.removeTwitchChannel(env.communityId, "recguy");
    const pruned = await subs.pruneBroadcasterIfUntracked("8880001", deps);
    assert.equal(pruned.pruned, true);
    assert.equal(env.db.getTwitchEventsubSub("stream.online", "8880001"), null);
  });

  it("#824 reconciler: a rotated secret/URL rebinds (delete-old → create-new → binding recorded)", async () => {
    const cfgA = {
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
          id: `sub-${req.type}-${req.condition.broadcaster_user_id}-gen${createdReqs.length}`,
          status: "webhook_callback_verification_pending",
        },
      };
    };
    const fakeDelete = async (id) => {
      deletedIds.push(id);
      return { ok: true, status: 204 };
    };
    const deps = {
      createEventsubSubscription: fakeCreate,
      deleteEventsubSubscription: fakeDelete,
      listEventsubSubscriptions: async () => [],
    };

    env.db.addTwitchChannel(env.communityId, "777001", "rotguy", "RotGuy", null);
    try {
      // 1) First sweep binds the rows with WHAT THEY WERE CREATED WITH.
      await subs.ensureBroadcasterSubs("777001", cfgA, deps);
      assert.equal(createdReqs.length, 2);
      const onA = env.db.getTwitchEventsubSub("stream.online", "777001");
      assert.equal(onA.secret_fingerprint, subs.eventsubSecretFingerprint(SECRET));
      assert.equal(onA.callback_url, cfgA.callbackUrl);

      // 2) Same config, same binding → NOTHING happens (idempotence intact).
      createdReqs.length = 0;
      const again = await subs.ensureBroadcasterSubs("777001", cfgA, deps);
      assert.deepEqual([again.created, again.failed], [0, 0], "a proven binding is left alone");
      assert.equal(createdReqs.length, 0);

      // 3) ROTATION (secret AND URL): the healthy-looking rows are stale.
      //    The old Twitch subs are DELETEd first (quota + the 409 law),
      //    fresh ones are created with the new secret/callback, and the
      //    rows carry the NEW proof.
      const cfgB = {
        ...cfgA,
        secret: "rotated-secret-0123456789-abcd",
        callbackUrl: "https://newbase.example.com/hooks/twitch",
      };
      createdReqs.length = 0;
      deletedIds.length = 0;
      const rebound = await subs.ensureBroadcasterSubs("777001", cfgB, deps);
      assert.deepEqual([rebound.created, rebound.failed], [2, 0]);
      assert.equal(deletedIds.length, 2, "both dead old subs were dropped first");
      assert.ok(deletedIds.includes(onA.subscription_id));
      assert.deepEqual(
        createdReqs.map((r) => r.secret),
        [cfgB.secret, cfgB.secret],
        "creates ride the NEW secret",
      );
      const onB = env.db.getTwitchEventsubSub("stream.online", "777001");
      assert.equal(onB.secret_fingerprint, subs.eventsubSecretFingerprint(cfgB.secret));
      assert.equal(onB.callback_url, cfgB.callbackUrl);

      // 4) URL-only rotation rebinds too (same secret).
      createdReqs.length = 0;
      deletedIds.length = 0;
      await subs.ensureBroadcasterSubs("777001", {
        ...cfgB,
        callbackUrl: "https://moved.example.com/hook",
      }, deps);
      assert.equal(createdReqs.length, 2, "callback-only rotation is still rotation");
      assert.equal(deletedIds.length, 2);

      // 5) A PRE-#824 row (no recorded binding) is UNPROVEN: one rebind,
      //    then the proof lands and the churn stops. Built by DELETE +
      //    INSERT (the COALESCE upsert cannot erase a binding — by design).
      //    cfgC = step 4's live state, so ONLY the legacy row is stale.
      const cfgC = { ...cfgB, callbackUrl: "https://moved.example.com/hook" };
      env.db.deleteTwitchEventsubSub("stream.offline", "777001");
      env.db.upsertTwitchEventsubSub({
        type: "stream.offline",
        broadcasterId: "777001",
        subscriptionId: "legacy-sub",
        status: "enabled",
      });
      createdReqs.length = 0;
      deletedIds.length = 0;
      await subs.ensureBroadcasterSubs("777001", cfgC, deps);
      assert.deepEqual(deletedIds, ["legacy-sub"], "only the unproven row rebinds");
      assert.equal(createdReqs.length, 1);
      assert.equal(createdReqs[0].type, "stream.offline");
      const legacyRebound = env.db.getTwitchEventsubSub("stream.offline", "777001");
      assert.equal(legacyRebound.secret_fingerprint, subs.eventsubSecretFingerprint(cfgC.secret));
      createdReqs.length = 0;
      await subs.ensureBroadcasterSubs("777001", cfgC, deps);
      assert.equal(createdReqs.length, 0, "and now the row is proven — no repeated churn");
    } finally {
      env.db.removeTwitchChannel(env.communityId, "rotguy");
      env.db.deleteTwitchEventsubSub("stream.online", "777001");
      env.db.deleteTwitchEventsubSub("stream.offline", "777001");
    }
  });

  it("#824 self-heal now pulls Twitch's revoked/notification-failure views too", async () => {
    // Tracked broadcasters with PROVEN bindings: ensure skips them (no
    // create), prune leaves them alone, and the widened self-heal list is
    // all that touches their status this sweep.
    env.db.addTwitchChannel(env.communityId, "666001", "heal1", "Heal1", null);
    env.db.addTwitchChannel(env.communityId, "666002", "heal2", "Heal2", null);
    env.db.upsertTwitchEventsubSub({
      type: "stream.online",
      broadcasterId: "666001",
      subscriptionId: "nf-sub",
      status: "enabled",
      callbackUrl: "https://bot.example.com/hooks/twitch",
      secretFingerprint: subs.eventsubSecretFingerprint(SECRET),
    });
    env.db.upsertTwitchEventsubSub({
      type: "stream.offline",
      broadcasterId: "666002",
      subscriptionId: "rev-sub",
      status: "enabled",
      callbackUrl: "https://bot.example.com/hooks/twitch",
      secretFingerprint: subs.eventsubSecretFingerprint(SECRET),
    });

    const listed = [];
    const deps = {
      getConfig: () => ({
        enabled: true,
        secret: SECRET,
        callbackUrl: "https://bot.example.com/hooks/twitch",
        maxChannels: 50,
        missing: [],
      }),
      createEventsubSubscription: async () => {
        throw new Error("ensure must NOT create: the bindings are proven");
      },
      deleteEventsubSubscription: async (id) => {
        // Belt: prune must not run for tracked broadcasters.
        throw new Error(`unexpected delete of ${id}`);
      },
      listEventsubSubscriptions: async ({ status }) => {
        listed.push(status);
        if (status === "notification_failures_exceeded") {
          return [{ type: "stream.online", condition: { broadcaster_user_id: "666001" } }];
        }
        if (status === "revoked") {
          return [{ type: "stream.offline", condition: { broadcaster_user_id: "666002" } }];
        }
        return [];
      },
    };

    let summary;
    let nf;
    let rev;
    try {
      summary = await subs.reconcileEventsubSubscriptions(deps);
      nf = env.db.getTwitchEventsubSub("stream.online", "666001");
      rev = env.db.getTwitchEventsubSub("stream.offline", "666002");
    } finally {
      env.db.deleteTwitchEventsubSub("stream.online", "666001");
      env.db.deleteTwitchEventsubSub("stream.offline", "666002");
      env.db.removeTwitchChannel(env.communityId, "heal1");
      env.db.removeTwitchChannel(env.communityId, "heal2");
    }
    assert.equal(summary.error, undefined);
    assert.equal(summary.created, 0, "proven bindings rode ensure untouched");
    assert.deepEqual(listed, [
      "webhook_callback_verification_failed",
      "notification_failures_exceeded",
      "revoked",
    ], "all three of Twitch's failure vocabularies are pulled each sweep");

    assert.equal(nf.status, "notification_failures_exceeded");
    assert.match(nf.last_error, /twitch status/);
    assert.equal(rev.status, "revoked");
    // Either way the rows now NEED a create — the stranding is over even
    // before the fingerprint rule gets a turn.
    assert.equal(subs.needsCreate(nf, null), true);
    assert.equal(subs.needsCreate(rev, null), true);
  });

  it("#824 one failing self-heal list does not blind the others", async () => {
    env.db.addTwitchChannel(env.communityId, "666003", "heal3", "Heal3", null);
    env.db.upsertTwitchEventsubSub({
      type: "stream.online",
      broadcasterId: "666003",
      subscriptionId: "ok-sub",
      status: "enabled",
      callbackUrl: "https://bot.example.com/hooks/twitch",
      secretFingerprint: subs.eventsubSecretFingerprint(SECRET),
    });
    const cap = [];
    const realErr = console.error;
    console.error = (...a) => cap.push(a.map(String).join(" "));
    let summary;
    try {
      summary = await subs.reconcileEventsubSubscriptions({
        getConfig: () => ({
          enabled: true,
          secret: SECRET,
          callbackUrl: "https://bot.example.com/hooks/twitch",
          maxChannels: 50,
          missing: [],
        }),
        createEventsubSubscription: async () => {
          throw new Error("ensure must NOT create here");
        },
        deleteEventsubSubscription: async (id) => {
          throw new Error(`unexpected delete of ${id}`);
        },
        listEventsubSubscriptions: async ({ status }) => {
          if (status === "revoked") throw new Error("helix 503");
          return [];
        },
      });
    } finally {
      console.error = realErr;
      env.db.deleteTwitchEventsubSub("stream.online", "666003");
      env.db.removeTwitchChannel(env.communityId, "heal3");
    }
    assert.equal(summary.error, undefined, "a partial list is not a failed sweep");
    assert.ok(
      cap.some((l) => l.includes("EventSub revoked sweep failed") && l.includes("helix 503")),
      `the one blind spot is named: ${cap.join(" | ")}`,
    );
  });

  it("clips poller: seeds silently, announces once, caps flood", async () => {
    const { processNewClips } = ticker;
    env.db.addTwitchChannel(env.communityId, "703000", "clipper", "Clipper", null);
    env.db.setTwitchChannelMediaFlags(env.communityId, "703000", {
      notifyClips: true,
      notifyVods: false,
    });

    // Null watermark (direct update bypassed seeding) → seed only, no send.
    env.db.updateTwitchChannelClipState(env.communityId, "703000", {
      lastClipId: null,
      lastClipCreatedAt: null,
    });
    env.channels.notify.sent.length = 0;
    let sub = env.db.getTwitchChannel(env.communityId, "clipper");
    await processNewClips(fakeSupervisor(env.client), sub, {
      fetchClips: async () => {
        throw new Error("must not fetch when watermark is null");
      },
    });
    sub = env.db.getTwitchChannel(env.communityId, "clipper");
    assert.ok(sub.last_clip_created_at > 0);
    assert.equal(env.channels.notify.sent.length, 0);

    const wm = sub.last_clip_created_at;
    const iso = (ms) => new Date(ms).toISOString();
    const clips = [
      { id: "old", url: "https://twitch.tv/c/old", title: "Old", created_at: iso(wm - 1000) },
      { id: "c1", url: "https://twitch.tv/c/c1", title: "First fresh", created_at: iso(wm + 1000), duration: 30 },
      { id: "c2", url: "https://twitch.tv/c/c2", title: "Second fresh", created_at: iso(wm + 2000) },
    ];
    await processNewClips(fakeSupervisor(env.client), sub, { fetchClips: async () => clips });
    assert.equal(env.channels.notify.sent.length, 2);
    assert.match(env.channels.notify.sent[0].content, /Clipper/);
    // PR 7: plain NormalizedEmbed JSON at the send boundary.
    assert.equal(env.channels.notify.sent[0].embeds[0].title, "First fresh");
    sub = env.db.getTwitchChannel(env.communityId, "clipper");
    assert.equal(sub.last_clip_id, "c2");
    assert.equal(sub.last_clip_created_at, wm + 2000);

    // Redelivered same clips → nothing new (view-ordered response is fine).
    await processNewClips(fakeSupervisor(env.client), sub, { fetchClips: async () => [...clips].reverse() });
    assert.equal(env.channels.notify.sent.length, 2);

    // Flood cap: 7 fresh → 5 announced, watermark jumps past all 7.
    const many = Array.from({ length: 7 }, (_, i) => ({
      id: `bulk-${i}`,
      url: `https://twitch.tv/c/bulk-${i}`,
      title: `Bulk ${i}`,
      created_at: iso(sub.last_clip_created_at + (i + 1) * 1000),
    }));
    env.channels.notify.sent.length = 0;
    await processNewClips(fakeSupervisor(env.client), sub, { fetchClips: async () => many });
    assert.equal(env.channels.notify.sent.length, 5);
    sub = env.db.getTwitchChannel(env.communityId, "clipper");
    assert.equal(sub.last_clip_id, "bulk-6");

    // Unknown fetch state (null) → no crash, no state change.
    const before = sub.last_clip_created_at;
    await processNewClips(fakeSupervisor(env.client), sub, { fetchClips: async () => null });
    assert.equal(env.db.getTwitchChannel(env.communityId, "clipper").last_clip_created_at, before);
    assert.equal(env.channels.notify.sent.length, 5);
  });

  it("vods poller: archives-only announce with created_at watermark", async () => {
    const { processNewVods } = ticker;
    env.db.addTwitchChannel(env.communityId, "704000", "vodder", "Vodder", null);
    env.db.setTwitchChannelMediaFlags(env.communityId, "704000", {
      notifyClips: false,
      notifyVods: true,
    });
    env.channels.notify.sent.length = 0;
    let sub = env.db.getTwitchChannel(env.communityId, "vodder");
    assert.ok(sub.last_video_created_at > 0, "seeded on enable");

    const wm = sub.last_video_created_at;
    const iso = (ms) => new Date(ms).toISOString();
    const videos = [
      { id: "vnew", title: "Marathon", created_at: iso(wm + 5000), duration: "PT2H15M", view_count: 7 },
      { id: "vold", title: "Ancient", created_at: iso(wm - 5000) },
    ];
    await processNewVods(fakeSupervisor(env.client), sub, { fetchArchives: async () => videos });
    assert.equal(env.channels.notify.sent.length, 1);
    // PR 7: plain NormalizedEmbed JSON at the send boundary.
    const embed = env.channels.notify.sent[0].embeds[0];
    assert.equal(embed.title, "Marathon");
    assert.ok(
      embed.fields.some((f) => f.name === "Length" && f.value === "2h 15m"),
      "ISO duration formatted",
    );
    sub = env.db.getTwitchChannel(env.communityId, "vodder");
    assert.equal(sub.last_video_id, "vnew");

    // Same videos again → silent.
    await processNewVods(fakeSupervisor(env.client), sub, { fetchArchives: async () => videos });
    assert.equal(env.channels.notify.sent.length, 1);

    // Media notifications never ping the notify role.
    env.db.updateGuildSettings(env.communityId, { twitch_notify_role_id: IDS.roleExempt });
    await processNewVods(fakeSupervisor(env.client), sub, {
      fetchArchives: async () => [{ id: "v2", title: "Newest", created_at: iso(wm + 99999) }],
    });
    const last = env.channels.notify.sent[env.channels.notify.sent.length - 1];
    assert.deepEqual(last.allowedMentions, { parse: [] });
    env.db.updateGuildSettings(env.communityId, { twitch_notify_role_id: null });
  });

  it("runTwitchTick: media pollers only run for opted-in subscriptions", async () => {
    env.db.addTwitchChannel(env.communityId, "705000", "plainsub", "PlainSub", null);
    const polledClips = [];
    const polledVods = [];
    await ticker.runTwitchTick(fakeSupervisor(env.client), {
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
    env.db.addTwitchChannel(env.communityId, "706000", "flagman", "FlagMan", null);

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
    let row = env.db.getTwitchChannel(env.communityId, "flagman");
    assert.equal(row.notify_clips, 1);
    assert.ok(row.last_clip_created_at > 0);

    const vod = await env.runCommand({
      commandName: "twitch",
      subcommand: "vod",
      admin: true,
      options: { channel: "FLAGMAN", enabled: true },
    });
    assertReplyContains(vod, /announce new \*\*VODs\*\*/);
    row = env.db.getTwitchChannel(env.communityId, "flagman");
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
    assert.equal(env.db.getTwitchChannel(env.communityId, "flagman").notify_clips, 0);

    const missing = await env.runCommand({
      commandName: "twitch",
      subcommand: "clips",
      admin: true,
      options: { channel: "nosuchchan", enabled: true },
    });
    assertEphemeralReply(missing, /No matching subscription/);
  });

  it("reconciler: one broadcaster's throwing create does not stop the sweep (#198)", async () => {
    const cfg = {
      enabled: true,
      secret: SECRET,
      callbackUrl: "https://bot.example.com/hooks/twitch",
      maxChannels: 50,
      missing: [],
    };
    env.db.addTwitchChannel(env.communityId, "8880011", "boomguy", "BoomGuy", null);
    env.db.addTwitchChannel(env.communityId, "8880012", "fineguy", "FineGuy", null);

    const errors = [];
    const origErr = console.error;
    console.error = (...a) => errors.push(a.map(String).join(" "));
    let summary;
    try {
      summary = await subs.reconcileEventsubSubscriptions({
        getConfig: () => cfg,
        createEventsubSubscription: async (req) => {
          if (req.condition.broadcaster_user_id === "8880011") {
            throw new Error("simulated Helix create outage");
          }
          return {
            ok: true,
            status: 202,
            subscription: {
              id: `sub-${req.type}-${req.condition.broadcaster_user_id}`,
              status: "webhook_callback_verification_pending",
            },
          };
        },
        deleteEventsubSubscription: async () => ({ ok: true, status: 204 }),
        listEventsubSubscriptions: async () => [],
      });
    } finally {
      console.error = origErr;
    }

    // The sweep finished (no outer error) and counted the throw as a failure.
    assert.equal(summary.error, undefined);
    assert.ok(summary.failed >= 1, `expected a counted failure: ${JSON.stringify(summary)}`);

    // The healthy broadcaster still got BOTH subs…
    for (const type of subs.SUB_TYPES) {
      assert.equal(
        env.db.getTwitchEventsubSub(type, "8880012")?.subscription_id,
        `sub-${type}-8880012`,
        `${type} sub missing for the healthy broadcaster`,
      );
    }
    // …the throwing one left no local row, and ran once (loop moved on).
    assert.equal(env.db.getTwitchEventsubSub("stream.online", "8880011"), null);

    const lines = errors.filter((l) =>
      l.includes("EventSub reconcile failed"),
    );
    assert.equal(
      lines.length,
      1,
      `expected one reconcile error, got: ${errors.join(" | ")}`,
    );
    assert.ok(lines[0].includes("8880011"), `broadcaster id missing in: ${lines[0]}`);
    assert.ok(
      lines[0].includes("simulated Helix create outage"),
      `cause missing in: ${lines[0]}`,
    );
  });

  // -------------------------------------------------------------------------
  // #477 (INT-13): a failed prune delete must NOT drop the local row — the
  // row (subscription_id included) is the only record of the Twitch-side
  // sub; dropping it orphaned the sub forever (quota bleed + no later
  // sweep could find the id). Failure keeps the row prune_pending and the
  // hourly sweep retries.
  // -------------------------------------------------------------------------

  it("#477 failed prune delete keeps the row as prune_pending for retry", async () => {
    const cfg = {
      enabled: true,
      secret: SECRET,
      callbackUrl: "https://bot.example.com/hooks/twitch",
      maxChannels: 50,
      missing: [],
    };
    // Untracked broadcaster with a live-looking sub.
    env.db.upsertTwitchEventsubSub({
      type: "stream.online",
      broadcasterId: "8880077",
      subscriptionId: "quota-bleed-sub",
      status: "enabled",
    });
    const deleteResults = [
      { ok: false, status: 0 }, // network blip — must NOT swallow the id
      { ok: true, status: 204 }, // next sweep succeeds
    ];
    const attempted = [];
    const deps = {
      getConfig: () => cfg,
      createEventsubSubscription: async () => ({ ok: true, subscription: { id: "x", status: "verification_pending" } }),
      deleteEventsubSubscription: async (id) => {
        attempted.push(id);
        return deleteResults.shift();
      },
      listEventsubSubscriptions: async () => [],
    };

    // Sweep 1: prune hits the delete failure.
    await subs.reconcileEventsubSubscriptions(deps);
    const kept = env.db.getTwitchEventsubSub("stream.online", "8880077");
    assert.ok(kept, "#477: the local row SURVIVES a failed remote delete");
    assert.equal(kept.subscription_id, "quota-bleed-sub", "the id needed to retry is intact");
    assert.equal(kept.status, "prune_pending", "the row names its retry state");
    assert.match(kept.last_error, /delete failed/);

    // Sweep 2: the SAME sweep pass picks the untracked prune_pending row up
    // again (no status filter on the prune scan) and the successful delete
    // finally untracks it.
    await subs.reconcileEventsubSubscriptions(deps);
    assert.equal(
      env.db.getTwitchEventsubSub("stream.online", "8880077"),
      null,
      "successful retry untracks — quota returned",
    );
    assert.deepEqual(attempted, ["quota-bleed-sub", "quota-bleed-sub"], "delete retried once per sweep");
  });

  it("#477 successful prune deletes rows as before (behavior pin)", async () => {
    env.db.upsertTwitchEventsubSub({
      type: "stream.offline",
      broadcasterId: "8880078",
      subscriptionId: "clean-sub",
      status: "enabled",
    });
    const cfg = {
      enabled: true,
      secret: SECRET,
      callbackUrl: "https://bot.example.com/hooks/twitch",
      maxChannels: 50,
      missing: [],
    };
    await subs.pruneBroadcasterIfUntracked("8880078", {
      getConfig: () => cfg,
      deleteEventsubSubscription: async () => ({ ok: true, status: 204, gone: undefined }),
    });
    assert.equal(env.db.getTwitchEventsubSub("stream.offline", "8880078"), null);
  });
});
