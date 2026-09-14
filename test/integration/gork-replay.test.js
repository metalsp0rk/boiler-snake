/**
 * Gork replay E2E regression (Phase C, session 2026-09-13-gork-interaction-log).
 *
 * The durable contract is the checked-in golden fixture
 * `test/fixtures/gork-replay/single-round-prior-context.json` (fake ids, no
 * secrets). Flow:
 *  1. RECORD one live Q&A (real SQLite + mocked Discord + mocked fetch, the
 *     same stack as gork-interaction-log.test.js) and export it through the
 *     export CLI's own `buildFixture()` — the golden on disk is (re)written
 *     from exactly that, so prompt/context/export shapes stay pinned.
 *  2. REPLAY the golden through the pipeline via test/helpers/replay.js:
 *     THE regression alarm is the byte-equal system_prompt/user_prompt and
 *     the visible reply equalling `expect.shippedAnswer`.
 *
 * Re-record intentionally after approved prompt changes:
 *   FIXTURE_UPDATE=1 node --test test/integration/gork-replay.test.js
 *   then review the diff. Without FIXTURE_UPDATE=1 a MISSING golden file is
 *   a hard failure (no silent re-arm of the regression net).
 *
 * Multi-turn memory fixtures live in gork-memory-replay.test.js; the CLI
 * process itself is exercised in export-gork-log.test.js.
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { createIntegrationEnv } = require("../helpers/harness");
const { uniqueId } = require("../helpers/fixtures");
const { buildFixture } = require("../../scripts/export-gork-log");
const {
  loadFixture,
  replayInteraction,
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
  "single-round-prior-context.json",
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
    });
  }
  return c;
}

const SKY_ANSWER = "Because Rayleigh scattering bends blue light harder than red.";

function skyChatBody(id) {
  return {
    id,
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: SKY_ANSWER },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 41, completion_tokens: 12, total_tokens: 53 },
  };
}

/**
 * Drive one FULL live Q&A through the pipeline (seeded channel history +
 * keyword trigger + scripted provider answer) and export the written qa row
 * as a v1 fixture.
 */
async function recordGoldenFixture() {
  const env = await freshEnv({ guildId: uniqueId("guild-replay") });
  const saved = saveEnv();
  const fetchMock = scriptFetch([
    { urlIncludes: "chat/completions", body: skyChatBody("chatcmpl-golden-1") },
  ]);
  try {
    armEnv();
    env.db.updateGuildSettings(env.guild.id, {
      gork_keyword: "gork",
      gork_cooldown_sec: 0,
    });
    const ch = env.channels.general;
    ch.sendTyping = async () => {};
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
    const message = {
      id: "100000000000000009",
      content: "gork: why is the sky blue?",
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

    const qa = env.db
      .listGorkInteractions({ guildId: env.guild.id, limit: 10 })
      .map((r) => env.db.getGorkInteractionByUid(r.uid))
      .find((r) => r && r.kind === "qa");
    assert.ok(qa, "recording wrote a qa interaction row");
    return buildFixture(qa);
  } finally {
    restoreEnv(saved);
    fetchMock.restore();
  }
}

describe("gork replay: golden fixture regression", () => {
  it("record → export matches the checked-in golden fixture", async () => {
    const fixture = await recordGoldenFixture();
    const fresh = JSON.stringify(canonicalFixture(fixture), null, 2);
    let golden = null;
    try {
      golden = fs.readFileSync(FIXTURE_FILE, "utf8");
    } catch {
      golden = null;
    }
    if (golden === null && process.env.FIXTURE_UPDATE !== "1") {
      // The goldens are committed — an absent file means it was deleted or
      // never checked out, and silently re-seeding would re-arm the
      // regression net around whatever the CURRENT code produces (quiet
      // green, zero protection). Fail loudly; regeneration is opt-in.
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
      "recorded fixture drifted from the checked-in golden — re-record with FIXTURE_UPDATE=1 after reviewing the prompt change",
    );
  });

  it("the golden fixture replays byte-exact through the pipeline", async () => {
    const fixture = loadFixture(FIXTURE_FILE);
    const env = await freshEnv({ guildId: uniqueId("guild-replay-golden") });
    const out = await replayInteraction(env, fixture);
    const qa = out.rows.find((r) => r.kind === "qa");
    assert.ok(qa, "replay wrote a qa interaction row");
    assert.equal(qa.status, "shipped");
    // THE regression alarm: byte-identical prompts.
    assert.equal(qa.system_prompt, fixture.expect.systemPrompt);
    assert.equal(qa.user_prompt, fixture.expect.userPrompt);
    // the visible reply is what the fixture says shipped
    assert.equal(out.replyContent, fixture.expect.shippedAnswer);
    // exactly one row (memory off in the fixture settings)
    assert.equal(out.rows.length, 1);
  });

  it("replay surfaces provider failures like the recording did", async () => {
    const fixture = loadFixture(FIXTURE_FILE);
    const env = await freshEnv({ guildId: uniqueId("guild-replay-fail") });
    const out = await replayInteraction(env, fixture, {
      chatResponses: [{ error: { message: "upstream exploded" } }],
    });
    const qa = out.rows.find((r) => r.kind === "qa");
    assert.ok(qa, "failed replay still records the call");
    assert.equal(qa.status, "failure");
    assert.match(
      String(qa.error || ""),
      /upstream exploded|empty|HTTP/i,
      "the specific provider failure is stored",
    );
    assert.notEqual(out.replyContent, fixture.expect.shippedAnswer);
  });

  it("a reply-context fixture replays with the replied-to line exactly once", async () => {
    // Inline fixture (not recorded): exercises the reply path end-to-end —
    // the replied-to message must appear in the prompt ONCE (history
    // exclusion in the helper vs. fetchReference seeding).
    const replyFixture = {
      v: 1,
      uid: "reply-fixture-inline",
      kind: "qa",
      generatedAt: null,
      trigger: {
        guildId: "g-reply",
        channelId: "channel-general-1",
        messageId: "500000000000000009",
        userId: "user-member-1",
        content: "gork: what did they say?",
        replyToMessageId: "500000000000000005",
      },
      settings: {
        gork_enabled: 1,
        gork_keyword: "gork",
        gork_context_window: 10,
        gork_search_enabled: 0,
      },
      contextMessages: [
        {
          id: "500000000000000004",
          authorId: "user-member-2",
          content: "we shipped the release yesterday",
          timestamp: null,
        },
        {
          id: "500000000000000005",
          authorId: "user-member-1",
          content: "the replay harness finally works",
          timestamp: null,
        },
      ],
      rosterEntries: [
        { id: "user-member-1", display: "member", handle: "member", nickname: null },
        { id: "user-member-2", display: "member2", handle: "member2", nickname: null },
      ],
      memory: { enabled: false, meta: null, turns: [], memoryTurns: [] },
      expect: {
        model: "gpt-4o-mini",
        systemPrompt: null,
        userPrompt: null,
        tools: null,
        params: null,
        status: "shipped",
        shippedAnswer: "They shipped a release and the harness works.",
        finishReason: "stop",
        usage: null,
        toolCallCount: 0,
        error: null,
        transcript: [
          {
            type: "response",
            data: {
              id: "chatcmpl-reply-1",
              object: "chat.completion",
              created: 1700000000,
              model: "gpt-4o-mini",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "They shipped a release and the harness works.",
                  },
                  finish_reason: "stop",
                },
              ],
            },
          },
        ],
      },
      parsedFailures: [],
    };
    const env = await freshEnv({ guildId: uniqueId("guild-replay-reply") });
    const out = await replayInteraction(env, replyFixture);
    const qa = out.rows.find((r) => r.kind === "qa");
    assert.ok(qa, "reply replay wrote a qa row");
    assert.equal(qa.status, "shipped");
    assert.equal(out.replyContent, "They shipped a release and the harness works.");
    const mentions = (
      qa.user_prompt.match(/replay harness finally works/g) || []
    ).length;
    assert.equal(mentions, 1, "the replied-to message appears exactly once in the prompt");
    assert.ok(
      qa.user_prompt.includes("we shipped the release yesterday"),
      "backfilled context still present",
    );
  });
});
