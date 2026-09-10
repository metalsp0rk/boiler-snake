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
 * - `assertRuntimeEnv()` enforces ONLY DISCORD_TOKEN. The doc header lists
 *   CLIENT_ID as "required", but the shipped code does not check it here —
 *   CLIENT_ID is consumed directly by src/commands/register.js.
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

// Env vars the module documents (required + optional) — cleared in tests so
// a developer's real .env (via dotenv elsewhere) can never leak into a case.
const KNOWN_VARS = [
  "DISCORD_TOKEN",
  "CLIENT_ID",
  "DEV_GUILD_ID",
  "DATA_DIR",
  "DB_PATH",
  "CLIENT_SECRET",
  "YOUTUBE_API_KEY",
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
  it("exports exactly { requireEnv, assertRuntimeEnv } and loads with zero env", () => {
    const config = loadFreshConfig();
    assert.deepEqual(Object.keys(config).sort(), ["assertRuntimeEnv", "requireEnv"]);
    // Optional-var defaults/precedence are NOT this module's job: it exposes
    // no config object, so nothing here parses DATA_DIR/DB_PATH.
    assert.equal(typeof config.requireEnv, "function");
    assert.equal(typeof config.assertRuntimeEnv, "function");
  });

  // Positive: pins the lazy-read behavior — env set AFTER require is still
  // seen (module never snapshots process.env at require time).
  it("reads process.env at call time, not at require time", () => {
    const config = loadFreshConfig(); // no env set yet
    assert.throws(() => config.assertRuntimeEnv(), /Missing required environment variable: DISCORD_TOKEN/);
    process.env.DISCORD_TOKEN = FAKE.DISCORD_TOKEN;
    assert.doesNotThrow(() => config.assertRuntimeEnv()); // same instance now passes
  });

  // Negative: with required vars absent, the module still loads but the
  // gate rejects boot.
  it("assertRuntimeEnv rejects boot when required env was absent at require time", () => {
    const config = loadFreshConfig();
    assert.throws(
      () => config.assertRuntimeEnv(),
      { message: "Missing required environment variable: DISCORD_TOKEN" }
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
      { message: "Missing required environment variable: DISCORD_TOKEN" }
    );
  });

  // Negative: empty token (e.g. `DISCORD_TOKEN=` in .env) → same throw.
  it("throws when DISCORD_TOKEN is an empty string", () => {
    process.env.DISCORD_TOKEN = "";
    assert.throws(
      () => config.assertRuntimeEnv(),
      { message: "Missing required environment variable: DISCORD_TOKEN" }
    );
  });

  // Pins shipped reality: the header doc lists CLIENT_ID as required, but
  // assertRuntimeEnv checks ONLY DISCORD_TOKEN. Optional vars are likewise
  // not required for login. (CLIENT_ID is enforced at registration time in
  // src/commands/register.js, not here.)
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
