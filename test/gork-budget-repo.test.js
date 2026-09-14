/**
 * gorkBudget repository unit tests (roadmap/gork.md §7.17).
 *
 * Pure resolveBudget precedence + tri-state clamping run without any DB;
 * rule CRUD + usage/pruning run against a fresh temp SQLite via loadDb().
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

const {
  clampDailyLimit,
  resolveBudget,
} = require("../src/db/repositories/gorkBudget");

describe("gorkBudget clampDailyLimit (decision 31)", () => {
  it("clamps to the tri-state bounds -1..1000", () => {
    assert.equal(clampDailyLimit(-5), -1);
    assert.equal(clampDailyLimit(-1), -1);
    assert.equal(clampDailyLimit(0), 0);
    assert.equal(clampDailyLimit(7), 7);
    assert.equal(clampDailyLimit(1000), 1000);
    assert.equal(clampDailyLimit(5000), 1000);
    assert.equal(clampDailyLimit("5"), 5);
    assert.equal(clampDailyLimit(7.9), 7);
  });

  it("garbage degrades to 0 = unlimited (never a silent block)", () => {
    assert.equal(clampDailyLimit(null), 0);
    assert.equal(clampDailyLimit(undefined), 0);
    assert.equal(clampDailyLimit("gork"), 0);
    assert.equal(clampDailyLimit(NaN), 0);
    assert.equal(clampDailyLimit(Infinity), 0, "non-finite is garbage, not a big cap");
  });
});

describe("gorkBudget resolveBudget precedence (decision 30, pure)", () => {
  const rules = [
    { scope_kind: "channel", target_id: "c1", daily_limit: 5 },
    { scope_kind: "category", target_id: "cat1", daily_limit: 2 },
  ];

  it("channel rule wins over category and guild default", () => {
    assert.deepEqual(
      resolveBudget(rules, "c1", "cat1", 99),
      { scopeKind: "channel", scopeId: "c1", limit: 5 },
    );
  });

  it("category rule applies when no channel rule matches", () => {
    assert.deepEqual(
      resolveBudget(rules, "c2", "cat1", 99),
      { scopeKind: "category", scopeId: "cat1", limit: 2 },
    );
  });

  it("guild default applies when no rule matches (with tri-state clamp)", () => {
    assert.deepEqual(resolveBudget(rules, "c2", "cat9", 3), {
      scopeKind: "guild",
      scopeId: "0",
      limit: 3,
    });
    assert.equal(resolveBudget([], null, null, 5000).limit, 1000);
    assert.equal(resolveBudget([], null, null, -7).limit, -1);
    assert.equal(
      resolveBudget([], "c1", "cat1", undefined).limit,
      0,
      "missing default = unlimited (feature off)",
    );
  });

  it("unfiled channel (no category) skips the category layer", () => {
    assert.deepEqual(resolveBudget(rules, "c2", null, 4), {
      scopeKind: "guild",
      scopeId: "0",
      limit: 4,
    });
  });

  it("coerces numeric target ids and ignores malformed rows", () => {
    const mixed = [
      null,
      { scope_kind: "role", target_id: "c1", daily_limit: 1 },
      { scope_kind: "channel", target_id: 1234, daily_limit: 6 },
    ];
    assert.deepEqual(resolveBudget(mixed, "1234", null, 0), {
      scopeKind: "channel",
      scopeId: "1234",
      limit: 6,
    });
  });
});

describe("gorkBudget rules + usage repository (real temp SQLite)", () => {
  let api;
  let cleanup;

  before(() => {
    // Contract: loadDb() before any src/ db access — fresh temp SQLite file,
    // src require-cache reset, tracked cleanup (never touches project DB).
    ({ api, cleanup } = loadDb());
  });

  after(() => cleanup?.());

  const today = () => new Date().toISOString().slice(0, 10);

  it("upsert inserts, then replaces limit + provenance in place (one row)", () => {
    const g = "g-bud-crud";
    assert.equal(api.upsertGorkBudgetRule(g, "channel", "c1", 3, "staff-1"), true);
    let rows = api.listGorkBudgetRules(g);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].daily_limit, 3);
    assert.equal(rows[0].created_by, "staff-1");

    assert.equal(api.upsertGorkBudgetRule(g, "channel", "c1", -1, "staff-2"), true);
    rows = api.listGorkBudgetRules(g);
    assert.equal(rows.length, 1, "replace must not add a row");
    assert.equal(rows[0].daily_limit, -1);
    assert.equal(rows[0].created_by, "staff-2");
  });

  it("clamp on write: out-of-range rule limits are clamped to -1..1000", () => {
    const g = "g-bud-clamp";
    api.upsertGorkBudgetRule(g, "category", "cat1", 5000, null);
    assert.equal(api.listGorkBudgetRules(g)[0].daily_limit, 1000);
  });

  it("garbage scope kind / ids are rejected without touching the DB", () => {
    const g = "g-bud-garbage";
    assert.equal(api.upsertGorkBudgetRule(g, "role", "r1", 5, null), false);
    assert.equal(api.upsertGorkBudgetRule(g, "channel", "", 5, null), false);
    assert.equal(api.deleteGorkBudgetRule(g, "", "c1"), false);
    assert.equal(api.listGorkBudgetRules(g).length, 0);
  });

  it("delete removes exactly the matching rule (returns existence)", () => {
    const g = "g-bud-del";
    api.upsertGorkBudgetRule(g, "channel", "c1", 5, null);
    api.upsertGorkBudgetRule(g, "category", "c1", 2, null); // same id, other kind
    assert.equal(api.deleteGorkBudgetRule(g, "channel", "c1"), true);
    assert.equal(api.deleteGorkBudgetRule(g, "channel", "c1"), false);
    const rows = api.listGorkBudgetRules(g);
    assert.equal(rows.length, 1, "only the channel-kind row was removed");
    assert.equal(rows[0].scope_kind, "category");
  });

  it("usage starts at 0; increment counts 1,2,3 and returns the new total", () => {
    const g = "g-bud-use";
    const day = today();
    assert.equal(api.getGorkUsage(g, "u1", "channel", "c1", day), 0);
    assert.equal(api.incrementGorkUsage(g, "u1", "channel", "c1", day), 1);
    assert.equal(api.incrementGorkUsage(g, "u1", "channel", "c1", day), 2);
    assert.equal(api.incrementGorkUsage(g, "u1", "channel", "c1", day), 3);
    assert.equal(api.getGorkUsage(g, "u1", "channel", "c1", day), 3);
  });

  it("counters are isolated per (user, scope, day)", () => {
    const g = "g-bud-iso";
    const day = today();
    api.incrementGorkUsage(g, "u1", "channel", "c1", day);
    assert.equal(api.getGorkUsage(g, "u2", "channel", "c1", day), 0, "other user");
    assert.equal(api.getGorkUsage(g, "u1", "category", "c1", day), 0, "other scope kind");
    assert.equal(api.getGorkUsage(g, "u1", "guild", "0", day), 0, "guild default row");
    assert.equal(api.getGorkUsage(g, "u1", "channel", "c2", day), 0, "other channel");
    assert.equal(api.getGorkUsage(g, "u1", "channel", "c1", "2000-01-01"), 0, "other day");
  });

  it("lazy prune on the write path: days older than yesterday go, yesterday stays", () => {
    const g = "g-bud-prune";
    const day = today();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const insert = api.db.prepare(`
      INSERT INTO gork_usage (guild_id, user_id, scope_kind, scope_id, day, count)
      VALUES (?, ?, 'channel', 'c1', ?, 7)
      ON CONFLICT(guild_id, user_id, scope_kind, scope_id, day)
      DO UPDATE SET count = count + 7
    `);
    insert.run(g, "u-old", "2020-01-01"); // ancient
    insert.run(g, "u-yest", yesterday); // yesterday
    insert.run(g, "u-today", day);

    api.incrementGorkUsage(g, "u1", "channel", "c1", day); // triggers the prune

    const days = api.db
      .prepare(`SELECT day FROM gork_usage WHERE guild_id=?`)
      .all(g)
      .map((r) => r.day);
    assert.ok(!days.includes("2020-01-01"), "ancient day must be pruned");
    assert.ok(days.includes(yesterday), "yesterday must survive one more day");
    assert.ok(days.includes(day), "today is current");
  });
});
