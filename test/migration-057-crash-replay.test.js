/**
 * #813 (C2-1): migration 057's crash-window replay. The rebuild used to run
 * bare (`db.exec` autocommits each statement): a crash inside the migration
 * window left `role_drop_state__057` / `guild_settings__057` residue the
 * `hasFk` gate could not see, and every later boot died on "table … already
 * exists" or "no such table: …" out of runMigrations at require time — a
 * permanent boot loop until a human ran manual SQL. Both lead-reproduced
 * crash cuts (and the guild_settings placeholder shapes) must now REPLAY
 * CLEAN through the real `up()`, healing or finishing as appropriate.
 *
 * Doctrine mirrored from migration-003-crash-replay.test.js: drive the
 * migration's real up() against the loaded test DB across every residue
 * shape, including the loud-abort doctrines that must STAY loud.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");
const { api, cleanup } = loadDb(); // CONTRACT: temp DB before src/ requires

const { up } = require("../src/db/migrations/057_level_role_fk");
const { tableExists } = require("../src/db/connection");

after(cleanup);

const CID = communityKey("940000000000005700");
const ROLE = "860000000000000057";
const USER = "870000000000000057";

// ── fixture shapes ──────────────────────────────────────────────────────────
// The live DDLs as they stood BEFORE 057 (FK-free, core-table era).
const LEGACY_RDS = `
CREATE TABLE role_drop_state (
  community_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  below_since INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id, role_id)
)`;
const LEGACY_GS = `
CREATE TABLE guild_settings (
  community_id INTEGER NOT NULL PRIMARY KEY,
  xp_per_message INTEGER DEFAULT 5,
  cooldown_seconds INTEGER DEFAULT 20
)`;
// The staged shapes a crashed pass could leave behind.
const STAGED_RDS = `
CREATE TABLE role_drop_state__057 (
  community_id INTEGER NOT NULL REFERENCES communities(id),
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  below_since INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id, role_id),
  FOREIGN KEY (community_id, role_id)
    REFERENCES level_roles (community_id, role_id) ON DELETE CASCADE
)`;
const STAGED_GS = `
CREATE TABLE "guild_settings__057" (
  community_id INTEGER NOT NULL PRIMARY KEY REFERENCES communities(id),
  xp_per_message INTEGER DEFAULT 5,
  cooldown_seconds INTEGER DEFAULT 20
)`;
const PLACEHOLDER_GS = `
CREATE TABLE guild_settings__057 (
  community_id INTEGER NOT NULL PRIMARY KEY,
  placeholder INTEGER
)`;

const db = api.db;

function wipe() {
  db.exec(`
DROP TABLE IF EXISTS role_drop_state; DROP TABLE IF EXISTS role_drop_state__057;
DROP TABLE IF EXISTS guild_settings; DROP TABLE IF EXISTS guild_settings__057;`);
}

const rdsRows = () =>
  db.prepare("SELECT community_id, user_id, role_id, below_since FROM role_drop_state").all();
const gsCols = () =>
  db.prepare("SELECT name FROM pragma_table_info('guild_settings')").all().map((r) => r.name);
const gsRows = () => db.prepare("SELECT * FROM guild_settings ORDER BY community_id").all();

/** Fresh legacy pair with one row each (+ a level_role so FKs resolve). */
function legacyFixture() {
  wipe();
  db.exec(LEGACY_RDS);
  db.exec(LEGACY_GS);
  api.upsertLevelRole(CID, ROLE, 5, 7);
  db
    .prepare(
      `INSERT INTO role_drop_state (community_id, user_id, role_id, below_since, updated_at)
       VALUES (?, ?, ?, 1234, 1)`,
    )
    .run(CID, USER, ROLE);
  db
    .prepare("INSERT INTO guild_settings (community_id, xp_per_message, cooldown_seconds) VALUES (?, 9, 30)")
    .run(CID);
}

const dds = (t) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t).sql;

describe("migration 057 crash-window replay (#813)", () => {
  it("plain legacy DB rebuilds BOTH tables; replay is inert", () => {
    legacyFixture();
    up(db, { tableExists });

    assert.match(dds("role_drop_state"), /REFERENCES\s+communities/i);
    assert.match(dds("guild_settings"), /REFERENCES\s+communities/i);
    assert.deepEqual(rdsRows(), [{ community_id: CID, user_id: USER, role_id: ROLE, below_since: 1234 }],
      "drop-state data survives the copy");
    assert.deepEqual(gsRows(), [{ community_id: CID, xp_per_message: 9, cooldown_seconds: 30 }],
      "every grown-by-ALTER column survives verbatim");

    up(db, { tableExists }); // "re-running migrations is safe"
    assert.deepEqual(rdsRows().length, 1);
    assert.deepEqual(gsRows().length, 1);
  });

  it("RDS REPLAY after a crash between INSERT and DROP: stale staging dropped, rebuild completes", () => {
    legacyFixture();
    db.exec(STAGED_RDS); // crashed pass left the staged copy…
    db
      .prepare(`INSERT INTO role_drop_state__057 VALUES (?, ?, ?, 9999, 1)`)
      .run(CID, USER, ROLE); // …with half-written (here: drifted) rows

    up(db, { tableExists });

    assert.equal(tableExists("role_drop_state__057"), false, "staging consumed");
    assert.deepEqual(rdsRows(), [{ community_id: CID, user_id: USER, role_id: ROLE, below_since: 1234 }],
      "the LIVE table's rows are the truth — the stale copy's 9999 never lands");
    assert.match(dds("role_drop_state"), /REFERENCES\s+communities/i);
  });

  it("RDS REPLAY after a crash between DROP and RENAME: heals by finishing the rename", () => {
    wipe();
    db.exec(LEGACY_GS); // guild_settings stays in its legacy shape (own pass runs)
    api.upsertLevelRole(CID, ROLE, 5, 7);
    db.exec(STAGED_RDS); // live role_drop_state is GONE — the staged copy is the data
    db.prepare(`INSERT INTO role_drop_state__057 VALUES (?, ?, ?, 777, 1)`).run(CID, USER, ROLE);

    up(db, { tableExists });

    assert.equal(tableExists("role_drop_state"), true, "the table is BACK — data not orphaned");
    assert.deepEqual(rdsRows(), [{ community_id: CID, user_id: USER, role_id: ROLE, below_since: 777 }],
      "the staged rows survive the heal");
    assert.match(dds("role_drop_state"), /REFERENCES\s+level_roles\s*\(community_id,\s*role_id\)/i,
      "the healed table carries the composite FK (staged DDL was the target shape)");
  });

  it("GS REPLAY with the placeholder residue beside live: placeholder dropped, rebuild completes", () => {
    legacyFixture();
    db.exec(PLACEHOLDER_GS); // died right after the vestigial CREATE

    up(db, { tableExists });

    assert.equal(tableExists("guild_settings__057"), false, "placeholder residue dropped");
    assert.match(dds("guild_settings"), /REFERENCES\s+communities/i);
    assert.deepEqual(gsCols(), ["community_id", "xp_per_message", "cooldown_seconds"],
      "the derived DDL kept every live column");
    assert.deepEqual(gsRows().length, 1);
  });

  it("GS REPLAY after a crash between DROP and RENAME: finishes the rename — the settings SURVIVE", () => {
    wipe();
    db.exec(LEGACY_RDS);
    api.upsertLevelRole(CID, ROLE, 5, 7);
    db.prepare(`INSERT INTO role_drop_state VALUES (?, ?, ?, NULL, 1)`).run(CID, USER, ROLE);
    db.exec(STAGED_GS); // live guild_settings is GONE; the full copy is staged
    db
      .prepare("INSERT INTO guild_settings__057 (community_id, xp_per_message, cooldown_seconds) VALUES (?, 9, 30)")
      .run(CID);

    up(db, { tableExists });

    assert.equal(tableExists("guild_settings"), true, "the settings table is BACK");
    assert.deepEqual(gsRows(), [{ community_id: CID, xp_per_message: 9, cooldown_seconds: 30 }],
      "EVERY settings row rides the heal");
    assert.match(dds("guild_settings"), /REFERENCES\s+communities/i);
  });

  it("GS completed rebuild + leftover staging residue (post-fix replay): staging dropped only", () => {
    legacyFixture();
    up(db, { tableExists }); // FK present now
    db.exec(STAGED_GS); // a hypothetical leftover re-appears beside the finished table
    db.prepare("INSERT INTO guild_settings__057 (community_id) VALUES (?)").run(CID);

    up(db, { tableExists });

    assert.equal(tableExists("guild_settings__057"), false, "residue dropped, not resurrected");
    assert.deepEqual(gsRows(), [{ community_id: CID, xp_per_message: 9, cooldown_seconds: 30 }],
      "the completed table is untouched");
  });

  it("the loud-abort doctrine SURVIVES the transaction: an orphan settings row still kills the copy", () => {
    legacyFixture();
    db.prepare("INSERT INTO guild_settings (community_id) VALUES (424242)").run(); // unregistered

    assert.throws(() => up(db, { tableExists }), /FOREIGN KEY/i,
      "the copy runs under FK enforcement — orphan settings rows abort LOUDLY (041 doctrine)");
    // The transaction rolled back: legacy tables stand untouched (no boot-loop residue).
    assert.equal(tableExists("guild_settings__057"), false, "the rolled-back pass leaves NOTHING behind");
    assert.match(dds("guild_settings"), /CREATE TABLE/i);
    assert.deepEqual(gsRows().map((r) => r.community_id).sort(), [CID, 424242].sort(),
      "no partial copy persisted");
  });

  it("impossible GS shape (live gone, only the placeholder staged) aborts with the honest cause", () => {
    wipe();
    db.exec(LEGACY_RDS);
    api.upsertLevelRole(CID, ROLE, 5, 7);
    db.exec(PLACEHOLDER_GS);

    assert.throws(() => up(db, { tableExists }), /Restore the database from backup/i);
  });

  it("a fully missing table names itself instead of dying cryptically on the copy", () => {
    wipe(); // neither table, no residue
    assert.throws(() => up(db, { tableExists }), /does not exist/);
  });

  it("the orphan sweep still pre-cleans stranded drop-state rows before the copy", () => {
    legacyFixture();
    db.prepare("INSERT INTO role_drop_state VALUES (?, ?, 'role-stranded', 1, 1)").run(CID, USER);
    db.prepare("INSERT INTO role_drop_state VALUES (555555, ?, 'r', 1, 1)").run(USER);

    up(db, { tableExists });

    assert.deepEqual(rdsRows().length, 1, "the honest row survives; the DB-10 orphans are swept");
  });
});
