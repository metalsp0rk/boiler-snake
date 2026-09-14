/**
 * Unit tests for scripts/export-gork-log.js — Phase C of the gork
 * interaction-logging work. Pure fixture assembly (no DB, no Discord):
 * the v1 fixture contract, JSON-column resilience, memory-chain assembly
 * and CLI argument validation.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildFixture,
  buildFixturesFromRows,
  main,
} = require("../scripts/export-gork-log");

/** Minimal full `gork_interactions` row (getGorkInteractionByUid shape). */
function baseRow(overrides = {}) {
  return {
    uid: "u-qa",
    kind: "qa",
    parent_uid: null,
    guild_id: "g1",
    channel_id: "c1",
    message_id: "m1",
    user_id: "usr1",
    status: "shipped",
    model: "gpt-4o-mini",
    params: '{"temperature":0.8}',
    tools: null,
    settings: '{"gork_keyword":"gork"}',
    system_prompt: "SYS",
    user_prompt: "USR",
    trigger_content: "gork: hi",
    reply_to_message_id: null,
    context_messages:
      '[{"id":"m0","authorId":"usr2","content":"earlier","timestamp":1}]',
    roster_entries: "[]",
    memory_meta: null,
    transcript:
      '{"events":[{"type":"request","payload":{"model":"gpt-4o-mini"}},' +
      '{"type":"response","ok":true,"data":{"id":"r1","choices":[]}}]}',
    answer_raw: "hi there",
    answer_shipped: "hi there",
    finish_reason: "stop",
    usage: '{"total_tokens":5}',
    tool_call_count: 0,
    error: null,
    created_at: 111,
    ...overrides,
  };
}

function memoryTurnRow(overrides = {}) {
  return baseRow({
    uid: "u-mem",
    kind: "memory_turn",
    parent_uid: "u-qa",
    status: "shipped",
    trigger_content: "gork: hi",
    transcript:
      '{"events":[{"type":"request","payload":{"model":"m"}},' +
      '{"type":"response","ok":true,"data":{"id":"r2","choices":[]}}]}',
    ...overrides,
  });
}

describe("export-gork-log: buildFixture v1 contract", () => {
  it("maps columns into the locked v1 fixture shape", () => {
    const fx = buildFixture(baseRow());
    assert.equal(fx.v, 1);
    assert.equal(fx.uid, "u-qa");
    assert.equal(fx.kind, "qa");
    assert.deepEqual(fx.trigger, {
      guildId: "g1",
      channelId: "c1",
      messageId: "m1",
      userId: "usr1",
      content: "gork: hi",
      replyToMessageId: null,
    });
    assert.deepEqual(fx.settings, { gork_keyword: "gork" });
    assert.equal(fx.contextMessages.length, 1);
    assert.deepEqual(fx.expect, {
      ...fx.expect,
      model: "gpt-4o-mini",
      systemPrompt: "SYS",
      userPrompt: "USR",
      status: "shipped",
      shippedAnswer: "hi there",
      finishReason: "stop",
      toolCallCount: 0,
      error: null,
    });
    assert.deepEqual(fx.expect.usage, { total_tokens: 5 });
    assert.deepEqual(fx.parsedFailures, []);
  });

  it("carries the recorded transcript events for the replayer", () => {
    const fx = buildFixture(baseRow());
    assert.deepEqual(
      fx.expect.transcript.map((e) => e.type),
      ["request", "response"],
    );
    assert.deepEqual(fx.expect.transcript[1].data, { id: "r1", choices: [] });
  });

  it("keeps broken JSON columns verbatim WITHOUT crashing (parsedFailures)", () => {
    const fx = buildFixture(
      baseRow({ settings: "{broken", context_messages: "also-broken" }),
    );
    assert.deepEqual(fx.parsedFailures.sort(), ["contextMessages", "settings"]);
    assert.deepEqual(fx.settings, {}); // degraded shape is still object-typed
    assert.deepEqual(fx.contextMessages, []);
  });

  it("solo qa fixture seeds memory.turns with its own trigger turn", () => {
    const fx = buildFixture(baseRow());
    assert.deepEqual(fx.memory.turns, [
      {
        messageId: "m1",
        userId: "usr1",
        content: "gork: hi",
        replyToMessageId: null,
      },
    ]);
    assert.deepEqual(fx.memory.memoryTurns, []);
    assert.equal(fx.memory.enabled, false);
  });
});

describe("export-gork-log: memory chain assembly", () => {
  it("the qa trigger row carries its memory_turn companions", () => {
    const qa = baseRow();
    const mem = memoryTurnRow();
    const fx = buildFixture(qa, { chainTurns: [mem] });
    assert.equal(fx.memory.memoryTurns.length, 1);
    const t = fx.memory.memoryTurns[0];
    assert.equal(t.uid, "u-mem");
    assert.equal(t.parentUid, "u-qa", "camelCase companion link");
    assert.equal(t.status, "shipped");
    assert.deepEqual(t.transcript.responses, [{ id: "r2", choices: [] }]);
  });

  it("a companion recorded for the SAME message adds no duplicate turn", () => {
    const fx = buildFixture(baseRow(), { chainTurns: [memoryTurnRow()] });
    assert.equal(fx.memory.turns.length, 1);
    assert.equal(fx.memory.turns[0].messageId, "m1");
  });

  it("a companion from a different message adds its own chronological turn", () => {
    const fx = buildFixture(baseRow(), {
      chainTurns: [memoryTurnRow({ message_id: "m0-b", trigger_content: "gork: prior" })],
    });
    assert.deepEqual(
      fx.memory.turns.map((t) => t.messageId),
      ["m1", "m0-b"],
    );
  });

  it("list assemblies export every row: qa folded with kids, orphans standalone", () => {
    const fixtures = buildFixturesFromRows([
      baseRow(),
      memoryTurnRow(),
      memoryTurnRow({ uid: "u-orphan", parent_uid: "u-gone", message_id: "m9" }),
    ]);
    const byKind = (k) => fixtures.filter((f) => f.kind === k);
    assert.equal(byKind("qa").length, 1);
    assert.equal(byKind("qa")[0].memory.memoryTurns.length, 1);
    // Orphan chain (parent outside the fetched set) still exports standalone.
    assert.ok(byKind("memory_turn").some((f) => f.uid === "u-orphan"));
    assert.equal(
      byKind("memory_turn").find((f) => f.uid === "u-qa") || undefined,
      undefined,
      "a folded companion does not ALSO appear as itself",
    );
  });
});

describe("export-gork-log: CLI argument validation (no DB touched)", () => {
  const quiet = (fn) => {
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      return fn();
    } finally {
      console.log = log;
      console.error = err;
    }
  };

  it("--help exits 0", () => {
    assert.equal(quiet(() => main(["--help"])), 0);
  });

  it("unknown flag exits 2 with a specific message", () => {
    let message = "";
    const real = console.error;
    console.error = (m) => {
      message += String(m);
    };
    try {
      const code = main(["--bogus"]);
      assert.equal(code, 2);
    } finally {
      console.error = real;
    }
    assert.match(message, /unknown flag: --bogus/);
  });

  it("missing selector exits 2", () => {
    assert.equal(quiet(() => main([])), 2);
  });

  it("bad --kind and --limit exit 2", () => {
    assert.equal(quiet(() => main(["--guild", "g1", "--kind", "nope"])), 2);
    assert.equal(quiet(() => main(["--guild", "g1", "--limit", "0"])), 2);
    assert.equal(quiet(() => main(["--guild", "g1", "--limit", "x"])), 2);
  });

  it("bad --kind exits 2 in --uid mode too (validated in every mode)", () => {
    // --uid used to return BEFORE the kind check, so a typo silently
    // exported with the default kind. Now it fails fast, before any DB.
    assert.equal(quiet(() => main(["--uid", "u1", "--kind", "nope"])), 2);
    assert.equal(quiet(() => main(["--uid", "u1", "--kind", ""])), 2);
  });
});
