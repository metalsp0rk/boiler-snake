/**
 * #699 — a test process must NEVER open the repo-default database.
 *
 * src/db/connection.js opens SQLite AT REQUIRE TIME (DB_PATH, else
 * DATA_DIR/xpbot.sqlite, else the project root). Several test files require
 * src/ — or view/feature modules that transitively pull src/db — at
 * describe-body / file-load time, BEFORE any loadDb() rebinds the env in a
 * before() hook (web-sessions.test.js #653 is the pinned example). Under
 * `node --test`'s per-file process isolation that means N parallel test
 * children create-and-open the SAME repo-root xpbot.sqlite + WAL sidecars
 * concurrently: on CI (Node 24.x leg) the collision surfaced as
 * SQLITE_CANTOPEN inside that direct-render require, and every local run
 * that reaches it silently touches the developer's REAL database —
 * migrations included. Observed, not theoretical.
 *
 * The guard binds DB_PATH/DATA_DIR to a per-process throwaway temp dir when
 * the invoking shell left both unset, so a load-time require opens an empty
 * ephemeral DB under the OS temp dir (removed at process exit). loadDb()
 * rebinds to the tracked per-section DB and clears the src cache exactly as
 * before; nothing else changes.
 *
 * Wiring:
 *  - every runner script passes `--require ./test/helpers/test-env-guard.js`
 *    (node propagates the flag to each per-file test child);
 *  - helpers/env.js also requires it, so plain `node --test path/to.file`
 *    runs from an editor or ad-hoc shell get the same protection.
 *
 * Pre-bound env is always left alone — suites that set DB_PATH/DATA_DIR
 * explicitly (or e2e harnesses) keep full control.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

if (!process.env.DB_PATH && !process.env.DATA_DIR) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `boiler-snake-testguard-${process.pid}-`),
  );
  process.env.DATA_DIR = dir;
  process.env.DB_PATH = path.join(dir, "ephemeral.sqlite");
  process.once("exit", () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort — the OS temp dir is cleaned by the OS
    }
  });
}
