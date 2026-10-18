/**
 * #455 (audit H2-7): Lavalink auth must NEVER default to the public
 * `youshallnotpass`.
 *
 * The documented compose path previously carried `:-youshallnotpass` in BOTH
 * services and lavalink.js kept `|| "youshallnotpass"` as last resort — so
 * the #205 boot fail-fast ("LAVALINK_HOST without LAVALINK_PASSWORD") was
 * UNREACHABLE under compose: the bot always saw a password, and the node ran
 * on the credential its own docs publish. Pins:
 *  - getLavalinkConfig(): empty authorization when unset (an honest 401 is
 *    better than a silent public-default success), exact value when set;
 *  - docker-compose.yml / application.yml / lavalink.js carry no
 *    youshallnotpass default anywhere; compose now REQUIRES the variable.
 */
const { describe, it, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { cleanup } = loadDb();
const { getLavalinkConfig } = require("../src/features/music/lavalink");

after(cleanup);

describe("lavalink auth has no public default (#455)", () => {
  const saved = {};
  beforeEach(() => {
    for (const k of ["LAVALINK_HOST", "LAVALINK_PORT", "LAVALINK_PASSWORD"]) {
      saved[k] = process.env[k];
    }
  });
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  after(restore);

  it("authorization is EMPTY (never youshallnotpass) when the password is unset", () => {
    process.env.LAVALINK_HOST = "lavalink";
    delete process.env.LAVALINK_PASSWORD;
    try {
      const cfg = getLavalinkConfig();
      assert.equal(cfg.authorization, "", "an unset password stays unset");
      assert.notEqual(cfg.authorization, "youshallnotpass");
    } finally {
      restore();
    }
  });

  it("a set password is passed through verbatim", () => {
    process.env.LAVALINK_HOST = "lavalink";
    process.env.LAVALINK_PASSWORD = "s3cret-node-pass";
    try {
      assert.equal(getLavalinkConfig().authorization, "s3cret-node-pass");
    } finally {
      restore();
    }
  });

  it("docker-compose.yml requires LAVALINK_PASSWORD and never defaults it (#455)", () => {
    const wf = fs.readFileSync(
      path.join(__dirname, "../docker-compose.yml"),
      "utf8",
    );
    assert.ok(
      !wf.includes("youshallnotpass"),
      "the public default may not return in compose",
    );
    // Both consumers must use compose's REQUIRED expansion (? : abort on
    // unset/empty with the message) — a bare ${VAR} would pass empty.
    const required = wf.match(/\$\{LAVALINK_PASSWORD:\?/g) || [];
    assert.equal(required.length, 2, "bot + lavalink service both gate on :?");
  });

  it("lavalink application.yml dropped its Spring `:youshallnotpass` fallback", () => {
    const yml = fs.readFileSync(
      path.join(__dirname, "../deploy/lavalink/application.yml"),
      "utf8",
    );
    assert.ok(
      !yml.includes("youshallnotpass"),
      "standalone lavalink must fail on the missing placeholder",
    );
    assert.match(yml, /password:\s*"\$\{LAVALINK_SERVER_PASSWORD\}"/);
  });

  it("lavalink.js source carries no youshallnotpass default", () => {
    const js = fs.readFileSync(
      path.join(__dirname, "../src/features/music/lavalink.js"),
      "utf8",
    );
    assert.ok(!js.includes("youshallnotpass"));
  });
});
