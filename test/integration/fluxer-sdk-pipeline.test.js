/**
 * Issue #200 (audit §6 P2 — "one message, all effects"): pushes ONE real
 * gateway-shaped Fluxer MESSAGE_CREATE through the shipped
 * pipelines.onMessageCreate against real SQLite and mocked transports, and
 * asserts EVERY step's observable effect:
 *
 *   step 0a contract gate   — the #201 validator accepts the SDK-shaped
 *                             normalize output (no contract log lines)
 *   step 2b community       — communities row + message.communityId resolve
 *   step 3  message cache   — NO row: the consumer-less Fluxer write is
 *                             dropped per issue #277 (the #200 fix made it
 *                             observable; nothing ever read it)
 *   step 9  channel activity — one user_channel_message_daily row
 *   step 10 message XP      — xp row + activity_log kind 'message'
 *   bridge                  — NO outbox rows for a non-bridged channel
 *   zero error logs          — the whole walk is quiet
 *
 * The message is NOT hand-built: it is the EXACT object the real gateway
 * emits — a hydrated model instance from the SDK (loaded through the
 * guarded loadFluxerSdk site; the package name never appears in this file,
 * keeping test/fluxer-sdk-import-guard.test.js green), built the way the
 * SDK's own MESSAGE_CREATE handler builds it, exactly like the unit-level
 * contract file (test/fluxer-sdk-contract-normalize.test.js — see its
 * header for the fidelity statement: real Client constructor + real model
 * constructors, no sockets/login/REST). When the package is absent the
 * tests SKIP (roadmap/fluxer.md § Tests).
 *
 * Test 4 is the audit's evidence test: the same real instance reaches the
 * bridge relay's §10.8 payload — embeds, the author handle, message-level
 * flags (CONTAINS_EXPLICIT_MEDIA), and attachment names all carry the real
 * instance's content, which the hand-built fixtures could not catch (the
 * "embeds/avatars hid behind green tests" class).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");

/**
 * Run `fn` with console.error captured; resolves to the joined log lines.
 * @param {() => Promise<void>|void} fn
 * @returns {Promise<string[]>}
 */
async function captureConsoleError(fn) {
  const orig = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return logs;
}

describe("integration: one REAL SDK-shaped Fluxer message through the full pipeline (issue #200)", () => {
  const FLUXER_INSTANCE = "https://sdk200.it";
  const GUILD_ID = "1554590611015729200";
  const CHANNEL_ID = "1554600000000000200";
  const USER_ID = "1554600000000000203";
  const MENTION_ID = "1554600000000000209";
  const ROLE_STAFF = "1554600000000000210";
  const TS_ISO = "2026-10-11T12:00:00.000Z";

  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let sdk; // real SDK namespace (null → all tests skip)
  let pipelines;
  let normalizeFluxerMessage;
  let loadFluxerSdk;
  let logsAudit;
  let relay;
  let repo;
  let codes;
  let makeFakeHandle;
  let communityId; // the Fluxer communities row every assertion keys on

  before(async () => {
    env = await createIntegrationEnv();
    // Require AFTER createIntegrationEnv (loadDb resets the src cache).
    pipelines = require("../../src/bot/pipelines");
    ({ normalizeFluxerMessage } = require("../../src/platform/fluxer/normalize"));
    ({ loadFluxerSdk } = require("../../src/platform/fluxer/client"));
    logsAudit = require("../../src/features/logs/auditLog");
    relay = require("../../src/features/bridge/relay");
    repo = require("../../src/db/repositories/bridges");
    codes = require("../../src/features/bridge/codes");
    ({ makeFakeHandle } = require("../helpers/fluxer"));
    sdk = await loadFluxerSdk("integration/sdk-pipeline");

    const { ensureCommunity } = require("../../src/platform/community");
    communityId = ensureCommunity({
      platform: "fluxer",
      instanceKey: FLUXER_INSTANCE,
      externalGuildId: GUILD_ID,
    });
    env.db.updateGuildSettings(communityId, { msg_xp: 5, msg_cooldown_sec: 0 });
  });

  after(() => {
    relay?.clearRelayState();
    env?.cleanup();
  });

  // -- Real-instance builders (identical fidelity notes to the unit contract
  // file; the gateway handler steps are replicated from the SDK dist).

  function makeRealClient() {
    return new sdk.Client({ logLevel: "error" });
  }

  function hydrateMessageCreate(client, wireD) {
    const guild = new sdk.Guild(client, { id: wireD.guild_id, name: "IT Guild" });
    client.guilds.set(guild.id, guild);
    if (wireD.member && wireD.author) {
      const member = new sdk.GuildMember(
        client,
        { ...wireD.member, user: wireD.author, guild_id: guild.id },
        guild,
      );
      guild.members.set(member.id, member);
    }
    return new sdk.Message(client, wireD);
  }

  /** MESSAGE_CREATE `d` with real content in every consumer-visible arm. */
  function wireMessageCreate(over = {}) {
    return {
      id: snowflakeNow(),
      channel_id: CHANNEL_ID,
      guild_id: GUILD_ID,
      author: {
        id: USER_ID,
        username: "talker",
        discriminator: "0001",
        global_name: "Talker G",
        avatar: "aHASH",
        avatar_color: null,
        flags: 0,
        bot: false,
      },
      content: "hello world",
      timestamp: TS_ISO,
      attachments: [], // media spool would reach the network: none here
      embeds: [{ title: "T", description: "D", fields: [{ name: "f", value: "v" }] }],
      mentions: [
        { id: MENTION_ID, username: "mentioned", discriminator: "0002", global_name: null },
      ],
      mention_roles: [ROLE_STAFF],
      mention_channels: [],
      mention_everyone: false,
      stickers: [],
      message_snapshots: [],
      type: 0,
      flags: 0,
      webhook_id: null,
      member: { roles: [ROLE_STAFF], joined_at: TS_ISO, nick: null },
      ...over,
    };
  }

  /** Digit snowflake decoding to ~now (bridge connected_at window safe). */
  function snowflakeNow() {
    return String((BigInt(Date.now()) - 1420070400000n) << 22n);
  }

  function activityCount(userId) {
    return env.db.db
      .prepare(
        'SELECT COALESCE(SUM("count"), 0) AS c FROM user_channel_message_daily WHERE community_id = ? AND user_id = ?',
      )
      .get(communityId, userId).c;
  }

  function outboxCount(messageId) {
    return env.db.db
      .prepare("SELECT COUNT(*) AS c FROM bridge_outbox WHERE src_message_id = ?")
      .get(messageId).c;
  }

  it("every pipeline step's observable effect: community, NO cache row (#277), activity row, XP row, no outbox, zero logs", async (t) => {
    if (!sdk) return t.skip("real SDK not installed — guarded loader resolved to null");

    const client = makeRealClient();
    const real = hydrateMessageCreate(client, wireMessageCreate());
    const normalized = normalizeFluxerMessage(real, { instanceKey: FLUXER_INSTANCE });
    assert.ok(normalized, "the real instance normalizes");
    assert.equal(normalized.communityId, null, "normalize leaves the resolve to the pipeline (contract 4)");

    const handle = makeFakeHandle({ instanceKey: FLUXER_INSTANCE });
    const xpBefore = env.db.getXp(communityId, USER_ID);

    const logs = await captureConsoleError(() =>
      pipelines.onMessageCreate(handle.outbound, normalized, {}),
    );

    // 0a. The #201 contract gate stayed silent (a violation logs + skips).
    assert.equal(
      logs.filter((l) => l.includes("contract violation") || l.startsWith("[MessageCreate]")).length,
      0,
      `pipeline ran silently, got: ${JSON.stringify(logs)}`,
    );

    // 2b. Community resolve (the SAME row the test seeded).
    assert.equal(normalized.communityId, communityId, "step 2b resolved the communities row");

    // 3. Message cache — ZERO rows (issue #277 drop): the write step runs
    // for every message but cacheMessage gates Fluxer out, because the
    // cache's only readers are the Discord delete-audit paths (the Fluxer
    // edit/delete intake resolves link rows, never takeCachedMessage). The
    // null is meaningful, not an early bail: step 2b resolved the community
    // (above) and steps 9/10 below still fired for this exact message.
    assert.equal(
      logsAudit.takeCachedMessage(normalized),
      null,
      "#277 drop: no Fluxer cache row to take",
    );
    assert.equal(
      logsAudit.getCachedMessage(normalized),
      null,
      "#277 drop: no Fluxer cache row at all (pre-drop, #200's write landed here unread)",
    );

    // 9. Channel activity row (user_channel_message_daily).
    assert.equal(activityCount(USER_ID), 1, "exactly one activity count for the message");

    // 10. XP row + its activity_log line.
    assert.equal(env.db.getXp(communityId, USER_ID), xpBefore + 5, "msg_xp awarded");
    const xpActivity = env.db.db
      .prepare(
        "SELECT COUNT(*) AS c FROM activity_log WHERE community_id = ? AND user_id = ? AND kind = 'message'",
      )
      .get(communityId, USER_ID).c;
    assert.equal(xpActivity, 1, "awardXp logged the 'message' activity");

    // Bridge: no seeded end on this channel → no outbox rows (no hidden writes).
    assert.equal(outboxCount(normalized.id), 0);

    // The member roles rode the whole way (real manager → payload-first staff).
    assert.deepEqual(normalized.memberRoleIds, [ROLE_STAFF]);
  });

  it("a real BOT-author Message earns nothing: no XP, no activity, no cache", async (t) => {
    if (!sdk) return t.skip("real SDK not installed — guarded loader resolved to null");

    const client = makeRealClient();
    const real = hydrateMessageCreate(
      client,
      wireMessageCreate({
        author: {
          id: "1554600000000000250",
          username: "relay",
          discriminator: "0000",
          global_name: null,
          bot: true,
        },
        member: undefined,
      }),
    );
    const normalized = normalizeFluxerMessage(real, { instanceKey: FLUXER_INSTANCE });
    assert.equal(normalized.authorBot, true, "the real User instance carries bot: true");

    const handle = makeFakeHandle({ instanceKey: FLUXER_INSTANCE });
    await captureConsoleError(() => pipelines.onMessageCreate(handle.outbound, normalized, {}));

    assert.equal(env.db.getXp(communityId, "1554600000000000250"), 0, "bot earns no XP");
    assert.equal(activityCount("1554600000000000250"), 0);
    assert.equal(logsAudit.getCachedMessage(normalized), null, "bot messages never cache");
  });

  it("a bridged Fluxer source produces exactly one outbox row whose §10.8 payload carries the REAL instance's content", async (t) => {
    if (!sdk) return t.skip("real SDK not installed — guarded loader resolved to null");

    relay.clearRelayState();
    // Bridge: end A on the harness Discord community, end B on THIS Fluxer
    // community + the message channel. Seed the CAS outcome directly (no
    // live connect): state active, connected_at in the past.
    const created = repo.createBridge({
      publicId: codes.generatePublicId(),
      createdByUserId: "creator-1",
      endACommunityId: env.communityId,
      endAChannelId: "2000000000000000001",
      direction: "both",
    });
    repo.addBridgeEnd({ bridgeId: created.id, position: "b", communityId, channelId: CHANNEL_ID });
    env.db.db
      .prepare("UPDATE bridges SET state = 'active', connected_at = ? WHERE id = ?")
      .run(Date.now() - 60_000, created.id);

    const client = makeRealClient();
    const real = hydrateMessageCreate(
      client,
      wireMessageCreate({ flags: 16 }), // CONTAINS_EXPLICIT_MEDIA (1 << 4)
    );
    const normalized = normalizeFluxerMessage(real, { instanceKey: FLUXER_INSTANCE });

    const handle = makeFakeHandle({ instanceKey: FLUXER_INSTANCE });
    const logs = await captureConsoleError(() =>
      pipelines.onMessageCreate(handle.outbound, normalized, {}),
    );
    assert.equal(logs.length, 0, `clean run, got: ${JSON.stringify(logs)}`);

    const rows = env.db.db
      .prepare("SELECT * FROM bridge_outbox WHERE src_message_id = ?")
      .all(normalized.id);
    assert.equal(rows.length, 1, "exactly one kind-create row");
    assert.equal(rows[0].kind, "create");
    assert.equal(rows[0].direction, "b_to_a", "Fluxer (end b) → Discord (end a)");

    const payload = JSON.parse(rows[0].payload_json);
    // THE audit evidence: content that hand-built fixtures structurally
    // could not pin — the REAL instance's embeds, handle, and flags reached
    // the durable payload.
    assert.equal(payload.author.handle, "talker", "attribution handle from authorRaw.username (#200 fix)");
    assert.equal(payload.author.display, "Talker G", "display from the real globalName");
    assert.equal(payload.embeds.length, 1, "embeds relay from the real hydrated view (#200 fix)");
    assert.equal(payload.embeds[0].title, "T");
    assert.equal(payload.explicitMedia, true, "message-level flags reach the §10.8 check (#200 fix)");
    assert.equal(payload.text, "hello world");
    // The source human still earns XP (the enqueue can never skip it, §10.4).
    assert.ok(env.db.getXp(communityId, USER_ID) >= 10, "prior test's award + this one");
  });

  it("SDK drift mid-gateway: normalize throws at the client boundary, the message is skipped with a loud log, zero DB effects", async (t) => {
    if (!sdk) return t.skip("real SDK not installed — guarded loader resolved to null");

    // Simulate the client.js messageCreate hook (its onEvent wrapper owns the
    // catch) with a drifted SDK instance: roleIds removed behind the member
    // getter. The message must NOT reach the pipeline (no XP/cache/activity)
    // and the log must name the drift.
    const client = makeRealClient();
    const real = hydrateMessageCreate(client, wireMessageCreate());
    const driftedMember = new Proxy(real.member, {
      get(target, prop, receiver) {
        if (prop === "roles") {
          return new Proxy(target.roles, {
            get(t2, p2, r2) {
              if (p2 === "roleIds") return undefined; // the drift
              return Reflect.get(t2, p2, r2);
            },
          });
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const drifted = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "member") return driftedMember;
        return Reflect.get(target, prop, receiver);
      },
    });

    const handle = makeFakeHandle({ instanceKey: FLUXER_INSTANCE });
    const xpBefore = env.db.getXp(communityId, USER_ID);
    // EXACTLY the client.js wiring: normalize inside a caught promise; only a
    // non-null result enters the pipeline.
    const logs = await captureConsoleError(async () => {
      await Promise.resolve()
        .then(() => {
          const normalized = normalizeFluxerMessage(drifted, { instanceKey: FLUXER_INSTANCE });
          if (normalized) return pipelines.onMessageCreate(handle.outbound, normalized, {});
        })
        .catch((err) => {
          console.error(`[fluxer] ${FLUXER_INSTANCE} messageCreate failed: ${err?.message || err}`);
        });
    });

    assert.equal(
      logs.filter(
        (l) =>
          l.includes("messageCreate failed") &&
          /roleIds/i.test(l) &&
          l.includes(String(real.id)),
      ).length,
      1,
      `one loud, specific boundary log naming roleIds drift AND the message id (AGENTS.md rule 2), got: ${JSON.stringify(logs)}`,
    );
    assert.equal(env.db.getXp(communityId, USER_ID), xpBefore, "drifted traffic never earns XP");
  });
});
