/**
 * PR 7 (activation) integration tests (roadmap/bridge.md § Tests —
 * "Activation"): the relay worker boots, the `!bridge` Fluxer guild prefix
 * path runs through the ONE shipped dispatcher (KD 17), the DM connect entry
 * works end to end (spec §10.2 / §10.10), and the BRIDGE_ENABLED kill switch
 * gates commands, enqueue, and the worker (Rollout).
 *
 * All Fluxer REST I/O runs against the fake transport from test/helpers/
 * fluxer.js — no network, no real gateway. The service module is monkey-patched
 * (restored via t.after) to observe the arguments the handlers pass, so these
 * tests prove WIRING; the service's own behavior lives in bridge-activate.test.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { loadDb, communityKey } = require("./helpers/env");

// CONTRACT: loadDb() before every src/ require (fresh temp DB, cache reset).
const { api: db, cleanup } = loadDb();

const repo = require("../src/db/repositories/bridges");
const service = require("../src/features/bridge/service");
const handlers = require("../src/features/bridge/handlers");
const relay = require("../src/features/bridge/relay");
const bridgeFeature = require("../src/features/bridge");
const tokenCrypto = require("../src/features/bridge/tokenCrypto");
const { buildPausedNotice, createPauseLatch } = require("../src/features/bridge/config");
const { normalizeFluxerMessage, normalizeFluxerDmMessage } = require("../src/platform/fluxer/normalize");
const { ensureCommunity } = require("../src/platform/community");
const {
  makeFakeRest,
  makeFakeHandle,
  gatewayMessage,
} = require("./helpers/fluxer");
const { parsePrefix } = require("../src/platform/fluxer/commands");
const { dispatchPrefixCommand } = require("../src/platform/fluxer/dispatch");
const { buildDefaultRegistry } = require("../src/commands/registry");

test.after(() => cleanup?.());

const INSTANCE = "https://fluxer.test";
const CODE = "BRG-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF";

// The §10.2/§10.10 DM copy chosen for PR 7, spelled here as a literal so a
// drift from the shipped handlers fails this file.
const DM_USAGE =
  "DMs run one bridge command: !bridge connect <code> <channel>. " +
  "Paste the BRG- code from bridge create, then the id of the Fluxer " +
  "channel to pair with the bridged Discord channel.";
const VERB_GUIDANCE =
  'The "status" verb runs in a guild channel: run !bridge status there (status and list results come back by DM). ' +
  "DMs support !bridge connect <code> <channel>.";

const KEY = crypto.randomBytes(32).toString("base64");
const enc = (token) => tokenCrypto.encryptWebhookToken(token, { keyGetter: () => KEY });

const registry = buildDefaultRegistry();
const P = { registryCommands: registry.commands, prefix: "!" };

// Communities used across the file (numeric keys, contract 4).
const GUILD_DM = "1554590611015729152"; // guild owning the DM-connect TARGET channel
const COMM_FLUXER = ensureCommunity({
  platform: "fluxer",
  instanceKey: INSTANCE,
  externalGuildId: GUILD_DM,
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Swap the service entry points for the duration of one test (t.after restores
 * the originals, so monkey-patching never leaks between tests).
 */
function patchService(t, impl) {
  const orig = {
    createBridge: service.createBridge,
    connectBridge: service.connectBridge,
  };
  service.createBridge = impl.createBridge || (async () => ({ ok: false, error: "unexpected" }));
  service.connectBridge = impl.connectBridge || (async () => ({ ok: false, error: "unexpected" }));
  t.after(() => {
    service.createBridge = orig.createBridge;
    service.connectBridge = orig.connectBridge;
  });
}

/** The §10.2 activation-path success shape the shipped handlers render. */
function connectOk(publicId = "b_cafef00d") {
  return {
    ok: true,
    publicId,
    peer: { platformLabel: "Discord", instanceKey: "discord", channelId: "555999888" },
    directionLabel: "both directions",
    warnings: [],
  };
}

function withEnv(t, name, value, fn) {
  const prev = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  });
  return fn;
}

/** Minimal ctx for direct handlers.handleBridge calls (slash-surface shape). */
function handlerCtx(overrides = {}) {
  return {
    platform: "discord",
    communityId: 1,
    channelId: 100,
    userId: "u1",
    memberRoleIds: [],
    channelPermissions: 0n,
    options: {
      _s: { code: null, channel: null, bridge: null, direction: null },
      getString(name) {
        return this._s[name] ?? null;
      },
      getChannel() {
        return null;
      },
    },
    replies: [],
    reply(data) {
      this.replies.push(data);
      return Promise.resolve({ id: "m1" });
    },
    followUp(data) {
      this.replies.push(data);
      return Promise.resolve({ id: "m2" });
    },
    ...overrides,
  };
}

/** A relay-eligible NormalizedMessage-shaped object for the enqueue gate. */
function relayMessage(overrides = {}) {
  return {
    platform: "discord",
    id: "900",
    channelId: "700",
    authorId: "author-1",
    authorBot: false,
    type: 0,
    communityId: 1,
    ...overrides,
  };
}

/**
 * Seed an ACTIVE bridge: Discord end A (community 1, channel 700) ↔ Fluxer
 * end B (community COMM_FLUXER, channel 800), both webhook tokens encrypted.
 */
function seedActiveBridge(publicId, opts = {}) {
  const endACommunityId = opts.endACommunityId ?? 1;
  const created = repo.createBridge({
    publicId,
    createdByUserId: "1",
    endACommunityId,
    endAChannelId: opts.endAChannelId ?? "700",
    direction: "both",
    codeHash: null,
  });
  repo.addBridgeEnd({
    bridgeId: created.id,
    position: "b",
    communityId: opts.endBCommunityId ?? COMM_FLUXER,
    channelId: opts.endBChannelId ?? "800",
  });
  db.db
    .prepare("UPDATE bridges SET state = 'active' WHERE id = ?")
    .run(created.id);
  return created;
}

/** Standard relay create payload for outbox seeding. */
function relayPayload(publicId, srcMessageId) {
  return {
    schemaVersion: 1,
    publicId,
    direction: "a_to_b",
    srcCommunityId: 1,
    srcChannelId: "700",
    srcMessageId,
    author: { id: "42", display: "Alice", handle: "alice", avatarUrl: null },
    text: "queued message",
    replyHeader: null,
    voiceCaption: null,
    explicitMedia: false,
    stickers: [],
    embeds: [],
    attachments: [],
  };
}

function seedOutboxRow(bridgeId, srcMessageId, publicId = "b_p05e0001") {
  const row = repo.enqueueBridgeOutbox(bridgeId, {
    direction: "a_to_b",
    kind: "create",
    srcMessageId,
    payload: relayPayload(publicId, srcMessageId),
  });
  return row.id;
}

/**
 * Fresh fake handle + supervisor + NormalizedDmMessage for the DM connect flow.
 * The DM (channel 7, author 5) carries the full `!bridge connect` line; the
 * TARGET channel 555000222 lives in guild GUILD_DM (community COMM_FLUXER).
 */
function dmSetup(t) {
  const rest = makeFakeRest({
    routes: {
      // Raw channel record: the DM handler reads guild_id from it.
      "GET /v1/channels/555000222": {
        id: "555000222",
        type: 0,
        guild_id: GUILD_DM,
        permission_overwrites: [],
      },
      // resolveFluxerPermissions for the DM author on the target channel.
      "GET /v1/guilds/1554590611015729152/members/5": {
        user: { id: "5", username: "tester", bot: false },
        roles: ["900"],
      },
      // ManageGuild (0x20 = 32) on the author's role.
      "GET /v1/guilds/1554590611015729152/roles": [{ id: "900", permissions: "32" }],
      // K2 DM replies.
      "POST /v1/users/@me/channels": { id: "dm-42", type: 1 },
      "POST /v1/channels/dm-42/messages": { id: "dm-msg-1" },
      // §10.10 notice in the target channel.
      "POST /v1/channels/555000222/messages": { id: "target-echo-1" },
    },
  });
  const handle = makeFakeHandle({ instanceKey: INSTANCE, rest });
  const supervisor = {
    fluxer: new Map([[INSTANCE, handle]]),
    clientForCommunity: () => handle.outbound,
  };
  const dmFor = (content) =>
    normalizeFluxerDmMessage(
      { t: "MESSAGE_CREATE", d: gatewayMessage({ guild_id: null, channel_id: "7", content }) },
      { instanceKey: INSTANCE },
    );
  return { rest, handle, supervisor, dmFor };
}

const dmPosts = (rest) =>
  rest.calls.filter((c) => c.method === "POST" && c.path === "/v1/channels/dm-42/messages");

// ---------------------------------------------------------------------------
// 1. Guild prefix path: `!bridge create` through the shipped dispatcher
// ---------------------------------------------------------------------------

test("the guild prefix path runs !bridge create through the dispatcher exactly once (KD 17)", async (t) => {
  const guild = communityKey("99", "fluxer", INSTANCE); // gateway fixture guild

  let createCalls = 0;
  patchService(t, {
    createBridge: async (args) => {
      createCalls += 1;
      return {
        ok: true,
        publicId: "b_cafe0001",
        code: CODE,
        expiresAt: 1_700_000_600_000,
        direction: "both",
        _args: args,
      };
    },
  });

  const rest = makeFakeRest({
    routes: {
      // Dispatch step 2.5: member + role resolution for the author.
      "GET /v1/guilds/99/members/5": {
        user: { id: "5", username: "tester", bot: false },
        roles: ["900"],
      },
      "GET /v1/guilds/99/roles": [{ id: "900", permissions: "32" }],
      // K2 (sensitive reply) lands in the DM — and ONLY there. No guild-channel
      // POST route is registered: any attempt fails with FAKE_NO_ROUTE.
      "POST /v1/users/@me/channels": { id: "dm-42", type: 1 },
      "POST /v1/channels/dm-42/messages": { id: "dm-msg-1" },
    },
  });
  const handle = makeFakeHandle({ instanceKey: INSTANCE, rest });
  const supervisor = {
    fluxer: new Map([[INSTANCE, handle]]),
    clientForCommunity: () => handle.outbound,
  };

  const raw = gatewayMessage({ content: "!bridge create" });
  const message = normalizeFluxerMessage(raw, { instanceKey: INSTANCE });
  message.communityId = guild; // what the pipeline attaches (contract 4)

  const parsed = parsePrefix("!bridge create", P);
  assert.ok(parsed && !parsed.usageError, "the prefix grammar resolves !bridge create");
  assert.equal(parsed.commandName, "bridge");
  assert.equal(parsed.subcommand, "create");

  await dispatchPrefixCommand(handle.outbound, message, parsed, { registry, supervisor });

  // Exactly ONE service call, carrying the Fluxer-surface facts.
  assert.equal(createCalls, 1, "the command ran exactly once — no double dispatch");

  // The create credential reply is SENSITIVE: K2 carries it by DM, and the
  // guild channel (the invocation channel) receives nothing (spec §10.1).
  const dmCreate = rest.calls.filter((c) => c.method === "POST" && c.path === "/v1/users/@me/channels");
  assert.equal(dmCreate.length, 1, "the recipient DM is created via the users/@me/channels spec form");
  assert.deepEqual(dmCreate[0].body, { recipient_id: "5" }, "the DM targets the author");
  const posts = dmPosts(rest);
  assert.equal(posts.length, 1, "exactly one DM reply");
  assert.ok(posts[0].body.content.includes("Bridge b_cafe0001."), "the reply names the handle");
  assert.ok(
    posts[0].body.content.includes("BRG-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF"),
    "the credential is shown once in the DM (spec §10.1)",
  );
  assert.ok(
    posts[0].body.content.includes("!bridge connect <credential> <channel>"),
    "the DM spells the connect command in the spec format",
  );
  const guildPosts = rest.calls.filter(
    (c) => c.method === "POST" && c.path === "/v1/channels/7/messages",
  );
  assert.equal(guildPosts.length, 0, "the guild channel never receives the credential");

  // KD 2: the command message is not XP-eligible and never relayed.
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM user_channel_message_daily WHERE channel_id = '7'").get().n,
    0,
    "command invocations never reach the XP pipeline",
  );
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM bridge_outbox").get().n,
    0,
    "commands are never relayed as messages",
  );
});

// ---------------------------------------------------------------------------
// 2. The DM connect surface (spec §10.2)
// ---------------------------------------------------------------------------

test("the DM path resolves the community from the TARGET channel and runs connect", async (t) => {
  patchService(t, { connectBridge: async () => connectOk("b_cafef00d") });
  const { rest, supervisor, dmFor } = dmSetup(t);
  assert.ok(COMM_FLUXER > 0, "the target guild is a registered community");

  await handlers.handleDmMessage(dmFor(`!bridge connect code ${CODE} channel 555000222`), {
    supervisor,
  });

  // Every reply returns in the DM, carrying the §10.2 service sentence.
  const posts = dmPosts(rest);
  assert.equal(posts.length, 1, "exactly one DM reply");
  console.log("REPLY:", JSON.stringify(posts[0].body.content)); assert.ok(
    posts[0].body.content.includes("Connected bridge b_cafef00d."),
    "the DM carries the service success message",
  );
  assert.match(posts[0].body.content, /Stop it with !bridge disconnect/, "the surface command verb rides along");
  assert.deepEqual(
    posts[0].body.allowed_mentions,
    { parse: [] },
    "relay copy pings nobody (wire shape)",
  );

  // The public target-channel notice (§10.10): handle + direction, no far id.
  const targetPosts = rest.calls.filter(
    (c) => c.method === "POST" && c.path === "/v1/channels/555000222/messages",
  );
  assert.equal(targetPosts.length, 1, "the target channel gets exactly one notice");
  assert.equal(
    targetPosts[0].body.content,
    "Bridge b_cafef00d connected. Direction: both directions.",
    "the notice names handle + direction only",
  );
  assert.ok(!targetPosts[0].body.content.includes("555999888"), "the far channel id is not public");
  assert.ok(!targetPosts[0].body.content.includes(CODE), "the code never appears in a public channel");

  // The DM reply never posts to a guild channel (K2 through sendDm).
  const guildPosts = rest.calls.filter(
    (c) => c.method === "POST" && /\/channels\/(7|555000222)\/messages$/.test(c.path) && !c.path.includes("dm-42"),
  );
  assert.equal(
    guildPosts.length,
    1,
    "only the target notice posts to a channel — the DM reply rides the DM",
  );
});

test("the DM handler hands connectBridge the surface facts (via dm, null invocation channel, computed staff mask)", async (t) => {
  const { supervisor, dmFor } = dmSetup(t);
  let seenArgs = null;
  patchService(t, {
    connectBridge: async (args) => {
      seenArgs = args;
      return connectOk("b_cafef00d");
    },
  });

  await handlers.handleDmMessage(dmFor(`!bridge connect code ${CODE} channel 555000222`), {
    supervisor,
  });

  assert.ok(seenArgs, "connectBridge ran through the DM path");
  assert.equal(seenArgs.via, "dm", "the service records the DM surface (KD 23)");
  assert.equal(
    seenArgs.invocationChannelId,
    null,
    "DMs have no community — the invocation channel is null (spec §10.2)",
  );
  assert.equal(seenArgs.targetChannelId, "555000222", "the parsed channel argument is the target");
  assert.equal(seenArgs.rawCode, CODE, "the raw code arrives exactly as the author typed it");
  assert.equal(seenArgs.actorUserId, "5", "the DM author is the actor");
  assert.equal(seenArgs.community.id, COMM_FLUXER, "the target channel's guild pins the community");
  assert.equal(seenArgs.surfaceCmd, "!bridge", "the DM surface command name for reply copy");
  assert.equal(seenArgs.staff.hasManageGuild, true, "the author's ManageGuild bit is computed on the target channel");
  assert.deepEqual(seenArgs.staff.memberRoleIds, ["900"], "the author's guild roles ride along");
  assert.equal(
    typeof seenArgs.deps.activateBridge,
    "function",
    "handlers inject the §10.7 step-8 activator (KD 22 lifted)",
  );
  void suppressRestRead(seenArgs);
});

// Restraint helper: touching deps.seams must not throw (the service owns them).
function suppressRestRead(args) {
  for (const v of Object.values(args.deps)) void v;
  return true;
}

test("the DM surface is connect-only: verbs and non-commands get specific replies", async (t) => {
  const { rest, supervisor, dmFor } = dmSetup(t);
  let connectCalls = 0;
  patchService(t, {
    connectBridge: async () => {
      connectCalls += 1;
      return connectOk("b_cafef00d");
    },
  });

  // Bare `connect` (no option tokens) → the parser's specific missing-option
  // reason + the DM usage form.
  await handlers.handleDmMessage(dmFor("!bridge connect"), { supervisor });
  let posts = dmPosts(rest);
  assert.equal(posts.length, 1, "one DM reply");
  assert.match(posts[0].body.content, /Missing required option "code"/, "specific parser reason");
  assert.ok(posts[0].body.content.includes(DM_USAGE), "usage line shows the DM form");
  assert.equal(connectCalls, 0);

  // A non-command DM is ignored and touches nothing (no REST, no XP).
  const before = rest.calls.length;
  const ignored = await handlers.handleDmMessage(dmFor("!hello there"), { supervisor });
  assert.equal(ignored, null, "non-bridge DM text is not a command");
  assert.equal(rest.calls.length, before, "non-commands trigger zero REST calls");

  // A known non-connect verb → guidance pointing at the guild surface.
  await handlers.handleDmMessage(dmFor("!bridge status"), { supervisor });
  posts = dmPosts(rest);
  assert.equal(posts.length, 2, "the verb guidance comes back in the DM");
  assert.ok(posts[1].body.content.includes(VERB_GUIDANCE), "status points at the guild channel");
  assert.equal(connectCalls, 0, "no verb other than connect reaches the service");

  // A numeric-but-undersized channel token parses (the K10 guard admits bare
  // digits) and is refused by the DM target rule with the specific §10.10
  // sentence ("the DM channel itself is not a valid target").
  await handlers.handleDmMessage(dmFor(`!bridge connect code ${CODE} channel 123`), { supervisor });
  posts = dmPosts(rest);
  assert.equal(posts.length, 3);
  assert.match(
    posts[2].body.content,
    /needs a channel id of 5–20 digits|is not a valid target/,
    "an unpairable channel argument gets the specific parser/§10.10 sentence (never a generic)",
  );
  assert.equal(connectCalls, 0);
});

// ---------------------------------------------------------------------------
// 3. The BRIDGE_ENABLED kill switch (spec Rollout / §10.10)
// ---------------------------------------------------------------------------

test("the slash handler replies the kill-switch sentence before any community lookup", async (t) => {
  withEnv(t, "BRIDGE_ENABLED", "0", () => {});
  let called = false;
  patchService(t, {
    createBridge: async () => {
      called = true;
      return connectOk();
    },
  });

  // communityId 99999 is not registered: the kill switch must fire FIRST.
  const ctx = handlerCtx({ communityId: 99999 });
  await handlers.handleBridge(ctx, {});

  assert.equal(ctx.replies.length, 1, "exactly one reply");
  assert.equal(
    ctx.replies[0].content,
    "Bridges are turned off on this process (BRIDGE_ENABLED=0).",
    "the reply is the kill-switch sentence verbatim",
  );
  assert.equal(called, false, "the service is never reached while disabled");
});

test("the prefix path replies the kill-switch sentence (via DM — K2)", async (t) => {
  withEnv(t, "BRIDGE_ENABLED", "0", () => {});
  patchService(t, {
    createBridge: async () => {
      throw new Error("must not run while BRIDGE_ENABLED=0");
    },
  });

  const rest = makeFakeRest({
    routes: {
      "GET /v1/guilds/99/members/5": {
        user: { id: "5", username: "tester", bot: false },
        roles: [],
      },
      "POST /v1/users/@me/channels": { id: "dm-42", type: 1 },
      "POST /v1/channels/dm-42/messages": { id: "dm-msg-1" },
    },
  });
  const handle = makeFakeHandle({ instanceKey: INSTANCE, rest });
  const supervisor = {
    fluxer: new Map([[INSTANCE, handle]]),
    clientForCommunity: () => handle.outbound,
  };
  const message = normalizeFluxerMessage(
    { t: "MESSAGE_CREATE", d: gatewayMessage({ content: "!bridge create" }) },
    { instanceKey: INSTANCE },
  );
  const parsed = parsePrefix("!bridge create", P);

  await dispatchPrefixCommand(handle.outbound, message, parsed, { registry, supervisor });

  const posts = dmPosts(rest);
  assert.equal(posts.length, 1, "exactly one reply");
  assert.equal(
    posts[0].body.content,
    "Bridges are turned off on this process (BRIDGE_ENABLED=0).",
    "the kill-switch sentence is the reply (verbatim)",
  );
});

test("the DM path replies the kill-switch sentence in the DM", async (t) => {
  withEnv(t, "BRIDGE_ENABLED", "0", () => {});
  const { rest, supervisor, dmFor } = dmSetup(t);

  await handlers.handleDmMessage(dmFor(`!bridge connect code ${CODE} channel 555000222`), {
    supervisor,
  });

  const posts = dmPosts(rest);
  assert.equal(posts.length, 1, "exactly one DM reply");
  assert.equal(
    posts[0].body.content,
    "Bridges are turned off on this process (BRIDGE_ENABLED=0).",
    "the kill-switch sentence is the DM reply",
  );
});

test("enqueue refuses to insert new rows while disabled (the pause window never bursts)", async (t) => {
  withEnv(t, "BRIDGE_ENABLED", "0", () => {});
  seedActiveBridge("b_k1110001");

  const res = await relay.enqueueBridgeMessage(relayMessage({ content: "while paused" }));  assert.equal(res, null, "no outbox row is enqueued while BRIDGE_ENABLED=0");
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS n FROM bridge_outbox").get().n,
    0,
    "zero rows inserted during the pause",
  );
});

test("the worker skips ticks while disabled and posts the paused notice once per incident", async (t) => {
  const commA = communityKey("900000000000040901"); // Discord end A
  const commB = communityKey("900000000000040902", "fluxer", INSTANCE); // Fluxer end B
  const { bridge, publicId } = (() => {
    const id = "b_p05e0001";
    const created = repo.createBridge({
      publicId: id,
      createdByUserId: "1",
      endACommunityId: commA,
      endAChannelId: "7091",
      direction: "both",
      codeHash: null,
    });
    repo.addBridgeEnd({
      bridgeId: created.id,
      position: "b",
      communityId: commB,
      channelId: "8091",
    });
    db.db.prepare("UPDATE bridges SET state = 'active' WHERE id = ?").run(created.id);
    repo.setBridgeEndWebhook(created.id, "b", {
      webhookId: "wh-b-pause",
      tokenEnc: enc("tok-pause"),
    });
    return { bridge: created, publicId: id };
  })();

  const sent = [];
  const apiCalls = [];
  let enabled = false;
  const api = {
    async executeRelayWebhook(webhook, opts) {
      apiCalls.push({ webhook, opts });
      return { ok: true, messageId: "dest-1" };
    },
  };

  const worker = relay.createRelayWorker({
    repo,
    db: db.db,
    getWebhookApi: () => api,
    getOutbound: () => null,
    keyGetter: () => KEY,
    isBridgeEnabled: () => enabled,
    sendMessage: async (communityId, channelId, content) => {
      sent.push({ communityId, channelId, content });
      return { ok: true };
    },
    sleep: async () => {},
  });

  // One queued row exists BEFORE the pause; the first paused tick notifies.
  const rowId = seedOutboxRow(bridge.id, "9100");

  // Tick 1 — disabled: nothing claimed, one paused notice on the SOURCE channel.
  enabled = false;
  assert.deepEqual(await worker.tick(), { started: 0 }, "the disabled tick starts nothing");
  assert.equal(apiCalls.length, 0, "no webhook request executes while paused");
  let notices = sent.filter((s) => s.content.includes(buildPausedNotice(publicId)));
  assert.equal(notices.length, 1, "the paused notice posted exactly once");
  assert.equal(notices[0].communityId, commA, "the notice goes to the source community");
  assert.equal(notices[0].channelId, "7091", "the notice goes to the source channel");
  assert.equal(
    notices[0].content,
    `Bridge ${publicId} is paused on this process (BRIDGE_ENABLED=0). ` +
      "Messages posted while it is paused are not copied.",
    "the notice is the verbatim §10.10 sentence",
  );
  assert.equal(
    repo.getBridgeOutboxById(rowId).state,
    "pending",
    "the queued row survives the pause untouched",
  );

  // Tick 2 — still disabled: NO re-notification (one notice per incident).
  assert.deepEqual(await worker.tick(), { started: 0 });
  assert.equal(sent.filter((s) => s.content.includes(buildPausedNotice(publicId))).length, 1);
  assert.equal(apiCalls.length, 0);

  // Re-enable: the queued row drains normally (no burst-copy of the window).
  enabled = true;
  await worker.drainAll();
  assert.equal(apiCalls.length, 1, "exactly one webhook request after re-enable");
  assert.equal(
    repo.getBridgeOutboxById(rowId).state,
    "done",
    "the queued row sent on re-enable",
  );
  assert.equal(sent.filter((s) => s.content.includes(buildPausedNotice(publicId))).length, 1);

  // Disable again: a NEW incident notifies once more (the latch resets per incident).
  enabled = false;
  const rowId2 = seedOutboxRow(bridge.id, "9102");
  assert.deepEqual(await worker.tick(), { started: 0 });
  assert.equal(sent.filter((s) => s.content.includes(buildPausedNotice(publicId))).length, 2);
  void rowId2;
});

test("the pause latch notifies each (bridge, direction) once per incident", () => {
  const latch = createPauseLatch();
  assert.equal(latch.shouldNote("b1", "a_to_b"), false, "outside an incident nothing is noted");
  latch.beginIncident();
  assert.equal(latch.shouldNote("b1", "a_to_b"), true, "first note of the incident");
  assert.equal(latch.shouldNote("b1", "a_to_b"), false, "latched: one notice per incident");
  assert.equal(latch.shouldNote("b1", "b_to_a"), true, "the other direction latches separately");
  assert.equal(latch.shouldNote("b2", "a_to_b"), true, "other bridges are independent");
  latch.endIncident();
  assert.equal(latch.shouldNote("b1", "a_to_b"), false, "notes outside an incident are suppressed");
  latch.beginIncident();
  assert.equal(latch.shouldNote("b1", "a_to_b"), true, "a new incident notifies again");
});

// ---------------------------------------------------------------------------
// 4. Feature wiring: DM consumer attached once; start wires the loops
// ---------------------------------------------------------------------------

test("the bridge feature wires the DM surface once and boots the relay loops on start", async (t) => {
  const LATE = "https://late.fluxer.test";
  const wired = [];
  const lateRest = makeFakeRest({
    routes: {
      "POST /v1/users/@me/channels": { id: "dm-99", type: 1 },
      "POST /v1/channels/dm-99/messages": { id: "late-msg-1" },
    },
  });
  const lateHandle = {
    ...makeFakeHandle({ instanceKey: LATE, rest: lateRest }),
    onDmMessage(cb) {
      wired.push(cb);
    },
  };

  const readyCallbacks = [];
  const fakeSupervisor = {
    fluxer: new Map([[LATE, lateHandle]]),
    onFluxerReady(cb) {
      readyCallbacks.push(cb);
    },
    clientForCommunity: () => lateHandle.outbound,
  };

  // KD 17: registration is idempotent — the pre-registered handle gets ONE
  // consumer no matter how many times registerEvents runs.
  bridgeFeature.registerEvents(fakeSupervisor);
  bridgeFeature.registerEvents(fakeSupervisor);
  assert.equal(
    wired.length,
    1,
    "the pre-registered handle gets exactly one consumer (no second listener)",
  );

  // A handle that finishes connecting AFTER registration is wired through the
  // onFluxerReady hook — exactly once, even with two listeners registered.
  // The late handle needs a COUNTING onDmMessage — a plain fake handle's
  // default consumer would register invisibly and `wired` would never see it.
  const lateBase = {
    ...makeFakeHandle({ instanceKey: "https://later.fluxer.test", rest: lateRest }),
    onDmMessage(cb) {
      wired.push(cb);
    },
  };
  readyCallbacks.forEach((cb) => cb(lateBase)); // late Fluxer login, fired twice
  assert.equal(
    wired.length,
    2,
    "the late handle is wired exactly once despite two ready listeners",
  );

  // The attached consumer is the real DM entry: with the kill switch on, the
  // wired callback answers in the DM with the §10.2 sentence.
  withEnv(t, "BRIDGE_ENABLED", "0", () => {});
  const dm = normalizeFluxerDmMessage(
    { t: "MESSAGE_CREATE", d: gatewayMessage({ guild_id: null, content: "!bridge create" }) },
    { instanceKey: LATE },
  );
  await wired[0](dm);
  const latePosts = lateRest.calls.filter(
    (c) => c.method === "POST" && c.path === "/v1/channels/dm-99/messages",
  );
  assert.equal(latePosts.length, 1, "the wired consumer answers in the DM");
  assert.equal(
    latePosts[0].body.content,
    "Bridges are turned off on this process (BRIDGE_ENABLED=0).",
    "the DM consumer routes into handlers.handleDmMessage",
  );

  // start wires the relay + expiry jobs on the scheduler (KD 22 lifted).
  const fakeScheduler = {
    jobs: new Map(),
    registerJob(spec) {
      this.jobs.set(spec.name, spec);
    },
    stop(name) {
      this.jobs.delete(name);
    },
  };
  const loops = bridgeFeature.start(fakeSupervisor, {
    scheduler: fakeScheduler,
    repo,
    getWebhookApi: () => null,
    getOutbound: () => null,
    keyGetter: () => KEY,
    sendMessage: async () => ({ ok: true }),
  });
  t.after(() => {
    if (loops && typeof loops.stop === "function") loops.stop();
  });

  assert.equal(bridgeFeature.start, relay.startBridgeLoops, "start IS the relay loop starter");
  assert.ok(loops && typeof loops.stop === "function", "start returns a stoppable handle");
  assert.ok(fakeScheduler.jobs.has("bridge-relay"), "the relay loop is registered");
  assert.ok(fakeScheduler.jobs.has("bridge-expiry"), "the expiry sweeper is registered");
  loops.stop();
  assert.equal(fakeScheduler.jobs.size, 0, "stop() removes both jobs from the scheduler");
});

// ---------------------------------------------------------------------------
// 5. Module surface (loader + service-guard seam)
// ---------------------------------------------------------------------------

test("the feature exports the loader surface and the worker keeps its activation seams", async () => {
  assert.equal(bridgeFeature.name, "bridge");
  assert.equal(typeof bridgeFeature.handlers.bridge, "function");
  assert.equal(bridgeFeature.handlerApi.bridge, "context");
  assert.equal(typeof bridgeFeature.registerEvents, "function");
  assert.equal(typeof bridgeFeature.start, "function");
  // The relay seams PR 7 wires (enqueue guard + worker gate + starter).
  assert.equal(typeof relay.enqueueBridgeMessage, "function");
  assert.equal(typeof relay.createRelayWorker, "function");
  assert.equal(typeof relay.startBridgeLoops, "function");
  // The service-level fail-closed guard stays as defense-in-depth: the
  // shipped connectBridge rejects junk (and missing deps) before any webhook
  // create — bridge-activate.test.js owns that behavior in full.
  assert.equal(typeof service.activateBridgeTx, "function");
  const guard = await service.connectBridge({});
  assert.equal(guard.ok, false, "connectBridge({}) cannot succeed");
  assert.match(
    String(guard.error),
    /communities row|internal error/i,
    "the shipped guard rejects before touching any transport",
  );
});
