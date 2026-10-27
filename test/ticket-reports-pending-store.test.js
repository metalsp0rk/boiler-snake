/**
 * Pending-report TTL snapshot store unit tests (#745, locked decision 3).
 *
 * Fake-clock semantics via `createPendingReportStore({ now })` — the same seam
 * as the gork cooldown gate (no real 10-minute waits, no timers, and every
 * clock-shaped value derives from ONE forced instant per test/README.md #4–#5):
 * put→take round-trip with one-shot consume, unknown/malformed tokens, expiry
 * (inclusive at exactly the TTL), explicit and lazy sweep, token format and
 * uniqueness, and the put guards that answer null instead of throwing
 * (AGENTS.md error rule 6). The process-wide singleton runs on the real clock
 * with its *ForTests reset, plus a forced `{ now }` expiry.
 *
 * No DB, no sockets, no discord.js interactions — the store is pure in-memory
 * state (a restart clearing it IS the expired-token semantics).
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const pendingReports = require("../src/features/tickets/pendingReports");
const {
  PENDING_REPORT_TTL_MS,
  TOKEN_BYTES,
  REPORT_KINDS,
  createPendingReportStore,
  putReport,
  put,
  takeReport,
  take,
  sweepPendingReports,
  pendingReportCountForTests,
  resetPendingReportsForTests,
} = pendingReports;
const {
  MODAL_REPORT_MESSAGE_PREFIX,
  MODAL_REPORT_USER_PREFIX,
  MODAL_REPORT_FIELD_CONTEXT,
  MODAL_REPORT_FIELD_DELETE,
} = require("../src/features/tickets/constants");

const TTL = PENDING_REPORT_TTL_MS;

/** Forced instant: every clock-shaped value in this file derives from it. */
const T0 = Date.UTC(2026, 9, 26, 12, 0, 0);

/** Exactly locked decision 3's snapshot shape — 13 fields, nothing else. */
const SNAPSHOT_KEYS = [
  "kind",
  "guildId",
  "reporterUserId",
  "messageId",
  "channelId",
  "channelName",
  "authorId",
  "content",
  "attachments",
  "embedUrls",
  "stickers",
  "subjectUserId",
  "capturedAt",
];

/** Message-variant snapshot as the invoke handler (subtask 05) hands it in. */
function messageSnapshot(overrides = {}) {
  return {
    kind: REPORT_KINDS.MESSAGE,
    guildId: "1000",
    reporterUserId: "2000",
    messageId: "3000",
    channelId: "4000",
    channelName: "general",
    authorId: "5000",
    content: "read the rules or else",
    attachments: [
      {
        id: "7000",
        name: "proof.png",
        url: "https://cdn.example/proof.png",
        size: 1234,
        contentType: "image/png",
      },
    ],
    embedUrls: ["https://example.com/thread"],
    stickers: ["Wavecat"],
    subjectUserId: "5000",
    ...overrides,
  };
}

/** Mutable fake clock + a private store (same shape as the gork gate tests). */
function withClock(startMs = T0) {
  let nowMs = startMs;
  const store = createPendingReportStore({ now: () => nowMs });
  return { store, advance: (ms) => (nowMs += ms), at: () => nowMs };
}

describe("pending-report store: snapshot round-trip (decision 3)", () => {
  it("put→take returns the snapshot and consumes the token", () => {
    const { store } = withClock();
    const token = store.put(messageSnapshot());
    assert.ok(token, "a complete snapshot mints a token");

    const snap = store.take(token);
    assert.ok(snap);
    assert.equal(snap.kind, "message");
    assert.equal(snap.guildId, "1000");
    assert.equal(snap.reporterUserId, "2000");
    assert.equal(snap.messageId, "3000");
    assert.equal(snap.channelId, "4000");
    assert.equal(snap.channelName, "general");
    assert.equal(snap.authorId, "5000");
    assert.equal(snap.content, "read the rules or else");
    assert.deepEqual(snap.attachments, [
      {
        id: "7000",
        name: "proof.png",
        url: "https://cdn.example/proof.png",
        size: 1234,
        contentType: "image/png",
      },
    ]);
    assert.deepEqual(snap.embedUrls, ["https://example.com/thread"]);
    assert.deepEqual(snap.stickers, ["Wavecat"]);
    assert.equal(snap.subjectUserId, "5000");
    assert.equal(snap.capturedAt, T0, "capture time is the clock at put");
    assert.deepEqual(
      Object.keys(snap).sort(),
      [...SNAPSHOT_KEYS].sort(),
      "stored shape is exactly decision 3 — no extras, no byte fields",
    );

    assert.equal(store.take(token), null, "one-shot: the same token never reads twice");
    assert.equal(store.size(), 0, "the consumed entry leaves the store");
  });

  it("stores attachment METADATA only — bytes and foreign objects are dropped", () => {
    const { store } = withClock();
    const token = store.put(
      messageSnapshot({
        attachments: [
          {
            id: "1",
            name: "a.png",
            url: "https://cdn.example/a.png",
            size: 10,
            contentType: "image/png",
            // What a live discord.js Attachment carries beyond metadata: none
            // of this may survive the store (decision 3 — bytes are fetched at
            // execution time, after the evidence post).
            bytes: Buffer.from("not-in-the-store"),
            raw: { toString: () => "nope" },
            spoiler: false,
          },
          "https://cdn.example/b.png", // bare URL string, assets.js-style
          null,
          42,
          { name: "no-url-no-id" },
        ],
      }),
    );

    const snap = store.take(token);
    assert.deepEqual(snap.attachments, [
      {
        id: "1",
        name: "a.png",
        url: "https://cdn.example/a.png",
        size: 10,
        contentType: "image/png",
      },
      { id: null, name: null, url: "https://cdn.example/b.png", size: null, contentType: null },
    ]);
    assert.equal(snap.attachments[0].bytes, undefined, "no byte payload retained");
    assert.equal(snap.attachments[0].raw, undefined, "no foreign object retained");
    assert.equal(
      JSON.stringify(snap).includes("not-in-the-store"),
      false,
      "the serialized snapshot carries no attachment bytes",
    );
  });

  it("user-variant defaults: no message fields, empty metadata arrays", () => {
    const { store } = withClock();
    const token = store.put({
      kind: REPORT_KINDS.USER,
      guildId: "1000",
      reporterUserId: "2000",
      subjectUserId: "5000",
    });

    const snap = store.take(token);
    assert.equal(snap.kind, "user");
    assert.equal(snap.messageId, null);
    assert.equal(snap.channelId, null);
    assert.equal(snap.channelName, null);
    assert.equal(snap.authorId, null);
    assert.equal(snap.content, "", "one string type for the evidence builder");
    assert.deepEqual(snap.attachments, []);
    assert.deepEqual(snap.embedUrls, []);
    assert.deepEqual(snap.stickers, []);
    assert.equal(snap.capturedAt, T0);
  });

  it("non-array metadata is not invented, and text lists keep strings", () => {
    const { store } = withClock();
    const token = store.put(
      messageSnapshot({
        attachments: "https://cdn.example/not-an-array.png",
        embedUrls: ["https://a.example", { name: "Named embed", url: "https://b.example" }, null, {}],
        stickers: "Wavecat",
      }),
    );

    const snap = store.take(token);
    assert.deepEqual(snap.attachments, [], "a non-array never becomes a fake entry");
    assert.deepEqual(snap.embedUrls, ["https://a.example", "Named embed"], "objects reduce to text");
    assert.deepEqual(snap.stickers, [], "a bare string is not an array");
  });

  it("capturedAt from the caller wins, and garbage falls back to the clock", () => {
    const { store } = withClock();
    const stamped = store.put(messageSnapshot({ capturedAt: T0 - 60_000 }));
    assert.equal(store.take(stamped).capturedAt, T0 - 60_000, "caller timestamp respected");

    const junk = store.put(messageSnapshot({ capturedAt: "yesterday" }));
    assert.equal(store.take(junk).capturedAt, T0, "unparseable stamps fall back to now");
  });
});

describe("pending-report store: token semantics (decision 3)", () => {
  it("unknown, empty, and malformed tokens take to null without throwing", () => {
    const { store } = withClock();
    store.put(messageSnapshot());
    for (const junk of [null, undefined, "", "   ", 42, {}, [], "tk:rep:m:deadbeef"]) {
      assert.equal(store.take(junk), null, `take(${JSON.stringify(junk)})`);
    }
    assert.equal(store.size(), 1, "reading junk tokens never disturbs the live entry");
  });

  it("is still live one millisecond before the TTL", () => {
    const { store, advance } = withClock();
    const token = store.put(messageSnapshot());
    advance(TTL - 1);
    assert.ok(store.take(token), "the window is inclusive of its last ms");
  });

  it("expires at exactly the TTL and drops the entry", () => {
    const { store, advance } = withClock();
    const token = store.put(messageSnapshot());
    advance(TTL);
    assert.equal(store.take(token), null, "expiry is inclusive, like the gork gate window");
    assert.equal(store.size(), 0, "an expired take removes the entry, not just reads it");
    assert.equal(store.take(token), null, "and it stays gone");
  });

  it("TTL runs from capture time, so a late snapshot expires early", () => {
    const { store, advance } = withClock();
    const token = store.put(messageSnapshot({ capturedAt: T0 - 9 * 60_000 }));
    advance(60_000); // 10 minutes since the CAPTURE, 1 minute since the put
    assert.equal(store.take(token), null, "touching an entry never extends its TTL");
  });

  it("explicit sweep drops only expired entries", () => {
    const { store, advance } = withClock();
    const oldToken = store.put(messageSnapshot({ messageId: "3001" }));
    advance(1000);
    const liveToken = store.put(messageSnapshot({ messageId: "3002" }));
    advance(TTL - 1000); // the first is exactly at its TTL; the second has 1s left

    assert.equal(store.sweep(), 1, "one expired entry swept");
    assert.equal(store.sweep(), 0, "a second sweep finds nothing");
    assert.equal(store.size(), 1);
    assert.equal(store.take(oldToken), null);
    assert.ok(store.take(liveToken), "the live token survived the sweep");
  });

  it("put and take sweep lazily — the store holds no timers", () => {
    const { store, advance } = withClock();
    store.put(messageSnapshot({ messageId: "3003" }));
    advance(TTL);
    assert.equal(store.size(), 1, "nothing has touched the store since the put");

    store.put(messageSnapshot({ messageId: "3004" }));
    assert.equal(store.size(), 1, "the new put swept the expired one");
  });

  it("tokens are unique lowercase hex and fit the modal customId budget", () => {
    const { store } = withClock();
    const tokens = new Set();
    for (let i = 0; i < 500; i += 1) {
      const token = store.put(messageSnapshot({ messageId: String(10_000 + i) }));
      assert.match(token, /^[0-9a-f]+$/, "lowercase hex only");
      assert.equal(token.length, TOKEN_BYTES * 2, "16 random bytes → 32 hex chars");
      tokens.add(token);
    }
    assert.equal(tokens.size, 500, "500 puts mint 500 distinct tokens");
    assert.equal(store.size(), 500, "all live under one instant");

    const longestPrefix = Math.max(
      MODAL_REPORT_MESSAGE_PREFIX.length,
      MODAL_REPORT_USER_PREFIX.length,
    );
    assert.ok(
      longestPrefix + TOKEN_BYTES * 2 <= 100,
      "prefix + token stays inside Discord's 100-char customId limit",
    );
  });
});

describe("pending-report store: put guards (error rule 6)", () => {
  it("an incomplete or unusable snapshot returns null and stores nothing", () => {
    const { store } = withClock();
    const cases = [
      ["missing kind", { guildId: "1000", reporterUserId: "2000" }],
      ["unknown kind", { kind: "channel", guildId: "1000", reporterUserId: "2000" }],
      ["missing guildId", { kind: "message", reporterUserId: "2000" }],
      ["blank guildId", { kind: "message", guildId: "   ", reporterUserId: "2000" }],
      ["missing reporterUserId", { kind: "message", guildId: "1000" }],
      ["zero ids carry no identity", { kind: "message", guildId: 0, reporterUserId: 0 }],
      ["null snapshot", null],
      ["undefined snapshot", undefined],
      ["string snapshot", "message"],
      ["array snapshot", []],
    ];
    for (const [label, input] of cases) {
      assert.equal(store.put(input), null, label);
    }
    assert.equal(store.size(), 0, "a rejected put stores nothing");
  });

  it("PENDING_REPORT_TTL_MS is the locked 10 minutes", () => {
    assert.equal(TTL, 10 * 60 * 1000);
  });

  it("exports exactly the surface the report handlers build on", () => {
    assert.deepEqual(
      Object.keys(pendingReports).sort(),
      [
        "PENDING_REPORT_TTL_MS",
        "TOKEN_BYTES",
        "TOKEN_COLLISION_RETRIES",
        "REPORT_KINDS",
        "createPendingReportStore",
        "putReport",
        "put",
        "takeReport",
        "take",
        "sweepPendingReports",
        "pendingReportCountForTests",
        "resetPendingReportsForTests",
      ].sort(),
    );
    assert.deepEqual(REPORT_KINDS, { MESSAGE: "message", USER: "user" });
  });
});

describe("pending-report singleton (process-wide store)", () => {
  beforeEach(() => resetPendingReportsForTests());

  it("putReport→takeReport round-trips and consumes", () => {
    const token = putReport(messageSnapshot());
    assert.ok(token);
    assert.equal(pendingReportCountForTests(), 1);

    assert.equal(takeReport(token).messageId, "3000");
    assert.equal(takeReport(token), null, "second take is null");
    assert.equal(pendingReportCountForTests(), 0);
  });

  it("the short put/take aliases are the same functions", () => {
    assert.equal(put, putReport);
    assert.equal(take, takeReport);

    const token = put(messageSnapshot());
    assert.equal(take(token).reporterUserId, "2000");
    assert.equal(take(token), null);
  });

  it("singleton expiry is testable without waiting ({ now } override)", () => {
    const token = putReport(messageSnapshot(), { now: T0 });
    assert.equal(pendingReportCountForTests(), 1);
    assert.equal(takeReport(token, { now: T0 + TTL }), null, "forced expiry");
    assert.equal(pendingReportCountForTests(), 0, "the forced take swept it out");
    assert.equal(sweepPendingReports({ now: T0 + TTL }), 0, "nothing left to sweep");
  });

  it("resetPendingReportsForTests clears leftovers between tests", () => {
    putReport(messageSnapshot());
    assert.equal(pendingReportCountForTests(), 1);
    resetPendingReportsForTests();
    assert.equal(pendingReportCountForTests(), 0);
  });
});

describe("report modal constants (#745)", () => {
  it("customId prefixes and field ids are exactly the agreed tk: convention", () => {
    assert.equal(MODAL_REPORT_MESSAGE_PREFIX, "tk:rep:m:");
    assert.equal(MODAL_REPORT_USER_PREFIX, "tk:rep:u:");
    assert.equal(MODAL_REPORT_FIELD_CONTEXT, "rep_context");
    assert.equal(MODAL_REPORT_FIELD_DELETE, "rep_delete");
  });

  it("the two modal routes stay distinguishable by prefix alone", () => {
    // registerModalHandler matches by prefix, so neither may be a prefix of
    // the other or one handler would swallow both report kinds.
    assert.ok(!MODAL_REPORT_MESSAGE_PREFIX.startsWith(MODAL_REPORT_USER_PREFIX));
    assert.ok(!MODAL_REPORT_USER_PREFIX.startsWith(MODAL_REPORT_MESSAGE_PREFIX));
    assert.notEqual(MODAL_REPORT_FIELD_CONTEXT, MODAL_REPORT_FIELD_DELETE);
  });
});
