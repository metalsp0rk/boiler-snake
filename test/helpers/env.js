const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Clear Node require cache for all project `src/` modules so DB_PATH and
 * feature singletons rebind cleanly for integration tests.
 */
function resetSrcModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}`)) {
      delete require.cache[key];
    }
  }
}

/**
 * @returns {{ tmpDir: string, dbPath: string }}
 */
function createTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boiler-snake-it-"));
  const dbPath = path.join(tmpDir, "test.sqlite");
  return { tmpDir, dbPath };
}

/**
 * Point DB_PATH at a fresh temp SQLite file, clear src cache, load migrations.
 *
 * @returns {{ api: object, tmpDir: string, dbPath: string }}
 */
function loadDb() {
  const { tmpDir, dbPath } = createTempDbPath();
  process.env.DB_PATH = dbPath;
  resetSrcModules();
  const api = require("../../src/db");
  return { api, tmpDir, dbPath };
}

module.exports = {
  resetSrcModules,
  createTempDbPath,
  loadDb,
};
