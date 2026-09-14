/**
 * Integration tests for the gork daily usage budget (roadmap/gork.md §7.17,
 * decisions 30–37): real SQLite, mocked Discord I/O, mocked global fetch.
 *
 * Extends the gork.test.js harness idioms: fresh env per test (require-cache
 * reset → fresh gorkQueue AND fresh budget reject throttle), the
 * whenGorkIdleForTests settle seam instead of sleeps, and gate-held fetches
 * for the queued no-overage proof.
 *
 * Fixtures from the implementation sketch: exact cap reached, blocked scope,
 * queued multi-request no-overage, partial-send not counted, staff counted,
 * restart persistence (DB-backed counters), empty-retry success counted once.
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const { resetSrcModules } = require("../helpers/env");
const { IDS } = require("../helpers/fixtures");

const { LLM_FAILURE_REPLY } = require("../../src/features/gork/trigger");

// ---------- env hygiene (same local pair as gork.test.js) ----------

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
  process.env.OPENAI_API_KEY = TEST_AI_KEY;
}

// ---------- mocked global fetch (same scripted fake as gork.test.js) ----------

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function chatCompletionResponse(content) {
  return jsonResponse({
    id: "chatcmpl-test-1",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
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

// ---------- fake Discord surface ----------

function attachTyping(channel) {
  channel.sendTyping = async () => {};
}

function makeGorkMessage(env, opts = {}) {
  const channel = opts.channel || env.channels.general;
  const author = opts.author || env.users.memberUser;
  const member =
    opts.member != null
      ? opts.member
      : env.guild.members.cache.get(author.id) ||
        env.createMember({ guild: env.guild, user: author, admin: false });
  const id = opts.id || `gorkb-${Math.random().toString(36).slice(2)}`;

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
    reference: null,
    fetchReference: async () => {
      throw new Error(`message ${id} has no reference`);
    },
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
  };
  return { message, replies, reacts };
}

function embedText(embed) {
  if (!embed) return "";
  const data =
    typeof embed.toJSON === "function" ? embed.toJSON() : embed.data || embed;
  const parts = [];
  if (data.title) parts.push(String(data.title));
  if (data.description) parts.push(String(data.description));
  if (Array.isArray(data.fields)) {
    for (const f of data.fields) {
      if (f?.name) parts.push(String(f.name));
      if (f?.value) parts.push(String(f.value));
    }
  }
  return parts.join("\n");
}

function gorkIdle() {
  return require("../../src/features/gork/trigger").whenGorkIdleForTests();
}

/** Macrotask boundary (NOT a sleep): lets parked mock chains settle to their next blocking point. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
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

const today = () => new Date().toISOString().slice(0, 10);

/** Standard gork guild: keyword on, cooldown off (the budget is the gate). */
function setupGuild(env, over = {}) {
  env.db.updateGuildSettings(env.guild.id, {
    gork_keyword: "gork",
    gork_cooldown_sec: 0,
    audit_log_channel_id: IDS.channelLog,
    ...over,
  });
  attachTyping(env.channels.general);
}

// ---------- tests ----------

describe("integration: gork daily usage budget (roadmap §7.17)", () => {
  it("exact cap: two answers count, the third bounces with scope + reset, the fourth is deduped silent, another user is unaffected", async () => {
    const env = await freshEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse("Answer one."),
      chatCompletionResponse("Answer two."),
      chatCompletionResponse("Other user answered."),
    ]);
    try {
      enableAiKey();
      setupGuild(env);
      // Channel rule → the locked §7.17.5 wording names the channel.
      env.db.upsertGorkBudgetRule(env.guild.id, "channel", IDS.channelGeneral, 2, null);

      const m1 = makeGorkMessage(env, { id: "b1", content: "gork: q1" });
      await env.onMessageCreate(m1.message);
      await gorkIdle();
      assert.equal(m1.replies[0].content, "Answer one.");

      const m2 = makeGorkMessage(env, { id: "b2", content: "gork: q2" });
      await env.onMessageCreate(m2.message);
      await gorkIdle();
      assert.equal(m2.replies[0].content, "Answer two.");
      assert.equal(
        env.db.getGorkUsage(env.guild.id, IDS.member, "channel", IDS.channelGeneral, today()),
        2,
        "both successes counted in the winning (channel) scope",
      );
      assert.equal(
        env.db.getGorkUsage(env.guild.id, IDS.member, "guild", "0", today()),
        0,
        "the guild-default counter is untouched when a channel rule wins",
      );

      // Third trigger: over budget → terse directed reply naming scope +
      // reset, NO clock reaction (that stays cooldown-only), no LLM call.
      const m3 = makeGorkMessage(env, { id: "b3", content: "gork: q3" });
      await env.onMessageCreate(m3.message);
      await gorkIdle();
      assert.equal(fetchMock.calls.length, 2, "rejection must not hit the LLM");
      assert.equal(m3.replies.length, 1, "one rejection reply");
      assert.match(
        m3.replies[0].content,
        /Daily gork budget reached in #general \(2\/day\) — resets 00:00 UTC\./,
      );
      assert.deepEqual(m3.reacts, [], "budget rejections never react 🕐");

      // Fourth trigger (same user+scope): hourly dedup → silent bounce.
      const m4 = makeGorkMessage(env, { id: "b4", content: "gork: q4" });
      await env.onMessageCreate(m4.message);
      await gorkIdle();
      assert.equal(m4.replies.length, 0, "rejection replies dedup 1/hour/scope");

      // The budget is per USER: a different user is unaffected.
      const m5 = makeGorkMessage(env, {
        id: "b5",
        content: "gork: q5",
        author: env.users.member2User,
        member: env.members.member2,
      });
      await env.onMessageCreate(m5.message);
      await gorkIdle();
      assert.equal(m5.replies[0].content, "Other user answered.");

      // Q&A audit embed of the second answer carries the Budget field.
      const auditBlob = env.channels.log.sent
        .map((p) => embedText(p?.embeds?.[0]))
        .join("\n");
      assert.match(auditBlob, /2\/2 in #general/);
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("blocked scope (-1): own rejection surface, zero LLM calls, zero usage rows — staff included", async () => {
    const env = await freshEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([]);
    try {
      enableAiKey();
      setupGuild(env); // guild default unlimited
      env.db.upsertGorkBudgetRule(env.guild.id, "channel", IDS.channelGeneral, -1, null);

      const m1 = makeGorkMessage(env, { id: "bx1", content: "gork: blocked?" });
      await env.onMessageCreate(m1.message);
      await gorkIdle();
      assert.equal(m1.replies[0].content, "gork isn't available in this channel.");
      assert.equal(fetchMock.calls.length, 0);

      // Staff are NOT exempt from block/budget (decision 35). Different
      // user: the hourly rejection dedup keys on (user, scope), so a fresh
      // user gets its own blocked surface to observe.
      const m2 = makeGorkMessage(env, {
        id: "bx2",
        content: "gork: blocked?",
        author: env.users.adminUser,
        member: env.members.adminMember,
      });
      await env.onMessageCreate(m2.message);
      await gorkIdle();
      assert.equal(m2.replies[0].content, "gork isn't available in this channel.");
      assert.equal(fetchMock.calls.length, 0);

      assert.equal(
        env.db.getGorkUsage(env.guild.id, IDS.member, "channel", IDS.channelGeneral, today()),
        0,
        "blocked triggers never count",
      );
      assert.equal(
        env.db.getGorkUsage(env.guild.id, IDS.admin, "channel", IDS.channelGeneral, today()),
        0,
        "blocked staff never count either",
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("category rule pools channels inside it and owns the counter", async () => {
    const env = await freshEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([chatCompletionResponse("Category answer.")]);
    try {
      enableAiKey();
      setupGuild(env, { gork_daily_limit: 9 });
      env.db.upsertGorkBudgetRule(env.guild.id, "category", "cat-support", 1, null);
      env.channels.general.parent = { id: "cat-support", name: "Support", type: 4 };

      const m1 = makeGorkMessage(env, { id: "bc1", content: "gork: first" });
      await env.onMessageCreate(m1.message);
      await gorkIdle();
      assert.equal(m1.replies[0].content, "Category answer.");
      assert.equal(
        env.db.getGorkUsage(env.guild.id, IDS.member, "category", "cat-support", today()),
        1,
        "counter lives on the winning (category) scope",
      );
      assert.equal(
        env.db.getGorkUsage(env.guild.id, IDS.member, "guild", "0", today()),
        0,
        "the guild default counter stayed untouched",
      );

      const m2 = makeGorkMessage(env, { id: "bc2", content: "gork: second" });
      await env.onMessageCreate(m2.message);
      await gorkIdle();
      assert.match(
        m2.replies[0].content,
        /Daily gork budget reached in category "Support" \(1\/day\)/,
      );
      assert.equal(fetchMock.calls.length, 1);
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("queued multi-request no-overage: with the cooldown off, a dequeue that finds the budget spent bounces WITHOUT an LLM call", async () => {
    const env = await freshEnv();
    const saved = saveEnv();
    let releaseFirst;
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const fetchMock = mockFetch([
      async () => {
        await gate; // hold the in-flight slot so B and C queue behind A
        return chatCompletionResponse("Answer A.");
      },
      chatCompletionResponse("Answer B."),
      // Deliberately NO third entry: a third fetch would throw.
    ]);
    try {
      enableAiKey();
      setupGuild(env, { gork_daily_limit: 2 });

      const mA = makeGorkMessage(env, { id: "bq-a", content: "gork: question A" });
      await env.onMessageCreate(mA.message);
      await flush();

      // Same user, cooldown off: B and C queue behind A (up to 5 allowed).
      const mB = makeGorkMessage(env, { id: "bq-b", content: "gork: question B" });
      await env.onMessageCreate(mB.message);
      const mC = makeGorkMessage(env, { id: "bq-c", content: "gork: question C" });
      await env.onMessageCreate(mC.message);
      await flush();

      const { gorkQueue } = require("../../src/features/gork/trigger");
      assert.equal(
        gorkQueue.waitingCount({ guildId: env.guild.id }),
        2,
        "B and C parked on their FIFO turns",
      );

      releaseFirst();
      await gorkIdle();

      assert.equal(mA.replies[0].content, "Answer A.");
      assert.equal(mB.replies[0].content, "Answer B.");
      // C dequeued AFTER B's increment (decision 32) → sees used=2 → bounces
      // with no LLM call and no count (decision 33).
      assert.match(
        mC.replies[0].content,
        /Daily gork budget reached in this server \(2\/day\)/,
      );
      assert.equal(fetchMock.calls.length, 2, "exactly two LLM calls — no overage");
      assert.equal(
        env.db.getGorkUsage(env.guild.id, IDS.member, "guild", "0", today()),
        2,
        "the bounced request added no count",
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("partial send not counted: a mid-answer send failure leaves the budget untouched (strictest reading of 'no error')", async () => {
    const env = await freshEnv();
    const saved = saveEnv();
    // > 2000 chars → two chunks; the SECOND channel send (chunk 2) fails.
    const longAnswer = `${"A".repeat(1500)}\n${"B".repeat(800)}`;
    const fetchMock = mockFetch([
      chatCompletionResponse(longAnswer),
      chatCompletionResponse("Small answer."),
    ]);
    try {
      enableAiKey();
      setupGuild(env, { gork_daily_limit: 1 });

      const ch = env.channels.general;
      const originalSend = ch.send.bind(ch);
      let sends = 0;
      ch.send = async (payload) => {
        sends += 1;
        if (sends === 2) throw new Error("simulated mid-answer send failure");
        return originalSend(payload);
      };

      const m1 = makeGorkMessage(env, { id: "bp1", content: "gork: big" });
      await env.onMessageCreate(m1.message);
      await gorkIdle();
      assert.ok(sends >= 2, "chunk 1 sent, chunk 2 attempted");
      assert.equal(
        env.db.getGorkUsage(env.guild.id, IDS.member, "guild", "0", today()),
        0,
        "chunk-2 failure means NO count even though chunk 1 landed",
      );

      // Budget still available → the next trigger answers and counts once.
      const m2 = makeGorkMessage(env, { id: "bp2", content: "gork: small" });
      await env.onMessageCreate(m2.message);
      await gorkIdle();
      assert.equal(m2.replies[0].content, "Small answer.");
      assert.equal(
        env.db.getGorkUsage(env.guild.id, IDS.member, "guild", "0", today()),
        1,
        "only the fully-delivered answer counted",
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("LLM failure never counts; empty-then-retry SUCCESS counts exactly once", async () => {
    const env = await freshEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse(null), // trigger 1: ok-but-empty…
      chatCompletionResponse(null), // …retry also empty → canned failure
      chatCompletionResponse(null), // trigger 2: ok-but-empty…
      chatCompletionResponse("Retry succeeded."), // …retry lands → success
    ]);
    try {
      enableAiKey();
      setupGuild(env, { gork_daily_limit: 1 });

      const m1 = makeGorkMessage(env, { id: "bf1", content: "gork: fail?" });
      await env.onMessageCreate(m1.message);
      await gorkIdle();
      assert.equal(m1.replies[0].content, LLM_FAILURE_REPLY);
      assert.equal(
        env.db.getGorkUsage(env.guild.id, IDS.member, "guild", "0", today()),
        0,
        "canned failure replies never count",
      );

      const m2 = makeGorkMessage(env, { id: "bf2", content: "gork: retry?" });
      await env.onMessageCreate(m2.message);
      await gorkIdle();
      assert.equal(m2.replies[0].content, "Retry succeeded.");
      assert.equal(
        env.db.getGorkUsage(env.guild.id, IDS.member, "guild", "0", today()),
        1,
        "the empty-retry success counted ONCE despite two LLM calls",
      );

      // Cap (1) is now reached: next trigger bounces with no further fetch.
      const m3 = makeGorkMessage(env, { id: "bf3", content: "gork: over?" });
      await env.onMessageCreate(m3.message);
      await gorkIdle();
      assert.match(m3.replies[0].content, /Daily gork budget reached/);
      assert.equal(fetchMock.calls.length, 4, "rejection added no fetch");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("DB-backed counters: pre-existing usage rows reject immediately (restart-refund-proof)", async () => {
    const env = await freshEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([]);
    try {
      enableAiKey();
      setupGuild(env, { gork_daily_limit: 1 });

      // Simulate "already spent before this process started" straight in the
      // DB — the gate reads usage from SQLite, never from process memory.
      env.db.incrementGorkUsage(env.guild.id, IDS.member, "guild", "0", today());

      const m1 = makeGorkMessage(env, { id: "br1", content: "gork: refund me?" });
      await env.onMessageCreate(m1.message);
      await gorkIdle();
      assert.match(m1.replies[0].content, /Daily gork budget reached in this server \(1\/day\)/);
      assert.equal(fetchMock.calls.length, 0);
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("staff member hits a REAL cap: counted, then rejected (cooldown bypass must not skip the budget)", async () => {
    const env = await freshEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([chatCompletionResponse("Staff answer.")]);
    try {
      enableAiKey();
      // 180s cooldown: staff bypass it (decision 35 keeps the bypass) but the
      // budget must still count and reject them — decision 35's counting half.
      setupGuild(env, { gork_daily_limit: 1, gork_cooldown_sec: 180 });

      const m1 = makeGorkMessage(env, {
        id: "bs1",
        content: "gork: staff q",
        author: env.users.adminUser,
        member: env.members.adminMember,
      });
      await env.onMessageCreate(m1.message);
      await gorkIdle();
      assert.equal(m1.replies[0].content, "Staff answer.", "staff still get answers (cooldown bypassed)");
      assert.deepEqual(m1.reacts, [], "staff never see the 🕐 cooldown reaction");
      assert.equal(
        env.db.getGorkUsage(env.guild.id, IDS.admin, "guild", "0", today()),
        1,
        "the staff success COUNTS (no exemption)",
      );

      const m2 = makeGorkMessage(env, {
        id: "bs2",
        content: "gork: staff again",
        author: env.users.adminUser,
        member: env.members.adminMember,
      });
      await env.onMessageCreate(m2.message);
      await gorkIdle();
      assert.match(
        m2.replies[0].content,
        /Daily gork budget reached in this server \(1\/day\)/,
        "staff are rejected by the cap like everyone else",
      );
      assert.equal(fetchMock.calls.length, 1, "the rejected staff trigger skipped the LLM");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("threads obey the PARENT channel's rule: shared counter, parent-named rejection (kill-switch promise)", async () => {
    const env = await freshEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([chatCompletionResponse("Thread answer.")]);
    try {
      enableAiKey();
      setupGuild(env);
      env.db.upsertGorkBudgetRule(env.guild.id, "channel", IDS.channelGeneral, 1, null);

      let threadSeq = 0;
      const makeThread = (id) => ({
        id,
        name: `thread-${id}`,
        type: 11, // GuildPublicThread
        isThread: () => true,
        isTextBased: () => true,
        parent: env.channels.general,
        sent: [],
        send: async (payload) => {
          threadSeq += 1;
          const sent = { id: `${id}-s-${threadSeq}`, ...payload };
          return sent;
        },
        sendTyping: async () => {},
      });
      const thread = makeThread("thr-1");

      const m1 = makeGorkMessage(env, { id: "bt1", content: "gork: in thread", channel: thread });
      await env.onMessageCreate(m1.message);
      await gorkIdle();
      assert.equal(m1.replies[0].content, "Thread answer.");
      assert.equal(
        env.db.getGorkUsage(env.guild.id, IDS.member, "channel", IDS.channelGeneral, today()),
        1,
        "the counter binds the PARENT channel, not the thread id",
      );

      const m2 = makeGorkMessage(env, { id: "bt2", content: "gork: again", channel: thread });
      await env.onMessageCreate(m2.message);
      await gorkIdle();
      assert.match(
        m2.replies[0].content,
        /Daily gork budget reached in #general \(1\/day\)/,
        "rejection names the parent channel",
      );
      assert.equal(fetchMock.calls.length, 1, "over-budget thread trigger skipped the LLM");

      // A SIBLING thread shares the same parent counter — no escape hatch.
      const sibling = makeThread("thr-2");
      const m3 = makeGorkMessage(env, { id: "bt3", content: "gork: sibling", channel: sibling });
      await env.onMessageCreate(m3.message);
      await gorkIdle();
      assert.equal(m3.replies.length, 0, "hourly dedup keeps the sibling bounce silent");
      assert.equal(fetchMock.calls.length, 1, "still no second LLM call");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("budget-read failure fails CLOSED with the canned reply — never a silent drop, never counts", async () => {
    const env = await freshEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([]);
    const realGetGorkUsage = env.db.getGorkUsage;
    try {
      enableAiKey();
      setupGuild(env, { gork_daily_limit: 5 });
      // budget.js destructures the db facade at call time → patch visible.
      env.db.getGorkUsage = () => {
        throw new Error("simulated usage-read failure");
      };

      const m1 = makeGorkMessage(env, { id: "be1", content: "gork: broken db?" });
      await env.onMessageCreate(m1.message);
      await gorkIdle();
      assert.equal(
        m1.replies[0]?.content,
        LLM_FAILURE_REPLY,
        "fail-closed must still answer with the sanctioned canned reply (no silence)",
      );
      assert.equal(fetchMock.calls.length, 0, "no LLM call when the gate cannot read usage");
      const rows = env.db.db
        .prepare(`SELECT COUNT(*) AS n FROM gork_usage WHERE guild_id=?`)
        .get(env.guild.id);
      assert.equal(rows.n, 0, "a failed gate never counts");

      // Second trigger, same user: throttled like a normal rejection — a
      // broken settings read must not turn every message into a reply.
      const m2 = makeGorkMessage(env, { id: "be2", content: "gork: still broken?" });
      await env.onMessageCreate(m2.message);
      await gorkIdle();
      assert.equal(m2.replies.length, 0, "error replies are throttled 1/hour too");
    } finally {
      env.db.getGorkUsage = realGetGorkUsage;
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("day key is the TRIGGER MESSAGE's UTC date: yesterday's trigger spends yesterday", async () => {
    const env = await freshEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse("Late-yesterday answer."),
      chatCompletionResponse("Today answer."),
    ]);
    try {
      enableAiKey();
      setupGuild(env, { gork_daily_limit: 1 });

      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const m1 = makeGorkMessage(env, { id: "bd1", content: "gork: 23:59 yesterday" });
      m1.message.createdAt = new Date(`${yesterday}T23:59:00Z`);
      await env.onMessageCreate(m1.message);
      await gorkIdle();
      assert.equal(m1.replies[0].content, "Late-yesterday answer.");
      assert.equal(
        env.db.getGorkUsage(env.guild.id, IDS.member, "guild", "0", yesterday),
        1,
        "counted on the trigger's UTC day (yesterday), not the wall clock",
      );

      // Today, same cap-1 budget: allowed — the counters live on different days.
      const m2 = makeGorkMessage(env, { id: "bd2", content: "gork: today" });
      await env.onMessageCreate(m2.message);
      await gorkIdle();
      assert.equal(m2.replies[0].content, "Today answer.");
      assert.equal(
        env.db.getGorkUsage(env.guild.id, IDS.member, "guild", "0", today()),
        1,
      );

      // Today's cap is now spent → reject without a third fetch.
      const m3 = makeGorkMessage(env, { id: "bd3", content: "gork: today again" });
      await env.onMessageCreate(m3.message);
      await gorkIdle();
      assert.match(m3.replies[0].content, /Daily gork budget reached/);
      assert.equal(fetchMock.calls.length, 2);
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("counters survive a real DB reopen (decision 37, literal)", async () => {
    const env = await freshEnv();
    const saved = saveEnv();
    const fetchMock = mockFetch([chatCompletionResponse("Before restart.")]);
    try {
      enableAiKey();
      setupGuild(env, { gork_daily_limit: 1 });

      const m1 = makeGorkMessage(env, { id: "bo1", content: "gork: before restart" });
      await env.onMessageCreate(m1.message);
      await gorkIdle();
      assert.equal(m1.replies[0].content, "Before restart.");

      // Literal restart: drop every src/ module (fresh connections and fresh
      // in-memory state) and re-open the SAME SQLite file.
      resetSrcModules();
      const fresh = require("../../src/db");
      try {
        assert.equal(
          fresh.getGorkUsage(env.guild.id, IDS.member, "guild", "0", today()),
          1,
          "the counter survives the process-level restart",
        );
      } finally {
        try {
          fresh.db?.close();
        } catch {
          // best effort
        }
      }
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });
});
