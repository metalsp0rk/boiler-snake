/**
 * Unit tests for the PR 3 adapter delta "Inbound DM ingestion" (roadmap/bridge.md
 * §10.3 delta 1, KD 24):
 *
 *  - normalizeFluxerDmMessage: DM payloads → NormalizedDmMessage (exact shape).
 *  - createDmDispatcher (src/platform/fluxer/client.js): the opt-in consumer
 *    registry behind handle.onDmMessage — multiple consumers, per-listener
 *    fault isolation, unsubscribe.
 *  - The guild pipeline is untouched: guild payloads keep normalizing to
 *    NormalizedMessage and never reach the DM normalizer.
 *
 * SDK-free by construction: normalize.js is pure; client.js is required at
 * module scope ONLY (its SDK load lives inside the async factory, which these
 * tests never call — fluxer-sdk-import-guard contract). The DB is the shipped
 * temp-DB double (loadDb), because client.js pulls in the pipeline chain.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
// client.js pulls in src/bot/pipelines (→ features → db), so it needs it.
const { cleanup } = loadDb();

const {
  normalizeFluxerMessage,
  normalizeFluxerDmMessage,
} = require("../src/platform/fluxer/normalize");
// Requiring client.js is safe: the SDK is only referenced by a dynamic
// import() inside createFluxerHandle, which is never invoked here.
const { createDmDispatcher } = require("../src/platform/fluxer/client");
const { gatewayMessage } = require("./helpers/fluxer");

after(cleanup);

const TS_ISO = "2026-10-01T09:00:00.000Z";

/** DM MESSAGE_CREATE `d`: the guild message fixture with NO guild id. */
function dmD(overrides = {}) {
  return gatewayMessage({
    guild_id: undefined,
    id: "1554600000000005001",
    channel_id: "1554600000000005002",
    author: { id: "1554600000000005003", username: "staffy", bot: false },
    content: "!bridge connect B_7K2M9QXP 42",
    timestamp: TS_ISO,
    ...overrides,
  });
}

describe("platform/fluxer/normalize — normalizeFluxerDmMessage", () => {
  it("emits the NormalizedDmMessage shape for a DM fixture (exact keys, no community)", () => {
    const dm = normalizeFluxerDmMessage(
      { t: "MESSAGE_CREATE", d: dmD() },
      { instanceKey: "https://fluxer.test" },
    );
    assert.ok(dm, "a guildless payload with author must normalize to a DM");
    // EXACTLY the §10.3 typedef — no communityId, no guild fields, no extras.
    assert.deepEqual(Object.keys(dm).sort(), [
      "attachments",
      "authorId",
      "channelId",
      "content",
      "createdAt",
      "id",
      "instanceKey",
      "mentions",
      "platform",
    ]);
    assert.equal(dm.platform, "fluxer");
    assert.equal(dm.instanceKey, "https://fluxer.test");
    assert.equal(dm.channelId, "1554600000000005002");
    assert.equal(dm.id, "1554600000000005001");
    assert.equal(dm.authorId, "1554600000000005003");
    assert.equal(dm.content, "!bridge connect B_7K2M9QXP 42");
    assert.deepEqual(dm.mentions, { users: [], roles: [], channels: [] });
    assert.deepEqual(dm.attachments, []);
    assert.ok(dm.createdAt instanceof Date);
    assert.equal(dm.createdAt.getTime(), Date.parse(TS_ISO));
  });

  it("carries mentions and attachments on the DM shape", () => {
    const dm = normalizeFluxerDmMessage(
      {
        t: "MESSAGE_CREATE",
        d: dmD({
          mentions: [{ id: "9", username: "mention", bot: false }],
          mention_roles: ["10"],
          mention_channels: [{ id: "11", name: "general", type: 0 }],
          attachments: [{ id: "a1", filename: "note.txt", url: "https://cdn.test/note.txt" }],
        }),
      },
      { instanceKey: "f" },
    );
    assert.deepEqual(dm.mentions, { users: ["9"], roles: ["10"], channels: ["11"] });
    // DM attachments stay the typedef's { name, url } pair — nothing more.
    assert.deepEqual(dm.attachments, [
      { name: "note.txt", url: "https://cdn.test/note.txt" },
    ]);
  });

  it("defaults missing content to empty string and an unparseable timestamp to null", () => {
    const dm = normalizeFluxerDmMessage(
      { t: "MESSAGE_CREATE", d: dmD({ content: undefined, timestamp: "not-a-date" }) },
      { instanceKey: "f" },
    );
    assert.equal(dm.content, "");
    assert.equal(dm.createdAt, null);
  });

  it("returns null for GUILD payloads (guild traffic is not a DM)", () => {
    assert.equal(normalizeFluxerDmMessage({ t: "MESSAGE_CREATE", d: gatewayMessage() }, {}), null);
    assert.equal(
      normalizeFluxerDmMessage(
        { id: "1", channelId: "7", guildId: "99", author: { id: "5" } },
        { instanceKey: "f" },
      ),
      null,
      "the SDK camelCase guild shape is not a DM either",
    );
  });

  it("drops unusable payloads: missing id / channel / author, non-objects", () => {
    assert.equal(normalizeFluxerDmMessage({ t: "MESSAGE_CREATE", d: dmD({ id: undefined }) }), null);
    assert.equal(
      normalizeFluxerDmMessage({ t: "MESSAGE_CREATE", d: dmD({ channel_id: null }) }),
      null,
    );
    assert.equal(normalizeFluxerDmMessage({ t: "MESSAGE_CREATE", d: dmD({ author: null }) }), null);
    assert.equal(normalizeFluxerDmMessage(null), null);
    assert.equal(normalizeFluxerDmMessage("nope"), null);
  });

  it("keeps the guild drop for DMs: normalizeFluxerMessage behavior is unchanged", () => {
    // The pipeline gate story (KD 12/24): a DM never enters the guild shape.
    assert.equal(normalizeFluxerMessage({ t: "MESSAGE_CREATE", d: dmD() }, {}), null);
    // And a guild message keeps producing the guild shape untouched (fields the
    // shipped consumers read: identity, channel, author, parsePrefix).
    const out = normalizeFluxerMessage(
      { t: "MESSAGE_CREATE", d: gatewayMessage() },
      { instanceKey: "https://fluxer.test" },
    );
    assert.equal(out.platform, "fluxer");
    assert.equal(out.externalGuildId, "99");
    assert.equal(out.communityId, null, "community resolution stays the pipeline's job");
    assert.equal(out.channelId, "7");
    assert.equal(out.authorId, "5");
    assert.equal(out.parsePrefix, null);
  });
});

describe("platform/fluxer/client — createDmDispatcher (opt-in onDmMessage hook)", () => {
  it("delivers the NormalizedDmMessage to every registered consumer (identity-preserved)", async () => {
    const dispatcher = createDmDispatcher("https://fluxer.test");
    const dm = normalizeFluxerDmMessage({ t: "MESSAGE_CREATE", d: dmD() }, { instanceKey: "x" });

    const gotA = [];
    const gotB = [];
    dispatcher.register((m) => gotA.push(m));
    dispatcher.register(async (m) => {
      await Promise.resolve();
      gotB.push(m);
    });

    await dispatcher.emit(dm);
    assert.equal(gotA.length, 1);
    assert.equal(gotB.length, 1);
    assert.equal(gotA[0], dm, "consumers receive the exact normalized object");
    assert.equal(dispatcher.listenerCount(), 2, "multiple consumers are allowed");
  });

  it("isolates consumer failures: a throwing consumer never skips the next and logs the cause", async () => {
    const dispatcher = createDmDispatcher("inst-1");
    const lines = [];
    const orig = console.error;
    console.error = (...args) => lines.push(args.join(" "));
    try {
      let secondCalled = false;
      const dm = normalizeFluxerDmMessage({ t: "MESSAGE_CREATE", d: dmD() }, { instanceKey: "x" });
      dispatcher.register(() => {
        throw new Error("pairing table exploded");
      });
      dispatcher.register(() => {
        secondCalled = true;
      });

      // emit() itself must not reject (the gateway handler stays alive).
      await dispatcher.emit(dm);

      assert.equal(secondCalled, true, "the healthy consumer still ran");
      const failure = lines.filter((l) => l.includes("[fluxer] dm consumer failed:"));
      assert.equal(failure.length, 1, "exactly one consumer-failure log line");
      assert.ok(failure[0].includes("pairing table exploded"), "the specific cause is logged");
      assert.ok(failure[0].includes("inst-1"), "the instance key identifies the deployment");
    } finally {
      console.error = orig;
    }
  });

  it("isolates async rejections too (per-listener catch, not just sync throws)", async () => {
    const dispatcher = createDmDispatcher("inst-2");
    const lines = [];
    const orig = console.error;
    console.error = (...args) => lines.push(args.join(" "));
    try {
      dispatcher.register(async () => {
        throw new Error("async boom");
      });
      await dispatcher.emit({ id: "m1", authorId: "u1" });
      assert.equal(
        lines.filter((l) => l.includes("async boom")).length,
        1,
      );
    } finally {
      console.error = orig;
    }
  });

  it("supports unsubscribe and tolerates double-unsubscribe", async () => {
    const dispatcher = createDmDispatcher("inst-3");
    let hits = 0;
    const off = dispatcher.register(() => {
      hits += 1;
    });
    await dispatcher.emit({ id: "m1" });
    assert.equal(hits, 1);

    off();
    off(); // second call is a no-op
    await dispatcher.emit({ id: "m2" });
    assert.equal(hits, 1, "the unregistered consumer receives nothing more");
    assert.equal(dispatcher.listenerCount(), 0);
  });

  it("is inert with zero consumers: emit resolves and nothing is logged (non-bridge consumers unaffected)", async () => {
    const dispatcher = createDmDispatcher("inst-4");
    const lines = [];
    const orig = console.error;
    console.error = (...args) => lines.push(args.join(" "));
    try {
      await dispatcher.emit(normalizeFluxerDmMessage({ t: "MESSAGE_CREATE", d: dmD() }, {}));
      assert.equal(dispatcher.listenerCount(), 0);
      assert.equal(lines.length, 0, "a DM with no registered consumer is simply ignored");
    } finally {
      console.error = orig;
    }
  });

  it("rejects non-function registrations with a specific TypeError", () => {
    const dispatcher = createDmDispatcher("inst-5");
    assert.throws(
      () => dispatcher.register("bridge"),
      (err) => err instanceof TypeError && /onDmMessage: listener must be a function/.test(err.message),
    );
  });
});
