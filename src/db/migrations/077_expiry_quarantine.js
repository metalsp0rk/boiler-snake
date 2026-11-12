/**
 * #810 — the expiry engine must be able to FIRE a chronically failing row
 * and to REACH every community on boot.
 *
 * Two structural gaps, both fixed append-only:
 *
 *  1. QUARANTINE. A record whose `finalizeExpiry` can never succeed (dead
 *     community, MissingAccess, permanent 50013) returned to `active` after
 *     every lease and re-entered the oldest-first `LIMIT` slice forever:
 *     N oldest permanently-failing rows own the sweep, every younger expiry
 *     starves indefinitely, and the failures burn REST + log lines each
 *     pass. `expiry_attempts INTEGER NOT NULL DEFAULT 0` counts REAL
 *     winner-side attempts (a loser to the claim lease did nothing and
 *     never counts), and the status CHECK widens with the terminal
 *     `expiry_failed`: after the configured ceiling the row leaves the
 *     `active` domain — the sweep and reconcile stop selecting it, staff
 *     get the loud embed + audit row. Widening follows the 075/076 law:
 *     DDL-derived rebuild, pure EXTENSION (existing rows can never
 *     violate), one transaction with the FK toggle outside, stored-DDL
 *     belt + foreign_key_check(ban_appeals) child belt.
 *
 *  2. RECONCILE ROTATION. The boot reconcile took the SAME deterministic
 *     top-25 communities every boot (newest-ban order) — bots in more than
 *     25 active-ban guilds NEVER reconciled communities 26+.
 *     `ban_reconcile_state(community_id PK → communities CASCADE,
 *     last_reconciled_at)` records one attempt timestamp per community;
 *     the reconcile scope orders never-reconciled first, then
 *     least-recently-reconciled, so every guild converges over successive
 *     boots. The row is written at attempt START: an unreachable guild
 *     rotates too (round-robin fairness — a broken guild must not camp at
 *     the head because its pass failed).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function, addColumnIfMissing: Function }} helpers
 * @returns {{ rebuilt: boolean, columnAdded: boolean, stateTable: boolean }}
 */

const REBUILT_CHECK_ENTRY = "'expiry_failed'";

/** The live status CHECK's IN-list (074 stored it verbatim in sqlite_master). */
const STATUS_LIST_RE = /status\s+IN\s*\(([^)]*)\)/i;

const quoteIdent = (name) => `"${name}"`;

/** Whitespace-normalized SQL, for comparing injected CHECK text against stored DDL (040). */
const norm = (sql) => String(sql).replace(/\s+/g, " ").trim();

/**
 * CREATE-TABLE prefix matcher accepting every spelling sqlite_master can hold
 * after an ALTER … RENAME (040/034 lesson: renames rewrite the stored SQL
 * with a QUOTED identifier).
 * @param {string} table
 */
function createPrefixRe(table) {
  const ident = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `CREATE TABLE (?:IF NOT EXISTS )?(?:${ident}\\b|"${ident}"|'${ident}'|\`${ident}\`|\\[${ident}\\])`,
    "i",
  );
}

/**
 * Widen the ban_records status CHECK with `expiry_failed` via the 075/076-
 * derived rebuild: rows, ids, the AUTOINCREMENT sequence, both named UNIQUE
 * belts and the plain indexes all ride along (captured from sqlite_master,
 * re-issued after the rename).
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {"already-extended" | "rebuilt"}
 */
function extendBanRecordsStatusCheck(db) {
  const ddlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get("ban_records");
  const ddl = String(ddlRow?.sql || "");

  // Idempotent replay: the entry rides only in the widened CHECK.
  if (ddl.includes(REBUILT_CHECK_ENTRY)) return "already-extended";

  const listMatch = ddl.match(STATUS_LIST_RE);
  if (!listMatch) {
    throw new Error(
      "Migration 077_expiry_quarantine refused: unexpected ban_records DDL — the status " +
        "CHECK IN-list could not be derived from the live schema (shape drift since " +
        "074/075/076). Refusing to ship a rebuild without the widened constraint.",
    );
  }

  // Pure EXTENSION: the 074+075+076 domain is a subset of the new one, so
  // existing rows can never violate the widened CHECK.
  const extendedList = `${listMatch[1]},${REBUILT_CHECK_ENTRY}`;
  const extendedCheck = `status IN (${extendedList})`;

  const staging = "ban_records_077_new";
  const createRe = createPrefixRe("ban_records");
  const renamed = ddl.replace(
    createRe,
    (match) => match.replace("ban_records", staging).replace(/ IF NOT EXISTS/i, ""),
  );
  const injected = renamed.replace(listMatch[0], extendedCheck);
  if (injected === renamed || !norm(injected).includes(norm(extendedCheck))) {
    throw new Error(
      `Migration 077_expiry_quarantine refused: the ${norm(extendedCheck)} constraint could ` +
        "not be injected into the derived ban_records DDL. Refusing to claim a " +
        "constraint it did not install.",
    );
  }

  // Named indexes ride the DROP — capture and re-issue (034/040 discipline).
  const indexes = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
    )
    .all("ban_records");
  const columns = db
    .prepare(`PRAGMA table_info(ban_records)`)
    .all()
    .map((c) => c.name);

  db.exec(injected);
  db.prepare(
    `INSERT INTO ${staging} (${columns.map(quoteIdent).join(", ")})
     SELECT ${columns.map(quoteIdent).join(", ")} FROM ban_records`,
  ).run();
  db.exec("DROP TABLE ban_records");
  db.exec(`ALTER TABLE ${staging} RENAME TO ban_records`);
  for (const idx of indexes) db.exec(idx.sql);

  // Belt-and-braces: the STORED DDL must carry the widened CHECK.
  const after = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get("ban_records");
  if (!norm(after.sql).includes(norm(extendedCheck))) {
    throw new Error(
      `Migration 077_expiry_quarantine failed its post-rebuild check: ban_records DDL does ` +
        `not contain ${norm(extendedCheck)} after the rebuild.`,
    );
  }

  // Defensive child-binding belt (075's law): ban_appeals rows must still
  // bind to the renamed table row-for-row.
  if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ban_appeals'`).get()) {
    const broken = db.prepare("PRAGMA foreign_key_check(ban_appeals)").all();
    if (broken.length > 0) {
      throw new Error(
        `Migration 077_expiry_quarantine failed its post-rebuild check: ${broken.length} ` +
          "ban_appeals row(s) lost their ban_records binding across the rebuild.",
      );
    }
  }

  return "rebuilt";
}

function up(db, { tableExists, addColumnIfMissing }) {
  if (!tableExists("ban_records")) {
    throw new Error(
      "077_expiry_quarantine: the 'ban_records' table is missing — migration 074_ban_lifecycle must run first; " +
        "quarantine and reconcile rotation are meaningless without the records they govern",
    );
  }

  const summary = { rebuilt: false, columnAdded: false, stateTable: false };

  const run = db.transaction(() => {
    // The attempt counter first: the CHECK rebuild DERIVES the live DDL, so
    // the staged table carries the new column by construction. ALTER ADD
    // COLUMN with a constant DEFAULT is the SQLite-legal form of
    // NOT NULL-on-existing-rows (every existing row backfills to 0).
    summary.columnAdded = addColumnIfMissing(
      "ban_records",
      "expiry_attempts",
      "expiry_attempts INTEGER NOT NULL DEFAULT 0",
    );
    summary.rebuilt = extendBanRecordsStatusCheck(db) === "rebuilt";

    // Reconcile rotation state (idempotent by IF NOT EXISTS — a re-run
    // after a partial crash keeps every timestamp already recorded).
    const before = !!db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ban_reconcile_state'")
      .get();
    db.exec(`
CREATE TABLE IF NOT EXISTS ban_reconcile_state (
  community_id INTEGER PRIMARY KEY REFERENCES communities(id) ON DELETE CASCADE,
  last_reconciled_at INTEGER NOT NULL
);
`);
    summary.stateTable = !before;
  });

  // No-op inside a transaction — toggle outside (034/040/075/076 pattern).
  const fkWasOn = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  try {
    run();
  } finally {
    db.pragma(`foreign_keys = ${fkWasOn ? "ON" : "OFF"}`);
  }

  if (summary.rebuilt) {
    console.log(
      "[db] Migration 077_expiry_quarantine: rebuilt ban_records with the expiry_failed status CHECK " +
        "(#810), added expiry_attempts, created ban_reconcile_state (reconcile rotation)",
    );
  }
  return summary;
}

module.exports = { id: "077_expiry_quarantine", up };
