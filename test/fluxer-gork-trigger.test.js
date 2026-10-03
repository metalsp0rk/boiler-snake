/**
 * Integration tests for the gork keyword trigger on FLUXER messages
 * (roadmap/fluxer.md PR 8, § Gork mentions and history).
 *
 * Real SQLite + mocked global fetch (the gork-budget.test.js idiom): the
 * NORMALIZED fluxer message enters through handleGorkMessage, routes by
 * message.platform, and answers through the fake OutboundClient's REST
 * transport. Pins, end to end:
 *   - the model is given `read_history` (NOT read_discord) on Fluxer,
 *   - the answer ships sanitized (mention markup → roster names),
 *   - every Fluxer gork send carries allowed_mentions {parse: []},
 *   - the read_history window fetches run over REST (before/after/limit),
 *   - the reply references the trigger message,
 *   - /staff syncpermissions on Fluxer answers the locked Discord-only line
 *     (the PR 8 staff-gate deliverable riding in this suite).
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { createIntegrationEnv } = require("./helpers/harness");
const { makeFakeRest, makeFakeHandle } = require("./helpers/fluxer");

const INSTANCE = "https://fluxer.test";
const GUILD = "777000000000000001";
const CHANNEL = "70001";
const ASKER = "5000000000000000001";
const BOB = "6000000000000000001";

const TS = "2026-09-30T12:00:00.000Z";

/* ------------------------------ env hygiene ------------------------------- */

const AI_ENV_KEYS = [
  "AI_API_KEY",
  "AI_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
];

function saveEnv() {
  const saved = {};
  for (const key of AI_ENV_KEYS) {
    saved[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
  }
  return saved;
}

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function enableAiKey() {
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
  delete process.env.OPENAI_MODEL;
  process.env.OPENAI_API_KEY = "test-key";
}

/* --------------------------- mocked LLM transport -------------------------- */

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function chatCompletionResponse(content) {
  return jsonResponse({
    id: "chatcmpl-fx-1",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, tool_calls: null },
        finish_reason: "stop",
      },
    ],
    usage: {},
  });
}

function toolCallResponse(toolName, args) {
  return jsonResponse({
    id: "chatcmpl-fx-2",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: toolName, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {},
  });
}

function mockFetch(script = []) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const next = script.length ? script.shift() : null;
    if (next == null) throw new Error(`mockFetch: unexpected fetch call to ${url}`);
    return next;
  };
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

/* ------------------------------- fixtures -------------------------------- */

function channelRows() {
  // REST order is NEWEST-first (the contract context.js's collector enforces —
  // ascending ids get dropped as "not a newest-first page"). Wire rows carry
  // the NESTED author user object (Phase 0), not a flat authorId.
  return [
    { id: "1000010", author: { id: BOB, bot: false }, content: "read me later", timestamp: TS },
    { id: "1000002", author: { id: ASKER, bot: false }, content: "hi bob", timestamp: TS },
    { id: "1000001", author: { id: BOB, bot: false }, content: "hello there", timestamp: TS },
  ];
}

function makeRoutes() {
  return {
    "GET /v1/channels/70001/messages": () => channelRows(),
    "GET /v1/users/5000000000000000001": () => ({ id: ASKER, username: "asker", bot: false }),
    "GET /v1/users/6000000000000000001": () => ({ id: BOB, username: "bob", bot: false }),
    "POST /v1/channels/70001/messages": () => ({ id: "9000000000000000001" }),
  };
}

function fluxerMessage(overrides = {}) {
  return {
    platform: "fluxer",
    id: "8000000000000000001",
    externalGuildId: GUILD,
    channelId: CHANNEL,
    authorId: ASKER,
    authorBot: false,
    content: "gork what did I say first?",
    createdAt: new Date(TS),
    memberRoleIds: [],
    ...overrides,
  };
}

const createdEnvs = [];
const savedEnv = saveEnv();
after(() => {
  restoreEnv(savedEnv);
  for (const env of createdEnvs) env.cleanup();
  createdEnvs.length = 0;
});

/** Fresh DB + fluxer community with the keyword armed. Requires src modules
 *  AFTER loadDb (require-cache reset) so every helper binds to this env. */
async function setup(opts = {}) {
  const env = await createIntegrationEnv();
  createdEnvs.push(env);
  const { ensureCommunity } = require("../src/platform/community");
  const communityId = ensureCommunity({
    platform: "fluxer",
    instanceKey: INSTANCE,
    externalGuildId: GUILD,
  });
  env.db.updateGuildSettings(communityId, {
    gork_keyword: "gork",
    gork_cooldown_sec: 0,
    ...(opts.auditChannelId ? { audit_log_channel_id: opts.auditChannelId } : {}),
  });
  const trigger = require("../src/features/gork/trigger");
  const routes = makeRoutes();
  if (opts.auditChannelId) {
    routes[`GET /v1/channels/${opts.auditChannelId}`] = () => ({
      id: opts.auditChannelId,
      type: 0,
    });
    routes[`POST /v1/channels/${opts.auditChannelId}/messages`] = () => ({
      id: "9000000000000000009",
    });
  }
  const rest = makeFakeRest({ routes });
  const handle = makeFakeHandle({ instanceKey: INSTANCE, rest });
  // Real boot stamps the discovered endpoints.webapp onto handle → outbound
  // (PR #168 gap #2); the fake handle has no discovery, so set the base.
  handle.outbound.webappBaseUrl = "https://chat.test";
  const supervisor = {
    clientForCommunity: (cid) => (cid === communityId ? handle.outbound : null),
  };
  return { env, trigger, rest, handle, supervisor, communityId };
}

/* -------------------------------- tests ---------------------------------- */

describe("fluxer gork trigger (PR 8)", () => {
  it("answers a keyword trigger with the sanitized, ping-free payload", async () => {
    const saved = saveEnv();
    enableAiKey();
    const ai = mockFetch([chatCompletionResponse("answer: <@6000000000000000001> spoke here")]);
    try {
      const { trigger, rest, supervisor, communityId } = await setup();
      const msg = fluxerMessage({ communityId });

      // No outbound for the community: log-and-skip, never a throw.
      await trigger.handleGorkMessage({ clientForCommunity: () => null }, msg);
      await trigger.whenGorkIdleForTests();
      assert.equal(
        rest.calls.filter((c) => c.method === "POST").length,
        0,
        "no client: no sends (logged skip, never a throw)",
      );

      await trigger.handleGorkMessage(supervisor, msg);
      await trigger.whenGorkIdleForTests();

      const posts = rest.calls.filter((c) => c.method === "POST" && c.path === "/v1/channels/70001/messages");
      assert.equal(posts.length, 1, "exactly one channel answer");
      const body = posts[0].body;
      // Sanitized (spec: sanitizeAnswer stays the rewrite): roster id → name.
      assert.equal(body.content, "answer: @bob spoke here");
      assert.ok(!body.content.includes("<@"), "no raw mention markup survives");
      // Locked (spec 642): all mention parsing off on Fluxer gork sends.
      assert.deepEqual(body.allowed_mentions, { parse: [] });
      // Plain text reply TO the keyword message (decision 11).
      assert.deepEqual(body.message_reference, { message_id: msg.id });
    } finally {
      ai.restore();
      restoreEnv(saved);
    }
  });

  it("posts the Q&A audit embed to the community audit channel (PR #168 M3 pin)", async () => {
    // Regression pin: runGorkHookFluxer must pass the Fluxer OutboundClient
    // as runGorkJob's auditClient (was null — "Fluxer v1 has no audit
    // channel" — so every answered question lost its audit row on Fluxer
    // and CI stayed green: the audit helpers were only tested directly).
    const saved = saveEnv();
    enableAiKey();
    const ai = mockFetch([chatCompletionResponse("the answer")]);
    try {
      const { trigger, rest, supervisor, communityId } = await setup({ auditChannelId: "70009" });
      const msg = fluxerMessage({ communityId });
      await trigger.handleGorkMessage(supervisor, msg);
      await trigger.whenGorkIdleForTests();

      const auditPosts = rest.calls.filter(
        (c) => c.method === "POST" && c.path === "/v1/channels/70009/messages",
      );
      assert.equal(
        auditPosts.length,
        1,
        "the Q&A audit embed must post through the Fluxer OutboundClient to the configured audit channel",
      );
      const body = JSON.parse(JSON.stringify(auditPosts[0].body));
      assert.equal(body.embeds[0].title, "Gork Q&A");
      const jump = (body.embeds[0].fields || []).find((f) => f.name === "Jump");
      assert.ok(
        jump && jump.value.includes(`https://chat.test/channels/${GUILD}/${CHANNEL}/${msg.id}`),
        `question jump uses the discovered webapp base: ${jump && jump.value}`,
      );
      assert.ok(
        !JSON.stringify(body).includes("discord.com"),
        "no discord.com links in a Fluxer audit embed (gap #2)",
      );
      // The channel answer is unaffected by the audit leg.
      assert.equal(
        rest.calls.filter((c) => c.method === "POST" && c.path === "/v1/channels/70001/messages")
          .length,
        1,
        "exactly one channel answer",
      );
    } finally {
      ai.restore();
      restoreEnv(saved);
    }
  });

  it("hands the model read_history (not read_discord) and runs its window", async () => {
    const saved = saveEnv();
    enableAiKey();
    const ai = mockFetch([
      toolCallResponse("read_history", { link: "1000010" }),
      chatCompletionResponse("context read complete"),
    ]);
    try {
      const { trigger, supervisor, rest, communityId } = await setup();
      await trigger.handleGorkMessage(supervisor, fluxerMessage({ communityId }));
      await trigger.whenGorkIdleForTests();

      // LLM round 1 carries the Fluxer reader tool, never the Discord one.
      const llmCalls = ai.calls.filter((c) => c.body && Array.isArray(c.body.tools));
      assert.ok(llmCalls.length >= 1, "tool round happened");
      const toolNames = llmCalls[0].body.tools.map((t) => t.function.name);
      assert.deepEqual(toolNames, ["read_history"], "Fluxer gets read_history only");
      assert.ok(!toolNames.includes("read_discord"));

      // Tool loop: second LLM call carries the tool result message.
      const toolMsg = ai.calls[1].body.messages.find((m) => m.role === "tool");
      assert.ok(toolMsg, "tool result fed back to the model");
      assert.equal(toolMsg.tool_call_id, "call-1");
      assert.ok(toolMsg.content.includes("1000010 | "), "the anchored line is present");

      // The bare message id ran as a MESSAGE target: channel probe first,
      // then the three spec windows on the trigger channel.
      assert.ok(
        rest.calls.some((c) => c.method === "GET" && c.path === "/v1/channels/1000010"),
        "bare id probed as a channel first",
      );
      const windowQueries = rest.calls
        .filter((c) => c.path === "/v1/channels/70001/messages")
        .map((c) => c.query);
      for (const q of [
        { limit: 1, after: "1000009" },
        { limit: 40, before: "1000010" },
        { limit: 10, after: "1000010" },
      ]) {
        assert.ok(
          windowQueries.some((w) => w && w.limit === q.limit && w.after === q.after && w.before === q.before),
          `window fetch ${JSON.stringify(q)} issued`,
        );
      }

      const posts = rest.calls.filter((c) => c.method === "POST" && c.path === "/v1/channels/70001/messages");
      assert.equal(posts.length, 1, "one answer after the tool round");
      assert.equal(posts[0].body.content, "context read complete");
    } finally {
      ai.restore();
      restoreEnv(saved);
    }
  });

  it("stays silent for a non-fluxer-shaped message (no communityId)", async () => {
    const saved = saveEnv();
    enableAiKey();
    const ai = mockFetch([]);
    try {
      const { trigger, rest } = await setup();
      const msg = fluxerMessage({ communityId: undefined });
      await trigger.handleGorkMessage({ clientForCommunity: () => null }, msg);
      await trigger.whenGorkIdleForTests();
      assert.equal(rest.calls.length, 0, "unroutable message: zero REST calls");
      assert.equal(ai.calls.length, 0, "no LLM call");
    } finally {
      ai.restore();
      restoreEnv(saved);
    }
  });
});

describe("staff syncpermissions on Fluxer (PR 8 locked reply)", () => {
  const LOCKED =
    "Slash-command visibility sync is Discord-only. On Fluxer the bot role from the install is the permission grant.";

  it("answers the locked line first, as a DM (K2), before any OAuth work", async () => {
    const staffRoles = require("../src/features/staffRoles");
    const replies = [];
    const ctx = {
      platform: "fluxer",
      subcommand: "syncpermissions",
      subcommandGroup: null,
      reply: async (payload) => {
        replies.push(payload);
        return { ok: true };
      },
    };
    await staffRoles.handlers.staff(ctx, {
      supervisor: { discord: null, fluxer: new Map(), clientForCommunity: () => null },
      registry: null,
    });
    assert.equal(replies.length, 1, "exactly one reply");
    assert.equal(replies[0].content, LOCKED, "the spec's verbatim sentence");
    assert.equal(replies[0].sensitive, true, "K2: the reply routes DM-sensitive");
  });

  it("leaves the Discord arm untouched (non-admin copy unchanged)", async () => {
    const staffRoles = require("../src/features/staffRoles");
    const replies = [];
    const ctx = {
      platform: "discord",
      subcommand: "syncpermissions",
      subcommandGroup: null,
      channelPermissions: 0n, // no ManageGuild bit
      reply: async (payload) => {
        replies.push(payload);
        return { ok: true };
      },
    };
    await staffRoles.handlers.staff(ctx, {});
    assert.equal(replies.length, 1);
    assert.equal(
      replies[0].content,
      "Only server administrators (Manage Server) can sync command visibility.",
      "the pre-existing Discord non-admin copy is byte-identical",
    );
  });
});
