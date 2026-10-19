/**
 * #217: the bridge relay backlog row on the ticker-health surface.
 *
 * Pure classification, the registry wiring (worker-dark honesty included),
 * and the repository's aggregated summary query against real SQLite.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { api, cleanup } = loadDb();
const {
  bridgeRelayBacklogResult,
  registerBridgeRelayHealthSource,
  RELAY_BACKLOG_SOURCE,
} = require("../src/web/data/bridgeRelayHealth");
const {
  registerTickerHealthSource,
  snapshotTickerHealth,
  _clearTickerHealthForTests,
} = require("../src/web/data/tickerHealth");
const bridges = require("../src/db/repositories/bridges");

after(() => cleanup?.());

describe("#217 bridgeRelayBacklogResult: pure classification", () => {
  it("clear backlog → ok, all-clear detail", () => {
    assert.deepEqual(bridgeRelayBacklogResult({ bridges: [], totals: { queued: 0, parked: 0 } }), {
      status: "ok",
      detail: "all relay queues clear",
    });
  });

  it("queued-only → ok with the depth breakdown (depth alone is NOT stale)", () => {
    const r = bridgeRelayBacklogResult({
      bridges: [{ publicId: "b_alpha2x9", queued: 3, parked: 0 }],
      totals: { queued: 3, parked: 0 },
    });
    assert.equal(r.status, "ok");
    assert.match(r.detail, /^3 queued/);
    assert.ok(r.detail.includes("b_alpha2x9 q3 p0"));
  });

  it("parked copies → STALE naming the count and /bridge retry", () => {
    const r = bridgeRelayBacklogResult({
      bridges: [{ publicId: "b_alpha2x9", queued: 2, parked: 1 }],
      totals: { queued: 2, parked: 1 },
    });
    assert.equal(r.status, "stale");
    assert.match(r.detail, /1 parked copy — \/bridge retry/);
    assert.ok(r.detail.includes("q2 p1"));
  });

  it("per-bridge breakdown caps at 3 tokens with a +N more overflow", () => {
    const r = bridgeRelayBacklogResult({
      bridges: [
        { publicId: "b_parked11", queued: 0, parked: 5 },
        { publicId: "b_worst222", queued: 9, parked: 2 },
        { publicId: "b_mid3333", queued: 4, parked: 0 },
        { publicId: "b_four444", queued: 1, parked: 0 },
        { publicId: "b_five555", queued: 1, parked: 0 },
      ],
      totals: { queued: 15, parked: 7 },
    });
    assert.match(r.detail, /\+2 more/);
    assert.ok(!r.detail.includes("b_five555"), "overflowed bridge omitted");
    assert.equal(r.status, "stale", "parked ANYWHERE dominates the status");
  });

  it("detail never exceeds the registry's display cap", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      publicId: `b_longname${i}`,
      queued: 999,
      parked: 999,
    }));
    const r = bridgeRelayBacklogResult({
      bridges: many,
      totals: { queued: 19980, parked: 19980 },
    });
    assert.ok(r.detail.length <= 120, `detail bounded: ${r.detail.length}`);
  });

  it("worker NOT running → null (registry renders unknown/not wired)", () => {
    assert.equal(
      bridgeRelayBacklogResult({ bridges: [], totals: { queued: 0, parked: 0 } }, { workerRunning: false }),
      null,
      "a never-started relay worker is never a fabricated green",
    );
  });
});

describe("#217 registry wiring", () => {
  before(() => _clearTickerHealthForTests());
  after(() => _clearTickerHealthForTests());

  const fakeRepo = (summary) => ({ relayHealthSummary: () => summary });
  const alwaysOn = { isWorkerRunning: () => true };

  it("the source registers under the stable name and feeds the snapshot", async () => {
    const off = registerBridgeRelayHealthSource(
      fakeRepo({ bridges: [{ publicId: "b_one11111", queued: 0, parked: 4 }], totals: { queued: 0, parked: 4 } }),
      alwaysOn
    );
    const rows = await snapshotTickerHealth(1_700_000_000_000);
    off();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, RELAY_BACKLOG_SOURCE);
    assert.equal(rows[0].status, "stale");
    assert.match(rows[0].detail, /4 parked copies/);
  });

  it("worker dark → unknown with the not-wired detail (honesty end-to-end)", async () => {
    const off = registerBridgeRelayHealthSource(
      fakeRepo({ bridges: [], totals: { queued: 0, parked: 0 } }),
      { isWorkerRunning: () => false }
    );
    const rows = await snapshotTickerHealth(1_700_000_000_000);
    off();
    assert.equal(rows[0].status, "unknown");
    assert.equal(rows[0].detail, "not wired");
  });

  it("a throwing repo getter degrades to unknown WITHOUT leaking internals", async () => {
    const off = registerBridgeRelayHealthSource(
      {
        relayHealthSummary: () => {
          throw new Error("SQLITE LOCKED secret path /tmp/secret");
        },
      },
      alwaysOn
    );
    const rows = await snapshotTickerHealth(1_700_000_000_000);
    off();
    assert.equal(rows[0].status, "unknown");
    assert.equal(rows[0].detail, "source failed");
    assert.ok(!JSON.stringify(rows).includes("secret"), "no internals escape");
  });
});

describe("#217 relayHealthSummary: one query over the backlog (real DB)", () => {
  let communityId;

  before(() => {
    communityId = communityKey("930000000000000001");
  });

  let channelSeq = 0;
  const mkBridge = (publicId, { state = "active" } = {}) => {
    bridges.createBridge({
      publicId,
      createdByUserId: "100000000000000001",
      endACommunityId: communityId,
      endAChannelId: String(310000000 + ++channelSeq),
    });
    api.db.prepare("UPDATE bridges SET state = ? WHERE public_id = ?").run(state, publicId);
    return bridges.getBridgeByPublicId(publicId);
  };

  const parkRow = (bridgeId, direction, src) => {
    bridges.enqueueBridgeOutbox(bridgeId, { direction, kind: "create", srcMessageId: src });
    const row = api.db
      .prepare("SELECT id FROM bridge_outbox WHERE bridge_id = ? AND src_message_id = ?")
      .get(bridgeId, src);
    bridges.recordOutboxFailure(row.id, "403 blocked", { maxAttempts: 1 });
  };

  it("clear DB → zero totals, no bridge rows", () => {
    const s = bridges.relayHealthSummary();
    assert.deepEqual(s.totals, { queued: 0, parked: 0 });
    assert.equal(s.bridges.length, 0);
  });

  it("queues + parks aggregate per bridge, worst-first; non-active bridges excluded", () => {
    const parked = mkBridge("b_parked01");
    const busy = mkBridge("b_tense001");
    const dark = mkBridge("b_dark0001", { state: "broken" });

    bridges.enqueueBridgeOutbox(busy.id, { direction: "a_to_b", kind: "create", srcMessageId: "m1" });
    bridges.enqueueBridgeOutbox(busy.id, { direction: "a_to_b", kind: "edit", srcMessageId: "m2" });
    parkRow(parked.id, "b_to_a", "m3");
    parkRow(parked.id, "a_to_b", "m4");
    // the dark bridge's backlog is invisible: its worker never relays it
    bridges.enqueueBridgeOutbox(dark.id, { direction: "a_to_b", kind: "create", srcMessageId: "m5" });

    const s = bridges.relayHealthSummary();
    assert.deepEqual(s.bridges, [
      { publicId: "b_parked01", queued: 0, parked: 2 },
      { publicId: "b_tense001", queued: 2, parked: 0 },
    ]);
    assert.deepEqual(s.totals, { queued: 2, parked: 2 });
  });
});
