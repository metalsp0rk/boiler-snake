/**
 * Integration tests for the Gork interaction log (E2E capture, session
 * 2026-09-13-gork-interaction-log Phase B): real SQLite, mocked Discord I/O,
 * mocked global fetch — no real network.
 *
 * Proves the FULL stack: a keyword trigger (or `/gork log` toggle) all the
 * way through trigger.js into ONE `gork_interactions` row per agent call —
 * exact prompts, params, tools, settings/context/roster/memory snapshots,
 * the wire transcript (incl. tool rounds + retry attempts), raw + shipped
 * answer, and the failure/error variants — plus the memory_turn companion
 * row linked through parent_uid.
 *
 * Same settle discipline as gork.test.js: `whenGorkIdleForTests()` drains
 * every detached gork unit (hook, LLM job, audit posts, memory turn, and
 * therefore every recorder finalize), so no sleeps or polling anywhere.
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertEphemeralReply,
  assertReplyContains,
} = require("../helpers/assert");
const { IDS, uniqueId } = require("../helpers/fixtures");

const { LLM_FAILURE_REPLY } = require("../../src/features/gork/trigger");
const { GORK_BASE_PROMPT } = require("../../src/features/gork/prompt");
const { ENV_KEYS: IL_ENV_KEYS } = require("../../src/features/gork/interactionLog");
const { READ_DISCORD_TOOL } = require("../../src/features/gork/tools/readDiscord");

// ---------- env hygiene (same local save/restore pair as gork.test.js) ----------

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
  ...IL_ENV_KEYS,
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
 * Deterministic AI env: test key, default model (gpt-4o-mini), DEFAULT LLM
 * params (so the recorded params column is pinned) and interaction-log
 * knobs at their defaults (capture ON, retention 30, budget 200k).
 */
function armGork() {
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
  delete process.env.OPENAI_MODEL;
  delete process.env.GORK_LLM_MAX_TOKENS;
  delete process.env.GORK_LLM_TIMEOUT_MS;
  delete process.env.GORK_LLM_MAX_TOOL_ROUNDS;
  delete process.env.GORK_LLM_THINKING_TOKEN_BUDGET;
  delete process.env.GORK_MAX_ANSWER_CHARS;
  for (const key of IL_ENV_KEYS) delete process.env[key];
  process.env.OPENAI_API_KEY = TEST_AI_KEY;
}

// ---------- mocked global fetch (same scripted-fake pattern as gork.test.js) ----------

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function chatCompletionResponse(content, messageExtra = {}) {
  const { finish_reason: fr, ...msgExtra } = messageExtra;
  return jsonResponse({
    id: "chatcmpl-ilog-1",
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

// ---------- fake Discord surface (same shape gork.test.js proved) ----------

function attachTyping(channel) {
  const state = { calls: 0 };
  channel.sendTyping = async () => {
    state.calls += 1;
  };
  return state;
}

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
    react: async (emoji) => {
      return { emoji };
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

// ---------- settle seam + env lifecycle ----------

function gorkIdle() {
  return require("../../src/features/gork/trigger").whenGorkIdleForTests();
}

const createdEnvs = [];

async function freshEnv(options) {
  const env = await createIntegrationEnv(options);
  createdEnvs.push(env);
  return env;
}

after(() => {
  for (const env of createdEnvs) env.cleanup();
  createdEnvs.length = 0;
});

// ---------- row helpers ----------

/** All interaction rows for the guild (fresh column values via uid lookup). */
function rowsByKind(env) {
  const byKind = {};
  for (const listed of env.db.listGorkInteractions({
    guildId: env.guild.id,
    limit: 50,
  })) {
    byKind[listed.kind] = env.db.getGorkInteractionByUid(listed.uid);
  }
  return byKind;
}

const j = (col) => (col == null ? null : JSON.parse(col));

// ---------- tests ----------

describe("integration: gork interaction log", () => {
  it("successful Q&A writes ONE qa row snapshotting the exact call", async () => {
    const env = await freshEnv({ guildId: uniqueId("guild-ilqa") });
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse("The sky is blue because of Rayleigh scattering."),
    ]);
    try {
      armGork();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
      });

      const ch = env.channels.general;
      ch.addMessage({
        id: "il-a1",
        content: "Earlier chatter about the sky",
        author: { id: IDS.member2, username: "member2", tag: "member2#0000" },
        createdTimestamp: Date.now() - 20000,
      });
      ch.addMessage({
        id: "il-a2",
        content: "Anyone know about light scattering?",
        author: { id: IDS.member, username: "member", tag: "member#0000" },
        createdTimestamp: Date.now() - 10000,
      });
      attachTyping(ch);
      const { message, replies } = makeGorkMessage(env, {
        id: "t-il-1",
        content: "gork: why is the sky blue?",
      });

      await env.onMessageCreate(message);
      await gorkIdle();

      assert.equal(replies.length, 1, "answer shipped as usual");
      const { qa } = rowsByKind(env);
      assert.ok(qa, "exactly one qa interaction row expected");
      assert.equal(
        env.db.listGorkInteractions({ guildId: env.guild.id, limit: 50 }).length,
        1,
        "one row per call — nothing else",
      );

      // Identity + linkage
      assert.equal(qa.kind, "qa");
      assert.equal(qa.parent_uid, null, "qa rows have no parent");
      assert.equal(qa.guild_id, env.guild.id);
      assert.equal(qa.channel_id, ch.id);
      assert.equal(qa.message_id, "t-il-1");
      assert.equal(qa.user_id, IDS.member);
      assert.equal(qa.status, "shipped");
      assert.equal(qa.reply_to_message_id, null);
      assert.equal(qa.trigger_content, "gork: why is the sky blue?");

      // EXACT prompts: byte-identical to the wire request.
      assert.equal(fetchMock.calls.length, 1);
      const body = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(qa.system_prompt, body.messages[0].content);
      assert.equal(qa.user_prompt, body.messages[1].content);
      assert.ok(qa.system_prompt.startsWith(GORK_BASE_PROMPT));
      assert.ok(qa.user_prompt.includes("why is the sky blue?"));
      assert.ok(qa.user_prompt.includes("Conversation context:"));
      assert.ok(qa.user_prompt.includes("People in this conversation"));

      // Model + params exactly as sent (env pinned → defaults)
      assert.equal(qa.model, "gpt-4o-mini");
      assert.deepEqual(j(qa.params), {
        temperature: 0.8,
        maxTokens: 6000,
        timeoutMs: 90000,
        maxToolRounds: 3,
        thinkingTokenBudget: 0,
      });
      // read_discord is ALWAYS on (decision 44): even with SEARXNG_URL
      // unset and memory off, the tools column snapshots exactly the
      // reader — the payload is never tool-less anymore.
      assert.deepEqual(
        j(qa.tools),
        [READ_DISCORD_TOOL],
        "no SEARXNG_URL + memory off → exactly the always-on read_discord",
      );

      // Settings snapshot of the guild at call time (NOT NULL column defaults
      // from migration 021/023: context_window 10, search 1, memory 0).
      assert.deepEqual(j(qa.settings), {
        gork_keyword: "gork",
        gork_context_window: 10,
        gork_cooldown_sec: 0,
        gork_search_enabled: 1,
        gork_memory_enabled: 0,
        gork_extra_rules: null,
        gork_interaction_log_enabled: 1,
      });

      // Transcript: request → response, attempt-tagged, carrying the wire prompts
      const t = j(qa.transcript);
      assert.equal(t.truncated, false);
      assert.deepEqual(
        t.events.map((e) => `${e.type}:${e.round}:${e.attempt}`),
        ["request:0:1", "response:0:1"],
      );
      assert.deepEqual(t.events[0].payload.messages, [
        { role: "system", content: qa.system_prompt },
        { role: "user", content: qa.user_prompt },
      ]);
      assert.equal(t.events[1].ok, true);
      assert.equal(t.events[1].finishReason, "stop");
      assert.deepEqual(t.events[1].usage, {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      });

      // Outcome columns
      assert.equal(qa.answer_raw, "The sky is blue because of Rayleigh scattering.");
      assert.equal(qa.answer_shipped, replies[0].content);
      assert.equal(qa.finish_reason, "stop");
      assert.deepEqual(j(qa.usage), {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      });
      assert.equal(qa.tool_call_count, 0);
      assert.equal(qa.error, null);
      assert.ok(qa.duration_ms >= 0, "duration recorded");
      assert.ok(
        Math.abs(qa.started_at - Date.now()) < 60000,
        "started_at is the job start clock",
      );
      assert.ok(qa.created_at >= qa.started_at);

      // Context + roster snapshots
      assert.deepEqual(j(qa.context_messages).map((m) => m.id), ["il-a1", "il-a2"]);
      assert.deepEqual(j(qa.context_messages)[0], {
        id: "il-a1",
        authorId: IDS.member2,
        content: "Earlier chatter about the sky",
        timestamp: null, // harness fakes carry no createdAt
      });
      const ctxMeta = j(qa.context_meta);
      assert.equal(ctxMeta.mode, "prior");
      assert.equal(ctxMeta.collected, 2);
      assert.ok(
        Number.isInteger(ctxMeta.chars) && ctxMeta.chars > 0,
        "context block char count recorded",
      );
      const rosterMeta = j(qa.roster_meta);
      assert.equal(rosterMeta.entries, 2, "two distinct speakers in the roster");
      assert.equal(rosterMeta.truncated, 0);
      assert.ok(qa.roster_block.includes("People in this conversation"));
      assert.deepEqual(
        j(qa.roster_entries).map((e) => e.id).sort(),
        [IDS.member, IDS.member2],
      );

      // Memory was OFF → no meta and no companion row
      assert.equal(qa.memory_meta, null);
      assert.equal(rowsByKind(env).memory_turn, undefined);
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("tool loop records every round: request/response/tool events + tool metadata", async () => {
    const env = await freshEnv({ guildId: uniqueId("guild-iltool") });
    const saved = saveEnv();
    const fetchMock = mockFetch([
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
      jsonResponse({
        query: "node.js streams",
        results: [
          {
            title: "Node.js Streams",
            url: "https://nodejs.org/docs/latest/api/stream.html",
            content: "Streams process data sequentially with backpressure.",
          },
        ],
      }),
      chatCompletionResponse(
        "Node streams pipe data sequentially instead of buffering the whole payload.",
      ),
    ]);
    try {
      armGork();
      process.env.SEARXNG_URL = "https://searxng.test";
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
        gork_search_enabled: 1,
      });
      attachTyping(env.channels.general);
      const { message, replies } = makeGorkMessage(env, {
        id: "t-il-tool-1",
        content: "gork: how do node.js streams work?",
      });

      await env.onMessageCreate(message);
      await gorkIdle();

      assert.equal(replies.length, 1, "final answer shipped");
      const { qa } = rowsByKind(env);
      assert.ok(qa, "tool-loop call produced a qa row");
      assert.equal(qa.status, "shipped");
      assert.equal(qa.tool_call_count, 1, "one web_search executed");

      // Tools column: the exact schemas sent, in wire order (search
      // enabled; read_discord first — always-on reader, decision 44)
      assert.deepEqual(
        j(qa.tools).map((t) => t.function.name),
        ["read_discord", "web_search", "read_page"],
      );

      // Full ordered transcript of the loop, attempt-tagged on every event
      const t = j(qa.transcript);
      assert.deepEqual(
        t.events.map((e) => `${e.type}:${e.round}:${e.attempt}`),
        [
          "request:0:1",
          "response:0:1",
          "tool:0:1",
          "request:1:1",
          "response:1:1",
        ],
      );
      const tool = t.events[2];
      assert.equal(tool.name, "web_search");
      assert.deepEqual(tool.args, { query: "node.js streams" });
      assert.equal(tool.ok, true);
      assert.ok(tool.output.includes("Node.js Streams"), "tool output captured");
      // Round 2 carries the tool result back on the wire
      assert.equal(
        t.events[3].payload.messages.length,
        4,
        "system, user, assistant(tool_calls), tool result",
      );
      assert.equal(t.events[3].payload.messages[3].role, "tool");

      // The shipped answer also fed answer_raw / answer_shipped
      assert.equal(qa.answer_shipped, "Node streams pipe data sequentially instead of buffering the whole payload.");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("retry-after-empty writes ONE row with attempt-tagged events", async () => {
    const env = await freshEnv({ guildId: uniqueId("guild-ilretry") });
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse(null), // OK-but-empty → triggers the one retry
      chatCompletionResponse("Retry answered: water evaporates, condenses, repeats."),
    ]);
    try {
      armGork();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
      });
      attachTyping(env.channels.general);
      const { message, replies } = makeGorkMessage(env, {
        id: "t-il-retry-1",
        content: "gork: what is the water cycle?",
      });

      await env.onMessageCreate(message);
      await gorkIdle();

      assert.equal(fetchMock.calls.length, 2, "both attempts hit the wire");
      assert.equal(replies[0].content.startsWith("Retry answered:"), true);
      const { qa } = rowsByKind(env);
      assert.ok(qa, "retry shares ONE record");
      assert.equal(qa.status, "shipped");
      const t = j(qa.transcript);
      assert.deepEqual(
        t.events.map((e) => e.attempt),
        [1, 1, 2, 2],
        "attempt tags on request AND response events",
      );
      assert.deepEqual(
        t.events.map((e) => e.type),
        ["request", "response", "request", "response"],
      );
      assert.equal(t.events[1].ok, true, "attempt 1 was ok-but-empty, not an error");
      assert.equal(qa.answer_shipped, "Retry answered: water evaporates, condenses, repeats.");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("HTTP failure stores the specific cause and ships the canned reply", async () => {
    const env = await freshEnv({ guildId: uniqueId("guild-ilfail") });
    const saved = saveEnv();
    const fetchMock = mockFetch([
      jsonResponse({ error: { message: "upstream exploded" } }, 500),
    ]);
    try {
      armGork();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
        gork_memory_enabled: 1, // failure must NOT feed the memory write path
      });
      attachTyping(env.channels.general);
      const { message, replies } = makeGorkMessage(env, {
        id: "t-il-fail-1",
        content: "gork: will you remember this?",
      });

      await env.onMessageCreate(message);
      await gorkIdle();

      assert.equal(replies[0].content, LLM_FAILURE_REPLY, "canned reply shipped");
      assert.equal(fetchMock.calls.length, 1, "no retry on HTTP failure");
      const rows = rowsByKind(env);
      const qa = rows.qa;
      assert.ok(qa, "failure path records the call too");
      assert.equal(qa.status, "failure");
      assert.match(qa.error, /HTTP 500/);
      assert.ok(qa.answer_shipped == null, "canned reply is NOT stored as an answer");
      const t = j(qa.transcript);
      assert.deepEqual(
        t.events.map((e) => `${e.type}:${e.attempt}`),
        ["request:1", "response:1"],
      );
      assert.equal(t.events[1].ok, false);
      assert.equal(t.events[1].status, 500);
      assert.equal(
        rows.memory_turn,
        undefined,
        "memory turn never fires on a canned failure (§7.16.3)",
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("job crash after prompts stored: status 'error' with the message", async () => {
    const env = await freshEnv({ guildId: uniqueId("guild-ilerr") });
    const saved = saveEnv();
    const fetchMock = mockFetch([chatCompletionResponse("Answer doomed to die.")]);
    try {
      armGork();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
      });
      attachTyping(env.channels.general);
      const { message } = makeGorkMessage(env, {
        id: "t-il-err-1",
        content: "gork: does this row survive a dead reply channel?",
      });
      // Simulate the reply send exploding mid-answer (deleted channel, etc.)
      message.reply = async () => {
        throw new Error("Missing Access");
      };

      await env.onMessageCreate(message);
      await gorkIdle(); // the crash must not reject the pipeline

      const { qa } = rowsByKind(env);
      assert.ok(qa, "outer-job failures still produce the row");
      assert.equal(qa.status, "error");
      assert.equal(qa.error, "Missing Access");
      assert.ok(qa.system_prompt, "prompts captured before the crash");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("/gork log off|on gates row writes; status + audit reflect it; staff-gated", async () => {
    const env = await freshEnv({ guildId: uniqueId("guild-ilcmd") });
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse("Stored answer the first time."),
      chatCompletionResponse("Quiet while logging is off."),
      chatCompletionResponse("Stored again after re-enable."),
    ]);
    try {
      armGork();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
        audit_log_channel_id: IDS.channelLog,
      });
      attachTyping(env.channels.general);

      const triggerOnce = async (id, content) => {
        const { message, replies } = makeGorkMessage(env, { id, content });
        await env.onMessageCreate(message);
        await gorkIdle();
        return replies;
      };

      // Baseline: default column ON → row lands.
      await triggerOnce("t-il-c1", "gork: first question");
      assert.equal(env.db.countGorkInteractions(env.guild.id), 1);

      // Toggle OFF → setting persisted, ephemerally confirmed, audit trail.
      const off = await env.runCommand({
        commandName: "gork",
        subcommand: "log",
        admin: true,
        options: { enabled: false },
      });
      assertEphemeralReply(off);
      assertReplyContains(off, /interaction log is now \*\*off\*\*/);
      assert.equal(env.db.getGuildSettings(env.guild.id).gork_interaction_log_enabled, 0);

      // /gork status reflects OFF.
      const statusOff = await env.runCommand({
        commandName: "gork",
        subcommand: "status",
        admin: true,
      });
      const statusOffText = embedText(
        statusOff.replies[statusOff.replies.length - 1].embeds[0],
      );
      assert.match(statusOffText, /Interaction Log/);
      assert.match(statusOffText, /Off/);

      // While OFF: answers still ship, ZERO new rows.
      const quiet = await triggerOnce("t-il-c2", "gork: second question");
      assert.equal(quiet[0].content, "Quiet while logging is off.");
      assert.equal(env.db.countGorkInteractions(env.guild.id), 1, "no row while OFF");

      // Toggle back ON → rows flow again.
      const on = await env.runCommand({
        commandName: "gork",
        subcommand: "log",
        admin: true,
        options: { enabled: true },
      });
      assertEphemeralReply(on);
      assertReplyContains(on, /interaction log is now \*\*on\*\*/);
      assert.equal(env.db.getGuildSettings(env.guild.id).gork_interaction_log_enabled, 1);
      await triggerOnce("t-il-c3", "gork: third question");
      assert.equal(env.db.countGorkInteractions(env.guild.id), 2);

      // /gork status now reports ON with the live row count.
      const statusOn = await env.runCommand({
        commandName: "gork",
        subcommand: "status",
        admin: true,
      });
      const statusOnText = embedText(
        statusOn.replies[statusOn.replies.length - 1].embeds[0],
      );
      assert.match(statusOnText, /Interaction Log/);
      assert.match(statusOnText, /On \(2 rows\)/);

      // Audit trail captured both toggles.
      const auditAll = env.channels.log.sent
        .map((p) => embedText(p.embeds?.[0]))
        .join("\n");
      assert.ok(auditAll.includes("Gork interaction log disabled"), auditAll);
      assert.ok(auditAll.includes("Gork interaction log enabled"), auditAll);
      assert.ok(auditAll.includes("/gork log"), auditAll);

      // Non-staff cannot toggle it.
      const denied = await env.runCommand({
        commandName: "gork",
        subcommand: "log",
        admin: false,
        user: env.users.memberUser,
        options: { enabled: false },
      });
      assertEphemeralReply(denied, /permission/i);
      assert.equal(env.db.getGuildSettings(env.guild.id).gork_interaction_log_enabled, 1);
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("GORK_INTERACTION_LOG=0 kill-switch: answers ship, zero rows (env beats column)", async () => {
    const env = await freshEnv({ guildId: uniqueId("guild-ilkill") });
    const saved = saveEnv();
    const fetchMock = mockFetch([chatCompletionResponse("Still answered fine.")]);
    try {
      armGork();
      process.env.GORK_INTERACTION_LOG = "0";
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
        // column stays at its default 1 — the env kill must win over it
      });
      attachTyping(env.channels.general);
      const { message, replies } = makeGorkMessage(env, {
        id: "t-il-kill-1",
        content: "gork: does the kill switch hurt the answer?",
      });

      await env.onMessageCreate(message);
      await gorkIdle();

      assert.equal(replies[0].content, "Still answered fine.");
      assert.equal(fetchMock.calls.length, 1);
      assert.equal(env.db.countGorkInteractions(env.guild.id), 0, "kill-switch wrote nothing");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("memory ON writes a linked memory_turn row with the extraction call captured", async () => {
    const env = await freshEnv({ guildId: uniqueId("guild-ilmem") });
    const saved = saveEnv();
    const extraction = JSON.stringify({ memories: [] });
    const fetchMock = mockFetch([
      chatCompletionResponse("Noted, member."),
      chatCompletionResponse(extraction),
    ]);
    try {
      armGork();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
        gork_memory_enabled: 1,
      });
      attachTyping(env.channels.general);
      const { message, replies } = makeGorkMessage(env, {
        id: "t-il-mem-1",
        content: "gork: thanks for the help earlier",
      });

      await env.onMessageCreate(message);
      await gorkIdle(); // drains the answer job AND the tracked extraction turn

      assert.equal(replies.length, 1, "answer shipped");
      assert.equal(fetchMock.calls.length, 2, "qa + extraction wire calls");
      const { qa, memory_turn: mem } = rowsByKind(env);
      assert.ok(qa, "qa row");
      assert.ok(mem, "memory_turn companion row");
      assert.equal(mem.parent_uid, qa.uid, "linked to the qa record");
      assert.equal(
        mem.status,
        "shipped",
        "extraction had a successful LLM response → shipped even with nothing stored",
      );
      assert.equal(mem.error, null, "no failure cause on a shipped memory turn");
      assert.equal(mem.model, "gpt-4o-mini", "small-model default follows AI_MODEL");
      assert.equal(mem.system_prompt, null, "memory prompts ride onEvent, not columns");
      assert.equal(mem.user_prompt, null);
      assert.equal(mem.answer_raw, extraction, "raw extraction JSON captured");
      assert.deepEqual(j(mem.params), { stored: 0, skippedInvalid: 0 });

      // The extraction request IS in the transcript (system prompt proves it)
      const t = j(mem.transcript);
      assert.deepEqual(t.events.map((e) => e.type), ["request", "response"]);
      const sysMsg = t.events[0].payload.messages[0];
      assert.equal(sysMsg.role, "system");
      assert.match(sysMsg.content, /extract durable memories/i);

      // qa row carries the read-side memory meta now
      const memMeta = j(qa.memory_meta);
      assert.ok(memMeta, "memory_meta snapshot on the qa row");
      assert.ok("mode" in memMeta && "indexed" in memMeta);
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("memory extraction LLM failure → memory_turn row status 'failure' with the cause", async () => {
    const env = await freshEnv({ guildId: uniqueId("guild-ilmemfail") });
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse("Noted, member."), // qa chat round succeeds
      jsonResponse({ error: { message: "upstream exploded" } }, 500), // extraction dies
    ]);
    try {
      armGork();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
        gork_memory_enabled: 1,
      });
      attachTyping(env.channels.general);
      const { message, replies } = makeGorkMessage(env, {
        id: "t-il-memfail-1",
        content: "gork: thanks for the help earlier",
      });

      await env.onMessageCreate(message);
      await gorkIdle(); // drains the answer job AND the tracked extraction turn

      assert.equal(replies.length, 1, "answer still ships — extraction failure is user-invisible");
      assert.equal(fetchMock.calls.length, 2, "qa + extraction wire calls");
      const { qa, memory_turn: mem } = rowsByKind(env);
      assert.ok(qa && mem, "qa row plus the companion memory_turn row");
      assert.equal(qa.status, "shipped", "the qa row is unaffected by the extraction failure");
      assert.equal(
        mem.status,
        "failure",
        "no successful LLM response during extraction → truthful failure status",
      );
      assert.match(mem.error, /http: HTTP 500/, "the specific extraction cause is stored");
      assert.equal(mem.answer_raw, null, "no ok response → no raw extraction content");
      const params = j(mem.params);
      assert.equal(params.stored, 0, "silent-drop turn stored nothing");
      assert.equal(params.skippedInvalid, 0);
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("tool-round cap with content: answer ships AND the row records status 'partial'", async () => {
    const env = await freshEnv({ guildId: uniqueId("guild-ilpartial") });
    const saved = saveEnv();
    const webSearchCall = (id, query) => ({
      id,
      type: "function",
      function: { name: "web_search", arguments: `{"query":"${query}"}` },
    });
    const fetchMock = mockFetch([
      // round 0 (under the cap of 1): a web_search tool call — it executes.
      chatCompletionResponse(null, { tool_calls: [webSearchCall("call_p1", "node streams")] }),
      jsonResponse({
        query: "node streams",
        results: [
          {
            title: "Node.js Streams",
            url: "https://nodejs.org/docs/latest/api/stream.html",
            content: "Streams process data sequentially with backpressure.",
          },
        ],
      }),
      // round 1 (AT the cap): provider cap-with-content shape — another
      // tool_call PLUS real content and finish_reason "tool_calls", so
      // chatWithTools returns ok:false/reason:"cap" carrying that content →
      // trigger.js delivers the partial answer and stores status "partial".
      chatCompletionResponse("Partial answer before the tool-round cap.", {
        tool_calls: [webSearchCall("call_p2", "node backpressure")],
      }),
    ]);
    try {
      armGork();
      process.env.SEARXNG_URL = "https://searxng.test";
      process.env.GORK_LLM_MAX_TOOL_ROUNDS = "1"; // cap after ONE tool round
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
        gork_search_enabled: 1,
      });
      attachTyping(env.channels.general);
      const { message, replies } = makeGorkMessage(env, {
        id: "t-il-partial-1",
        content: "gork: hit the tool round cap",
      });

      await env.onMessageCreate(message);
      await gorkIdle();

      assert.equal(fetchMock.calls.length, 3, "chat, search, chat (capped) — no retry");
      assert.equal(replies.length, 1, "the partial answer is delivered to the channel");
      assert.equal(replies[0].content, "Partial answer before the tool-round cap.");
      const { qa } = rowsByKind(env);
      assert.ok(qa, "capped call produced its qa row");
      assert.equal(
        qa.status,
        "partial",
        "!res.ok (cap) with real content → the trigger's partial branch",
      );
      assert.ok(qa.answer_shipped, "the shipped partial answer is recorded");
      assert.equal(qa.answer_shipped, "Partial answer before the tool-round cap.");
      assert.equal(qa.tool_call_count, 1, "exactly one web_search executed");
      assert.equal(qa.finish_reason, "tool_calls", "the capped round's finish_reason");
      assert.equal(j(qa.params).maxToolRounds, 1, "the recorded params mirror the env cap");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });
});
