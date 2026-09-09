const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

describe("gork memory repository", () => {
  let api;
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boiler-snake-gorkmem-"));
    dbPath = path.join(tmpDir, "test.sqlite");
    process.env.DB_PATH = dbPath;
    // Fresh require after setting DB_PATH — clear cache for db modules
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}src${path.sep}db`) || key.endsWith(`${path.sep}db.js`)) {
        delete require.cache[key];
      }
    }
    api = require("../src/db");
  });

  const base = (over = {}) => ({
    guildId: "g-mem",
    subjectUserId: "u-1",
    memDate: "2026-09-01",
    title: "loves rust",
    titleKey: "loves rust",
    body: "prefers rust over python",
    kind: "preference",
    importance: 3,
    sourceMessageIds: ["m1"],
    ...over,
  });

  it("insert upsert returns created:true with an integer id (no eviction)", () => {
    const r = api.gorkMemoryUpsert(base());
    assert.equal(r.created, true);
    assert.ok(Number.isInteger(r.id), "id must be an integer rowid");
    assert.equal(r.evicted, 0);
    const row = api.gorkMemoryGetById("g-mem", r.id);
    assert.equal(row.title, "loves rust");
    assert.equal(row.last_used_at, null, "last_used_at starts unset");
  });

  it("same-key upsert overwrites in place (one row, created:false)", () => {
    const g = "g-mem-overwrite";
    const first = api.gorkMemoryUpsert(base({ guildId: g }));
    const second = api.gorkMemoryUpsert(
      base({
        guildId: g,
        title: "Loves Rust AND Zig",
        titleKey: "loves rust",
        body: "updated body",
        kind: "project",
        importance: 5,
        sourceMessageIds: ["m2"],
      })
    );
    assert.equal(second.created, false);
    assert.equal(second.id, first.id, "overwrite must keep the same row/id");
    const rows = api.gorkMemoryListForSubject(g, "u-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Loves Rust AND Zig");
    assert.equal(rows[0].body, "updated body");
    assert.equal(rows[0].kind, "project");
    assert.equal(rows[0].importance, 5);
  });

  it("case/whitespace title variants collide into ONE row via title_key", () => {
    const g = "g-mem-variant";
    const a = api.gorkMemoryUpsert(base({ guildId: g, title: "Loves Rust", titleKey: "loves rust" }));
    // what normalizeTitle("  LOVES   rust!! ") produces — same key, different display
    const b = api.gorkMemoryUpsert(base({ guildId: g, title: "LOVES rust!!", titleKey: "loves rust" }));
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.id, a.id);
    assert.equal(api.gorkMemoryListForGuild(g, 10).length, 1, "must stay a single row");
    assert.equal(api.gorkMemoryListForGuild(g, 10)[0].title, "LOVES rust!!", "display title overwritten");
  });

  it("source_message_ids union de-dupes and caps at the 20 newest", () => {
    const g = "g-mem-src";
    const firstIds = Array.from({ length: 15 }, (_, i) => `a${i}`); // a0..a14
    api.gorkMemoryUpsert(base({ guildId: g, sourceMessageIds: firstIds }));
    api.gorkMemoryUpsert(
      base({
        guildId: g,
        sourceMessageIds: [...Array.from({ length: 10 }, (_, i) => `b${i}`), "a14"],
      })
    );
    const row = api.gorkMemoryListForSubject(g, "u-1")[0];
    const merged = JSON.parse(row.source_message_ids);
    assert.equal(merged.length, 20, "union must cap at 20");
    assert.equal(new Set(merged).size, 20, "union must be unique");
    assert.equal(merged[merged.length - 1], "a14", "re-seen id takes its newest position");
    assert.ok(merged.includes("b9"));
    assert.ok(merged.includes("a5"), "recent ids of the old batch survive");
    assert.ok(!merged.includes("a3"), "oldest entries are evicted from the id list");
    assert.ok(!merged.includes("a0"));
  });

  it("eviction keeps the exact ranked survivors (importance → recency → date → id)", () => {
    const g = "g-mem-evict";
    const u = "u-evict";
    const mk = (t, imp, date) =>
      base({ guildId: g, subjectUserId: u, title: t, titleKey: t, memDate: date, importance: imp });
    const alpha = api.gorkMemoryUpsert(mk("alpha", 5, "2026-09-01"));
    const beta = api.gorkMemoryUpsert(mk("beta", 3, "2026-09-02"));
    const gamma = api.gorkMemoryUpsert(mk("gamma", 3, "2026-09-07"));
    const delta = api.gorkMemoryUpsert(mk("delta", 3, "2026-09-06"));
    const epsilon = api.gorkMemoryUpsert(mk("epsilon", 3, "2026-09-09"));
    const zeta = api.gorkMemoryUpsert(mk("zeta", 1, "2026-09-10"));

    // Seed exact rank fields so the eviction order is fully deterministic
    // (wall-clock updated_at from the inserts would make it time-dependent).
    //                     imp  last_used  updated  date       COALESCE
    // alpha                  5       5000     1000   2026-09-01     5000
    // beta                   3       4000     1000   2026-09-02     4000
    // gamma                  3       NULL     3000   2026-09-07     3000
    // delta                  3       3000     1000   2026-09-06     3000 (loses date to gamma)
    // epsilon                3       NULL     2000   2026-09-09     2000 (newest date, still loses)
    // zeta                   1       NULL     9000   2026-09-10     9000 (worst importance dominates)
    const seed = `UPDATE gork_memories
     SET importance=?, last_used_at=?, updated_at=?, mem_date=? WHERE id=?`;
    const seedStmt = api.db.prepare(seed);
    seedStmt.run(5, 5000, 1000, "2026-09-01", alpha.id);
    seedStmt.run(3, 4000, 1000, "2026-09-02", beta.id);
    seedStmt.run(3, null, 3000, "2026-09-07", gamma.id);
    seedStmt.run(3, 3000, 1000, "2026-09-06", delta.id);
    seedStmt.run(3, null, 2000, "2026-09-09", epsilon.id);
    seedStmt.run(1, null, 9000, "2026-09-10", zeta.id);

    const omega = api.gorkMemoryUpsert(mk("omega", 2, "2026-09-11"), 3);
    assert.equal(omega.evicted, 4, "keeps alpha, beta, gamma only");
    const survivors = api.gorkMemoryListForSubject(g, u).map((r) => r.title).sort();
    assert.deepEqual(
      survivors,
      ["alpha", "beta", "gamma"],
      "importance DESC, then COALESCE(last_used_at, updated_at) DESC (gamma > delta on the " +
        "recency tie via mem_date), then mem_date beats epsilon, and low-importance zeta " +
        "goes first regardless of its 9000 recency"
    );
  });

  it("eviction uses id DESC when every other rank field is equal", () => {
    const g = "g-mem-evict2";
    const u = "u-evict2";
    const first = api.gorkMemoryUpsert(base({ guildId: g, subjectUserId: u, title: "t1", titleKey: "t1" }));
    const second = api.gorkMemoryUpsert(base({ guildId: g, subjectUserId: u, title: "t2", titleKey: "t2" }));
    const sameSql =
      `UPDATE gork_memories
     SET importance=3, last_used_at=NULL, updated_at=1000, mem_date='2026-09-01' WHERE id=?`;
    api.db.prepare(sameSql).run(first.id);
    api.db.prepare(sameSql).run(second.id);

    const worse = api.gorkMemoryUpsert(
      base({ guildId: g, subjectUserId: u, title: "t3", titleKey: "t3", importance: 1, memDate: "2026-09-09" }),
      1
    );
    assert.equal(worse.evicted, 2, "t1 loses the id DESC tie and t3 is worst-importance");
    const survivors = api.gorkMemoryListForSubject(g, u).map((r) => r.title);
    assert.deepEqual(survivors, ["t2"], "only the higher-id equal-rank row survives");
  });

  it("touchMemories lifts a row above a newer-updated row during eviction", () => {
    const g = "g-mem-touch-order";
    const u = "u-touch";
    const p = api.gorkMemoryUpsert(base({ guildId: g, subjectUserId: u, title: "p", titleKey: "p", memDate: "2026-09-01" }));
    const q = api.gorkMemoryUpsert(base({ guildId: g, subjectUserId: u, title: "q", titleKey: "q", memDate: "2026-09-02" }));
    // p is the OLDER row on every axis (updated_at 500 vs q's 8000)…
    api.db.prepare("UPDATE gork_memories SET last_used_at=NULL, updated_at=500 WHERE id=?").run(p.id);
    api.db.prepare("UPDATE gork_memories SET last_used_at=NULL, updated_at=8000 WHERE id=?").run(q.id);

    // …until it gets recalled: last_used_at = real now() must beat q's seeded 8000.
    assert.equal(api.gorkMemoryTouch(g, [p.id]), 1);
    const r = api.gorkMemoryUpsert(
      base({ guildId: g, subjectUserId: u, title: "r", titleKey: "r", memDate: "2026-09-03", importance: 3 }),
      2
    );
    assert.equal(r.evicted, 1);
    const survivors = api.gorkMemoryListForSubject(g, u).map((row) => row.title).sort();
    assert.deepEqual(
      survivors,
      ["p", "r"],
      "touched p must survive; without the touch, p's 500 < q's 8000 would evict it"
    );
  });

  it("touchMemories sets last_used_at and is guild-scoped", () => {
    const g = "g-mem-touch";
    const r = api.gorkMemoryUpsert(base({ guildId: g, title: "t", titleKey: "t" }));
    assert.equal(api.gorkMemoryGetById(g, r.id).last_used_at, null);
    assert.equal(api.gorkMemoryTouch("g-mem-touch-other", [r.id]), 0, "touch is guild-scoped");
    assert.equal(api.gorkMemoryTouch(g, []), 0, "empty ids is a no-op");
    assert.equal(api.gorkMemoryTouch(g, [r.id, 999999]), 1, "missing ids don't count");
    const after = api.gorkMemoryGetById(g, r.id);
    assert.ok(Number.isInteger(after.last_used_at), "last_used_at must be stamped");
  });

  it("getById / deleteById are guild-scoped (no cross-guild leak)", () => {
    const gA = "g-mem-scopeA";
    const gB = "g-mem-scopeB";
    const r = api.gorkMemoryUpsert(base({ guildId: gA, title: "s", titleKey: "s" }));
    assert.equal(api.gorkMemoryGetById(gB, r.id), null, "id invisible from another guild");
    assert.equal(api.gorkMemoryDeleteById(gB, r.id), false, "id undeletable from another guild");
    assert.ok(api.gorkMemoryGetById(gA, r.id), "id visible in owning guild");
    assert.equal(api.gorkMemoryDeleteById(gA, r.id), true);
    assert.equal(api.gorkMemoryDeleteById(gA, r.id), false, "second delete is a no-op");
    assert.equal(api.gorkMemoryGetById(gA, r.id), null);
    assert.equal(api.gorkMemoryGetById(gA, "not-a-number"), null, "garbage id never throws");
  });

  it("deleteForSubject / countForGuild / deleteForGuild report counts", () => {
    const g = "g-mem-counts";
    const other = "g-mem-counts-other";
    api.gorkMemoryUpsert(base({ guildId: g, subjectUserId: "u-a", title: "one", titleKey: "one" }));
    api.gorkMemoryUpsert(base({ guildId: g, subjectUserId: "u-a", title: "two", titleKey: "two" }));
    api.gorkMemoryUpsert(base({ guildId: g, subjectUserId: "u-b", title: "three", titleKey: "three" }));
    api.gorkMemoryUpsert(base({ guildId: other, subjectUserId: "u-c", title: "four", titleKey: "four" }));

    assert.equal(api.gorkMemoryCountForGuild(g), 3);
    assert.equal(api.gorkMemoryCountForGuild("g-mem-none"), 0, "empty guild counts 0");
    assert.equal(api.gorkMemoryDeleteForSubject(g, "u-a"), 2);
    assert.equal(api.gorkMemoryDeleteForSubject(g, "u-a"), 0, "second clear is a no-op");
    assert.equal(api.gorkMemoryCountForGuild(g), 1);
    assert.equal(api.gorkMemoryDeleteForGuild(g), 1);
    assert.equal(api.gorkMemoryCountForGuild(g), 0);
    assert.equal(api.gorkMemoryCountForGuild(other), 1, "other guild untouched");
    assert.equal(api.gorkMemoryDeleteForGuild(other), 1);
  });

  it("listForSubjects: per-person order importance/mem_date DESC + limit", () => {
    const g = "g-mem-list";
    const u1 = "u-list-1";
    const u2 = "u-list-2";
    const mk = (u, t, imp, date) =>
      base({ guildId: g, subjectUserId: u, title: t, titleKey: t, importance: imp, memDate: date });
    api.gorkMemoryUpsert(mk(u1, "imp1-day5", 1, "2026-09-05"));
    api.gorkMemoryUpsert(mk(u1, "imp5-day1", 5, "2026-09-01"));
    api.gorkMemoryUpsert(mk(u1, "imp3-day4-first", 3, "2026-09-04"));
    api.gorkMemoryUpsert(mk(u1, "imp3-day4-second", 3, "2026-09-04"));
    api.gorkMemoryUpsert(mk(u2, "imp2-day9", 2, "2026-09-09"));

    const limited = api.gorkMemoryListForSubjects(g, [u1, u2, "u-missing"], 3);
    assert.deepEqual(
      limited.map((r) => r.title),
      ["imp5-day1", "imp3-day4-second", "imp3-day4-first", "imp2-day9"],
      "per-person importance DESC then mem_date DESC then id DESC, limited per person"
    );
    assert.equal("rn" in limited[0], false, "window helper column must not leak");

    const full = api.gorkMemoryListForSubjects(g, [u1]);
    assert.equal(full.length, 4, "default per-person limit covers all rows");
    assert.deepEqual(api.gorkMemoryListForSubjects(g, []), [], "empty subject list never throws");
    assert.deepEqual(api.gorkMemoryListForSubjects("g-mem-list-other", [u1]), [], "per-guild");
  });

  it("empty guilds read as [] / null without throwing", () => {
    assert.deepEqual(api.gorkMemoryListForSubject("g-mem-none", "u-none"), []);
    assert.deepEqual(api.gorkMemoryListForGuild("g-mem-none", 25), []);
    assert.equal(api.gorkMemoryGetById("g-mem-none", 1), null);
  });
});
