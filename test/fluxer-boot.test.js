/**
 * Unit tests for PR 6 boot configuration (roadmap/fluxer.md § Boot rules
 * 1-4 + § Environment; bundle Agent A).
 *
 * Covers src/config.js Fluxer surface: parseFluxerInstances validation
 * (malformed JSON, missing origin/token, duplicate instanceKey, illegal
 * URLs, http: policy), normalizeOriginForKey canonicalization,
 * getFluxerCommandPrefix (K1), and the assertRuntimeEnv gate.
 *
 * Deterministic: no network, no SQLite, no SDK. All values are clearly
 * fake placeholders (AGENTS.md: no real token shapes).
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const CONFIG_PATH = path.resolve(__dirname, "../src/config.js");

// Fresh instance with a clean require cache (config.js is stateless; mirrors
// the style of test/config.test.js).
function loadFreshConfig() {
  delete require.cache[require.resolve(CONFIG_PATH)];
  return require(CONFIG_PATH);
}

const RELEVANT_VARS = [
  "DISCORD_TOKEN",
  "FLUXER_INSTANCES",
  "FLUXER_COMMAND_PREFIX",
  "FLUXER_ALLOW_INSECURE",
];

const FAKE_TOKEN = "YOUR_FAKE_FLUXER_TOKEN"; // placeholder shape, never real

function setEnv(pairs) {
  for (const name of RELEVANT_VARS) delete process.env[name];
  for (const [name, value] of Object.entries(pairs)) {
    process.env[name] = value;
  }
}

describe("assertRuntimeEnv — Fluxer-aware boot gate (spec § Boot rules 1-3)", () => {
  let config;
  let saved;

  beforeEach(() => {
    saved = { ...process.env };
    config = loadFreshConfig();
  });

  afterEach(() => {
    for (const name of RELEVANT_VARS) delete process.env[name];
    Object.assign(process.env, saved);
  });

  // Rule 1: no Fluxer block + DISCORD_TOKEN → Discord-only, identical to today.
  it("rule 1: FLUXER_INSTANCES unset with DISCORD_TOKEN set → Discord-only boot", () => {
    setEnv({ DISCORD_TOKEN: "FAKE_TOKEN" });
    assert.doesNotThrow(() => config.assertRuntimeEnv());
  });

  it('rule 1: FLUXER_INSTANCES empty string with DISCORD_TOKEN set → Discord-only boot', () => {
    setEnv({ DISCORD_TOKEN: "FAKE_TOKEN", FLUXER_INSTANCES: "   " });
    assert.doesNotThrow(() => config.assertRuntimeEnv());
  });

  it("rule 1: FLUXER_INSTANCES=[] with DISCORD_TOKEN set → Discord-only boot", () => {
    setEnv({ DISCORD_TOKEN: "FAKE_TOKEN", FLUXER_INSTANCES: "[]" });
    assert.doesNotThrow(() => config.assertRuntimeEnv());
  });

  it("Discord + valid Fluxer block → passes with both endpoints configured", () => {
    setEnv({
      DISCORD_TOKEN: "FAKE_TOKEN",
      FLUXER_INSTANCES: `[{"origin":"https://fluxer.test","token":"${FAKE_TOKEN}"}]`,
    });
    assert.doesNotThrow(() => config.assertRuntimeEnv());
  });

  // Rule 2: a broken Fluxer block throws AT BOOT even when DISCORD_TOKEN is
  // set — never silently ignored.
  it("rule 2: malformed JSON throws even when DISCORD_TOKEN is set", () => {
    setEnv({ DISCORD_TOKEN: "FAKE_TOKEN", FLUXER_INSTANCES: "{not json" });
    assert.throws(
      () => config.assertRuntimeEnv(),
      { message: /FLUXER_INSTANCES is not valid JSON/ },
    );
  });

  it("rule 2: non-array JSON throws even when DISCORD_TOKEN is set", () => {
    setEnv({ DISCORD_TOKEN: "FAKE_TOKEN", FLUXER_INSTANCES: '{"origin":"https://a.test"}' });
    assert.throws(
      () => config.assertRuntimeEnv(),
      { message: /must be a JSON array/ },
    );
  });

  it("rule 2: missing origin throws even when DISCORD_TOKEN is set", () => {
    setEnv({ DISCORD_TOKEN: "FAKE_TOKEN", FLUXER_INSTANCES: `[{"token":"${FAKE_TOKEN}"}]` });
    assert.throws(
      () => config.assertRuntimeEnv(),
      { message: /missing a required "origin"/ },
    );
  });

  it("rule 2: missing token throws even when DISCORD_TOKEN is set", () => {
    setEnv({ DISCORD_TOKEN: "FAKE_TOKEN", FLUXER_INSTANCES: '[{"origin":"https://a.test"}]' });
    assert.throws(
      () => config.assertRuntimeEnv(),
      { message: /missing a required non-empty "token"/ },
    );
  });

  it("rule 2: empty token throws even when DISCORD_TOKEN is set", () => {
    setEnv({ DISCORD_TOKEN: "FAKE_TOKEN", FLUXER_INSTANCES: '[{"origin":"https://a.test","token":"  "}]' });
    assert.throws(
      () => config.assertRuntimeEnv(),
      { message: /missing a required non-empty "token"/ },
    );
  });

  it("rule 2: duplicate instanceKey throws even when DISCORD_TOKEN is set", () => {
    const a = JSON.stringify({ origin: "https://a.test", token: FAKE_TOKEN });
    const b = JSON.stringify({ origin: "https://a.test", token: "OTHER_FAKE_TOKEN" });
    setEnv({ DISCORD_TOKEN: "FAKE_TOKEN", FLUXER_INSTANCES: `[${a},${b}]` });
    assert.throws(
      () => config.assertRuntimeEnv(),
      { message: /duplicate instanceKey/ },
    );
  });

  it("rule 2: illegal origin scheme (file:) throws even when DISCORD_TOKEN is set", () => {
    setEnv({ DISCORD_TOKEN: "FAKE_TOKEN", FLUXER_INSTANCES: `[{"origin":"file:///etc/passwd","token":"${FAKE_TOKEN}"}]` });
    assert.throws(
      () => config.assertRuntimeEnv(),
      { message: /scheme "file:" is not allowed/ },
    );
  });

  it("rule 2: relative origin (no scheme) throws even when DISCORD_TOKEN is set", () => {
    setEnv({ DISCORD_TOKEN: "FAKE_TOKEN", FLUXER_INSTANCES: `[{"origin":"fluxer.app","token":"${FAKE_TOKEN}"}]` });
    assert.throws(
      () => config.assertRuntimeEnv(),
      { message: /has an invalid "origin" URL/ },
    );
  });

  // Rule 3: no Discord token and zero valid Fluxer instances.
  it("rule 3: FLUXER_INSTANCES=[] with no DISCORD_TOKEN → exact credential message", () => {
    setEnv({ FLUXER_INSTANCES: "[]" });
    assert.throws(
      () => config.assertRuntimeEnv(),
      { message: "Missing a platform credential: set DISCORD_TOKEN or FLUXER_INSTANCES" },
    );
  });

  // Legacy parity (pins test/config.test.js): with NO Fluxer block at all,
  // the exact pre-Fluxer message is preserved.
  it("no FLUXER_INSTANCES at all with no DISCORD_TOKEN → the platform-credential message", () => {
    // Spec § Boot rule 3: no DISCORD_TOKEN and zero valid Fluxer instances
    // (unset counts as zero) throws the platform-credential message.
    setEnv({});
    assert.throws(
      () => config.assertRuntimeEnv(),
      { message: "Missing a platform credential: set DISCORD_TOKEN or FLUXER_INSTANCES" },
    );
  });
});

describe("parseFluxerInstances — entry validation", () => {
  let config;
  let saved;

  beforeEach(() => {
    saved = { ...process.env };
    for (const name of RELEVANT_VARS) delete process.env[name];
    config = loadFreshConfig();
  });

  afterEach(() => {
    for (const name of RELEVANT_VARS) delete process.env[name];
    Object.assign(process.env, saved);
  });

  it("empty / whitespace / null input → []", () => {
    assert.deepEqual(config.parseFluxerInstances(""), []);
    assert.deepEqual(config.parseFluxerInstances("   "), []);
    assert.deepEqual(config.parseFluxerInstances(undefined), []);
    assert.deepEqual(config.parseFluxerInstances(null), []);
  });

  it("well-formed entry: defaults instanceKey + label to the normalized origin", () => {
    const entries = config.parseFluxerInstances(
      `[{"origin":"https://Example.COM:8443/API/","token":"${FAKE_TOKEN}"}]`,
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].origin, "https://example.com:8443/API");
    assert.equal(entries[0].instanceKey, "https://example.com:8443/API");
    assert.equal(entries[0].label, "https://example.com:8443/API");
    assert.equal(entries[0].token, FAKE_TOKEN);
    assert.equal(entries[0].clientId, null);
    assert.equal(entries[0].clientSecret, null);
  });

  it("explicit instanceKey, label, clientId, clientSecret are kept (trimmed)", () => {
    const entries = config.parseFluxerInstances(
      `[{"instanceKey":" primary ","origin":"https://a.test","token":"${FAKE_TOKEN}","label":"  Main  ","clientId":" cid ","clientSecret":" csec "}]`,
    );
    assert.equal(entries[0].instanceKey, "primary");
    assert.equal(entries[0].label, "Main");
    assert.equal(entries[0].clientId, "cid");
    assert.equal(entries[0].clientSecret, "csec");
  });

  it("duplicate explicit instanceKey throws naming the key", () => {
    assert.throws(
      () =>
        config.parseFluxerInstances(
          `[{"instanceKey":"dup","origin":"https://a.test","token":"${FAKE_TOKEN}"},` +
            `{"instanceKey":"dup","origin":"https://b.test","token":"${FAKE_TOKEN}"}]`,
        ),
      { message: /duplicate instanceKey "dup"/ },
    );
  });

  it("non-object entries throw with the array index", () => {
    assert.throws(
      () => config.parseFluxerInstances('["https://a.test"]'),
      { message: /FLUXER_INSTANCES\[0\] must be an object/ },
    );
  });

  it("http: origin is rejected for non-loopback hosts", () => {
    assert.throws(
      () =>
        config.parseFluxerInstances(
          `[{"origin":"http://example.com","token":"${FAKE_TOKEN}"}]`,
        ),
      { message: /uses plain http:; allowed only for loopback hosts or with FLUXER_ALLOW_INSECURE=1/ },
    );
  });

  it("http: loopback hosts are accepted without the flag", () => {
    for (const host of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      const entries = config.parseFluxerInstances(
        `[{"origin":"${host}","token":"${FAKE_TOKEN}"}]`,
      );
      assert.equal(entries.length, 1);
      assert.equal(entries[0].origin, host);
    }
  });

  it("FLUXER_ALLOW_INSECURE=1 accepts non-loopback http: origins", () => {
    process.env.FLUXER_ALLOW_INSECURE = "1";
    const entries = config.parseFluxerInstances(
      `[{"origin":"http://insecure.example","token":"${FAKE_TOKEN}"}]`,
    );
    assert.equal(entries[0].origin, "http://insecure.example");
  });

  it('FLUXER_ALLOW_INSECURE values other than "1" do not open the gate', () => {
    process.env.FLUXER_ALLOW_INSECURE = "true";
    assert.throws(
      () =>
        config.parseFluxerInstances(
          `[{"origin":"http://example.com","token":"${FAKE_TOKEN}"}]`,
        ),
      { message: /plain http:/ },
    );
  });
});

describe("normalizeOriginForKey — instanceKey canonicalization", () => {
  let config;

  beforeEach(() => {
    config = loadFreshConfig();
  });

  it("lowercases the host, keeps an explicit port, strips trailing slashes", () => {
    assert.equal(
      config.normalizeOriginForKey("https://Example.COM:8443/"),
      "https://example.com:8443",
    );
  });

  it("keeps a written path prefix (and its case), trimming trailing slashes", () => {
    assert.equal(
      config.normalizeOriginForKey("https://Example.COM/api/"),
      "https://example.com/api",
    );
  });

  it('the bare origin gains no path ("path kept only if the operator wrote one")', () => {
    assert.equal(config.normalizeOriginForKey("https://a.test"), "https://a.test");
  });

  it("rejects non-strings, empties, and non-URLs with specific messages", () => {
    assert.throws(() => config.normalizeOriginForKey(""), /non-empty string/);
    assert.throws(() => config.normalizeOriginForKey(null), /non-empty string/);
    assert.throws(() => config.normalizeOriginForKey(42), /non-empty string/);
    assert.throws(() => config.normalizeOriginForKey("not a url"), /not a valid absolute URL/);
  });
});

describe("getFluxerCommandPrefix — K1", () => {
  let config;

  beforeEach(() => {
    config = loadFreshConfig();
  });

  it('defaults to "!" when unset, empty, or whitespace-only', () => {
    assert.equal(config.getFluxerCommandPrefix({}), "!");
    assert.equal(config.getFluxerCommandPrefix({ FLUXER_COMMAND_PREFIX: "" }), "!");
    assert.equal(config.getFluxerCommandPrefix({ FLUXER_COMMAND_PREFIX: "   " }), "!");
  });

  it("trims an explicit value and accepts '/' as an explicit value", () => {
    assert.equal(config.getFluxerCommandPrefix({ FLUXER_COMMAND_PREFIX: " /fx " }), "/fx");
    assert.equal(config.getFluxerCommandPrefix({ FLUXER_COMMAND_PREFIX: "/" }), "/");
  });

  it('accepts up to 8 characters', () => {
    assert.equal(config.getFluxerCommandPrefix({ FLUXER_COMMAND_PREFIX: "12345678" }), "12345678");
  });

  it("rejects >8 chars, whitespace, '<' and '>' with specific messages", () => {
    assert.throws(
      () => config.getFluxerCommandPrefix({ FLUXER_COMMAND_PREFIX: "123456789" }),
      { message: /must be 1-8 characters/ },
    );
    assert.throws(
      () => config.getFluxerCommandPrefix({ FLUXER_COMMAND_PREFIX: "a b" }),
      { message: /must not contain whitespace/ },
    );
    assert.throws(
      () => config.getFluxerCommandPrefix({ FLUXER_COMMAND_PREFIX: "<x" }),
      { message: /must not contain '<' or '>'/ },
    );
    assert.throws(
      () => config.getFluxerCommandPrefix({ FLUXER_COMMAND_PREFIX: "x>" }),
      { message: /must not contain '<' or '>'/ },
    );
  });
});
