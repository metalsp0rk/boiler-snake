const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// #609: this file LOADS src modules whose require chain reaches src/db —
// connection.js opens DB_PATH at REQUIRE time, so bind a private temp DB
// BEFORE anything else loads. Concurrent node --test files sharing one
// ambient DB_PATH race mid-migration (the #470 G2-6 gork flake class).
const { loadDb } = require("./helpers/env");
const { cleanup: cleanupTempDb } = loadDb();
after(cleanupTempDb);

const Database = require("better-sqlite3");

// #429 (audit XE-2): rows written BEFORE the clamp could carry cooldowns far
// beyond what the in-memory sweeper honored (msgcooldown 86400 behaved as
// 6h). Migration 050 pulls every out-of-range row inside the config max so
// the (now horizon-matched) sweep can never truncate it.
const { id, up } = require("../src/db/migrations/050_xp_cooldown_clamp");

describe(`${id} — legacy cooldown rows clamp to one day`, () => {
  const seed = () => {
    const db = new Database(":memory:");
    db.prepare(
      `CREATE TABLE guild_settings (
         community_id TEXT PRIMARY KEY,
         msg_cooldown_sec INTEGER NOT NULL DEFAULT 20,
         reaction_cooldown_sec INTEGER NOT NULL DEFAULT 10
       )`,
    ).run();
    db.prepare(
      `INSERT INTO guild_settings (community_id, msg_cooldown_sec, reaction_cooldown_sec) VALUES
         ('wild',  90000, 90001),
         ('ok',    20,    10),
         ('edge',  86400, 86401)`,
    ).run();
    return db;
  };

  it("clamps only the out-of-range values, leaves valid ones untouched", () => {
    const db = seed();
    up(db);
    const rows = Object.fromEntries(
      db
        .prepare(`SELECT community_id, msg_cooldown_sec, reaction_cooldown_sec FROM guild_settings`)
        .all()
        .map((r) => [r.community_id, [r.msg_cooldown_sec, r.reaction_cooldown_sec]]),
    );
    assert.deepEqual(rows.wild, [86_400, 86_400], "both columns clamp");
    assert.deepEqual(rows.ok, [20, 10], "valid rows are never touched");
    assert.deepEqual(rows.edge, [86_400, 86_400], "86400 stays; 86401 clamps");
  });

  it("is idempotent (migration replays cleanly)", () => {
    const db = seed();
    up(db);
    up(db);
    assert.equal(
      db.prepare(`SELECT msg_cooldown_sec c FROM guild_settings WHERE community_id='wild'`).get().c,
      86_400,
    );
  });
});
