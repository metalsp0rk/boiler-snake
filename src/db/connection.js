const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

// DB location (Docker-friendly):
// - DB_PATH: full path to the .sqlite file
// - DATA_DIR: directory for xpbot.sqlite (default: project root)
const defaultDataDir = path.join(__dirname, "..", "..");
const dataDir = process.env.DATA_DIR || defaultDataDir;
const dbPath = process.env.DB_PATH || path.join(dataDir, "xpbot.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

// Explicit connection pragmas (audit-2026-10 #202). Every value below MATCHES
// what this bot effectively ran with before (SQLite ambient defaults are
// OFF/FULL/0 — better-sqlite3 opens with foreign_keys=ON and busy_timeout=5000
// already; only WAL was set here). They are now written down so a library
// upgrade can never silently change runtime behaviour, and so
// `test/migrations-user-version.test.js` can pin them. Flipping one is a
// deliberate schema/behaviour decision, not a default drift.
//   - journal_mode=WAL: readers never block the writer; -wal/-shm sidecars
//     live beside the DB file (see docs/database.md § Single-writer contract).
//   - foreign_keys=ON: enforcement ON today (better-sqlite3 default, verified
//     by tests) — migration 034 toggles it OFF around its own table rebuilds
//     and restores whatever this line set (src/db/migrations/034_communities.js).
//   - synchronous=FULL: crash-durable on every commit (SQLite default kept).
//   - busy_timeout=5000: bounded wait instead of instant SQLITE_BUSY so a
//     brief overlap (e.g. an `sqlite3` CLI `.backup` on the same file) does
//     not error — it does NOT license a second writer process; the
//     single-writer contract in docs/database.md still applies.
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = FULL");
db.pragma("busy_timeout = 5000");

function now() {
  return Date.now();
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function tableExists(name) {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
  return !!row;
}

/**
 * @param {string} table
 * @returns {string[]}
 */
function getColumns(table) {
  if (!tableExists(table)) return [];
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

/**
 * SQLite does not support IF NOT EXISTS for columns.
 * @param {string} table
 * @param {string} columnName
 * @param {string} columnDefSql e.g. "reaction_xp INTEGER NOT NULL DEFAULT 2"
 */
function addColumnIfMissing(table, columnName, columnDefSql) {
  const cols = new Set(getColumns(table));
  if (cols.has(columnName)) return false;
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnDefSql}`).run();
  return true;
}

/**
 * Primary-key column names for a table, ordered by pk index.
 * @param {string} table
 * @returns {string[]}
 */
function getPrimaryKeyColumns(table) {
  if (!tableExists(table)) return [];
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

module.exports = {
  db,
  dbPath,
  dataDir,
  now,
  tableExists,
  getColumns,
  addColumnIfMissing,
  getPrimaryKeyColumns,
};
