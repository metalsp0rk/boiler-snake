/**
 * #469 (F2-10): a backfill PAGE is an atomic unit — counts + cursor commit
 * together, or the page replays exactly once.
 *
 * Old shape: `incrementDaily(...)` per bucket, then the cursor write. A
 * crash in between replayed the page (cursor never moved) while the
 * committed counts stayed — and with no event-level dedup table the
 * double-count was PERMANENT. Simulated here with an armed prepare(): the
 * second bucket's upsert "crashes" mid-page.
 *   old: bucket A committed, no cursor → resume counts A twice.
 *   new: the transaction rolls A back → resume counts everything once.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env"); // CONTRACT: temp DB before src/
const { api, cleanup } = loadDb();

const backfill = require("../src/features/userActivity/backfill");
const { ensureCommunity } = require("../src/platform/community");

after(cleanup);

const GUILD = "990000000000004610";
const CHANNEL = "ch-f210";
const DAY = Date.UTC(2026, 4, 14);

/** 100 human messages: ids 100..199, author alternates u-a / u-b. */
const all = Array.from({ length: 100 }, (_, i) => ({
  id: String(199 - i), // newest first like a Discord page
  type: 0,
  author: { id: i % 2 === 0 ? "u-a" : "u-b", bot: false },
  createdTimestamp: DAY + i,
}));

const channel = {
  id: CHANNEL,
  guildId: GUILD,
  messages: {
    fetch: async (opts = {}) => {
      const picked = all.filter(
        (m) => !opts.before || Number(m.id) < Number(opts.before),
      );
      const page = picked.slice(0, opts.limit ?? 100);
      return new Map(page.map((m) => [m.id, m]));
    },
  },
};

function totals(cid) {
  return api.db
    .prepare(
      "SELECT user_id, count FROM user_channel_message_daily WHERE community_id=? ORDER BY user_id",
    )
    .all(cid)
    .map((r) => [r.user_id, Number(r.count)]);
}

describe("#469 (F2-10): crash mid-page replays each message exactly once", () => {
  let cid;

  before(() => {
    cid = ensureCommunity({
      platform: "discord",
      instanceKey: "discord",
      externalGuildId: GUILD,
    });
    backfill.setBackfillPageDelayForTests(0);
  });

  it("the armed mid-page crash leaves NO counts (transaction rollback)", async () => {
    // Arm: the SECOND user_channel_message_daily upsert of the page throws
    // — bucket u-a committed, bucket u-b "crashes" in the old autocommit world.
    const realPrepare = api.db.prepare.bind(api.db);
    let writes = 0;
    api.db.prepare = (sql) => {
      const st = realPrepare(sql);
      if (typeof sql === "string" && sql.includes("INSERT INTO user_channel_message_daily")) {
        return {
          ...st,
          run: (...args) => {
            writes += 1;
            if (writes === 2) throw new Error("SIMULATED MID-PAGE CRASH");
            return st.run(...args);
          },
        };
      }
      return st;
    };

    await assert.rejects(
      () =>
        backfill.backfillChannelHistory({
          channel,
          watermarkMs: DAY + 10_000,
          onlyUserId: null,
          cursorMode: "guild",
        }),
      /SIMULATED MID-PAGE CRASH/,
    );

    api.db.prepare = realPrepare;

    assert.deepEqual(
      totals(cid),
      [],
      "old code left bucket u-a committed WITHOUT a cursor — resume would count those 50 again, forever",
    );
  });

  it("the clean resume counts every message EXACTLY once", async () => {
    const res = await backfill.backfillChannelHistory({
      channel,
      watermarkMs: DAY + 10_000,
      onlyUserId: null,
      cursorMode: "guild",
    });
    assert.equal(res.complete, true);
    assert.equal(res.counted, 100);
    assert.deepEqual(
      totals(cid),
      [
        ["u-a", 50],
        ["u-b", 50],
      ],
      "50 + 50, not 100 + 50 (the old at-least-once resume double-counted the first bucket)",
    );
  });

  it("the cursor now marks the channel complete (idempotent re-run counts nothing)", async () => {
    const res = await backfill.backfillChannelHistory({
      channel,
      watermarkMs: DAY + 10_000,
      onlyUserId: null,
      cursorMode: "guild",
    });
    assert.equal(res.counted, 0);
    assert.deepEqual(totals(cid), [
      ["u-a", 50],
      ["u-b", 50],
    ]);
  });
});
