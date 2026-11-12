/**
 * FK coverage for the level-role pair + guild_settings (issue #469, DB-9/DB-10).
 *
 * The 034 cutover preserved the original FK-free DDL of the core tables, so
 * `role_drop_state` and `guild_settings` still trusted `assertCommunityId`
 * alone — an unregistered integer wrote orphan rows the DB accepted (the
 * "unfinished half" of the FK item). This migration takes the two tables
 * whose invariants are actively maintained in application code:
 *
 *  - role_drop_state: gains FK→communities(id) AND the composite
 *    FK→level_roles(community_id, role_id) ON DELETE CASCADE. The repository
 *    ALREADY promises "deleteLevelRole removes both rows" (DB-10 flagged the
 *    un-wrapped pair); now the database keeps that promise too — the orphan
 *    class becomes impossible, not just unlikely.
 *  - guild_settings: FK→communities(id) on the PK. No pre-clean: an orphan
 *    settings row would abort the copy LOUDLY (041's demonstrated doctrine —
 *    settings rows only ever mint through ensureGuildSettings on a
 *    registered community).
 *
 * Orphan role_drop_state rows CAN legitimately exist on legacy DBs (exactly
 * the DB-10 gap: a level_roles row deleted, its drop-state stranded), so
 * they are pre-cleaned with a named count before the copy — the sweep is
 * idempotent and stays outside the schema gate so every replay re-checks it.
 *
 * The rebuild itself is gated on the FK actually being absent (ledger-less
 * replay is the law), same 040 shape.
 *
 * #813 (C2-1) — the rebuild used to run BARE: `db.exec` autocommits every
 * statement (better-sqlite3), so a crash (OOM-kill, SIGKILL, power loss)
 * between statements left staging residue the `hasFk` gate could not see,
 * and the replay collided with it — "table role_drop_state__057 already
 * exists", or "no such table: role_drop_state" after a DROP-then-died
 * window — out of `runMigrations` at require time: a permanent BOOT LOOP
 * until a human ran manual SQL (the #458 B2-9 class, relocated into this
 * file by 057 landing the same day 003's heal shipped). Now:
 *
 *  - EVERY crash-residue shape heals BEFORE the schema gate (003's
 *    doctrine): a half-finished rebuild (live table gone, full copy staged)
 *    is COMPLETED by the atomic single-statement RENAME; a staging table
 *    beside an intact live table is stale residue and gets DROPPED; the
 *    vestigial placeholder-staging residue gets dropped; the one shape
 *    that cannot be healed (live gone, only the placeholder staged) aborts
 *    with a restore-from-backup cause instead of looping on cryptic throws.
 *  - Each rebuild runs in ONE `db.transaction` (034/040/075 discipline):
 *    after this version a crash CANNOT leave mid-rebuild residue — the
 *    heals above exist for DBs damaged by the pre-fix code.
 *  - DOCUMENTED DEVIATION from 034/040/075: `PRAGMA foreign_keys` stays ON
 *    through the rebuild (they toggle it OFF around theirs). This file's
 *    copy-time FK enforcement IS the loud-abort doctrine above (an orphan
 *    guild_settings row must make the copy FAIL, not copy silently), and
 *    both tables are FK CHILDREN ONLY — no shipped DDL references them, so
 *    DROP/RENAME under enforcement is safe (verified #813).
 *  - A post-rebuild DDL belt re-reads sqlite_master and refuses to let the
 *    migration claim an FK it did not install (040's law).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists?: Function }} [helpers]
 */

const RDS = "role_drop_state";
const RDS_STAGING = "role_drop_state__057";
const GS = "guild_settings";
const GS_STAGING = "guild_settings__057";

/** The pre-#813 placeholder table is pure residue — never the data copy. */
function stagingIsPlaceholder(db, table) {
  return (
    db
      .prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = 'placeholder'")
      .get(table) !== undefined
  );
}

/**
 * Heal every role_drop_state crash residue BEFORE the gate (003 doctrine).
 * @param {import("better-sqlite3").Database} db
 * @param {(name: string) => boolean} tableExists
 */
function healRoleDropStateResidue(db, tableExists) {
  if (!tableExists(RDS_STAGING)) return;
  if (!tableExists(RDS)) {
    // Died after the DROP, before the RENAME: the staged copy IS the data
    // (the INSERT precedes the DROP) — completing the rename (one atomic
    // statement) heals it.
    db.exec(`ALTER TABLE ${RDS_STAGING} RENAME TO ${RDS}`);
    console.log(
      "[db] Migration 057: healed a half-finished role_drop_state rebuild — completed the rename (#813)",
    );
    return;
  }
  // Live table intact → the crash predates its DROP; the staged copy is a
  // stale duplicate that would collide with the rebuild.
  db.exec(`DROP TABLE ${RDS_STAGING}`);
  console.log(
    "[db] Migration 057: dropped stale role_drop_state__057 residue (#813)",
  );
}

/**
 * Heal every guild_settings crash residue BEFORE the gate. Residue shapes:
 * placeholder-only (died between its CREATE and DROP), full copy beside
 * live (died before the live DROP / after a rolled-back pre-fix pass), and
 * full copy WITHOUT live (died between DROP and RENAME — the staged table
 * holds EVERY settings row, finish the rename).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {(name: string) => boolean} tableExists
 */
function healGuildSettingsResidue(db, tableExists) {
  if (!tableExists(GS_STAGING)) return;
  if (stagingIsPlaceholder(db, GS_STAGING)) {
    if (!tableExists(GS)) {
      // Cannot happen from the shipped statement order (the placeholder is
      // dropped long before the live table is touched) — but if a hand-
      // mangled DB says the full copy is gone while only the placeholder
      // remains, every settings row is already lost. Say exactly that,
      // once, instead of boot-looping on cryptic throws.
      throw new Error(
        "[db] Migration 057: guild_settings is gone and only its vestigial " +
          "placeholder residue is staged — the settings copy does not exist. " +
          "Restore the database from backup; do not hand-drop the residue.",
      );
    }
    db.exec(`DROP TABLE ${GS_STAGING}`);
    console.log(
      "[db] Migration 057: dropped vestigial guild_settings__057 placeholder residue (#813)",
    );
    return;
  }
  if (!tableExists(GS)) {
    db.exec(`ALTER TABLE ${GS_STAGING} RENAME TO ${GS}`);
    console.log(
      "[db] Migration 057: healed a half-finished guild_settings rebuild — completed the rename (#813)",
    );
    return;
  }
  db.exec(`DROP TABLE ${GS_STAGING}`);
  console.log(
    "[db] Migration 057: dropped stale guild_settings__057 residue (#813)",
  );
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} table
 * @param {string} rebuiltFor error-message wording
 */
function assertRebuiltFk(db, table) {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table);
  if (!row || !/REFERENCES\s+communities/i.test(row.sql)) {
    throw new Error(
      `[db] Migration 057: rebuild claims success but ${table} does not carry the communities FK — refusing to leave the invariant half-true`,
    );
  }
}

function up(db, helpers = {}) {
  const tableExists =
    helpers.tableExists ??
    ((name) =>
      !!db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(name));

  // ── #813: heal every crash residue shape BEFORE anything else reads the
  // table set (the old gate could not see half-crash state). ──────────────
  healRoleDropStateResidue(db, tableExists);
  healGuildSettingsResidue(db, tableExists);

  // A table neither live nor staged cannot be migrated — on shipped boot
  // sequences both tables exist long before 057; name the anomaly loudly
  // instead of dying on the copy with "no such table".
  for (const table of [RDS, GS]) {
    if (!tableExists(table)) {
      throw new Error(
        `[db] Migration 057: ${table} does not exist (and no rebuild residue was staged) — cannot add the communities FK to a table that is not there`,
      );
    }
  }

  // Idempotent orphan sweep (see header): drop-state rows no reachable
  // invariant explains — stranded by the DB-10 gap or a removed community.
  const stranded = db
    .prepare(`
DELETE FROM role_drop_state
 WHERE (community_id, role_id) NOT IN (
   SELECT community_id, role_id FROM level_roles
 )
   OR community_id NOT IN (SELECT id FROM communities)
`)
    .run();
  if (stranded.changes > 0) {
    console.log(
      `[db] Migration 057: removed ${stranded.changes} orphan role_drop_state row(s) (DB-10 class)`,
    );
  }

  const hasFk = (table) => {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table);
    return !!row && /REFERENCES\s+communities/i.test(row.sql);
  };

  if (!hasFk(RDS)) {
    // ONE transaction (#813): any failure rolls the whole rebuild back, so
    // a crash can never leave a half-state for the next boot. Copy runs
    // under FK enforcement (documented deviation — the sweep above owns
    // the legitimate orphans; anything still violating FK aborts the copy
    // LOUDLY, 041's demonstrated doctrine).
    const rebuild = db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS ${RDS_STAGING}`);
      db.exec(`
CREATE TABLE ${RDS_STAGING} (
  community_id INTEGER NOT NULL REFERENCES communities(id),
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  below_since INTEGER, -- ms epoch, NULL when not below
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id, role_id),
  FOREIGN KEY (community_id, role_id)
    REFERENCES level_roles (community_id, role_id) ON DELETE CASCADE
);

INSERT INTO ${RDS_STAGING}
  (community_id, user_id, role_id, below_since, updated_at)
SELECT community_id, user_id, role_id, below_since, updated_at
  FROM ${RDS};

DROP TABLE ${RDS};
ALTER TABLE ${RDS_STAGING} RENAME TO ${RDS};
`);
    });
    rebuild();
    assertRebuiltFk(db, RDS);
  }

  if (!hasFk(GS)) {
    // Copy through the live column list: guild_settings grew by ALTER over
    // dozens of migrations — hard-coding it here would drift on day one.
    const cols = db
      .prepare(`SELECT name FROM pragma_table_info('${GS}')`)
      .all()
      .map((c) => c.name);
    const colList = cols.join(", ");
    // The real rebuild keeps EVERY column verbatim: build the CREATE from
    // the live definition with the FK added (034's own proven trick —
    // derive DDL from sqlite_master, rewrite only the head of the PK line).
    // The pre-#813 placeholder dance is gone: inside the transaction the
    // derived DDL either installs or the whole pass rolls back.
    const live = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
      .get(GS).sql;
    const rewritten = live.replace(
      /CREATE TABLE (?:IF NOT EXISTS )?"?guild_settings"?/i,
      'CREATE TABLE "guild_settings__057"',
    );
    const withFk = rewritten.replace(
      /community_id INTEGER NOT NULL PRIMARY KEY/i,
      "community_id INTEGER NOT NULL PRIMARY KEY REFERENCES communities(id)",
    );
    if (withFk === rewritten || !/REFERENCES communities/i.test(withFk)) {
      throw new Error(
        "[db] Migration 057: could not rewrite the guild_settings DDL to carry the communities FK — refusing to rebuild blind",
      );
    }
    const rebuild = db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS ${GS_STAGING}`);
      db.exec(withFk);
      db.exec(`
INSERT INTO ${GS_STAGING} (${colList})
SELECT ${colList} FROM ${GS};
DROP TABLE ${GS};
ALTER TABLE ${GS_STAGING} RENAME TO ${GS};
`);
    });
    rebuild();
    assertRebuiltFk(db, GS);
  }
}

module.exports = { id: "057_level_role_fk", up };
