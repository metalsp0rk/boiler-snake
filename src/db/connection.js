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
db.pragma("journal_mode = WAL");

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
