/**
 * Gork interaction logging — unit tests:
 *  1. migration 027 (schema, indexes, guild_settings default, idempotency)
 *     + the gorkInteractions repository via the db facade on a temp DB.
 *  2. the optional `onEvent` capture seam in src/core/ai.js (no DB, no
 *     network — scripted fetch only).
 *  3. the interaction-log recorder (src/features/gork/interactionLog.js):
 *     env config parsing, the enable matrix, event caps, row mapping,
 *     finalize idempotency and transcript truncation — all on a fake repo
 *     and an injected clock, no DB and no network.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

// Contract (same as the other repo tests): loadDb() must run before any
// DB-opening `src/` require in this file. src/core/ai.js opens no DB/env and
// holds no module state, so requiring it at module scope is safe here.
const { loadDb } = require("./helpers/env");
const { chatCompletion, chatWithTools } = require("../src/core/ai");
// Recorder module: requires only `crypto` at load (the db facade is required
// lazily at finalize), so a top-level require is safe before loadDb().
const {
  interactionLogConfig,
  isInteractionLogEnabled,
  buildSettingsSnapshot,
  createInteractionRecorder,
  MAX_EVENTS,
  EVENT_STRING_CAP,
  STRING_CAP_MARKER,
  DEFAULT_MAX_JSON_CHARS,
} = require("../src/features/gork/interactionLog");

const DAY = 86400000;

/** Run `fn` with console.<method> captured; returns the captured lines. */
function captureConsole(fn, method = "error") {
  const real = console[method];
  const lines = [];
  console[method] = (...args) => lines.push(args.map(String).join(" "));
  try {
    fn();
  } finally {
    console[method] = real;
  }
  return lines;
}

// ---------- repository (temp DB) ----------

describe("gork interaction log repository", () => {
  let api;
  let cleanup;

  before(() => {
    ({ api, cleanup } = loadDb());
  });

  // Closes the tracked DB handles and removes the temp dir (idempotent).
  after(() => cleanup?.());

  let seq = 0;
  const nextUid = () => `int-test-${seq++}`;

  /** Full valid row (snake_case = table columns); JSON cols pre-stringified. */
  const fullRow = (over = {}) => ({
    uid: nextUid(),
    kind: "qa",
    parent_uid: "int-parent-1",
    guild_id: "g-log",
    channel_id: "c-log-1",
    message_id: "m-log-trigger",
    user_id: "u-asker",
    status: "shipped",
    started_at: 1757000000000,
    duration_ms: 4321,
    model: "test-model",
    params: JSON.stringify({ temperature: 0.5, max_tokens: 500, timeout_ms: 60000 }),
    tools: JSON.stringify([{ type: "function", function: { name: "web_search" } }]),
    settings: JSON.stringify({ gork_keyword: "@gork", gork_context_window: 10 }),
    system_prompt: "SYSTEM PROMPT EXACT TEXT",
    user_prompt: "composed user content EXACT TEXT",
    trigger_content: "@gork what did I ask earlier?",
    reply_to_message_id: "m-log-referenced",
    context_meta: JSON.stringify({ mode: "fetch", collected: 2, chars: 24 }),
    context_messages: JSON.stringify([
      { id: "m-old-1", authorId: "u-other", content: "prior chatter", timestamp: 1757000000 },
    ]),
    roster_meta: JSON.stringify({ entries: 1, truncated: 0 }),
    roster_block: "- Alice (@alice)",
    roster_entries: JSON.stringify([
      { id: "u-other", display: "Alice", handle: "alice", nickname: null },
    ]),
    memory_meta: null,
    transcript: JSON.stringify({ events: [{ type: "request", payload: {} }], truncated: false }),
    answer_raw: "raw model answer",
    answer_shipped: "shipped answer",
    finish_reason: "stop",
    usage: JSON.stringify({ total_tokens: 77 }),
    tool_call_count: 1,
    error: null,
    created_at: Date.now(),
    ...over,
  });

  const ALL_COLUMNS = [
    "uid", "kind", "parent_uid", "guild_id", "channel_id", "message_id",
    "user_id", "status", "started_at", "duration_ms", "model", "params",
    "tools", "settings", "system_prompt", "user_prompt", "trigger_content",
    "reply_to_message_id", "context_meta", "context_messages", "roster_meta",
    "roster_block", "roster_entries", "memory_meta", "transcript",
    "answer_raw", "answer_shipped", "finish_reason", "usage",
    "tool_call_count", "error", "created_at",
  ];

  it("migration 027 is registered after 026 and re-runs cleanly", () => {
    const { migrations, runMigrations } = require("../src/db/migrate");
    const i27 = migrations.findIndex((m) => m.id === "027_gork_interaction_log");
    const i26 = migrations.findIndex((m) => m.id === "026_gork_budget");
    assert.ok(i27 >= 0, "027_gork_interaction_log must be registered in migrate.js");
    assert.ok(i26 >= 0 && i27 > i26, "027 must be registered right after 026");
    assert.doesNotThrow(() => runMigrations(), "027 up() must be idempotent");
  });

  it("creates gork_interactions with all spec columns and the 5 indexes", () => {
    const table = api.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='gork_interactions'`)
      .get();
    assert.ok(table, "gork_interactions table must exist");
    const cols = api.db.prepare(`PRAGMA table_info(gork_interactions)`).all();
    assert.deepEqual(
      cols.map((c) => c.name),
      ["id", ...ALL_COLUMNS],
      "table must carry exactly the id + the 32 spec columns"
    );
    const uniqueUid = api.db
      .prepare(`PRAGMA index_list(gork_interactions)`)
      .all()
      .some((idx) => idx.unique === 1 &&
        api.db.prepare(`PRAGMA index_info(${idx.name})`).all().some((c) => c.name === "uid"));
    assert.ok(uniqueUid, "uid must be UNIQUE");
    const indexes = api.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_gork_interactions%'`
      )
      .all()
      .map((r) => r.name)
      .sort();
    assert.deepEqual(indexes, [
      "idx_gork_interactions_created", // retention prune scan (created_at < cutoff)
      "idx_gork_interactions_guild",
      "idx_gork_interactions_kind",
      "idx_gork_interactions_msg",
      "idx_gork_interactions_uid",
    ]);
  });

  it("guild_settings.gork_interaction_log_enabled: default 1, on/off via updateGuildSettings", () => {
    const g = "g-log-settings";
    assert.equal(api.getGuildSettings(g).gork_interaction_log_enabled, 1, "default ON");
    assert.equal(
      api.updateGuildSettings(g, { gork_interaction_log_enabled: "off" }).gork_interaction_log_enabled,
      0
    );
    assert.equal(
      api.updateGuildSettings(g, { gork_interaction_log_enabled: true }).gork_interaction_log_enabled,
      1
    );
    assert.equal(
      api.updateGuildSettings(g, { gork_interaction_log_enabled: 0 }).gork_interaction_log_enabled,
      0
    );
  });

  it("insert round-trips every column (JSON blobs stored verbatim)", () => {
    const row = fullRow({ created_at: 1757000001234 });
    const res = api.insertGorkInteraction(row, { retentionDays: 0 });
    assert.equal(res.ok, true);
    assert.ok(Number.isInteger(res.id), "id must be the integer rowid");
    const stored = api.getGorkInteractionByUid(row.uid);
    assert.ok(stored);
    assert.equal(stored.id, res.id);
    for (const col of ALL_COLUMNS) {
      assert.deepEqual(stored[col], row[col], `column ${col} must round-trip`);
    }
  });

  it("insert normalizes defaults: kind 'qa', tool_call_count 0, created_at stamped, absent cols null", () => {
    const row = {
      uid: nextUid(),
      guild_id: "g-log-min",
      channel_id: "c-min",
      message_id: "m-min",
      user_id: "u-min",
      status: "failure",
      started_at: 1757000000000,
      error: "HTTP 500",
    };
    const res = api.insertGorkInteraction(row);
    assert.equal(res.ok, true);
    const stored = api.getGorkInteractionByUid(row.uid);
    assert.equal(stored.kind, "qa", "kind defaults to qa");
    assert.equal(stored.tool_call_count, 0, "tool_call_count defaults to 0");
    assert.ok(Math.abs(stored.created_at - Date.now()) < 5000, "created_at stamped server-side");
    assert.equal(stored.duration_ms, null);
    assert.equal(stored.params, null);
    assert.equal(stored.transcript, null);
    assert.equal(stored.model, null);
    assert.equal(stored.parent_uid, null);
    assert.equal(stored.error, "HTTP 500");
  });

  it("insert never throws: missing columns, garbage binds, and duplicate uid → {ok:false}", () => {
    let garbage;
    const lines = captureConsole(() => {
      garbage = api.insertGorkInteraction({});
    });
    assert.equal(garbage.ok, false);
    assert.equal(typeof garbage.error, "string");
    assert.ok(
      lines.some((l) => l.startsWith("[gork] interaction log insert failed:")),
      "failure is logged with the [gork] prefix"
    );

    const dupRow = fullRow();
    assert.equal(api.insertGorkInteraction(dupRow, { retentionDays: 0 }).ok, true);
    let dupRes;
    captureConsole(() => {
      dupRes = api.insertGorkInteraction(fullRow({ uid: dupRow.uid }));
    });
    assert.equal(dupRes.ok, false, "uid is UNIQUE");

    let objUid;
    captureConsole(() => {
      objUid = api.insertGorkInteraction(fullRow({ uid: { evil: true } }));
    });
    assert.equal(objUid.ok, false, "un-bindable garbage degrades to {ok:false}, never throws");

    // garbage created_at is treated as "omitted" and stamped — insert succeeds
    const stamp = api.insertGorkInteraction(fullRow({ guild_id: "g-log-stamp", created_at: {} }));
    assert.equal(stamp.ok, true, "garbage created_at normalizes to the server stamp");
  });

  it("listGorkInteractions: summaries only, newest-first, limit, kind, beforeId", () => {
    const g = "g-log-list";
    const other = "g-log-list-other";
    const rowA = fullRow({ guild_id: g });
    const rowB = fullRow({ guild_id: g, kind: "memory_turn" });
    const rowC = fullRow({ guild_id: g });
    for (const row of [rowA, rowB, rowC]) {
      assert.equal(api.insertGorkInteraction(row, { retentionDays: 0 }).ok, true);
    }
    api.insertGorkInteraction(fullRow({ guild_id: other }), { retentionDays: 0 });

    const rows = api.listGorkInteractions({ guildId: g });
    assert.equal(rows.length, 3, "guild-scoped");
    assert.deepEqual(
      Object.keys(rows[0]).sort(),
      ["channel_id", "created_at", "duration_ms", "error", "id", "kind",
        "message_id", "model", "status", "tool_call_count", "uid", "user_id"],
      "summary projection exactly"
    );
    for (const blob of ["system_prompt", "user_prompt", "transcript", "params",
      "context_messages", "settings", "tools", "answer_shipped"]) {
      assert.equal(blob in rows[0], false, `${blob} blob column must stay out of summaries`);
    }
    assert.deepEqual(rows.map((r) => r.uid), [rowC.uid, rowB.uid, rowA.uid], "newest-first");

    assert.deepEqual(
      api.listGorkInteractions({ guildId: g, kind: "memory_turn" }).map((r) => r.uid),
      [rowB.uid]
    );
    assert.equal(api.listGorkInteractions({ guildId: g, limit: 2 }).length, 2);
    assert.deepEqual(
      api.listGorkInteractions({ guildId: g, beforeId: rows[0].id }).map((r) => r.uid),
      [rowB.uid, rowA.uid],
      "beforeId (row id) is exclusive"
    );
    assert.deepEqual(api.listGorkInteractions({ guildId: "g-log-none" }), [], "empty guild → []");
  });

  it("getGorkInteractionByUid returns the full row incl. transcript; missing/garbage → null", () => {
    const row = fullRow({ guild_id: "g-log-get" });
    api.insertGorkInteraction(row, { retentionDays: 0 });
    const stored = api.getGorkInteractionByUid(row.uid);
    assert.equal(stored.transcript, row.transcript, "transcript must come back verbatim");
    assert.equal(stored.system_prompt, row.system_prompt);
    assert.equal(stored.roster_entries, row.roster_entries);
    assert.equal(api.getGorkInteractionByUid("int-nope"), null);
    assert.equal(api.getGorkInteractionByUid(""), null);
    assert.equal(api.getGorkInteractionByUid(), null, "missing uid never throws");
  });

  it("countGorkInteractions: total + kind filter, 0 for empty/unknown guild", () => {
    const g = "g-log-count";
    api.insertGorkInteraction(fullRow({ guild_id: g }), { retentionDays: 0 });
    api.insertGorkInteraction(fullRow({ guild_id: g, kind: "memory_turn" }), { retentionDays: 0 });
    assert.equal(api.countGorkInteractions(g), 2);
    assert.equal(api.countGorkInteractions(g, { kind: "memory_turn" }), 1);
    assert.equal(api.countGorkInteractions(g, { kind: "qa" }), 1);
    assert.equal(api.countGorkInteractions("g-log-count-none"), 0);
    assert.equal(api.countGorkInteractions(""), 0, "garbage guild never throws");
  });

  it("pruneGorkInteractions deletes exactly rows older than the cutoff", () => {
    const g = "g-log-prune";
    const old = fullRow({ guild_id: g, created_at: Date.now() - 10 * DAY });
    const fresh = fullRow({ guild_id: g });
    api.insertGorkInteraction(old, { retentionDays: 0 });
    api.insertGorkInteraction(fresh, { retentionDays: 0 });

    assert.equal(api.pruneGorkInteractions(Date.now() - 5 * DAY), 1, "one row older than cutoff");
    assert.equal(api.getGorkInteractionByUid(old.uid), null);
    assert.ok(api.getGorkInteractionByUid(fresh.uid), "recent row survives");
    assert.equal(api.pruneGorkInteractions(Date.now() - 5 * DAY), 0, "second prune with the same cutoff is a no-op");
    assert.equal(api.pruneGorkInteractions("garbage"), 0, "non-finite cutoff is a no-op");
    assert.ok(api.getGorkInteractionByUid(fresh.uid), "garbage prune deleted nothing");
  });

  it("lazy retention prune on insert: default 30d window", () => {
    const g = "g-log-retention-default";
    const staleRow = fullRow({ guild_id: g, created_at: Date.now() - 40 * DAY });
    api.insertGorkInteraction(staleRow, { retentionDays: 0 });
    assert.ok(api.getGorkInteractionByUid(staleRow.uid), "stale row staged (prune disabled)");

    const freshRow = fullRow({ guild_id: g });
    assert.equal(api.insertGorkInteraction(freshRow).ok, true, "default retentionDays applies");
    assert.equal(api.getGorkInteractionByUid(staleRow.uid), null, "40d-old row pruned by the next insert");
    assert.ok(api.getGorkInteractionByUid(freshRow.uid), "the fresh insert itself survives");
    assert.equal(api.countGorkInteractions(g), 1);
  });

  it("lazy retention prune: explicit small window prunes, retentionDays 0 keeps forever", () => {
    const g = "g-log-retention-explicit";
    const d10 = fullRow({ guild_id: g, created_at: Date.now() - 10 * DAY });
    const d2 = fullRow({ guild_id: g, created_at: Date.now() - 2 * DAY });
    api.insertGorkInteraction(d10, { retentionDays: 0 });
    api.insertGorkInteraction(fullRow({ guild_id: g }), { retentionDays: 3 });
    assert.equal(api.getGorkInteractionByUid(d10.uid), null, "10d-old row pruned by a 3d window");

    api.insertGorkInteraction(d2, { retentionDays: 0 });
    api.insertGorkInteraction(fullRow({ guild_id: g }), { retentionDays: 0 });
    assert.ok(api.getGorkInteractionByUid(d2.uid), "retentionDays 0 prunes nothing");
  });

  it("deleteGorkInteractionsForGuild: boolean result, guild-scoped", () => {
    const g = "g-log-del";
    const other = "g-log-del-other";
    api.insertGorkInteraction(fullRow({ guild_id: g }), { retentionDays: 0 });
    api.insertGorkInteraction(fullRow({ guild_id: g, kind: "memory_turn" }), { retentionDays: 0 });
    api.insertGorkInteraction(fullRow({ guild_id: other }), { retentionDays: 0 });

    assert.equal(api.deleteGorkInteractionsForGuild(g), true);
    assert.equal(api.countGorkInteractions(g), 0);
    assert.equal(api.deleteGorkInteractionsForGuild(g), false, "second delete is a no-op");
    assert.equal(api.countGorkInteractions(other), 1, "other guild untouched");
    assert.equal(api.deleteGorkInteractionsForGuild(""), false, "garbage guild never throws");
  });

  it("reads never throw on garbage: [] / 0 no matter what", () => {
    assert.deepEqual(api.listGorkInteractions(), []);
    assert.ok(
      api.listGorkInteractions({ guildId: "g-log-list", limit: "abc" }).length <= 20,
      "garbage limit falls back to the 20 default"
    );
    assert.equal(api.pruneGorkInteractions(NaN), 0);
  });
});

// ---------- ai.js onEvent capture seam (no DB, no network) ----------

describe("ai.js onEvent capture seam", () => {
  const AI_CFG = { apiKey: "test-key", baseUrl: "https://ai.example/v1", model: "test-model" };

  const providerBody = (message) => ({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "test",
    choices: [{ index: 0, message, finish_reason: "stop" }],
    usage: { total_tokens: 42 },
  });

  /** Fake provider fetch capturing the RAW body string sent on the wire. */
  function okFetch(scripted) {
    const calls = [];
    const impl = async (url, init) => {
      calls.push({ url, rawBody: init.body, body: JSON.parse(init.body) });
      const step =
        typeof scripted === "function"
          ? scripted(calls.length - 1)
          : (scripted[calls.length - 1] ?? scripted[scripted.length - 1]);
      return { ok: true, status: 200, json: async () => providerBody(step) };
    };
    return { impl, calls };
  }

  const toolCall = (id, query) => ({
    id,
    type: "function",
    function: { name: "web_search", arguments: JSON.stringify({ query }) },
  });

  const collect = () => {
    const events = [];
    return { events, onEvent: (e) => events.push(e) };
  };

  it("chatCompletion: request event = exact wire body (before fetch), then response with data", async () => {
    const { events, onEvent } = collect();
    let rawBodyAtFetch = null;
    let requestsAtFetchTime = -1;
    const impl = async (url, init) => {
      rawBodyAtFetch = init.body;
      requestsAtFetchTime = events.filter((e) => e.type === "request").length;
      return { ok: true, status: 200, json: async () => providerBody({ content: "pong" }) };
    };
    const res = await chatCompletion(AI_CFG, {
      messages: [{ role: "user", content: "ping" }],
      temperature: 0.3,
      maxTokens: 64,
      fetchImpl: impl,
      onEvent,
    });
    assert.ok(res.ok);
    assert.equal(res.content, "pong");
    assert.equal(requestsAtFetchTime, 1, "request event fired BEFORE the HTTP attempt");
    assert.deepEqual(events.map((e) => e.type), ["request", "response"]);

    const [req, resp] = events;
    assert.deepEqual(req.payload, {
      model: "test-model",
      messages: [{ role: "user", content: "ping" }],
      temperature: 0.3,
      max_tokens: 64,
    }, "payload equals the wire body field-by-field — onEvent never leaks in");
    assert.equal(JSON.stringify(req.payload), rawBodyAtFetch, "event payload IS the serialized wire body");

    assert.equal(resp.ok, true);
    assert.deepEqual(resp.data, providerBody({ content: "pong" }), "raw parsed body on success");
    assert.equal(resp.finishReason, "stop");
    assert.deepEqual(resp.usage, { total_tokens: 42 });
    assert.ok(Number.isFinite(resp.durationMs) && resp.durationMs >= 0);
  });

  it("chatCompletion: HTTP/network/empty failures emit ok:false response events without body", async () => {
    const { events, onEvent } = collect();
    const http = await chatCompletion(AI_CFG, {
      messages: [{ role: "user", content: "x" }],
      fetchImpl: async () => ({ ok: false, status: 429 }),
      onEvent,
    });
    assert.ok(!http.ok);
    const resp = events[1];
    assert.deepEqual(resp.type, "response");
    assert.equal(resp.ok, false);
    assert.equal(resp.status, 429);
    assert.equal(resp.reason, "http");
    assert.equal(resp.error, "HTTP 429");
    assert.equal("data" in resp, false, "failed responses omit the body to keep rows small");

    const net = await chatCompletion(AI_CFG, {
      messages: [{ role: "user", content: "x" }],
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
      onEvent,
    });
    assert.ok(!net.ok);
    const netResp = events[3];
    assert.equal(netResp.ok, false);
    assert.equal(netResp.status, null);
    assert.equal(netResp.reason, "network");
    assert.equal(netResp.error, "ECONNREFUSED");

    const empty = await chatCompletion(AI_CFG, {
      messages: [{ role: "user", content: "x" }],
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) }),
      onEvent,
    });
    assert.ok(!empty.ok);
    assert.equal(empty.reason, "empty");
    const emptyResp = events[5];
    assert.equal(emptyResp.ok, false);
    assert.equal(emptyResp.reason, "empty");
    assert.equal("data" in emptyResp, false);
  });

  it("chatWithTools: in-order round-tagged request→response→tool events across rounds", async () => {
    const { events, onEvent } = collect();
    const { impl, calls } = okFetch([
      { tool_calls: [toolCall("c1", "alpha")] },
      { tool_calls: [toolCall("c2", "beta")] },
      { content: "final answer" },
    ]);
    const res = await chatWithTools(AI_CFG, {
      messages: [{ role: "user", content: "q" }],
      tools: [{ type: "function", function: { name: "web_search" } }],
      executeTool: async (name, args) => `res:${args.query}`,
      maxToolRounds: 3,
      fetchImpl: impl,
      onEvent,
    });
    assert.ok(res.ok);
    assert.equal(res.content, "final answer");
    assert.equal(res.toolCalls, 2);
    assert.deepEqual(
      events.map((e) => `${e.type}:${e.round}`),
      [
        "request:0", "response:0", "tool:0",
        "request:1", "response:1", "tool:1",
        "request:2", "response:2",
      ],
      "every event is round-tagged and in causal order"
    );
    const tool0 = events.find((e) => e.type === "tool");
    assert.equal(tool0.name, "web_search");
    assert.deepEqual(tool0.args, { query: "alpha" });
    assert.equal(tool0.output, "res:alpha");
    assert.equal(tool0.ok, true);
    assert.ok(Number.isFinite(tool0.durationMs));
    assert.deepEqual(
      events[3].payload.messages.map((m) => m.role),
      calls[1].body.messages.map((m) => m.role),
      "round 1 request snapshot equals the actual wire conversation"
    );
    assert.equal(events[1].data.choices[0].message.tool_calls.length, 1);
    assert.equal(events[7].data.choices[0].message.content, "final answer");
  });

  it("chatWithTools: tool event ok:false + failure output when executeTool throws, loop unaffected", async () => {
    const { events, onEvent } = collect();
    const { impl } = okFetch([
      { tool_calls: [toolCall("c1", "x")] },
      { content: "still answered" },
    ]);
    const res = await chatWithTools(AI_CFG, {
      messages: [{ role: "user", content: "q" }],
      tools: [{ type: "function", function: { name: "web_search" } }],
      executeTool: async () => {
        throw new Error("boom");
      },
      maxToolRounds: 2,
      fetchImpl: impl,
      onEvent,
    });
    assert.ok(res.ok, "the model still gets the failure string and answers");
    assert.equal(res.content, "still answered");
    const tool = events.find((e) => e.type === "tool");
    assert.equal(tool.ok, false);
    assert.equal(tool.output, 'tool "web_search" failed: boom');
    assert.equal(tool.round, 0);
  });

  it("a throwing sink never breaks chatWithTools — every sink call is wrapped and warned", async () => {
    const warns = [];
    const realWarn = console.warn;
    console.warn = (...args) => warns.push(args.map(String).join(" "));
    let res;
    try {
      const { impl } = okFetch([
        { tool_calls: [toolCall("c1", "x")] },
        { content: "survived" },
      ]);
      res = await chatWithTools(AI_CFG, {
        messages: [{ role: "user", content: "q" }],
        tools: [{ type: "function", function: { name: "web_search" } }],
        executeTool: async () => "r",
        maxToolRounds: 2,
        fetchImpl: impl,
        onEvent: () => {
          throw new Error("sink exploded");
        },
      });
    } finally {
      console.warn = realWarn;
    }
    assert.ok(res.ok);
    assert.equal(res.content, "survived");
    assert.equal(res.toolCalls, 1);
    assert.equal(warns.length, 5, "one warn per swallowed sink failure (req0 resp0 tool0 req1 resp1)");
    for (const w of warns) {
      assert.ok(w.startsWith("[ai] interaction event failed:"), `warn carries the fixed prefix: ${w}`);
    }
  });

  it("onEvent absent = zero behavior/wire change (identical bodies and results)", async () => {
    const script = [
      { tool_calls: [toolCall("c1", "x")] },
      { content: "same" },
    ];
    const withSink = okFetch(script);
    const resA = await chatWithTools(AI_CFG, {
      messages: [{ role: "user", content: "q" }],
      tools: [{ type: "function", function: { name: "web_search" } }],
      executeTool: async () => "r",
      fetchImpl: withSink.impl,
      onEvent: () => {},
    });
    const plain = okFetch(script);
    const resB = await chatWithTools(AI_CFG, {
      messages: [{ role: "user", content: "q" }],
      tools: [{ type: "function", function: { name: "web_search" } }],
      executeTool: async () => "r",
      fetchImpl: plain.impl,
    });
    assert.deepEqual(plain.calls.map((c) => c.body), withSink.calls.map((c) => c.body),
      "wire payloads identical with and without the seam");
    assert.deepEqual(
      { ok: resB.ok, content: resB.content, toolCalls: resB.toolCalls, finishReason: resB.finishReason },
      { ok: true, content: "same", toolCalls: 1, finishReason: "stop" }
    );
    assert.equal(resA.content, resB.content);

    const solo = await chatCompletion(AI_CFG, {
      messages: [{ role: "user", content: "ping" }],
      fetchImpl: okFetch([{ content: "pong" }]).impl,
    });
    assert.ok(solo.ok);
    assert.equal(solo.content, "pong", "chatCompletion untouched without onEvent");
  });
});

// ---------- interaction log recorder (fake repo, no DB, no network) ----------

const IL_ENV_KEYS = [
  "GORK_INTERACTION_LOG",
  "GORK_INTERACTION_LOG_RETENTION_DAYS",
  "GORK_INTERACTION_LOG_MAX_JSON_CHARS",
];

/**
 * Run `fn` with the interaction-log env keys replaced by `over` (keys not in
 * `over` are deleted for the duration, so ambient env can't leak in).
 */
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

/** Recorder with a fake repo + fixed clock (injectable via `over`). */
function makeRecorder(over = {}) {
  const repo = fakeRepo();
  const recorder = createInteractionRecorder({
    kind: "qa",
    guildId: "guild-rec",
    channelId: "chan-rec",
    messageId: "msg-rec",
    userId: "user-rec",
    startedAt: 1757000000000,
    now: () => 1757000005000,
    repo,
    ...over,
  });
  return { recorder, repo };
}

describe("interaction log recorder — config env parsing", () => {
  it("defaults when env unset: enabled, retentionDays 30, maxJsonChars 200000", () => {
    withEnv({}, () => {
      assert.deepEqual(interactionLogConfig(), {
        enabled: true,
        retentionDays: 30,
        maxJsonChars: DEFAULT_MAX_JSON_CHARS,
      });
    });
  });

  it('GORK_INTERACTION_LOG "0" kills capture; anything else stays enabled', () => {
    withEnv({ GORK_INTERACTION_LOG: "0" }, () => {
      assert.equal(interactionLogConfig().enabled, false);
    });
    for (const value of ["1", "off", "yes", " "]) {
      withEnv({ GORK_INTERACTION_LOG: value }, () => {
        assert.equal(interactionLogConfig().enabled, true, `"${value}" ≠ kill`);
      });
    }
  });

  it("retention days: '7' → 7, '0' → 0 (forever), garbage/negative → default 30", () => {
    withEnv({ GORK_INTERACTION_LOG_RETENTION_DAYS: "7" }, () => {
      assert.equal(interactionLogConfig().retentionDays, 7);
    });
    withEnv({ GORK_INTERACTION_LOG_RETENTION_DAYS: "0" }, () => {
      assert.equal(interactionLogConfig().retentionDays, 0);
    });
    for (const value of ["abc", "-2", ""]) {
      withEnv({ GORK_INTERACTION_LOG_RETENTION_DAYS: value }, () => {
        assert.equal(interactionLogConfig().retentionDays, 30, `"${value}" → default`);
      });
    }
  });

  it("max json chars: parsed positive int, garbage/0 → default", () => {
    withEnv({ GORK_INTERACTION_LOG_MAX_JSON_CHARS: "5000" }, () => {
      assert.equal(interactionLogConfig().maxJsonChars, 5000);
    });
    for (const value of ["abc", "0", "-10", ""]) {
      withEnv({ GORK_INTERACTION_LOG_MAX_JSON_CHARS: value }, () => {
        assert.equal(interactionLogConfig().maxJsonChars, DEFAULT_MAX_JSON_CHARS);
      });
    }
  });

  it("env is re-read per call (override without restart)", () => {
    withEnv({}, () => {
      assert.equal(interactionLogConfig().enabled, true);
      process.env.GORK_INTERACTION_LOG = "0";
      assert.equal(interactionLogConfig().enabled, false, "read per call");
    });
  });
});

describe("interaction log recorder — enable matrix", () => {
  it("guild column drives when env allows: absent default 1, explicit 0 blocks", () => {
    withEnv({}, () => {
      assert.equal(isInteractionLogEnabled(undefined), true);
      assert.equal(isInteractionLogEnabled({}), true, "absent column defaults ON");
      assert.equal(isInteractionLogEnabled({ gork_interaction_log_enabled: 1 }), true);
      assert.equal(isInteractionLogEnabled({ gork_interaction_log_enabled: true }), true);
      assert.equal(isInteractionLogEnabled({ gork_interaction_log_enabled: 0 }), false);
      assert.equal(isInteractionLogEnabled({ gork_interaction_log_enabled: "0" }), false);
      assert.equal(isInteractionLogEnabled({ gork_interaction_log_enabled: "off" }), false);
    });
  });

  it("env kill-switch takes precedence over the guild column", () => {
    withEnv({ GORK_INTERACTION_LOG: "0" }, () => {
      assert.equal(isInteractionLogEnabled({ gork_interaction_log_enabled: 1 }), false);
      assert.equal(isInteractionLogEnabled(undefined), false);
    });
  });
});

describe("interaction log recorder — buildSettingsSnapshot", () => {
  it("maps the prompt-relevant settings and normalizes flags/rules", () => {
    assert.deepEqual(
      buildSettingsSnapshot({
        gork_keyword: "@gork",
        gork_context_window: 7,
        gork_cooldown_sec: 12,
        gork_search_enabled: 1,
        gork_memory_enabled: 0,
        gork_extra_rules: "Be kind.",
        gork_interaction_log_enabled: 0,
        xp_cooldown_sec: 30, // unrelated settings stay out
      }),
      {
        gork_keyword: "@gork",
        gork_context_window: 7,
        gork_cooldown_sec: 12,
        gork_search_enabled: 1,
        gork_memory_enabled: 0,
        gork_extra_rules: "Be kind.",
        gork_interaction_log_enabled: 0,
      },
    );
  });

  it("blank rules → null; missing settings → defaults (log enabled 1)", () => {
    const snap = buildSettingsSnapshot({ gork_keyword: "gork", gork_extra_rules: "   " });
    assert.equal(snap.gork_extra_rules, null);
    assert.equal(snap.gork_interaction_log_enabled, 1);
    assert.equal(snap.gork_context_window, null);
    assert.deepEqual(buildSettingsSnapshot(null), {
      gork_keyword: null,
      gork_context_window: null,
      gork_cooldown_sec: null,
      gork_search_enabled: null,
      gork_memory_enabled: null,
      gork_extra_rules: null,
      gork_interaction_log_enabled: 1,
    });
  });
});

describe("interaction log recorder — capture", () => {
  it("uid defaults to a v4 uuid; an injected uid wins", () => {
    const a = makeRecorder();
    assert.match(
      a.recorder.uid,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const b = makeRecorder({ uid: "custom-uid" });
    assert.equal(b.recorder.uid, "custom-uid");
  });

  it("snapshots events immediately: later mutation of the caller object cannot rewrite history", () => {
    const { recorder, repo } = makeRecorder();
    const evt = { type: "request", payload: { messages: [{ role: "user", content: "before" }] } };
    recorder.onEvent(evt);
    evt.payload.messages[0].content = "after"; // chatWithTools-style reuse
    evt.type = "mutated";
    recorder.finalize({ status: "shipped" });
    const t = JSON.parse(repo.calls[0].row.transcript);
    assert.equal(t.events.length, 1);
    assert.equal(t.events[0].type, "request", "type captured before mutation");
    assert.equal(t.events[0].payload.messages[0].content, "before", "content captured before mutation");
    assert.equal(t.truncated, false);
  });

  it("caps strings at EVENT_STRING_CAP (marker keeps truncation visible), nested deep", () => {
    const { recorder, repo } = makeRecorder();
    const huge = "x".repeat(EVENT_STRING_CAP + 5000);
    recorder.onEvent({
      type: "tool",
      name: "read_page",
      output: huge,
      args: { urls: [huge] },
    });
    recorder.finalize({ status: "shipped" });
    const t = JSON.parse(repo.calls[0].row.transcript);
    const out = t.events[0].output;
    assert.ok(out.length <= EVENT_STRING_CAP + STRING_CAP_MARKER.length + 1, "capped length");
    assert.ok(out.startsWith("x".repeat(100)) && out.endsWith(STRING_CAP_MARKER), "prefix kept + marker");
    assert.equal(t.events[0].args.urls[0].length, EVENT_STRING_CAP + STRING_CAP_MARKER.length);
  });

  it("caps the event LIST at 64: oldest dropped, truncated flagged", () => {
    const { recorder, repo } = makeRecorder();
    for (let i = 0; i < MAX_EVENTS + 10; i += 1) recorder.onEvent({ type: "tool", tag: `e${i}`, output: "r" });
    recorder.finalize({ status: "shipped" });
    const t = JSON.parse(repo.calls[0].row.transcript);
    assert.equal(t.events.length, MAX_EVENTS, "event list capped");
    assert.equal(t.truncated, true, "overflow flagged");
    assert.equal(t.events[0].tag, "e10", "oldest dropped first");
    assert.equal(t.events[t.events.length - 1].tag, `e${MAX_EVENTS + 9}`, "newest kept");
  });

  it("a circular/unsnapshotable event degrades instead of throwing", () => {
    const { recorder, repo } = makeRecorder();
    const evil = { type: "response", ok: true };
    evil.self = evil;
    recorder.onEvent(evil);
    assert.doesNotThrow(() => recorder.finalize({ status: "shipped" }));
    const t = JSON.parse(repo.calls[0].row.transcript);
    assert.equal(t.events[0].capture_failed, true, "slot kept and marked degraded");
  });
});

describe("interaction log recorder — finalize", () => {
  const fullOutcome = {
    status: "shipped",
    answerRaw: "raw text",
    answerShipped: "shipped text",
    finishReason: "stop",
    usage: { total_tokens: 77 },
    toolCallCount: 2,
    durationMs: 1234,
  };

  it("maps every option to its column: JSON columns stringified, undefined → null", () => {
    const { recorder, repo } = makeRecorder({
      kind: "memory_turn",
      parentUid: "qa-parent-1",
      question: "q?",
      triggerContent: "@gork q?",
      replyToMessageId: "msg-ref",
      model: "m-test",
      params: { temperature: 0.5 },
      tools: [{ type: "function", function: { name: "web_search" } }],
      settings: { gork_keyword: "@gork" },
      system: "SYSTEM",
      user: "USER",
      contextMeta: { mode: "prior", collected: 2, chars: 40 },
      contextMessages: [{ id: "m1", authorId: "u1", content: "hi", timestamp: 5 }],
      rosterMeta: { entries: 1, truncated: 0 },
      rosterBlock: "People in this conversation\nid | @u | U",
      rosterEntries: [{ id: "u1", display: "U", handle: "u", nickname: null }],
      memoryMeta: { mode: "none", indexed: 0, selectedIds: [], blockChars: 0 },
    });
    recorder.onEvent({ type: "request", payload: { model: "m-test" } });
    const res = recorder.finalize(fullOutcome);
    assert.deepEqual(res, { ok: true, id: 101 }, "repo result passed through");
    assert.equal(repo.calls.length, 1);
    const { row, opts } = repo.calls[0];
    assert.deepEqual(Object.keys(opts), ["retentionDays"], "retention passed per insert");
    assert.equal(opts.retentionDays, 30, "default retention from env config");

    assert.deepEqual(
      {
        uid: row.uid,
        kind: row.kind,
        parent_uid: row.parent_uid,
        guild_id: row.guild_id,
        channel_id: row.channel_id,
        message_id: row.message_id,
        user_id: row.user_id,
        status: row.status,
        started_at: row.started_at,
        duration_ms: row.duration_ms,
        created_at: row.created_at,
        model: row.model,
        system_prompt: row.system_prompt,
        user_prompt: row.user_prompt,
        trigger_content: row.trigger_content,
        reply_to_message_id: row.reply_to_message_id,
        roster_block: row.roster_block,
        answer_raw: row.answer_raw,
        answer_shipped: row.answer_shipped,
        finish_reason: row.finish_reason,
        tool_call_count: row.tool_call_count,
        error: row.error,
      },
      {
        uid: recorder.uid,
        kind: "memory_turn",
        parent_uid: "qa-parent-1",
        guild_id: "guild-rec",
        channel_id: "chan-rec",
        message_id: "msg-rec",
        user_id: "user-rec",
        status: "shipped",
        started_at: 1757000000000,
        duration_ms: 1234,
        created_at: 1757000005000,
        model: "m-test",
        system_prompt: "SYSTEM",
        user_prompt: "USER",
        trigger_content: "@gork q?",
        reply_to_message_id: "msg-ref",
        roster_block: "People in this conversation\nid | @u | U",
        answer_raw: "raw text",
        answer_shipped: "shipped text",
        finish_reason: "stop",
        tool_call_count: 2,
        error: null,
      },
    );
    // JSON columns arrive pre-stringified
    const jsonCols = [
      ["params", { temperature: 0.5 }],
      ["tools", [{ type: "function", function: { name: "web_search" } }]],
      ["settings", { gork_keyword: "@gork" }],
      ["context_meta", { mode: "prior", collected: 2, chars: 40 }],
      ["context_messages", [{ id: "m1", authorId: "u1", content: "hi", timestamp: 5 }]],
      ["roster_meta", { entries: 1, truncated: 0 }],
      ["roster_entries", [{ id: "u1", display: "U", handle: "u", nickname: null }]],
      ["memory_meta", { mode: "none", indexed: 0, selectedIds: [], blockChars: 0 }],
      ["usage", { total_tokens: 77 }],
    ];
    for (const [col, value] of jsonCols) {
      assert.equal(typeof row[col], "string", `${col} stringified`);
      assert.deepEqual(JSON.parse(row[col]), value, `${col} round-trip`);
    }
    // transcript structure per the contract
    const t = JSON.parse(row.transcript);
    assert.deepEqual(Object.keys(t).sort(), ["events", "truncated"]);
    assert.equal(t.truncated, false);
    assert.deepEqual(t.events[0], { type: "request", payload: { model: "m-test" } });
  });

  it("finalize({}) defaults: status 'error', count 0, everything else null", () => {
    const { recorder, repo } = makeRecorder({ uid: "rec-empty", startedAt: null, now: () => 111 });
    recorder.finalize({});
    const { row } = repo.calls[0];
    assert.equal(row.status, "error");
    assert.equal(row.tool_call_count, 0);
    assert.equal(row.duration_ms, null);
    assert.equal(row.model, null);
    assert.equal(row.system_prompt, null);
    assert.equal(row.params, null);
    assert.equal(row.memory_meta, null);
    assert.equal(row.usage, null);
    assert.equal(row.error, null);
    assert.equal(row.started_at, 111, "startedAt falls back to the injected clock");
    assert.equal(row.created_at, 111);
    assert.equal(row.parent_uid, null);
    assert.deepEqual(JSON.parse(row.transcript), { events: [], truncated: false });
  });

  it("is idempotent: the second finalize is a no-op and replays the first result", () => {
    const { recorder, repo } = makeRecorder();
    recorder.onEvent({ type: "request", payload: {} });
    const first = recorder.finalize({ status: "shipped" });
    const second = recorder.finalize({ status: "failure", error: "too late" });
    assert.deepEqual(second, first, "first result replayed");
    assert.equal(repo.calls.length, 1, "exactly one insert");
  });

  it("retentionDays: explicit option wins over env default", () => {
    withEnv({ GORK_INTERACTION_LOG_RETENTION_DAYS: "45" }, () => {
      const envDriven = makeRecorder();
      envDriven.recorder.finalize({ status: "shipped" });
      assert.equal(envDriven.repo.calls[0].opts.retentionDays, 45, "env drives default");
      const pinned = makeRecorder({ retentionDays: 0 });
      pinned.recorder.finalize({ status: "shipped" });
      assert.equal(pinned.repo.calls[0].opts.retentionDays, 0, "explicit override");
    });
  });

  it("transcript JSON is budgeted by dropping OLDEST events first", () => {
    const { recorder, repo } = makeRecorder({ maxJsonChars: 400 });
    for (const tag of ["e1", "e2", "e3", "e4"]) {
      recorder.onEvent({ type: "request", tag, payload: { x: "a".repeat(100) } });
    }
    recorder.finalize({ status: "shipped" });
    const raw = repo.calls[0].row.transcript;
    assert.ok(raw.length <= 400, `transcript within budget (${raw.length})`);
    const t = JSON.parse(raw);
    assert.equal(t.truncated, true, "budget drops flagged");
    const tags = t.events.map((e) => e.tag);
    assert.equal(tags[tags.length - 1], "e4", "newest survives");
    assert.equal(tags.includes("e1"), false, "oldest dropped first");
  });

  it("never throws into the caller: a throwing repo warns with the finalize prefix", () => {
    const boom = {
      insertGorkInteraction() {
        throw new Error("db on fire");
      },
    };
    const recorder = createInteractionRecorder({
      guildId: "g",
      channelId: "c",
      messageId: "m",
      userId: "u",
      repo: boom,
    });
    let res;
    const lines = captureConsole(() => {
      res = recorder.finalize({ status: "shipped" });
    }, "warn");
    assert.equal(res.ok, false);
    assert.equal(res.error, "db on fire");
    assert.ok(
      lines.some((l) => l.startsWith("[gork] interaction log finalize failed:")),
      "distinct finalize-failure warn: " + JSON.stringify(lines),
    );
  });
});
