/**
 * /gork summarize HANDLER tests (roadmap/gork.md §7.21, subtask 08).
 *
 * Drives handleSummarize end-to-end against fake Discord objects
 * (test/helpers/discord.js) + a real temp SQLite (budget counters, tickets,
 * interaction-log rows) + a mocked global fetch for the one-shot AI call.
 * Covers the full error-branch matrix: mode usage errors, cooldown armed,
 * budget bounce, security refusal, unknown anchor, empty range, fetch
 * partial, generation failure, embed-post failure (+ the ordered poster's
 * all-chunks-land accounting), queue-full drop, and the success bookkeeping
 * (embed posted → cooldown armed → budget counted once → audit embed →
 * interaction-log row) for all three modes.
 */
const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// Contract (same as the other repo tests): loadDb() must run before any
// src/ db access — fresh temp SQLite, src require-cache reset, cleanup.
const { loadDb, communityKey } = require("./helpers/env");

let api;
let cleanup;
let D; // discord helpers
let H; // gork handlers
let FEATURE; // gork feature index (dispatch)
let cooldown; // summarizeCooldown (singleton resets + assertions)
let budget; // budget (rejection-throttle reset)
let gorkQueue; // the SHARED queue the handler must use

before(() => {
  ({ api, cleanup } = loadDb());
  H = require("../src/features/gork/handlers");
  FEATURE = require("../src/features/gork");
  cooldown = require("../src/features/gork/summarizeCooldown");
  budget = require("../src/features/gork/budget");
  gorkQueue = require("../src/features/gork/trigger").gorkQueue;
  D = require("./helpers/discord");
});

after(() => cleanup?.());

// ---------- env + AI scaffolding ----------

const AI_ENV = [
  "AI_API_KEY",
  "AI_BASE_URL",
  "AI_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "GORK_LLM_THINKING_TOKEN_BUDGET",
  "GORK_SUMMARIZE_TURN_TIMEOUT_MS",
  "GORK_INTERACTION_LOG",
  "GORK_DEBUG",
];

let envSnapshot = null;
let origFetch = null;
let aiCalls = null;

const RUNDOWN = [
  "**Headline** — launch-week go/no-go.",
  "**What was decided** — ship Tuesday.",
  "**Open questions** — none.",
  "**Action items** — Alice: deploy.",
  "**Who said what that mattered** — Alice: ship it.",
].join("\n");

beforeEach(() => {
  envSnapshot = {};
  for (const key of AI_ENV) envSnapshot[key] = process.env[key];
  process.env.AI_API_KEY = "test-key-not-real";
  process.env.AI_BASE_URL = "https://ai.example/v1";
  process.env.AI_MODEL = "test-model";
  for (const key of AI_ENV.slice(3)) delete process.env[key];
  origFetch = globalThis.fetch;
  aiCalls = [];
  // Fresh per-guild / per-user gates for every test (all singletons).
  cooldown.resetSummarizeGuildCooldownForTests();
  budget.resetBudgetRejectThrottleForTests();
  gorkQueue.reset();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  for (const key of AI_ENV) {
    if (envSnapshot[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
});

/** Mock the one-shot OpenAI call; records every wire request. */
function stubAi({ content = RUNDOWN, ok = true, status = 200 } = {}) {
  aiCalls = [];
  globalThis.fetch = async (url, init) => {
    aiCalls.push({ url, body: init ? JSON.parse(init.body) : null });
    if (!ok) {
      return { ok: false, status, text: async () => "provider boom", json: async () => ({}) };
    }
    return {
      ok: true,
      status,
      json: async () => ({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [
          { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
        ],
        usage: { completion_tokens: 7 },
      }),
    };
  };
}

// ---------- fixtures ----------

let seq = 0;

/**
 * Guild + invocation channel with a 3-message conversation, an admin
 * invoker (member row added — the reader's ViewChannel parity gate fetches
 * it), and a client wired to the guild (audit-channel resolution seam).
 */
function makeEnv(options = {}, { seed = true } = {}) {
  seq += 1;
  const guildId = `gs-${seq}`;
  const communityId = communityKey(guildId);
  const guild = D.createGuild({ id: guildId });
  const channel = D.createTextChannel({
    id: `ch-${seq}`,
    guild,
    name: `general-${seq}`,
  });
  guild.addChannel(channel);
  const client = D.createClient();
  client.addGuild(guild);
  const user = D.createUser({ id: `staff-${seq}`, username: `staffer${seq}` });
  const member = D.createMember({ guild, user, admin: true });
  guild.addMember(member);
  const interaction = D.createChatInputInteraction({
    commandName: "gork",
    subcommand: "summarize",
    guild,
    user,
    member,
    admin: true,
    channel,
    channelId: channel.id,
    client,
    options,
  });
  interaction.id = `itc-${seq}`;
  if (seed) {
    channel.addMessage({
      id: "1000000000000000101",
      content: "first message",
      author: { id: "1111", username: "alice" },
    });
    channel.addMessage({
      id: "1000000000000000102",
      content: "second message",
      author: { id: "2222", username: "bob" },
    });
    channel.addMessage({
      id: "1000000000000000103",
      content: "third message",
      author: { id: "3333", username: "eve" },
    });
  }
  return { guildId, communityId, guild, channel, client, user, member, interaction };
}

/** Count channel.messages.fetch calls (proves "no read" branches). */
function spyReads(channel) {
  const counter = { reads: 0 };
  const orig = channel.messages.fetch;
  channel.messages.fetch = (arg) => {
    counter.reads += 1;
    return orig(arg);
  };
  return counter;
}

const run = (env) =>
  H.handleSummarize(env.client, env.interaction, env.guildId, env.communityId);

const today = () => new Date().toISOString().slice(0, 10);

const editedReplies = (interaction) => interaction.replies.filter((r) => r?._edited);

function embedData(payloadEmbed) {
  return payloadEmbed?.toJSON ? payloadEmbed.toJSON() : payloadEmbed;
}

function embedField(embed, name) {
  return (embed.fields || []).find((f) => f.name === name)?.value;
}

const usageRows = (communityId) =>
  api.db.prepare("SELECT COUNT(*) AS n FROM gork_usage WHERE community_id = ?").get(communityId).n;

const interactionRow = (communityId) =>
  api.db
    .prepare("SELECT kind, status, context_meta FROM gork_interactions WHERE community_id = ?")
    .get(communityId);

// ---------- mode usage errors (decision 53) ----------

describe("/gork summarize — mode-exclusivity usage errors", () => {
  const badCombos = [
    { label: "from + last", options: { from: "1000000000000000101", last: 5 } },
    { label: "to without from", options: { to: "1000000000000000102" } },
    { label: "no range at all", options: {} },
  ];
  for (const { label, options } of badCombos) {
    it(`${label}: ephemeral usage error naming the three modes`, async () => {
      const env = makeEnv(options);
      stubAi();
      await run(env);
      assert.equal(env.interaction.deferred, false, "answered without deferring");
      assert.equal(D.lastReplyEphemeral(env.interaction), true);
      assert.match(D.lastReplyContent(env.interaction), /Give exactly one range/);
      assert.match(D.lastReplyContent(env.interaction), /from:\+to:.*from: alone.*last:<N>/s);
      assert.equal(aiCalls.length, 0, "no LLM call for a usage error");
      assert.equal(cooldown.checkSummarizeGuildCooldown(env.communityId), 0, "never arms");
    });
  }
});

// ---------- happy paths: all three modes ----------

describe("/gork summarize — happy paths (post + arm + count)", () => {
  const modes = [
    { label: "from+to", options: { from: "1000000000000000101", to: "1000000000000000103" }, mode: "from-to" },
    { label: "from→now", options: { from: "1000000000000000101" }, mode: "from-now" },
    { label: "last:2", options: { last: 2 }, mode: "last" },
  ];
  for (const { label, options, mode } of modes) {
    it(`${label}: posts the embed, arms the cooldown, counts the budget once`, async () => {
      const env = makeEnv(options);
      api.updateGuildSettings(env.communityId, { gork_daily_limit: 5 });
      stubAi();
      await run(env);

      assert.equal(env.interaction.deferred, true, "deferred before the read");
      assert.equal(aiCalls.length, 1, "exactly one one-shot AI call");

      const edits = editedReplies(env.interaction);
      assert.equal(edits.length, 1, "the deferred reply carries the rundown embed");
      const embed = embedData(edits[0].embeds[0]);
      assert.equal(embed.title, "Gork rundown");
      assert.equal(embedField(embed, "Mode"), mode);
      assert.match(embed.footer.text, /@staffer/, "footer names the invoker");
      assert.match(embed.footer.text, /discord\.com\/channels\//, "range jump links in footer");
      assert.deepEqual(edits[0].allowedMentions, { parse: [] }, "NO_PING_MENTIONS on the post");
      assert.equal(env.interaction.followUps.length, 0, "no continuation embed needed");

      assert.ok(
        cooldown.checkSummarizeGuildCooldown(env.communityId) > 0,
        "guild cooldown armed on success",
      );
      assert.equal(usageRows(env.communityId), 1, "budget counted exactly once");

      const row = interactionRow(env.communityId);
      assert.equal(row.kind, "summarize", "interaction-log row recorded");
      assert.equal(row.status, "shipped");
      assert.equal(JSON.parse(row.context_meta).surface, "summarize");
    });
  }

  it("last: mode carries last_count + the audit embed lands on the log channel", async () => {
    const env = makeEnv({ last: 2 });
    const auditCh = D.createTextChannel({ id: `audit-${seq}`, guild: env.guild, name: "audit" });
    env.guild.addChannel(auditCh);
    api.updateGuildSettings(env.communityId, { audit_log_channel_id: auditCh.id });
    stubAi();
    await run(env);

    const row = interactionRow(env.communityId);
    assert.equal(JSON.parse(row.context_meta).last_count, 2);

    const audits = auditCh.sent
      .filter((p) => p?.embeds?.length)
      .map((p) => embedData(p.embeds[0]));
    const summary = audits.find((e) => e.title === "Gork summarize");
    assert.ok(summary, "logGorkSummarize audit embed posted to the log channel");
    assert.equal(embedField(summary, "Mode"), "last:2");
    assert.ok(
      (embedField(summary, "Requested by") || "").length > 0,
      "audit names the requester",
    );
  });

  it("focus + lang ride into the recorder context", async () => {
    const env = makeEnv({ last: 3, focus: "decisions only", lang: "spanish" });
    stubAi();
    await run(env);
    const meta = JSON.parse(interactionRow(env.communityId).context_meta);
    assert.equal(meta.focus, "decisions only");
    assert.equal(meta.lang, "spanish");
  });
});

// ---------- cooldown armed: no read, no LLM ----------

describe("/gork summarize — per-guild cooldown", () => {
  it("armed guild replies minutes remaining WITHOUT reading or generating", async () => {
    const env = makeEnv({ last: 3 });
    const reads = spyReads(env.channel);
    cooldown.armSummarizeGuildCooldown(env.communityId);
    stubAi();
    await run(env);

    assert.equal(D.lastReplyEphemeral(env.interaction), true);
    assert.match(D.lastReplyContent(env.interaction), /already posted one/);
    assert.match(D.lastReplyContent(env.interaction), /minute/i);
    assert.match(D.lastReplyContent(env.interaction), /Nothing was read or generated/);
    assert.equal(reads.reads, 0, "the range reader was NOT touched");
    assert.equal(aiCalls.length, 0, "no LLM call while armed");
    assert.equal(usageRows(env.communityId), 0, "no budget counted");
  });
});

// ---------- budget ----------

describe("/gork summarize — daily budget gate", () => {
  it("over budget: replies with the locked rejection and never runs", async () => {
    const env = makeEnv({ last: 3 });
    api.updateGuildSettings(env.communityId, { gork_daily_limit: 1 });
    api.incrementGorkUsage(env.communityId, env.user.id, "guild", "0", today());
    const reads = spyReads(env.channel);
    stubAi();
    await run(env);

    assert.equal(D.lastReplyEphemeral(env.interaction), true);
    assert.match(D.lastReplyContent(env.interaction), /Daily gork budget reached/);
    assert.match(D.lastReplyContent(env.interaction), /resets 00:00 UTC/);
    assert.equal(reads.reads, 0, "never queued, never read");
    assert.equal(aiCalls.length, 0);
    assert.equal(env.interaction.deferred, false, "bounced before deferring");
    assert.ok(usageRows(env.communityId) <= 1, "no extra count on the bounce");
  });

  it("blocked scope (-1) gets its own surface", async () => {
    const env = makeEnv({ last: 3 });
    // Guild-wide kill switch: settings default limit -1 (decision 34) — the
    // shape resolveGorkBudget actually resolves (mirrors gork-budget-gate).
    api.updateGuildSettings(env.communityId, { gork_daily_limit: -1 });
    stubAi();
    await run(env);
    assert.match(D.lastReplyContent(env.interaction), /gork isn't available in this server/);
    assert.equal(aiCalls.length, 0);
  });
});

// ---------- range-read failures ----------

describe("/gork summarize — range read failures", () => {
  it("cross-guild link is refused before any fetch (decision 46)", async () => {
    const env = makeEnv({
      from: "https://discord.com/channels/999999999999999999/123/456",
    });
    const reads = spyReads(env.channel);
    stubAi();
    await run(env);
    const text = D.lastReplyContent(env.interaction);
    assert.match(text, /another server/);
    assert.equal(reads.reads, 0, "guild isolation runs BEFORE any fetch");
    assert.equal(aiCalls.length, 0);
    assert.equal(cooldown.checkSummarizeGuildCooldown(env.communityId), 0);
  });

  it("deleted/unknown anchor gets the specific notfound cause", async () => {
    const env = makeEnv({ from: "9999999999999999999999" });
    stubAi();
    await run(env);
    assert.match(D.lastReplyContent(env.interaction), /deleted or unknown id/);
    assert.equal(aiCalls.length, 0);
    assert.equal(cooldown.checkSummarizeGuildCooldown(env.communityId), 0);
  });

  it("empty range replies zero-readable, no rundown", async () => {
    const env = makeEnv({ last: 10 }, { seed: false });
    stubAi();
    await run(env);
    assert.match(D.lastReplyContent(env.interaction), /No readable messages/);
    assert.equal(aiCalls.length, 0);
    assert.equal(cooldown.checkSummarizeGuildCooldown(env.communityId), 0);
  });

  it("mid-range fetch failure reports the partial window and produces nothing", async () => {
    const env = makeEnv({ from: "1000000000000000101" });
    stubAi();
    const orig = env.channel.messages.fetch;
    let pages = 0;
    env.channel.messages.fetch = (arg) => {
      if (typeof arg === "string") return orig(arg); // anchor fetch
      pages += 1;
      if (pages === 1) return orig(arg); // first page fine (1000000000000000102)
      throw new Error("rest 500 boom"); // second page dies
    };
    await run(env);

    const text = D.lastReplyContent(env.interaction);
    assert.match(text, /Message fetch failed/);
    assert.match(text, /rest 500 boom/, "carries the cause");
    assert.match(text, /no rundown was produced/);
    // Progress counts everything read before the throw: anchor + page 1.
    assert.match(text, /Partial window actually read: \*\*3\*\* message\(s\) \(1000000000000000101 → 1000000000000000103\)/);
    assert.equal(aiCalls.length, 0, "no generation from a partial read");
    assert.equal(cooldown.checkSummarizeGuildCooldown(env.communityId), 0, "no arm");
    assert.equal(usageRows(env.communityId), 0, "no count");
  });
});

// ---------- generation + post failures ----------

describe("/gork summarize — generation & post failures", () => {
  it("generation failure: specific reply, no arm, no count, failure row", async () => {
    const env = makeEnv({ last: 3 });
    api.updateGuildSettings(env.communityId, { gork_daily_limit: 5 });
    stubAi({ ok: false, status: 500 });
    await run(env);

    const text = D.lastReplyContent(env.interaction);
    assert.match(text, /rundown generation failed/);
    assert.match(text, /HTTP 500/, "carries the provider cause");
    assert.match(text, /budget was not counted/);
    assert.equal(cooldown.checkSummarizeGuildCooldown(env.communityId), 0, "no arm on generation failure");
    assert.equal(usageRows(env.communityId), 0, "no count on generation failure");
    assert.equal(interactionRow(env.communityId).status, "failure");
  });

  it("embed post failure: no arm, no count, posted count + cause reported", async () => {
    const env = makeEnv({ last: 3 });
    api.updateGuildSettings(env.communityId, { gork_daily_limit: 5 });
    stubAi();
    env.interaction.editReply = async () => {
      throw new Error("discord 500");
    };
    await run(env);

    assert.equal(env.interaction.followUps.length, 1, "failure reported via followUp");
    const note = env.interaction.followUps[0].content;
    assert.match(note, /Could not finish posting the rundown/);
    assert.match(note, /discord 500/, "carries the cause");
    assert.match(note, /\*\*0\*\* of 1 embed landed/, "posted count reported");
    assert.deepEqual(env.interaction.followUps[0].allowedMentions, { parse: [] });
    assert.equal(cooldown.checkSummarizeGuildCooldown(env.communityId), 0, "post failure never arms");
    assert.equal(usageRows(env.communityId), 0, "post failure never counts");
    assert.equal(interactionRow(env.communityId).status, "error");
  });

  it("postRundownPayloads posts in order and reports the mid-sequence count", async () => {
    const sentOrder = [];
    const interaction = {
      editReply: async (p) => {
        sentOrder.push("edit");
        assert.equal(p.embeds.length, 1, "one embed per message");
        return { id: "m1" };
      },
      followUp: async (p) => {
        sentOrder.push(`follow:${p.embeds[0]?.id ?? "?"}`);
        if (sentOrder.length === 2) {
          // second embed already landed; third dies
        }
        if (sentOrder.length === 3) throw new Error("embed-post boom");
        return { id: `f${sentOrder.length}` };
      },
    };
    const payloads = [
      { embeds: [{ id: "e1" }], allowedMentions: { parse: [] } },
      { embeds: [{ id: "e2" }], allowedMentions: { parse: [] } },
      { embeds: [{ id: "e3" }], allowedMentions: { parse: [] } },
    ];
    const res = await H.postRundownPayloads(interaction, payloads);
    assert.equal(res.ok, false);
    assert.equal(res.posted.length, 2, "exactly the embeds that LANDED are counted");
    assert.match(res.error, /embed-post boom/);
    assert.deepEqual(sentOrder, ["edit", "follow:e2", "follow:e3"]);
  });
});

// ---------- queue (decision 34) ----------

describe("/gork summarize — shared per-guild queue", () => {
  it("queue full: specific gork reply, nothing read or generated", async () => {
    const env = makeEnv({ last: 3 });
    stubAi();
    // Occupy the in-flight slot + the whole waiting room (5).
    const slot = gorkQueue.admit({ communityId: env.communityId });
    assert.equal(slot.dropped, false);
    const waiters = [
      gorkQueue.admit({ communityId: env.communityId }),
      gorkQueue.admit({ communityId: env.communityId }),
      gorkQueue.admit({ communityId: env.communityId }),
      gorkQueue.admit({ communityId: env.communityId }),
      gorkQueue.admit({ communityId: env.communityId }),
    ];
    assert.ok(waiters.every((w) => !w.dropped));

    const reads = spyReads(env.channel);
    await run(env);

    assert.equal(env.interaction.deferred, true);
    const text = D.lastReplyContent(env.interaction);
    assert.match(text, /brain is already busy/);
    assert.match(text, /Nothing was read or generated/);
    assert.equal(reads.reads, 0, "a dropped job never reads");
    assert.equal(aiCalls.length, 0);
    assert.equal(cooldown.checkSummarizeGuildCooldown(env.communityId), 0);
    assert.equal(usageRows(env.communityId), 0, "a dropped job never counts");
    gorkQueue.release({ guildId: env.guildId }); // (beforeEach reset() also clears state)
  });
});

// ---------- dispatch (index.js) ----------

describe("/gork — summarize subcommand dispatch", () => {
  it("handleGork routes `summarize` to the handler (staff gate kept)", async () => {
    const env = makeEnv({ last: 3 });
    cooldown.armSummarizeGuildCooldown(env.communityId); // bounce fast, prove the route
    stubAi();
    const gorkHandler = FEATURE.handlers.gork;
    await gorkHandler(env.interaction, { client: env.client });
    assert.match(D.lastReplyContent(env.interaction), /already posted one/);
    assert.equal(aiCalls.length, 0);
    // Non-staff gets the denial, never the rundown path:
    const nope = makeEnv({ last: 3 });
    nope.interaction.setAdmin(false);
    nope.member.setAdmin(false);
    await gorkHandler(nope.interaction, { client: nope.client });
    assert.doesNotMatch(D.lastReplyContent(nope.interaction), /already posted one/);
    assert.equal(nope.interaction.deferred, false);
  });
});

// ---------- /gork summarize-budget (per-guild input token budget) ----------

describe("/gork summarize-budget", () => {
  function budgetEnv(tokens) {
    const env = makeEnv({});
    const ixn = D.createChatInputInteraction({
      commandName: "gork",
      subcommand: "summarize-budget",
      guild: env.guild,
      user: env.user,
      member: env.member,
      admin: true,
      channel: env.channel,
      channelId: env.channel.id,
      client: env.client,
      options: { tokens },
    });
    return { env, ixn };
  }

  it("stores a valid budget and replies with the stored value", async () => {
    const { env, ixn } = budgetEnv(50000);
    await H.setSummarizeBudget(env.client, ixn, env.guildId, env.communityId);
    assert.equal(D.lastReplyEphemeral(ixn), true, "ephemeral confirmation");
    assert.match(D.lastReplyContent(ixn), /\*\*50000\*\* tokens/, "reply echoes the stored budget");
    assert.equal(api.getGuildSettings(env.communityId).gork_summarize_input_tokens, 50000);
  });

  it("out-of-range input gets the specific range reply — settings untouched", async () => {
    const { env, ixn } = budgetEnv(5000);
    await H.setSummarizeBudget(env.client, ixn, env.guildId, env.communityId);
    assert.equal(D.lastReplyEphemeral(ixn), true);
    assert.match(D.lastReplyContent(ixn), /8000-120000 tokens/, "names the allowed range");
    assert.equal(
      api.getGuildSettings(env.communityId).gork_summarize_input_tokens,
      80000,
      "prior value kept — nothing written",
    );
  });

  it("the guild's gork_summarize_input_tokens clamps the rundown transcript", async () => {
    const env = makeEnv({ last: 103 });
    // 8,000 tokens → 8,000 × 4 − 8,000 = 24,000-char transcript budget.
    api.updateGuildSettings(env.communityId, { gork_summarize_input_tokens: 8000 });
    // 100 fat messages on top of the seeded 3 (≈460-char lines → ~46k chars).
    for (let i = 0; i < 100; i += 1) {
      env.channel.addMessage({
        id: (1000000000000000104n + BigInt(i)).toString(),
        content: "x".repeat(400),
        author: { id: "4444", username: "frank" },
      });
    }
    stubAi();
    await run(env);

    assert.equal(env.interaction.deferred, true);
    assert.equal(aiCalls.length, 1, "exactly one one-shot AI call");
    const user = aiCalls[0].body.messages.find((m) => m.role === "user");
    assert.ok(
      user.content.includes("1000000000000000203 | "),
      "last: keeps the NEWEST messages",
    );
    assert.ok(
      !user.content.includes("1000000000000000101 | "),
      "the custom budget clamped the oldest lines away",
    );
    const edits = editedReplies(env.interaction);
    assert.ok(
      String(edits[0].content).includes("24000-character transcript budget"),
      `disclosure names the guild budget: ${String(edits[0].content).slice(0, 200)}`,
    );
  });
});
