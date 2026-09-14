/**
 * Memory-chain export integration test (Phase C, session
 * 2026-09-13-gork-interaction-log): the export CLI assembles a two-turn
 * memory conversation (qa rows + memory_turn companions linked by
 * parent_uid) into v1 fixtures where the TRIGGER row carries its chain
 * companions (`memory.memoryTurns`) and the conversation seed
 * (`memory.turns`) ends with the trigger turn. The exported turn-2 fixture
 * must then REPLAY byte-exact through the pipeline (export → replay round
 * trip — the whole Phase C contract in one test).
 *
 * Real SQLite temp DB (same stack as export-gork-log.test.js), mocked
 * Discord I/O and provider fetch.
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { createIntegrationEnv } = require("../helpers/harness");
const { uniqueId } = require("../helpers/fixtures");
const { buildFixturesFromRows } = require("../../scripts/export-gork-log");
const {
  createFixtureChannel,
  createFixtureMember,
  scriptFetch,
  armEnv,
  saveEnv,
  restoreEnv,
} = require("../helpers/replay");

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

describe("export-gork-log: memory chain assembly", () => {
  it("the qa trigger row carries its memory_turn companion and the seed", async () => {
    const env = await freshEnv({ guildId: uniqueId("guild-chain") });
    const saved = saveEnv();
    const fetchMock = scriptFetch([
      { urlIncludes: "chat/completions", body: chatBody("c1", "Sunny with a light breeze.") },
      { urlIncludes: "chat/completions", body: chatBody("c1e", '{"memories":[]}') },
    ]);
    try {
      armEnv();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
        gork_memory_enabled: 1,
      });
      env.db.gorkMemoryUpsert({
        guildId: env.guild.id,
        subjectUserId: env.users.memberUser.id,
        memDate: "2026-09-14",
        titleKey: "weather",
        title: "Weather plans",
        body: "Asked about tomorrow's weather.",
        kind: "profile",
        importance: 4,
      });
      const ch = env.channels.general;
      ch.sendTyping = async () => {};
      ch.addMessage({
        id: "100000000000000004",
        content: "earlier context line one",
        author: { id: env.users.memberUser.id, username: "member" },
        createdTimestamp: Date.now() - 50000,
      });
      const message = {
        id: "100000000000000009",
        content: "gork: what is the weather tomorrow?",
        guild: env.guild,
        guildId: env.guild.id,
        channel: ch,
        channelId: ch.id,
        author: env.users.memberUser,
        member: env.members.member,
        memberPermissions: env.members.member.permissions,
        attachments: new Map(),
        embeds: [],
        reply: async (payload) => ch.send(payload),
        react: async (emoji) => ({ emoji }),
        delete: async () => {},
      };
      await env.onMessageCreate(message);
      await require("../../src/features/gork/trigger").whenGorkIdleForTests();

      const rows = env.db
        .listGorkInteractions({ guildId: env.guild.id, limit: 20 })
        .map((r) => env.db.getGorkInteractionByUid(r.uid))
        .filter(Boolean);
      assert.ok(
        rows.some((r) => r.kind === "memory_turn"),
        "a memory_turn companion row exists",
      );

      const fixtures = buildFixturesFromRows(rows);
      const qa = fixtures.find((f) => f.kind === "qa");
      assert.ok(qa, "one qa fixture");
      assert.equal(qa.trigger.messageId, "100000000000000009");
      const turns = qa.memory.memoryTurns || [];
      assert.equal(turns.length, 1, "the trigger row carries its companion");
      assert.equal(turns[0].parentUid, qa.uid, "companion links to the qa uid");
      assert.equal(turns[0].status, "shipped");
      const seed = qa.memory.turns || [];
      assert.equal(
        seed[seed.length - 1].messageId,
        "100000000000000009",
        "the seed chain ends with the trigger turn",
      );
      assert.equal(
        new Set(seed.map((t) => t.messageId)).size,
        seed.length,
        "no duplicate turns in the seed",
      );
      // Companion rows ALSO export standalone (raw audit rows); the qa
      // fixture is the one that CARRIES them for replays.
      assert.ok(
        fixtures.some((f) => f.kind === "memory_turn"),
        "the memory_turn row also exports standalone",
      );
    } finally {
      restoreEnv(saved);
      fetchMock.restore();
    }
  });

  it("the assembled chain fixture replays byte-exact through the pipeline", async () => {
    // record once to obtain the fixture, replay it into a SECOND env
    const rec = await freshEnv({ guildId: uniqueId("guild-chain-r") });
    const saved = saveEnv();
    const chatResponses = [
      { urlIncludes: "chat/completions", body: chatBody("d1", "Clear skies.") },
      { urlIncludes: "chat/completions", body: chatBody("d1e", '{"memories":[]}') },
    ];
    let fixture;
    const fetchMockRecord = scriptFetch(chatResponses);
    try {
      armEnv();
      rec.db.updateGuildSettings(rec.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
        gork_memory_enabled: 1,
      });
      rec.db.gorkMemoryUpsert({
        guildId: rec.guild.id,
        subjectUserId: rec.users.memberUser.id,
        memDate: "2026-09-14",
        titleKey: "weather",
        title: "Weather plans",
        body: "Asked about tomorrow's weather.",
        kind: "profile",
        importance: 4,
      });
      const ch = rec.channels.general;
      ch.sendTyping = async () => {};
      ch.addMessage({
        id: "100000000000000004",
        content: "earlier context line one",
        author: { id: rec.users.memberUser.id, username: "member" },
        createdTimestamp: Date.now() - 50000,
      });
      const message = {
        id: "100000000000000009",
        content: "gork: what is the weather tomorrow?",
        guild: rec.guild,
        guildId: rec.guild.id,
        channel: ch,
        channelId: ch.id,
        author: rec.users.memberUser,
        member: rec.members.member,
        memberPermissions: rec.members.member.permissions,
        attachments: new Map(),
        embeds: [],
        reply: async (payload) => ch.send(payload),
        react: async (emoji) => ({ emoji }),
        delete: async () => {},
      };
      await rec.onMessageCreate(message);
      await require("../../src/features/gork/trigger").whenGorkIdleForTests();
      const rows = rec.db
        .listGorkInteractions({ guildId: rec.guild.id, limit: 20 })
        .map((r) => rec.db.getGorkInteractionByUid(r.uid))
        .filter(Boolean);
      fixture = buildFixturesFromRows(rows).find((f) => f.kind === "qa");
      assert.ok(fixture, "qa fixture assembled");
    } finally {
      restoreEnv(saved);
      fetchMockRecord.restore();
    }
    // Replay bodies, in CALL order: the qa answer, then the extraction
    // turn — both straight from the fixture's recorded transcripts.
    const recorded = [
      ...(fixture.expect.transcript || [])
        .filter((e) => e && e.type === "response" && e.data)
        .map((e) => ({ urlIncludes: "chat/completions", body: e.data })),
      ...(fixture.memory.memoryTurns || [])
        .flatMap((t) => t.transcript?.responses || [])
        .filter(Boolean)
        .map((body) => ({ urlIncludes: "chat/completions", body })),
    ];
    assert.equal(recorded.length, 2, "recorded both provider bodies (qa + extraction)");

    const env = await freshEnv({ guildId: uniqueId("guild-chain-p") });
    const saved2 = saveEnv();
    const fetchMock = scriptFetch(recorded);
    try {
      armEnv();
      env.db.updateGuildSettings(env.guild.id, {
        gork_keyword: "gork",
        gork_cooldown_sec: 0,
        gork_memory_enabled: 1,
        gork_interaction_log_enabled: 1,
      });
      env.db.gorkMemoryUpsert({
        guildId: env.guild.id,
        subjectUserId: env.users.memberUser.id,
        memDate: "2026-09-14",
        titleKey: "weather",
        title: "Weather plans",
        body: "Asked about tomorrow's weather.",
        kind: "profile",
        importance: 4,
      });
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
      const entry =
        (fixture.rosterEntries || []).find(
          (e) => String(e.id) === String(fixture.trigger.userId),
        ) || { id: fixture.trigger.userId, display: "member", handle: "member" };
      const member = createFixtureMember(entry, { guild: env.guild });
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
      await env.onMessageCreate(message);
      await require("../../src/features/gork/trigger").whenGorkIdleForTests();

      const qa = env.db
        .listGorkInteractions({ guildId: env.guild.id, limit: 10 })
        .map((r) => env.db.getGorkInteractionByUid(r.uid))
        .find((r) => r && r.kind === "qa");
      assert.ok(qa, "chain replay wrote a qa row");
      assert.equal(qa.status, "shipped");
      // THE regression alarm: byte-identical prompts from an EXPORTED fixture.
      assert.equal(qa.system_prompt, fixture.expect.systemPrompt);
      assert.equal(qa.user_prompt, fixture.expect.userPrompt);
    } finally {
      restoreEnv(saved2);
      fetchMock.restore();
    }
  });
});

