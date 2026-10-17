const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  loadDb,
  communityKey,
  createTempDbPath,
  resetSrcModules,
  FAKE_TOKEN_ENCRYPTION_KEY,
} = require("./helpers/env");

/**
 * Migration 040_schema_hygiene (audit-2026-10 #204): CHECK constraints on
 * users.xp / gork_budget_rules.daily_limit, the leaderboard + archived-ticket
 * indexes, and the drop of the dead voice_sessions table. Verification per
 * the issue: constraint rejection on boundary values, EXPLAIN QUERY PLAN
 * index usage, and fresh-DB / migrated-DB parity for the drops.
 */

const MAX_SAFE_XP = Number.MAX_SAFE_INTEGER; // 9007199254740991 — mirrors src/core/constants

/** Fresh-DB describe: schema objects, CHECK boundaries, EQP index usage. */
describe("migration 040_schema_hygiene (fresh DB: constraints, indexes, drops)", () => {
  /** @type {ReturnType<typeof loadDb>["api"]} */
  let api;
  let cleanup;
  let cid;

  before(() => {
    ({ api, cleanup } = loadDb());
    cid = communityKey("g-040-hygiene");
  });

  after(() => cleanup?.());

  const ddl = (table) =>
    api.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql || "";

  // ── CHECK constraints ─────────────────────────────────────────────────────

  it("users.xp carries the documented CHECK derived from clampXpTotal's domain", () => {
    assert.match(ddl("users"), /CHECK \(xp BETWEEN 0 AND 9007199254740991\)/);
    assert.match(ddl("users"), /PRIMARY KEY \(community_id, user_id\)/, "rebuild preserved the PK");
  });

  it("gork_budget_rules.daily_limit carries the tri-state CHECK", () => {
    assert.match(ddl("gork_budget_rules"), /CHECK \(daily_limit BETWEEN -1 AND 1000\)/);
  });

  const insertUser = (userId, xpLiteral) =>
    api.db
      .prepare(
        `INSERT INTO users (community_id, user_id, xp, created_at, updated_at)
         VALUES (?, ?, ${xpLiteral}, 1, 1)`
      )
      .run(cid, userId);

  describe("users.xp CHECK boundary values", () => {
    it("rejects xp = -1", () => {
      assert.throws(() => insertUser("lb-neg", -1), /CHECK constraint failed: xp BETWEEN 0 AND 9007199254740991/);
    });

    it("accepts xp = 0 and xp = MAX_SAFE_XP (the clampXpTotal ceiling is LEGAL)", () => {
      assert.doesNotThrow(() => insertUser("lb-zero", 0));
      assert.doesNotThrow(() => insertUser("lb-max", MAX_SAFE_XP));
      assert.equal(api.getXp(cid, "lb-zero"), 0);
    });

    it("rejects xp = MAX_SAFE_XP + 1 (beyond JS-safe integers)", () => {
      assert.throws(() => insertUser("lb-over", MAX_SAFE_XP + 1), /CHECK constraint failed/);
    });

    it("rejects the audit's poisoned cell: TEXT 'Infinity' (better-sqlite3 stores it raw)", () => {
      assert.throws(
        () => insertUser("lb-inf", "'Infinity'"),
        /CHECK constraint failed: xp BETWEEN 0 AND 9007199254740991/
      );
    });

    it("repository XP writes stay inside the domain (addXp clamp, decay floor)", () => {
      assert.equal(api.addXp(cid, "repo-user", 150), 150);
      // clampDelta(1e18) saturates to MAX_SAFE_XP, addXp caps to the headroom:
      // the stored total lands EXACTLY on the CHECK ceiling — legal, not rejected.
      assert.equal(api.addXp(cid, "repo-user", 1e18), MAX_SAFE_XP, "award clamps TO MAX_SAFE_XP");
      assert.equal(api.getXp(cid, "repo-user"), MAX_SAFE_XP, "clamped total persists under the CHECK");
      const decayed = api.applyDecay(cid, "repo-user", 0.5);
      assert.ok(decayed && decayed.after_xp >= 0, "decay stays in [0, MAX_SAFE_XP]");
    });
  });

  describe("gork_budget_rules.daily_limit CHECK domain values", () => {
    const insertRule = (targetId, limit) =>
      api.db
        .prepare(
          `INSERT INTO gork_budget_rules (community_id, scope_kind, target_id, daily_limit, created_at)
           VALUES (?, 'channel', ?, ?, 1)`
        )
        .run(cid, targetId, limit);

    it("accepts the tri-state domain: -1 blocked | 0 unlimited | 1000 cap", () => {
      assert.doesNotThrow(() => insertRule("c-neg1", -1));
      assert.doesNotThrow(() => insertRule("c-zero", 0));
      assert.doesNotThrow(() => insertRule("c-max", 1000));
    });

    it("rejects -2 and 1001 (outside clampDailyLimit's documented clamp)", () => {
      assert.throws(() => insertRule("c-under", -2), /CHECK constraint failed: daily_limit BETWEEN -1 AND 1000/);
      assert.throws(() => insertRule("c-over", 1001), /CHECK constraint failed/);
    });

    it("repository upsert still round-trips (clamp-on-write remains the front line)", () => {
      assert.equal(api.upsertGorkBudgetRule(cid, "channel", "c-repo", 42, "staff"), true);
      const rules = api.listGorkBudgetRules(cid);
      assert.equal(rules.find((r) => r.target_id === "c-repo").daily_limit, 42);
      // Out-of-range input NEVER reaches the CHECK — the repo clamps first.
      assert.equal(api.upsertGorkBudgetRule(cid, "channel", "c-clamp", 9999), true);
      assert.equal(api.listGorkBudgetRules(cid).find((r) => r.target_id === "c-clamp").daily_limit, 1000);
    });
  });

  // ── Indexes: presence + usage (EXPLAIN QUERY PLAN) ────────────────────────

  describe("idx_users_guild_xp serves the leaderboard path", () => {
    const idx = () =>
      api.db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_users_guild_xp'")
        .get();

    it("exists with the (community_id, xp DESC, user_id ASC) shape", () => {
      const row = idx();
      assert.ok(row, "idx_users_guild_xp must exist");
      assert.match(row.sql, /ON users \(community_id, xp DESC, user_id ASC\)/);
    });

    it("slash leaderboard shape (topUsers) uses it, sort-free", () => {
      const plan = api.db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT user_id, xp FROM users WHERE community_id=? ORDER BY xp DESC LIMIT ?`
        )
        .all(cid, 10)
        .map((r) => r.detail);
      assert.ok(
        plan.some((d) => /idx_users_guild_xp/.test(d)),
        `expected idx_users_guild_xp in plan: ${JSON.stringify(plan)}`
      );
      assert.ok(
        !plan.some((d) => /TEMP B-TREE/i.test(d)),
        `ORDER BY must be index-served, no temp B-tree: ${JSON.stringify(plan)}`
      );
    });

    it("web leaderboard shape (xp DESC + user_id tie-break, LIMIT/OFFSET) uses it, sort-free", () => {
      const plan = api.db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT user_id, xp FROM users
           WHERE community_id=?
           ORDER BY xp DESC, user_id ASC
           LIMIT ? OFFSET ?`
        )
        .all(cid, 25, 0)
        .map((r) => r.detail);
      assert.ok(
        plan.some((d) => /idx_users_guild_xp/.test(d)),
        `expected idx_users_guild_xp in plan: ${JSON.stringify(plan)}`
      );
      assert.ok(!plan.some((d) => /TEMP B-TREE/i.test(d)), "tie-break order is index-served too");
    });

    it("topUsers repository call still returns correct order (index did not change semantics)", () => {
      const g = communityKey("g-040-toporder");
      api.addXp(g, "a", 10);
      api.addXp(g, "b", 30);
      api.addXp(g, "c", 20);
      assert.deepEqual(
        api.topUsers(g, 10).map((r) => r.user_id),
        ["b", "c", "a"]
      );
    });
  });

  describe("idx_tickets_archived serves the archived-ticket listing", () => {
    before(() => {
      const open = api.db.prepare(
        `INSERT INTO tickets (community_id, ticket_number, channel_id, creator_user_id, status, created_at)
         VALUES (?, ?, ?, 'creator', 'open', ?)`
      );
      const archived = api.db.prepare(
        `INSERT INTO tickets (community_id, ticket_number, channel_id, creator_user_id, status, created_at,
                              closed_at, archived, transcript_token, transcript_path)
         VALUES (?, ?, NULL, 'creator', 'closed', ?, ?, 1, ?, ?)`
      );
      const tx = api.db.transaction(() => {
        open.run(cid, 1, "1200000000000000001", 1000);
        archived.run(cid, 2, 2000, 2000, "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f", "ticket-transcripts/x/2");
        archived.run(cid, 3, 3000, 3000, "1f1f1f1f-1f1f-4f1f-9f1f-1f1f1f1f1f1f", "ticket-transcripts/x/3");
        // A non-archived row WITHOUT a token must never enter the partial index's scope.
        open.run(cid, 4, "1200000000000000004", 4000);
      });
      tx();
    });

    it("exists as a PARTIAL index matching the archived-listing predicate", () => {
      const row = api.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_tickets_archived'")
        .get();
      assert.ok(row, "idx_tickets_archived must exist");
      assert.match(
        row.sql,
        /ON tickets \(community_id, closed_at DESC, ticket_number DESC\)\s+WHERE archived = 1 AND transcript_token IS NOT NULL/i
      );
    });

    it("community-scoped listArchivedTickets shape uses it, sort-free", () => {
      const plan = api.db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT * FROM tickets
           WHERE community_id=? AND archived=1 AND transcript_token IS NOT NULL
           ORDER BY closed_at DESC, ticket_number DESC
           LIMIT ? OFFSET ?`
        )
        .all(cid, 50, 0)
        .map((r) => r.detail);
      assert.ok(
        plan.some((d) => /idx_tickets_archived/.test(d)),
        `expected idx_tickets_archived in plan: ${JSON.stringify(plan)}`
      );
      assert.ok(
        !plan.some((d) => /TEMP B-TREE/i.test(d)),
        `closed_at DESC order must be index-served: ${JSON.stringify(plan)}`
      );
    });

    it("the repository listing still returns exactly the archived+token rows", () => {
      const rows = api.listArchivedTickets({ communityId: cid });
      assert.deepEqual(rows.map((r) => r.ticket_number).sort((a, b) => a - b), [2, 3]);
    });
  });

  // ── Drops: voice_sessions + cleanupOldNotifications ───────────────────────

  describe("dead weight dropped on the fresh path", () => {
    it("voice_sessions table does not exist after the full migration chain", () => {
      assert.equal(
        api.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='voice_sessions'")
          .get(),
        undefined
      );
    });

    it("the dead voiceSessions repository file is gone and its exports never resurface", () => {
      const repoPath = path.join(__dirname, "..", "src", "db", "repositories", "voiceSessions.js");
      assert.equal(fs.existsSync(repoPath), false, "src/db/repositories/voiceSessions.js must be deleted");
      for (const name of ["upsertVoiceSession", "getVoiceSession", "deleteVoiceSession"]) {
        assert.equal(name in api, false, `${name} must not resurface on the facade`);
      }
    });

    it("cleanupOldNotifications is gone from the youtube repository AND the facade", () => {
      const youtube = require("../src/db/repositories/youtube");
      assert.equal("cleanupOldNotifications" in youtube, false, "the un-wired data-deleter must be gone");
      assert.equal("cleanupOldNotifications" in api, false);
      // The SURVIVING cleanup helper (wired from guildSettings) is untouched.
      assert.equal(typeof youtube.cleanupMalformedYoutubeChannels, "function");
    });
  });

  it("re-running the FULL migration chain stays safe on a post-040 DB (idempotent replay)", () => {
    const { runMigrations } = require("../src/db/migrate");
    api.db.pragma("user_version = 0"); // force the replay path (#202 guard model)
    assert.doesNotThrow(() => runMigrations());
    assert.equal(Number(api.db.pragma("user_version", { simple: true })), 49);
    // End-of-pass convergence: even though frozen 001 re-creates an empty
    // voice_sessions shell mid-pass, 040 drops it again (see migration header).
    assert.equal(api.db.prepare("SELECT name FROM sqlite_master WHERE name='voice_sessions'").get(), undefined);
    assert.match(ddl("users"), /CHECK \(xp BETWEEN 0 AND 9007199254740991\)/);
    // Data survived the replay (the CHECK-guarded rebuild is a no-op now).
    const gOrder = communityKey("g-040-toporder");
    assert.deepEqual(
      api.topUsers(gOrder, 10).map((r) => r.user_id),
      ["b", "c", "a"],
      "XP rows survived the full replay"
    );
  });
});

/**
 * Fail-loud pre-scan (#189/039 precedent): rows written out-of-band that
 * violate the new CHECK must REFUSE the migration BY NAME, leave every row
 * untouched, and never half-apply. Needs a real pre-040 DB (the CHECK would
 * reject the poison insert afterwards), so the fixture runs migrations
 * 001–039 only.
 */
describe("migration 040 fails loud on violating rows (pre-040 fixture)", () => {
  let env;
  let connection;
  let migration;
  let upTo039;

  before(() => {
    env = createTempDbPath();
    process.env.DB_PATH = env.dbPath;
    process.env.DATA_DIR = env.tmpDir;
    if (!process.env.TOKEN_ENCRYPTION_KEY) process.env.TOKEN_ENCRYPTION_KEY = FAKE_TOKEN_ENCRYPTION_KEY;
    resetSrcModules();
    connection = require("../src/db/connection");
    env.dbs.push(connection.db);
    const { migrations } = require("../src/db/migrate");
    upTo039 = {
      now: connection.now,
      tableExists: connection.tableExists,
      getColumns: connection.getColumns,
      addColumnIfMissing: connection.addColumnIfMissing,
      getPrimaryKeyColumns: connection.getPrimaryKeyColumns,
    };
    for (const m of migrations) {
      if (String(m.id ?? "") >= "040") continue; // stop BEFORE the subject
      m.up(connection.db, upTo039);
    }
    migration = require("../src/db/migrations/040_schema_hygiene");
    assert.ok(connection.tableExists("voice_sessions"), "pre-040 fixture still has voice_sessions");
  });

  after(() => env?.cleanup());

  it("a poisoned users row (TEXT 'Infinity') + out-of-domain budget rule are refused BY NAME", () => {
    connection.db
      .prepare(`INSERT INTO users (community_id, user_id, xp, created_at, updated_at) VALUES (7, 'poisoned', 'Infinity', 1, 1)`)
      .run();
    connection.db
      .prepare(`INSERT INTO users (community_id, user_id, xp, created_at, updated_at) VALUES (7, 'negative', -5, 1, 1)`)
      .run();

    assert.throws(
      () => migration.up(connection.db, upTo039),
      (err) =>
        /Migration 040_schema_hygiene refused/.test(err.message) &&
        /users\(community_id=7, user_id=poisoned\) xp=<text> Infinity/.test(err.message) &&
        /users\(community_id=7, user_id=negative\) xp=<integer> -5/.test(err.message) &&
        /UPDATE users SET xp = 0/.test(err.message),
      "error must name the offenders (ids + shape) and the fix"
    );

    // Nothing half-applied: rows untouched, table still present, no CHECK installed.
    assert.equal(
      connection.db.prepare("SELECT COUNT(*) n FROM users WHERE user_id IN ('poisoned','negative')").get().n,
      2,
      "a refused migration never edits rows"
    );
    assert.ok(connection.tableExists("voice_sessions"), "a refused migration never drops the table");
    assert.doesNotMatch(
      connection.db.prepare("SELECT sql FROM sqlite_master WHERE name='users'").get().sql,
      /CHECK \(xp BETWEEN/
    );
  });

  it("out-of-domain gork_budget_rules rows are refused by name too", () => {
    connection.db
      .prepare(`INSERT INTO users (community_id, user_id, xp, created_at, updated_at) VALUES (7, 'good', 5, 1, 1)`)
      .run();
    // users clean again? no — remove the poison so the users gate passes and
    // the gork gate is the thing that fires:
    connection.db.prepare("DELETE FROM users WHERE user_id IN ('poisoned','negative')").run();
    connection.db
      .prepare(`INSERT INTO gork_budget_rules (community_id, scope_kind, target_id, daily_limit, created_at) VALUES (7, 'channel', 'over', 5000, 1)`)
      .run();

    assert.throws(
      () => migration.up(connection.db, upTo039),
      (err) =>
        /Migration 040_schema_hygiene refused/.test(err.message) &&
        /gork_budget_rules\(community_id=7, scope_kind=channel, target_id=over\) daily_limit=<integer> 5000/.test(err.message) &&
        /DELETE the rule/.test(err.message)
    );
    assert.equal(
      connection.db.prepare("SELECT COUNT(*) n FROM gork_budget_rules WHERE target_id='over'").get().n,
      1,
      "the violating rule is never silently rewritten"
    );
    connection.db.prepare("DELETE FROM gork_budget_rules WHERE target_id='over'").run();
  });

  it("once the rows are fixed, 040 applies cleanly and re-runs are no-ops", () => {
    const first = migration.up(connection.db, upTo039);
    assert.deepEqual(first.rebuilt, ["users", "gork_budget_rules"]);
    assert.equal(first.dropped, true);
    assert.equal(connection.tableExists("voice_sessions"), false);

    // The legitimate survivor (xp=5) rode through the rebuild unchanged.
    assert.equal(
      connection.db.prepare("SELECT xp FROM users WHERE user_id='good'").get().xp,
      5
    );

    const second = migration.up(connection.db, upTo039);
    assert.deepEqual(second.rebuilt, [], "replay must skip both rebuilds");
    assert.equal(second.dropped, false);
    assert.match(
      connection.db.prepare("SELECT sql FROM sqlite_master WHERE name='users'").get().sql,
      /CHECK \(xp BETWEEN 0 AND 9007199254740991\)/
    );
  });
});

/**
 * Fresh-DB vs migrated-DB PARITY (issue verification): an old populated DB
 * (seed-pre034: migrations 001–033 + seeded rows, then replays 034→040 in
 * place) and a brand-new DB (001→040 straight through) must end on the SAME
 * schema for every object 040 touches — and both must have NO voice_sessions.
 */
describe("migration 040 fresh-DB ↔ migrated-DB schema parity", () => {
  const TOUCHED = ["users", "gork_budget_rules", "tickets"];

  /** Normalized sqlite_master snapshot for the objects 040 touches. */
  function captureSchema(db) {
    const placeholders = TOUCHED.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT type, name, COALESCE(sql, '') AS sql
         FROM sqlite_master
         WHERE tbl_name IN (${placeholders})
            OR name IN ('idx_users_guild_xp', 'idx_tickets_archived')
         ORDER BY type, name`
      )
      .all(...TOUCHED)
      .map((r) => ({ type: r.type, name: r.name, sql: String(r.sql).replace(/\s+/g, " ").trim() }));
  }

  let migratedSchema;
  let migratedHasVoiceSessions;
  let migratedUsersSurvivors;
  const fixtureCleanupFns = [];

  before(() => {
    // 1) migrated path: seeded pre-034 DB, then run every migration ≥ 034
    //    in place — exactly what an old production DB sees on boot.
    const { createPre034Fixture } = require("./helpers/seed-pre034");
    if (!process.env.TOKEN_ENCRYPTION_KEY) process.env.TOKEN_ENCRYPTION_KEY = FAKE_TOKEN_ENCRYPTION_KEY;
    const fixture = createPre034Fixture();
    fixtureCleanupFns.push(fixture.cleanup);
    const { migrations } = require("../src/db/migrate");
    for (const m of migrations) {
      if (String(m.id ?? "") < "034") continue;
      m.up(fixture.db, fixture.helpers);
    }
    migratedSchema = captureSchema(fixture.db);
    migratedHasVoiceSessions = fixture.db
      .prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'voice_sessions'")
      .get().n;
    migratedUsersSurvivors = fixture.db
      .prepare("SELECT COUNT(*) n FROM users WHERE xp IN (100, 70, 50)")
      .get().n;
    fixture.cleanup();
  });

  after(() => {
    for (const fn of fixtureCleanupFns) fn?.();
  });

  it("the migrated DB lands post-040 too (voice_sessions gone, seeded rows rode the rebuild)", () => {
    assert.equal(migratedHasVoiceSessions, 0, "migrated path: voice_sessions dropped in place");
    assert.ok(migratedUsersSurvivors >= 2, "xp values survived the in-place users rebuild");
  });

  it("fresh-DB and migrated-DB schemas for the touched objects are IDENTICAL", () => {
    const { api, cleanup } = loadDb();
    try {
      const freshSchema = captureSchema(api.db);
      assert.deepEqual(
        freshSchema,
        migratedSchema,
        "fresh-DB and migrated-DB sqlite_master must converge for users/gork_budget_rules/tickets"
      );
      // Sanity (the deepEqual above already pins it): both carry the CHECKs
      // and BOTH indexes, neither carries voice_sessions.
      const users = freshSchema.find((r) => r.name === "users");
      assert.match(users.sql, /CHECK \(xp BETWEEN 0 AND 9007199254740991\)/);
      assert.ok(freshSchema.some((r) => r.name === "idx_users_guild_xp"));
      assert.ok(freshSchema.some((r) => r.name === "idx_tickets_archived"));
      assert.equal(freshSchema.some((r) => r.name === "voice_sessions"), false);
    } finally {
      cleanup?.();
    }
  });
});
