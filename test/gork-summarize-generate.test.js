/**
 * Unit tests for the `/gork summarize` generation service (roadmap/gork.md
 * §7.21.3, decision 55; subtask gork-summarize-05).
 *
 * Fully offline: global fetch is replaced per test (tickets.test.js
 * AI-mock pattern + gork.test.js makeAiFetch call-recorder), env saved and
 * restored around every test. Covers: exactly one HTTP round trip (no tool
 * loop), instruction zone = card + focus/lang directives ONLY when supplied
 * (Q&A base prompt absent, no gork_extra_rules), data zone = quoted
 * transcript + disclosed window + roster lines (supplied or built from the
 * window's messages), sanitizeAnswer on the output, the code-point-safe
 * 3,500-char cap with visible truncation, and every never-throw failure
 * branch (config / provider cause / empty output / empty input / crash).
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  generateSummarize,
  buildSummarizeSystemPrompt,
  buildSummarizeUserContent,
  capSummarizeOutput,
  summarizeTurnTimeoutMs,
  SUMMARIZE_TEMPERATURE,
  SUMMARIZE_MAX_TOKENS,
  SUMMARIZE_TURN_TIMEOUT_MS,
  SUMMARIZE_TRUNCATE_MARKER,
} = require("../src/features/gork/summarize");
const C = require("../src/features/gork/constants");

// ---------- env + fetch scaffolding ----------

const AI_ENV = [
  "AI_API_KEY",
  "AI_BASE_URL",
  "AI_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "GORK_LLM_THINKING_TOKEN_BUDGET",
  "GORK_SUMMARIZE_TURN_TIMEOUT_MS",
];

let envSnapshot = null;
let origFetch = null;

beforeEach(() => {
  envSnapshot = {};
  for (const key of AI_ENV) envSnapshot[key] = process.env[key];
  process.env.AI_API_KEY = "test-key-not-real";
  process.env.AI_BASE_URL = "https://ai.example/v1";
  process.env.AI_MODEL = "test-model";
  // OPENAI_* fallbacks must never leak in from the developer's machine.
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
  delete process.env.GORK_LLM_THINKING_TOKEN_BUDGET;
  delete process.env.GORK_SUMMARIZE_TURN_TIMEOUT_MS;
  origFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  for (const key of AI_ENV) {
    if (envSnapshot[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
});

/**
 * Fake OpenAI fetch (gork.test.js pattern): records every wire call and
 * answers with `content` as the assistant message.
 * @param {string|null} content
 */
function makeAiFetch(content) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { completion_tokens: 123 },
      }),
    };
  };
  return { calls, impl };
}

/** Fetch stub that must NEVER be called; counts instead of throwing. */
function countCalls() {
  const calls = [];
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ choices: [] }) };
    },
  };
}

// ---------- fixtures ----------

const RUNDOWN = [
  "**Headline** — launch-week go/no-go.",
  "**What was decided** — ship Tuesday.",
  "**Open questions** — none.",
  "**Action items** — Alice: deploy.",
  "**Who said what that mattered** — Alice: ship it.",
].join("\n");

/** readSummarizeRange() success result (consumed as-is by the service). */
function readerResult(overrides = {}) {
  return {
    ok: true,
    mode: "from-to",
    channelId: "chan-1",
    messages: [
      { id: "111", author: { id: "1111", username: "alice" }, content: "ship it" },
      {
        id: "222",
        author: { id: "2222", username: "gork", bot: true },
        content: "deployed",
        webhookId: null,
      },
    ],
    transcript: [
      "111 | 2026-09-27 10:00 | @alice: ship it",
      "222 | 2026-09-27 10:01 | @gork [bot]: deployed",
    ].join("\n"),
    firstId: "111",
    lastId: "222",
    count: 2,
    scannedCount: 2,
    requestedLast: null,
    clamped: false,
    clampReasons: [],
    clampNote: null,
    ...overrides,
  };
}

/** Pre-built buildRoster() result covering the window's human author. */
function prebuiltRoster() {
  return {
    entries: new Map([
      ["1111", { id: "1111", handle: "alice", display: "Alice", nickname: null }],
    ]),
    lines: ["1111 | @alice | Alice"],
    truncated: 0,
  };
}

/** Duck-typed guild + client resolving author "1111" (roster build test). */
function rosterFakes() {
  const guild = {
    id: "g1",
    members: {
      cache: new Map([
        [
          "1111",
          { user: { id: "1111", username: "alice" }, displayName: "Alice", nickname: null },
        ],
      ]),
      fetch: async () => null,
    },
  };
  const client = {
    users: {
      cache: new Map([["2222", { id: "2222", username: "gork", bot: true }]]),
      fetch: async () => null,
    },
  };
  return { guild, client };
}

/** Assert every surrogate in `text` is part of a valid pair. */
function assertNoLoneSurrogates(text, msg = "") {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      assert.ok(
        next >= 0xdc00 && next <= 0xdfff,
        `${msg}: high surrogate at ${i} not followed by a low surrogate`,
      );
      i += 1;
    } else {
      assert.ok(
        !(code >= 0xdc00 && code <= 0xdfff),
        `${msg}: lone low surrogate at ${i}`,
      );
    }
  }
}

// ---------- single-shot call ----------

describe("generateSummarize — one-shot call", () => {
  it("makes exactly ONE HTTP round trip with [system,user] and no tools parameter", async () => {
    const { calls, impl } = makeAiFetch(RUNDOWN);
    globalThis.fetch = impl;

    const res = await generateSummarize(readerResult(), { guildId: "g1" });

    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://ai.example/v1/chat/completions");
    const body = calls[0].body;
    assert.equal(body.model, "test-model");
    assert.deepEqual(
      body.messages.map((m) => m.role),
      ["system", "user"],
    );
    // No tool loop (decision 55): no tools param on the wire at all.
    assert.ok(!("tools" in body), "wire body must not carry tools");
    assert.equal(body.temperature, SUMMARIZE_TEMPERATURE);
    assert.equal(body.max_tokens, SUMMARIZE_MAX_TOKENS);
    // Reasoning budget only rides on an explicit opt-in.
    assert.ok(!("thinking_token_budget" in body));
  });

  it("forwards GORK_LLM_THINKING_TOKEN_BUDGET like the Q&A path", async () => {
    process.env.GORK_LLM_THINKING_TOKEN_BUDGET = "1024";
    const { calls, impl } = makeAiFetch(RUNDOWN);
    globalThis.fetch = impl;

    const res = await generateSummarize(readerResult(), { guildId: "g1" });

    assert.equal(res.ok, true);
    assert.equal(calls[0].body.thinking_token_budget, 1024);
  });

  it("summarizeTurnTimeoutMs: bounded default with a call-time env override", () => {
    assert.equal(summarizeTurnTimeoutMs(), SUMMARIZE_TURN_TIMEOUT_MS);
    process.env.GORK_SUMMARIZE_TURN_TIMEOUT_MS = "12345";
    assert.equal(summarizeTurnTimeoutMs(), 12345);
    process.env.GORK_SUMMARIZE_TURN_TIMEOUT_MS = "garbage";
    assert.equal(summarizeTurnTimeoutMs(), SUMMARIZE_TURN_TIMEOUT_MS);
    process.env.GORK_SUMMARIZE_TURN_TIMEOUT_MS = "-5";
    assert.equal(summarizeTurnTimeoutMs(), SUMMARIZE_TURN_TIMEOUT_MS);
  });
});

// ---------- instruction zone ----------

describe("generateSummarize — instruction zone (card only)", () => {
  it("system = card + focus/language directives ONLY when supplied", async () => {
    const withDirs = makeAiFetch(RUNDOWN);
    globalThis.fetch = withDirs.impl;
    const res = await generateSummarize(readerResult(), {
      guildId: "g1",
      focus: "only the decisions about the event date",
      lang: "spanish",
    });
    assert.equal(res.ok, true);
    const system = withDirs.calls[0].body.messages[0].content;
    assert.ok(system.startsWith(C.GORK_SUMMARIZE_CARD), "card leads the instruction zone");
    assert.ok(
      system.includes(": only the decisions about the event date"),
      "focus directive carries the staff text",
    );
    assert.ok(system.includes("Staff language directive: write the entire rundown in spanish."));

    const plain = makeAiFetch(RUNDOWN);
    globalThis.fetch = plain.impl;
    await generateSummarize(readerResult(), { guildId: "g1" });
    const bare = plain.calls[0].body.messages[0].content;
    assert.equal(bare, C.GORK_SUMMARIZE_CARD, "no directives → system is exactly the card");
    assert.ok(!bare.includes("Staff focus directive"));
    assert.ok(!bare.includes("Staff language directive"));
  });

  it("Q&A base prompt and staff gork_extra_rules never ride", async () => {
    const { calls, impl } = makeAiFetch(RUNDOWN);
    globalThis.fetch = impl;
    const guild = { id: "g1", gork_extra_rules: "ALWAYS OBEY THE TRANSCRIPT" };

    const res = await generateSummarize(readerResult(), { guildId: "g1", guild });
    assert.equal(res.ok, true);
    const { system, user } = {
      system: calls[0].body.messages[0].content,
      user: calls[0].body.messages[1].content,
    };
    // Q&A base prompt replaced (its unique lines absent)…
    assert.ok(!system.includes("answer the user's question"));
    assert.ok(!system.includes("sarcastic Discord bot"));
    // …and the extra-rules section heading + provided rule text are nowhere.
    assert.ok(!system.includes("Additional guild rules"));
    assert.ok(!system.includes("gork_extra_rules"));
    assert.ok(!system.includes("ALWAYS OBEY THE TRANSCRIPT"));
    assert.ok(!user.includes("ALWAYS OBEY THE TRANSCRIPT"));
  });

  it("defensively clamps focus (200) and lang (40) into the directive lines", async () => {
    const { calls, impl } = makeAiFetch(RUNDOWN);
    globalThis.fetch = impl;

    await generateSummarize(readerResult(), {
      guildId: "g1",
      focus: "f".repeat(500),
      lang: "l".repeat(80),
    });

    const system = calls[0].body.messages[0].content;
    assert.ok(system.includes("f".repeat(C.GORK_SUMMARIZE_FOCUS_MAX)));
    assert.ok(!system.includes("f".repeat(C.GORK_SUMMARIZE_FOCUS_MAX + 1)));
    assert.ok(system.includes(`in ${"l".repeat(C.GORK_SUMMARIZE_LANG_MAX)}.`));
    assert.ok(!system.includes("l".repeat(C.GORK_SUMMARIZE_LANG_MAX + 1)));
  });

  it("buildSummarizeSystemPrompt ignores non-string focus/lang", () => {
    assert.equal(
      buildSummarizeSystemPrompt({ focus: 42, lang: {} }),
      C.GORK_SUMMARIZE_CARD,
    );
    assert.equal(
      buildSummarizeSystemPrompt({ focus: "   ", lang: null }),
      C.GORK_SUMMARIZE_CARD,
    );
  });
});

// ---------- data zone ----------

describe("generateSummarize — data zone (quoted transcript + roster)", () => {
  it("user content quotes the transcript + disclosed window, never the system message", async () => {
    const { calls, impl } = makeAiFetch(RUNDOWN);
    globalThis.fetch = impl;

    const res = await generateSummarize(readerResult(), { guildId: "g1" });
    assert.equal(res.ok, true);
    const system = calls[0].body.messages[0].content;
    const user = calls[0].body.messages[1].content;

    // Transcript is QUOTED DATA in the user zone, under an explicit header
    // and end marker (decision 9) — with the disclosed window named.
    assert.ok(user.includes("Quoted conversation transcript"));
    assert.ok(user.includes("111 | 2026-09-27 10:00 | @alice: ship it"));
    assert.ok(user.includes("222 | 2026-09-27 10:01 | @gork [bot]: deployed"));
    assert.ok(user.includes("--- end of quoted transcript ---"));
    assert.ok(user.includes("Disclosed window: channel chan-1 · messages 111 → 222 · 2 message(s)."));
    // Decision 9 hard line: transcript content never reaches the system.
    assert.ok(!system.includes("ship it"));
    assert.ok(!system.includes("@alice"));
  });

  it("pre-built roster block rides in the user message (People roster)", async () => {
    const { calls, impl } = makeAiFetch(RUNDOWN);
    globalThis.fetch = impl;

    await generateSummarize(readerResult(), {
      guildId: "g1",
      roster: prebuiltRoster(),
    });

    const user = calls[0].body.messages[1].content;
    assert.ok(user.includes("People roster:"));
    assert.ok(user.includes("1111 | @alice | Alice"));
    assert.ok(user.includes("never write raw <@id>")); // roster.js guidance block
  });

  it("builds the roster from the window's messages via client + guild (Q&A Fix 2)", async () => {
    const { calls, impl } = makeAiFetch(RUNDOWN);
    globalThis.fetch = impl;
    const { guild, client } = rosterFakes();

    const res = await generateSummarize(readerResult(), { guildId: "g1", guild, client });

    assert.equal(res.ok, true);
    const user = calls[0].body.messages[1].content;
    assert.ok(user.includes("1111 | @alice | Alice"), "human author resolved");
    assert.ok(user.includes("2222 | @gork | gork"), "labeled bot author resolved");
    assert.equal(res.meta.rosterEntries, 2);
  });

  it("a failing roster build never sinks the generation (best-effort)", async () => {
    const { impl } = makeAiFetch(RUNDOWN);
    globalThis.fetch = impl;

    const res = await generateSummarize(readerResult(), {
      guildId: "g1",
      rosterBuilder: async () => {
        throw new Error("roster exploded");
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.meta.rosterEntries, 0);
    const user = res.meta.user;
    assert.ok(!user.includes("People roster:"));
    assert.ok(user.includes("ship it"), "transcript still delivered");
  });

  it("buildSummarizeUserContent degrades gracefully without window info", () => {
    const out = buildSummarizeUserContent({ transcript: "abc | x | @a: hi" });
    assert.ok(out.includes("abc | x | @a: hi"));
    assert.ok(!out.includes("Disclosed window"));
    assert.equal(buildSummarizeUserContent({}), "");
  });
});

// ---------- output handling ----------

describe("generateSummarize — output handling", () => {
  it("sanitizeAnswer rewrites echoed mention tokens via the roster (Fix 1)", async () => {
    const { impl } = makeAiFetch(
      "**Headline** — <@1111> shipped it; <@9999> asked about <#555>.",
    );
    globalThis.fetch = impl;

    const res = await generateSummarize(readerResult(), {
      guildId: "g1",
      guild: {},
      roster: prebuiltRoster(),
    });

    assert.equal(res.ok, true);
    assert.ok(res.text.includes("@Alice"), "known id → resolved name");
    assert.ok(res.text.includes("@someone"), "unknown id → @someone");
    assert.ok(res.text.includes("#some-channel"));
    assert.ok(!res.text.includes("<@1111>"));
    assert.ok(!res.text.includes("<@9999>"));
    assert.ok(!res.text.includes("<#555>"));
  });

  it("clamps over-cap output to 3,500 chars with the visible marker", async () => {
    const { impl } = makeAiFetch("x".repeat(5000));
    globalThis.fetch = impl;

    const res = await generateSummarize(readerResult(), { guildId: "g1" });

    assert.equal(res.ok, true);
    assert.equal(res.text.length, C.GORK_SUMMARIZE_OUTPUT_MAX);
    assert.ok(res.text.endsWith(SUMMARIZE_TRUNCATE_MARKER), "truncation is visible");
    assert.equal(res.meta.truncated, true);
    assert.equal(res.meta.sanitizedChars, 5000);
    assert.equal(res.meta.outputChars, C.GORK_SUMMARIZE_OUTPUT_MAX);
  });

  it("capSummarizeOutput cuts at a code-point boundary, never splitting an emoji", () => {
    const window = C.GORK_SUMMARIZE_OUTPUT_MAX - SUMMARIZE_TRUNCATE_MARKER.length;
    // Over the cap, with the cut position landing EXACTLY INSIDE the first
    // surrogate pair (a naive slice would emit a lone high surrogate).
    const text = `${"a".repeat(window - 1)}${"😀".repeat(20)}`;
    assert.ok(text.length > C.GORK_SUMMARIZE_OUTPUT_MAX);

    const { text: capped, truncated } = capSummarizeOutput(text);

    assert.equal(truncated, true);
    assert.ok(capped.length <= C.GORK_SUMMARIZE_OUTPUT_MAX);
    assert.equal(capped, "a".repeat(window - 1) + SUMMARIZE_TRUNCATE_MARKER);
    assertNoLoneSurrogates(capped, "capped output");

    const under = capSummarizeOutput("short rundown");
    assert.deepEqual(under, { text: "short rundown", truncated: false });
  });

  it("meta carries everything the audit + interaction log want", async () => {
    const { calls, impl } = makeAiFetch(RUNDOWN);
    globalThis.fetch = impl;

    const res = await generateSummarize(readerResult(), { guildId: "g1" });

    assert.equal(res.ok, true);
    assert.equal(res.meta.model, "test-model");
    assert.equal(typeof res.meta.durationMs, "number");
    assert.ok(res.meta.durationMs >= 0);
    assert.equal(res.meta.finishReason, "stop");
    assert.deepEqual(res.meta.usage, { completion_tokens: 123 });
    // Byte-identical prompt capture for the interaction log.
    assert.equal(res.meta.system, calls[0].body.messages[0].content);
    assert.equal(res.meta.user, calls[0].body.messages[1].content);
    assert.equal(res.text, RUNDOWN);
  });
});

// ---------- never-throw error contract ----------

describe("generateSummarize — never throws, specific causes", () => {
  it("missing API key → { ok:false, code:'config' } with zero network calls", async () => {
    delete process.env.AI_API_KEY;
    const counter = countCalls();
    globalThis.fetch = counter.impl;

    const res = await generateSummarize(readerResult(), { guildId: "g1" });

    assert.equal(res.ok, false);
    assert.equal(res.code, "config");
    assert.match(res.error, /AI is not configured/i);
    assert.equal(counter.calls.length, 0);
  });

  it("provider HTTP failure → specific { ok:false } carrying the cause", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      text: async () => "model 'test-model' does not exist or you lack access",
    });

    const res = await generateSummarize(readerResult(), { guildId: "g1" });

    assert.equal(res.ok, false);
    assert.equal(res.code, "ai");
    assert.match(res.error, /HTTP 503/);
    assert.match(res.error, /does not exist or you lack access/);
    assert.match(res.error, /url=https:\/\/ai\.example\/v1\/chat\/completions/);
  });

  it("provider network failure → the thrown cause surfaces", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED boom");
    };

    const res = await generateSummarize(readerResult(), { guildId: "g1" });

    assert.equal(res.ok, false);
    assert.equal(res.code, "ai");
    assert.match(res.error, /network/);
    assert.match(res.error, /ECONNREFUSED boom/);
  });

  it("OK-with-empty completion → distinct 'empty' error with provider diagnostics", async () => {
    for (const blank of ["", "   \n ", null]) {
      const { impl } = makeAiFetch(blank);
      globalThis.fetch = impl;

      const res = await generateSummarize(readerResult(), { guildId: "g1" });

      assert.equal(res.ok, false, `blank content ${JSON.stringify(blank)} must fail`);
      assert.equal(res.code, "empty");
      assert.match(res.error, /empty rundown/);
      assert.match(res.error, /finish_reason=stop/);
      assert.match(res.error, /completion_tokens=123/);
    }
  });

  it("empty transcript → 'empty' error without touching the network", async () => {
    const counter = countCalls();
    globalThis.fetch = counter.impl;

    const res = await generateSummarize({ transcript: "   " }, { guildId: "g1" });

    assert.equal(res.ok, false);
    assert.equal(res.code, "empty");
    assert.match(res.error, /No transcript to summarize/);
    assert.equal(counter.calls.length, 0);
  });

  it("never throws: garbage inputs and a throwing chat stub stay result objects", async () => {
    const missing = await generateSummarize(undefined, undefined);
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "empty");

    const exploded = await generateSummarize(readerResult(), {
      guildId: "g1",
      chatImpl: async () => {
        throw new Error("stub exploded");
      },
    });
    assert.equal(exploded.ok, false);
    assert.equal(exploded.code, "internal");
    assert.match(exploded.error, /stub exploded/);
  });
});
