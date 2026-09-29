/**
 * Integration tests for the `/gork summarize` MVP (roadmap/gork.md §7.21,
 * decisions 53–57): real SQLite via loadDb(), mocked Discord I/O, mocked
 * global fetch — no real network.
 *
 * Sibling of test/integration/gork.test.js with the same harness idioms
 * (fresh createIntegrationEnv per test: loadDb() resets the src require
 * cache, so the per-guild queue, the summarize cooldown gate and the
 * budget-reject throttle are all fresh module state per test). Unlike the
 * detached Q&A trigger pipeline, the whole summarize surface runs THROUGH
 * the awaited slash-command path (router → handler → budget gate → defer →
 * shared queue slot → range read → one-shot AI call → embed post →
 * success bookkeeping), so `await env.runCommand(...)` IS the structural
 * join — every assertion below observes final state with zero wall-clock
 * sleeps and zero polling (acceptance: existing seams only).
 *
 * Discord-side reads (channel.messages.fetch with after:/before:
 * pagination) are served by the harness fake channel — never HTTP. The
 * product code's ONLY network path is the one-shot AI completion
 * (src/core/ai.js) through globalThis.fetch, scripted by mockFetch(); an
 * unexpected global fetch REJECTS, so "no real network" is provable.
 *
 * Seeded channels, messages and anchors use real Discord-shaped 18-digit
 * snowflakes: fixed width keeps lexicographic id order chronological, the
 * exact contract the harness fetch fake and summarizeRange's idCmp rely on.
 *
 * Subtask gork-summarize-09 acceptance map (this file):
 *  - e2e ×3 modes (embed set, one AI fetch, budget once, one interaction
 *    row, audit embed, cooldown armed)  → tests "mode from+to ...",
 *    "mode from->now ...", "mode last:N ..."
 *  - cooldown (minutes-remaining reply, ZERO AI fetches, no budget; other
 *    guild still succeeds)              → test "per-guild cooldown ..."
 *  - caps + clamp-and-disclose          → tests "1,000-message read cap ...",
 *                                         "12,000-char transcript budget ..."
 *  - security (open ticket / cross-guild / ViewChannel parity)
 *                                       → tests "open help ticket ...",
 *    "cross-guild anchor ...", "invoker without ViewChannel ..."
 *  - failure economics (provider error, zero-readable range)
 *                                       → tests "AI provider error ...",
 *    "system-only range ..."
 *  - embed budget (embed-only posts, per-embed headroom, parse-empty
 *    allowedMentions)                   → test "long model output ..."
 *  - mode-exclusivity usage errors      → test "usage-error combinations ..."
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const { createGuild } = require("../helpers/discord");
const { assertEphemeralReply } = require("../helpers/assert");
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
  "GORK_LLM_MAX_TOKENS",
  "GORK_LLM_TIMEOUT_MS",
  "GORK_LLM_MAX_TOOL_ROUNDS",
  "GORK_LLM_THINKING_TOKEN_BUDGET",
  "GORK_MAX_ANSWER_CHARS",
  // Summarize-side knobs that must be deterministic for these tests:
  // the interaction-log kill switch (rows are asserted) and the one-shot
  // generation deadline (a stale ambient tiny value would time fetches out).
  "GORK_INTERACTION_LOG",
  "GORK_SUMMARIZE_TURN_TIMEOUT_MS",
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
 * The interaction-log kill switch is explicitly cleared: every success /
 * failure branch below asserts its migration-027 row.
 */
function enableAiKey() {
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
  delete process.env.OPENAI_MODEL;
  delete process.env.GORK_LLM_THINKING_TOKEN_BUDGET;
  delete process.env.GORK_SUMMARIZE_TURN_TIMEOUT_MS;
  delete process.env.GORK_INTERACTION_LOG;
  process.env.OPENAI_API_KEY = TEST_AI_KEY;
}

// ---------- mocked global fetch (AI completion only) ----------

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** One OpenAI chat.completion response. */
function chatCompletionResponse(content, messageExtra = {}) {
  const { finish_reason: fr, ...msgExtra } = messageExtra;
  return jsonResponse({
    id: "chatcmpl-sum-1",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, ...msgExtra },
        finish_reason: fr ?? "stop",
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
}

/** HTTP error WITH a provider error body (src/core/ai.js reads .text()). */
function providerErrorResponse(status, bodyText) {
  return {
    ok: false,
    status,
    json: async () => ({ error: { message: bodyText } }),
    text: async () => bodyText,
  };
}

/**
 * Replace globalThis.fetch with a scripted fake (gork.test.js idiom).
 * `script` entries are consumed in call order; an unexpected call rejects
 * the test instead of hitting the network.
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

// ---------- realistic snowflake ids ----------
// Fixed-width (18-digit) ids so lexicographic order == chronological order,
// matching the harness fetch fake + summarizeRange's idCmp contract.

let snowSeq = 0;
function snow(classDigit) {
  snowSeq += 1;
  return `${classDigit}${String(snowSeq).padStart(17, "0")}`;
}
const snowGuild = () => snow(9);
const snowChannel = () => snow(8);
const snowMessage = () => snow(7);
const snowUser = () => snow(6);
const snowInteraction = () => snow(5);

/** Full Discord message link (§7.19 grammar accepted by the anchor parser). */
function messageLink(guildId, channelId, messageId) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

// ---------- env lifecycle ----------

const createdEnvs = [];

/** createIntegrationEnv() + tracking so the file-level after() can clean up. */
async function freshEnv(options) {
  const env = await createIntegrationEnv(options);
  createdEnvs.push(env);
  return env;
}

after(() => {
  for (const env of createdEnvs) env.cleanup();
  createdEnvs.length = 0;
});

// ---------- shared summarize helpers ----------

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

/** Standard per-guild settings for a summarize run: audit sink + a bounded budget. */
function setupGuild(env, guildId = env.guild.id, extra = {}) {
  env.db.updateGuildSettings(guildId, {
    audit_log_channel_id: IDS.channelLog,
    gork_daily_limit: 3, // success-only counting must be observable
    ...extra,
  });
}

/** Numeric snowflake staff author + member so the roster resolves real names. */
function makeSpeaker(env, username, displayName) {
  const user = env.createUser({ id: snowUser(), username });
  const member = env.createMember({ guild: env.guild, user, admin: false });
  member.displayName = displayName || username;
  env.guild.addMember(member);
  return { user, member };
}

/**
 * Add a text channel seeded with ascending-id (18-digit) messages.
 * `botAt` marks one index as a bot-authored message; `systemAt` marks
 * indices as Discord system messages (the fake addMessage has no system
 * flag — the seeded object is mutated, the same object the cache holds).
 */
function seedChannel(
  env,
  { name, n, speakers, content = null, contentLen = 0, botAt = -1, systemAt = [] },
) {
  const ch = env.createTextChannel({ id: snowChannel(), guild: env.guild, name });
  env.guild.addChannel(ch);
  const ids = [];
  const list = Array.isArray(systemAt) ? systemAt : [systemAt];
  for (let i = 0; i < n; i += 1) {
    const sp = speakers[i % speakers.length];
    const isBot = botAt === i;
    const msg = ch.addMessage({
      id: snowMessage(),
      content:
        content ??
        (contentLen > 0 ? "x".repeat(contentLen) : `${name}-note-${i}`),
      author: isBot
        ? { id: snowUser(), username: "gorkbot", tag: "gorkbot#0000", bot: true }
        : { id: sp.user.id, username: sp.user.username, tag: sp.user.tag },
      createdTimestamp: Date.UTC(2026, 8, 20, 12, 0, 0) + i * 1000,
    });
    if (list.includes(i)) msg.system = true;
    ids.push(msg.id);
  }
  return { ch, ids };
}

/** Count channel.messages.fetch calls (proves "refused BEFORE any fetch"). */
function instrumentChannelFetch(channel) {
  const seam = channel.messages;
  const real = seam.fetch.bind(seam);
  const state = { calls: 0 };
  seam.fetch = async (arg) => {
    state.calls += 1;
    return real(arg);
  };
  return state;
}

/** The editReply payload (what resolves the deferred interaction). */
function editedPayload(ixn) {
  const p = ixn.replies[ixn.replies.length - 1];
  assert.ok(
    p && typeof p === "object" && p._edited === true,
    `expected an editReply payload (deferred resolution), got: ${JSON.stringify(ixn.replies)}`,
  );
  return p;
}

/** Parse the i-th scripted AI round trip (must be a chat.completions call). */
function aiBody(fetchMock, i = 0) {
  assert.match(fetchMock.calls[i].url, /\/chat\/completions$/, "AI endpoint");
  assert.equal(
    fetchMock.calls[i].init.headers.Authorization,
    `Bearer ${TEST_AI_KEY}`,
    "AI auth header",
  );
  return JSON.parse(fetchMock.calls[i].init.body);
}

/** The CURRENT env's cooldown gate (require AFTER freshEnv — cache reset). */
function cooldownRemaining(guildId) {
  return require("../../src/features/gork/summarizeCooldown").checkSummarizeGuildCooldown(
    guildId,
  );
}

/** Invoker's guild-scope daily usage for the current UTC day. */
function usageOf(env, guildId = env.guild.id, userId = IDS.admin) {
  return env.db.getGorkUsage(
    guildId,
    userId,
    "guild",
    "0",
    new Date().toISOString().slice(0, 10), // same UTC day key as the handler
  );
}

function summarizeRows(env, guildId = env.guild.id) {
  return env.db.listGorkInteractions({ guildId, kind: "summarize" });
}

/**
 * Run /gork summarize through the REAL router. The router awaits the
 * handler and the handler awaits the queue job end to end, so the returned
 * interaction already carries the FINAL state (no waits needed).
 *
 * Mirrors harness `runCommand` (same member resolution + real router entry)
 * but assigns the fake an `id`: production ChatInputCommandInteractions
 * ALWAYS carry one, and the slash audit row needs it (gork_interactions
 * .message_id is NOT NULL; handlers pass `interaction.id` there).
 */
async function runSummarize(env, options, cmdOpts = {}) {
  const guild = cmdOpts.guild ?? env.guild;
  const admin = cmdOpts.admin !== false;
  const user = cmdOpts.user || (admin ? env.users.adminUser : env.users.memberUser);
  let mem = cmdOpts.member;
  if (!mem) {
    if (user.id === env.users.adminUser.id) mem = env.members.adminMember;
    else if (user.id === env.users.memberUser.id) mem = env.members.member;
    else if (user.id === env.users.member2User.id) mem = env.members.member2;
    else mem = env.createMember({ guild, user, admin });
  }
  mem.setAdmin?.(admin);

  const ixn = env.createChatInputInteraction({
    commandName: "gork",
    guild,
    user,
    member: mem,
    channelId: cmdOpts.channelId || env.IDS.channelGeneral,
    client: env.client,
    admin,
    options,
    subcommand: "summarize",
  });
  ixn.setAdmin?.(admin);
  ixn.id = cmdOpts.interactionId || snowInteraction();

  await env.handleInteraction(ixn, env.ctx);
  return ixn;
}

/** One audit-channel embed flattened to text (index into env.channels.log.sent). */
function auditTextAt(env, i = 0) {
  return embedText(env.channels.log.sent[i]?.embeds?.[0]);
}

// ---------- tests ----------

describe("integration: /gork summarize (§7.21)", () => {
  it("mode from+to end-to-end: one embed set posted, one AI call, budget counted once, audit + interaction rows, cooldown armed", async () => {
    const env = await freshEnv({ guildId: snowGuild() });
    const saved = saveEnv();
    const RUNDOWN =
      "**Headline** — launch blockers.\n**What was decided** — ship Friday.\n" +
      "**Open questions** — none.\n**Action items** — bob: freeze.\n" +
      "**Who said what that mattered** — alice drove it.";
    const fetchMock = mockFetch([chatCompletionResponse(RUNDOWN)]);
    try {
      enableAiKey();
      setupGuild(env);
      const alice = makeSpeaker(env, "alice", "Alice");
      const bob = makeSpeaker(env, "bob", "Bob");
      const { ch, ids } = seedChannel(env, {
        name: "launch",
        n: 8,
        speakers: [alice, bob],
        botAt: 3,
        systemAt: [4],
      });
      const reads = instrumentChannelFetch(ch);

      // from = full message link; to = bare id resolved via the channel:
      // picker; window ids 1..5 (id 4 is system → skipped, id 3 is bot).
      const ixn = await runSummarize(env, {
        from: messageLink(env.guild.id, ch.id, ids[1]),
        to: ids[5],
        channel: ch,
        focus: "shipping decisions only",
        lang: "spanish",
      });

      // ---- posted embed (deferred editReply, embed-only, no pings) ----
      assert.equal(ixn.deferred, true, "the handler defers before reading");
      assert.equal(ixn.replies.length, 1, "exactly one posted message");
      assert.equal(ixn.followUps.length, 0, "single-embed rundown has no continuations");
      const payload = editedPayload(ixn);
      assert.deepEqual(payload.allowedMentions, { parse: [] }, "NO_PING on every post");
      assert.ok(payload.embeds?.length === 1, "the rundown posts as an embed");
      assert.equal(payload.content ?? undefined, undefined, "embed-only, never plain text");
      const primary = payload.embeds[0];
      const primaryText = embedText(primary);
      assert.ok(primaryText.includes("Gork rundown"), `rundown title: ${primaryText}`);
      assert.ok(primaryText.includes(RUNDOWN), "the generated rundown is the embed body");
      assert.ok(primaryText.includes("from-to"), `Mode field: ${primaryText}`);
      assert.ok(primaryText.includes(ids[1]) && primaryText.includes(ids[5]), "footer carries the range");
      assert.ok(primaryText.includes("Requested by @admin"), "footer names the invoker");

      // ---- one AI round trip, one-shot (decision 55) ----
      assert.equal(fetchMock.calls.length, 1, "exactly one AI fetch");
      const body = aiBody(fetchMock);
      assert.equal(body.model, "gpt-4o-mini");
      assert.equal(body.temperature, 0.3);
      assert.equal(body.max_tokens, 4000);
      assert.equal(body.tools, undefined, "no tool loop for generation");
      assert.equal(body.response_format, undefined, "plain text output (not JSON)");
      assert.equal(body.messages.length, 2, "system + user only");

      // Instruction zone = card + the ONLY two staff directives.
      const { GORK_SUMMARIZE_CARD } = require("../../src/features/gork/constants");
      const sys = body.messages.find((m) => m.role === "system");
      assert.ok(sys.content.startsWith(GORK_SUMMARIZE_CARD), "card replaces the Q&A base");
      assert.ok(sys.content.includes("Staff focus directive"), "focus rides the instruction zone");
      assert.ok(sys.content.includes("shipping decisions only"));
      assert.ok(sys.content.includes("write the entire rundown in spanish."));

      // Data zone = quoted transcript + disclosed window + roster (decision 9).
      const user = body.messages.find((m) => m.role === "user");
      assert.ok(user.content.includes("Quoted conversation transcript"));
      assert.ok(user.content.includes("--- end of quoted transcript ---"));
      assert.ok(
        user.content.includes(
          `Disclosed window: channel ${ch.id} · messages ${ids[1]} → ${ids[5]} · 4 message(s).`,
        ),
        `decision-54 window line: ${user.content.slice(0, 200)}`,
      );
      for (const keep of [ids[1], ids[2], ids[3], ids[5]]) {
        assert.ok(user.content.includes(`${keep} | `), `window line for ${keep}`);
      }
      assert.ok(!user.content.includes(`${ids[4]} | `), "system message skipped");
      assert.ok(!user.content.includes(`${ids[0]} | `), "before from: excluded");
      assert.ok(!user.content.includes(`${ids[6]} | `), "after to: excluded");
      assert.ok(user.content.includes("@gorkbot [bot]:"), "bots ride along labeled [bot]");
      assert.ok(user.content.includes("People roster:"), "roster resolves authors");
      assert.ok(user.content.includes(`${alice.user.id} | @alice | Alice`), user.content);
      assert.ok(reads.calls > 0, "the reader paginated the channel (mocked, not HTTP)");

      // ---- audit embed (summarize variant, §7.21.5) ----
      assert.ok(env.channels.log.sent.length >= 1, "expected the summarize audit embed");
      const audit = auditTextAt(env);
      assert.ok(audit.includes("Gork summarize"), audit);
      assert.ok(audit.includes("from+to"), `audit mode label: ${audit}`);
      assert.ok(audit.includes(`<@${IDS.admin}>`), "audit names the invoker");
      assert.ok(audit.includes("#launch"), "audit names the read channel");
      assert.ok(audit.includes("4 msgs"), "audit discloses the read count");
      assert.ok(audit.includes("shipping decisions only"), "audit records focus");
      assert.ok(audit.includes("spanish"), "audit records lang");
      assert.ok(audit.includes("gpt-4o-mini"), "audit records the model");
      assert.ok(audit.includes("posted"), "audit records the outcome");

      // ---- decision 32/57 success bookkeeping: budget ONCE, cooldown armed ----
      assert.equal(usageOf(env), 1, "daily budget counted exactly once");
      const remain = cooldownRemaining(env.guild.id);
      assert.ok(
        remain > 0 && remain <= 600000,
        `guild cooldown armed on success (remaining=${remain})`,
      );

      // ---- migration-027 interaction row (kind="summarize") ----
      const rows = summarizeRows(env);
      assert.equal(rows.length, 1, "exactly one summarize row");
      assert.equal(rows[0].status, "shipped");
      assert.equal(rows[0].tool_call_count, 0, "no tool loop");
      const full = env.db.getGorkInteractionByUid(rows[0].uid);
      assert.equal(full.kind, "summarize");
      assert.equal(full.trigger_content, "/gork summarize");
      assert.equal(full.model, "gpt-4o-mini");
      assert.equal(full.finish_reason, "stop");
      assert.equal(full.answer_shipped, RUNDOWN, "posted rundown captured");
      const meta = JSON.parse(full.context_meta);
      assert.equal(meta.surface, "summarize");
      assert.equal(meta.mode, "from+to");
      assert.equal(meta.resolved.channel_id, ch.id);
      assert.equal(meta.resolved.first_message_id, ids[1]);
      assert.equal(meta.resolved.last_message_id, ids[5]);
      assert.equal(meta.resolved.collected, 4);
      assert.equal(meta.resolved.clamped, false);
      assert.equal(meta.focus, "shipping decisions only");
      assert.equal(meta.lang, "spanish");
      const transcript = JSON.parse(full.transcript);
      assert.equal(transcript.events.length, 2, "request + response captured once");
      assert.ok(
        JSON.stringify(transcript.events[0]).includes("Quoted conversation transcript"),
        "wire payload captured byte-for-byte",
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("mode from->now end-to-end: reads the anchor through the newest message, books success", async () => {
    const env = await freshEnv({ guildId: snowGuild() });
    const saved = saveEnv();
    const fetchMock = mockFetch([chatCompletionResponse("Headline — tail of the thread.")]);
    try {
      enableAiKey();
      setupGuild(env);
      const carol = makeSpeaker(env, "carol", "Carol");
      const { ch, ids } = seedChannel(env, { name: "tail", n: 6, speakers: [carol] });

      // from alone = open range through the newest readable message.
      const ixn = await runSummarize(env, { from: ids[3], channel: ch });

      assert.equal(fetchMock.calls.length, 1);
      const body = aiBody(fetchMock);
      const user = body.messages.find((m) => m.role === "user");
      for (const keep of [ids[3], ids[4], ids[5]]) {
        assert.ok(user.content.includes(`${keep} | `), `anchor→newest includes ${keep}`);
      }
      assert.ok(!user.content.includes(`${ids[0]} | `), "older messages excluded");
      assert.ok(
        user.content.includes(
          `Disclosed window: channel ${ch.id} · messages ${ids[3]} → ${ids[5]} · 3 message(s).`,
        ),
        "window line covers anchor → newest",
      );

      const payload = editedPayload(ixn);
      assert.deepEqual(payload.allowedMentions, { parse: [] });
      assert.ok(embedText(payload.embeds[0]).includes("from-now"), "embed mode from-now");

      const audit = auditTextAt(env);
      assert.ok(audit.includes("from->now"), `audit mode: ${audit}`);

      assert.equal(summarizeRows(env).length, 1, "one interaction row");
      assert.equal(summarizeRows(env)[0].status, "shipped");
      assert.equal(usageOf(env), 1, "budget counted once");
      assert.ok(cooldownRemaining(env.guild.id) > 0, "cooldown armed");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("mode last:N end-to-end: keeps the newest N readable messages, books success", async () => {
    const env = await freshEnv({ guildId: snowGuild() });
    const saved = saveEnv();
    const fetchMock = mockFetch([chatCompletionResponse("Headline — the last 50 lines.")]);
    try {
      enableAiKey();
      setupGuild(env);
      const dana = makeSpeaker(env, "dana", "Dana");
      const { ch, ids } = seedChannel(env, { name: "busy", n: 60, speakers: [dana] });

      // Run the command INSIDE the target channel: no channel: option needed.
      const ixn = await runSummarize(env, { last: 50 }, { channelId: ch.id });

      assert.equal(fetchMock.calls.length, 1);
      const body = aiBody(fetchMock);
      const user = body.messages.find((m) => m.role === "user");
      assert.ok(user.content.includes(`${ids[59]} | `), "newest message in the window");
      assert.ok(user.content.includes(`${ids[10]} | `), "window starts at the 50th newest");
      assert.ok(!user.content.includes(`${ids[9]} | `), "older than last:50 excluded");
      assert.ok(
        user.content.includes(
          `Disclosed window: channel ${ch.id} · messages ${ids[10]} → ${ids[59]} · 50 message(s).`,
        ),
        "window names the newest-50 range",
      );

      const payload = editedPayload(ixn);
      assert.equal(payload.content, undefined, "no cap bit → embeds-only reply (no disclosure text)");
      assert.deepEqual(payload.allowedMentions, { parse: [] });

      const audit = auditTextAt(env);
      assert.ok(audit.includes("last:50"), `audit mode last:N: ${audit}`);
      assert.ok(audit.includes("#busy"), "audit names the read channel");

      const rows = summarizeRows(env);
      assert.equal(rows.length, 1);
      const meta = JSON.parse(env.db.getGorkInteractionByUid(rows[0].uid).context_meta);
      assert.equal(meta.mode, "last:50");
      assert.equal(meta.last_count, 50);
      assert.equal(meta.resolved.collected, 50);

      assert.equal(usageOf(env), 1, "budget counted once");
      assert.ok(cooldownRemaining(env.guild.id) > 0, "cooldown armed");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("per-guild cooldown: the second run right after a success gets the minutes-remaining reply with ZERO AI calls and no budget; another guild still succeeds", async () => {
    const env = await freshEnv({ guildId: snowGuild() });
    const saved = saveEnv();
    const fetchMock = mockFetch([
      chatCompletionResponse("Rundown one for guild A."),
      chatCompletionResponse("Rundown for guild B (cooldown is per-guild)."),
    ]);
    try {
      enableAiKey();
      setupGuild(env);
      const erin = makeSpeaker(env, "erin", "Erin");
      const { ch } = seedChannel(env, { name: "cooldown", n: 5, speakers: [erin] });

      // 1. Success arms the guild cooldown.
      const first = await runSummarize(env, { last: 5, channel: ch });
      assert.ok(embedText(editedPayload(first).embeds[0]).includes("Gork rundown"));
      assert.equal(fetchMock.calls.length, 1);
      assert.equal(usageOf(env), 1);

      // 2. Immediate retry in the SAME guild: ephemeral minutes-remaining
      //    refusal BEFORE defer — nothing read, nothing generated.
      const second = await runSummarize(env, { last: 5, channel: ch });
      assert.equal(second.deferred, false, "cooldown refusal happens before defer");
      assertEphemeralReply(second, /One rundown per server per 10 minutes/);
      assertEphemeralReply(second, /Try again in \*\*10 minutes\*\*/);
      assertEphemeralReply(second, /Nothing was read or generated/);
      assert.equal(fetchMock.calls.length, 1, "ZERO additional AI fetches while armed");
      assert.equal(usageOf(env), 1, "rejected run counted NO budget");
      assert.equal(summarizeRows(env).length, 1, "rejected run wrote NO interaction row");
      assert.ok(cooldownRemaining(env.guild.id) > 0, "still armed");

      // 3. A DIFFERENT guild is unaffected by guild A's armed window.
      // (guildB.members.me stays null — the bot-readability probe skips
      // when the guild exposes no bot member, like the harness default.)
      const guildB = createGuild({ id: snowGuild() });
      env.client.addGuild(guildB);
      const bAdmin = env.createMember({ guild: guildB, user: env.users.adminUser, admin: true });
      guildB.addMember(bAdmin);
      const bCh = env.createTextChannel({ id: snowChannel(), guild: guildB, name: "b-summarize" });
      guildB.addChannel(bCh);
      bCh.addMessage({
        id: snowMessage(),
        content: "the B guild conversation",
        author: { id: env.users.member2User.id, username: "member2", tag: "member2#0000" },
        createdTimestamp: Date.UTC(2026, 8, 21, 12, 0, 0),
      });
      setupGuild(env, guildB.id);

      const third = await runSummarize(
        env,
        { last: 5, channel: bCh },
        { guild: guildB, member: bAdmin, channelId: bCh.id },
      );
      assert.ok(
        embedText(editedPayload(third).embeds[0]).includes("Gork rundown"),
        "guild B succeeded while guild A was cooling down",
      );
      assert.equal(fetchMock.calls.length, 2, "guild B got its own one-shot call");
      assert.equal(usageOf(env, guildB.id), 1, "budget is per-guild too");
      assert.ok(cooldownRemaining(guildB.id) > 0, "guild B armed its OWN window on success");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("1,000-message read cap: a larger range clamps at 1,000 scanned and the embed discloses the window actually read", async () => {
    const env = await freshEnv({ guildId: snowGuild() });
    const saved = saveEnv();
    const fetchMock = mockFetch([chatCompletionResponse("Headline — a very long thread.")]);
    try {
      enableAiKey();
      // 12k-token budget (40k-char transcript) so the char cap bites on top
      // of the message cap — short seeded lines fit the 80k default.
      setupGuild(env, env.guild.id, { gork_summarize_input_tokens: 12000 });
      const frank = makeSpeaker(env, "frank", "Frank");
      const { ch, ids } = seedChannel(env, {
        name: "flood",
        n: 1201, // anchor + 1,200 → the 1,000-message scan cap bites with range left
        speakers: [frank],
      });

      const ixn = await runSummarize(env, { from: messageLink(env.guild.id, ch.id, ids[0]) });

      assert.equal(fetchMock.calls.length, 1, "generation ran once on the clamped window");
      const payload = editedPayload(ixn);
      const text = embedText(payload.embeds[0]);
      // Decision 54 clamp-and-disclose: the reader's verbatim note names BOTH caps.
      assert.ok(text.includes("Disclosed window"), `disclosed-window field present: ${text.slice(0, 300)}`);
      // §7.21.2: the reply TEXT repeats the same disclosure (embed field + content).
      assert.ok(
        String(payload.content || "").includes("Disclosed window"),
        `reply text repeats the disclosure: ${JSON.stringify(payload.content)}`,
      );
      assert.ok(text.includes("1000-message read cap"), "names the message cap");
      assert.match(text, /kept \d+ of 1000 read messages/, "names scanned=1000 vs delivered");

      // The prompt only ever saw the window that fit the 40k-char transcript budget.
      const user = aiBody(fetchMock).messages.find((m) => m.role === "user");
      assert.ok(user.content.includes(`${ids[10]} | `), "early delivered messages present");
      assert.ok(!user.content.includes(`${ids[999]} | `), "scanned-but-undelivered messages absent");

      // Row + audit carry the clamped, disclosed window.
      const rows = summarizeRows(env);
      assert.equal(rows.length, 1);
      const meta = JSON.parse(env.db.getGorkInteractionByUid(rows[0].uid).context_meta);
      assert.equal(meta.resolved.clamped, true, "row marks the clamp");
      assert.ok(meta.resolved.first_message_id === ids[0], "delivered window starts at the anchor");
      assert.ok(meta.resolved.collected > 0 && meta.resolved.collected < 1000);
      const audit = auditTextAt(env);
      assert.ok(audit.includes("Disclosed") || audit.includes("msgs"), "audit discloses counts");

      assert.equal(usageOf(env), 1);
      assert.ok(cooldownRemaining(env.guild.id) > 0);
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("gork_summarize_input_tokens 8000: a 30k+-char range keeps the newest suffix and the reply + embed disclose it", async () => {
    const env = await freshEnv({ guildId: snowGuild() });
    const saved = saveEnv();
    const fetchMock = mockFetch([chatCompletionResponse("Headline — dense discussion.")]);
    try {
      enableAiKey();
      // Per-guild budget: 8,000 tokens → 8,000×4 − 8,000 = 24,000-char cap.
      setupGuild(env, env.guild.id, { gork_summarize_input_tokens: 8000 });
      const ginny = makeSpeaker(env, "ginny", "Ginny");
      const { ch, ids } = seedChannel(env, {
        name: "dense",
        n: 150,
        speakers: [ginny],
        contentLen: 150, // ~200-char lines × 150 → past the 24k transcript budget
      });

      const ixn = await runSummarize(env, { last: 150, channel: ch });

      assert.equal(fetchMock.calls.length, 1);
      const payload = editedPayload(ixn);
      const text = embedText(payload.embeds[0]);
      assert.ok(text.includes("Disclosed window"), "embed carries the disclosed-window line");
      assert.match(text, /24000-character transcript budget kept \d+ of 150 read messages/, text.slice(0, 400));
      // §7.21.2: the reply TEXT repeats the same disclosure.
      assert.ok(
        String(payload.content || "").includes("Disclosed window"),
        `reply text repeats the disclosure: ${JSON.stringify(payload.content)}`,
      );

      const user = aiBody(fetchMock).messages.find((m) => m.role === "user");
      assert.ok(user.content.includes(`${ids[149]} | `), "last: keeps the NEWEST suffix");
      assert.ok(!user.content.includes(`${ids[0]} | `), "oldest lines were clamped away");

      const meta = JSON.parse(env.db.getGorkInteractionByUid(summarizeRows(env)[0].uid).context_meta);
      assert.equal(meta.resolved.clamped, true);
      assert.equal(usageOf(env), 1);
      assert.ok(cooldownRemaining(env.guild.id) > 0);
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("open help ticket blackout: refused with the specific reply, zero message fetches, nothing booked", async () => {
    const env = await freshEnv({ guildId: snowGuild() });
    const saved = saveEnv();
    const fetchMock = mockFetch([]); // any AI call rejects the test
    try {
      enableAiKey();
      setupGuild(env);
      const hank = makeSpeaker(env, "hank", "Hank");
      const { ch } = seedChannel(env, { name: "ticket-summarize", n: 4, speakers: [hank] });
      env.db.createTicket({
        guildId: env.guild.id,
        creatorUserId: IDS.member,
        channelId: ch.id,
        reason: "summarize blackout check",
      });
      const reads = instrumentChannelFetch(ch);

      const ixn = await runSummarize(env, { last: 4, channel: ch });

      assert.equal(ixn.deferred, true, "deferral happened; the refusal resolves the defer");
      const text = editedPayload(ixn).content;
      assert.ok(
        text.includes("is an open help ticket — live tickets are covered by the ticket close flow"),
        `specific refusal: ${text}`,
      );
      assert.ok(text.includes(ch.id), "names the channel");
      assert.equal(reads.calls, 0, "blackout refuses BEFORE any message fetch");
      assert.equal(fetchMock.calls.length, 0, "no AI call");
      assert.equal(cooldownRemaining(env.guild.id), 0, "failure never arms the cooldown");
      assert.equal(usageOf(env), 0, "failure never counts the budget");
      assert.equal(summarizeRows(env).length, 0, "no recorder was built for a failed read");

      const audit = auditTextAt(env);
      assert.ok(audit.includes("Gork summarize"), audit);
      assert.ok(audit.includes("open help ticket"), "failure audit names the specific cause");
      assert.ok(audit.includes("range read failed (security)"), "audit carries the code");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("cross-guild anchor link: refused with the specific reply BEFORE any fetch (decision 46)", async () => {
    const env = await freshEnv({ guildId: snowGuild() });
    const saved = saveEnv();
    const fetchMock = mockFetch([]);
    try {
      enableAiKey();
      setupGuild(env);
      const ivy = makeSpeaker(env, "ivy", "Ivy");
      const { ch, ids } = seedChannel(env, { name: "victim", n: 3, speakers: [ivy] });
      const reads = instrumentChannelFetch(ch);

      const foreignGuild = snowGuild();
      const link = messageLink(foreignGuild, ch.id, ids[0]);
      const ixn = await runSummarize(env, { from: link });

      const text = editedPayload(ixn).content;
      assert.ok(
        text.includes("points to another server — /gork summarize only reads messages in this server"),
        `specific guild-isolation refusal: ${text}`,
      );
      assert.equal(reads.calls, 0, "guild isolation fires BEFORE any channel work");
      assert.equal(fetchMock.calls.length, 0);
      assert.equal(cooldownRemaining(env.guild.id), 0);
      assert.equal(usageOf(env), 0);
      assert.equal(summarizeRows(env).length, 0);
      assert.ok(auditTextAt(env).includes("another server"), "failure audit names the cause");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("invoker without ViewChannel on the target is refused; the channel content never leaks", async () => {
    const { PermissionFlagsBits } = require("discord.js");
    const env = await freshEnv({ guildId: snowGuild() });
    const saved = saveEnv();
    const fetchMock = mockFetch([]);
    try {
      enableAiKey();
      setupGuild(env);
      const jack = makeSpeaker(env, "jack", "Jack");
      const { ch } = seedChannel(env, { name: "secret-plans", n: 3, speakers: [jack] });
      ch.addMessage({
        id: snowMessage(),
        content: "CLASSIFIED: surprise party for gork",
        author: { id: jack.user.id, username: "jack", tag: jack.user.tag },
        createdTimestamp: Date.UTC(2026, 8, 22, 12, 0, 0),
      });
      // The INVOKING staff member cannot view the channel; the bot can —
      // asker parity must fail closed (mirrors the §7.19 parity fixture).
      ch.permissionsFor = (member) => ({
        has: (flag) =>
          !(String(member?.id ?? "") === IDS.admin && flag === PermissionFlagsBits.ViewChannel),
      });
      const reads = instrumentChannelFetch(ch);

      const ixn = await runSummarize(env, { last: 5, channel: ch });

      const text = editedPayload(ixn).content;
      assert.ok(
        text.includes("The invoking user cannot view channel"),
        `specific parity refusal: ${text}`,
      );
      assert.ok(!text.includes("CLASSIFIED"), "no content leak through the refusal");
      assert.equal(reads.calls, 0, "parity gate refuses BEFORE reading any message");
      assert.equal(fetchMock.calls.length, 0, "no AI call — nothing can echo the secret");
      assert.equal(cooldownRemaining(env.guild.id), 0);
      assert.equal(usageOf(env), 0);
      const audit = auditTextAt(env);
      assert.ok(audit.includes("cannot view channel"), "failure audit names the parity cause");
      assert.ok(!audit.includes("CLASSIFIED"), "no content leak into the audit either");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("AI provider error: specific failure reply, NO cooldown arm, NO budget count, failure row + audit — an immediate retry succeeds", async () => {
    const env = await freshEnv({ guildId: snowGuild() });
    const saved = saveEnv();
    const fetchMock = mockFetch([
      providerErrorResponse(503, "That model is currently overloaded"),
      chatCompletionResponse("Headline — retry worked."),
    ]);
    try {
      enableAiKey();
      setupGuild(env);
      const kim = makeSpeaker(env, "kim", "Kim");
      const { ch } = seedChannel(env, { name: "flaky", n: 4, speakers: [kim] });

      const first = await runSummarize(env, { last: 4, channel: ch });
      const text = editedPayload(first).content;
      assert.ok(text.includes("HTTP 503"), `reply carries the status: ${text}`);
      assert.ok(
        text.includes("That model is currently overloaded"),
        "reply carries the provider's own words",
      );
      assert.ok(text.includes("no cooldown was armed, and your budget was not counted"), text);
      assert.equal(cooldownRemaining(env.guild.id), 0, "failed generation did NOT arm the cooldown");
      assert.equal(usageOf(env), 0, "failed generation did NOT count the budget");

      const failRows = summarizeRows(env);
      assert.equal(failRows.length, 1, "the failed run still recorded its row (finalize on every path)");
      assert.equal(failRows[0].status, "failure");
      assert.ok(env.db.getGorkInteractionByUid(failRows[0].uid).error.includes("HTTP 503"));

      const audit = auditTextAt(env);
      assert.ok(audit.includes("generation failed (ai)"), `failure audit: ${audit}`);

      // Decision 57: failures never lock the guild out — immediate retry works.
      const second = await runSummarize(env, { last: 4, channel: ch });
      assert.ok(
        embedText(editedPayload(second).embeds[0]).includes("Headline — retry worked."),
        "retry posted the rundown",
      );
      assert.equal(fetchMock.calls.length, 2);
      assert.equal(usageOf(env), 1, "only the SUCCESS counted the budget");
      assert.ok(cooldownRemaining(env.guild.id) > 0, "cooldown armed by the success only");
      const rows = summarizeRows(env); // newest first
      assert.equal(rows[0].status, "shipped");
      assert.equal(rows.length, 2, "one failure row + one shipped row");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("system-only range: the specific empty-range error, no AI call, nothing booked", async () => {
    const env = await freshEnv({ guildId: snowGuild() });
    const saved = saveEnv();
    const fetchMock = mockFetch([]);
    try {
      enableAiKey();
      setupGuild(env);
      const lola = makeSpeaker(env, "lola", "Lola");
      const { ch, ids } = seedChannel(env, {
        name: "joins-only",
        n: 3,
        speakers: [lola],
        systemAt: [0, 1, 2], // every message is a Discord system message
      });

      const ixn = await runSummarize(env, {
        from: messageLink(env.guild.id, ch.id, ids[0]),
        to: ids[2],
        channel: ch, // bare `to` id must resolve in the SAME channel as the from: link
      });

      const text = editedPayload(ixn).content;
      assert.ok(
        text.includes("No readable messages in that range — Discord system messages"),
        `specific empty-range error: ${text}`,
      );
      assert.equal(fetchMock.calls.length, 0, "zero AI fetches");
      assert.equal(cooldownRemaining(env.guild.id), 0);
      assert.equal(usageOf(env), 0);
      assert.equal(summarizeRows(env).length, 0, "no recorder row for a failed read");
      assert.ok(auditTextAt(env).includes("range read failed (empty)"), "failure audit names it");
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("usage-error combinations: ephemeral refusal naming the three modes — before defer, before any read, nothing booked", async () => {
    const env = await freshEnv({ guildId: snowGuild() });
    const saved = saveEnv();
    const fetchMock = mockFetch([]);
    try {
      enableAiKey();
      setupGuild(env);
      const matt = makeSpeaker(env, "matt", "Matt");
      const { ch } = seedChannel(env, { name: "usage", n: 3, speakers: [matt] });

      // (a) from + last are mutually exclusive.
      let ixn = await runSummarize(env, { from: "123456789012345678", last: 10, channel: ch });
      assert.equal(ixn.deferred, false, "usage errors resolve BEFORE defer");
      assertEphemeralReply(ixn, /Give exactly one range: from:\+to: \(closed range\), from: alone .*or last:<N>/);
      assertEphemeralReply(ixn, /got both from: and last:/);

      // (b) to without from.
      ixn = await runSummarize(env, { to: "123456789012345678", channel: ch });
      assertEphemeralReply(ixn, /got to: without a from: anchor/);

      // (c) nothing given.
      ixn = await runSummarize(env, { focus: "vibes" });
      assertEphemeralReply(ixn, /none was given/);

      // (d) last: out of the 1–1000 bounds (the handler gate, not Discord).
      ixn = await runSummarize(env, { last: 0, channel: ch });
      assertEphemeralReply(ixn, /last: must be an integer between 1 and 1000 — got "0"/);

      assert.equal(ixn.followUps.length, 0);
      assert.equal(fetchMock.calls.length, 0, "no AI call for any usage error");
      assert.equal(cooldownRemaining(env.guild.id), 0, "usage errors never arm the cooldown");
      assert.equal(usageOf(env), 0, "usage errors never count the budget");
      assert.equal(summarizeRows(env).length, 0, "usage errors write no rows");

      // (e) unparseable anchor: a READ-surface usage error (after defer),
      //     still specific, still books nothing.
      const bad = await runSummarize(env, { from: "banana", channel: ch });
      assert.equal(bad.deferred, true, "anchor parsing happens in the queued job");
      assert.ok(
        editedPayload(bad).content.includes('from: "banana" is not a Discord message link or message id'),
        "anchor errors name the option verbatim",
      );
      assert.equal(fetchMock.calls.length, 0);
      assert.equal(cooldownRemaining(env.guild.id), 0);
      assert.equal(usageOf(env), 0);
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("embed budget: a long model output posts embed-only, capped under Discord's limits, parse-empty mentions on every post (continuations stay embeds)", async () => {
    const env = await freshEnv({ guildId: snowGuild() });
    const saved = saveEnv();
    const LONG = `**Headline** — marathon.\n${"🎬 long-take detail ".repeat(360)}`; // ~6.5k chars
    const fetchMock = mockFetch([chatCompletionResponse(LONG)]);
    try {
      enableAiKey();
      setupGuild(env);
      const nina = makeSpeaker(env, "nina", "Nina");
      const { ch } = seedChannel(env, { name: "longform", n: 3, speakers: [nina] });

      const ixn = await runSummarize(env, { last: 3, channel: ch });

      // Handler-side guarantee: the 3,500 output cap keeps ONE embed, and
      // nothing is ever delivered as plain text.
      assert.equal(ixn.replies.length, 1);
      assert.equal(ixn.followUps.length, 0);
      const payload = editedPayload(ixn);
      assert.equal(payload.embeds.length, 1, "the output cap keeps one embed");
      assert.equal(payload.content ?? undefined, undefined);
      assert.deepEqual(payload.allowedMentions, { parse: [] }, "parse-empty on every post");
      const data = payload.embeds[0].toJSON();
      assert.ok(data.description.length <= 3500, `desc ≤ output cap: ${data.description.length}`);
      assert.ok(data.description.length <= 4096, "under Discord's hard description cap");
      assert.ok(
        JSON.stringify(data).length <= 6000,
        `whole embed stays inside the ~6k per-embed budget: ${JSON.stringify(data).length}`,
      );
      assert.ok(
        data.description.endsWith("…[truncated]"),
        `visible truncation (never silent): ${data.description.slice(-20)}`,
      );
      assert.ok(data.description.includes("🎬"), "capping kept the text valid UTF-16");

      // Emergency continuation path (§7.21.4): when a body ever exceeds the
      // embed budget, the renderer/poster must stay embed-only with
      // parse-empty mentions on EVERY continuation — proven on the current
      // env's render + post seam with a >4,000-char body.
      const {
        renderSummarizeEmbeds,
        buildRundownPayloads,
        EMBED_BODY_MAX,
      } = require("../../src/features/gork/summarizeEmbed");
      const { postRundownPayloads } = require("../../src/features/gork/handlers");
      const OVERFLOW = Array.from({ length: 40 }, (_, i) => `overflow-line-${i}: ${"z".repeat(110)}`).join("\n");
      assert.ok(OVERFLOW.length > 4000, "fixture overflows one embed body");
      const embeds = renderSummarizeEmbeds(OVERFLOW, {
        guildId: env.guild.id,
        mode: "from-to",
        range: { firstId: "123456789012345678", lastId: "123456789012345679", channelId: "123456789012345600" },
        invoker: { username: "admin" },
      });
      assert.ok(embeds.length >= 2, "overflow renders continuation EMBEDS (never plain text)");
      const payloads = buildRundownPayloads(embeds);
      let joined = "";
      for (const p of payloads) {
        assert.equal(p.embeds.length, 1, "one embed per message");
        assert.deepEqual(p.allowedMentions, { parse: [] }, "parse-empty on continuations too");
        assert.equal(p.content ?? undefined, undefined, "no plain-text dump");
        const d = p.embeds[0].toJSON();
        assert.ok(d.description.length <= EMBED_BODY_MAX, `chunk ≤ embed body budget: ${d.description.length}`);
        assert.ok(d.description.length <= 4096, "under Discord's hard description cap");
        joined += d.description;
      }
      assert.equal(joined, OVERFLOW, "continuations join back into the exact rundown");
      assert.ok(
        embeds[1].toJSON().title.includes("(continued"),
        "continuation titles itself",
      );

      // Poster seam posts IN ORDER: first embed resolves the defer, then followUps.
      const order = [];
      const seamIxn = {
        editReply: async (p) => { order.push({ kind: "edit", p }); return { id: "m-edit" }; },
        followUp: async (p) => { order.push({ kind: "follow", p }); return { id: `m-follow-${order.length}` }; },
      };
      const posted = await postRundownPayloads(seamIxn, payloads);
      assert.equal(posted.ok, true, "all-chunks-land");
      assert.equal(posted.posted.length, payloads.length);
      assert.deepEqual(order.map((o) => o.kind), ["edit", ...payloads.slice(1).map(() => "follow")]);
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });
});
