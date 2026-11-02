/**
 * Migration 075_ban_appeals guard (#773): the REBUILD itself.
 *
 * test/migrations-ban-lifecycle-074.test.js already pins the 075 domain in a
 * FULLY-MIGRATED DB — wiring, boot guards, the widened-DDL regex, the
 * ban_appeals column/index shape, raw CHECK accept/reject, the one-per-cycle
 * UNIQUE text, FK unscoped/dangling/cascade, the toggle default, and direct +
 * full-replay idempotence. Those pins prove WHAT the schema says; they cannot
 * prove HOW the ban_records CHECK rebuild got there. This file owns exactly
 * the transition a migrated DB no longer shows (sibling precedent:
 * migrations-heal-041.test.js builds its pre-state by chaining migrations
 * directly and skipping the subject):
 * - a true pre-075 DB (chain 001→074) rejects `clemency_granted` — ACCEPTANCE
 *   is this migration's doing, not the CHECK's luck;
 * - the clean pass reports { rebuilt: true, settingAdded: true } (the summary
 *   contract) and restores the foreign_keys pragma;
 * - every seeded 074 row rides the rebuild byte-identically (explicit ids,
 *   B-n, statuses, flags), AUTOINCREMENT continues past MAX(id) — nothing
 *   renumbers (the `appeal:<banRecordId>` stable-id law);
 * - both named UNIQUE belts and the partial-active index still bite AFTER the
 *   rebuild; garbage statuses stay outside the widened domain;
 * - pre-existing guild_settings rows gain ban_appeals DEFAULT 1 (ALTER ADD
 *   COLUMN onto live rows);
 * - the guarded replay: re-run reports { rebuilt: false, settingAdded: false }
 *   and moves nothing;
 * - shape-drift fail-loud: DDL without a derivable status IN-list is REFUSED
 *   (names itself, installs nothing, leaves the pragma ON).
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
const { api: db, cleanup } = loadDb();
after(cleanup);

const { id: id075, up: up075 } = require("../src/db/migrations/075_ban_appeals");
// Bound to THIS file's main (fully migrated) connection; the fixture/sandbox
// below build their own connection-bound helper sets (041 law: helpers are
// per-connection objects, never smuggled across DBs).
const { tableExists, addColumnIfMissing } = require("../src/db/connection");

// Fixed instant — no wall-clock reads anywhere in this file.
const T0 = Date.UTC(2026, 10, 1);

/** Whitespace-normalized SQL (migration-side comparison idiom, 040). */
const norm = (sql) => String(sql ?? "").replace(/\s+/g, " ").trim();

const tableDdl = (d, table) =>
  d.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table)?.sql ?? "";

const tableNames = (d) =>
  d.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r) => r.name);

const indexNames = (d, table) =>
  d
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name`)
    .all(table)
    .map((r) => r.name);

const columns = (d, table) => d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

const settingsCols = (d) => columns(d, "guild_settings");

/**
 * A DB frozen one migration early: the FULL 001→074 chain run directly with
 * the subject migration (075) and everything after it skipped by registry
 * order. Exactly the 041-suite fixture idiom — `id >= "075"` string-compares
 * the numbered migration ids.
 */
function createPre075Fixture() {
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
    if (String(m.id ?? "") >= "075") continue; // skip the subject + everything after
    m.up(connection.db, helpers);
  }
  return { env, db: connection.db, helpers };
}

/** Raw communities insert (communityKey would bind through the require cache). */
function addCommunity(d, externalGuildId) {
  return d
    .prepare(
      `INSERT INTO communities (platform, instance_key, external_guild_id, created_at)
       VALUES ('discord', 'discord', ?, ?)`,
    )
    .run(externalGuildId, T0).lastInsertRowid;
}

/**
 * Direct SQL seed of the 074 table shape — explicit ids included, because id
 * survival across the rebuild is the whole point (040-style copy law).
 * `id: null` = AUTOINCREMENT assignment (better-sqlite3 binds null, never
 * undefined).
 */
function insertPreBan(d, { id = null, cid, n, userId, status = "active", expiresAt = null, over = {} } = {}) {
  const row = {
    reason: "pre-075 probe",
    bannedAt: T0,
    source: "staff",
    banDmSent: 0,
    welcomeDmSent: 0,
    unbanClaimedAt: null,
    unbanReason: null,
    ...over,
  };
  return d
    .prepare(
      `INSERT INTO ban_records (id, community_id, ban_number, user_id, source, reason,
                                banned_at, expires_at, status, ban_dm_sent, welcome_dm_sent,
                                unban_claimed_at, unban_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      cid,
      n,
      userId,
      row.source,
      row.reason,
      row.bannedAt,
      expiresAt,
      status,
      row.banDmSent,
      row.welcomeDmSent,
      row.unbanClaimedAt,
      row.unbanReason,
    ).lastInsertRowid;
}

const allBans = (d) => d.prepare(`SELECT * FROM ban_records ORDER BY id`).all();

// ---------------------------------------------------------------------------
// The migrated-DB lane: the summary-flag contract of a guarded replay. (The
// 074-guard file pins the no-op SIDE of the replay — schema stable, rows
// preserved; it only asserts doesNotThrow on the call itself. The RETURN
// VALUES are this file's pin.) Declared first so it runs before the fixture
// describes reset the src require cache.
// ---------------------------------------------------------------------------

describe(`${id075} — re-run on a healthy migrated DB reports the honest flags`, () => {
  it("up() on the fully migrated DB is {rebuilt:false, settingAdded:false} (CHECK-guarded)", () => {
    const summary = up075(db.db, { tableExists, addColumnIfMissing });
    assert.deepEqual(summary, { rebuilt: false, settingAdded: false });
    // The widened CHECK rides the DDL itself — the replay must have skipped
    // the rebuild, not re-run it into the same answer.
    assert.match(norm(tableDdl(db.db, "ban_records")), /'clemency_granted'/);
  });
});

// ---------------------------------------------------------------------------
// The pre-075 lane: true transition battery on a chain-frozen DB.
// ---------------------------------------------------------------------------

describe(`${id075} — rebuilds a TRUE pre-075 DB (rows, ids, belts, toggle all survive)`, () => {
  let fixture;
  const GUILD_A = "1773000000000000001";
  const GUILD_B = "1773000000000000002";
  let cidA;
  let cidB;
  let preRows = [];

  before(() => {
    fixture = createPre075Fixture();
    cidA = addCommunity(fixture.db, GUILD_A);
    cidB = addCommunity(fixture.db, GUILD_B);
    // A live settings row per community PRE-migration — the ALTER must land
    // the toggle onto rows that already exist.
    fixture.db
      .prepare(`INSERT INTO guild_settings (community_id, updated_at) VALUES (?, ?), (?, ?)`)
      .run(cidA, T0, cidB, T0);
    // The five 074 statuses + a closed duplicate (partial-unique witness) +
    // a second community. Explicit ids: 100…106 — MAX(id) is 106.
    [
      insertPreBan(fixture.db, { id: 100, cid: cidA, n: 1, userId: "075-x-active", over: { banDmSent: 1 } }),
      insertPreBan(fixture.db, {
        id: 101, cid: cidA, n: 2, userId: "075-x-expired", status: "expired_unbanned",
        over: { unbanClaimedAt: T0, unbanReason: "expired" },
      }),
      insertPreBan(fixture.db, { id: 102, cid: cidA, n: 3, userId: "075-x-manual", status: "unbanned_manual" }),
      insertPreBan(fixture.db, { id: 103, cid: cidA, n: 4, userId: "075-x-park", status: "pending_rejoin" }),
      insertPreBan(fixture.db, {
        id: 104, cid: cidA, n: 5, userId: "075-x-welcome", status: "welcomed", over: { welcomeDmSent: 1 },
      }),
      insertPreBan(fixture.db, { id: 105, cid: cidB, n: 1, userId: "075-y-active" }),
      insertPreBan(fixture.db, { id: 106, cid: cidA, n: 6, userId: "075-x-welcome", status: "welcomed" }),
    ].forEach((insertedId, i) => assert.equal(insertedId, 100 + i, "explicit ids land as given"));
    // Pre-repair snapshot for the byte-equality assertion (041-suite idiom).
    preRows = allBans(fixture.db);
  });

  after(() => fixture?.env?.cleanup());

  it("the fixture IS pre-075: no appeals table, no toggle, and the narrow CHECK REFUSES clemency_granted", () => {
    // Acceptance is migration 075's doing — this test throws RED the moment
    // the fixture chain silently includes 075 or 074 is edited in place.
    assert.ok(!tableNames(fixture.db).includes("ban_appeals"), "ban_appeals must not exist yet");
    assert.ok(!settingsCols(fixture.db).includes("ban_appeals"), "the toggle must not exist yet");
    assert.doesNotMatch(norm(tableDdl(fixture.db, "ban_records")), /'clemency_granted'/);

    assert.throws(
      () => insertPreBan(fixture.db, { id: 199, cid: cidA, n: 90, userId: "075-pre-clemency", status: "clemency_granted" }),
      /CHECK constraint failed/,
      "the 074 domain is still narrow on the frozen DB",
    );
    assert.equal(
      fixture.db.prepare(`SELECT id FROM ban_records WHERE id=?`).get(199),
      undefined,
      "the refusal stored nothing",
    );
    assert.equal(preRows.length, 7, "seven pre-075 rows are the fixture's spine");
  });

  it("the clean pass rebuilds, creates the table, adds the toggle — and restores foreign_keys", () => {
    assert.equal(fixture.db.pragma("foreign_keys", { simple: true }), 1, "fixture connection: FK ON at rest");

    const summary = up075(fixture.db, fixture.helpers);
    assert.deepEqual(summary, { rebuilt: true, settingAdded: true }, "the summary tells exactly what the pass did");

    assert.equal(fixture.db.pragma("foreign_keys", { simple: true }), 1, "the OFF-toggle rides a finally — restored");
    assert.ok(tableNames(fixture.db).includes("ban_appeals"));
    assert.ok(settingsCols(fixture.db).includes("ban_appeals"));
    assert.equal(
      fixture.db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'ban_records_075%'`).get().n,
      0,
      "no staging debris may linger (040 law)",
    );
  });

  it("every seeded row rode the rebuild byte-identically — ids, B-n, statuses, flags (nothing renumbered)", () => {
    // The honest path: full-row snapshots taken pre-repair, deep-compared
    // post-repair (041-suite discipline). SELECT * ORDER BY id is the exact
    // read the 040 copy's explicit-column list promises.
    const after = allBans(fixture.db);
    assert.deepEqual(after, preRows, "row-for-row byte-identity across the rebuild");
    assert.deepEqual(after.map((r) => r.id), [100, 101, 102, 103, 104, 105, 106], "ids copied explicitly");
    const first = after[0];
    assert.equal(first.ban_number, 1, "B-n rides unchanged (UNIQUE law)");
    assert.equal(first.ban_dm_sent, 1, "flag columns copied, not defaulted");
    assert.equal(first.reason, "pre-075 probe");
    const expired = after.find((r) => r.id === 101);
    assert.equal(expired.unban_claimed_at, T0, "epoch columns survive as integers");
    assert.equal(expired.unban_reason, "expired");
    assert.equal(after.find((r) => r.id === 104).welcome_dm_sent, 1);
  });

  it("the widened domain: clemency_granted ACCEPTED post-rebuild, garbage still REFUSED", () => {
    // Light-touch here — the deep CHECK-text regex + fresh-chain domain pins
    // live in migrations-ban-lifecycle-074.test.js. This is the rebuild's
    // before/after pair against the fixture's narrow-CHECK rejection above.
    assert.doesNotThrow(
      () =>
        fixture.db
          .prepare(
            `INSERT INTO ban_records (community_id, ban_number, user_id, source, reason, banned_at, status)
             VALUES (?, 40, '075-post-clemency', 'staff', 'appeal granted', ?, 'clemency_granted')`,
          )
          .run(cidA, T0),
      "the promised append landed",
    );
    for (const status of ["ACTIVE", "unbanned", ""]) {
      assert.throws(
        () =>
          fixture.db
            .prepare(
              `INSERT INTO ban_records (community_id, ban_number, user_id, source, reason, banned_at, status)
               VALUES (?, 41, ?, 'staff', 'probe', ?, ?)`,
            )
            .run(cidA, `075-post-bad-${status}`, T0, status),
        /CHECK constraint failed/,
        `status ${JSON.stringify(status)} stayed outside the widened domain`,
      );
    }
  });

  it("both named UNIQUE belts + the partial-active index still bite on the REBUILT table", () => {
    // Rebuild re-issued the captured index SQL — deep fresh-chain pins live
    // in the 074-guard file; this proves the REBUILD kept them.
    assert.deepEqual(indexNames(fixture.db, "ban_records"), [
      "idx_ban_records_due",
      "idx_ban_records_user",
      "uq_ban_records_active",
      "uq_ban_records_number",
    ]);
    assert.throws(
      () =>
        fixture.db
          .prepare(
            `INSERT INTO ban_records (community_id, ban_number, user_id, source, reason, banned_at, status)
             VALUES (?, 1, '075-num-collide', 'staff', 'probe', ?, 'active')`,
          )
          .run(cidA, T0), // (cidA, 1) is taken by id 100
      /UNIQUE constraint failed: ban_records\.community_id, ban_records\.ban_number/,
    );
    assert.doesNotThrow(
      () =>
        fixture.db
          .prepare(
            `INSERT INTO ban_records (community_id, ban_number, user_id, source, reason, banned_at, status)
             VALUES (?, 2, '075-num-ok-b', 'staff', 'probe', ?, 'active')`,
          )
          .run(cidB, T0), // cidB only owns n=1 — per-community law survives the rebuild
    );
    assert.throws(
      () =>
        fixture.db
          .prepare(
            `INSERT INTO ban_records (community_id, ban_number, user_id, source, reason, banned_at, status)
             VALUES (?, 42, '075-x-active', 'staff', 'probe', ?, 'active')`,
          )
          .run(cidA, T0), // id 100 is still ACTIVE on this user
      /UNIQUE constraint failed: ban_records\.community_id, ban_records\.user_id/,
      "the partial-unique active-ban belt survived the rebuild",
    );
  });

  it("ids are never renumbered: AUTOINCREMENT continues past MAX(seed id)", () => {
    // The `appeal:<banRecordId>` customId seam survives restarts only while
    // ids move strictly forward.
    const fresh = insertPreBan(fixture.db, { cid: cidB, n: 43, userId: "075-forward" });
    assert.ok(fresh > 106, `new id ${fresh} must exceed MAX(seed id)=106`);
  });

  it("pre-existing guild_settings rows gained ban_appeals DEFAULT 1 (ALTER onto live rows) — and round-trips", () => {
    for (const cid of [cidA, cidB]) {
      assert.equal(
        fixture.db.prepare(`SELECT ban_appeals FROM guild_settings WHERE community_id=?`).get(cid).ban_appeals,
        1,
        "intake default-ON lands on rows that predate the column",
      );
    }
    fixture.db.prepare(`UPDATE guild_settings SET ban_appeals=0 WHERE community_id=?`).run(cidA);
    assert.equal(fixture.db.prepare(`SELECT ban_appeals FROM guild_settings WHERE community_id=?`).get(cidA).ban_appeals, 0);
    fixture.db.prepare(`UPDATE guild_settings SET ban_appeals=1 WHERE community_id=?`).run(cidA);
    assert.equal(fixture.db.prepare(`SELECT ban_appeals FROM guild_settings WHERE community_id=?`).get(cidA).ban_appeals, 1);
  });

  it("ban_appeals binds to the rebuilt table: one-per-cycle belt + FK all well-formed", () => {
    assert.deepEqual(indexNames(fixture.db, "ban_appeals"), ["idx_ban_appeals_ticket", "uq_ban_appeals_ban_record"]);
    const recId = insertPreBan(fixture.db, { cid: cidB, n: 44, userId: "075-appeal-host" });
    const aid = fixture.db
      .prepare(
        `INSERT INTO ban_appeals (community_id, ban_record_id, appeal_statement, ferry_paused, created_at, updated_at)
         VALUES (?, ?, 'rebuild probe', 0, ?, ?)`,
      )
      .run(cidB, recId, T0, T0).lastInsertRowid;
    assert.ok(aid >= 1, "an appeal binds to a rebuilt-parent row cleanly");
    assert.throws(
      () =>
        fixture.db
          .prepare(
            `INSERT INTO ban_appeals (community_id, ban_record_id, appeal_statement, ferry_paused, created_at, updated_at)
             VALUES (?, ?, 'collision', 0, ?, ?)`,
          )
          .run(cidB, recId, T0, T0),
      /UNIQUE constraint failed: ban_appeals\.ban_record_id/,
    );
    assert.throws(
      () =>
        fixture.db
          .prepare(
            `INSERT INTO ban_appeals (community_id, ban_record_id, appeal_statement, ferry_paused, created_at, updated_at)
             VALUES (?, 987654, 'dangle', 0, ?, ?)`,
          )
          .run(cidB, T0, T0),
      /FOREIGN KEY constraint failed/,
    );
    assert.deepEqual(fixture.db.prepare("PRAGMA foreign_key_check").all(), [], "no FK damage DB-wide");
  });

  it("guarded replay: a second up() reports {rebuilt:false, settingAdded:false} and moves NOTHING", () => {
    const ddlBefore = tableDdl(fixture.db, "ban_records");
    const banColsBefore = columns(fixture.db, "ban_records");
    const settingsBefore = settingsCols(fixture.db);
    const rowsBefore = allBans(fixture.db);

    const summary = up075(fixture.db, fixture.helpers);
    assert.deepEqual(summary, { rebuilt: false, settingAdded: false }, "the CHECK-presence guard skipped the rebuild");

    assert.equal(tableDdl(fixture.db, "ban_records"), ddlBefore, "the DDL byte-stood — no rebuild happened");
    assert.deepEqual(columns(fixture.db, "ban_records"), banColsBefore);
    assert.deepEqual(settingsCols(fixture.db), settingsBefore, "no duplicate toggle column");
    assert.deepEqual(allBans(fixture.db), rowsBefore, "replay never touches data");
  });
});

// ---------------------------------------------------------------------------
// Fail-loud drift guard: the rebuild DERIVES its DDL from the live schema; a
// shape it cannot read must be refused, never guessed at.
// ---------------------------------------------------------------------------

describe(`${id075} — refuses to rebuild from drifted ban_records DDL (fail-loud, installs nothing)`, () => {
  it("an underivable status IN-list is named and the transaction lands nothing (FK pragma restored)", () => {
    const loaded = loadDb();
    const connection = require("../src/db/connection");
    const d = loaded.api.db;
    try {
      // Synthetic drift: a ban_records WITHOUT the status CHECK IN-list
      // (the shape 075 must never guess a rebuild from).
      d.exec("DROP TABLE ban_appeals");
      d.exec("DROP TABLE ban_records");
      d.exec(`CREATE TABLE ban_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
        status TEXT NOT NULL
      )`);

      assert.throws(
        () =>
          up075(d, {
            tableExists: connection.tableExists,
            addColumnIfMissing: connection.addColumnIfMissing,
          }),
        (err) =>
          /Migration 075_ban_appeals refused/.test(err.message) &&
          /could not be derived from the live schema/.test(err.message),
        "the refusal names the migration and the derivability failure",
      );

      // Nothing installed: the CREATE never ran (the throw precedes it, and
      // the transaction rolled back anything it might have touched).
      assert.ok(!tableNames(d).includes("ban_appeals"), "a refused migration never half-installs its table");
      assert.deepEqual(columns(d, "ban_records"), ["id", "community_id", "status"], "the drifted table stands untouched");
      assert.equal(d.pragma("foreign_keys", { simple: true }), 1, "the pragma finally-restore holds on the throw path too");
    } finally {
      loaded.cleanup();
    }
  });
});
