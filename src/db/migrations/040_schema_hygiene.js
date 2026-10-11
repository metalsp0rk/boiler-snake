/**
 * Schema hygiene (audit-2026-10 #204): CHECK constraints on the two numeric
 * domains the audit flagged, the leaderboard / archived-ticket indexes, and
 * the drop of the dead `voice_sessions` table.
 *
 * Runs entirely inside ONE transaction (the 034 rebuild discipline — 003's
 * non-transactional outlier is the cautionary tale): a crash anywhere rolls
 * the whole migration back, so a half-rebuilt `users` can never survive into
 * the next boot. `PRAGMA foreign_keys` is a no-op inside a transaction, so
 * the toggle wraps the transaction exactly like 034 (sqlite.org
 * lang_altertable § 5). Neither rebuilt table has child FKs today, but the
 * toggle keeps the DROP/RENAME pattern safe regardless.
 *
 * Decisions (documented per the issue):
 *  - `users.xp` CHECK domain: `BETWEEN 0 AND MAX_SAFE_XP` (9007199254740991).
 *    This is EXACTLY the range `clampXpTotal` documents ([0, MAX_SAFE_XP]) and
 *    that runtime code writes: `addXp` caps with `MIN(MAX_SAFE_XP, …)`,
 *    migration 005 clamps junk TO MAX_SAFE_XP, and `getXp`'s repair write can
 *    legitimately PERSIST MAX_SAFE_XP — a tighter bound (e.g. the 1e9
 *    per-award cap) would reject values the app itself writes. The bound is
 *    the AGENTS.md "DB/JS-safe totals" ceiling: every JS-supplied total is
 *    ≤ 2^53−1 by construction, while TEXT junk ('Infinity') and REAL
 *    Infinity compare OUTSIDE the range (SQLite type ordering puts TEXT
 *    above every number), so the CHECK also rejects the audit's
 *    poisoned-cell shapes for free. Fractional REALs pass (every reader
 *    floor-clamps via clampXpTotal) — rejecting them would risk bricking a
 *    real DB over a shape no shipped writer produces.
 *  - `gork_budget_rules.daily_limit` CHECK domain: `BETWEEN -1 AND 1000` —
 *    the tri-state of decision 31 (-1 blocked | 0 unlimited | 1..1000),
 *    which is the contiguous integer domain `clampDailyLimit` (the only
 *    writer, shipped together with 026) produces. `guild_settings.gork_daily_limit`
 *    shares the tri-state but is a settings-layer clamp — out of scope here.
 *  - SQLite cannot ADD CHECK via ALTER, so both tables get the documented
 *    CREATE→copy→DROP→RENAME rebuild, DERIVED FROM THE LIVE DDL (034's
 *    precedent: every other column constraint/default/PK survives by
 *    construction; quoted-table-name spellings are handled like 034 handled
 *    the 003 legacy). An unexpected DDL shape FAILS LOUD instead of silently
 *    skipping the CHECK — the migration must never claim a constraint it did
 *    not install.
 *  - FAIL LOUD on existing violations (#189/039 precedent — no silent data
 *    edits inside a schema rebuild): the pre-scan runs the SAME predicate as
 *    the CHECK; violating rows are refused by name (ids + typeof + value
 *    preview, capped), and the message says how to fix it. Rows written by
 *    the shipped repositories can never violate (every writer clamps), so
 *    this only fires on out-of-band tampering.
 *  - Indexes:
 *      * `idx_users_guild_xp (community_id, xp DESC, user_id ASC)` serves the
 *        slash leaderboard (`topUsers`: WHERE community_id ORDER BY xp DESC
 *        LIMIT) AND the web page (adds the user_id ASC tie-break) with one
 *        covering, sort-free index; created AFTER the users rebuild (a
 *        rebuild destroys dependent indexes) so both order paths converge.
 *      * `idx_tickets_archived (community_id, closed_at DESC, ticket_number
 *        DESC) WHERE archived = 1 AND transcript_token IS NOT NULL` — the
 *        partial predicate is exactly what every archived-listing read
 *        filters on (listArchivedTickets et al.), and the column order
 *        matches the community-scoped ORDER BY (no temp B-tree).
 *  - `voice_sessions` DROP: dead weight verified twice — the write side
 *    (repositories/voiceSessions.js) had ZERO callers in src/, so the only
 *    reader (the web /voice sessions panel) always rendered an empty panel
 *    and the table never holds rows on a bot-managed DB. The paired code
 *    removal (repository, facade entries, web read-model + panel) ships in
 *    the same commit. Old migrations stay frozen (001/034 still name the
 *    table; 034's rebuild loop tableExists-guards it away after the drop).
 *    Note: a FULL replay pass (any user_version mismatch) re-runs 001, which
 *    recreates an empty shell of the table before 040 drops it again — the
 *    end-of-pass state converges (gone, and it can never hold rows since no
 *    writer exists), so fresh and migrated DBs land on the same post-040
 *    schema; parity is pinned by test/schema-hygiene-040.test.js.
 *
 * Idempotent: the rebuilds are CHECK-presence guarded (replay = no-op), the
 * drop is existence guarded, the index creates are IF NOT EXISTS.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: (name: string) => boolean }} helpers
 */

const { MAX_SAFE_XP } = require("../../core/xpMath");

/** Rebuild plan per table: DDL injection + violation predicate + labels. */
const REBUILDS = [
  {
    table: "users",
    checkText: `CHECK (xp BETWEEN 0 AND ${MAX_SAFE_XP})`,
    // Column definition as 001 wrote it and 034's DDL-derivation preserved.
    columnRe: /(^|[,(]\s*)(xp\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0)\b/i,
    violationSql: `
      SELECT community_id, user_id, typeof(xp) AS valueType, xp AS offender
      FROM users
      WHERE xp IS NULL OR xp < 0 OR xp > ?
    `,
    violationParams: [MAX_SAFE_XP],
    idColumns: ["community_id", "user_id"],
    valueColumn: "xp",
    fixHint:
      `Every violating row is outside the JS-safe XP domain [0, ${MAX_SAFE_XP}] ` +
      "(TEXT junk like 'Infinity' included). Fix it out-of-band, e.g. " +
      `"UPDATE users SET xp = 0 WHERE community_id=? AND user_id=?" (mirroring ` +
      "src/core/xpMath's clampXpTotal semantics), then start again.",
  },
  {
    table: "gork_budget_rules",
    checkText: "CHECK (daily_limit BETWEEN -1 AND 1000)",
    columnRe: /(^|[,(]\s*)(daily_limit\s+INTEGER\s+NOT\s+NULL)\b/i,
    violationSql: `
      SELECT community_id, scope_kind, target_id, typeof(daily_limit) AS valueType,
             daily_limit AS offender
      FROM gork_budget_rules
      WHERE daily_limit IS NULL OR daily_limit < -1 OR daily_limit > 1000
    `,
    violationParams: [],
    idColumns: ["community_id", "scope_kind", "target_id"],
    valueColumn: "daily_limit",
    fixHint:
      "Every violating rule is outside the tri-state domain -1 blocked | 0 unlimited | " +
      "1..1000 (decision 31). Fix it out-of-band (UPDATE ... SET daily_limit = 0, or " +
      "DELETE the rule), then start again.",
  },
];

/** Max row labels quoted in one failure message (logs stay actionable, not megabytes). */
const MAX_REPORTED_ROWS = 5;

const quoteIdent = (name) => `"${name}"`;

/** Whitespace-normalized SQL, for comparing injected CHECK text against stored DDL. */
const norm = (sql) => String(sql).replace(/\s+/g, " ").trim();

/**
 * CREATE-TABLE prefix matcher accepting every spelling sqlite_master can hold
 * after an ALTER … RENAME (034's comment on the 003 prod crash: renames
 * rewrite the stored SQL with a QUOTED identifier).
 * @param {string} table
 */
function createPrefixRe(table) {
  const ident = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `CREATE TABLE (?:IF NOT EXISTS )?(?:${ident}\\b|"${ident}"|'${ident}'|\`${ident}\`|\\[${ident}\\])`,
    "i"
  );
}

/** "users(community_id=7, user_id=u1) xp=<text> Infinity" — ids + shape, capped preview. */
function violationLabel(spec, row) {
  const ids = spec.idColumns.map((c) => `${c}=${row[c]}`).join(", ");
  const raw = String(row.offender);
  const preview = raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
  return `${spec.table}(${ids}) ${spec.valueColumn}=<${row.valueType}> ${preview}`;
}

/**
 * Rebuild one table with its CHECK injected, derived from the live DDL.
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: (name: string) => boolean }} helpers
 * @param {typeof REBUILDS[number]} spec
 * @returns {"absent" | "already-checked" | "rebuilt"}
 */
function rebuildWithCheck(db, helpers, spec) {
  if (!helpers.tableExists(spec.table)) return "absent";

  const ddlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(spec.table);
  if (norm(ddlRow.sql).includes(norm(spec.checkText))) return "already-checked";

  // Fail loud BEFORE touching anything: the INSERT…SELECT below would abort
  // the transaction on these rows anyway — the point is to NAME them.
  const violations = db.prepare(spec.violationSql).all(...spec.violationParams);
  if (violations.length > 0) {
    const labels = violations.slice(0, MAX_REPORTED_ROWS).map((row) => violationLabel(spec, row));
    const more =
      violations.length > MAX_REPORTED_ROWS
        ? ` (and ${violations.length - MAX_REPORTED_ROWS} more)`
        : "";
    throw new Error(
      `Migration 040_schema_hygiene refused: ${violations.length} row(s) in ${spec.table} ` +
        `violate the ${norm(spec.checkText)} constraint it must install and would brick boot. ` +
        `Offenders: ${labels.join("; ")}${more}. ${spec.fixHint}`
    );
  }

  const staging = `${spec.table}_040_new`;
  const createRe = createPrefixRe(spec.table);
  const renamed = ddlRow.sql.replace(
    createRe,
    (match) => match.replace(spec.table, staging).replace(/ IF NOT EXISTS/i, "")
  );
  const injected = renamed.replace(
    spec.columnRe,
    (_m, lead, colDef) => `${lead}${colDef} ${spec.checkText}`
  );
  if (injected === renamed || !norm(injected).includes(norm(spec.checkText))) {
    throw new Error(
      `Migration 040_schema_hygiene refused: unexpected ${spec.table} DDL — the ` +
        `${norm(spec.checkText)} column constraint could not be derived from the live schema ` +
        `(shape drift since 001/026). Refusing to ship a schema without the constraint.`
    );
  }

  // Named indexes ride the DROP — capture and re-issue (034 discipline).
  const indexes = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL"
    )
    .all(spec.table);
  const columns = db
    .prepare(`PRAGMA table_info(${spec.table})`)
    .all()
    .map((c) => c.name);

  db.exec(injected);
  db.prepare(
    `INSERT INTO ${staging} (${columns.map(quoteIdent).join(", ")})
     SELECT ${columns.map(quoteIdent).join(", ")} FROM ${spec.table}`
  ).run();
  db.exec(`DROP TABLE ${spec.table}`);
  db.exec(`ALTER TABLE ${staging} RENAME TO ${spec.table}`);
  for (const idx of indexes) db.exec(idx.sql);

  // Belt-and-braces: the STORED DDL must carry the constraint.
  const after = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(spec.table);
  if (!norm(after.sql).includes(norm(spec.checkText))) {
    throw new Error(
      `Migration 040_schema_hygiene failed its post-rebuild check: ${spec.table} DDL ` +
        `does not contain ${norm(spec.checkText)} after the rebuild.`
    );
  }
  return "rebuilt";
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: (name: string) => boolean }} helpers
 * @returns {{ rebuilt: string[], skipped: string[], dropped: boolean }}
 */
function up(db, helpers) {
  const summary = { rebuilt: [], skipped: [], dropped: false };

  const run = db.transaction(() => {
    for (const spec of REBUILDS) {
      const result = rebuildWithCheck(db, helpers, spec);
      if (result === "rebuilt") summary.rebuilt.push(spec.table);
      else summary.skipped.push(`${spec.table}:${result}`);
    }

    // Dead weight (audit §3 "Schema"): zero writers were ever wired, so the
    // table is empty by construction. See the file header.
    if (helpers.tableExists("voice_sessions")) {
      db.exec("DROP TABLE voice_sessions");
      summary.dropped = true;
    }

    // Leaderboard path: one covering index serves BOTH shipped order shapes
    // — topUsers `ORDER BY xp DESC LIMIT n` (slash) and the web page's
    // `ORDER BY xp DESC, user_id ASC LIMIT ? OFFSET ?` — sort-free, because
    // the community_id equality prefix leaves exactly the ORDER BY columns
    // in index order. Created after the users rebuild above (a rebuild
    // destroys dependent indexes; this order keeps both paths convergent).
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_users_guild_xp
        ON users (community_id, xp DESC, user_id ASC)
    `);

    // Archived-ticket listing: partial index matching the exact predicate
    // every archived read carries (archived = 1 AND transcript_token IS NOT
    // NULL), ordered for the community-scoped listing (closed_at DESC,
    // ticket_number DESC). Open tickets never touch this index.
    if (helpers.tableExists("tickets")) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tickets_archived
          ON tickets (community_id, closed_at DESC, ticket_number DESC)
          WHERE archived = 1 AND transcript_token IS NOT NULL
      `);
    }
  });

  // No-op inside a transaction — toggle outside (034 pattern).
  const fkWasOn = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  try {
    run();
  } finally {
    db.pragma(`foreign_keys = ${fkWasOn ? "ON" : "OFF"}`);
  }

  if (summary.rebuilt.length > 0 || summary.dropped) {
    console.log(
      `[db] Migration 040_schema_hygiene: rebuilt [${summary.rebuilt.join(", ") || "none"}] ` +
        `with CHECK constraints, dropped voice_sessions, created idx_users_guild_xp ` +
        `+ idx_tickets_archived`
    );
  }
  return summary;
}

module.exports = { id: "040_schema_hygiene", up };
