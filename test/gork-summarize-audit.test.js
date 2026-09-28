/**
 * `/gork summarize` audit variant + interaction-log row shape — unit tests
 * (roadmap/gork.md §7.21.5, decision 57; subtask gork-summarize-06).
 *
 * 1. logGorkSummarize: the summarize variant of the Q&A audit embed — mode
 *    (from+to / from->now / last:N), resolved range (channel + first/last
 *    ids), focus (display-capped), lang, invoker, outcome — plus the
 *    never-throw degrade idioms (console fallback / console.warn).
 * 2. logGorkSummarizeFailure: the compact one-liner carrying the SPECIFIC
 *    failure reason (logGorkFailure style).
 * 3. createSummarizeInteractionRecorder: the summarize row on the
 *    migration-027 envelope — same isInteractionLogEnabled gate as Q&A,
 *    exactly one row per job, kind "summarize" marker, context_meta
 *    carrying the resolved window, zero schema change.
 *
 * Real db facade on a temp SQLite (sendAuditLog resolves the guild's audit
 * channel through getGuildSettings), real audit.js, fake discord.js I/O,
 * fake repo for the recorder (no gork_interactions writes needed).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

// Contract (same as the other repo tests): loadDb() must run before any
// DB-opening `src/` require — audit.js loads src/features/logs/auditLog,
// which requires the db facade at module scope.
const { loadDb } = require("./helpers/env");
const {
  createClient,
  createGuild,
  createTextChannel,
  createUser,
} = require("./helpers/discord");

let api;
let cleanup;
let audit;
let constants;
let Color;

before(() => {
  ({ api, cleanup } = loadDb());
  audit = require("../src/features/gork/audit");
  constants = require("../src/features/gork/constants");
  ({ Color } = require("../src/core/theme"));
});

after(() => cleanup?.());

// ---------- harness ----------

/** Guild with a wired audit channel (settings + fake client fetch seam). */
function makeAuditEnv(guildId) {
  const guild = createGuild({ id: guildId });
  const auditChannel = createTextChannel({
    id: `audit-${guildId}`,
    guild,
    name: "audit",
  });
  guild.addChannel(auditChannel);
  const client = createClient();
  client.addGuild(guild);
  api.updateGuildSettings(guildId, { audit_log_channel_id: auditChannel.id });
  return { guild, auditChannel, client };
}

/** Guild WITHOUT a configured audit channel (fallback-log branch). */
function makeBareEnv(guildId) {
  const guild = createGuild({ id: guildId });
  const client = createClient();
  client.addGuild(guild);
  return { guild, client };
}

/** Embed JSON of the Nth payload sent to the audit channel (0-based). */
function sentEmbed(env, index = 0) {
  const payload = env.auditChannel.sent[index];
  const embed = payload && payload.embeds && payload.embeds[0];
  return embed ? (embed.toJSON ? embed.toJSON() : embed) : null;
}

function fieldValue(embed, name) {
  const field = (embed.fields || []).find((f) => f.name === name);
  return field ? field.value : undefined;
}

/** Run async `fn` with console.<method> captured; resolves to the lines. */
async function captureConsoleAsync(fn, method = "warn") {
  const real = console[method];
  const lines = [];
  console[method] = (...args) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console[method] = real;
  }
  return lines;
}

// The interaction-log env keys owned by interactionLog.js — scrubbed for
// every recorder test so ambient env can't leak in (same idiom as
// test/gork-interaction-log.test.js).
const IL_ENV_KEYS = [
  "GORK_INTERACTION_LOG",
  "GORK_INTERACTION_LOG_RETENTION_DAYS",
  "GORK_INTERACTION_LOG_MAX_JSON_CHARS",
];

function withEnv(over, fn) {
  const saved = {};
  const keys = new Set([...IL_ENV_KEYS, ...Object.keys(over)]);
  for (const key of keys) {
    saved[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
  }
  for (const key of keys) {
    if (over[key] === undefined) delete process.env[key];
    else process.env[key] = over[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Fake db facade: records every insert call, returns incrementing ids. */
function fakeRepo() {
  const calls = [];
  return {
    calls,
    insertGorkInteraction(row, opts) {
      calls.push({ row, opts });
      return { ok: true, id: 100 + calls.length };
    },
  };
}

/**
 * The exact migration-027 column set (gork_interactions). The summarize row
 * must stay inside this list — anything new would mean a schema change.
 */
const MIGRATION_027_COLUMNS = [
  "uid", "kind", "parent_uid", "guild_id", "channel_id", "message_id",
  "user_id", "status", "started_at", "duration_ms", "model", "params",
  "tools", "settings", "system_prompt", "user_prompt", "trigger_content",
  "reply_to_message_id", "context_meta", "context_messages", "roster_meta",
  "roster_block", "roster_entries", "memory_meta", "transcript",
  "answer_raw", "answer_shipped", "finish_reason", "usage",
  "tool_call_count", "error", "created_at",
];

// ---------- describeSummarizeMode ----------

describe("describeSummarizeMode — locked mode labels", () => {
  it("maps the three discrete modes to the audited labels", () => {
    assert.equal(audit.describeSummarizeMode("from-to"), "from+to");
    assert.equal(audit.describeSummarizeMode("from+to"), "from+to");
    assert.equal(audit.describeSummarizeMode("FROM-TO"), "from+to");
    assert.equal(audit.describeSummarizeMode("range"), "from+to");
    assert.equal(audit.describeSummarizeMode("from-now"), "from->now");
    assert.equal(audit.describeSummarizeMode("from->now"), "from->now");
    assert.equal(audit.describeSummarizeMode("From Now"), "from->now");
    assert.equal(audit.describeSummarizeMode("last", 250), "last:250");
    assert.equal(audit.describeSummarizeMode("last", "40"), "last:40");
    assert.equal(audit.describeSummarizeMode("last:250"), "last:250");
  });

  it("degrades without inventing a label: no count, unknown mode, empty", () => {
    assert.equal(audit.describeSummarizeMode("last"), "last", "no N → raw pass-through");
    assert.equal(audit.describeSummarizeMode("sideways"), "sideways");
    assert.equal(audit.describeSummarizeMode(null), "—");
    assert.equal(audit.describeSummarizeMode("  "), "—");
  });
});

// ---------- logGorkSummarize (success embed) ----------

describe("logGorkSummarize — summarize variant of the Q&A audit embed", () => {
  it("records mode, resolved range, focus, lang and invoker for a successful run", async () => {
    const env = makeAuditEnv("g-sum-ok");
    const invoker = createUser({ id: "u-invoker" });
    await audit.logGorkSummarize(env.client, "g-sum-ok", {
      user: invoker,
      mode: "last",
      lastCount: 150,
      channelLabel: "#general",
      channelId: "c-src",
      firstMessage: "1110000000000000001",
      lastMessage: { id: "1110000000000000009", channelId: "c-src" },
      messageCount: 150,
      focus: "the migration plan",
      lang: "spanish",
      model: "test-model",
      durationMs: 2300,
      rundown: "**Headline** — migration talk",
      replyMessage: { id: "2220000000000000002", channelId: "c-cmd" },
    });

    assert.equal(env.auditChannel.sent.length, 1, "exactly one audit embed");
    const embed = sentEmbed(env);
    assert.equal(embed.title, "Gork summarize");
    assert.equal(embed.color, Color.brand);
    assert.equal(fieldValue(embed, "Requested by"), "<@u-invoker>");
    assert.equal(fieldValue(embed, "Mode"), "last:150");
    assert.equal(fieldValue(embed, "Channel"), "#general");
    const range = fieldValue(embed, "Range");
    assert.ok(range.includes("1110000000000000001"), "first id recorded");
    assert.ok(range.includes("1110000000000000009"), "last id recorded");
    assert.ok(
      range.includes("https://discord.com/channels/g-sum-ok/c-src/1110000000000000001"),
      "first id carries a jump link",
    );
    assert.ok(range.includes("150 msgs"), "disclosed window count");
    assert.equal(fieldValue(embed, "Focus"), "the migration plan");
    assert.equal(fieldValue(embed, "Language"), "spanish");
    assert.equal(fieldValue(embed, "Model / duration"), "test-model / 2.3s");
    assert.ok(fieldValue(embed, "Rundown").includes("migration talk"));
    assert.equal(fieldValue(embed, "Outcome"), "posted", "default outcome");
    assert.ok(
      fieldValue(embed, "Jump").includes(
        "https://discord.com/channels/g-sum-ok/c-cmd/2220000000000000002",
      ),
      "jump link to the posted rundown",
    );
  });

  it("renders every mode in the embed and defaults the optional bits", async () => {
    const env = makeAuditEnv("g-sum-modes");
    for (const [mode, lastCount, label] of [
      ["from-to", null, "from+to"],
      ["from-now", null, "from->now"],
      ["last", 25, "last:25"],
    ]) {
      await audit.logGorkSummarize(env.client, "g-sum-modes", {
        user: createUser({ id: "u-mode" }),
        mode,
        lastCount,
        channelId: "c-src-m",
      });
    }
    assert.deepEqual(
      [0, 1, 2].map((i) => fieldValue(sentEmbed(env, i), "Mode")),
      ["from+to", "from->now", "last:25"],
    );
    const embed = sentEmbed(env, 0);
    assert.equal(fieldValue(embed, "Channel"), "<#c-src-m>", "label-less channel falls back to a mention");
    assert.equal(fieldValue(embed, "Range"), "—", "no anchors → explicit dash, never fake ids");
    assert.equal(fieldValue(embed, "Focus"), "—");
    assert.equal(fieldValue(embed, "Language"), "(conversation language)");
    assert.equal(embed.fields.some((f) => f.name === "Model / duration"), false, "model omitted → field absent");
    assert.equal(embed.fields.some((f) => f.name === "Jump"), false, "no reply message → no Jump field");
  });

  it("caps the focus display at the option cap (GORK_SUMMARIZE_FOCUS_MAX)", async () => {
    const env = makeAuditEnv("g-sum-focus");
    await audit.logGorkSummarize(env.client, "g-sum-focus", {
      mode: "from-to",
      channelId: "c-src-f",
      focus: "f".repeat(500),
    });
    const value = fieldValue(sentEmbed(env), "Focus");
    assert.ok(
      value.length <= constants.GORK_SUMMARIZE_FOCUS_MAX,
      `focus display ≤ ${constants.GORK_SUMMARIZE_FOCUS_MAX} (got ${value.length})`,
    );
    assert.ok(value.endsWith("…"), "truncation is visible");
    assert.ok(value.startsWith("ffff"));
  });

  it("degrades to a one-line console log when no audit channel is configured", async () => {
    const env = makeBareEnv("g-sum-nochannel");
    // No audit_log_channel_id on this guild → sendAuditLog returns false →
    // the ids ride a one-line console fallback (AGENTS.md: reproduce from logs).
    const lines = await captureConsoleAsync(
      () =>
        audit.logGorkSummarize(env.client, "g-sum-nochannel", {
          user: createUser({ id: "u-lonely" }),
          mode: "from-now",
          channelId: "c-src-n",
        }),
      "log",
    );
    assert.ok(
      lines.some((l) => l.startsWith("[gork] summarize (no audit channel): <@u-lonely> from->now")),
      "fallback console line with invoker + mode: " + JSON.stringify(lines),
    );
  });

  it("never throws: an internal explosion warns with the audit-failed prefix", async () => {
    const env = makeAuditEnv("g-sum-boom");
    const evilUser = {
      get id() {
        throw new Error("summarize audit exploded");
      },
    };
    const lines = await captureConsoleAsync(() =>
      audit.logGorkSummarize(env.client, "g-sum-boom", { user: evilUser, mode: "last", lastCount: 5 }),
    );
    assert.ok(
      lines.some((l) => l.startsWith("[gork] summarize audit log failed:")),
      "degrade idiom matches the existing audit functions: " + JSON.stringify(lines),
    );
    assert.ok(lines.some((l) => l.includes("summarize audit exploded")), "the cause is logged");
    assert.equal(env.auditChannel.sent.length, 0, "nothing half-built was posted");
  });
});

// ---------- logGorkSummarizeFailure (failure one-liner) ----------

describe("logGorkSummarizeFailure — compact failure audit", () => {
  it("posts the compact variant naming the specific reason", async () => {
    const env = makeAuditEnv("g-sum-fail");
    await audit.logGorkSummarizeFailure(env.client, "g-sum-fail", {
      user: createUser({ id: "u-staff" }),
      mode: "last",
      lastCount: 25,
      channelLabel: "#ticket-7",
      reason: "provider returned an empty answer (finish_reason=length)",
    });
    assert.equal(env.auditChannel.sent.length, 1);
    const embed = sentEmbed(env);
    assert.equal(embed.title, "Gork summarize");
    assert.equal(embed.color, Color.danger, "failure chrome mirrors logGorkFailure");
    assert.ok(embed.description.includes("provider returned an empty answer (finish_reason=length)"));
    assert.ok(embed.description.includes("last:25"));
    assert.ok(embed.description.includes("#ticket-7"));
    assert.ok(embed.description.includes("<@u-staff>"));
  });

  it("still names a reason when nothing else is known, and degrades without an audit channel", async () => {
    const env = makeBareEnv("g-sum-fail-bare");
    const lines = await captureConsoleAsync(
      () => audit.logGorkSummarizeFailure(env.client, "g-sum-fail-bare", { mode: null }),
      "log",
    );
    assert.ok(
      lines.some(
        (l) => l.startsWith("[gork] summarize failure (no audit channel): Unknown: unknown error"),
      ),
      "unknown-error fallback, never silence: " + JSON.stringify(lines),
    );
  });
});

// ---------- createSummarizeInteractionRecorder (migration-027 row) ----------

describe("createSummarizeInteractionRecorder — summarize row on the 027 envelope", () => {
  /** Recorder opts with the full resolved-window context (fake repo). */
  function summarizeRecorderOpts(over = {}) {
    const repo = fakeRepo();
    const recorder = audit.createSummarizeInteractionRecorder({
      settings: { gork_interaction_log_enabled: 1 },
      guildId: "g-sum-log",
      channelId: "ix-chan",
      interactionId: "ix-900",
      userId: "u-sum",
      mode: "last",
      lastCount: 40,
      range: {
        channelId: "c-read",
        firstMessageId: "m-first",
        lastMessageId: "m-last",
        collected: 40,
        clamped: true,
      },
      focus: "decisions",
      lang: "en",
      model: "m-test",
      params: { temperature: 0.5, maxTokens: 3500 },
      system: "SUMMARIZE SYSTEM",
      user: "TRANSCRIPT DATA",
      startedAt: 1757000000000,
      repo,
      uid: "sum-uid-1",
      now: () => 1757000005000,
      ...over,
    });
    return { recorder, repo };
  }

  it("enabled run produces exactly one row with the summarize marker", () => {
    withEnv({}, () => {
      const { recorder, repo } = summarizeRecorderOpts();
      assert.ok(recorder, "enabled → recorder exists");
      recorder.onEvent({ type: "request", payload: { model: "m-test" } });
      const first = recorder.finalize({ status: "shipped", answerShipped: "the rundown" });
      assert.deepEqual(first, { ok: true, id: 101 });
      recorder.finalize({ status: "error" });
      assert.equal(repo.calls.length, 1, "exactly one insert per job (finalize idempotent)");

      const { row } = repo.calls[0];
      assert.equal(row.kind, "summarize", "summarize-identifying kind value");
      assert.equal(row.kind, audit.GORK_SUMMARIZE_INTERACTION_KIND);
      assert.equal(row.uid, "sum-uid-1");
      assert.equal(row.parent_uid, null, "standalone job");
      assert.equal(row.guild_id, "g-sum-log");
      assert.equal(row.channel_id, "c-read", "resolved READ channel");
      assert.equal(row.message_id, "ix-900", "slash interaction id anchors the row");
      assert.equal(row.user_id, "u-sum");
      assert.equal(row.status, "shipped");
      assert.equal(row.answer_shipped, "the rundown");
      assert.equal(row.trigger_content, "/gork summarize", "invocation surface label");
      assert.equal(row.system_prompt, "SUMMARIZE SYSTEM");
      assert.equal(row.user_prompt, "TRANSCRIPT DATA");
      assert.equal(row.model, "m-test");

      // context_meta carries the summarize run shape (§7.21.5 audit fields).
      assert.deepEqual(JSON.parse(row.context_meta), {
        surface: "summarize",
        mode: "last:40",
        last_count: 40,
        resolved: {
          channel_id: "c-read",
          first_message_id: "m-first",
          last_message_id: "m-last",
          collected: 40,
          clamped: true,
        },
        focus: "decisions",
        lang: "en",
      });

      // Migration-027 schema ONLY: the row touches exactly the known columns.
      assert.deepEqual(
        Object.keys(row).sort(),
        [...MIGRATION_027_COLUMNS].sort(),
        "no new columns — 027 schema only",
      );
      // MVP sends no tools: the tools column stays null unless provided.
      assert.equal(row.tools, null);
    });
  });

  it("accepts a custom triggerContent surface label", () => {
    withEnv({}, () => {
      const { recorder, repo } = summarizeRecorderOpts({
        triggerContent: "/gork summarize channel:#general last:40",
      });
      recorder.finalize({ status: "shipped" });
      assert.equal(repo.calls[0].row.trigger_content, "/gork summarize channel:#general last:40");
    });
  });

  it("disabled interaction log writes nothing: env kill-switch AND guild setting", () => {
    withEnv({ GORK_INTERACTION_LOG: "0" }, () => {
      const { recorder, repo } = summarizeRecorderOpts({
        settings: { gork_interaction_log_enabled: 1 },
      });
      assert.equal(recorder, null, "env kill-switch → no recorder at all");
      assert.equal(repo.calls.length, 0, "nothing written");
    });
    withEnv({}, () => {
      const { recorder, repo } = summarizeRecorderOpts({
        settings: { gork_interaction_log_enabled: 0 },
      });
      assert.equal(recorder, null, "guild setting OFF → no recorder (same gate as Q&A)");
      assert.equal(repo.calls.length, 0);
    });
    withEnv({}, () => {
      const { recorder } = summarizeRecorderOpts({ settings: null });
      assert.ok(recorder, "absent settings defaults ON, like Q&A rows");
    });
  });

  it("never throws: a hostile settings read degrades to null with a warn", () => {
    const evil = {
      get gork_interaction_log_enabled() {
        throw new Error("evil settings");
      },
    };
    const run = () =>
      audit.createSummarizeInteractionRecorder({
        settings: evil,
        guildId: "g-sum-evil",
        interactionId: "ix-evil",
      });
    const real = console.warn;
    const lines = [];
    console.warn = (...args) => lines.push(args.map(String).join(" "));
    let result;
    try {
      result = run();
    } finally {
      console.warn = real;
    }
    assert.equal(result, null, "build failure → null → handler skips recording");
    assert.ok(
      lines.some(
        (l) =>
          l.startsWith("[gork] summarize interaction log recorder build failed (guild=g-sum-evil interaction=ix-evil):") &&
          l.includes("evil settings"),
      ),
      "warn with ids + cause: " + JSON.stringify(lines),
    );
  });
});
