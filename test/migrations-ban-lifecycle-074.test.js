/**
 * Migration 074 guard (#772 ban lifecycle): the schema law banRecords.js and
 * the ban service lean on. Pins — the exact column shape, the CLOSED status/
 * source CHECK vocabularies (incl. #773's `clemency_granted` still being
 * REJECTED until an append-only migration widens the CHECK), the named
 * UNIQUE(community_id, ban_number) belt whose error-text contract the
 * repository's BAN_NUMBER_RACE matcher depends on, the partial UNIQUE that
 * admits exactly ONE active row per (community_id, user_id) — exercised via
 * REAL constraint violations, never a mock — the 034 "never unscoped" FK
 * posture (INSERT outside a community fails, community delete cascades), the
 * ban_dm / welcome_back_dm defaults, the missing-communities boot guard, and
 * idempotent up() replay (direct AND full runMigrations()).
 * Naming precedent: migrations-automod-rules-channel-073.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();
after(cleanup);

const { id, up } = require("../src/db/migrations/074_ban_lifecycle");
const {
  tableExists,
  addColumnIfMissing,
  getColumns,
} = require("../src/db/connection");
const { runMigrations, migrations } = require("../src/db/migrate");

// Fixed instant — no wall-clock reads anywhere in this file.
const T0 = Date.UTC(2026, 10, 1);

const guildSettingsCols = () =>
  db.db.prepare("PRAGMA table_info(guild_settings)").all().map((c) => c.name);

const banIndexNames = () =>
  db.db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ban_records' ORDER BY name`,
    )
    .all()
    .map((r) => r.name);

/**
 * Direct SQL seed — bypasses the repository so a violation proves the SCHEMA
 * enforces it, not the service layer.
 * @returns {number} lastInsertRowid
 */
function insertBan({ cid, n, userId, status = "active", source = "staff", expiresAt = null }) {
  return db.db
    .prepare(
      `INSERT INTO ban_records (community_id, ban_number, user_id, source, reason, banned_at, expires_at, status)
       VALUES (?, ?, ?, ?, 'migration probe', ?, ?, ?)`,
    )
    .run(cid, n, userId, source, T0, expiresAt, status).lastInsertRowid;
}

describe(`${id} — schema shape`, () => {
  it("registers in the migrate.js list and lands ban_records on boot", () => {
    assert.ok(
      migrations.some((m) => m.id === id),
      "the migration is wired into the runner",
    );
    assert.ok(tableExists("ban_records"));
  });

  it("creates exactly the 074 columns, in order", () => {
    assert.deepEqual(getColumns("ban_records"), [
      "id",
      "community_id",
      "ban_number",
      "user_id",
      "moderator_id",
      "source",
      "reason",
      "banned_at",
      "expires_at",
      "status",
      "ban_dm_sent",
      "welcome_dm_sent",
      "unban_claimed_at",
      "unban_reason",
    ]);
  });

  it("creates the two named UNIQUE belts and the two plain indexes", () => {
    // NAMED indexes (unlike 068's table constraints) so the repository's
    // error path can name them; the plain pair is the user-history and the
    // partial expiry-sweep index.
    assert.deepEqual(banIndexNames(), [
      "idx_ban_records_due",
      "idx_ban_records_user",
      "uq_ban_records_active",
      "uq_ban_records_number",
    ]);
  });
});

describe(`${id} — CHECK vocabularies are CLOSED`, () => {
  const CID = communityKey("074-guard-domains");

  it("accepts every status in the 074 machine", () => {
    let n = 0;
    for (const status of [
      "active",
      "expired_unbanned",
      "unbanned_manual",
      "pending_rejoin",
      "welcomed",
    ]) {
      n += 1;
      assert.doesNotThrow(
        () => insertBan({ cid: CID, n, userId: `074-status-${status}`, status }),
        `status ${status} must be admitted`,
      );
    }
  });

  it("rejects statuses OUTSIDE the CHECK — incl. #773's future clemency_granted", () => {
    // The machine is APPEND-ONLY: #773 must add clemency_granted through a
    // NEW migration, and until then the schema refuses it. This throws RED
    // the moment someone edits 074 in place.
    let n = 100;
    for (const status of ["clemency_granted", "ACTIVE", "unbanned", ""]) {
      n += 1;
      assert.throws(
        () => insertBan({ cid: CID, n, userId: `074-bad-${n}`, status }),
        /CHECK constraint failed/,
        `status ${JSON.stringify(status)} must stay outside the domain`,
      );
    }
  });

  it("source is the staff/automod audit split — nothing else", () => {
    assert.doesNotThrow(() =>
      insertBan({ cid: CID, n: 200, userId: "074-source-automod", source: "automod" }),
    );
    // 'admin' is the vocabulary the pre-#772 audit logs used; the CHECK
    // forces the migration's two-word audit split.
    assert.throws(
      () => insertBan({ cid: CID, n: 201, userId: "074-source-admin", source: "admin" }),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insertBan({ cid: CID, n: 202, userId: "074-source-null", source: null }),
      /CHECK constraint failed|NOT NULL constraint failed/,
    );
  });
});

describe(`${id} — UNIQUE(community_id, ban_number) belt`, () => {
  const CID = communityKey("074-guard-number");
  const CID_B = communityKey("074-guard-number-b");

  it("rejects a duplicate ban_number IN the same community — and the error names ban_records.ban_number", () => {
    insertBan({ cid: CID, n: 1, userId: "074-num-a" });
    // The message contract is part of the belt: createBanRecord maps a
    // message containing "ban_records.ban_number" to code BAN_NUMBER_RACE.
    assert.throws(
      () => insertBan({ cid: CID, n: 1, userId: "074-num-dup" }),
      /UNIQUE constraint failed: ban_records\.community_id, ban_records\.ban_number/,
    );
  });

  it("ban_number is PER COMMUNITY — the same n in another community is fine", () => {
    insertBan({ cid: CID, n: 500, userId: "074-num-x" });
    assert.doesNotThrow(() =>
      insertBan({ cid: CID_B, n: 500, userId: "074-num-y" }),
    );
  });
});

describe(`${id} — ONE active row per (community_id, user_id)`, () => {
  const CID = communityKey("074-guard-active");

  it("the second ACTIVE row for the same user is a REAL constraint violation", () => {
    insertBan({ cid: CID, n: 1, userId: "074-active-user" });
    // The partial UNIQUE's message names its columns; banRecords.js keys the
    // ACTIVE_BAN_EXISTS code off "ban_records.user_id" riding in the text.
    assert.throws(
      () => insertBan({ cid: CID, n: 2, userId: "074-active-user" }),
      /UNIQUE constraint failed: ban_records\.community_id, ban_records\.user_id/,
    );
  });

  it("closing the first row lets a new ACTIVE cycle in (append-only history)", () => {
    const first = insertBan({ cid: CID, n: 3, userId: "074-cycle-user" });
    assert.throws(
      () => insertBan({ cid: CID, n: 4, userId: "074-cycle-user" }),
      /UNIQUE constraint failed: ban_records\.community_id, ban_records\.user_id/,
      "still refused while the first row is active",
    );
    db.db
      .prepare(`UPDATE ban_records SET status='unbanned_manual' WHERE id=?`)
      .run(first);
    assert.doesNotThrow(() =>
      insertBan({ cid: CID, n: 5, userId: "074-cycle-user" }),
    );
    // …and the new cycle may be active WHILE the closed one remains.
    assert.throws(
      () => insertBan({ cid: CID, n: 6, userId: "074-cycle-user" }),
      /UNIQUE constraint failed: ban_records\.community_id, ban_records\.user_id/,
      "exactly one active row survives the cycle flip",
    );
  });

  it("CLOSED rows may duplicate freely — the predicate only admits status='active'", () => {
    for (let i = 0; i < 3; i += 1) {
      insertBan({
        cid: CID,
        n: 100 + i,
        userId: "074-welcomed-repeat",
        status: "welcomed",
      });
    }
    // Same user, different community: active again, no conflict.
    insertBan({
      cid: communityKey("074-guard-active-b"),
      n: 1,
      userId: "074-welcomed-repeat",
    });
  });
});

describe(`${id} — community scoping is enforced by the FK itself`, () => {
  it("a ban record can never exist unscoped (034 ordering posture)", () => {
    // 999999 has no communities row: the FK rejects it, so no code path can
    // write an unscoped record even with the service bypassed.
    assert.throws(
      () =>
        insertBan({
          cid: 999_999,
          n: 1,
          userId: "074-unscoped",
        }),
      /FOREIGN KEY constraint failed/,
    );
  });

  it("deleting the community cascades its records away", () => {
    const cid = communityKey("074-guard-cascade");
    const recId = insertBan({ cid, n: 1, userId: "074-cascade-user" });
    db.db.prepare(`DELETE FROM communities WHERE id=?`).run(cid);
    assert.equal(
      db.db.prepare(`SELECT id FROM ban_records WHERE id=?`).get(recId),
      undefined,
      "community rows OWN their ban records",
    );
  });
});

describe(`${id} — guild_settings toggles`, () => {
  it("ban_dm and welcome_back_dm land DEFAULT 1 (the warn_dm_members family)", () => {
    const cols = guildSettingsCols();
    assert.ok(cols.includes("ban_dm"));
    assert.ok(cols.includes("welcome_back_dm"));

    const cid = communityKey("074-guard-toggles");
    const s = db.getGuildSettings(cid);
    assert.equal(s.ban_dm, 1, "ban DMs are ON until a mod flips /bannotify");
    assert.equal(s.welcome_back_dm, 1);
  });

  it("addColumnIfMissing replays as a false-returning no-op", () => {
    // The pre-074 replay lane: same call again must add NOTHING (and say so).
    assert.equal(
      addColumnIfMissing("guild_settings", "ban_dm", "ban_dm INTEGER NOT NULL DEFAULT 1"),
      false,
    );
    assert.equal(
      addColumnIfMissing(
        "guild_settings",
        "welcome_back_dm",
        "welcome_back_dm INTEGER NOT NULL DEFAULT 1",
      ),
      false,
    );
    assert.equal(
      guildSettingsCols().filter((n) => n === "ban_dm").length,
      1,
    );
  });
});

describe(`${id} — idempotent replay + boot guard`, () => {
  it("up() REFUSES to run without the communities table (never unscoped)", () => {
    // The 034 ordering guard: ban records must never be created unscoped,
    // so the migration names the missing dependency instead of proceeding.
    assert.throws(
      () => up(db.db, { tableExists: () => false, addColumnIfMissing: () => true }),
      /communities.*is missing|034_communities/s,
    );
  });

  it("direct up() re-run on the migrated DB is a no-op (tables, indexes, columns, rows)", () => {
    const cid = communityKey("074-guard-replay");
    const recId = insertBan({ cid, n: 77, userId: "074-replay-row" });
    const colsBefore = getColumns("ban_records");
    const colsBeforeG = guildSettingsCols();
    const indexesBefore = banIndexNames();

    assert.doesNotThrow(() => up(db.db, { tableExists, addColumnIfMissing }));

    assert.deepEqual(getColumns("ban_records"), colsBefore, "no column churn");
    assert.deepEqual(guildSettingsCols(), colsBeforeG, "no duplicate toggle column");
    assert.deepEqual(banIndexNames(), indexesBefore, "IF NOT EXISTS belts hold");

    const row = db.db.prepare(`SELECT * FROM ban_records WHERE id=?`).get(recId);
    assert.equal(row.status, "active", "replay never touches data");
    assert.equal(row.ban_number, 77);
    assert.equal(row.reason, "migration probe");
  });

  it("full migration replay (user_version=0 → runMigrations) preserves records and toggles", () => {
    const cid = communityKey("074-guard-full-replay");
    const recId = insertBan({ cid, n: 78, userId: "074-full-replay-row" });
    db.updateGuildSettings(cid, { ban_dm: 0 });

    db.db.pragma("user_version = 0"); // force the idempotent full replay
    assert.doesNotThrow(() => runMigrations());

    assert.equal(
      guildSettingsCols().filter((n) => n === "ban_dm").length,
      1,
      "replay never adds the column twice",
    );
    assert.equal(
      db.getGuildSettings(cid).ban_dm,
      0,
      "the replay preserves the operator's flip",
    );

    const row = db.db.prepare(`SELECT * FROM ban_records WHERE id=?`).get(recId);
    assert.ok(row, "the record survives the full replay");
    assert.equal(row.ban_number, 78);
    assert.equal(row.status, "active");
    // The partial UNIQUE still bites after the replay (index intact).
    assert.throws(
      () => insertBan({ cid, n: 79, userId: "074-full-replay-row" }),
      /UNIQUE constraint failed: ban_records\.community_id, ban_records\.user_id/,
    );
  });
});
