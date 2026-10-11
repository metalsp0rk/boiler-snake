/**
 * Gateway-listener crash net (audit C8, issue #185): every ordered pipeline
 * listener in bot/pipelines.js must (a) run `normalizeDiscordMessage` inside
 * a try/catch — it throws SYNCHRONOUSLY inside the gateway listener on bad
 * input, including its synchronous SQLite `ensureCommunity` insert, and a
 * throw there used to kill the whole process — and (b) attach its own
 * `.catch()` to the fire-and-forget pipeline promise.
 *
 * No gateway login: a fake client captures the registered listeners and the
 * test calls them directly.
 */
const { describe, it, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before src requires (pipelines pulls the feature graph,
// which opens SQLite at require time). Temp DB, isolated per run.
const { cleanup } = loadDb();
after(cleanup);

const { Events } = require("discord.js");
const { registerOrderedPipelines } = require("../src/bot/pipelines");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fake discord.js client recording every `on(event, handler)`. */
function createFakeClient() {
  const handlers = new Map();
  return {
    guilds: { cache: new Map() },
    on(event, handler) {
      handlers.set(event, handler);
    },
    handlers,
  };
}

/** Run fn with console.error captured; also fails the test on an escaped
 * process-level rejection (exactly the crash class this fix removes). */
async function withCapture(fn) {
  const orig = console.error;
  const logs = [];
  console.error = (...a) => logs.push(a.join(" "));
  const escapes = [];
  const onEscape = (reason) => escapes.push(reason?.message || String(reason));
  process.on("unhandledRejection", onEscape);
  try {
    await fn();
    await sleep(50); // let any fire-and-forget rejection surface
  } finally {
    console.error = orig;
    process.off("unhandledRejection", onEscape);
  }
  return { logs, escapes };
}

describe("registerOrderedPipelines dispatch guards (C8)", () => {
  it("registers guarded listeners for all five ordered events", () => {
    const client = createFakeClient();
    registerOrderedPipelines(client);
    for (const event of [
      Events.MessageCreate,
      Events.MessageReactionAdd,
      Events.MessageReactionRemove,
      Events.MessageUpdate,
      Events.MessageDelete,
    ]) {
      assert.equal(
        typeof client.handlers.get(event),
        "function",
        `missing listener for ${event}`,
      );
    }
  });

  it("MessageCreate: a synchronously throwing normalize is logged, not fatal", async () => {
    const client = createFakeClient();
    registerOrderedPipelines(client);
    const messageHandler = client.handlers.get(Events.MessageCreate);

    const { logs, escapes } = await withCapture(async () => {
      // normalizeDiscordMessage throws on non-objects (TypeError) and the
      // community insert throws on DB faults — same listener boundary.
      assert.doesNotThrow(() => messageHandler("not-a-message"));
      assert.doesNotThrow(() => messageHandler(undefined));
    });

    assert.deepEqual(escapes, [], "nothing may escape to the process net");
    const dropLogs = logs.filter((l) => l.includes("[MessageCreate] normalize failed"));
    assert.equal(dropLogs.length, 2, `expected both drops logged: ${JSON.stringify(logs)}`);
    assert.ok(dropLogs.every((l) => l.includes("message dropped")));
    assert.ok(dropLogs.some((l) => l.includes("normalizeDiscordMessage: message required")));
  });

  it("MessageUpdate / MessageDelete: same boundary on the other normalize sites", async () => {
    const client = createFakeClient();
    registerOrderedPipelines(client);

    const { logs, escapes } = await withCapture(async () => {
      assert.doesNotThrow(() => client.handlers.get(Events.MessageUpdate)(undefined, 42));
      assert.doesNotThrow(() => client.handlers.get(Events.MessageDelete)(null));
    });

    assert.deepEqual(escapes, []);
    assert.ok(logs.some((l) => l.includes("[MessageUpdate] normalize failed")));
    assert.ok(logs.some((l) => l.includes("[MessageDelete] normalize failed")));
  });

  it("MessageCreate: a well-formed guild-less message still flows through the pipeline", async () => {
    const client = createFakeClient();
    registerOrderedPipelines(client);

    const { logs, escapes } = await withCapture(async () => {
      client.handlers.get(Events.MessageCreate)({
        id: "111",
        content: "hello",
        author: { id: "222", bot: false },
        createdAt: new Date(),
      });
    });

    assert.deepEqual(escapes, []);
    assert.ok(
      !logs.some((l) => l.includes("normalize failed") || l.includes("pipeline rejected")),
      `clean message must not log faults: ${JSON.stringify(logs)}`,
    );
  });

  it("reaction listeners survive garbage input without reaching the process net", async () => {
    const client = createFakeClient();
    registerOrderedPipelines(client);

    const { logs, escapes } = await withCapture(async () => {
      // undefined reaction → sync TypeError inside the handler's own try:
      // logged by the pipeline, and the listener's .catch keeps it contained.
      assert.doesNotThrow(() =>
        client.handlers.get(Events.MessageReactionAdd)(undefined, undefined),
      );
      assert.doesNotThrow(() =>
        client.handlers.get(Events.MessageReactionRemove)(undefined, undefined),
      );
    });

    assert.deepEqual(escapes, []);
    assert.ok(logs.some((l) => l.includes("[ReactionAdd] error:")));
    assert.ok(logs.some((l) => l.includes("[ReactionRemove] error:")));
  });
});
