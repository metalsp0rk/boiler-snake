/**
 * Integration tests for the Gork AI keyword Q&A feature
 * (roadmap/gork.md §7.12): real SQLite, mocked Discord I/O, and a mocked
 * global fetch — no real network.
 *
 * The gork pipeline hook is DETACHED (src/bot/pipelines.js never awaits it),
 * so these tests poll for the recorded reply after driving `onMessageCreate`.
 *
 * Each test builds a FRESH integration env: `loadDb()` points DB_PATH at a new
 * temp SQLite file and resets the src require cache, so the in-memory gork
 * queue / cooldown state (module-level in src/features/gork/trigger.js) cannot
 * leak between tests.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertEphemeralReply,
  assertReplyContains,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

// ---------- env hygiene ----------
// (test/helpers/env.js has no save/restore helpers, so keep a local pair;
// loadDb() in the harness still owns DB_PATH / DATA_DIR.)

const AI_ENV_KEYS = [
  "AI_API_KEY",
  "AI_BASE_URL",
  "AI_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "SEARXNG_URL",
];

const TEST_AI_KEY = "test-key";

function saveEnv(keys = AI_ENV_KEYS) {
  const saved = {};
  for (const key of keys) {
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

/**
 * Point the shared AI client at the test key. getAiConfig() prefers AI_*
 * over OPENAI_* (and honors AI_MODEL / OPENAI_MODEL), so clear the AI_*
 * and model overrides to keep key + model deterministic regardless of the
 * ambient environment; saveEnv()/restoreEnv() put them back per test.
 */
function enableAiKey() {
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
  delete process.env.OPENAI_MODEL;
  process.env.OPENAI_API_KEY = TEST_AI_KEY;
}

/** No key at all: gork (and ticket AI) must stay silent. */
function clearAiKey() {
  delete process.env.AI_API_KEY;
  delete process.env.OPENAI_API_KEY;
}

// ---------- mocked global fetch ----------
// The AI client (src/core/ai.js) and the SearXNG tool (gork/tools/webSearch.js)
// both call globalThis.fetch when no fetchImpl is injected; the gork trigger
// injects none, so the tests script it here.

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/**
 * One OpenAI chat.completion response. `content` may be null when the
 * assistant message carries tool_calls instead.
 */
function chatCompletionResponse(content, messageExtra = {}) {
  return jsonResponse({
    id: "chatcmpl-test-1",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, ...messageExtra },
        finish_reason: messageExtra.tool_calls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
}

/**
 * Replace globalThis.fetch with a scripted fake.
 * `script` entries are consumed in call order: a plain response object, or a
 * function (url, init) => response (use for gated/hanging replies). An
 * unexpected call (script exhausted) rejects, so accidental fetches fail the
 * test instead of hitting the network.
 *
 * @returns {{ calls: {url: string, init: object}[], restore: () => void }}
 */
function mockFetch(script = []) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const next = script.length ? script.shift() : null;
    if (next == null) {
      throw new Error(`mockFetch: unexpected fetch call to ${url}`);
    }
    if (typeof next === "function") return next(String(url), init || {});
    return next;
  };
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

// ---------- fake Discord surface for gork ----------

/**
 * The trigger calls `channel.sendTyping()` (harness channels do not define
 * it) — attach a counting implementation to the fake channel.
 */
function attachTyping(channel) {
  const state = { calls: 0 };
  channel.sendTyping = async () => {
    state.calls += 1;
  };
  return state;
}

/**
 * Build a fake Message with the full surface the pipeline + gork trigger
 * read: a superset of the harness `createMessage` fields plus `reply` (the
 * trigger replies TO the keyword message), `memberPermissions`, and an
 * optional reply `reference` / `fetchReference` for the chain-walk path.
 *
 * @returns {{ message: object, replies: object[] }}
 */
function makeGorkMessage(env, opts = {}) {
  const channel = opts.channel || env.channels.general;
  const author = opts.author || env.users.memberUser;
  const member =
    opts.member != null
      ? opts.member
      : env.guild.members.cache.get(author.id) ||
        env.createMember({ guild: env.guild, user: author, admin: false });
  const id = opts.id || `gork-msg-${Math.random().toString(36).slice(2)}`;

  const replies = [];
  const message = {
    id,
    content: opts.content || "",
    guild: env.guild,
    guildId: env.guild.id,
    channel,
    channelId: channel.id,
    author,
    member,
    memberPermissions: {
      has: (flag) =>
        member && member.permissions ? member.permissions.has(flag) : false,
    },
    reference: opts.reference || null,
    fetchReference:
      opts.fetchReference ||
      (async () => {
        throw new Error(`message ${id} has no reference`);
      }),
    deletable: true,
    deleted: false,
    system: false,
    createdTimestamp: opts.createdTimestamp || Date.now(),
    attachments: new Map(),
    embeds: [],
    reply: async (payload) => {
      const sent = await channel.send(payload);
      replies.push(sent);
      return sent;
    },
    delete: async () => {
      message.deleted = true;
    },
    _wasDeleted: () => message.deleted,
  };
  return { message, replies };
}

/** Flatten an EmbedBuilder (or plain object) into searchable text. */
function embedText(embed) {
  if (!embed) return "";
  const data =
    typeof embed.toJSON === "function" ? embed.toJSON() : embed.data || embed;
  const parts = [];
  if (data.title) parts.push(String(data.title));
  if (data.description) parts.push(String(data.description));
  if (data.footer?.text) parts.push(String(data.footer.text));
  if (Array.isArray(data.fields)) {
    for (const f of data.fields) {
      if (f?.name) parts.push(String(f.name));
      if (f?.value) parts.push(String(f.value));
    }
  }
  return parts.join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll (every 25ms) until `predicate()` is truthy or the timeout elapses.
 * Needed because the gork LLM job is detached from the pipeline.
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
}

// ---------- tests ----------

describe("integration: gork (AI keyword Q&A)", () => {
  it("full path: keyword message -> typing + plain-text reply to the message + audit embed", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse(
        "The sky is blue because of Rayleigh scattering."
      ),
    ]);
    try {
      enableAiKey();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        audit_log_channel_id: IDS.channelLog,
      });

      const ch = env.channels.general;
      // Two prior messages feed the context window (ids sort before the
      // trigger id for the harness' lexicographic `before` filter).
      ch.addMessage({
        id: "a1",
        content: "Earlier chatter about the sky",
        author: { id: IDS.member2, username: "member2", tag: "member2#0000" },
        createdTimestamp: Date.now() - 20000,
      });
      ch.addMessage({
        id: "a2",
        content: "Anyone know about light scattering?",
        author: { id: IDS.member, username: "member", tag: "member#0000" },
        createdTimestamp: Date.now() - 10000,
      });

      const typing = attachTyping(ch);
      const { message, replies } = makeGorkMessage(env, {
        id: "t-gork-1",
        content: "gork: why is the sky blue?",
      });

      // The pipeline never awaits the gork job — poll for the reply.
      await env.onMessageCreate(message);
      assert.ok(
        await waitFor(() => replies.length >= 1),
        "expected gork to reply to the keyword message"
      );
      assert.equal(replies.length, 1, "expected exactly one reply");
      assert.equal(
        replies[0].content,
        "The sky is blue because of Rayleigh scattering."
      );
      assert.ok(
        !replies[0].embeds?.length,
        "gork reply must be plain text (no embed)"
      );
      assert.ok(
        ch.sent.some(
          (p) => p === replies[0].content || p?.content === replies[0].content
        ),
        "reply must be posted to the channel"
      );
      assert.ok(typing.calls >= 1, "expected the typing indicator to start");

      // Exactly one AI round trip, with the question + context in the prompt.
      assert.equal(fetchMock.calls.length, 1, "expected exactly one AI fetch");
      assert.match(fetchMock.calls[0].url, /\/chat\/completions$/);
      assert.equal(
        fetchMock.calls[0].init.headers.Authorization,
        `Bearer ${TEST_AI_KEY}`
      );
      const body = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(body.model, "gpt-4o-mini");
      const systemMsg = body.messages.find((m) => m.role === "system");
      assert.ok(
        systemMsg.content.includes("You are **Gork**"),
        "system prompt must carry the immutable gork base"
      );
      const userMsg = body.messages.find((m) => m.role === "user");
      assert.ok(userMsg.content.includes("why is the sky blue?"));
      assert.ok(userMsg.content.includes("Conversation context:"));
      assert.ok(
        userMsg.content.includes("[member2] Earlier chatter about the sky")
      );
      assert.ok(
        userMsg.content.includes("[member] Anyone know about light scattering?")
      );

      // Audit embed posted to the configured audit channel.
      assert.ok(
        await waitFor(() => env.channels.log.sent.length >= 1),
        "expected the Q&A audit embed in the audit channel"
      );
      const auditText = embedText(env.channels.log.sent[0].embeds[0]);
      assert.ok(auditText.includes("Gork Q&A"));
      assert.ok(auditText.includes("why is the sky blue?"));
      assert.ok(auditText.includes("2 prior messages"));
      assert.ok(
        auditText.includes("The sky is blue because of Rayleigh scattering.")
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("per-user cooldown: second trigger inside the window is silent (no reply, no fetch)", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse("Answer to the first question."),
    ]);
    try {
      enableAiKey();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 3600, // explicit long window: 2nd trigger must block
      });
      attachTyping(env.channels.general);

      const { message: m1, replies: r1 } = makeGorkMessage(env, {
        id: "t-cd-1",
        content: "gork: first question",
      });
      await env.onMessageCreate(m1);
      assert.ok(
        await waitFor(() => r1.length >= 1),
        "first trigger must be answered"
      );

      const { message: m2, replies: r2 } = makeGorkMessage(env, {
        id: "t-cd-2",
        content: "gork: second question",
      });
      await env.onMessageCreate(m2);
      await sleep(500); // a cooldown hit must stay silent; give it room
      assert.equal(
        r2.length,
        0,
        "second trigger inside the cooldown must stay silent"
      );
      assert.equal(
        fetchMock.calls.length,
        1,
        "no second LLM call on a cooldown hit"
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("staff (ManageGuild) bypasses the per-user cooldown", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse("First admin answer."),
      chatCompletionResponse("Second admin answer (staff bypass)."),
    ]);
    try {
      enableAiKey();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 3600,
      });
      attachTyping(env.channels.general);

      const { message: m1, replies: r1 } = makeGorkMessage(env, {
        id: "t-staff-1",
        content: "gork: admin question one",
        author: env.users.adminUser,
        member: env.members.adminMember,
      });
      await env.onMessageCreate(m1);
      assert.ok(
        await waitFor(() => r1.length >= 1),
        "staff first trigger must be answered"
      );

      const { message: m2, replies: r2 } = makeGorkMessage(env, {
        id: "t-staff-2",
        content: "gork: admin question two",
        author: env.users.adminUser,
        member: env.members.adminMember,
      });
      await env.onMessageCreate(m2);
      assert.ok(
        await waitFor(() => r2.length >= 1),
        "staff second trigger must bypass the cooldown"
      );
      assert.equal(r2[0].content, "Second admin answer (staff bypass).");
      assert.equal(fetchMock.calls.length, 2, "both staff triggers run the LLM");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("no AI key: keyword message is fully silent (no reply, no fetch, no typing)", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([]); // any call rejects
    try {
      clearAiKey();
      env.db.updateGuildSettings(env.guild.id, { gork_keyword: "gork" });
      const typing = attachTyping(env.channels.general);
      const { message, replies } = makeGorkMessage(env, {
        id: "t-nokey-1",
        content: "gork: why is the sky blue?",
      });

      // The pipeline must complete without throwing even with gork armed.
      await env.onMessageCreate(message);
      await sleep(500);
      assert.equal(replies.length, 0, "no AI key -> no reply at all");
      assert.equal(fetchMock.calls.length, 0, "no AI key -> no fetch calls");
      assert.equal(typing.calls, 0, "no AI key -> no typing indicator");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("keyword-alone reply: reply-chain walk + backfill reach the prompt", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse("Your keys, member. In the fridge, probably."),
    ]);
    try {
      enableAiKey();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_context_window: 10,
      });
      const ch = env.channels.general;
      // Backfill candidates (ids sort before the chain root "cA").
      ch.addMessage({
        id: "a1",
        content: "Morning all",
        author: { id: IDS.member2, username: "member2", tag: "member2#0000" },
        createdTimestamp: Date.now() - 30000,
      });
      ch.addMessage({
        id: "a2",
        content: "Did you lock the office?",
        author: { id: IDS.member, username: "member", tag: "member#0000" },
        createdTimestamp: Date.now() - 20000,
      });
      // Reply chain, also present in the channel cache.
      ch.addMessage({
        id: "cA",
        content: "I lost my keys",
        author: { id: IDS.member, username: "member", tag: "member#0000" },
        createdTimestamp: Date.now() - 10000,
      });
      ch.addMessage({
        id: "cB",
        content: "Has anyone seen my keys?",
        author: { id: IDS.member2, username: "member2", tag: "member2#0000" },
        createdTimestamp: Date.now() - 5000,
      });

      // The walk uses these reference objects (newest -> root).
      const chainA = {
        id: "cA",
        channelId: ch.id,
        content: "I lost my keys",
        author: { id: IDS.member, username: "member", tag: "member#0000" },
        reference: null,
        fetchReference: async () => {
          throw new Error("cA has no reference");
        },
      };
      const chainB = {
        id: "cB",
        channelId: ch.id,
        content: "Has anyone seen my keys?",
        author: { id: IDS.member2, username: "member2", tag: "member2#0000" },
        reference: { messageId: "cA" },
        fetchReference: async () => chainA,
      };

      attachTyping(ch);
      const { message, replies } = makeGorkMessage(env, {
        id: "t-chain-1",
        content: "gork", // keyword alone: answered from the reply-chain context
        reference: { messageId: "cB" },
        fetchReference: async () => chainB,
      });

      await env.onMessageCreate(message);
      const answered = await waitFor(() => replies.length >= 1);
      assert.ok(answered, "keyword-alone with a reply reference must be answered");
      assert.equal(
        replies[0].content,
        "Your keys, member. In the fridge, probably."
      );

      const body = JSON.parse(fetchMock.calls[0].init.body);
      const userMsg = body.messages.find((m) => m.role === "user");
      assert.ok(
        userMsg.content.includes(
          "The user sent only the keyword, replying to the message below"
        ),
        "keyword-alone prompt must use the fixed instruction"
      );
      // Context must be backfill (a1, a2) then chain root -> newest (cA, cB).
      const iA1 = userMsg.content.indexOf("[member2] Morning all");
      const iA2 = userMsg.content.indexOf("[member] Did you lock the office?");
      const iCA = userMsg.content.indexOf("[member] I lost my keys");
      const iCB = userMsg.content.indexOf("[member2] Has anyone seen my keys?");
      assert.ok(
        iA1 !== -1 && iA2 !== -1 && iCA !== -1 && iCB !== -1,
        `expected backfill + chain lines in the context, got: ${userMsg.content}`
      );
      // Spec order is oldest -> newest (roadmap/gork.md §7.2 decision 5).
      // KNOWN SRC BUG (reported, not fixed here): Discord's
      // GET /channels/{id}/messages returns messages newest -> oldest
      // (documented), but collectMessages() in src/features/gork/context.js
      // assumes the opposite — line 226 slices the OLDEST end of each page
      // (`fresh.slice(fresh.length - take)` takes the farthest-from-cursor
      // messages instead of the newest) and line 230 advances the cursor to
      // the NEWEST id (`values[0]`), so multi-page backfills re-read
      // overlapping pages (duplicate lines) and the final context comes out
      // newest -> oldest. This assertion fails until collectMessages is
      // fixed (take `fresh.slice(0, take)`; cursor = `values[values.length - 1].id`).
      assert.ok(
        iA1 < iA2 && iA2 < iCA && iCA < iCB,
        "context must be ordered oldest -> newest"
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("busy guild: queued request is answered in FIFO order", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    let releaseFirst;
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const fetchMock = mockFetch([
      async () => {
        await gate; // hold the in-flight slot so the second trigger queues
        return chatCompletionResponse("Answer A (first in flight).");
      },
      chatCompletionResponse("Answer B (was queued)."),
    ]);
    try {
      enableAiKey();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
      });
      const typing = attachTyping(env.channels.general);

      const { message: mA, replies: rA } = makeGorkMessage(env, {
        id: "t-fifo-a",
        content: "gork: question A",
        author: env.users.memberUser,
        member: env.members.member,
      });
      await env.onMessageCreate(mA);
      assert.ok(
        await waitFor(() => fetchMock.calls.length >= 1),
        "first trigger must start the LLM job"
      );
      const typingAfterA = typing.calls;

      // A different user so the per-user cooldown does not mask the queue.
      const { message: mB, replies: rB } = makeGorkMessage(env, {
        id: "t-fifo-b",
        content: "gork: question B",
        author: env.users.member2User,
        member: env.members.member2,
      });
      await env.onMessageCreate(mB);

      // Queued requests still start the typing indicator while waiting.
      assert.ok(
        await waitFor(() => typing.calls > typingAfterA),
        "queued request must start typing while it waits"
      );
      await sleep(200);
      assert.equal(
        rB.length,
        0,
        "queued request must not be answered before the first completes"
      );

      releaseFirst();
      assert.ok(
        await waitFor(() => rA.length >= 1 && rB.length >= 1, 5000),
        "both requests must be answered once the first completes"
      );
      assert.equal(rA[0].content, "Answer A (first in flight).");
      assert.equal(rB[0].content, "Answer B (was queued).");
      assert.equal(fetchMock.calls.length, 2, "one LLM call per request");

      // FIFO: A's completion went first, B's second.
      const bodyA = JSON.parse(fetchMock.calls[0].init.body);
      const bodyB = JSON.parse(fetchMock.calls[1].init.body);
      assert.ok(
        bodyA.messages.some(
          (m) => m.role === "user" && m.content.includes("question A")
        )
      );
      assert.ok(
        bodyB.messages.some(
          (m) => m.role === "user" && m.content.includes("question B")
        )
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("queue full: trigger beyond 1 in-flight + 5 waiting is dropped with the canned reply", async () => {
    const env = await createIntegrationEnv();
    // Same module instance the pipeline uses in this env (require cache).
    // The canned reply is exported from the trigger module (the feature
    // index only re-exports the handler surface).
    const { QUEUE_FULL_REPLY } = require("../../src/features/gork/trigger");
    const saved = saveEnv();
    let releaseFirst;
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    // The first fetch holds the in-flight slot; the other five resolve
    // immediately so the queue drains FIFO once the first completes.
    const fetchMock = mockFetch([
      async () => {
        await gate;
        return chatCompletionResponse("Answer 1");
      },
      chatCompletionResponse("Answer 2"),
      chatCompletionResponse("Answer 3"),
      chatCompletionResponse("Answer 4"),
      chatCompletionResponse("Answer 5"),
      chatCompletionResponse("Answer 6"),
    ]);
    try {
      enableAiKey();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
      });
      // The harness channel does not implement sendTyping; attach the spy so
      // the trigger's typing step does not throw.
      attachTyping(env.channels.general);

      // 7 distinct users (cooldown is per-user; concurrency is per-guild).
      const users = [env.users.memberUser, env.users.member2User];
      for (let i = 3; i <= 7; i += 1) {
        const u = env.createUser({
          id: `gork-q-user-${i}`,
          username: `queueuser${i}`,
        });
        const mem = env.createMember({ guild: env.guild, user: u, admin: false });
        env.guild.addMember(mem);
        users.push(u);
      }

      const entries = users.map((u, i) => {
        const { message, replies } = makeGorkMessage(env, {
          id: `t-full-${i + 1}`,
          content: `gork: question ${i + 1}`,
          author: u,
          member: env.guild.members.cache.get(u.id),
        });
        return { message, replies };
      });
      for (const { message } of entries) await env.onMessageCreate(message);

      // The 7th (queue full) is dropped with the locked canned reply.
      assert.ok(
        await waitFor(() => entries[6].replies.length >= 1),
        "7th trigger must receive the queue-full reply"
      );
      assert.equal(entries[6].replies[0].content, QUEUE_FULL_REPLY);

      // Only the first request is in flight; requests 2-6 are still queued
      // (the detached LLM jobs wait on their FIFO slot, so no fetch yet).
      assert.equal(
        fetchMock.calls.length,
        1,
        "only the first trigger runs the LLM while the rest are queued"
      );
      await sleep(200);
      assert.equal(
        entries.slice(0, 6).every((e) => e.replies.length >= 1),
        false,
        "queued triggers must not be answered before the first completes"
      );

      // Release the first: the five queued requests drain FIFO.
      releaseFirst();
      assert.ok(
        await waitFor(
          () => entries.slice(0, 6).every((e) => e.replies.length >= 1),
          5000
        ),
        "all queued triggers must be answered once the first completes"
      );
      assert.equal(
        fetchMock.calls.length,
        6,
        "one LLM call per admitted request"
      );
      for (let i = 0; i < 6; i += 1) {
        assert.equal(
          entries[i].replies[0].content,
          `Answer ${i + 1}`,
          `user ${i + 1} must be answered in FIFO order`
        );
      }
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("web search tool loop: web_search tool call -> SearXNG -> final answer", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([
      // 1) Model asks for a web search.
      chatCompletionResponse(null, {
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "web_search",
              arguments: '{"query":"node.js streams"}',
            },
          },
        ],
      }),
      // 2) SearXNG JSON results.
      jsonResponse({
        query: "node.js streams",
        results: [
          {
            title: "Node.js Streams",
            url: "https://nodejs.org/docs/latest/api/stream.html",
            content:
              "Streams are Node.js objects for sequential reading and writing of data.",
          },
          {
            title: "Backpressure",
            url: "https://example.com/backpressure",
            content: "Backpressure is flow control in streaming pipelines.",
          },
        ],
      }),
      // 3) Final answer informed by the search.
      chatCompletionResponse(
        "Node streams are backpressure-aware pipes: you process data sequentially instead of buffering it all."
      ),
    ]);
    try {
      enableAiKey();
      // Clearly fake placeholder for the reserved .test TLD — no real host.
      process.env.SEARXNG_URL = "https://searxng.test";
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_search_enabled: 1,
      });
      const typing = attachTyping(env.channels.general);
      const { message, replies } = makeGorkMessage(env, {
        id: "t-search-1",
        content: "gork: how do node.js streams work?",
      });

      await env.onMessageCreate(message);
      const answered = await waitFor(() => replies.length >= 1, 3000);
      assert.ok(answered, "expected a reply after the tool loop");
      assert.equal(
        replies[0].content,
        "Node streams are backpressure-aware pipes: you process data sequentially instead of buffering it all."
      );
      assert.ok(typing.calls >= 1, "typing indicator must start");

      assert.equal(
        fetchMock.calls.length,
        3,
        "expected chat -> search -> chat round trips"
      );
      const [c1, c2, c3] = fetchMock.calls;
      assert.match(c1.url, /\/chat\/completions$/);
      assert.equal(
        c2.url,
        "https://searxng.test/search?q=node.js%20streams&format=json"
      );
      assert.match(c3.url, /\/chat\/completions$/);

      // The second chat call must carry the SearXNG result back to the model.
      const body2 = JSON.parse(c3.init.body);
      const toolMsg = body2.messages.find((m) => m.role === "tool");
      assert.ok(toolMsg, "expected the SearXNG result fed back as a tool message");
      assert.ok(toolMsg.content.includes("Node.js Streams"));
      assert.ok(
        toolMsg.content.includes("https://nodejs.org/docs/latest/api/stream.html")
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("read_page tool: model browses pages, answer is grounded in page content", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    // Public IPv4 literal: the SSRF guard validates it without DNS, so the
    // test is deterministic and never resolves real hostnames.
    const PAGE_URL = "http://93.184.216.34/center-div";
    const PAGE_HTML = [
      "<!DOCTYPE html><html><head><title>Centering a div</title>",
      '<script>var evil="SCRIPT-SHOULD-VANISH";</script></head>',
      "<body><nav>NAV-SHOULD-VANISH</nav>",
      "<article><h1>Centering a div</h1>",
      `<p>${"Use flexbox on the container. ".repeat(30)}</p>`,
      `<p>${"Set display flex and justify-content center. ".repeat(10)}</p>`,
      "</article></body></html>",
    ].join("\n");
    const fetchMock = mockFetch([
      // 1) model calls read_page with the page URL
      chatCompletionResponse(null, {
        tool_calls: [
          {
            id: "call_read",
            type: "function",
            function: {
              name: "read_page",
              arguments: JSON.stringify({ urls: [PAGE_URL] }),
            },
          },
        ],
      }),
      // 2) the page itself
      async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (name) =>
            String(name).toLowerCase() === "content-type"
              ? "text/html; charset=utf-8"
              : null,
        },
        text: async () => PAGE_HTML,
      }),
      // 3) grounded final answer
      chatCompletionResponse(
        "Flex container with justify-content center — per the docs page."
      ),
    ]);
    try {
      enableAiKey();
      process.env.SEARXNG_URL = "https://searxng.test";
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        audit_log_channel_id: IDS.channelLog,
      });
      attachTyping(env.channels.general);

      const { message, replies } = makeGorkMessage(env, {
        id: "t-readpage-1",
        content: "gork: how do I center a div?",
      });
      await env.onMessageCreate(message);

      assert.ok(
        await waitFor(() => replies.length >= 1, 5000),
        "expected the read-page grounded answer"
      );
      assert.match(replies[0].content, /flex container/i);

      // Two chat calls + exactly one page fetch of the resolved URL.
      const chat = fetchMock.calls.filter((c) =>
        c.url.includes("/chat/completions")
      );
      const page = fetchMock.calls.filter((c) => c.url === PAGE_URL);
      assert.equal(chat.length, 2, "two chat round trips");
      assert.equal(page.length, 1, "the tool fetched the page once");

      // Both tools offered to the model when search is enabled.
      const firstBody = JSON.parse(chat[0].init.body);
      const toolNames = (firstBody.tools || [])
        .map((t) => t.function.name)
        .sort();
      assert.deepEqual(toolNames, ["read_page", "web_search"]);

      // Extracted page content entered the conversation as a tool result;
      // scripts/nav stripped by extraction.
      const secondBody = JSON.parse(chat[1].init.body);
      const toolMsg = secondBody.messages.find((m) => m.role === "tool");
      assert.ok(toolMsg, "tool result must feed the second chat call");
      assert.ok(
        toolMsg.content.includes("Centering a div"),
        `tool block carries title: ${toolMsg.content.slice(0, 120)}`
      );
      assert.ok(toolMsg.content.includes("Use flexbox on the container."));
      assert.ok(
        !toolMsg.content.includes("SCRIPT-SHOULD-VANISH"),
        "script content must be stripped"
      );
      assert.ok(
        !toolMsg.content.includes("NAV-SHOULD-VANISH"),
        "nav must be stripped"
      );

      // Audit records page reads separately from searches.
      assert.ok(
        await waitFor(() => env.channels.log.sent.length >= 1),
        "expected the Q&A audit embed"
      );
      const auditText = embedText(env.channels.log.sent[0].embeds[0]);
      assert.ok(
        auditText.includes("yes — 1 page read"),
        `audit tools field must count the page read only: ${auditText}`
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("/setgork keyword + search update settings; /settings reflects them", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    clearAiKey(); // config commands do not need the AI key
    try {
      // keyword: set
      let ixn = await env.runCommand({
        commandName: "setgork",
        subcommand: "keyword",
        admin: true,
        options: { keyword: "ask" },
      });
      assertEphemeralReply(ixn);
      assertReplyContains(ixn, "ask");
      assert.equal(env.db.getGuildSettings(env.guild.id).gork_keyword, "ask");

      // Reflected in /settings (Gork field).
      let settings = await env.runCommand({
        commandName: "settings",
        admin: true,
      });
      assertEphemeralReply(settings);
      let text = embedText(
        settings.replies[settings.replies.length - 1].embeds[0]
      );
      assert.ok(text.includes("Gork"));
      assert.ok(text.includes("Keyword **ask**"));

      // search: off
      ixn = await env.runCommand({
        commandName: "setgork",
        subcommand: "search",
        admin: true,
        options: { search: "off" },
      });
      assertEphemeralReply(ixn);
      assert.equal(env.db.getGuildSettings(env.guild.id).gork_search_enabled, 0);
      settings = await env.runCommand({ commandName: "settings", admin: true });
      text = embedText(settings.replies[settings.replies.length - 1].embeds[0]);
      assert.ok(text.includes("Search **off**"));

      // keyword: clear (disable)
      ixn = await env.runCommand({
        commandName: "setgork",
        subcommand: "keyword",
        admin: true,
        options: { keyword: "clear" },
      });
      assertEphemeralReply(ixn);
      assertReplyContains(ixn, /disabled/i);
      assert.equal(env.db.getGuildSettings(env.guild.id).gork_keyword, null);
      settings = await env.runCommand({ commandName: "settings", admin: true });
      text = embedText(settings.replies[settings.replies.length - 1].embeds[0]);
      assert.ok(text.includes("Keyword **disabled**"));

      // Non-staff is denied and the stored settings stay unchanged.
      const denied = await env.runCommand({
        commandName: "setgork",
        subcommand: "keyword",
        admin: false,
        user: env.users.memberUser,
        options: { keyword: "nope" },
      });
      assertEphemeralReply(denied, /permission/i);
      assert.equal(env.db.getGuildSettings(env.guild.id).gork_keyword, null);
    } finally {
      restoreEnv(saved);
    }
  });

  it("open ticket channel: keyword trigger is silently skipped", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([]); // any call rejects
    try {
      enableAiKey();
      env.db.updateGuildSettings(env.guild.id, { gork_keyword: "gork" });

      const ch = env.createTextChannel({
        id: "channel-ticket-gork",
        guild: env.guild,
        name: "ticket-gork",
      });
      env.guild.addChannel(ch);
      env.db.createTicket({
        guildId: env.guild.id,
        creatorUserId: IDS.member,
        channelId: ch.id,
        reason: "gork skip check",
      });
      assert.ok(
        env.db.getTicketByChannel(ch.id),
        "ticket row must exist for the channel"
      );

      const typing = attachTyping(ch);
      const { message, replies } = makeGorkMessage(env, {
        id: "t-ticket-1",
        content: "gork: why is the sky blue?",
        channel: ch,
      });
      await env.onMessageCreate(message);
      await sleep(500);
      assert.equal(
        replies.length,
        0,
        "gork must not reply inside an open ticket channel"
      );
      assert.equal(
        fetchMock.calls.length,
        0,
        "no LLM call in an open ticket channel"
      );
      assert.equal(typing.calls, 0, "no typing indicator in an open ticket channel");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("tickets AI regression: /ticket summarize works through the extracted src/core/ai.js", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const aiJson = JSON.stringify({
      resolution: "Mic fixed after restart",
      summary:
        "Member reported no audio output; resolved after restarting the client.",
    });
    const fetchMock = mockFetch([chatCompletionResponse(aiJson)]);
    try {
      enableAiKey();

      const opened = await env.runCommand({
        commandName: "ticket",
        subcommand: "for",
        admin: true,
        options: { user: env.users.memberUser, reason: "ai-summary-regression" },
      });
      assertReplyContains(opened, /opened|Ticket/i);
      const open = env.db.listOpenTickets(env.guild.id, {
        userId: IDS.member,
        limit: 10,
      });
      const row = open.find((t) => t.reason === "ai-summary-regression");
      assert.ok(row, "expected the staff-opened ticket");
      const ch = env.guild.channels.cache.get(row.channel_id);
      assert.ok(ch, "expected the ticket channel");
      ch.addMessage({
        id: "tix-m1",
        content: "My microphone is not working at all",
        author: { id: IDS.member, username: "member", tag: "member#0000" },
        createdTimestamp: Date.now() - 5000,
      });

      const res = await env.runCommand({
        commandName: "ticket",
        subcommand: "summarize",
        admin: true,
        channelId: row.channel_id,
      });
      // The handler defers ephemerally, then editReply inherits the original
      // reply's visibility (see editEphemeral in src/core/interaction.js),
      // which the harness fake cannot represent — assert the embed content.
      const text = embedText(res.replies[res.replies.length - 1].embeds[0]);
      assert.ok(
        text.includes("resolved after restarting the client"),
        `expected the AI summary text, got: ${text}`
      );
      assert.ok(text.includes("Mic fixed after restart"));
      assert.ok(
        text.includes("AI summary (model: gpt-4o-mini)"),
        "summary source must report the AI model"
      );

      assert.equal(fetchMock.calls.length, 1, "exactly one AI round trip");
      assert.match(fetchMock.calls[0].url, /\/chat\/completions$/);
      const body = JSON.parse(fetchMock.calls[0].init.body);
      assert.deepEqual(body.response_format, { type: "json_object" });
      const userMsg = body.messages.find((m) => m.role === "user");
      assert.ok(
        userMsg.content.includes("microphone"),
        "the ticket transcript must feed the prompt"
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });
});
