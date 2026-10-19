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
 * @param {import("better-sqlite3").Database} db
 */
function up(db) {
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

  if (!hasFk("role_drop_state")) {
    db.exec(`
CREATE TABLE role_drop_state__057 (
  community_id INTEGER NOT NULL REFERENCES communities(id),
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  below_since INTEGER, -- ms epoch, NULL when not below
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id, role_id),
  FOREIGN KEY (community_id, role_id)
    REFERENCES level_roles (community_id, role_id) ON DELETE CASCADE
);

INSERT INTO role_drop_state__057
  (community_id, user_id, role_id, below_since, updated_at)
SELECT community_id, user_id, role_id, below_since, updated_at
  FROM role_drop_state;

DROP TABLE role_drop_state;
ALTER TABLE role_drop_state__057 RENAME TO role_drop_state;
`);
  }

  if (!hasFk("guild_settings")) {
    // Copy through the live column list: guild_settings grew by ALTER over
    // dozens of migrations — hard-coding it here would drift on day one.
    const cols = db
      .prepare(`SELECT name FROM pragma_table_info('guild_settings')`)
      .all()
      .map((c) => c.name);
    const colList = cols.join(", ");
    db.exec(`
CREATE TABLE guild_settings__057 (
  community_id INTEGER NOT NULL PRIMARY KEY REFERENCES communities(id),
  placeholder INTEGER
);
`);
    // The real rebuild keeps EVERY column verbatim: build the CREATE from
    // the live definition with the FK added (034's own proven trick —
    // derive DDL from sqlite_master, rewrite only the head of the PK line).
    db.exec("DROP TABLE guild_settings__057;");
    const live = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='guild_settings'`)
      .get().sql;
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
    db.exec(withFk);
    db.exec(`
INSERT INTO guild_settings__057 (${colList})
SELECT ${colList} FROM guild_settings;
DROP TABLE guild_settings;
ALTER TABLE guild_settings__057 RENAME TO guild_settings;
`);
  }
}

module.exports = { id: "057_level_role_fk", up };
