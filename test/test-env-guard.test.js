/**
 * #699 pins — the test-env guard (test/helpers/test-env-guard.js).
 *
 * Why it exists: src/db/connection.js resolves DB_PATH and opens SQLite at
 * REQUIRE time. A test file that requires src/** (or a view/feature module
 * that transitively pulls src/db) at describe-body/file-load time — before
 * loadDb() rebinds the env — silently opens the repo-DEFAULT database: the
 * parallel per-file --test children collide on creating the same
 * repo-root xpbot.sqlite (+WAL sidecars) — the Node 24 CI leg surfaced that
 * race as SQLITE_CANTOPEN in web-sessions.test.js #653 — and every local run
 * that hits it touches the developer's REAL database, migrations included.
 * The guard (wired into every npm test script via --require, and pulled in
 * by helpers/env for plain `node --test <file>` runs) binds DB_PATH/DATA_DIR
 * to a per-process throwaway temp dir when the shell left both unset.
 *
 * These pins run REAL child node processes (spawnSync) so the env binding
 * and the require-time connection file are checked exactly as shipped.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const REPO_ROOT = path.join(__dirname, "..");
// Relative-with-dot form (exactly what the npm scripts pass); path.join would
// drop the "./" and turn it into a bare module specifier.
const GUARD_ARG = "./test/helpers/test-env-guard.js";

/** Run node in a child at REPO_ROOT with a controlled env. */
function runNode({ args, env }) {
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
  });
}

/** Child env with the DB bindings stripped — models a plain shell `npm test`. */
function cleanDbEnv(extra = {}) {
  const env = { ...process.env };
  delete env.DB_PATH;
  delete env.DATA_DIR;
  // Stripped FIRST, extras applied LAST (the pre-bound pin passes them in).
  return { ...env, ...extra };
}

/** Last stdout line as JSON (src/db logs run before the probe prints). */
function lastJson(stdout) {
  const line = stdout.trim().split("\n").filter(Boolean).pop();
  return JSON.parse(line);
}

describe("test-env guard (#699): a test process never binds the repo-default DB", () => {
  const tmpRoot = fs.realpathSync(os.tmpdir());

  it("clean env: guard binds DB_PATH/DATA_DIR under the OS temp dir and the require-time DB file follows", () => {
    const probe = [
      `const db = require(${JSON.stringify(path.join(REPO_ROOT, "src", "db"))});`,
      `const file = db.db.prepare("PRAGMA database_list").all().find((d) => d.name === "main")?.file;`,
      `console.log(JSON.stringify({ dbPath: process.env.DB_PATH, dataDir: process.env.DATA_DIR, bound: file }));`,
    ].join(" ");
    const r = runNode({
      args: ["-r", GUARD_ARG, "-e", probe],
      env: cleanDbEnv(),
    });
    assert.equal(r.status, 0, `child failed: ${r.stderr}`);
    const out = lastJson(r.stdout);

    assert.ok(out.dbPath && out.dataDir, "guard set both DB_PATH and DATA_DIR");
    assert.ok(
      // Textual check: the child exited and the guard's exit hook already
      // removed the dir — mkdtemp(os.tmpdir()) output needs no realpath.
      out.dataDir.startsWith(os.tmpdir() + path.sep),
      `DATA_DIR must live under the OS temp dir, got ${out.dataDir}`,
    );
    assert.equal(out.dbPath, path.join(out.dataDir, "ephemeral.sqlite"));
    assert.ok(
      !path.resolve(out.bound).startsWith(fs.realpathSync(REPO_ROOT) + path.sep),
      `require-time DB must NOT be inside the repo (got ${out.bound}) — this is the SQLITE_CANTOPEN race + dev-DB-touched failure of #699`,
    );
    assert.equal(path.resolve(out.bound), path.resolve(out.dbPath), "connection.js bound exactly the guard's ephemeral DB");
  });

  it("guard cleans its temp dir up when the process exits", () => {
    const r = runNode({
      args: ["-r", GUARD_ARG, "-e", "console.log(process.env.DATA_DIR)"],
      env: cleanDbEnv(),
    });
    assert.equal(r.status, 0, r.stderr);
    const dir = r.stdout.trim().split("\n").pop();
    assert.ok(dir.startsWith(tmpRoot) || dir.startsWith(os.tmpdir()), `unexpected dir ${dir}`);
    assert.ok(!fs.existsSync(dir), "guard dir removed on child exit (exit hook)");
  });

  it("pre-bound env is honored untouched (suites/e2e keep full control)", () => {
    const custom = fs.mkdtempSync(path.join(tmpRoot, "bs-guard-pin-"));
    try {
      const r = runNode({
        args: [
          "-r",
          GUARD_ARG,
          "-e",
          `console.log(JSON.stringify({ dbPath: process.env.DB_PATH, dataDir: process.env.DATA_DIR }))`,
        ],
        env: cleanDbEnv({ DB_PATH: path.join(custom, "kept.sqlite"), DATA_DIR: custom }),
      });
      assert.equal(r.status, 0, r.stderr);
      const out = lastJson(r.stdout);
      assert.equal(out.dbPath, path.join(custom, "kept.sqlite"));
      assert.equal(out.dataDir, custom);
    } finally {
      fs.rmSync(custom, { recursive: true, force: true });
    }
  });

  it("helpers/env wires the guard, so plain `node --test <file>` runs are protected too", () => {
    const envPath = path.join(REPO_ROOT, "test", "helpers", "env.js");
    const probe = 'require(' + JSON.stringify(envPath) + '); console.log(process.env.DB_PATH || "")';
    const r = runNode({
      args: ["-e", probe],
      env: cleanDbEnv(),
    });
    assert.equal(r.status, 0, r.stderr);
    const dbPath = r.stdout.trim().split("\n").pop();
    assert.ok(dbPath, "requiring helpers/env bound DB_PATH");
    assert.ok(
      path.dirname(dbPath).startsWith(os.tmpdir() + path.sep),
      `helpers/env must bind a temp-dir DB first, got ${dbPath}`,
    );
  });
});

/**
 * #857/#832 pins — deployment-context knobs (public base URL, web surface,
 * EventSub wiring) must be NEUTRAL in test processes even when the shell has
 * them (developer .env auto-loaded into every session by a dotenv plugin made
 * the tickets.test.js "no base URL" cases false-red locally while CI stayed
 * green). Unlike DB_PATH, shell presence is NOT honored for this list; the
 * escape hatch is TEST_ENV_GUARD_PINS_PASSTHROUGH.
 */
describe("test-env guard (#857/#832): deployment-context env is stripped", () => {
  const PINNED = [
    "PUBLIC_BASE_URL",
    "TICKET_PUBLIC_BASE_URL",
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
    "TWITCH_CLIENT_ID",
    "TWITCH_CLIENT_SECRET",
    "TWITCH_EVENTSUB_SECRET",
    "TWITCH_EVENTSUB_CALLBACK_URL",
    "TWITCH_EVENTSUB_MAX_CHANNELS",
  ];

  const PROBE = `console.log(JSON.stringify(
    ${JSON.stringify(PINNED)}.filter((k) => process.env[k] !== undefined)
  ))`;

  function probeGuard(extraEnv = {}) {
    const env = cleanDbEnv({
      ...Object.fromEntries(PINNED.map((k) => [k, "http://leaked.example"])),
      ...extraEnv,
    });
    const r = runNode({ args: ["-r", GUARD_ARG, "-e", PROBE], env });
    assert.equal(r.status, 0, `child failed: ${r.stderr}`);
    return lastJson(r.stdout);
  }

  it("strips every pinned knob that the shell (or a .env plugin) leaked in", () => {
    assert.deepEqual(probeGuard(), [], "all pinned knobs must be gone after the guard");
  });

  it("TEST_ENV_GUARD_PINS_PASSTHROUGH re-admits named knobs (or all with *)", () => {
    assert.deepEqual(probeGuard({ TEST_ENV_GUARD_PINS_PASSTHROUGH: "PUBLIC_BASE_URL" }), [
      "PUBLIC_BASE_URL",
    ]);
    assert.deepEqual(
      probeGuard({ TEST_ENV_GUARD_PINS_PASSTHROUGH: "PUBLIC_BASE_URL,TWITCH_EVENTSUB_SECRET" }),
      ["PUBLIC_BASE_URL", "TWITCH_EVENTSUB_SECRET"],
    );
    assert.deepEqual(probeGuard({ TEST_ENV_GUARD_PINS_PASSTHROUGH: "*" }), PINNED);
  });

  it("the pinned list covers the knobs the integration suites branch on", () => {
    // tickets.test.js resolves the transcript URL from PUBLIC_BASE_URL ||
    // TICKET_PUBLIC_BASE_URL — losing either name to drift re-opens #857.
    assert.ok(PINNED.includes("PUBLIC_BASE_URL"));
    assert.ok(PINNED.includes("TICKET_PUBLIC_BASE_URL"));
    // The guard file and this pin must not drift apart.
    const guardSrc = fs.readFileSync(
      path.join(REPO_ROOT, "test", "helpers", "test-env-guard.js"),
      "utf8",
    );
    const declared = [...guardSrc.matchAll(/^\s{2}"([A-Z0-9_]+)",$/gm)].map((m) => m[1]);
    assert.deepEqual(
      declared.sort(),
      [...PINNED].sort(),
      "test-env-guard.js PINNED_NEUTRAL_ENV and this pin drifted",
    );
  });
});
