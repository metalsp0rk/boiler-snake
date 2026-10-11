const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const { assertXp, assertBanned, assertNotBanned } = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

/**
 * Run `fn` with console.error captured; resolves to the joined log lines.
 * (Same swap-and-restore pattern as feature-load.test.js, async-aware.)
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

describe("integration: message pipeline", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;

  after(() => {
    // Close SQLite handles and remove the temp dir created for this env.
    env?.cleanup();
  });

  before(async () => {
    env = await createIntegrationEnv();
    // predictable XP + no cooldown for isolation
    env.db.updateGuildSettings(env.communityId, {
      msg_xp: 5,
      msg_cooldown_sec: 0,
    });
  });

  it("ignores bot authors", async () => {
    const before = env.db.getXp(env.communityId, IDS.bot);
    await env.emitMessage({ author: env.users.botUser });
    assertXp(env.db, env.communityId, IDS.bot, before);
  });

  it("awards message XP", async () => {
    const uid = IDS.member;
    const before = env.db.getXp(env.communityId, uid);
    await env.emitMessage({ author: env.users.memberUser });
    assertXp(env.db, env.communityId, uid, before + 5);
  });

  it("respects message cooldown", async () => {
    env.db.updateGuildSettings(env.communityId, {
      msg_xp: 5,
      msg_cooldown_sec: 60,
    });
    // unique user to avoid prior cooldown map noise — use member2
    const uid = IDS.member2;
    const before = env.db.getXp(env.communityId, uid);
    await env.emitMessage({ author: env.users.member2User });
    assertXp(env.db, env.communityId, uid, before + 5);
    await env.emitMessage({ author: env.users.member2User });
    assertXp(env.db, env.communityId, uid, before + 5);
    // restore
    env.db.updateGuildSettings(env.communityId, { msg_cooldown_sec: 0 });
  });

  it("honeypot channel bans and blocks XP", async () => {
    env.db.addHoneypotChannel(env.communityId, IDS.channelHoneypot);
    const uid = IDS.member;
    const before = env.db.getXp(env.communityId, uid);
    const message = await env.emitMessage({
      author: env.users.memberUser,
      channel: env.channels.honeypot,
      member: env.members.member,
    });
    assert.equal(message.deleted, true);
    assertBanned(env.guild, uid);
    assertXp(env.db, env.communityId, uid, before);
  });

  it("honeypot exempt deletes message but does not ban", async () => {
    // fresh user for exempt path
    const user = env.createUser({ id: "user-exempt-1", username: "staff" });
    const mem = env.createMember({
      guild: env.guild,
      user,
      roleIds: [IDS.roleExempt],
      admin: false,
    });
    env.guild.addMember(mem);
    env.db.addHoneypotChannel(env.communityId, IDS.channelHoneypot);
    env.db.addHoneypotExemptRole(env.communityId, IDS.roleExempt);

    env.guild._bans.length = 0;
    const before = env.db.getXp(env.communityId, user.id);
    const message = await env.emitMessage({
      author: user,
      member: mem,
      channel: env.channels.honeypot,
    });
    assert.equal(message.deleted, true);
    assertNotBanned(env.guild, user.id);
    assertXp(env.db, env.communityId, user.id, before);
  });
});

/**
 * Bridge pipeline gates (roadmap/bridge.md §10.4 + §10.12, PR 4 fixtures):
 * the create loop gate, the enqueue, and the Fluxer `!bridge` command line
 * are exercised END-TO-END through the shipped pipeline — relay echo drops,
 * per-deployment isolation, one outbox row per source human message, and
 * exactly one dispatch per bridge command line. No worker runs (KD 22): the
 * outbox row stays 'pending'; sending is the activation PR.
 */
describe("integration: bridge pipeline gates", () => {
  const FLUXER_INSTANCE = "https://bridge.it";
  const FLUXER_GUILD = "1554590611015729999";
  const FLUXER_CHANNEL = "777000111";

  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env2;
  // src modules are required AFTER createIntegrationEnv (loadDb resets the
  // src require cache — harness.js contract).
  let relay;
  let repo;
  let codes;
  let pipelines;
  let logsAudit;
  let createRegistry;
  let makeFakeHandle;
  let gatewayMessage;
  let normalizeFluxerMessage;
  let ensureCommunity;

  before(async () => {
    env2 = await createIntegrationEnv();
    env2.db.updateGuildSettings(env2.communityId, {
      msg_xp: 5,
      msg_cooldown_sec: 0,
    });
    relay = require("../../src/features/bridge/relay");
    repo = require("../../src/db/repositories/bridges");
    codes = require("../../src/features/bridge/codes");
    pipelines = require("../../src/bot/pipelines");
    logsAudit = require("../../src/features/logs/auditLog");
    ({ createRegistry } = require("../../src/commands/registry"));
    ({ makeFakeHandle, gatewayMessage } = require("../helpers/fluxer"));
    ({ normalizeFluxerMessage } = require("../../src/platform/fluxer/normalize"));
    ({ ensureCommunity } = require("../../src/platform/community"));
  });

  after(() => {
    relay?.clearRelayState();
    env2?.cleanup();
  });

  /** A digit-string snowflake decoding to ~now (connected_at window, §10.5). */
  function snowflakeNow() {
    return String((BigInt(Date.now()) - 1420070400000n) << 22n);
  }

  function activityCount(communityId, userId) {
    return env2.db.db
      .prepare(
        "SELECT COUNT(*) AS c FROM user_channel_message_daily WHERE community_id = ? AND user_id = ?",
      )
      .get(communityId, userId).c;
  }

  it("relay echo (webhook id in author.id only, bot flag absent) is dropped before cache/activity/XP", async () => {
    const echoId = "777000000000000001";
    const author = env2.createUser({ id: echoId, username: "relay-echo" }); // bot: false
    relay.clearRelayState();
    relay.registerRelayWebhookId("discord", "discord", echoId);

    const xpBefore = env2.db.getXp(env2.communityId, echoId);
    const message = env2.makeMessage({
      author,
      id: "700000000000000001",
      content: "copied text from the other side",
    });
    await env2.onMessageCreate(message);

    // Gate fires on author.id ALONE (no author.bot, no webhookId, empty
    // destination-id map): no XP, no activity counter, no cache, no outbox.
    assertXp(env2.db, env2.communityId, echoId, xpBefore);
    assert.equal(activityCount(env2.communityId, echoId), 0);
    assert.equal(logsAudit.getCachedMessage(message), null);
    assert.equal(
      env2.db.db
        .prepare("SELECT COUNT(*) AS c FROM bridge_outbox WHERE src_message_id = ?")
        .get("700000000000000001").c,
      0,
    );
  });

  it("a human sharing that id on ANOTHER deployment keeps XP (per-deployment gate)", async () => {
    const sharedId = "777000000000000001";
    const author = env2.createUser({ id: sharedId, username: "not-a-relay" });
    relay.clearRelayState();
    // The id is a RELAY WEBHOOK on a Fluxer deployment…
    relay.registerRelayWebhookId("fluxer", "inst-ghost", sharedId);
    // …and a HUMAN on Discord: the Discord deployment slice does not contain it.
    const before = env2.db.getXp(env2.communityId, sharedId);
    await env2.emitMessage({ author, id: "700000000000000002", content: "human on discord" });
    assertXp(env2.db, env2.communityId, sharedId, before + 5);
    assert.equal(activityCount(env2.communityId, sharedId), 1);
  });

  it("a human message on an active bridge enqueues exactly one outbox row (and keeps XP)", async () => {
    relay.clearRelayState();
    const author = env2.createUser({ id: "510000000000000001", username: "talker" });
    const created = repo.createBridge({
      publicId: codes.generatePublicId(),
      createdByUserId: "creator-1",
      endACommunityId: env2.communityId,
      endAChannelId: IDS.channelGeneral,
      direction: "both",
    });
    // PR 4 has no production connect (relay not wired), so the test seeds the
    // CAS outcome directly: state active + connected_at in the past.
    env2.db.db
      .prepare("UPDATE bridges SET state = 'active', connected_at = ? WHERE id = ?")
      .run(Date.now() - 60_000, created.id);

    const msgId = snowflakeNow();
    const before = env2.db.getXp(env2.communityId, author.id);
    await env2.emitMessage({ author, id: msgId, content: "hello world" });

    const rows = env2.db.db
      .prepare("SELECT * FROM bridge_outbox WHERE src_message_id = ?")
      .all(msgId);
    assert.equal(rows.length, 1, "exactly one outbox row per source message");
    assert.equal(rows[0].kind, "create");
    assert.equal(rows[0].direction, "a_to_b");
    assert.equal(rows[0].state, "pending"); // worker is PR 5 — nothing sends
    const payload = JSON.parse(rows[0].payload_json);
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.publicId, created.public_id);
    assert.equal(payload.text, "hello world");
    // The source human still earns XP (enqueue can never skip it, §10.4).
    assertXp(env2.db, env2.communityId, author.id, before + 5);
  });

  it("a bridge command line on Fluxer dispatches exactly once — not cached, not XP'd", async () => {
    relay.clearRelayState();
    const registry = createRegistry();
    let dispatches = 0;
    registry.registerHandler(
      "bridge",
      async () => {
        dispatches += 1;
      },
      { api: "context" },
    );
    const handle = makeFakeHandle({ instanceKey: FLUXER_INSTANCE });
    const fluxerCommunity = ensureCommunity({
      platform: "fluxer",
      instanceKey: FLUXER_INSTANCE,
      externalGuildId: FLUXER_GUILD,
    });

    const msg = normalizeFluxerMessage(
      {
        t: "MESSAGE_CREATE",
        d: gatewayMessage({
          id: "610001",
          channel_id: FLUXER_CHANNEL,
          guild_id: FLUXER_GUILD,
          content: "!bridge list",
        }),
      },
      { instanceKey: FLUXER_INSTANCE },
    );
    msg.communityId = fluxerCommunity;
    const xpBefore = env2.db.getXp(fluxerCommunity, "5"); // gateway author id

    await pipelines.onMessageCreate(handle.outbound, msg, {
      registry,
      supervisor: null,
    });

    // One dispatch through the shipped dispatcher; no XP, no activity.
    assert.equal(dispatches, 1);
    assertXp(env2.db, fluxerCommunity, "5", xpBefore);
    assert.equal(activityCount(fluxerCommunity, "5"), 0);

    // A BOT-authored bridge line is relay/bot traffic: dropped, never dispatched.
    const botMsg = normalizeFluxerMessage(
      {
        t: "MESSAGE_CREATE",
        d: gatewayMessage({
          id: "610002",
          channel_id: FLUXER_CHANNEL,
          guild_id: FLUXER_GUILD,
          content: "!bridge list",
          author: { id: "9", username: "relay", bot: true },
        }),
      },
      { instanceKey: FLUXER_INSTANCE },
    );
    botMsg.communityId = fluxerCommunity;
    await pipelines.onMessageCreate(handle.outbound, botMsg, {
      registry,
      supervisor: null,
    });
    assert.equal(dispatches, 1);

    // No spurious outbox rows for command traffic (§10.4: not relayed).
    assert.equal(
      env2.db.db
        .prepare(
          "SELECT COUNT(*) AS c FROM bridge_outbox WHERE src_message_id IN ('610001', '610002')",
        )
        .get().c,
      0,
    );
  });

  it("a half-shaped Fluxer normalized message is contract-rejected at the boundary — logged + skipped (issue #201)", async () => {
    relay.clearRelayState();
    const registry = createRegistry();
    let dispatches = 0;
    registry.registerHandler(
      "bridge",
      async () => {
        dispatches += 1;
      },
      { api: "context" },
    );
    const handle = makeFakeHandle({ instanceKey: FLUXER_INSTANCE });
    const fluxerCommunity = ensureCommunity({
      platform: "fluxer",
      instanceKey: FLUXER_INSTANCE,
      externalGuildId: FLUXER_GUILD,
    });

    const msg = normalizeFluxerMessage(
      {
        t: "MESSAGE_CREATE",
        d: gatewayMessage({
          id: "610003",
          channel_id: FLUXER_CHANNEL,
          guild_id: FLUXER_GUILD,
          content: "hello world",
        }),
      },
      { instanceKey: FLUXER_INSTANCE },
    );
    msg.communityId = fluxerCommunity;
    // Half-shaped hand-build: a REAL fluxer output with one REQUIRED field
    // removed. The boundary must catch it before any pipeline step runs.
    delete msg.content;

    const xpBefore = env2.db.getXp(fluxerCommunity, "5"); // gateway author id
    const logs = await captureConsoleError(() =>
      pipelines.onMessageCreate(handle.outbound, msg, {
        registry,
        supervisor: null,
      }),
    );

    // Loud + specific: the violation names the field AND the platform,
    // logged as a contract line — never the generic pipeline error line.
    assert.equal(
      logs.filter(
        (l) =>
          l.includes("normalized-message contract violation") &&
          l.includes('"content"') &&
          l.includes('platform "fluxer"'),
      ).length,
      1,
      `expected one contract-violation log naming content+fluxer, got: ${JSON.stringify(logs)}`,
    );
    assert.equal(
      logs.filter((l) => l.startsWith("[MessageCreate] error:")).length,
      0,
      "contract failures stay distinguishable from downstream errors",
    );
    assert.equal(dispatches, 0, "nothing downstream ran");
    // skipped message earns no XP
    assertXp(env2.db, fluxerCommunity, "5", xpBefore);
  });
});

/**
 * Discord-side boundary tests for the NormalizedMessage required-field
 * contract (issue #201, audit §6 P2): a half-shaped hand-built message is
 * logged and SKIPPED at onMessageCreate entry (no XP, no cache); the
 * adapter boundary catches payloads the normalizer cannot complete (no
 * author); and guild-less (DM) messages keep flowing to the guild gate
 * exactly as before — the contract MODELS the DM null, it does not newly
 * reject it.
 */
describe("integration: normalized-message contract boundary (Discord, issue #201)", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env3;
  let pipelines;
  let getDiscordOutbound;
  let normalizeDiscordMessage;
  let logsAudit3;

  before(async () => {
    env3 = await createIntegrationEnv();
    env3.db.updateGuildSettings(env3.communityId, {
      msg_xp: 5,
      msg_cooldown_sec: 0,
    });
    pipelines = require("../../src/bot/pipelines");
    ({ getDiscordOutbound } = require("../../src/platform/discord/outbound"));
    ({ normalizeDiscordMessage } = require("../../src/platform/discord/normalize"));
    logsAudit3 = require("../../src/features/logs/auditLog");
  });

  after(() => {
    env3?.cleanup();
  });

  it("a full-shape normalized message still flows end-to-end (XP awarded)", async () => {
    const before = env3.db.getXp(env3.communityId, IDS.member);
    await env3.emitMessage({ author: env3.users.memberUser });
    assertXp(env3.db, env3.communityId, IDS.member, before + 5);
  });

  it("a hand-built message missing a REQUIRED field is logged as a contract violation and skipped", async () => {
    const raw = env3.makeMessage({
      author: env3.users.memberUser,
      id: "700000000000000101",
    });
    const half = { ...normalizeDiscordMessage(raw) };
    delete half.channelId;

    const xpBefore = env3.db.getXp(env3.communityId, IDS.member);
    const logs = await captureConsoleError(() =>
      pipelines.onMessageCreate(getDiscordOutbound(env3.client), half, {}),
    );

    assert.equal(
      logs.filter(
        (l) =>
          l.includes("normalized-message contract violation") &&
          l.includes('"channelId"') &&
          l.includes('platform "discord"'),
      ).length,
      1,
      `expected one contract log naming channelId+discord, got: ${JSON.stringify(logs)}`,
    );
    assert.equal(
      logs.filter((l) => l.startsWith("[MessageCreate] error:")).length,
      0,
      "the contract line replaces the generic pipeline error line",
    );
    // skipped message earns no XP
    assertXp(env3.db, env3.communityId, IDS.member, xpBefore);
    // the message never reached the logs cache (full object → proper cache key)
    assert.equal(logsAudit3.getCachedMessage(half), null);
  });

  it("a payload the Discord adapter cannot complete (no author) is logged + skipped, bot stays alive", async () => {
    const raw = env3.makeMessage({
      author: env3.users.memberUser,
      id: "700000000000000102",
    });
    delete raw.author;
    delete raw.member;

    const logs = await captureConsoleError(() => env3.onMessageCreate(raw));
    assert.equal(
      logs.filter(
        (l) =>
          l.includes("normalized-message contract violation") &&
          l.includes('"authorId"'),
      ).length,
      1,
      `expected one contract log naming authorId, got: ${JSON.stringify(logs)}`,
    );
  });

  it("guild-less (DM) messages still reach the guild gate — not newly contract-rejected", async () => {
    const dm = {
      id: "700000000000000103",
      content: "hi bot (dm)",
      guild: null,
      guildId: null,
      channel: { id: "dm-channel-1" },
      channelId: "dm-channel-1",
      author: { id: "900000000000000001", username: "dm-user", bot: false },
      member: null,
      createdAt: new Date(),
      attachments: new Map(),
    };
    const logs = await captureConsoleError(() => env3.onMessageCreate(dm));
    assert.deepEqual(
      logs.filter((l) => l.includes("contract violation")),
      [],
      `a DM must pass the boundary (externalGuildId: null is the modeled shape), got: ${JSON.stringify(logs)}`,
    );
  });
});
