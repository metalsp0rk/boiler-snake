const { describe, it, after, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const Database = require("better-sqlite3");

const { loadDb, resetSrcModules, FAKE_TOKEN_ENCRYPTION_KEY } = require("./helpers/env");

/**
 * Migration 039_encrypt_third_party_tokens (audit-2026-10 C6, issue #189):
 * the third-party credential columns (guild_command_permission_oauth
 * refresh/access tokens, github_watches PAT) are AES-256-GCM envelope
 * encrypted at rest; this migration converts pre-existing plaintext rows
 * and FAILS LOUD instead of booting mixed-state columns.
 *
 * Unit half: migration.up() driven directly against a minimal post-034
 * in-memory schema (exact column names, ids only) so every fail-loud branch
 * is exercised without a full boot.
 * Integration half: the real chain — plaintext rows seeded into a booted
 * DB survive a close + reopen (boot → migrate → boot) and read back through
 * the repositories as their original plaintext.
 */


// #609: this file LOADS src/db-bound modules at require time (the first
// such require is `../src/db/migrations/039_encrypt_third_party_tokens` below) — connection.js opens AND migrates
// DB_PATH at LOAD time, so two concurrent node --test files sharing an
// ambient DB_PATH race mid-migration (the #470 G2-6 class). Bind a
// private temp DB HERE; later env flows (createIntegrationEnv /
// per-test loadDb) rebind to their own env exactly as before.
const { cleanup: cleanupTempDb } = require("./helpers/env").loadDb();
after(cleanupTempDb);
const migration = require("../src/db/migrations/039_encrypt_third_party_tokens");
const {
  KEY_ENV,
  ENVELOPE_PREFIX,
  ENVELOPE_V2_PREFIX,
  encryptToken,
  decryptToken,
  looksLikeEnvelope,
} = require("../src/core/thirdPartyTokens");

const KEY_A = FAKE_TOKEN_ENCRYPTION_KEY;
// Clearly-fake second key (base64 of 32 0x41 bytes) for the wrong-key test.
const KEY_B = Buffer.alloc(32, 0x41).toString("base64");

/** Minimal post-034 shape of the two target tables (ids + token columns). */
function createFixtureDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE guild_command_permission_oauth (
      community_id INTEGER PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      access_token TEXT,
      access_expires_at INTEGER,
      authorized_by_user_id TEXT,
      last_sync_at INTEGER,
      last_sync_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE github_watches (
      community_id INTEGER NOT NULL,
      repo TEXT NOT NULL,
      repo_display TEXT NOT NULL,
      channel_id TEXT,
      role_id TEXT,
      token TEXT,
      last_release_id INTEGER,
      last_release_published_at INTEGER,
      last_checked INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (community_id, repo)
    );
  `);
  return db;
}

const tableExists = (db) => (name) =>
  !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);

function runUp(db) {
  migration.up(db, { tableExists: tableExists(db) });
}

function seedOauth(db, communityId, refreshToken, accessToken) {
  db.prepare(
    `INSERT INTO guild_command_permission_oauth
       (community_id, refresh_token, access_token, created_at, updated_at)
     VALUES (?, ?, ?, 1, 1)`
  ).run(communityId, refreshToken, accessToken);
}

function seedWatch(db, communityId, repo, token) {
  db.prepare(
    `INSERT INTO github_watches
       (community_id, repo, repo_display, token, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1)`
  ).run(communityId, repo, repo, token);
}

function rawOauth(db, communityId) {
  return db
    .prepare(`SELECT refresh_token, access_token FROM guild_command_permission_oauth WHERE community_id=?`)
    .get(communityId);
}

function rawWatch(db, communityId, repo) {
  return db
    .prepare(`SELECT token FROM github_watches WHERE community_id=? AND repo=?`)
    .get(communityId, repo);
}

describe("migration 039_encrypt_third_party_tokens", () => {
  let prevKey;

  before(() => {
    prevKey = process.env[KEY_ENV] ?? null;
  });

  const withKey = (key, fn) => {
    if (key == null) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = key;
    try {
      return fn();
    } finally {
      if (prevKey === null) delete process.env[KEY_ENV];
      else process.env[KEY_ENV] = prevKey;
    }
  };

  describe("registration", () => {
    it("is registered in migrate.js after 038", () => {
      const { migrations } = require("../src/db/migrate");
      const ids = migrations.map((m) => m.id);
      const i038 = ids.indexOf("038_event_reminder_claim_state");
      const i039 = ids.indexOf("039_encrypt_third_party_tokens");
      assert.ok(i038 !== -1 && i039 !== -1, "038 and 039 must both be registered");
      assert.ok(i039 === i038 + 1, "039 runs last (after 038)");
    });
  });

  describe("unit: up() on a minimal post-034 schema", () => {
    it("no-ops without a key when there is no token material (empty tables)", () => {
      const db = createFixtureDb();
      withKey(null, () => assert.doesNotThrow(() => runUp(db)));
    });

    it("no-ops without a key when every token column is NULL/empty", () => {
      const db = createFixtureDb();
      db.exec(`DELETE FROM guild_command_permission_oauth`); // nothing token-bearing at all
      seedWatch(db, 2, "acme/widgets", null);
      seedWatch(db, 2, "acme/empty", "");
      withKey(null, () => assert.doesNotThrow(() => runUp(db)));
      assert.equal(rawWatch(db, 2, "acme/widgets").token, null, "NULL stays NULL");
      assert.equal(rawWatch(db, 2, "acme/empty").token, "", "'' stays ''");
    });

    it("a NULL access_token next to a real refresh_token counts as token material", () => {
      const db = createFixtureDb();
      seedOauth(db, 1, "rt-secret", null);
      withKey(null, () => assert.throws(() => runUp(db), /TOKEN_ENCRYPTION_KEY/));
      assert.equal(rawOauth(db, 1).refresh_token, "rt-secret", "untouched");
    });

    it("fails LOUD without a key when plaintext rows exist; touches nothing", () => {
      const db = createFixtureDb();
      seedOauth(db, 7, "rt-secret", "at-secret");
      seedWatch(db, 7, "acme/widgets", "ghp_fake_pat");
      const before = {
        oauth: rawOauth(db, 7),
        watch: rawWatch(db, 7, "acme/widgets"),
      };
      withKey(null, () => assert.throws(() => runUp(db), (err) => {
        assert.match(err.message, /TOKEN_ENCRYPTION_KEY/);
        assert.match(err.message, /guild_command_permission_oauth/);
        assert.match(err.message, /github_watches/);
        assert.match(err.message, /community_id=7/);
        // No secret material in the error text.
        assert.ok(!err.message.includes("rt-secret") && !err.message.includes("ghp_fake_pat"));
        return true;
      }));
      assert.deepEqual(rawOauth(db, 7), before.oauth, "rows stay byte-identical on failure");
      assert.deepEqual(rawWatch(db, 7, "acme/widgets"), before.watch);
    });

    it("encrypts plaintext rows; NULL/empty stay untouched; decrypts to the original", () => {
      const db = createFixtureDb();
      seedOauth(db, 7, "rt-secret", "at-secret");
      seedOauth(db, 8, "rt-noaccess", null);
      seedWatch(db, 7, "acme/widgets", "ghp_fake_pat");
      seedWatch(db, 7, "acme/public", null);
      withKey(KEY_A, () => {
        runUp(db);

        const oauth = rawOauth(db, 7);
        assert.ok(oauth.refresh_token.startsWith(ENVELOPE_V2_PREFIX), "refresh becomes an envelope");
        assert.ok(oauth.access_token.startsWith(ENVELOPE_V2_PREFIX), "access becomes an envelope");
        assert.notEqual(oauth.refresh_token, "rt-secret");
        assert.equal(decryptToken(oauth.refresh_token), "rt-secret");
        assert.equal(decryptToken(oauth.access_token), "at-secret");

        assert.equal(decryptToken(rawWatch(db, 7, "acme/widgets").token), "ghp_fake_pat");
        assert.equal(rawWatch(db, 7, "acme/public").token, null, "NULL stays NULL");
        assert.equal(rawOauth(db, 8).access_token, null, "NULL access stays NULL");
        assert.equal(decryptToken(rawOauth(db, 8).refresh_token), "rt-noaccess");
      });
    });

    it("second run is a byte-identical no-op (idempotent re-run)", () => {
      const db = createFixtureDb();
      seedOauth(db, 7, "rt-secret", "at-secret");
      seedWatch(db, 7, "acme/widgets", "ghp_fake_pat");
      withKey(KEY_A, () => {
        runUp(db);
        const first = {
          oauth: rawOauth(db, 7),
          watch: rawWatch(db, 7, "acme/widgets"),
        };
        runUp(db); // re-run over already-encrypted rows (incl. runtime-written envelopes)
        assert.deepEqual(rawOauth(db, 7), first.oauth, "already-encrypted rows are NOT re-wrapped");
        assert.deepEqual(rawWatch(db, 7, "acme/widgets"), first.watch);
      });
    });

    it("refuses envelope-shaped values that do not decrypt with the current key (foreign key)", () => {
      const db = createFixtureDb();
      const foreignEnvelope = withKey(KEY_B, () => encryptToken("rt-from-other-key"));
      seedOauth(db, 9, foreignEnvelope, null);
      withKey(KEY_A, () => assert.throws(() => runUp(db), (err) => {
        assert.match(err.message, /Migration 039 refused/);
        assert.match(err.message, /guild_command_permission_oauth\(community_id=9\)/);
        assert.match(err.message, /refresh_token/);
        assert.match(err.message, /TOKEN_ENCRYPTION_KEY/);
        return true;
      }));
      assert.equal(
        rawOauth(db, 9).refresh_token,
        foreignEnvelope,
        "a foreign envelope must survive untouched (never blindly re-wrapped)"
      );
    });

    it("refuses corrupt v1.-prefixed garbage, naming table + row id", () => {
      const db = createFixtureDb();
      seedWatch(db, 5, "acme/broken", "v1.###.!!!.$$$");
      withKey(KEY_A, () => assert.throws(() => runUp(db), (err) => {
        assert.match(err.message, /Migration 039 refused/);
        assert.match(err.message, /github_watches\(community_id=5, repo=acme\/broken\)/);
        assert.match(err.message, /\btoken\b/);
        return true;
      }));
    });

    it("commits all re-encryption in one transaction (partial failure leaves nothing half-migrated)", () => {
      // KEY_A-migrated row + a foreign-key row: validation happens BEFORE
      // any write, so the refused run must leave the plaintext row plaintext.
      const db = createFixtureDb();
      seedWatch(db, 1, "ok/repo", "pat-plain");
      const foreign = withKey(KEY_B, () => encryptToken("pat-foreign"));
      seedWatch(db, 2, "bad/repo", foreign);
      withKey(KEY_A, () => assert.throws(() => runUp(db), /Migration 039 refused/));
      assert.equal(rawWatch(db, 1, "ok/repo").token, "pat-plain");
      assert.equal(rawWatch(db, 2, "bad/repo").token, foreign);
    });

    it("tolerates missing tables (fresh/odd databases)", () => {
      const db = new Database(":memory:");
      withKey(null, () => assert.doesNotThrow(() => runUp(db)));
      db.close();
    });
  });

  describe("integration: boot → plaintext seed → boot (real chain re-runs 039 on reopen)", () => {
    let first;
    let reopened;
    let dbPath;
    const COMMUNITY = "1554590611015729152";

    before(async () => {
      first = loadDb();
      const { api, cleanup, dbs } = first;
      reopened = { cleanup, dbs }; // share cleanup/handle tracking
      dbPath = first.dbPath;

      const cid = require("./helpers/env").communityKey(COMMUNITY);

      // Plaintext rows written DIRECTLY (simulating pre-#189 storage):
      // repository writes are encrypted since #189, so raw SQL is the only
      // way to get plaintext into the columns.
      api.db
        .prepare(
          `INSERT INTO guild_command_permission_oauth
             (community_id, refresh_token, access_token, created_at, updated_at)
           VALUES (?, ?, ?, 1, 1)`
        )
        .run(cid, "legacy-refresh", "legacy-access");
      api.db
        .prepare(
          `INSERT INTO github_watches
             (community_id, repo, repo_display, token, created_at, updated_at)
           VALUES (?, 'acme/widgets', 'Acme/Widgets', ?, 1, 1)`
        )
        .run(cid, "legacy-pat");

      // Simulated deploy restart: close every tracked handle, then require
      // src/db fresh against the SAME file → migrations (incl. 039) run.
      // #202 guard: the pre-guard legacy DB this boot simulates carries no
      // recorded version, so zero it — the full replay (incl. 039) runs and
      // re-stamps; the THIRD boot below then rides the user_version fast-skip.
      api.db.pragma("user_version = 0");
      for (const handle of dbs) handle.close();
      dbs.length = 0;
      resetSrcModules();
      process.env.DB_PATH = dbPath;
      const api2 = require("../src/db");
      dbs.push(api2.db);
      reopened.api = api2;
      reopened.cid = cid;
    });

    after(() => reopened?.cleanup());

    it("re-encrypts the legacy rows at reopen (raw columns are envelopes)", () => {
      const { api: api2, cid } = reopened;
      const oauth = api2.db
        .prepare(`SELECT refresh_token, access_token FROM guild_command_permission_oauth WHERE community_id=?`)
        .get(cid);
      assert.ok(oauth.refresh_token.startsWith(ENVELOPE_V2_PREFIX));
      assert.ok(oauth.access_token.startsWith(ENVELOPE_V2_PREFIX));
      assert.notEqual(oauth.refresh_token, "legacy-refresh");

      const watch = api2.db
        .prepare(`SELECT token FROM github_watches WHERE community_id=? AND repo='acme/widgets'`)
        .get(cid);
      assert.ok(watch.token.startsWith(ENVELOPE_V2_PREFIX));
    });

    it("repositories read the re-encrypted rows back as the original plaintext", () => {
      const { api: api2, cid } = reopened;
      const row = api2.getCommandPermissionOauth(cid);
      assert.equal(row.refresh_token, "legacy-refresh");
      assert.equal(row.access_token, "legacy-access");
      const watch = api2.getAllGithubWatches().find((w) => w.repo === "acme/widgets");
      assert.equal(watch.token, "legacy-pat");
    });

    it("a THIRD boot changes nothing (migration re-run is a no-op over live envelopes)", () => {
      const { api: api2, cid, dbs } = reopened;
      const before = api2.db
        .prepare(`SELECT refresh_token, access_token FROM guild_command_permission_oauth WHERE community_id=?`)
        .get(cid);
      for (const handle of dbs) handle.close();
      dbs.length = 0;
      resetSrcModules();
      process.env.DB_PATH = dbPath;
      const api3 = require("../src/db");
      dbs.push(api3.db);
      const after = api3.db
        .prepare(`SELECT refresh_token, access_token FROM guild_command_permission_oauth WHERE community_id=?`)
        .get(cid);
      assert.deepEqual(after, before, "already-encrypted rows stay byte-identical across boots");
      assert.equal(api3.getCommandPermissionOauth(cid).refresh_token, "legacy-refresh");
    });
  });
});

// ===========================================================================
// #281 — rotation era: RETIRED keys pass the boot gate; fail-loud stands
// ===========================================================================

describe("migration 039 with retired keys (#281)", () => {
  const crypto = require("crypto");
  const KEY_NEW = Buffer.alloc(32, 0x31).toString("base64");
  const KEY_RETIRED_NAME = "TOKEN_ENCRYPTION_KEY_RETIRED";

  function handV1(keyB64, plaintext) {
    const key = Buffer.from(keyB64, "base64");
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
  }

  function withEnv(overlay, fn) {
    const prev = {};
    for (const [k, v] of Object.entries(overlay)) {
      prev[k] = process.env[k];
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("a row sealed with a key now living in RETIRED passes the gate, untouched", () => {
    const db = createFixtureDb();
    const sealed = handV1(KEY_B, "legacy-pat");
    seedWatch(db, 91, "acme/retired", sealed);
    withEnv({ [KEY_ENV]: KEY_NEW, [KEY_RETIRED_NAME]: `junk-not-a-key,${KEY_B}` }, () => {
      assert.doesNotThrow(() => runUp(db), "retired-key rows must not kill boot");
    });
    const after = db
      .prepare("SELECT token FROM github_watches WHERE community_id=91")
      .get().token;
    assert.equal(after, sealed, "039 leaves decryptable-migrated rows byte-identical (lazy read converges later)");
    db.close();
  });

  it("still refuses rows sealed by a key that is NEITHER current NOR retired", () => {
    const db = createFixtureDb();
    seedWatch(db, 92, "acme/stranded", handV1(KEY_B, "legacy-pat"));
    withEnv({ [KEY_ENV]: KEY_NEW, [KEY_RETIRED_NAME]: null }, () => {
      assert.throws(() => runUp(db), (err) => /Migration 039 refused/.test(err.message) && /TOKEN_ENCRYPTION_KEY_RETIRED/.test(err.message));
    });
    db.close();
  });
});
