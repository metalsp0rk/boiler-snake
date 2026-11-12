/**
 * Migration 074 guard (#772 ban lifecycle): the schema law banRecords.js and
 * the ban service lean on. Pins — the exact column shape, the CLOSED status/
 * source CHECK vocabularies (the machine stayed append-only: 075's #773
 * rebuild WIDENED `status` with `clemency_granted` — this file pins both the
 * widened domain and everything still outside it), the named
 * UNIQUE(community_id, ban_number) belt whose error-text contract the
 * repository's BAN_NUMBER_RACE matcher depends on, the partial UNIQUE that
 * admits exactly ONE active row per (community_id, user_id) — exercised via
 * REAL constraint violations, never a mock — the 034 "never unscoped" FK
 * posture (INSERT outside a community fails, community delete cascades), the
 * ban_dm / welcome_back_dm defaults, the missing-communities boot guard, and
 * idempotent up() replay (direct AND full runMigrations()).
 * The 075 (#773) guards ride along here: the CHECK rebuild extends THIS
 * table's law, so the widened rebuild + the ban_appeals schema it creates
 * are pinned in this file's migrated DB (deliverable: "the CHECK rebuild
 * lands here").
 * Naming precedent: migrations-automod-rules-channel-073.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();
after(cleanup);

const { id, up } = require("../src/db/migrations/074_ban_lifecycle");
const { id: id075, up: up075 } = require("../src/db/migrations/075_ban_appeals");
const {
  tableExists,
  addColumnIfMissing,
  getColumns,
} = require("../src/db/connection");
const { runMigrations, migrations } = require("../src/db/migrate");

// Fixed instant — no wall-clock reads anywhere in this file.
const T0 = Date.UTC(2026, 10, 1);

/** Whitespace-normalized SQL (migration-side comparison idiom, 040). */
const norm = (sql) => String(sql).replace(/\s+/g, " ").trim();

const guildSettingsCols = () =>
  db.db.prepare("PRAGMA table_info(guild_settings)").all().map((c) => c.name);

const banIndexNames = () =>
  db.db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ban_records' ORDER BY name`,
    )
    .all()
    .map((r) => r.name);

const banAppealIndexNames = () =>
  db.db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ban_appeals' ORDER BY name`,
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

/**
 * Direct SQL seed for ban_appeals (#773 law below) — same schema-vs-service
 * separation as insertBan.
 * @returns {number} lastInsertRowid
 */
function insertAppeal({
  cid,
  banRecordId,
  status = "filed",
  statement = "I would like to appeal this ban",
}) {
  return db.db
    .prepare(
      `INSERT INTO ban_appeals (community_id, ban_record_id, status, appeal_statement, ferry_paused, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(cid, banRecordId, status, statement, T0, T0).lastInsertRowid;
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
    // Append-only since 074: #773/075 widened the status CHECK (no column),
    // #809/076 appended ban_identity_reason, #810/077 appended
    // expiry_attempts. The pin stays EXACT — columns only ever append.
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
      "ban_identity_reason",
      "expiry_attempts",
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

  it("accepts clemency_granted (075 rebuild, #773) — and still rejects everything outside the widened domain", () => {
    // UPDATE for #773: the machine is APPEND-ONLY and 075 IS the promised
    // append — the CHECK rebuild lands clemency_granted inside the domain.
    // Pre-075 this INSERT had to throw; asserting ACCEPTANCE now throws RED
    // the moment someone edits 074 in place or drops 075's extension, while
    // the remaining values prove the rebuild did NOT open a hole.
    let n = 100;
    n += 1;
    assert.doesNotThrow(
      () =>
        insertBan({
          cid: CID,
          n,
          userId: `074-clemency-${n}`,
          status: "clemency_granted",
        }),
      "clemency_granted is in the machine since migration 075 (#773)",
    );
    for (const status of ["ACTIVE", "unbanned", ""]) {
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

// ---------------------------------------------------------------------------
// Migration 075 (#773) — the CHECK rebuild 074 promised, plus the schema it
// creates. It extends THIS table's law, so its guards live in this file's
// fully-migrated DB (see the header).
// ---------------------------------------------------------------------------

describe(`${id075} — wiring + boot guards`, () => {
  it("registers after 074 (the rebuild depends on it) and lands ban_appeals on boot", () => {
    const ids = migrations.map((m) => m.id);
    const idx074 = ids.indexOf(id);
    const idx075 = ids.indexOf(id075);
    assert.ok(idx074 >= 0 && idx075 > idx074, "075 is wired into the runner AFTER 074");
    assert.ok(tableExists("ban_appeals"));
  });

  it("up() REFUSES to run without communities / without ban_records (never unscoped or dangling)", () => {
    assert.throws(
      () => up075(db.db, { tableExists: () => false, addColumnIfMissing: () => true }),
      /communities.*is missing|034_communities/s,
    );
    assert.throws(
      () =>
        up075(db.db, {
          tableExists: (name) => name === "communities",
          addColumnIfMissing: () => true,
        }),
      /ban_records.*is missing|074_ban_lifecycle/s,
    );
  });
});

describe(`${id075} — ban_records CHECK rebuild preserved the 074 shape`, () => {
  it("the stored DDL carries the widened status CHECK (074's append-only promise kept)", () => {
    const ddl = db.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='ban_records'`)
      .get().sql;
    // Exact read keeps earning its keep: 075 appended clemency_granted,
    // 076 (#809) appended expired_held, 077 (#810) appended expiry_failed —
    // all at the END. Any reorder or removal lands here.
    assert.match(
      norm(ddl),
      /status TEXT NOT NULL DEFAULT 'active' CHECK \(status IN \('active','expired_unbanned','unbanned_manual','pending_rejoin','welcomed','clemency_granted','expired_held','expiry_failed'\)\)/,
      "the rebuilt DDL must read exactly like 074's + the appended entries",
    );
  });

  it("the rebuild preserved every column, in order, and all four indexes", () => {
    // PRAGMA reads the LIVE (rebuilt) table — byte-identical shape is the
    // 040-discipline contract: the copy used an explicit column list and the
    // captured index SQL was re-issued. The trailing ban_identity_reason /
    // expiry_attempts are 076 (#809) / 077 (#810) appends; the 075 rebuild
    // itself was column-preserving.
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
      "ban_identity_reason",
      "expiry_attempts",
    ]);
    assert.deepEqual(banIndexNames(), [
      "idx_ban_records_due",
      "idx_ban_records_user",
      "uq_ban_records_active",
      "uq_ban_records_number",
    ]);
  });
});

describe(`${id075} — ban_appeals schema law`, () => {
  const CID = communityKey("075-guard-domains");

  it("creates exactly the 075 columns, in order", () => {
    assert.deepEqual(getColumns("ban_appeals"), [
      "id",
      "community_id",
      "ban_record_id",
      "ticket_channel_id",
      "status",
      "appeal_statement",
      "ferry_user_msg_id",
      "ferry_user_ts",
      "ferry_ticket_msg_id",
      "ferry_ticket_ts",
      "ferry_paused",
      "decided_by",
      "decided_at",
      "denial_reason",
      "created_at",
      "updated_at",
    ]);
    assert.deepEqual(banAppealIndexNames(), [
      "idx_ban_appeals_ticket",
      "uq_ban_appeals_ban_record",
    ]);
  });

  it("accepts every status in the 075 machine", () => {
    const statuses = ["filed", "open", "granted", "denied", "closed"];
    statuses.forEach((status, i) => {
      const recId = insertBan({ cid: CID, n: 10 + i, userId: `075-status-${status}` });
      assert.doesNotThrow(
        () => insertAppeal({ cid: CID, banRecordId: recId, status }),
        `status ${status} must be admitted`,
      );
    });
  });

  it("status is CLOSED outside the five-state machine", () => {
    ["pending", "OPEN", ""].forEach((status, i) => {
      const recId = insertBan({ cid: CID, n: 30 + i, userId: `075-bad-${i}` });
      assert.throws(
        () => insertAppeal({ cid: CID, banRecordId: recId, status }),
        /CHECK constraint failed/,
        `status ${JSON.stringify(status)} must stay outside the domain`,
      );
    });
  });

  it("untouched rows carry the storage defaults (filed, unpaused, nothing decided)", () => {
    const cid = communityKey("075-guard-defaults");
    const recId = insertBan({ cid, n: 1, userId: "075-defaults-user" });
    const aid = db.db
      .prepare(
        `INSERT INTO ban_appeals (community_id, ban_record_id, appeal_statement, created_at, updated_at)
         VALUES (?, ?, 'migration probe', ?, ?)`,
      )
      .run(cid, recId, T0, T0).lastInsertRowid;
    const row = db.db.prepare(`SELECT * FROM ban_appeals WHERE id=?`).get(aid);
    assert.equal(row.status, "filed", "intake lands filed until the ticket opens");
    assert.equal(row.ferry_paused, 0, "the relay is never paused at rest");
    for (const col of [
      "ticket_channel_id",
      "ferry_user_msg_id",
      "ferry_user_ts",
      "ferry_ticket_msg_id",
      "ferry_ticket_ts",
      "decided_by",
      "decided_at",
      "denial_reason",
    ]) {
      assert.equal(row[col], null, `${col} starts absent`);
    }
  });
});

describe(`${id075} — ONE appeal per ban cycle + FK law`, () => {
  const CID = communityKey("075-guard-cycle");

  it("the second appeal for the same ban_record_id is a REAL constraint violation naming the column", () => {
    const recId = insertBan({ cid: CID, n: 1, userId: "075-cycle-user" });
    assert.doesNotThrow(() => insertAppeal({ cid: CID, banRecordId: recId }));
    // The named index's message contract is part of the belt: fileAppeal
    // maps a message containing "ban_appeals.ban_record_id" to the
    // one-appeal-per-cycle refusal.
    assert.throws(
      () => insertAppeal({ cid: CID, banRecordId: recId }),
      /UNIQUE constraint failed: ban_appeals\.ban_record_id/,
    );
  });

  it("an appeal can never exist unscoped or dangling (034/074 posture)", () => {
    assert.throws(
      () => insertAppeal({ cid: 999_999, banRecordId: 999_999 }),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => insertAppeal({ cid: CID, banRecordId: 987_654 }),
      /FOREIGN KEY constraint failed/,
      "987654 has no ban_records row — an appeal must never dangle",
    );
  });

  it("deleting the community cascades its appeals away", () => {
    const cid = communityKey("075-guard-cascade");
    const recId = insertBan({ cid, n: 1, userId: "075-cascade-user" });
    const aid = insertAppeal({ cid, banRecordId: recId });
    db.db.prepare(`DELETE FROM communities WHERE id=?`).run(cid);
    assert.equal(
      db.db.prepare(`SELECT id FROM ban_appeals WHERE id=?`).get(aid),
      undefined,
      "community rows OWN their appeals (and the record cascade sweeps them too)",
    );
  });
});

describe(`${id075} — guild toggle + idempotent replay`, () => {
  it("guild_settings.ban_appeals lands DEFAULT 1 (intake default-ON)", () => {
    assert.ok(guildSettingsCols().includes("ban_appeals"));
    const s = db.getGuildSettings(communityKey("075-guard-toggle"));
    assert.equal(s.ban_appeals, 1, "appeals intake is ON until a mod flips /banappeals");
  });

  it("direct up() re-run on the migrated DB is a no-op (tables, indexes, columns, rows)", () => {
    const cid = communityKey("075-guard-replay");
    const recId = insertBan({ cid, n: 900, userId: "075-replay-row" });
    const aid = insertAppeal({ cid, banRecordId: recId });
    const appealColsBefore = getColumns("ban_appeals");
    const banColsBefore = getColumns("ban_records");
    const appealIdxBefore = banAppealIndexNames();
    const banIdxBefore = banIndexNames();
    const settingsBefore = guildSettingsCols();

    assert.doesNotThrow(() => up075(db.db, { tableExists, addColumnIfMissing }));

    assert.deepEqual(getColumns("ban_appeals"), appealColsBefore, "no column churn");
    assert.deepEqual(getColumns("ban_records"), banColsBefore, "the rebuild skipped (guarded)");
    assert.deepEqual(banAppealIndexNames(), appealIdxBefore, "IF NOT EXISTS belts hold");
    assert.deepEqual(banIndexNames(), banIdxBefore, "ban_records indexes untouched");
    assert.deepEqual(guildSettingsCols(), settingsBefore, "no duplicate toggle column");

    const row = db.db.prepare(`SELECT * FROM ban_appeals WHERE id=?`).get(aid);
    assert.equal(row.status, "filed", "replay never touches data");
    assert.equal(row.appeal_statement, "I would like to appeal this ban");
  });

  it("full migration replay (user_version=0 → runMigrations) preserves appeals and the widened CHECK", () => {
    const cid = communityKey("075-guard-full-replay");
    const recId = insertBan({ cid, n: 901, userId: "075-full-replay-row" });
    const aid = insertAppeal({ cid, banRecordId: recId });

    db.db.pragma("user_version = 0"); // force the idempotent full replay
    assert.doesNotThrow(() => runMigrations());

    const appeal = db.db.prepare(`SELECT * FROM ban_appeals WHERE id=?`).get(aid);
    assert.ok(appeal, "the appeal survives the full replay");
    assert.equal(appeal.status, "filed");
    const record = db.db.prepare(`SELECT * FROM ban_records WHERE id=?`).get(recId);
    assert.ok(record, "the ban record survives the rebuilt-rebuild replay");
    assert.equal(record.status, "active");

    const ddl = db.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='ban_records'`)
      .get().sql;
    assert.match(norm(ddl), /'clemency_granted'/, "the widened CHECK survives the replay");

    // The cycle belt still bites after the replay (index intact).
    assert.throws(
      () => insertAppeal({ cid, banRecordId: recId }),
      /UNIQUE constraint failed: ban_appeals\.ban_record_id/,
    );
  });
});
