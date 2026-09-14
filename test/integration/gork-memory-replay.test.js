/**
 * Gork MEMORY replay E2E (Phase C, session 2026-09-13-gork-interaction-log).
 *
 * Companion of gork-replay.test.js for the memory-on path: records a two-
 * turn conversation (memory enabled, memory_turn companion rows via
 * parent_uid), persists it as the golden
 * `test/fixtures/gork-replay/single-round-prior-context-memory.json`, then
 * REPLAYS both turns from the golden through the pipeline and asserts the
 * regression alarm byte-exactly (prompts of BOTH turns + shipped replies +
 * the parent-uid link).
 *
 * Same settle discipline as gork.test.js: whenGorkIdleForTests() after each
 * turn — never sleeps.
 *
 * Re-record intentionally after approved prompt changes:
 *   FIXTURE_UPDATE=1 node --test test/integration/gork-memory-replay.test.js
 *   then review the diff. Without FIXTURE_UPDATE=1 a MISSING golden file is
 *   a hard failure (no silent re-arm of the regression net).
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { createIntegrationEnv } = require("../helpers/harness");
const { uniqueId } = require("../helpers/fixtures");
const { buildFixture, buildFixturesFromRows } = require("../../scripts/export-gork-log");
const {
  loadFixture,
  createFixtureChannel,
  createFixtureMember,
  scriptFetch,
  armEnv,
  saveEnv,
  restoreEnv,
} = require("../helpers/replay");

const FIXTURE_FILE = path.join(
  __dirname,
  "..",
  "fixtures",
  "gork-replay",
  "single-round-prior-context-memory.json",
);

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

/** Strip fields that legitimately differ between runs. */
function canonicalFixture(f) {
  const c = JSON.parse(JSON.stringify(f));
  c.uid = "uid-stable";
  c.generatedAt = null;
  if (c.trigger) c.trigger.guildId = "guild-stable";
  (c.contextMessages || []).forEach((m, i) => {
    m.timestamp = Number.isFinite(m.timestamp) ? i : null;
  });
  (c.expect?.transcript || []).forEach((e) => {
    if (e && typeof e === "object" && e.durationMs != null) e.durationMs = 0; // wall-clock jitter
  });
  if (c.memory) {
    if (c.memory.meta) c.memory.meta.updated_at = null;
    (c.memory.turns || []).forEach((t, i) => {
      t.created_at = i;
    });
    (c.memory.memoryTurns || []).forEach((t, i) => {
      t.durationMs = 0; // ms-granular clock jitter across runs
      t.created_at = i;
      t.uid = "uid-stable";
      // The only qa row in the fixture is the golden itself ("uid-stable"),
      // so the companion's parent link normalizes to the same stable id.
      if (t.parentUid) t.parentUid = "uid-stable";
    });
  }
  return c;
}

function chatBody(id, content) {
  return {
    id,
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
  };
}

function chatRequest(body) {
  try {
    return JSON.parse(body || "{}");
  } catch {
    return {};
  }
}

/**
 * Seed facts so the memory read path has real rows: one profile fact per
 * conversation participant (deterministic titles/bodies).
 */
function seedFacts(env, guildId, day) {
  env.db.gorkMemoryUpsert({
    guildId,
    subjectUserId: env.users.memberUser.id,
    memDate: day,
    titleKey: "weather",
    title: "Weather plans",
    body: "Asked about tomorrow's weather and plans around it.",
    kind: "profile",
    importance: 4,
  });
  env.db.gorkMemoryUpsert({
    guildId,
    subjectUserId: env.users.member2User.id,
    memDate: day,
    titleKey: "weather",
    title: "Weather plans",
    body: "Also following the weather question.",
    kind: "profile",
    importance: 3,
  });
}

/** Seed the channel history the recording reads (same ids as the golden). */
function seedHistory(env, ch) {
  for (const m of [
    { id: "100000000000000004", agoMs: 50000, content: "earlier context line one", user: env.users.memberUser },
    { id: "100000000000000005", agoMs: 40000, content: "earlier context line two", user: env.users.member2User },
    { id: "100000000000000006", agoMs: 30000, content: "earlier context line three", user: env.users.memberUser },
    { id: "100000000000000007", agoMs: 20000, content: "earlier context line four", user: env.users.member2User },
  ]) {
    ch.addMessage({
      id: m.id,
      content: m.content,
      author: { id: m.user.id, username: m.user.username, tag: `${m.user.username}#0000` },
      createdTimestamp: Date.now() - m.agoMs,
    });
  }
}

/** Drive one trigger message through the pipeline and settle. */
async function drive(env, message) {
  await env.onMessageCreate(message);
  await require("../../src/features/gork/trigger").whenGorkIdleForTests();
}

function memoryTurnMessage(env, ch, { id, content, member }) {
  return {
    id,
    content,
    guild: env.guild,
    guildId: env.guild.id,
    channel: ch,
    channelId: ch.id,
    author: env.users.memberUser,
    member,
    memberPermissions: member.permissions,
    attachments: new Map(),
    embeds: [],
    reply: async (payload) => ch.send(payload),
    react: async (emoji) => ({ emoji }),
    delete: async () => {},
  };
}

/**
 * Record the two-turn memory conversation with facts seeded up front (the
 * memory read path must have real rows): turn 1 Q&A + turn 2 follow-up that
 * sees the stored memory — each turn writes qa + memory_turn rows. Export
 * BOTH turn fixtures through the chain-aware assembler so each carries its
 * `memory.memoryTurns` companion.
 */
async function recordMemoryFixture(opts = {}) {
  const env = await freshEnv({
    guildId: opts.guildId || uniqueId("guild-mrp"),
  });
  const saved = saveEnv();
  const fetchMock = scriptFetch([
    // turn 1 Q&A + its extraction turn
    { urlIncludes: "chat/completions", body: chatBody("m1", "Mostly sunny with a light breeze.") },
    { urlIncludes: "chat/completions", body: chatBody("m1e", '{"memories":[]}') },
    // turn 2 Q&A + its extraction turn
    { urlIncludes: "chat/completions", body: chatBody("m2", "You asked about the weather earlier.") },
    { urlIncludes: "chat/completions", body: chatBody("m2e", '{"memories":[]}') },
  ]);
  try {
    armEnv();
    env.db.updateGuildSettings(env.guild.id, {
      gork_keyword: "gork",
      gork_cooldown_sec: 0,
      gork_memory_enabled: 1,
    });
    // memDateFromMessage decodes the trigger's snowflake id, not the wall
    // clock — 100000000000000009 decodes to 2026-09-14 (UTC).
    seedFacts(env, env.guild.id, "2026-09-14");
    const ch = env.channels.general;
    ch.sendTyping = async () => {};
    seedHistory(env, ch);

    await drive(env, memoryTurnMessage(env, ch, {
      id: "100000000000000009",
      content: "gork: what is the weather tomorrow?",
      member: env.members.member,
    }));
    await drive(env, memoryTurnMessage(env, ch, {
      id: "100000000000000010",
      content: "gork: and the day after?",
      member: env.members.member,
    }));

    const rows = env.db
      .listGorkInteractions({ guildId: env.guild.id, limit: 50 })
      .map((r) => env.db.getGorkInteractionByUid(r.uid))
      .filter(Boolean);
    const qa1 = rows.filter((r) => r.kind === "qa")[1]; // oldest of the two
    const qa2 = rows.filter((r) => r.kind === "qa")[0];
    assert.ok(qa1 && qa2, "recording wrote two qa rows");
    assert.ok(
      rows.some((r) => r.kind === "memory_turn"),
      "memory_turn companion rows were written (facts + extraction ran)",
    );
    const fixtures = buildFixturesFromRows(rows);
    const pair = fixtures.filter((f) => f.kind === "qa");
    assert.equal(pair.length, 2, "two qa fixtures from the chain-aware assembler");
    // The golden = turn 2 (the memory-BEARING turn: it sees the facts).
    const fixture =
      pair.find((f) => f.trigger.messageId === qa2.trigger_message_id) || pair[0];
    assert.ok(
      (fixture.memory.memoryTurns || []).length >= 1,
      "golden turn carries its memory_turn companion",
    );
    const byMsg = (a, b) =>
      String(a.trigger.messageId).localeCompare(String(b.trigger.messageId));
    // close:false → env + fetch mock stay live for the caller (2-turn
    // replay); createdEnvs cleanup still reaps the env at teardown.
    return {
      fixture,
      env,
      turn1Id: qa1.trigger_message_id,
      turn2Id: qa2.trigger_message_id,
      pair: [...pair].sort(byMsg),
      teardown: () => {
        restoreEnv(saved);
        fetchMock.restore();
      },
    };
  } finally {
    if (opts.close !== false) {
      restoreEnv(saved);
      fetchMock.restore();
      env.cleanup();
    }
  }
}

describe("gork memory replay: golden fixture regression", () => {
  it("record → export matches the checked-in memory golden", async () => {
    // durationMs is wall-clock jitter (0|1ms) — normalize in BOTH shapes.
    const { fixture } = await recordMemoryFixture({ normalizeDur: true });
    const fresh = JSON.stringify(canonicalFixture(fixture), null, 2);
    let golden = null;
    try {
      golden = fs.readFileSync(FIXTURE_FILE, "utf8");
    } catch {
      golden = null;
    }
    if (golden === null && process.env.FIXTURE_UPDATE !== "1") {
      // The golden is committed — an absent file means it was deleted or
      // never checked out; silently re-seeding would re-arm the regression
      // net around the CURRENT code's output (quiet green, zero protection).
      throw new Error(
        `golden fixture missing — run with FIXTURE_UPDATE=1 to regenerate: ${FIXTURE_FILE}`,
      );
    }
    if (golden === null || process.env.FIXTURE_UPDATE === "1") {
      fs.mkdirSync(path.dirname(FIXTURE_FILE), { recursive: true });
      fs.writeFileSync(FIXTURE_FILE, fresh + "\n");
      return; // (re)seeded via FIXTURE_UPDATE=1 — subsequent runs enforce the byte contract
    }
    assert.equal(
      fresh,
      JSON.stringify(canonicalFixture(JSON.parse(golden)), null, 2),
      "recorded memory fixture drifted from the checked-in golden — re-record with FIXTURE_UPDATE=1 after reviewing the prompt change",
    );
  });

  it("the memory golden replays byte-exact through the pipeline", async () => {
    const fixture = loadFixture(FIXTURE_FILE);
    const env = await freshEnv({ guildId: uniqueId("guild-mrp-golden") });
    const saved = saveEnv();
    // The replay re-sends the recorded provider responses in order.
    const responses = (fixture.expect.transcript || [])
      .filter((e) => e && e.type === "response" && e.data)
      .map((e) => ({ urlIncludes: "chat/completions", body: e.data }));
    const fetchMock = scriptFetch(responses);
    try {
      armEnv();
      // Fresh replay identity: settings fresh (memory ON), module-level
      // conversation logs empty for this guild, facts seeded to match the
      // recording (read path renders the same memory block).
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
        gork_memory_enabled: 1,
        gork_interaction_log_enabled: 1,
      });
      seedFacts(env, env.guild.id, "2026-09-14");
      for (const e of fixture.rosterEntries || []) {
        if (e?.id && (e.handle || e.display)) {
          env.guild.addMember(createFixtureMember(e, { guild: env.guild }));
        }
      }
      const ch = createFixtureChannel(fixture.contextMessages, {
        id: fixture.trigger.channelId,
        name: "general",
        rosterEntries: fixture.rosterEntries,
        guild: env.guild,
      });
      ch.guild = env.guild;
      ch.sendTyping = async () => {};
      const member = createFixtureMember(
        fixture.rosterEntries.find((e) => String(e.id) === String(fixture.trigger.userId)),
        { guild: env.guild },
      );

      const message = {
        id: fixture.trigger.messageId,
        content: fixture.trigger.content,
        guild: env.guild,
        guildId: env.guild.id,
        channel: ch,
        channelId: ch.id,
        author: member.author,
        member,
        memberPermissions: member.permissions,
        reference: null,
        referencedMessage: null,
        fetchReference: async () => {
          throw new Error("no reference");
        },
        deletable: true,
        deleted: false,
        system: false,
        createdTimestamp: Date.now(),
        attachments: new Map(),
        embeds: [],
        reply: async (payload) => ch.send(payload),
        react: async (emoji) => ({ emoji }),
        delete: async () => {},
      };

      await drive(env, message);

      const qa = env.db
        .listGorkInteractions({ guildId: env.guild.id, limit: 10 })
        .map((r) => env.db.getGorkInteractionByUid(r.uid))
        .find((r) => r && r.kind === "qa");
      assert.ok(qa, "replay wrote a qa interaction row");
      assert.equal(qa.status, "shipped");
      // THE regression alarm: byte-identical prompts on the memory turn.
      assert.equal(qa.system_prompt, fixture.expect.systemPrompt);
      assert.equal(qa.user_prompt, fixture.expect.userPrompt);
      // The replayed provider calls saw the recorded prompt bytes.
      const qaCalls = fetchMock.calls
        .filter((c) => String(c.url).includes("chat/completions"))
        .map((c) => chatRequest(c.body));
      assert.ok(qaCalls.length >= 1, "at least one chat call was made");
      const qaUser = qaCalls.find(
        (b) => !JSON.stringify(b.messages || []).includes("memory extraction"),
      );
      if (qaUser) {
        const userMsg = (qaUser.messages || []).find((m) => m.role === "user");
        assert.ok(userMsg, "chat call carried the user message");
        assert.equal(userMsg.content, fixture.expect.userPrompt);
        const sysMsg = (qaUser.messages || []).find((m) => m.role === "system");
        assert.equal(sysMsg.content, fixture.expect.systemPrompt);
      }
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("golden memory fixture keeps the parent-uid link shape", () => {
    const fixture = loadFixture(FIXTURE_FILE);
    assert.equal(fixture.kind, "qa");
    const turns = fixture.memory.memoryTurns || [];
    assert.ok(turns.length >= 1, "memory companions are carried");
    for (const t of turns) {
      assert.equal(t.parentUid, fixture.uid, "memory turn links to its qa row");
      assert.equal(t.status, "shipped");
    }
    // memory.turns is chronological: the trigger turn comes LAST.
    const turnMsgs = (fixture.memory.turns || []).map((t) => t.messageId);
    assert.equal(
      turnMsgs[turnMsgs.length - 1],
      fixture.trigger.messageId,
      "the chain ends with the fixture's own trigger turn",
    );
  });

  it("a 2-turn conversation replays with both prompts byte-exact", async () => {
    // Record the two-turn conversation, export BOTH turn fixtures, then
    // replay them IN ORDER into the same env with a fresh conversation
    // state (module logs are reset by the env swap): identical drives must
    // yield byte-identical prompts for BOTH turns and rebuild the
    // parent-uid chain (turn → memory_turn) exactly like the recording.
    // Record in one guild, replay in a DIFFERENT guild (fixture guildIds
    // are normalized — separate guilds keep the row sets distinguishable).
    const replayGuildId = uniqueId("guild-mrp-2t");
    const { fixture: fx2, pair, env, teardown } = await recordMemoryFixture({
      close: false,
      guildId: uniqueId("guild-mrp-rec"),
    });
    assert.equal(pair.length, 2, "recorded pair: turn 1 + turn 2");
    const fx1 = pair[0];
    assert.equal(fx2.uid, pair[1].uid, "golden is the newer pair member");

    // Replay bodies, in call order, straight from the fixtures' transcripts.
    // The record fixture kept its provider mock live for the recording;
    // drop it before scripting the replay bodies.
    teardown();

    const bodiesOf = (f) => [
      ...(f.expect.transcript || [])
        .filter((e) => e && e.type === "response" && e.data)
        .map((e) => ({ urlIncludes: "chat/completions", body: e.data })),
      ...(f.memory.memoryTurns || [])
        .flatMap((t) => t.transcript?.responses || [])
        .filter(Boolean)
        .map((body) => ({ urlIncludes: "chat/completions", body })),
    ];

    // Fresh GUILD env (new createIntegrationEnv → loadDb resets the module
    // state AND restarts the auto-increment memory ids): the replay mirrors
    // the recording env row-for-row. Same temp DB file keeps the fixture's
    // normalized guild contract — only the guild id differs.
    const saved = saveEnv();
    const env2 = await freshEnv({ guildId: replayGuildId });
    const saved2 = saveEnv();
    const fetchMock = scriptFetch([...bodiesOf(fx1), ...bodiesOf(fx2)]);
    try {
      armEnv();
      env2.db.updateGuildSettings(replayGuildId, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
        gork_memory_enabled: 1,
        gork_interaction_log_enabled: 1,
      });
      seedFacts(env2, replayGuildId, "2026-09-14");
      for (const e of fx2.rosterEntries || []) {
        if (e?.id && (e.handle || e.display)) {
          env2.guild.addMember(createFixtureMember(e, { guild: env2.guild }));
        }
      }
      const ch = createFixtureChannel(fx2.contextMessages, {
        id: fx2.trigger.channelId,
        name: "general",
        rosterEntries: fx2.rosterEntries,
        guild: env2.guild,
      });
      ch.guild = env2.guild;
      ch.sendTyping = async () => {};

      const driveTurn = async (fx) => {
        const member = createFixtureMember(
          (fx.rosterEntries || []).find(
            (e) => String(e.id) === String(fx.trigger.userId),
          ) || { id: fx.trigger.userId, display: "member", handle: "member" },
          { guild: env2.guild },
        );
        await drive(env2, {
          id: fx.trigger.messageId,
          content: fx.trigger.content,
          guild: env2.guild,
          guildId: env2.guild.id,
          channel: ch,
          channelId: ch.id,
          author: member.author,
          member,
          memberPermissions: member.permissions,
          reference: null,
          referencedMessage: null,
          fetchReference: async () => {
            throw new Error("no reference");
          },
          deletable: true,
          deleted: false,
          system: false,
          createdTimestamp: Date.now(),
          attachments: new Map(),
          embeds: [],
          reply: async (payload) => ch.send(payload),
          react: async (emoji) => ({ emoji }),
          delete: async () => {},
        });
      };
      await driveTurn(fx1);
      await driveTurn(fx2);

      // Replay rows live in the replay guild — the recording (different
      // guild) is untouched; filter to the replay guild by full row.
      const rows = env2.db
        .listGorkInteractions({ guildId: replayGuildId, limit: 50 })
        .map((r) => env2.db.getGorkInteractionByUid(r.uid))
        .filter(Boolean);
      const replayRows = rows;
      const qas = replayRows.filter((r) => r.kind === "qa");
      assert.equal(qas.length, 2, "two NEW qa rows written by the replay");
      const t1 = qas.find((r) => r.message_id === fx1.trigger.messageId);
      const t2 = qas.find((r) => r.message_id === fx2.trigger.messageId);
      assert.ok(t1 && t2, "both replayed turn rows exist");
      // THE regression alarms: BOTH prompts byte-exact.
      assert.equal(t1.user_prompt, fx1.expect.userPrompt);
      assert.equal(t1.system_prompt, fx1.expect.systemPrompt);
      assert.equal(t2.user_prompt, fx2.expect.userPrompt);
      assert.equal(t2.system_prompt, fx2.expect.systemPrompt);
      // The parent-uid chain rebuilt itself identically during replay.
      const mem = replayRows.filter((r) => r.kind === "memory_turn");
      assert.equal(mem.length, 2, "memory_turn companion for every turn");
      const qaUids = new Set(qas.map((r) => r.uid));
      assert.ok(
        mem.every((r) => qaUids.has(r.parent_uid)),
        "every replayed memory turn links to a replayed qa row",
      );
    } finally {
      restoreEnv(saved2);
      restoreEnv(saved);
      fetchMock.restore();
    }
  });
});
