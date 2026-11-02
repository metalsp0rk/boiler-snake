/**
 * Ban appeals (#773): the `ban_appeals` table, the `clemency_granted` CHECK
 * extension on `ban_records`, and the per-guild `ban_appeals` toggle.
 *
 * 074 froze the ban_records status machine with an explicit promise: "SQLite
 * cannot widen a CHECK in place, so #773 adds `clemency_granted` via a NEW
 * migration (rebuild or table amendment), never by editing this file." This
 * file IS that migration — 074 stays byte-frozen, and
 * BAN_RECORD_STATUSES in src/db/repositories/banRecords.js gains the one
 * appended entry in the same commit (test/ban-records-repo.test.js reads the
 * stored CHECK text from sqlite_master and fails on any drift between the
 * two vocabularies).
 *
 * - `ban_appeals`: one row per APPEALABLE ban cycle. `ban_record_id` carries
 *   a NAMED UNIQUE index (074's belt posture: named so the repository's
 *   error path can name it) — ONE appeal per ban cycle is schema law, not
 *   intake luck. Statuses: `filed` (intake landed, ticket not yet created) →
 *   `open` (staff ticket exists, relay live) → exactly one of
 *   `granted|denied|closed` via the single-winner outcome claim. Timestamps
 *   are ms epochs (repo-driven `now()`, same as every 07x table).
 * - Ferry cursors are FOUR plain columns (id + ts per direction): the hot
 *   path is a single-row lookup by appeal id (the PK), so nothing indexes
 *   them and no JSON parse rides the relay. Simple beats clever here.
 * - FK posture mirrors 074/068: real `ON DELETE CASCADE` on both parents
 *   (the community owns the appeal; the ban record is its identity) with the
 *   034 ordering guard — an appeal must never exist unscoped or dangling.
 * - The `ban_records` rebuild copies 040_schema_hygiene's pragma-safe
 *   discipline exactly: ONE transaction, `PRAGMA foreign_keys` toggled OFF
 *   outside the transaction (it is a no-op inside; sqlite.org
 *   lang_altertable § 5), new table derived from the LIVE DDL, copy rows,
 *   drop, rename, re-issue the captured indexes, and a post-rebuild check
 *   that the STORED DDL really carries the widened CHECK. 040's fail-loud
 *   violation pre-scan is deliberately NOT copied: this extension only
 *   ENLARGES the admitted set, so a row that satisfied the 074 CHECK cannot
 *   violate the 075 one. The rebuild is CHECK-presence guarded (replay =
 *   no-op). Ban-number/id stability: ids are copied explicitly and the
 *   AUTOINCREMENT sequence continues past MAX(id) — nothing is ever
 *   renumbered (074's stable-id contract, which `appeal:<banRecordId>`
 *   customIds depend on).
 * - `ban_appeals` guild toggle (guild_settings): the intake gate of the
 *   074 ban_dm family — default ON, and updateGuildSettings normalizes it
 *   with the same explicit-off tri-state.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function, addColumnIfMissing: Function }} helpers
 */

const REBUILT_CHECK_ENTRY = "'clemency_granted'";

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
 * Widen the ban_records status CHECK with `clemency_granted` via the
 * 040-style DDL-derived rebuild. Preserves rows (explicit column copy),
 * ids, the AUTOINCREMENT sequence, and BOTH named UNIQUE belts plus the two
 * plain indexes (captured from sqlite_master, re-issued after the rename).
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
      "Migration 075_ban_appeals refused: unexpected ban_records DDL — the status " +
        "CHECK IN-list could not be derived from the live schema (shape drift since " +
        "074). Refusing to ship a rebuild without the widened constraint.",
    );
  }

  // Pure EXTENSION: the 074 domain is a subset of the new one, so existing
  // rows can never violate (040's fail-loud pre-scan guards the opposite —
  // a NEW constraint on an unbounded column).
  const extendedList = `${listMatch[1]},${REBUILT_CHECK_ENTRY}`;
  const extendedCheck = `status IN (${extendedList})`;

  const staging = "ban_records_075_new";
  const createRe = createPrefixRe("ban_records");
  const renamed = ddl.replace(
    createRe,
    (match) => match.replace("ban_records", staging).replace(/ IF NOT EXISTS/i, ""),
  );
  const injected = renamed.replace(listMatch[0], extendedCheck);
  if (injected === renamed || !norm(injected).includes(norm(extendedCheck))) {
    throw new Error(
      `Migration 075_ban_appeals refused: the ${norm(extendedCheck)} constraint could ` +
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
      `Migration 075_ban_appeals failed its post-rebuild check: ban_records DDL does ` +
        `not contain ${norm(extendedCheck)} after the rebuild.`,
    );
  }

  // Defensive (never the normal path — the CREATE below runs AFTER this
  // rebuild, so no child exists on a clean pass): a ban_appeals table that
  // somehow predates a re-extended ban_records must still bind to the
  // renamed table row-for-row.
  if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ban_appeals'`).get()) {
    const broken = db.prepare("PRAGMA foreign_key_check(ban_appeals)").all();
    if (broken.length > 0) {
      throw new Error(
        `Migration 075_ban_appeals failed its post-rebuild check: ${broken.length} ` +
          "ban_appeals row(s) lost their ban_records binding across the rebuild.",
      );
    }
  }

  return "rebuilt";
}

/**
 * The appeals table (074's grammar: inline CHECKs on the vocabulary columns,
 * named UNIQUE belt as a separate index so the repository's error path can
 * name it, community-scoped helper index with the exact read predicate).
 */
const CREATE_BAN_APPEALS_SQL = `
CREATE TABLE IF NOT EXISTS ban_appeals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  ban_record_id INTEGER NOT NULL REFERENCES ban_records(id) ON DELETE CASCADE,
  ticket_channel_id TEXT,
  status TEXT NOT NULL DEFAULT 'filed'
    CHECK (status IN ('filed','open','granted','denied','closed')),
  appeal_statement TEXT NOT NULL,
  ferry_user_msg_id TEXT,
  ferry_user_ts INTEGER,
  ferry_ticket_msg_id TEXT,
  ferry_ticket_ts INTEGER,
  ferry_paused INTEGER NOT NULL DEFAULT 0,
  decided_by TEXT,
  decided_at INTEGER,
  denial_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ban_appeals_ban_record
  ON ban_appeals(ban_record_id);
CREATE INDEX IF NOT EXISTS idx_ban_appeals_ticket
  ON ban_appeals(community_id, ticket_channel_id)
  WHERE ticket_channel_id IS NOT NULL;
`;

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function, addColumnIfMissing: Function }} helpers
 * @returns {{ rebuilt: boolean, settingAdded: boolean }}
 */
function up(db, { tableExists, addColumnIfMissing }) {
  if (!tableExists("communities")) {
    throw new Error(
      "075_ban_appeals: the 'communities' table is missing — migration 034_communities must run first; " +
        "ban appeals are community-scoped rows and must never be created unscoped",
    );
  }
  if (!tableExists("ban_records")) {
    throw new Error(
      "075_ban_appeals: the 'ban_records' table is missing — migration 074_ban_lifecycle must run first; " +
        "an appeal is keyed to exactly one ban record and must never dangle",
    );
  }

  const summary = { rebuilt: false, settingAdded: false };

  const run = db.transaction(() => {
    // Order is load-bearing: the rebuild runs BEFORE the child table is
    // created, so on a clean pass nothing references ban_records while it is
    // dropped/renamed (the FK-off toggle still protects the replay-into-a-
    // drifted-DB path; see the post-rebuild foreign_key_check belt).
    summary.rebuilt = extendBanRecordsStatusCheck(db) === "rebuilt";

    db.exec(CREATE_BAN_APPEALS_SQL);

    // Intake gate, 074's default-ON toggle family: OFF removes the Appeal
    // button from new ban DMs and refuses new filings; existing appeals
    // stay decidable (the toggle gates INTAKE, not outcomes).
    summary.settingAdded = addColumnIfMissing(
      "guild_settings",
      "ban_appeals",
      "ban_appeals INTEGER NOT NULL DEFAULT 1",
    );
  });

  // No-op inside a transaction — toggle outside (034/040 pattern).
  const fkWasOn = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  try {
    run();
  } finally {
    db.pragma(`foreign_keys = ${fkWasOn ? "ON" : "OFF"}`);
  }

  if (summary.rebuilt) {
    console.log(
      "[db] Migration 075_ban_appeals: rebuilt ban_records with the clemency_granted " +
        "status CHECK (#773), created ban_appeals + guild toggle",
    );
  }
  return summary;
}

module.exports = { id: "075_ban_appeals", up };
