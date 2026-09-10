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
 * Build an idempotent, never-throwing teardown for a temp env: closes every
 * tracked better-sqlite3 handle (close flushes WAL/checkpoints, so do it
 * before removing files) and recursively removes the temp dir (covers WAL
 * sidecars). Best-effort: cleanup swallows individual failures so a broken
 * handle or a vanished dir never fails a test run.
 *
 * `dbs` is a live array; loaders push handles into it as they open them and
 * cleanup closes whatever is registered at call time.
 *
 * @param {{ tmpDir: string, dbs: Array<{ close?: () => void }> }} parts
 * @returns {() => void} cleanup (safe to call more than once)
 */
function createCleanup({ tmpDir, dbs }) {
  let cleaned = false;
  return function cleanup() {
    if (cleaned) return;
    cleaned = true;
    for (const handle of dbs) {
      try {
        handle.close();
      } catch {
        // already closed or handle was torn down — best effort
      }
    }
    dbs.length = 0;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // temp dir removal is best effort
    }
  };
}

/**
 * @returns {{ tmpDir: string, dbPath: string, dbs: object[], cleanup: () => void }}
 */
function createTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boiler-snake-it-"));
  const dbPath = path.join(tmpDir, "test.sqlite");
  const dbs = [];
  const cleanup = createCleanup({ tmpDir, dbs });
  return { tmpDir, dbPath, dbs, cleanup };
}

/**
 * Point DB_PATH at a fresh temp SQLite file, clear src cache, load migrations.
 *
 * The returned `cleanup()` closes the src/db handle and removes tmpDir;
 * integration files should call it from their `after()` hook.
 *
 * @returns {{ api: object, tmpDir: string, dbPath: string, dbs: object[], cleanup: () => void }}
 */
function loadDb() {
  const { tmpDir, dbPath, dbs, cleanup } = createTempDbPath();
  process.env.DB_PATH = dbPath;
  // Tickets HTML transcripts resolve under DATA_DIR
  process.env.DATA_DIR = tmpDir;
  resetSrcModules();
  const api = require("../../src/db");
  // Track the raw better-sqlite3 handle src/db opened so cleanup() can close it
  if (api?.db) dbs.push(api.db);
  return { api, tmpDir, dbPath, dbs, cleanup };
}

module.exports = {
  resetSrcModules,
  createCleanup,
  createTempDbPath,
  loadDb,
};
