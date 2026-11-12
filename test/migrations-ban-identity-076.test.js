/**
 * Migration 076_ban_identity (#809): the REBUILD + the new column.
 *
 * test/migrations-ban-lifecycle-074.test.js pins the post-076 domain in a
 * FULLY-MIGRATED DB (columns, widened CHECK regex, replay idempotence).
 * What a migrated DB no longer shows is the TRANSITION, and that is this
 * file's whole job (fixture idiom copied from
 * migrations-ban-appeals-075.test.js — chain the registry directly and skip
 * the subject by id order):
 * - a true pre-076 DB (chain 001→075) has NO ban_identity_reason column and
 *   its CHECK REJECTS 'expired_held' — acceptance is THIS migration's doing;
 * - the clean pass reports { rebuilt: true, columnAdded: true }; seeded rows
 *   ride the rebuild with EXPLICIT ids (stable-id law), AUTOINCREMENT
 *   continues past MAX(id), and the ban_appeals child rows keep their
 *   bindings (the foreign_key_check belt inside the migration is real);
 * - the named UNIQUE belts + both plain indexes still bite AFTER the rebuild;
 * - the guarded replay reports { rebuilt: false, columnAdded: false } and
 *   moves nothing;
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

const { id: id076, up: up076 } = require("../src/db/migrations/076_ban_identity");

// Fixed instant — no wall-clock reads anywhere in this file.
const T0 = Date.UTC(2026, 10, 2);

const norm = (sql) => String(sql ?? "").replace(/\s+/g, " ").trim();

const tableDdl = (d, table) =>
  d.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table)?.sql ?? "";

const indexNames = (d, table) =>
  d
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name`)
    .all(table)
    .map((r) => r.name);

const columns = (d, table) => d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

const allBans = (d) =>
  d.prepare("SELECT * FROM ban_records ORDER BY id").all();

/**
 * A DB frozen one migration early: the FULL 001→075 chain run directly, the
 * subject (076) skipped by registry order (041/075 fixture idiom).
 */
function createPre076Fixture() {
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
    if (String(m.id ?? "") >= "076") continue; // skip the subject (+ everything after)
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

/** Direct SQL seed of the pre-076 ban_records shape (explicit id optional). */
function insertBan(d, { id = null, cid, n, userId, status = "active", expiresAt = null }) {
  return d
    .prepare(
      `INSERT INTO ban_records (id, community_id, ban_number, user_id, source, reason,
                                banned_at, expires_at, status, ban_dm_sent, welcome_dm_sent)
       VALUES (?, ?, ?, ?, 'staff', 'pre-076 probe', ?, ?, ?, 0, 0)`
    )
    .run(id, cid, n, userId, T0, expiresAt, status).lastInsertRowid;
}

/** Raw ban_appeals seed (075 shape — the child the rebuild must not orphan). */
function insertAppeal(d, { cid, banRecordId }) {
  return d
    .prepare(
      `INSERT INTO ban_appeals (community_id, ban_record_id, status, appeal_statement,
                                ferry_paused, created_at, updated_at)
       VALUES (?, ?, 'filed', 'pre-076 appeal', 0, ?, ?)`
    )
    .run(cid, banRecordId, T0, T0).lastInsertRowid;
}

describe(`${id076} — the transition on a frozen pre-076 DB`, () => {
  /** @type {ReturnType<typeof createPre076Fixture>} */
  let fx;
  let cid;

  before(() => {
    fx = createPre076Fixture();
    cid = addCommunity(fx.db, "809-fixture");
    // Explicit ids across the board: id survival is the stable-id contract.
    insertBan(fx.db, { id: 41, cid, n: 1, userId: "u-terminal", status: "expired_unbanned" });
    insertBan(fx.db, { id: 42, cid, n: 2, userId: "u-held-soon", expiresAt: T0 + 1000 });
    insertAppeal(fx.db, { cid, banRecordId: 42 }); // the FK child rides too
    insertBan(fx.db, { cid, n: 3, userId: "u-auto" }); // AUTOINCREMENT assignment (id 43)
  });
  after(() => fx?.env?.cleanup());

  it("the fixture IS pre-076: no identity column, the narrow CHECK REFUSES expired_held", () => {
    // RED the moment the fixture chain silently includes 076.
    assert.equal(columns(fx.db, "ban_records").includes("ban_identity_reason"), false);
    assert.doesNotMatch(norm(tableDdl(fx.db, "ban_records")), /'expired_held'/);
    assert.throws(
      () => fx.db.prepare("UPDATE ban_records SET status='expired_held' WHERE id=42").run(),
      /CHECK constraint failed/,
      "acceptance of expired_held must be THIS migration's doing, not the CHECK's luck"
    );
  });

  it("the clean pass: summary contract + pragma restored + column and CHECK appended at the END", () => {
    const fkWasOn = fx.db.pragma("foreign_keys", { simple: true });
    const summary = up076(fx.db, fx.helpers);
    assert.deepEqual(summary, { rebuilt: true, columnAdded: true }, "summary contract");
    assert.equal(fx.db.pragma("foreign_keys", { simple: true }), fkWasOn, "pragma finally-restore");

    assert.equal(columns(fx.db, "ban_records").at(-1), "ban_identity_reason", "column APPENDS");
    assert.match(
      norm(tableDdl(fx.db, "ban_records")),
      /status IN \('active','expired_unbanned','unbanned_manual','pending_rejoin','welcomed','clemency_granted','expired_held'\)/,
      "the held status APPENDS to the domain — nothing reordered or removed"
    );
  });

  it("held is now WRITABLE, the identity column round-trips, garbage stays outside", () => {
    fx.db
      .prepare("UPDATE ban_records SET status='expired_held', ban_identity_reason='the story we issued' WHERE id=42")
      .run();
    const row = fx.db.prepare("SELECT status, ban_identity_reason FROM ban_records WHERE id=42").get();
    assert.equal(row.status, "expired_held");
    assert.equal(row.ban_identity_reason, "the story we issued");

    assert.throws(
      () => fx.db.prepare("UPDATE ban_records SET status='totally_made_up' WHERE id=41").run(),
      /CHECK constraint failed/
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
    // u-held-soon left the ACTIVE domain (held above) → a NEW active ban
    // for them is legitimate, proving the partial index follows statuses.
    const fresh = insertBan(fx.db, { cid, n: 78, userId: "u-held-soon" });
    assert.ok(Number(fresh) > 43);
  });

  it("the guarded replay reports nothing changed and moves nothing", () => {
    const before = allBans(fx.db);
    const colsBefore = columns(fx.db, "ban_records");
    const replay = up076(fx.db, fx.helpers);
    assert.deepEqual(replay, { rebuilt: false, columnAdded: false });
    assert.deepEqual(allBans(fx.db), before, "zero row movement");
    assert.deepEqual(columns(fx.db, "ban_records"), colsBefore, "zero column churn");
  });
});

describe(`${id076} — shape drift refuses loudly and installs nothing`, () => {
  it("a ban_records DDL without a derivable status IN-list: named refusal, ZERO residue", () => {
    // Hand-built micro-DB: only what up() touches (075's drift idiom runs
    // against a loaded connection; a raw connection keeps this hermetic).
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
          up076(d, {
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
          /Migration 076_ban_identity refused/.test(err.message) &&
          /could not be derived from the live schema/.test(err.message),
        "the refusal names the migration and the derivability failure"
      );
      // Transaction doctrine (#813 law): the ALTER ADD COLUMN ran BEFORE the
      // throw INSIDE the transaction — a clean rollback means the appended
      // column is GONE. Zero residue, table untouched, pragma restored.
      assert.deepEqual(
        d.prepare("PRAGMA table_info(ban_records)").all().map((c) => c.name),
        ["id", "status"],
        "the refused pass leaves NOTHING behind (transaction rollback)"
      );
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
      const tableExists = (name) =>
        !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
      assert.throws(
        () => up076(d, { tableExists, addColumnIfMissing: () => false }),
        /076_ban_identity: the 'ban_records' table is missing/
      );
    } finally {
      env.cleanup();
    }
  });
});
