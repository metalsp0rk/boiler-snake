/**
 * Self-healing repair for the PARTIAL 034 community cutover (audit-2026-10 #285).
 *
 * Root cause (verified 2026-10-11 on a copy of the live dev DB by the
 * migration-040 boot drill, #283): `034_communities` gates its WHOLE rebuild
 * block on one marker — `getColumns("users").includes("guild_id")`. Legacy DBs
 * whose `users` was cut over by an OLD, pre-fix version of the migration files
 * (034's own `transformCreateTableSql` comment records the 2026-10-01 prod
 * crash from the bare-name regex missing the quoted `"youtube_channels"`
 * CREATE) keep stragglers: on the drill copy `youtube_channels` still carried
 * `guild_id TEXT` while the repository (`src/db/repositories/youtube.js`)
 * queries ONLY `community_id` → every YouTube feature query throws
 * `SqliteError: no such column: community_id` at runtime. Once `users` lost
 * `guild_id`, every later 034 replay treated the cutover as complete and the
 * per-table rebuild never re-evaluated; #202's user_version fast-skip made
 * "never re-evaluate" even stronger. The CURRENT chain replays fine from
 * pre-cutover states (drill-proven: old e2e WAL DB → full 0→40 replay → parity
 * with fresh) — only DBs carrying the *historical partial application* fail to
 * converge, and this repair migration is the ONLY way they ever will.
 *
 * What it does (all inside ONE transaction, PRAGMA foreign_keys toggled OFF
 * around it exactly like 034 — DROP TABLE under FK enforcement fires
 * ON DELETE CASCADE / SET NULL on child tables and silently deletes or
 * unlinks their rows; see 034's header. The pragma is a no-op INSIDE a
 * transaction, so the toggle wraps run(), restoring whatever was set in
 * `finally`, per sqlite.org/lang_altertable § 5):
 *  1. DETECT stragglers: every table in 034's GUILD_SCOPED_TABLES (imported —
 *     single source of truth, NOT a hardcoded youtube list) that exists AND
 *     still carries a `guild_id` column OR lacks `community_id`. Zero
 *     stragglers → pure no-op return (healthy DB = zero statements).
 *  2. BACKFILL `communities` from the stragglers' distinct non-null guild_id
 *     values (INSERT OR IGNORE, platform='discord', instance_key='discord',
 *     UNION-dedupe + ORDER BY — 034's determinism discipline).
 *  3. REBUILD each straggler the way 034 does: the new CREATE TABLE is derived
 *     from the LIVE sqlite_master DDL via 034's `transformCreateTableSql`
 *     (quote-identifier-safe — it matches the quoted `"table"` spelling that
 *     ALTER … RENAME leaves behind, the exact shape that crashed prod on
 *     2026-10-01), so every column constraint / CHECK / UNIQUE / default / PK
 *     shape survives by construction. Data rides
 *     `INSERT INTO … SELECT … JOIN communities` with guild_id → community_id
 *     mapped through the registry; integer PKs are copied unchanged so child
 *     FK rows keep pointing at the same real rows (034 rule). Named indexes
 *     are captured before the DROP and re-issued after the RENAME with
 *     guild_id → community_id substituted; auto-indexes ride the DDL.
 *  4. FAIL LOUD (specific error naming table + row, full rollback via the
 *     transaction):
 *     - a straggler row whose guild_id matches NO (discord, discord)
 *       communities row AFTER the backfill — post-step-2 that means a NULL
 *       guild_id (034's backfill skipped NULL guild_ids, and a NULL cannot
 *       map into an INTEGER NOT NULL community_id column; deleting such rows
 *       the way 034's JOIN silently did would destroy member data — refusing
 *       the boot and naming the row is the honest choice) or a garbage-shape
 *       value that could not round-trip the communities UNIQUE key;
 *     - a straggler carrying BOTH columns or NEITHER — ambiguous state, no
 *       safe derivation exists;
 *     - `tickets` as a straggler at all: its rows carry `transcript_path`
 *       artifacts (`ticket-transcripts/{guildId}/…`) whose matching directory
 *       moves were 034's POST-COMMIT filesystem hook (`moveTranscriptDirs`) —
 *       un-replayable here. Rebuilding the table alone would half-align paths
 *       with disk (the community-named dirs may or may not already exist for
 *       those guilds); the #283 drill never observed tickets stuck, so
 *       refusing beats guessing the filesystem reality;
 *     - DDL the derivation could not fully convert (a residual `guild_id`
 *       token or a missing `community_id INTEGER NOT NULL`) — 040's
 *       "never claim a schema we did not install" precedent.
 *
 * Idempotence: after a repair the stragglers are gone, so the next pass
 * detects zero and returns; the #202 user_version stamp additionally fast-
 * skips the replay once the whole registry passes (this migration does NOT
 * fight that guard — it runs inside the replay, and after the stamp there is
 * nothing left to do).
 *
 * Ordering: 041 runs AFTER 040. In the partial state `users` is already cut
 * over (that IS the gate marker 034 misread), so 040's CHECK rebuild sees a
 * normal community_id-shaped users table — pinned by test/migrations-heal-041
 * .test.js rather than assumed.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ now: Function, tableExists: Function, getColumns: Function }} helpers
 */

// Single source of truth for the guild-scoped table list and the DDL
// derivation. 034 exposes both (export-only addition; its behaviour is
// unchanged) so this repair can never drift from the cutover it heals.
const { GUILD_SCOPED_TABLES, transformCreateTableSql } = require("./034_communities");

const quoteIdent = (name) => `"${name}"`;

/** Whitespace-normalized SQL for residual-token checks. */
const norm = (sql) => String(sql).replace(/\s+/g, " ").trim();

/** Max row labels quoted in one failure message (logs stay actionable, not megabytes). */
const MAX_REPORTED_ROWS = 5;

/** Temp mapping table (guild snowflake → communities.id), dropped on success. */
const GUILD_MAP_TABLE = "comm041_guild_map";

/**
 * Stragglers: existing guild-scoped tables that still carry `guild_id` or lack
 * `community_id`. Pure read — never mutates, so a zero-hit result can return
 * before any transaction/FK-pragma work (healthy DB = true no-op).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function, getColumns: Function }} helpers
 */
function findStragglers(db, { tableExists, getColumns }) {
  const stragglers = [];
  for (const table of GUILD_SCOPED_TABLES) {
    if (!tableExists(table)) continue;
    const cols = new Set(getColumns(table));
    const hasGuild = cols.has("guild_id");
    const hasCommunity = cols.has("community_id");
    if (hasGuild || !hasCommunity) {
      stragglers.push({ table, hasGuild, hasCommunity });
    }
  }
  return stragglers;
}

/** Primary-key column names (pk order) for one table via PRAGMA table_info. */
function pkColumns(db, table) {
  return db
    .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
    .all()
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

/** Value shape for failure labels: NULL / 'quoted text' / bare number. */
function labelValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return `'${value}'`;
  return String(value);
}

/**
 * Rows that cannot map to a community: NULL guild_id (never backfilled — 034
 * skipped NULLs and an INTEGER NOT NULL community_id cannot hold one) or a
 * guild_id with no (discord, discord) communities row after the backfill.
 * Runs AFTER step 2 so "no match" means a genuinely un-mappable value.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} table
 * @returns {string[]} failure labels (empty when every row maps)
 */
function unmappableRowLabels(db, table) {
  const ddlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table);
  // Rowid-based labelling assumes a rowid table. Every shipped DDL is one
  // (verified: zero `WITHOUT ROWID` in src/db/migrations); fail specific
  // instead of emitting a raw "no such column: rowid" SqliteError.
  if (/WITHOUT\s+ROWID/i.test(ddlRow.sql)) {
    throw new Error(
      `Migration 041_heal_partial_community_cutover refused: ${table} is a WITHOUT ROWID table ` +
        `(unexpected shape — no migration in this repo creates one). Refusing to guess how to ` +
        `re-key it; repair the table to a rowid table first.`
    );
  }

  const offenders = db
    .prepare(
      `SELECT rowid AS __rowid, guild_id AS __guild, s.*
       FROM ${quoteIdent(table)} s
       WHERE s.guild_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM ${GUILD_MAP_TABLE} m WHERE m.guild_id = s.guild_id
          )
       LIMIT ${MAX_REPORTED_ROWS + 1}`,
    )
    .all();
  if (offenders.length === 0) return [];

  const pkCols = pkColumns(db, table);
  const total = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ${quoteIdent(table)} s
       WHERE s.guild_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM ${GUILD_MAP_TABLE} m WHERE m.guild_id = s.guild_id)`,
    )
    .get().n;

  const labels = offenders.map((row) => {
    const ids = pkCols.length
      ? pkCols.map((c) => `${c}=${labelValue(row[c])}`).join(", ")
      : `rowid=${row.__rowid}`;
    const condition =
      row.__guild === null || row.__guild === undefined
        ? "NULL guild_id cannot map to an INTEGER NOT NULL community_id (034 skipped NULL " +
          "guild_ids when backfilling communities; delete the row or assign it a guild)"
        : `guild_id=${labelValue(row.__guild)} matches no (discord, discord) communities row ` +
          "even after the backfill (garbage shape?)";
    return `${table}[${ids}] rowid=${row.__rowid}: ${condition}`;
  });
  const more = total > labels.length ? ` (and ${total - labels.length} more)` : "";
  return labels.concat(more);
}

/**
 * Rebuild one straggler table onto community_id. Must run INSIDE the caller's
 * transaction with FKs off; every mutation here rides the same rollback.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} table
 * @returns {string} the staging table name (informational)
 */
function rebuildStraggler(db, table) {
  const newTable = `${table}_041_new`;
  const ddlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table);
  // Named indexes (and their partial WHERE clauses) are replayed verbatim with
  // the guild_id token swapped (034's approach — every index whose SQL
  // references this table); auto-indexes return with the DDL.
  const indexes = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
    )
    .all(table);
  const columns = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
  const dataCols = columns.map((c) => c.name).filter((name) => name !== "guild_id");

  // Derive the rebuild DDL from the live sqlite_master text (034's
  // transformCreateTableSql: quote-identifier-safe against the 2026-10-01
  // crash, preserves every constraint/PK shape, forces
  // `community_id INTEGER NOT NULL`).
  const staged = transformCreateTableSql(ddlRow.sql, table, newTable);
  if (/\bguild_id\b/.test(staged) || !/\bcommunity_id\s+INTEGER\s+NOT\s+NULL\b/i.test(staged)) {
    throw new Error(
      `Migration 041_heal_partial_community_cutover refused: ${table} DDL is a shape the 034 ` +
        "derivation cannot convert to community_id INTEGER NOT NULL (residual guild_id or an " +
        "unexpected guild_id column type). Refusing to ship a half-repaired schema. " +
        `DDL was: ${norm(ddlRow.sql).slice(0, 400)}`,
    );
  }

  db.exec(staged);

  // Explicit column list (034 rule): every column rides across unchanged and
  // every integer PK is copied verbatim so child FK rows keep their target.
  const cols = dataCols.map(quoteIdent);
  db.prepare(
    `INSERT INTO ${quoteIdent(newTable)} (${["community_id"].concat(cols).join(", ")})
     SELECT m.community_id, ${cols.map((c) => `s.${c}`).join(", ")}
     FROM ${quoteIdent(table)} s
     JOIN ${GUILD_MAP_TABLE} m ON m.guild_id = s.guild_id`,
  ).run();

  // Belt-and-braces: the pre-scan already refuses un-mappable rows, so a
  // count mismatch here would mean a bug in this migration itself.
  const before = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get().n;
  const after = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(newTable)}`).get().n;
  if (before !== after) {
    throw new Error(
      `Migration 041_heal_partial_community_cutover refused: rebuilding ${table} copied ` +
        `${after} of ${before} rows into the community_id shape (never drop data silently).`,
    );
  }

  db.exec(`DROP TABLE ${quoteIdent(table)}`);
  db.exec(`ALTER TABLE ${quoteIdent(newTable)} RENAME TO ${quoteIdent(table)}`);

  for (const idx of indexes) {
    db.exec(idx.sql.replace(/\bguild_id\b/g, "community_id"));
  }

  // Post-check (040's "never claim a schema we did not install" rule).
  const healed = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
  if (!healed.some((c) => c.name === "community_id") || healed.some((c) => c.name === "guild_id")) {
    throw new Error(
      `Migration 041_heal_partial_community_cutover failed its post-rebuild check: ${table} ` +
        "does not carry community_id (without guild_id) after the rebuild.",
    );
  }
  return newTable;
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ now: Function, tableExists: Function, getColumns: Function }} helpers
 * @returns {{ migrated: boolean, healed: string[] }}
 */
function up(db, { now, tableExists, getColumns }) {
  const stragglers = findStragglers(db, { tableExists, getColumns });
  if (stragglers.length === 0) {
    // Healthy (or already-healed) DB: pure no-op, zero statements.
    return { migrated: false, healed: [] };
  }

  // Ambiguous shapes fail loud BEFORE anything mutates. The repairable
  // straggler shape is (guild_id && !community_id); anything else that
  // tripped detection is a coin flip: BOTH columns means no way to know
  // which half is authoritative, NEITHER means there is nothing to derive.
  const ambiguous = stragglers.filter(
    (s) => (s.hasGuild && s.hasCommunity) || (!s.hasGuild && !s.hasCommunity)
  );
  if (ambiguous.length > 0) {
    const detail = ambiguous
      .map((s) =>
        s.hasGuild && s.hasCommunity
          ? `${s.table} carries BOTH guild_id and community_id (which half is authoritative?)`
          : `${s.table} is missing BOTH the guild_id and community_id columns (nothing to derive)`,
      )
      .join("; ");
    throw new Error(
      `Migration 041_heal_partial_community_cutover refused — ambiguous straggler shape: ${detail}. ` +
        "Repair the listed table(s) out-of-band (give them a single guild_id TEXT column holding " +
        "the historical guild snowflakes) so the repair can map them through communities, then start again.",
    );
  }

  if (!tableExists("communities")) {
    throw new Error(
      "Migration 041_heal_partial_community_cutover refused: stragglers were detected but the " +
        "communities table is missing — the 034 cutover never ran on this database. Run the full " +
        "migration chain (load src/db) so 034 can execute before this repair.",
    );
  }

  const ts = now();
  const tables = stragglers.map((s) => s.table);

  // Capability refusal (see header): a `tickets` straggler would need 034's
  // post-commit transcript-directory moves, which this migration cannot
  // replay — refuse loudly BEFORE touching anything instead of shipping a
  // half-repair that desyncs transcript_path values from disk.
  if (tables.includes("tickets")) {
    throw new Error(
      "Migration 041_heal_partial_community_cutover refused: tickets is a guild_id straggler. " +
        "Rebuilding it alone would leave transcript_path values (ticket-transcripts/{guildId}/…) " +
        "and the on-disk transcript directories inconsistent — 034's directory moves ran for its " +
        "guild map only. Repair out-of-band: give every tickets row a real guild_id snowflake " +
        "matching an EXISTING transcript directory (or clear/archive the affected rows), then " +
        "start again — nothing was changed."
    );
  }

  const run = db.transaction(() => {
    // 1. Backfill communities from the stragglers' distinct non-null guild
    //    ids — 034's discipline: UNION dedupes, INSERT OR IGNORE reuses the
    //    existing (discord, discord) rows (their ids survive unchanged), and
    //    ORDER BY keeps AUTOINCREMENT assignment deterministic. NULL
    //    guild_ids ride 034's skip policy; the row scan in step 2 names them.
    const union = tables.map((t) => `SELECT guild_id FROM ${quoteIdent(t)}`).join("\nUNION\n");
    db.prepare(
      `INSERT OR IGNORE INTO communities (platform, instance_key, external_guild_id, created_at)
       SELECT 'discord', 'discord', guild_id, ?
       FROM (${union})
       WHERE guild_id IS NOT NULL
       ORDER BY guild_id`,
    ).run(ts);

    // 2. Guild → community map (034's temp-table pattern: PRIMARY KEY makes
    //    one guild resolve to exactly one community id regardless of how many
    //    platform rows exist for the same external id string).
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS ${GUILD_MAP_TABLE} (
        guild_id TEXT PRIMARY KEY,
        community_id INTEGER NOT NULL
      );
      INSERT OR REPLACE INTO ${GUILD_MAP_TABLE} (guild_id, community_id)
        SELECT external_guild_id, id FROM communities
        WHERE platform = 'discord' AND instance_key = 'discord';
    `);

    // 3. Fail loud on un-mappable rows across EVERY straggler before the
    //    first DROP (040's pre-scan precedent — name every offender).
    const labels = [];
    for (const table of tables) {
      labels.push(...unmappableRowLabels(db, table));
    }
    if (labels.length > 0) {
      throw new Error(
        `Migration 041_heal_partial_community_cutover refused: ${labels.length} row label(s) in ` +
          `the straggler tables cannot map to a community. Offenders: ${labels.join("; ")}. ` +
          "Fix the named rows out-of-band (assign the real guild snowflake or DELETE the row), " +
          "then start again — nothing was changed.",
      );
    }

    // 4. Rebuild every straggler onto community_id (DDL derived from the live
    //    schema, data + PK shape + indexes preserved — 034's approach).
    for (const table of tables) {
      rebuildStraggler(db, table);
    }

    db.exec(`DROP TABLE IF EXISTS ${GUILD_MAP_TABLE}`);
  });

  // PRAGMA foreign_keys is a no-op INSIDE a transaction, so it toggles here,
  // outside run(); restored in `finally` exactly like 034/040 (DROP under FK
  // enforcement would cascade into child tables and delete or unlink rows).
  const fkWasOn = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  try {
    run();
  } finally {
    db.pragma(`foreign_keys = ${fkWasOn ? "ON" : "OFF"}`);
  }

  console.log(
    `[db] Migration 041_heal_partial_community_cutover: healed straggler tables ` +
      `[${tables.join(", ")}] onto community_id (${stragglers.length} rebuilt)`,
  );
  return { migrated: true, healed: tables };
}

module.exports = { id: "041_heal_partial_community_cutover", up, findStragglers };
