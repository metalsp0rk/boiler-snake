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
const { IDS, uniqueId } = require("../helpers/fixtures");

/** Locked canned failure reply (from the trigger module). */
const { LLM_FAILURE_REPLY } = require("../../src/features/gork/trigger");

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
  "GORK_LLM_MAX_TOKENS",
  "GORK_LLM_TIMEOUT_MS",
  "GORK_LLM_MAX_TOOL_ROUNDS",
  "GORK_LLM_THINKING_TOKEN_BUDGET",
  "GORK_MAX_ANSWER_CHARS",
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
  // Explicit finish_reason override (Fix 6: e.g. "length" for a
  // reasoning-truncated blank answer); existing callers unchanged.
  const { finish_reason: fr, ...msgExtra } = messageExtra;
  return jsonResponse({
    id: "chatcmpl-test-1",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, ...msgExtra },
        finish_reason: fr ?? (msgExtra.tool_calls ? "tool_calls" : "stop"),
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
 * trigger replies TO the keyword message), `react` (clock reaction on a
 * cooldown hit), `memberPermissions`, and an optional reply `reference` /
 * `fetchReference` for the chain-walk path.
 *
 * @returns {{ message: object, replies: object[], reacts: string[] }}
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
  const reacts = [];
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
    react: async (emoji) => {
      reacts.push(emoji);
      return { emoji };
    },
    delete: async () => {
      message.deleted = true;
    },
    _wasDeleted: () => message.deleted,
  };
  return { message, replies, reacts };
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

  it("per-user cooldown: second trigger inside the window gets the clock reaction (no reply, no fetch)", async () => {
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

      const { message: m1, replies: r1, reacts: c1 } = makeGorkMessage(env, {
        id: "t-cd-1",
        content: "gork: first question",
      });
      await env.onMessageCreate(m1);
      assert.ok(
        await waitFor(() => r1.length >= 1),
        "first trigger must be answered"
      );
      assert.deepEqual(
        c1,
        [],
        "an allowed trigger must not get the cooldown reaction"
      );

      const { message: m2, replies: r2, reacts: c2 } = makeGorkMessage(env, {
        id: "t-cd-2",
        content: "gork: second question",
      });
      await env.onMessageCreate(m2);
      assert.ok(
        await waitFor(() => c2.length >= 1),
        "cooldown hit must react with the clock emoji"
      );
      assert.deepEqual(c2, ["🕐"], "exactly one clock reaction on a hit");
      await sleep(250); // give any erroneous reply/second react room to land
      assert.equal(
        r2.length,
        0,
        "second trigger inside the cooldown must not reply"
      );
      assert.equal(c2.length, 1, "exactly one reaction on a cooldown hit");
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

      const { message: m1, replies: r1, reacts: c1 } = makeGorkMessage(env, {
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

      const { message: m2, replies: r2, reacts: c2 } = makeGorkMessage(env, {
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
      assert.deepEqual(
        [...c1, ...c2],
        [],
        "staff bypass means the clock reaction never fires"
      );
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
      // Regression guard: Discord returns pages newest -> oldest;
      // collectMessages() must take the newest end of each page and walk
      // the cursor backwards, or this order flips / duplicates appear.
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

  it("/gork keyword + search update settings; /settings reflects them", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    clearAiKey(); // config commands do not need the AI key
    try {
      // keyword: set
      let ixn = await env.runCommand({
        commandName: "gork",
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
        commandName: "gork",
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
        commandName: "gork",
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
        commandName: "gork",
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

  it("/gork ban/unban/bans: staff-gated command flow with db state + audit", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    clearAiKey(); // config commands do not need the AI key
    try {
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        audit_log_channel_id: IDS.channelLog,
      });

      // ban: stores a per-guild block, replies ephemerally
      let ixn = await env.runCommand({
        commandName: "gork",
        subcommand: "ban",
        admin: true,
        options: { user: env.users.memberUser },
      });
      assertEphemeralReply(ixn);
      assertReplyContains(ixn, /banned from gork/i);
      assert.equal(env.db.isGorkBlocked(env.guild.id, IDS.member), true);

      // bans: lists the blocked user
      ixn = await env.runCommand({
        commandName: "gork",
        subcommand: "bans",
        admin: true,
      });
      assertEphemeralReply(ixn);
      assertReplyContains(ixn, `<@${IDS.member}>`);
      assertReplyContains(ixn, /1\)/);

      // unban: removes the block
      ixn = await env.runCommand({
        commandName: "gork",
        subcommand: "unban",
        admin: true,
        options: { user: env.users.memberUser },
      });
      assertEphemeralReply(ixn);
      assertReplyContains(ixn, /can use gork again/i);
      assert.equal(env.db.isGorkBlocked(env.guild.id, IDS.member), false);

      // unban again: reports "not banned" (idempotent UX)
      ixn = await env.runCommand({
        commandName: "gork",
        subcommand: "unban",
        admin: true,
        options: { user: env.users.memberUser },
      });
      assertEphemeralReply(ixn);
      assertReplyContains(ixn, /not banned/i);

      // bans when empty: friendly empty state
      ixn = await env.runCommand({
        commandName: "gork",
        subcommand: "bans",
        admin: true,
      });
      assertEphemeralReply(ixn);
      assertReplyContains(ixn, /no users are banned/i);

      // bots are rejected (they never trigger gork anyway)
      ixn = await env.runCommand({
        commandName: "gork",
        subcommand: "ban",
        admin: true,
        options: { user: env.users.botUser },
      });
      assertEphemeralReply(ixn);
      assertReplyContains(ixn, /bots can't be banned/i);
      assert.equal(env.db.isGorkBlocked(env.guild.id, IDS.bot), false);

      // Non-staff is denied and stores nothing.
      const denied = await env.runCommand({
        commandName: "gork",
        subcommand: "ban",
        admin: false,
        user: env.users.memberUser,
        options: { user: env.users.member2User },
      });
      assertEphemeralReply(denied, /permission/i);
      assert.equal(env.db.isGorkBlocked(env.guild.id, IDS.member2), false);

      // Audit trail recorded the ban + unban (not the failed attempts).
      assert.ok(
        await waitFor(() => env.channels.log.sent.length >= 2),
        "expected ban + unban audit embeds"
      );
      const auditAll = env.channels.log.sent
        .map((p) => embedText(p.embeds?.[0]))
        .join("\n");
      assert.ok(auditAll.includes("Gork user banned"), auditAll);
      assert.ok(auditAll.includes("Gork user unbanned"), auditAll);
      assert.ok(auditAll.includes(`/gork ban`), auditAll);
    } finally {
      restoreEnv(saved);
    }
  });

  it("/gork enable off silences triggers (settings preserved); on restores; /settings reflects it", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const script = [];
    const fetchMock = mockFetch(script);
    try {
      enableAiKey();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 45,
      });
      attachTyping(env.channels.general);

      // Command: disable the whole feature for the guild.
      const off = await env.runCommand({
        commandName: "gork",
        subcommand: "enable",
        admin: true,
        options: { enable: "off" },
      });
      assertEphemeralReply(off);
      assertReplyContains(off, /disabled/i);
      const disabled = env.db.getGuildSettings(env.guild.id);
      assert.equal(disabled.gork_enabled, 0);
      assert.equal(disabled.gork_keyword, "gork", "disable preserves the keyword");
      assert.equal(
        disabled.gork_cooldown_sec,
        45,
        "disable preserves unrelated settings"
      );

      // /settings shows the disabled state.
      const settings = await env.runCommand({
        commandName: "settings",
        admin: true,
      });
      const settingsText = embedText(
        settings.replies[settings.replies.length - 1].embeds[0]
      );
      assert.match(settingsText, /Gork[\s\S]*disabled/i);

      // Trigger while disabled: fully silent (no reply, no fetch, no typing).
      const { message, replies } = makeGorkMessage(env, {
        id: "t-off-1",
        content: "gork: why is the sky blue?",
      });
      await env.onMessageCreate(message);
      await sleep(500);
      assert.equal(replies.length, 0, "disabled gork must not reply");
      assert.equal(fetchMock.calls.length, 0, "disabled gork must not call the LLM");

      // Command: re-enable, and triggers answer again (keyword survived).
      const on = await env.runCommand({
        commandName: "gork",
        subcommand: "enable",
        admin: true,
        options: { enable: "on" },
      });
      assertEphemeralReply(on);
      assertReplyContains(on, /enabled/i);
      assert.equal(env.db.getGuildSettings(env.guild.id).gork_enabled, 1);

      script.push(chatCompletionResponse("Rayleigh scattering, member."));
      const { message: m2, replies: r2 } = makeGorkMessage(env, {
        id: "t-off-2",
        content: "gork: why is the sky blue?",
      });
      await env.onMessageCreate(m2);
      assert.ok(
        await waitFor(() => r2.length >= 1),
        "re-enabled gork must answer again"
      );
      assert.equal(r2[0].content, "Rayleigh scattering, member.");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("banned user trigger: generic lunch reply, no LLM call; staff binds too; unban restores", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const script = [];
    const fetchMock = mockFetch(script);
    try {
      enableAiKey();
      // Cooldown 0 so repeated triggers from the same user are not masked.
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
      });
      const typing = attachTyping(env.channels.general);

      const LUNCH = "*gork's brain went to lunch* — try again in a bit.";

      // Regular banned user: exactly the vague failure reply, no LLM call.
      env.db.addGorkBlock(env.guild.id, IDS.member, IDS.admin);
      const { message: m1, replies: r1 } = makeGorkMessage(env, {
        id: "t-ban-1",
        content: "gork: why is the sky blue?",
      });
      await env.onMessageCreate(m1);
      assert.ok(
        await waitFor(() => r1.length >= 1),
        "banned trigger must get the canned reply"
      );
      assert.equal(r1[0].content, LUNCH, "ban must be disguised as a failure");
      assert.equal(fetchMock.calls.length, 0, "banned trigger must skip the LLM");
      assert.equal(typing.calls, 0, "banned trigger must not type");

      // Banned staff member: staff status does NOT bypass the ban.
      env.db.addGorkBlock(env.guild.id, IDS.admin, IDS.admin);
      const { message: m2, replies: r2 } = makeGorkMessage(env, {
        id: "t-ban-2",
        content: "gork: admin question",
        author: env.users.adminUser,
        member: env.members.adminMember,
      });
      await env.onMessageCreate(m2);
      assert.ok(
        await waitFor(() => r2.length >= 1),
        "banned staff trigger must get the canned reply"
      );
      assert.equal(r2[0].content, LUNCH);
      assert.equal(fetchMock.calls.length, 0, "banned staff must skip the LLM too");

      // Nothing QA-audited for banned triggers (they never reach the LLM).
      assert.equal(
        env.channels.log.sent.length,
        0,
        "banned triggers must not appear in the audit channel"
      );

      // Unban restores normal answering.
      env.db.removeGorkBlock(env.guild.id, IDS.member);
      script.push(chatCompletionResponse("Rayleigh scattering strikes again."));
      const { message: m3, replies: r3 } = makeGorkMessage(env, {
        id: "t-ban-3",
        content: "gork: why is the sky blue?",
      });
      await env.onMessageCreate(m3);
      assert.ok(
        await waitFor(() => r3.length >= 1),
        "unbanned trigger must be answered again"
      );
      assert.equal(r3[0].content, "Rayleigh scattering strikes again.");
      assert.equal(fetchMock.calls.length, 1, "exactly the unbanned trigger hit the LLM");
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

  // ---------- roadmap/gork.md §7.15 regression fixtures (Fixes 1–4) ----------

  it("Fix 1+2: echoed <@id> markup is sanitized, never pings, and the roster reaches the prompt", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse(
        `Ask <@${IDS.member2}> — <@${IDS.member2}> broke it.`
      ),
    ]);
    try {
      enableAiKey();
      env.db.updateGuildSettings(env.guild.id, { gork_keyword: "gork" });
      const ch = env.channels.general;
      ch.addMessage({
        id: "a1",
        content: "I totally broke the build",
        author: { id: IDS.member2, username: "member2", tag: "member2#0000" },
        createdTimestamp: Date.now() - 5000,
      });
      attachTyping(ch);

      const { message, replies } = makeGorkMessage(env, {
        id: "t-sanitize-1",
        content: `gork: who broke it? <@${IDS.member2}>`,
      });
      await env.onMessageCreate(message);
      assert.ok(
        await waitFor(() => replies.length >= 1),
        "expected the sanitized answer"
      );

      // Raw markup gone; resolved handle rendered instead.
      assert.ok(
        !replies[0].content.includes("<@"),
        `reply must not carry raw mention tokens: ${replies[0].content}`
      );
      assert.ok(replies[0].content.includes("@member2"), replies[0].content);

      // Ping control on the actual send payload.
      const sentPayload = ch.sent.find((p) => typeof p === "object" && p);
      assert.ok(sentPayload, "reply must be sent as a payload object");
      assert.deepEqual(sentPayload.allowedMentions, { parse: [] });

      // Fix 2: the prompt carried a roster naming the involved users.
      const body = JSON.parse(fetchMock.calls[0].init.body);
      const userMsg = body.messages.find((m) => m.role === "user");
      assert.ok(userMsg.content.includes("People roster:"), userMsg.content);
      assert.ok(
        userMsg.content.includes(`${IDS.member2} | @member2 |`),
        "roster must list the mentioned/authoring user",
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("Fix 3: trigger replying to a deleted message answers via backfill (no crash, slot released)", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse("Nothing survives deletion, member."),
    ]);
    try {
      enableAiKey();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
      });
      const ch = env.channels.general;
      ch.addMessage({
        id: "a1",
        content: "Ancient context before the deletion",
        author: { id: IDS.member2, username: "member2", tag: "member2#0000" },
        createdTimestamp: Date.now() - 5000,
      });
      attachTyping(ch);

      const { message, replies } = makeGorkMessage(env, {
        id: "t-deleted-1",
        content: "gork: what was said here?",
        reference: { messageId: "deleted-ref" },
        fetchReference: async () => {
          throw new Error("404 Unknown Message");
        },
      });
      await env.onMessageCreate(message);
      assert.ok(
        await waitFor(() => replies.length >= 1),
        "deleted reference must degrade to backfill context, not crash"
      );
      assert.equal(replies[0].content, "Nothing survives deletion, member.");
      const body = JSON.parse(fetchMock.calls[0].init.body);
      const userMsg = body.messages.find((m) => m.role === "user");
      assert.ok(
        userMsg.content.includes("[member2] Ancient context before the deletion"),
        "backfill context must still feed the prompt",
      );

      // The guild slot was released: the degraded job must not leak it.
      const { gorkQueue } = require("../../src/features/gork/trigger");
      assert.equal(
        gorkQueue.admit({ guildId: env.guild.id }).queued,
        false,
        "the guild slot must be free after the degraded job",
      );
      gorkQueue.release({ guildId: env.guild.id });
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("Fix 4: emoji-heavy >2000-char answer splits safely (valid text, whole tokens, continuations sent)", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const heavy =
      "Long one: " +
      "\u{1F600}".repeat(1000) +
      " ||secret|| " +
      "```\nconst x = '<@123456789012345678> '\n```".repeat(3) +
      " done \u{1F389}".repeat(50);
    const fetchMock = mockFetch([chatCompletionResponse(heavy)]);
    try {
      enableAiKey();
      env.db.updateGuildSettings(env.guild.id, { gork_keyword: "gork" });
      attachTyping(env.channels.general);

      const { message, replies } = makeGorkMessage(env, {
        id: "t-emoji-1",
        content: "gork: say something long and colorful",
      });
      await env.onMessageCreate(message);
      assert.ok(
        await waitFor(() => replies.length >= 1),
        "expected the first chunk"
      );

      const sentPayloads = ch_all_sent(env);
      assert.ok(
        sentPayloads.length >= 2,
        "long answer must continue as consecutive messages"
      );

      const contents = sentPayloads.map((p) => p.content);
      let joined = "";
      for (const c of contents) {
        assert.ok(c.length <= 2000, `chunk within Discord's limit: ${c.length}`);
        assert.ok(
          !hasLoneSurrogate(c),
          "chunk must be valid UTF-16 (no split emoji)"
        );
        joined += c;
      }
      assert.ok(joined.includes("\u{1F600}"), "emoji survived");
      assert.ok(joined.includes("done \u{1F389}"), "tail survived");
      assert.ok(
        !/(^|[^`<])\|\|(?!.*\|\|)/s.test(contents[0]) ||
          (contents[0].match(/\|\|/g) || []).length % 2 === 0,
        "no dangling spoiler marker at a chunk boundary"
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("Fix 5: ok-with-empty-text is retried once; the retry's answer is delivered", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse(null), // thinking-model blank response
      chatCompletionResponse("NetBSD 1.3, obviously, member."),
    ]);
    try {
      enableAiKey();
      env.db.updateGuildSettings(env.guild.id, { gork_keyword: "gork" });
      attachTyping(env.channels.general);

      const { message, replies } = makeGorkMessage(env, {
        id: "t-empty-1",
        content: "gork: best unix for a 386?",
      });
      await env.onMessageCreate(message);
      assert.ok(
        await waitFor(() => replies.length >= 1, 4000),
        "the retry answer must reach the channel"
      );
      assert.equal(replies[0].content, "NetBSD 1.3, obviously, member.");
      assert.equal(fetchMock.calls.length, 2, "exactly one retry, no more");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("Fix 5: empty twice -> canned reply + audit says 'empty answer' (not 'unknown')", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse(null),
      chatCompletionResponse(null),
    ]);
    try {
      enableAiKey();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        audit_log_channel_id: IDS.channelLog,
      });
      attachTyping(env.channels.general);

      const { message, replies } = makeGorkMessage(env, {
        id: "t-empty-2",
        content: "gork: best unix for a 386?",
      });
      await env.onMessageCreate(message);
      assert.ok(
        await waitFor(() => replies.length >= 1, 4000),
        "a canned reply must still be sent"
      );
      assert.equal(replies[0].content, LLM_FAILURE_REPLY);
      assert.equal(fetchMock.calls.length, 2, "one retry attempted");

      assert.ok(
        await waitFor(() => env.channels.log.sent.length >= 1),
        "expected the failure audit one-liner"
      );
      const auditText = embedText(env.channels.log.sent[0].embeds[0]);
      assert.ok(
        auditText.includes("empty answer"),
        `audit must name the real cause: ${auditText}`,
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("Fix 5: tool-round cap with real content delivers the partial answer (not the canned reply)", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const toolCall = (id) =>
      chatCompletionResponse(null, {
        tool_calls: [
          {
            id,
            type: "function",
            function: { name: "web_search", arguments: '{"query":"unix 386"}' },
          },
        ],
      });
    const emptyResults = jsonResponse({ query: "unix 386", results: [] });
    const fetchMock = mockFetch([
      toolCall("c1"), emptyResults,
      toolCall("c2"), emptyResults,
      toolCall("c3"), emptyResults,
      // 4th round still wants a tool -> budget cap; content is the partial answer.
      chatCompletionResponse("Half an answer: NetBSD runs on anything.", {
        tool_calls: [
          {
            id: "c4",
            type: "function",
            function: { name: "web_search", arguments: '{"query":"unix 386 again"}' },
          },
        ],
      }),
    ]);
    try {
      enableAiKey();
      process.env.SEARXNG_URL = "https://searxng.test";
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_search_enabled: 1,
      });
      attachTyping(env.channels.general);

      const { message, replies } = makeGorkMessage(env, {
        id: "t-cap-1",
        content: "gork: best unix for a 386?",
      });
      await env.onMessageCreate(message);
      assert.ok(
        await waitFor(() => replies.length >= 1, 5000),
        "the capped partial answer must be delivered"
      );
      assert.notEqual(replies[0].content, LLM_FAILURE_REPLY);
      assert.match(replies[0].content, /NetBSD runs on anything/);
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("Fix 6: thinking budget opt-in lands in the payload (+ max_tokens default 6000)", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse("Poem: ones are better off in Plan 9."),
    ]);
    try {
      enableAiKey();
      // Deterministic knobs: defaults everywhere, budget explicitly set.
      delete process.env.GORK_LLM_MAX_TOKENS;
      delete process.env.GORK_LLM_TIMEOUT_MS;
      delete process.env.GORK_LLM_MAX_TOOL_ROUNDS;
      delete process.env.GORK_MAX_ANSWER_CHARS;
      process.env.GORK_LLM_THINKING_TOKEN_BUDGET = "4000";
      env.db.updateGuildSettings(env.guild.id, { gork_keyword: "gork" });
      attachTyping(env.channels.general);

      const { message, replies } = makeGorkMessage(env, {
        id: "t-budget-1",
        content: "gork: write me a poem about 386s",
      });
      await env.onMessageCreate(message);
      assert.ok(
        await waitFor(() => replies.length >= 1, 4000),
        "expected the answer to reach the channel"
      );
      const body = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(
        body.thinking_token_budget,
        4000,
        "opt-in thinking cap must reach the provider"
      );
      assert.equal(body.max_tokens, 6000, "Fix 6 default completion budget");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("Fix 6: budget unset -> thinking_token_budget never appears in the payload", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse("Strict providers stay happy."),
    ]);
    try {
      enableAiKey();
      delete process.env.GORK_LLM_MAX_TOKENS;
      delete process.env.GORK_LLM_TIMEOUT_MS;
      delete process.env.GORK_LLM_MAX_TOOL_ROUNDS;
      delete process.env.GORK_LLM_THINKING_TOKEN_BUDGET;
      delete process.env.GORK_MAX_ANSWER_CHARS;
      env.db.updateGuildSettings(env.guild.id, { gork_keyword: "gork" });
      attachTyping(env.channels.general);

      const { message, replies } = makeGorkMessage(env, {
        id: "t-budget-2",
        content: "gork: best unix for a 386?",
      });
      await env.onMessageCreate(message);
      assert.ok(
        await waitFor(() => replies.length >= 1, 4000),
        "expected the answer to reach the channel"
      );
      const body = JSON.parse(fetchMock.calls[0].init.body);
      assert.ok(
        !("thinking_token_budget" in body),
        "0/unset budget = the param must NOT be sent (strict-provider safety)"
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("Fix 6: empty twice with finish_reason=length -> canned reply + diagnostics in audit", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse(null, { finish_reason: "length" }),
      chatCompletionResponse(null, { finish_reason: "length" }),
    ]);
    try {
      enableAiKey();
      delete process.env.GORK_LLM_MAX_TOKENS;
      delete process.env.GORK_LLM_TIMEOUT_MS;
      delete process.env.GORK_LLM_MAX_TOOL_ROUNDS;
      delete process.env.GORK_LLM_THINKING_TOKEN_BUDGET;
      delete process.env.GORK_MAX_ANSWER_CHARS;
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        audit_log_channel_id: IDS.channelLog,
      });
      attachTyping(env.channels.general);

      const { message, replies } = makeGorkMessage(env, {
        id: "t-empty-3",
        content: "gork: write me a poem about 386s",
      });
      await env.onMessageCreate(message);
      assert.ok(
        await waitFor(() => replies.length >= 1, 4000),
        "a canned reply must still be sent"
      );
      assert.equal(replies[0].content, LLM_FAILURE_REPLY);
      assert.equal(fetchMock.calls.length, 2, "one retry attempted");

      assert.ok(
        await waitFor(() => env.channels.log.sent.length >= 1),
        "expected the failure audit one-liner"
      );
      const auditText = embedText(env.channels.log.sent[0].embeds[0]);
      assert.ok(
        auditText.includes("empty answer"),
        `audit must name the empty answer: ${auditText}`
      );
      assert.ok(
        auditText.includes("finish_reason=length"),
        `audit must surface the provider finish reason: ${auditText}`
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("Fix 6: GORK_MAX_ANSWER_CHARS caps the visible answer to one capped message", async () => {
    const env = await createIntegrationEnv();
    const saved = saveEnv();
    const long = "word ".repeat(200).trim(); // ~1000 chars, no line breaks
    const fetchMock = mockFetch([chatCompletionResponse(long)]);
    try {
      enableAiKey();
      delete process.env.GORK_LLM_MAX_TOKENS;
      delete process.env.GORK_LLM_TIMEOUT_MS;
      delete process.env.GORK_LLM_MAX_TOOL_ROUNDS;
      delete process.env.GORK_LLM_THINKING_TOKEN_BUDGET;
      process.env.GORK_MAX_ANSWER_CHARS = "300";
      env.db.updateGuildSettings(env.guild.id, { gork_keyword: "gork" });
      attachTyping(env.channels.general);

      const { message, replies } = makeGorkMessage(env, {
        id: "t-capped-1",
        content: "gork: list every word you know",
      });
      await env.onMessageCreate(message);
      assert.ok(
        await waitFor(() => replies.length >= 1, 4000),
        "expected the capped answer to reach the channel"
      );
      const sentPayloads = ch_all_sent(env);
      assert.equal(
        sentPayloads.length,
        1,
        "a capped answer must be exactly one message (no continuations)"
      );
      const content = sentPayloads[0].content;
      assert.ok(content.length <= 300, `content within cap: ${content.length}`);
      assert.ok(
        long.startsWith(content.slice(0, 100)),
        "capped answer keeps the original prefix",
      );
      assert.ok(
        content.endsWith("[truncated]"),
        `capped answer carries the marker: ${content.slice(-40)}`
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });
});

// ---------- roadmap/gork.md §7.16 community memory (§7.16 scenarios) ----------

/**
 * Fixed UTC afternoon (2026-09-09 12:00Z) for the §7.16 extraction trigger
 * message: mem_date is stamped server-side from the trigger message, so a
 * fixed createdTimestamp keeps the expected date deterministic no matter
 * when the suite runs.
 */
const MEM_TRIGGER_TS = Date.UTC(2026, 8, 9, 12, 0, 0);
const MEM_TRIGGER_DATE = "2026-09-09";

/**
 * Seed one gork memory row through the REAL db facade (real SQLite, the
 * same instance the trigger reads), returning {id} for assertions.
 */
function seedMemory(env, opts) {
  const title = opts.title;
  return env.db.gorkMemoryUpsert({
    guildId: env.guild.id,
    subjectUserId: opts.subjectUserId,
    memDate: opts.memDate || "2026-09-01",
    title,
    titleKey: opts.titleKey || title.toLowerCase().replace(/\s+/g, " ").trim(),
    body: opts.body,
    kind: opts.kind || "profile",
    importance: opts.importance ?? 3,
    sourceMessageIds: ["seed-msg-1"],
  });
}

/** Parsed payload when the recorded fetch is a gork-persona (answer-path) call. */
function qaBodyOf(call) {
  try {
    const body = JSON.parse(call.init.body);
    const sys = (body.messages || []).find((m) => m.role === "system");
    return sys && String(sys.content).includes("You are **Gork**") ? body : null;
  } catch {
    return null;
  }
}

/** Parsed payload when the recorded fetch is the §7.16.3 extraction turn. */
function extractionBodyOf(call) {
  try {
    const body = JSON.parse(call.init.body);
    const sys = (body.messages || []).find((m) => m.role === "system");
    return sys && /extract durable memories/i.test(String(sys.content))
      ? body
      : null;
  } catch {
    return null;
  }
}

describe("integration: gork community memory (§7.16)", () => {
  it("memory off (default): seeded rows stay fully inert — no block, no recall tool, no extraction turn", async () => {
    // Objective (decision 29): gork_memory_enabled defaults to 0 and the
    // feature must be byte-inert when off — even with rows seeded for the
    // asker, the prompt, the payload, the audit and the fetch count all
    // stay exactly what the memory-less path produces.
    const env = await createIntegrationEnv({ guildId: uniqueId("guild-memoff") });
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse("No memories required, member."),
    ]);
    try {
      enableAiKey();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
        audit_log_channel_id: IDS.channelLog,
        // gork_memory_enabled deliberately UNSET (column default = 0).
      });
      assert.equal(
        env.db.getGuildSettings(env.guild.id).gork_memory_enabled,
        0,
        "memory defaults to OFF"
      );

      // Inertness must come from the switch, not from an empty table.
      seedMemory(env, {
        subjectUserId: IDS.member,
        title: "Loves Rust",
        body: "Prefers Rust for CLI tools.",
        kind: "preference",
      });
      seedMemory(env, {
        subjectUserId: IDS.member,
        title: "Runs a bakery",
        body: "Opens the bakery at 5am.",
      });

      attachTyping(env.channels.general);
      const { message, replies } = makeGorkMessage(env, {
        id: "t-memoff-1",
        content: "gork: what do you know about me?",
      });
      await env.onMessageCreate(message);
      assert.ok(
        await waitFor(() => replies.length >= 1),
        "memory-off trigger must still be answered normally"
      );

      const body = JSON.parse(fetchMock.calls[0].init.body);
      const userMsg = body.messages.find((m) => m.role === "user");
      assert.ok(
        !userMsg.content.includes("What you remember"),
        `prompt must carry NO memory block: ${userMsg.content}`
      );
      assert.ok(
        !("tools" in body),
        "payload must carry NO tools array (recall_memories absent) when memory is off"
      );

      assert.ok(
        await waitFor(() => env.channels.log.sent.length >= 1),
        "expected the Q&A audit embed"
      );
      const auditText = embedText(env.channels.log.sent[0].embeds[0]);
      assert.ok(
        !auditText.includes("Memory"),
        `Q&A audit must have NO Memory field when off: ${auditText}`
      );

      // No extraction turn either: the fetch count never grows past the
      // single Q&A call the memory-off expectations already assert.
      await sleep(300);
      assert.equal(
        fetchMock.calls.length,
        1,
        "memory OFF ships no extraction request (Q&A call count unchanged)"
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("memory on: seeded rows inject '#id' lines, recall_memories rides the payload, Q&A audit gains a Memory label", async () => {
    // Objective (§7.16.2 read path): with memory ON and rows stored for
    // the asker, the user prompt carries the decision-21 header plus the
    // seeded `(#id)` lines (bodies mode fits the default 12k budget), the
    // request carries the recall tool, and the Q&A audit embed records the
    // read-side Memory label.
    const env = await createIntegrationEnv({ guildId: uniqueId("guild-memon") });
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse("I remember, member."),
      // Extraction turn (fires after the answer ships): nothing durable.
      chatCompletionResponse(JSON.stringify({ memories: [] })),
    ]);
    try {
      enableAiKey();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
        gork_memory_enabled: 1, // budget stays at the default 12000
        audit_log_channel_id: IDS.channelLog,
      });
      const rowA = seedMemory(env, {
        subjectUserId: IDS.member,
        title: "Loves Rust",
        body: "Prefers Rust for CLI tools.",
        kind: "preference",
        importance: 5,
      });
      const rowB = seedMemory(env, {
        subjectUserId: IDS.member,
        title: "Runs a bakery",
        body: "Opens the bakery at 5am.",
        importance: 4,
      });
      const rowC = seedMemory(env, {
        subjectUserId: IDS.member,
        memDate: "2026-08-15",
        title: "Shipped a bot",
        body: "Built the guild ticket bot.",
        kind: "event",
      });

      attachTyping(env.channels.general);
      const { message, replies } = makeGorkMessage(env, {
        id: "t-memread-1",
        content: "gork: what do you know about me?",
      });
      await env.onMessageCreate(message);
      assert.ok(
        await waitFor(() => replies.length >= 1),
        "memory-on trigger must be answered"
      );

      const body = JSON.parse(fetchMock.calls[0].init.body);
      const userMsg = body.messages.find((m) => m.role === "user");
      assert.ok(
        userMsg.content.includes("What you remember about these people"),
        `prompt must carry the decision-21 memory header: ${userMsg.content}`
      );
      for (const row of [rowA, rowB, rowC]) {
        assert.ok(
          userMsg.content.includes(`(#${row.id})`),
          `memory #${row.id} line must be injected: ${userMsg.content}`
        );
      }
      assert.ok(
        userMsg.content.includes('"Loves Rust"'),
        "titles render quoted in the block"
      );
      assert.ok(
        userMsg.content.includes("Prefers Rust for CLI tools."),
        "bodies mode (everything fits the default budget): body goes inline"
      );

      const toolNames = (body.tools || []).map((t) => t.function.name);
      assert.deepEqual(
        toolNames,
        ["recall_memories"],
        "recall_memories ships alongside (and only without) the disabled search tools"
      );

      assert.ok(
        await waitFor(() => env.channels.log.sent.length >= 1),
        "expected the Q&A audit embed"
      );
      const auditText = embedText(env.channels.log.sent[0].embeds[0]);
      assert.ok(auditText.includes("Memory"), `Memory field must be present: ${auditText}`);
      assert.ok(
        auditText.includes("bodies ×3"),
        `read-side label must count the injected bodies: ${auditText}`
      );

      // Drain the detached extraction request before the mock is restored
      // (the write path always fires after a real shipped answer).
      assert.ok(
        await waitFor(() => fetchMock.calls.length >= 2, 5000),
        "extraction turn must arrive after the answer"
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("recall_memories round-trip: tool result carries the body, last_used_at is touched, exactly two answer-path AI calls", async () => {
    // Objective (§7.16.2 + contract G/F): the model may recall a stored
    // memory by #id mid-conversation; the tool result fed back to it
    // carries the full stored body, the recall stamps last_used_at
    // (gorkMemoryTouch side effect via the facade), and the answer path
    // costs exactly two chat completions (the recall adds one round).
    const env = await createIntegrationEnv({ guildId: uniqueId("guild-memrecall") });
    const seeded = seedMemory(env, {
      subjectUserId: IDS.member,
      title: "Owns a kayak",
      body: "Owns a bright red kayak named CSS.",
      kind: "project",
      importance: 4,
    });
    const saved = saveEnv();
    const fetchMock = mockFetch([
      // 1) Model recalls the seeded memory by #id.
      chatCompletionResponse(null, {
        tool_calls: [
          {
            id: "call_mem1",
            type: "function",
            function: {
              name: "recall_memories",
              arguments: JSON.stringify({ ids: [seeded.id] }),
            },
          },
        ],
      }),
      // 2) Final answer informed by the recall.
      chatCompletionResponse("Right, the red kayak named CSS."),
      // 3) Extraction turn (drained; nothing durable).
      chatCompletionResponse(JSON.stringify({ memories: [] })),
    ]);
    try {
      enableAiKey();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
        gork_memory_enabled: 1,
        audit_log_channel_id: IDS.channelLog,
      });
      attachTyping(env.channels.general);
      assert.equal(
        env.db.gorkMemoryGetById(env.guild.id, seeded.id).last_used_at,
        null,
        "seeded row starts untouched"
      );

      const { message, replies } = makeGorkMessage(env, {
        id: "t-memrecall-1",
        content: "gork: what do I own?",
      });
      await env.onMessageCreate(message);
      assert.ok(
        await waitFor(() => replies.length >= 1, 5000),
        "the recall round must still end in an answer"
      );
      assert.equal(replies[0].content, "Right, the red kayak named CSS.");
      assert.ok(
        await waitFor(() => fetchMock.calls.length >= 3, 5000),
        "extraction turn must arrive (drains before restore)"
      );

      // The tool result message fed back carries the seeded body.
      const secondBody = JSON.parse(fetchMock.calls[1].init.body);
      const toolMsg = secondBody.messages.find((m) => m.role === "tool");
      assert.ok(toolMsg, "recall result must feed the second chat call");
      assert.ok(
        toolMsg.content.includes(`#${seeded.id}`),
        `recall result carries the #id handle: ${toolMsg.content}`
      );
      assert.ok(
        toolMsg.content.includes("Owns a bright red kayak named CSS."),
        `recall result carries the FULL stored body: ${toolMsg.content}`
      );

      // Answer path = exactly the two gork-persona calls; the third fetch
      // is the (separate) extraction turn, not an answer-path round.
      const qaCalls = fetchMock.calls.filter((c) => qaBodyOf(c));
      const extractionCalls = fetchMock.calls.filter((c) => extractionBodyOf(c));
      assert.equal(qaCalls.length, 2, "exactly two AI calls on the answer path");
      assert.equal(extractionCalls.length, 1, "exactly one extraction turn");

      // gorkMemoryTouch side effect via the facade (decision: recalled rows
      // win the eviction recency tie-break).
      const row = env.db.gorkMemoryGetById(env.guild.id, seeded.id);
      assert.ok(
        row.last_used_at != null,
        "recall must stamp last_used_at via gorkMemoryTouch"
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("extraction turn after slot release: valid entry stored server-stamped, bogus subject skipped, small model used", async () => {
    // Objective (§7.16.3, decisions 25/26/29): after the answer ships and
    // the guild slot is RELEASED, a detached extraction turn runs on
    // AI_SMALL_MODEL with strict JSON. A valid entry lands with the
    // SERVER-STAMPED trigger-message UTC date and the normalized title_key
    // ("  Loves  Rust! " → "loves rust"); a subject outside the roster is
    // dropped (skipped_invalid) and never stored.
    const env = await createIntegrationEnv({ guildId: uniqueId("guild-memextract") });
    const saved = saveEnv([...AI_ENV_KEYS, "AI_SMALL_MODEL"]);
    const fetchMock = mockFetch([
      chatCompletionResponse("Noted, member."),
      // Extraction payload: one valid entry (asker) + one bogus subject.
      chatCompletionResponse(
        JSON.stringify({
          memories: [
            {
              subject_user_id: IDS.member,
              title: "  Loves  Rust! ",
              body: "Prefers Rust for CLI tooling.",
              kind: "preference",
              importance: 5,
            },
            {
              subject_user_id: "999999999999999999", // not in the roster
              title: "Imaginary crewmate",
              body: "Not in the roster at all.",
              kind: "profile",
              importance: 5,
            },
          ],
        })
      ),
    ]);
    try {
      enableAiKey();
      process.env.AI_SMALL_MODEL = "small-mem-model";
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
        gork_memory_enabled: 1,
        audit_log_channel_id: IDS.channelLog,
      });
      attachTyping(env.channels.general);

      const { message, replies } = makeGorkMessage(env, {
        id: "t-memx-1",
        content: "gork: I really love rust these days",
        createdTimestamp: MEM_TRIGGER_TS, // server-stamped mem_date source
      });
      await env.onMessageCreate(message);
      assert.ok(
        await waitFor(() => replies.length >= 1),
        "the answer must ship before any write-path work"
      );
      assert.ok(
        await waitFor(() => fetchMock.calls.length >= 2, 5000),
        "extraction request must arrive after the answer"
      );

      // The extraction turn fires only AFTER the finally-block slot
      // release — so once the request is in, the guild slot is observably
      // free (same admit-probe the §7.15 Fix 3 test uses).
      const { gorkQueue } = require("../../src/features/gork/trigger");
      assert.equal(
        gorkQueue.admit({ guildId: env.guild.id }).queued,
        false,
        "the guild slot was already released when the extraction turn fired"
      );
      gorkQueue.release({ guildId: env.guild.id });

      // The write-path request itself: small model + strict JSON + allow-list.
      const xBody = extractionBodyOf(fetchMock.calls[1]);
      assert.ok(xBody, "the second fetch must be the extraction turn");
      assert.equal(
        xBody.model,
        "small-mem-model",
        "AI_SMALL_MODEL overrides the extraction model (decision 29)"
      );
      assert.equal(
        qaBodyOf(fetchMock.calls[0])?.model,
        "gpt-4o-mini",
        "the answer path keeps the main model"
      );
      assert.deepEqual(
        xBody.response_format,
        { type: "json_object" },
        "extraction must request strict JSON"
      );
      const xUser = xBody.messages.find((m) => m.role === "user");
      assert.ok(
        xUser.content.includes(IDS.member),
        "allow-list must carry the asker id"
      );
      assert.ok(
        xUser.content.includes(MEM_TRIGGER_DATE),
        "server-stamped mem_date must be shown to the extractor"
      );

      // Valid entry: stored with server-stamped UTC date + normalized key.
      const rows = env.db.gorkMemoryListForSubject(env.guild.id, IDS.member);
      assert.equal(rows.length, 1, "exactly the valid entry stored");
      const row = rows[0];
      assert.equal(
        row.title_key,
        "loves rust",
        '"  Loves  Rust! " must normalizeTitle into the key half (decision 26)'
      );
      assert.equal(
        row.mem_date,
        MEM_TRIGGER_DATE,
        "mem_date = trigger message UTC day, stamped server-side"
      );
      assert.equal(row.kind, "preference");
      assert.equal(row.importance, 5);

      // Bogus subject: never stored (skipped_invalid path), never resolved.
      assert.equal(
        env.db.gorkMemoryCountForGuild(env.guild.id),
        1,
        "the out-of-roster entry must NOT be stored"
      );

      // Write-side audit gets its own compact "Gork memory" entry.
      assert.ok(
        await waitFor(
          () =>
            env.channels.log.sent.some((p) =>
              embedText(p.embeds?.[0]).includes("Gork memory")
            ),
          5000
        ),
        "expected the 'Gork memory' audit embed"
      );
      const memAudit = env.channels.log.sent
        .map((p) => embedText(p.embeds?.[0]))
        .find((t) => t.includes("Gork memory"));
      assert.ok(memAudit.includes("Stored: +1"), `stored counter: ${memAudit}`);
      assert.ok(
        memAudit.includes("skipped_invalid: 1"),
        `skipped_invalid counter: ${memAudit}`
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("/gork memory on + budget 8000: settings persisted + config-change audit embeds; non-staff denied", async () => {
    // Objective (§7.16.4, decision 28): the staff command surface persists
    // gork_memory_enabled / gork_memory_chars through the real router and
    // audits every change; non-staff cannot touch it.
    const env = await createIntegrationEnv({ guildId: uniqueId("guild-memcmd") });
    const saved = saveEnv();
    clearAiKey(); // config commands do not need the AI key
    try {
      env.db.updateGuildSettings(env.guild.id, {
        audit_log_channel_id: IDS.channelLog,
      });

      // on: master switch persisted.
      let ixn = await env.runCommand({
        commandName: "gork",
        subcommand: "memory",
        admin: true,
        options: { action: "on" },
      });
      assertEphemeralReply(ixn);
      assertReplyContains(ixn, /memory is now \*\*on\*\*/i);
      assert.equal(env.db.getGuildSettings(env.guild.id).gork_memory_enabled, 1);

      // budget 8000: the standalone block budget persists.
      ixn = await env.runCommand({
        commandName: "gork",
        subcommand: "memory",
        admin: true,
        options: { action: "budget", chars: 8000 },
      });
      assertEphemeralReply(ixn);
      assertReplyContains(ixn, "8000");
      assert.equal(env.db.getGuildSettings(env.guild.id).gork_memory_chars, 8000);

      // Non-staff is denied and the stored settings stay unchanged.
      const denied = await env.runCommand({
        commandName: "gork",
        subcommand: "memory",
        admin: false,
        user: env.users.memberUser,
        options: { action: "off" },
      });
      assertEphemeralReply(denied, /permission/i);
      assert.equal(env.db.getGuildSettings(env.guild.id).gork_memory_enabled, 1);

      // Audit trail: both config changes recorded (not the denial).
      assert.ok(
        await waitFor(() => env.channels.log.sent.length >= 2),
        "expected the two config-change audit embeds"
      );
      const auditAll = env.channels.log.sent
        .map((p) => embedText(p.embeds?.[0]))
        .join("\n");
      assert.ok(auditAll.includes("Gork memory enabled"), auditAll);
      assert.ok(auditAll.includes("Gork memory budget updated"), auditAll);
      assert.ok(auditAll.includes("/gork memory"), auditAll);
    } finally {
      restoreEnv(saved);
    }
  });
});

/** All payload objects sent to the general channel this run. */
function ch_all_sent(env) {
  return env.channels.general.sent.filter((p) => typeof p === "object" && p?.content);
}

/** True when `s` contains a lone (unpaired) UTF-16 surrogate. */
function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      const isHigh = code <= 0xdbff;
      const partner = s.charCodeAt(i + (isHigh ? 1 : -1));
      if (!(isHigh ? partner >= 0xdc00 && partner <= 0xdfff : partner >= 0xd800 && partner <= 0xdbff)) {
        return true;
      }
    }
  }
  return false;
}
