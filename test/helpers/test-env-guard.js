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
 * DB_PATH/DATA_DIR keep the "pre-bound env is always left alone" rule —
 * suites that set them explicitly (or e2e harnesses) keep full control.
 *
 * #857/#832 — the same isolation class, wider blast radius: DEPLOYMENT-CONTEXT
 * knobs (public base URL, web-console surface, Twitch EventSub wiring) must be
 * NEUTRAL in test processes unless a test sets them in-process. They used to
 * reach tests two ways: (a) a developer `.env` + any dotenv load in a spawned
 * child, (b) shell auto-loaders (e.g. the oh-my-zsh dotenv plugin) exporting
 * `.env` into EVERY session — so `PUBLIC_BASE_URL=http://localhost:8080` made
 * tickets.test.js "no base URL" cases false-red locally while CI stayed green.
 * Shell presence is therefore NOT a trustworthy "explicit pre-bound" signal
 * for this list, unlike DB_PATH (no plugin sets a database path by accident).
 * The guard strips the list unconditionally; every in-repo harness sets these
 * knobs in-process AFTER the guard runs (e2eEnv.js, web-test harnesses), so
 * nothing legitimate loses control. A harness that truly must pre-bind from
 * the shell opts in explicitly via TEST_ENV_GUARD_PINS_PASSTHROUGH (comma-
 * separated names, or `*` for all) — deliberate, greppable, plugin-proof.
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

/**
 * #857/#832 — deployment-context env stripped from every test process.
 * Tests that need any of these set them in-process (web harnesses,
 * e2eEnv.js, withBaseUrl) — never from the ambient shell.
 */
const PINNED_NEUTRAL_ENV = [
  // public links / transcript URLs
  "PUBLIC_BASE_URL",
  "TICKET_PUBLIC_BASE_URL",
  // web-console public surface (src/web/config.js + port knobs)
  "PUBLIC_HTTP_PORT",
  "TICKET_HTTP_PORT",
  "WEB_LOGIN_REDIRECT_URI",
  "WEB_LOGIN_PROMPT",
  "WEB_SESSION_TTL_HOURS",
  "WEB_TIER_CACHE_TTL_MS",
  "WEB_RATE_LIMIT_WINDOW_MS",
  "WEB_RATE_LIMIT_AUTH_MAX",
  "WEB_RATE_LIMIT_AUTH_USER_MAX",
  "WEB_RATE_LIMIT_MUTATION_MAX",
  "WEB_MAX_BODY_BYTES",
  "WEB_TRUST_PROXY",
  // Twitch EventSub trio + client creds (config.js derives callback from
  // PUBLIC_BASE_URL, so the trio goes neutral together)
  "TWITCH_CLIENT_ID",
  "TWITCH_CLIENT_SECRET",
  "TWITCH_EVENTSUB_SECRET",
  "TWITCH_EVENTSUB_CALLBACK_URL",
  "TWITCH_EVENTSUB_MAX_CHANNELS",
];

const pinPassthrough = new Set(
  String(process.env.TEST_ENV_GUARD_PINS_PASSTHROUGH || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
);

for (const name of PINNED_NEUTRAL_ENV) {
  if (pinPassthrough.has("*") || pinPassthrough.has(name)) continue;
  delete process.env[name];
}
