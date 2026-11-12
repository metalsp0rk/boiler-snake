/**
 * Migration 077_expiry_quarantine (#810): the REBUILD + the attempt counter +
 * the reconcile-rotation table.
 *
 * test/migrations-ban-lifecycle-074.test.js pins the post-077 domain in a
 * FULLY-MIGRATED DB (columns, widened CHECK regex). What a migrated DB no
 * longer shows is the TRANSITION, and that is this file's whole job (fixture
 * idiom copied from migrations-ban-identity-076.test.js — chain the registry
 * directly and skip the subject by id order):
 * - a true pre-077 DB (chain 001→076) has NO expiry_attempts column, NO
 *   ban_reconcile_state table, and its CHECK REJECTS 'expiry_failed' —
 *   acceptance is THIS migration's doing;
 * - the clean pass reports { rebuilt: true, columnAdded: true, stateTable:
 *   true }; seeded rows ride the rebuild with EXPLICIT ids (stable-id law),
 *   AUTOINCREMENT continues past MAX(id), and the ban_appeals child rows keep
 *   their bindings (the foreign_key_check belt inside the migration is real);
 * - the counter backfills 0 on every existing row (NOT NULL DEFAULT 0 — the
 *   SQLite-legal form of NOT-NULL-on-existing-rows);
 * - the named UNIQUE belts + both plain indexes still bite AFTER the rebuild;
 * - ban_reconcile_state's FK CASCADES on community delete (a bot that left a
 *   guild stops tracking its rotation stamp);
 * - the guarded replay reports { rebuilt: false, columnAdded: false,
 *   stateTable: false }, moves NOTHING, and KEEPS recorded stamps (the
 *   IF-NOT-EXISTS never drops the table);
 * - shape-drift fail-loud: a ban_records DDL whose status IN-list cannot be
 *   derived is REFUSED — names itself, installs NOTHING (the transaction
 *   rolls the appended column back too), pragma restored.
 *
 * Header contract: loadDb() runs ABOVE every src/ require. Fixed instants
 * only — no wall-clock reads anywhere in this file.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const {
  loadDb,
  createTempDbPath,
  resetSrcModules,
  FAKE_TOKEN_ENCRYPTION_KEY,
} = require("./helpers/env");
const { cleanup } = loadDb();
after(cleanup);

const { id: id077, up: up077 } = require("../src/db/migrations/077_expiry_quarantine");

// Fixed instant — no wall-clock reads anywhere in this file.
const T0 = Date.UTC(2026, 10, 3);

const norm = (sql) => String(sql ?? "").replace(/\s+/g, " ").trim();

const tableDdl = (d, table) =>
  d.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table)?.sql ?? "";

const indexNames = (d, table) =>
  d
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name`)
    .all(table)
    .map((r) => r.name);

const columns = (d, table) => d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

const allBans = (d) => d.prepare("SELECT * FROM ban_records ORDER BY id").all();

/**
 * A DB frozen one migration early: the FULL 001→076 chain run directly, the
 * subject (077) skipped by registry order (041/075/076 fixture idiom).
 */
function createPre077Fixture() {
  const env = createTempDbPath();
  process.env.DB_PATH = env.dbPath;
  process.env.DATA_DIR = env.tmpDir;
  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    process.env.TOKEN_ENCRYPTION_KEY = FAKE_TOKEN_ENCRYPTION_KEY;
  }
  resetSrcModules();
  const connection = require("../src/db/connection");
  env.dbs.push(connection.db);
  const helpers = {
    now: connection.now,
    tableExists: connection.tableExists,
    getColumns: connection.getColumns,
    addColumnIfMissing: connection.addColumnIfMissing,
    getPrimaryKeyColumns: connection.getPrimaryKeyColumns,
  };
  const { migrations } = require("../src/db/migrate");
  for (const m of migrations) {
    if (String(m.id ?? "") >= "077") continue; // skip the subject (+ everything after)
    m.up(connection.db, helpers);
  }
  return { env, db: connection.db, helpers };
}

/** Raw communities insert (communityKey would bind through the require cache). */
function addCommunity(d, externalGuildId) {
  return d
    .prepare(
      `INSERT INTO communities (platform, instance_key, external_guild_id, created_at)
       VALUES ('discord', 'discord', ?, ?)`
    )
    .run(externalGuildId, T0).lastInsertRowid;
}

/** Direct SQL seed of the pre-077 ban_records shape (explicit id optional). */
function insertBan(d, { id = null, cid, n, userId, status = "active", expiresAt = null }) {
  return d
    .prepare(
      `INSERT INTO ban_records (id, community_id, ban_number, user_id, source, reason,
                                banned_at, expires_at, status, ban_dm_sent, welcome_dm_sent)
       VALUES (?, ?, ?, ?, 'staff', 'pre-077 probe', ?, ?, ?, 0, 0)`
    )
    .run(id, cid, n, userId, T0, expiresAt, status).lastInsertRowid;
}

/** Raw ban_appeals seed (075 shape — the child the rebuild must not orphan). */
function insertAppeal(d, { cid, banRecordId }) {
  return d
    .prepare(
      `INSERT INTO ban_appeals (community_id, ban_record_id, status, appeal_statement,
                                ferry_paused, created_at, updated_at)
       VALUES (?, ?, 'filed', 'pre-077 appeal', 0, ?, ?)`
    )
    .run(cid, banRecordId, T0, T0).lastInsertRowid;
}

describe(`${id077} — the transition on a frozen pre-077 DB`, () => {
  /** @type {ReturnType<typeof createPre077Fixture>} */
  let fx;
  let cid;

  before(() => {
    fx = createPre077Fixture();
    cid = addCommunity(fx.db, "810-fixture");
    // Explicit ids across the board: id survival is the stable-id contract.
    insertBan(fx.db, { id: 41, cid, n: 1, userId: "u-terminal", status: "expired_unbanned" });
    insertBan(fx.db, { id: 42, cid, n: 2, userId: "u-quarantine-soon", expiresAt: T0 + 1000 });
    insertAppeal(fx.db, { cid, banRecordId: 42 }); // the FK child rides too
    insertBan(fx.db, { cid, n: 3, userId: "u-auto" }); // AUTOINCREMENT assignment (id 43)
  });
  after(() => fx?.env?.cleanup());

  it("the fixture IS pre-077: no counter, no state table, the narrow CHECK REFUSES expiry_failed", () => {
    // RED the moment the fixture chain silently includes 077.
    assert.equal(columns(fx.db, "ban_records").includes("expiry_attempts"), false);
    assert.equal(tableDdl(fx.db, "ban_reconcile_state"), "", "the rotation table is THIS migration's doing");
    assert.doesNotMatch(norm(tableDdl(fx.db, "ban_records")), /'expiry_failed'/);
    assert.throws(
      () => fx.db.prepare("UPDATE ban_records SET status='expiry_failed' WHERE id=42").run(),
      /CHECK constraint failed/,
      "acceptance of expiry_failed must be THIS migration's doing, not the CHECK's luck"
    );
  });

  it("the clean pass: summary contract + pragma restored + counter and CHECK append at the END", () => {
    const fkWasOn = fx.db.pragma("foreign_keys", { simple: true });
    const summary = up077(fx.db, fx.helpers);
    assert.deepEqual(
      summary,
      { rebuilt: true, columnAdded: true, stateTable: true },
      "summary contract"
    );
    assert.equal(fx.db.pragma("foreign_keys", { simple: true }), fkWasOn, "pragma finally-restore");

    assert.equal(columns(fx.db, "ban_records").at(-1), "expiry_attempts", "the counter APPENDS at the END");
    assert.match(
      norm(tableDdl(fx.db, "ban_records")),
      /status IN \('active','expired_unbanned','unbanned_manual','pending_rejoin','welcomed','clemency_granted','expired_held','expiry_failed'\)/,
      "the quarantine status APPENDS to the domain — nothing reordered or removed"
    );
  });

  it("the counter backfills 0 on every pre-existing row, expiry_failed becomes WRITABLE, garbage stays outside", () => {
    assert.deepEqual(
      fx.db.prepare("SELECT expiry_attempts FROM ban_records ORDER BY id").all().map((r) => r.expiry_attempts),
      [0, 0, 0],
      "NOT NULL DEFAULT 0: every legacy row starts clean"
    );

    fx.db
      .prepare("UPDATE ban_records SET status='expiry_failed', expiry_attempts=20 WHERE id=42")
      .run();
    const row = fx.db.prepare("SELECT status, expiry_attempts FROM ban_records WHERE id=42").get();
    assert.equal(row.status, "expiry_failed");
    assert.equal(row.expiry_attempts, 20);

    assert.throws(
      () => fx.db.prepare("UPDATE ban_records SET status='totally_made_up' WHERE id=41").run(),
      /CHECK constraint failed/
    );
    assert.throws(
      () => fx.db.prepare("UPDATE ban_records SET expiry_attempts=NULL WHERE id=41").run(),
      /NOT NULL constraint failed/,
      "the counter can never be NULL"
    );
  });

  it("explicit ids survived, the sequence CONTINUES past MAX(id), the child kept its binding", () => {
    const next = insertBan(fx.db, { cid, n: 4, userId: "u-fresh" });
    assert.ok(Number(next) > 43, `fresh id ${next} continues past the pre-rebuild MAX(43)`);
    assert.deepEqual(fx.db.prepare("PRAGMA foreign_key_check(ban_appeals)").all(), []);
    const appeal = fx.db.prepare("SELECT ban_record_id, status FROM ban_appeals").get();
    assert.equal(appeal.ban_record_id, 42, "the appeal still points at the SAME row id");
  });

  it("the named belts + plain indexes still bite AFTER the rebuild", () => {
    assert.deepEqual(indexNames(fx.db, "ban_records"), [
      "idx_ban_records_due",
      "idx_ban_records_user",
      "uq_ban_records_active",
      "uq_ban_records_number",
    ]);
    // B-n uniqueness (row 41 keeps its number even though terminal).
    assert.throws(() => insertBan(fx.db, { cid, n: 2, userId: "u-dupnum" }), /UNIQUE/i,
      "uq_ban_records_number");
    // One ACTIVE row per (community,user): u-auto is ACTIVE (id 43).
    assert.throws(() => insertBan(fx.db, { cid, n: 77, userId: "u-auto" }), /UNIQUE/i,
      "uq_ban_records_active");
    // u-quarantine-soon left the ACTIVE domain (expiry_failed above) → a NEW
    // active ban for them is legitimate, proving the partial index follows
    // statuses.
    const fresh = insertBan(fx.db, { cid, n: 78, userId: "u-quarantine-soon" });
    assert.ok(Number(fresh) > 43);
  });

  it("ban_reconcile_state: one stamp per community, NOT NULL clock, FK CASCADE on community delete", () => {
    const other = addCommunity(fx.db, "810-stamped");
    fx.db
      .prepare("INSERT INTO ban_reconcile_state (community_id, last_reconciled_at) VALUES (?, ?)")
      .run(other, T0 + 5);
    // PK: one row per community (the repo's upsert rides this).
    assert.throws(
      () =>
        fx.db
          .prepare("INSERT INTO ban_reconcile_state (community_id, last_reconciled_at) VALUES (?, ?)")
          .run(other, T0 + 9),
      /UNIQUE|PRIMARY KEY/i
    );
    // NOT NULL clock.
    assert.throws(
      () =>
        fx.db
          .prepare("INSERT INTO ban_reconcile_state (community_id, last_reconciled_at) VALUES (?, ?)")
          .run(cid, null),
      /NOT NULL constraint failed/
    );
    // FK + CASCADE: unknown communities never enter; deletes rotate the state away.
    assert.throws(
      () =>
        fx.db
          .prepare("INSERT INTO ban_reconcile_state (community_id, last_reconciled_at) VALUES (?, ?)")
          .run(999999, T0),
      /FOREIGN KEY constraint failed/
    );
    fx.db.prepare("DELETE FROM communities WHERE id=?").run(other);
    assert.equal(
      fx.db.prepare("SELECT COUNT(*) AS c FROM ban_reconcile_state WHERE community_id=?").get(other).c,
      0,
      "a departed guild stops being tracked (ON DELETE CASCADE)"
    );
  });

  it("the guarded replay reports nothing changed, moves nothing, and KEEPS recorded stamps", () => {
    const keep = addCommunity(fx.db, "810-keep");
    fx.db
      .prepare("INSERT INTO ban_reconcile_state (community_id, last_reconciled_at) VALUES (?, ?)")
      .run(keep, T0 + 77);

    const before = allBans(fx.db);
    const colsBefore = columns(fx.db, "ban_records");
    const replay = up077(fx.db, fx.helpers);
    assert.deepEqual(replay, { rebuilt: false, columnAdded: false, stateTable: false });
    assert.deepEqual(allBans(fx.db), before, "zero row movement");
    assert.deepEqual(columns(fx.db, "ban_records"), colsBefore, "zero column churn");
    assert.equal(
      fx.db.prepare("SELECT last_reconciled_at FROM ban_reconcile_state WHERE community_id=?").get(keep)
        .last_reconciled_at,
      T0 + 77,
      "the IF-NOT-EXISTS never drops the table — rotation state SURVIVES a replay"
    );
  });
});

describe(`${id077} — shape drift refuses loudly and installs nothing`, () => {
  it("a ban_records DDL without a derivable status IN-list: named refusal, ZERO residue", () => {
    // Hand-built micro-DB: only what up() touches (the 076 drift idiom — a
    // raw connection keeps this hermetic).
    const env = createTempDbPath();
    try {
      const Database = require("better-sqlite3");
      const d = new Database(env.dbPath);
      env.dbs.push(d);
      d.pragma("foreign_keys = ON");
      d.exec(`
CREATE TABLE ban_records (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL
);
INSERT INTO ban_records (id, status) VALUES (1, 'active');
`);
      assert.throws(
        () =>
          up077(d, {
            tableExists: (name) =>
              !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
            addColumnIfMissing: (table, column, ddl) => {
              const has = d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
              if (has) return false;
              d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
              return true;
            },
          }),
        (err) =>
          /Migration 077_expiry_quarantine refused/.test(err.message) &&
          /could not be derived from the live schema/.test(err.message),
        "the refusal names the migration and the derivability failure"
      );
      // Transaction doctrine (#813 law): the ALTER ADD COLUMN ran BEFORE the
      // throw INSIDE the transaction — a clean rollback means the appended
      // column is GONE and the state table never existed. Zero residue,
      // table untouched, pragma restored.
      assert.deepEqual(
        d.prepare("PRAGMA table_info(ban_records)").all().map((c) => c.name),
        ["id", "status"],
        "the refused pass leaves NOTHING behind (transaction rollback)"
      );
      assert.equal(tableDdl(d, "ban_reconcile_state"), "", "no orphan state table on the refused pass");
      assert.equal(d.prepare("SELECT status FROM ban_records WHERE id=1").get().status, "active");
      assert.equal(d.pragma("foreign_keys", { simple: true }), 1, "pragma finally-restore on the throw path");
    } finally {
      env.cleanup();
    }
  });

  it("a missing ban_records table names its own prerequisite", () => {
    const env = createTempDbPath();
    try {
      const Database = require("better-sqlite3");
      const d = new Database(env.dbPath);
      env.dbs.push(d);
      const exists = (name) =>
        !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
      assert.throws(
        () => up077(d, { tableExists: exists, addColumnIfMissing: () => false }),
        /077_expiry_quarantine: the 'ban_records' table is missing/
      );
    } finally {
      env.cleanup();
    }
  });
});
