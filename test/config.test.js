/**
 * Unit tests for src/config.js (T10: env parsing/validation gating boot).
 *
 * Objective: pin the shipped contract of the config module exhaustively —
 * required-var enforcement, falsy-vs-unset handling, lack of trimming,
 * lazy (call-time) env reads, and zero side effects at require time.
 *
 * Ground-truth notes (pinned, not prescribed):
 * - `requireEnv` reads `process.env[name]` at CALL time (not snapshot at
 *   require time) and uses a `!v` check: unset AND empty string both throw;
 *   any non-empty string (including "0" and "   ") passes, UNTRIMMED.
 * - `assertRuntimeEnv()` enforces the platform-credential gate (Fluxer PR 6,
 *   spec § Boot): no `DISCORD_TOKEN` and zero valid Fluxer instances →
 *   `Missing a platform credential: set DISCORD_TOKEN or FLUXER_INSTANCES`;
 *   a malformed Fluxer block throws even when `DISCORD_TOKEN` is set.
 *   CLIENT_ID is NOT part of this gate — the audit (#205) proved the old
 *   "required" doc claim false; the CLIENT_ID consequence moved to the
 *   separate `checkConfigSanity`/`assertConfigSanity` pair (WARN, never
 *   fatal), which src/index.js runs right after this gate.
 * - `checkConfigSanity(env)` is PURE (no console, no throw): it returns
 *   `{ warnings, errors }` for the three #205 rules plus the #282 DECAY_CRON
 *   fail-fast; `assertConfigSanity`
 *   logs warnings as `[config] WARN ...` and throws on any error.
 * - Optional vars (DEV_GUILD_ID, DATA_DIR, DB_PATH, CLIENT_SECRET, ...) are
 *   only DOCUMENTED in this module; defaults and the DB_PATH-wins-over-
 *   DATA_DIR precedence (AGENTS.md) live in src/db/connection.js (covered by
 *   test/db-layer.test.js). This module must not touch SQLite or Discord.
 *
 * Deterministic: no network, no SQLite, no timers. All values are clearly
 * fake placeholders per AGENTS.md (no real-looking secrets).
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const CONFIG_PATH = path.resolve(__dirname, "../src/config.js");

// Env vars the module documents (required + optional + sanity-rule inputs) —
// cleared in tests so a developer's real .env (via dotenv elsewhere) can
// never leak into a case.
const KNOWN_VARS = [
  "DISCORD_TOKEN",
  "CLIENT_ID",
  "CLIENT_SECRET",
  "DEV_GUILD_ID",
  "DATA_DIR",
  "DB_PATH",
  "YOUTUBE_API_KEY",
  "LAVALINK_HOST",
  "LAVALINK_PASSWORD",
  "OAUTH_STATE_SECRET",
  "DECAY_CRON",
];

// Clearly fake values only.
const FAKE = {
  DISCORD_TOKEN: "FAKE_TOKEN",
  CLIENT_ID: "123456789012345678", // fake snowflake-shaped app id
  DEV_GUILD_ID: "9990001112223334",
  DATA_DIR: "/tmp/fake-data-dir",
  DB_PATH: "/tmp/fake-data-dir/xpbot.sqlite",
  CLIENT_SECRET: "FAKE_CLIENT_SECRET",
  YOUTUBE_API_KEY: "YOUR_YOUTUBE_API_KEY",
  LAVALINK_HOST: "lavalink.invalid",
  LAVALINK_PASSWORD: "FAKE_LAVALINK_PASSWORD",
  OAUTH_STATE_SECRET: "FAKE_OAUTH_STATE_SECRET",
};

/** Fresh module instance with a clean require cache (config.js is stateless;
 *  this pins that a plain re-require works and mirrors the cache-reset style
 *  used by other unit files, without ever touching SQLite or Discord). */
function loadFreshConfig() {
  delete require.cache[require.resolve(CONFIG_PATH)];
  return require(CONFIG_PATH);
}

function clearKnownEnv() {
  for (const name of KNOWN_VARS) delete process.env[name];
}

describe("src/config.js module contract", () => {
  let saved;

  beforeEach(() => {
    saved = { ...process.env };
    clearKnownEnv();
  });

  afterEach(() => {
    clearKnownEnv();
    Object.assign(process.env, saved);
  });

  // Positive: requiring the module with NOTHING set must succeed — boot
  // gating happens at the assertRuntimeEnv() CALL (src/index.js), not at
  // import time, and the module performs no I/O (no SQLite, no Discord).
  it("exports the env-gate + Fluxer parsing surface and loads with zero env", () => {
    const config = loadFreshConfig();
    assert.deepEqual(Object.keys(config).sort(), [
      "DEFAULT_DECAY_CRON",
      "assertConfigSanity",
      "assertRuntimeEnv",
      "checkConfigSanity",
      "getDecayCron",
      "getFluxerCommandPrefix",
      "isValidCronExpression",
      "normalizeOriginForKey",
      "parseFluxerInstances",
      "requireEnv",
    ]);
    // Optional-var defaults/precedence are NOT this module's job: it exposes
    // no config object, so nothing here parses DATA_DIR/DB_PATH.
    assert.equal(typeof config.requireEnv, "function");
    assert.equal(typeof config.assertRuntimeEnv, "function");
    assert.equal(typeof config.checkConfigSanity, "function");
    assert.equal(typeof config.assertConfigSanity, "function");
    assert.equal(typeof config.getDecayCron, "function");
    assert.equal(typeof config.isValidCronExpression, "function");
  });

  // Positive: pins the lazy-read behavior — env set AFTER require is still
  // seen (module never snapshots process.env at require time).
  it("reads process.env at call time, not at require time", () => {
    const config = loadFreshConfig(); // no env set yet
    assert.throws(() => config.assertRuntimeEnv(), /Missing a platform credential: set DISCORD_TOKEN or FLUXER_INSTANCES/);
    process.env.DISCORD_TOKEN = FAKE.DISCORD_TOKEN;
    assert.doesNotThrow(() => config.assertRuntimeEnv()); // same instance now passes
  });

  // Negative: with required vars absent, the module still loads but the
  // gate rejects boot.
  it("assertRuntimeEnv rejects boot when required env was absent at require time", () => {
    const config = loadFreshConfig();
    assert.throws(
      () => config.assertRuntimeEnv(),
      { message: "Missing a platform credential: set DISCORD_TOKEN or FLUXER_INSTANCES" }
    );
  });
});

describe("requireEnv — required vars (DISCORD_TOKEN, CLIENT_ID)", () => {
  let config;
  let saved;

  beforeEach(() => {
    saved = { ...process.env };
    clearKnownEnv();
    config = loadFreshConfig();
  });

  afterEach(() => {
    clearKnownEnv();
    Object.assign(process.env, saved);
  });

  for (const name of ["DISCORD_TOKEN", "CLIENT_ID"]) {
    // Positive: present → value returned verbatim (parsed = passed through).
    it(`returns the value when ${name} is set`, () => {
      process.env[name] = FAKE[name];
      assert.equal(config.requireEnv(name), FAKE[name]);
    });

    // Negative: unset → throws with the exact shipped message.
    it(`throws the exact message when ${name} is unset`, () => {
      assert.throws(
        () => config.requireEnv(name),
        { message: `Missing required environment variable: ${name}` }
      );
    });

    // Negative: empty string is falsy → treated as missing (pins `!v` check;
    // empty string and unset are indistinguishable outcomes).
    it(`throws when ${name} is set to empty string`, () => {
      process.env[name] = "";
      assert.throws(
        () => config.requireEnv(name),
        { message: `Missing required environment variable: ${name}` }
      );
    });
  }

  // Edge cases (pin reality: NO trimming or normalization anywhere):
  // whitespace-only is truthy → passes and comes back UNTRIMMED.
  it("passes whitespace-only values through untrimmed (no normalization)", () => {
    process.env.DISCORD_TOKEN = "   ";
    assert.equal(config.requireEnv("DISCORD_TOKEN"), "   ");
  });

  // Edge case: "0" is a truthy STRING in JS → accepted, returned as "0".
  it('accepts the string "0" (only truly-empty/unset is rejected)', () => {
    process.env.CLIENT_ID = "0";
    assert.equal(config.requireEnv("CLIENT_ID"), "0");
  });

  // Edge case: value containing spaces is preserved verbatim (no trim/split).
  it("preserves values with inner and outer characters verbatim", () => {
    process.env.DISCORD_TOKEN = " FAKE_TOKEN ";
    assert.equal(config.requireEnv("DISCORD_TOKEN"), " FAKE_TOKEN ");
  });
});

describe("requireEnv — optional vars (generic name contract)", () => {
  let config;
  let saved;

  beforeEach(() => {
    saved = { ...process.env };
    clearKnownEnv();
    config = loadFreshConfig();
  });

  afterEach(() => {
    clearKnownEnv();
    Object.assign(process.env, saved);
  });

  // These vars are "optional" only because no code path in THIS module calls
  // requireEnv on them (defaults/precedence live in src/db/connection.js and
  // src/commands/register.js — see test/db-layer.test.js). requireEnv itself
  // is name-agnostic: if any caller requires one, present → verbatim passthrough.
  for (const name of ["DEV_GUILD_ID", "DATA_DIR", "DB_PATH", "CLIENT_SECRET", "YOUTUBE_API_KEY"]) {
    // Positive: present → parsed (returned exactly as provided, including
    // full-path vs dir distinction for DB_PATH vs DATA_DIR).
    it(`returns ${name} verbatim when set`, () => {
      process.env[name] = FAKE[name];
      assert.equal(config.requireEnv(name), FAKE[name]);
    });

    // Negative: unset → throws when a caller requires it (no implicit default
    // is invented by this module — an unset optional stays simply missing).
    it(`throws for unset ${name} when a caller requires it (no default invented here)`, () => {
      assert.throws(
        () => config.requireEnv(name),
        { message: `Missing required environment variable: ${name}` }
      );
    });
  }

  // Edge: empty-string DATA_DIR/DB_PATH would also throw if required —
  // pinning that falsy-empty never silently resolves to a default in config.js.
  it("treats empty-string optional vars as missing (never a silent default)", () => {
    process.env.DB_PATH = "";
    assert.throws(
      () => config.requireEnv("DB_PATH"),
      { message: "Missing required environment variable: DB_PATH" }
    );
  });
});

describe("assertRuntimeEnv — boot gate", () => {
  let config;
  let saved;

  beforeEach(() => {
    saved = { ...process.env };
    clearKnownEnv();
    config = loadFreshConfig();
  });

  afterEach(() => {
    clearKnownEnv();
    Object.assign(process.env, saved);
  });

  // Positive: valid token → gate passes and returns undefined (void gate).
  it("passes with a valid DISCORD_TOKEN and returns undefined", () => {
    process.env.DISCORD_TOKEN = FAKE.DISCORD_TOKEN;
    assert.equal(config.assertRuntimeEnv(), undefined);
  });

  // Negative: unset token → exact throw message (what boot operator sees).
  it("throws with the token name when DISCORD_TOKEN is missing", () => {
    assert.throws(
      () => config.assertRuntimeEnv(),
      { message: "Missing a platform credential: set DISCORD_TOKEN or FLUXER_INSTANCES" }
    );
  });

  // Negative: empty token (e.g. `DISCORD_TOKEN=` in .env) → same throw.
  it("throws when DISCORD_TOKEN is an empty string", () => {
    process.env.DISCORD_TOKEN = "";
    assert.throws(
      () => config.assertRuntimeEnv(),
      { message: "Missing a platform credential: set DISCORD_TOKEN or FLUXER_INSTANCES" }
    );
  });

  // Pins shipped reality: the platform gate checks ONLY DISCORD_TOKEN (or a
  // valid Fluxer block). CLIENT_ID is NOT a boot requirement — the #205 audit
  // proved the old "required" header claim false. Its missing-var consequence
  // is a WARN from checkConfigSanity (covered below), and the registration
  // CLI rejects at runtime in src/commands/register.js.
  it("does NOT check CLIENT_ID or any optional var (pins current behavior)", () => {
    process.env.DISCORD_TOKEN = FAKE.DISCORD_TOKEN;
    // CLIENT_ID, DEV_GUILD_ID, DATA_DIR, DB_PATH, CLIENT_SECRET, YOUTUBE_API_KEY
    // all unset:
    assert.doesNotThrow(() => config.assertRuntimeEnv());
  });

  // Edge: whitespace-only token passes the gate (truthy, untrimmed) — pinning
  // that no validation beyond non-empty exists.
  it("accepts a whitespace-only token (only emptiness is validated)", () => {
    process.env.DISCORD_TOKEN = " ";
    assert.doesNotThrow(() => config.assertRuntimeEnv());
  });
});

// ---------------------------------------------------------------------------
// checkConfigSanity / assertConfigSanity (issue #205 — boot config sanity)
// ---------------------------------------------------------------------------

/** A fully-sane Discord deploy: no rule may fire. */
const SANE_ENV = Object.freeze({
  DISCORD_TOKEN: FAKE.DISCORD_TOKEN,
  CLIENT_ID: FAKE.CLIENT_ID,
  CLIENT_SECRET: FAKE.CLIENT_SECRET,
  OAUTH_STATE_SECRET: FAKE.OAUTH_STATE_SECRET,
});

/** Copy of SANE_ENV with the listed vars deleted. */
function envWithout(...names) {
  const env = { ...SANE_ENV };
  for (const name of names) delete env[name];
  return env;
}

describe("checkConfigSanity — pure rules (issue #205)", () => {
  // checkConfigSanity is PURE: injected env in, strings out. process.env is
  // never consulted here, so these cases are immune to the ambient shell env.
  const { checkConfigSanity } = loadFreshConfig();

  it("fires no rule for a fully-configured deploy", () => {
    assert.deepEqual(checkConfigSanity(SANE_ENV), { warnings: [], errors: [] });
  });

  // Rule 1 — WARN (issue #205: warn, NOT fatal; base login genuinely works
  // without CLIENT_ID, Fluxer-first deploys legitimately have none).
  it("warns when DISCORD_TOKEN is set without CLIENT_ID (names the consequence)", () => {
    const { warnings, errors } = checkConfigSanity(envWithout("CLIENT_ID", "OAUTH_STATE_SECRET", "CLIENT_SECRET"));
    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 1);
    const [warning] = warnings;
    assert.ok(warning.includes("CLIENT_ID"), warning);
    assert.ok(warning.includes("npm run register"), warning);
    assert.ok(warning.includes("syncpermissions"), warning);
  });

  it("treats a whitespace-only CLIENT_ID as missing", () => {
    const { warnings } = checkConfigSanity({ ...SANE_ENV, CLIENT_ID: "   " });
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("CLIENT_ID"));
  });

  it("does NOT warn when DISCORD_TOKEN is unset/whitespace (Fluxer-only deploys)", () => {
    assert.deepEqual(checkConfigSanity({ CLIENT_SECRET: FAKE.CLIENT_SECRET, OAUTH_STATE_SECRET: FAKE.OAUTH_STATE_SECRET }), {
      warnings: [],
      errors: [],
    });
    assert.deepEqual(checkConfigSanity({ ...envWithout("CLIENT_ID"), DISCORD_TOKEN: "  " }), {
      warnings: [],
      errors: [],
    });
  });

  // Rule 2 — FAIL-FAST: a Lavalink host with no password is a half-config
  // (every play would fail authorization at connect; silent ≠ harmless).
  it("fails fast when LAVALINK_HOST is set without LAVALINK_PASSWORD (names both + the fix)", () => {
    const { warnings, errors } = checkConfigSanity({ ...SANE_ENV, LAVALINK_HOST: FAKE.LAVALINK_HOST });
    assert.deepEqual(warnings, []);
    assert.equal(errors.length, 1);
    const [error] = errors;
    assert.ok(error.includes("LAVALINK_HOST"), error);
    assert.ok(error.includes("LAVALINK_PASSWORD"), error);
    assert.ok(error.includes("application.yml"), error);
  });

  it("LAVALINK_PASSWORD empty-string or whitespace counts as missing; password present silences the rule", () => {
    assert.equal(checkConfigSanity({ ...SANE_ENV, LAVALINK_HOST: "127.0.0.1", LAVALINK_PASSWORD: "" }).errors.length, 1);
    assert.equal(checkConfigSanity({ ...SANE_ENV, LAVALINK_HOST: "127.0.0.1", LAVALINK_PASSWORD: "  " }).errors.length, 1);
    assert.deepEqual(
      checkConfigSanity({ ...SANE_ENV, LAVALINK_HOST: "127.0.0.1", LAVALINK_PASSWORD: FAKE.LAVALINK_PASSWORD }),
      { warnings: [], errors: [] },
    );
  });

  it("LAVALINK_PASSWORD without a host is nobody's business (no host, no music, no error)", () => {
    assert.deepEqual(checkConfigSanity({ ...SANE_ENV, LAVALINK_PASSWORD: FAKE.LAVALINK_PASSWORD }), {
      warnings: [],
      errors: [],
    });
  });

  // Rule 3 — dedicated OAUTH_STATE_SECRET guidance: the code has supported
  // the dedicated var all along; the DEPRECATION-STYLE WARN fires exactly
  // when the shared-CLIENT_SECRET fallback is live.
  it("warns when the OAuth state secret silently falls back to CLIENT_SECRET", () => {
    const { warnings, errors } = checkConfigSanity(envWithout("OAUTH_STATE_SECRET"));
    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 1);
    const [warning] = warnings;
    assert.ok(warning.includes("OAUTH_STATE_SECRET"), warning);
    assert.ok(warning.includes("CLIENT_SECRET"), warning);
    assert.ok(warning.includes("openssl rand"), warning);
  });

  it("no OAUTH_STATE_SECRET warning when the dedicated secret is set or no fallback source exists", () => {
    assert.deepEqual(checkConfigSanity(SANE_ENV), { warnings: [], errors: [] });
    // Neither var set: nothing falls back to anything (Fluxer-only + no web
    // secret) — the OAuth flows already reply with their own specific cause.
    assert.deepEqual(checkConfigSanity(envWithout("CLIENT_SECRET", "OAUTH_STATE_SECRET")), {
      warnings: [],
      errors: [],
    });
    // Dedicated secret alone, no CLIENT_SECRET: valid, silent.
    assert.deepEqual(checkConfigSanity(envWithout("CLIENT_SECRET")), { warnings: [], errors: [] });
  });

  // Rule 4 — DECAY_CRON knob (issue #282): FAIL FAST on a malformed
  // expression. The scheduler grammar and this check share node-cron, so a
  // value that passes here can never die at registration time.
  it("fails fast when DECAY_CRON is set to a malformed expression (names the bad value)", () => {
    const { warnings, errors } = checkConfigSanity({ ...SANE_ENV, DECAY_CRON: "not a cron" });
    assert.deepEqual(warnings, []);
    assert.equal(errors.length, 1);
    const [error] = errors;
    assert.ok(error.includes("DECAY_CRON"), error);
    assert.ok(error.includes('"not a cron"'), error);
    assert.ok(error.includes("0 4 * * *"), error); // names the default it replaces
  });

  it("valid or defaulted DECAY_CRON is silent; whitespace-only counts as unset", () => {
    for (const expr of ["0 4 * * *", "30 3 * * *", "0 2 * * 1", "*/15 * * * *"]) {
      assert.deepEqual(
        checkConfigSanity({ ...SANE_ENV, DECAY_CRON: expr }),
        { warnings: [], errors: [] },
        `${expr} must validate`,
      );
    }
    assert.deepEqual(checkConfigSanity({ ...SANE_ENV, DECAY_CRON: "   " }), {
      warnings: [],
      errors: [],
    });
  });

  it("accumulates multiple findings in one pass", () => {
    const { warnings, errors } = checkConfigSanity({
      DISCORD_TOKEN: FAKE.DISCORD_TOKEN,
      CLIENT_SECRET: FAKE.CLIENT_SECRET,
      LAVALINK_HOST: FAKE.LAVALINK_HOST,
    });
    assert.equal(warnings.length, 2, JSON.stringify(warnings)); // CLIENT_ID + OAUTH_STATE_SECRET
    assert.equal(errors.length, 1, JSON.stringify(errors)); // LAVALINK
  });

  it("is pure: never touches console, never throws", () => {
    const orig = { log: console.log, warn: console.warn, error: console.error };
    const calls = [];
    console.log = (...a) => calls.push(["log", a.join(" ")]);
    console.warn = (...a) => calls.push(["warn", a.join(" ")]);
    console.error = (...a) => calls.push(["error", a.join(" ")]);
    try {
      assert.doesNotThrow(() =>
        checkConfigSanity({
          DISCORD_TOKEN: FAKE.DISCORD_TOKEN,
          CLIENT_SECRET: FAKE.CLIENT_SECRET,
          LAVALINK_HOST: FAKE.LAVALINK_HOST,
        }),
      );
    } finally {
      Object.assign(console, orig);
    }
    assert.deepEqual(calls, []);
  });
});

describe("assertConfigSanity — boot wiring (issue #205)", () => {
  let saved;

  beforeEach(() => {
    saved = { ...process.env };
    clearKnownEnv();
  });

  afterEach(() => {
    clearKnownEnv();
    Object.assign(process.env, saved);
  });

  function captureLogs(fn) {
    const orig = { log: console.log, warn: console.warn, error: console.error };
    const warnings = [];
    console.log = () => {};
    console.warn = (...a) => warnings.push(a.join(" "));
    console.error = () => {};
    let thrown = null;
    try {
      fn();
    } catch (err) {
      thrown = err;
    } finally {
      Object.assign(console, orig);
    }
    return { warnings, thrown };
  }

  it("clean config: no logs, no throw", () => {
    const { warnings, thrown } = captureLogs(() =>
      loadFreshConfig().assertConfigSanity(SANE_ENV),
    );
    assert.equal(thrown, null);
    assert.deepEqual(warnings, []);
  });

  it("warning-only config logs [config] WARN per warning and still boots", () => {
    const { warnings, thrown } = captureLogs(() =>
      loadFreshConfig().assertConfigSanity(envWithout("CLIENT_ID", "OAUTH_STATE_SECRET", "CLIENT_SECRET")),
    );
    assert.equal(thrown, null, "a WARN must never be fatal (issue #205)");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].startsWith("[config] WARN "), warnings[0]);
    assert.ok(warnings[0].includes("CLIENT_ID"), warnings[0]);
  });

  it("LAVALINK_HOST without LAVALINK_PASSWORD throws with the [config]-prefixed cause", () => {
    const { warnings, thrown } = captureLogs(() =>
      loadFreshConfig().assertConfigSanity({ ...SANE_ENV, LAVALINK_HOST: FAKE.LAVALINK_HOST }),
    );
    assert.ok(thrown instanceof Error, "expected a fail-fast throw");
    assert.ok(thrown.message.includes("[config]"), thrown.message);
    assert.ok(thrown.message.includes("LAVALINK_HOST"), thrown.message);
    assert.ok(thrown.message.includes("LAVALINK_PASSWORD"), thrown.message);
    assert.deepEqual(warnings, []);
  });

  it("warns are logged BEFORE the fail-fast throw (operator sees the full picture in one boot log)", () => {
    const { warnings, thrown } = captureLogs(() =>
      loadFreshConfig().assertConfigSanity({ DISCORD_TOKEN: FAKE.DISCORD_TOKEN, LAVALINK_HOST: FAKE.LAVALINK_HOST }),
    );
    assert.equal(warnings.length, 1, JSON.stringify(warnings)); // CLIENT_ID warning
    assert.ok(thrown?.message.includes("LAVALINK_PASSWORD"), String(thrown));
  });

  it("defaults to process.env (the wiring src/index.js relies on)", () => {
    process.env.DISCORD_TOKEN = FAKE.DISCORD_TOKEN; // CLIENT_ID stays cleared
    const { warnings, thrown } = captureLogs(() => loadFreshConfig().assertConfigSanity());
    assert.equal(thrown, null);
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.ok(warnings[0].includes("CLIENT_ID"), warnings[0]);
  });
});

describe("getDecayCron — decay schedule knob (issue #282)", () => {
  const { getDecayCron, DEFAULT_DECAY_CRON } = loadFreshConfig();

  it("unset or whitespace-only DECAY_CRON → the historical 0 4 * * * default", () => {
    assert.equal(DEFAULT_DECAY_CRON, "0 4 * * *");
    assert.equal(getDecayCron({}), DEFAULT_DECAY_CRON);
    assert.equal(getDecayCron({ DECAY_CRON: "   " }), DEFAULT_DECAY_CRON);
  });

  it("a valid expression is used, trimmed", () => {
    assert.equal(getDecayCron({ DECAY_CRON: " 0 2 * * 1 " }), "0 2 * * 1");
    assert.equal(getDecayCron({ DECAY_CRON: "*/30 5-9 * * 2-6" }), "*/30 5-9 * * 2-6");
  });

  it("a malformed expression throws naming the bad value (defense behind the boot gate)", () => {
    assert.throws(
      () => getDecayCron({ DECAY_CRON: "0 4 * *" }),
      (err) =>
        /DECAY_CRON/.test(err.message) &&
        /"0 4 \* \*"/.test(err.message) &&
        /0 4 \* \* \*/.test(err.message),
    );
  });

  it("assertConfigSanity wires the rule into boot: malformed DECAY_CRON is fatal, named", () => {
    const saved = { ...process.env };
    clearKnownEnv();
    try {
      process.env.DISCORD_TOKEN = FAKE.DISCORD_TOKEN;
      process.env.CLIENT_ID = FAKE.CLIENT_ID;
      process.env.DECAY_CRON = "daily at four";
      assert.throws(
        () => loadFreshConfig().assertConfigSanity(),
        (err) =>
          /\[config\]/.test(err.message) &&
          err.message.includes('"daily at four"'),
      );
    } finally {
      clearKnownEnv();
      Object.assign(process.env, saved);
    }
  });
});
