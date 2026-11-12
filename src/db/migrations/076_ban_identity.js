/**
 * #809 — the expiry auto-unban must be able to recognize ITS OWN ban.
 *
 * Discord bans are (guild,user)-keyed with no ban id: when a ban is lifted
 * outside the bot and a fresh one issued (moderator re-ban during bot
 * downtime), the active record can no longer tell whether the live ban is
 * the one it issued — and the expiry sweep would lift the moderator's newer
 * ban, stamp the old record `expired_unbanned`, and DM a returning-member
 * welcome + invite to a member a human just re-banned.
 *
 * Two additions, both append-only:
 *
 *  1. `ban_identity_reason TEXT` — the live ban reason captured (via
 *     fetchBan) at ban-issue time: the record's fingerprint of the ban it
 *     owns. NULL = never captured (every pre-#809 row, or a ban issued
 *     while the identity read failed) — expiry then falls back to the
 *     historical behavior (the reason is the ONLY identity the v10 Ban
 *     payload carries: no ban id, no creation date, no moderator on this
 *     SDK's GuildBan shape — verified against the pinned discord-api-types).
 *  2. The status CHECK widens with `expired_held` — the terminal outcome
 *     "the term lapsed but the live ban does not match the record: staff
 *     owns whatever is live now; the auto-unban was HELD (never executed)
 *     and no welcome DM is sent." Widening follows the 075 law: a CHECK
 *     cannot be altered in place, so the rebuild is DDL-derived (040
 *     pattern), a pure EXTENSION of the domain (existing rows can never
 *     violate), runs in ONE transaction with the FK toggle outside, and
 *     ends with a stored-DDL belt plus a foreign_key_check(ban_appeals)
 *     child-binding belt.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function, addColumnIfMissing: Function }} helpers
 * @returns {{ rebuilt: boolean, columnAdded: boolean }}
 */

const REBUILT_CHECK_ENTRY = "'expired_held'";

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
 * Widen the ban_records status CHECK with `expired_held` via the 075-derived
 * rebuild: rows, ids, the AUTOINCREMENT sequence, both named UNIQUE belts and
 * the plain indexes all ride along (captured from sqlite_master, re-issued
 * after the rename).
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
      "Migration 076_ban_identity refused: unexpected ban_records DDL — the status " +
        "CHECK IN-list could not be derived from the live schema (shape drift since " +
        "074/075). Refusing to ship a rebuild without the widened constraint.",
    );
  }

  // Pure EXTENSION: the 074+075 domain is a subset of the new one, so
  // existing rows can never violate the widened CHECK.
  const extendedList = `${listMatch[1]},${REBUILT_CHECK_ENTRY}`;
  const extendedCheck = `status IN (${extendedList})`;

  const staging = "ban_records_076_new";
  const createRe = createPrefixRe("ban_records");
  const renamed = ddl.replace(
    createRe,
    (match) => match.replace("ban_records", staging).replace(/ IF NOT EXISTS/i, ""),
  );
  const injected = renamed.replace(listMatch[0], extendedCheck);
  if (injected === renamed || !norm(injected).includes(norm(extendedCheck))) {
    throw new Error(
      `Migration 076_ban_identity refused: the ${norm(extendedCheck)} constraint could ` +
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
      `Migration 076_ban_identity failed its post-rebuild check: ban_records DDL does ` +
        `not contain ${norm(extendedCheck)} after the rebuild.`,
    );
  }

  // Defensive child-binding belt (075's law): ban_appeals rows must still
  // bind to the renamed table row-for-row.
  if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ban_appeals'`).get()) {
    const broken = db.prepare("PRAGMA foreign_key_check(ban_appeals)").all();
    if (broken.length > 0) {
      throw new Error(
        `Migration 076_ban_identity failed its post-rebuild check: ${broken.length} ` +
          "ban_appeals row(s) lost their ban_records binding across the rebuild.",
      );
    }
  }

  return "rebuilt";
}

function up(db, { tableExists, addColumnIfMissing }) {
  if (!tableExists("ban_records")) {
    throw new Error(
      "076_ban_identity: the 'ban_records' table is missing — migration 074_ban_lifecycle must run first; " +
        "the expiry re-ban guard is meaningless without the records it fingerprints",
    );
  }

  const summary = { rebuilt: false, columnAdded: false };

  const run = db.transaction(() => {
    // The identity column first: the CHECK rebuild DERIVES the live DDL, so
    // the staged table carries the new column by construction.
    summary.columnAdded = addColumnIfMissing(
      "ban_records",
      "ban_identity_reason",
      "ban_identity_reason TEXT",
    );
    summary.rebuilt = extendBanRecordsStatusCheck(db) === "rebuilt";
  });

  // No-op inside a transaction — toggle outside (034/040/075 pattern).
  const fkWasOn = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  try {
    run();
  } finally {
    db.pragma(`foreign_keys = ${fkWasOn ? "ON" : "OFF"}`);
  }

  if (summary.rebuilt) {
    console.log(
      "[db] Migration 076_ban_identity: rebuilt ban_records with the expired_held status CHECK " +
        "(#809) and added ban_identity_reason",
    );
  }
  return summary;
}

module.exports = { id: "076_ban_identity", up };
