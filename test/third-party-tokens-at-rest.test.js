const { describe, it, after, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const {
  loadDb,
  communityKey,
  FAKE_TOKEN_ENCRYPTION_KEY,
} = require("./helpers/env");

// CONTRACT (same as test/github-releases.test.js): loadDb() must stay above
// every `src/` require — it points this process at a private temp DB (fresh
// DB_PATH + src require-cache reset, plus the clearly-fake default
// TOKEN_ENCRYPTION_KEY) before those requires load.
const { cleanup, api } = loadDb();
after(cleanup);

const {
  KEY_ENV,
  ENVELOPE_PREFIX,
  ENVELOPE_V2_PREFIX,
  hasTokenKey,
  encryptToken,
  decryptToken,
  looksLikeEnvelope,
  keyMissingError,
} = require("../src/core/thirdPartyTokens");
const coreCrypto = require("../src/core/tokenCrypto");
const oauthTokens = require("../src/features/commandPermissions/oauthTokens");

/**
 * Audit-2026-10 C6 (issue #189): the third-party credential columns
 * (`guild_command_permission_oauth.refresh_token`/`.access_token`,
 * `github_watches.token`) must hold ONLY AES-256-GCM envelopes at rest.
 * These tests drive the REAL repositories over a real SQLite file and read
 * the RAW column bytes past the repository (better-sqlite3 directly) to pin
 * "ciphertext at rest" — not merely "the getter looks decrypted".
 */

const CID = communityKey("1554590611015729152");

const envKeyBefore = process.env[KEY_ENV];
afterEach(() => {
  if (envKeyBefore === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = envKeyBefore;
});

/** Raw (unencrypted-at-rest verification) reads straight through the handle. */
const rawOauth = (communityId) =>
  api.db
    .prepare(
      `SELECT refresh_token, access_token FROM guild_command_permission_oauth WHERE community_id=?`
    )
    .get(communityId);
const rawWatchToken = (communityId, repo) =>
  api.db
    .prepare(`SELECT token FROM github_watches WHERE community_id=? AND repo=?`)
    .get(communityId, repo).token;

describe("core envelope (src/core/tokenCrypto)", () => {
  it("round-trips and cross-checks the bridge + third-party bindings share one envelope", () => {
    const bridge = require("../src/features/bridge/tokenCrypto");
    const env = encryptToken("shared-envelope-token", {
      keyGetter: () => FAKE_TOKEN_ENCRYPTION_KEY,
    });
    assert.ok(looksLikeEnvelope(env));
    // The bridge codec reads the SAME bytes with the same key material…
    assert.equal(
      bridge.decryptWebhookToken(env, { keyGetter: () => FAKE_TOKEN_ENCRYPTION_KEY }),
      "shared-envelope-token"
    );
    assert.equal(coreCrypto.ENVELOPE_VERSION, "v1");
    assert.equal(ENVELOPE_PREFIX, "v1.");
  });

  it("rejects missing, non-string, wrong-length, and non-canonical base64 keys", () => {
    for (const bad of [undefined, null, "", "   ", 42, "not-base64-!!", Buffer.alloc(16).toString("base64")]) {
      assert.equal(
        encryptToken("x", { keyGetter: () => bad }),
        null,
        `key ${String(bad)} must not encrypt`
      );
    }
    assert.equal(hasTokenKey({ keyGetter: () => FAKE_TOKEN_ENCRYPTION_KEY }), true);
  });

  it("looksLikeEnvelope is strict about shape (version, parts, iv/tag lengths)", () => {
    const real = encryptToken("abc", { keyGetter: () => FAKE_TOKEN_ENCRYPTION_KEY });
    assert.equal(looksLikeEnvelope(real), true);
    assert.equal(looksLikeEnvelope("v1.aaa.bbb.ccc"), false); // non-canonical junk
    assert.equal(looksLikeEnvelope("v1.a.b.c.d"), false); // wrong part count
    assert.equal(looksLikeEnvelope("ghp_realgithuutoken"), false);
    assert.equal(looksLikeEnvelope(""), false);
    assert.equal(looksLikeEnvelope(null), false);
    assert.equal(looksLikeEnvelope(42), false);
  });

  it("decrypt failures are static and never leak the plaintext or envelope", () => {
    const env = encryptToken("topsecret", { keyGetter: () => FAKE_TOKEN_ENCRYPTION_KEY });
    const other = Buffer.alloc(32, 7).toString("base64");
    assert.throws(
      () => decryptToken(env, { keyGetter: () => other }),
      (err) => {
        assert.equal(err.code, "third_party_token_envelope_invalid");
        assert.ok(!err.message.includes("topsecret"));
        assert.ok(!err.message.includes(env));
        return true;
      }
    );
    assert.throws(
      () => decryptToken(env, { keyGetter: () => undefined }),
      { code: "third_party_token_key_missing" }
    );
  });

  it("keyMissingError names the env var and never genericizes (AGENTS.md 3)", () => {
    const err = keyMissingError("the GitHub token");
    assert.match(err.message, /TOKEN_ENCRYPTION_KEY/);
    assert.match(err.message, /openssl rand -base64 32/);
    assert.match(err.message, /never stored\s+in plaintext/i);
    assert.equal(err.code, "third_party_token_key_missing");
  });
});

describe("github_watches repository: ciphertext at rest", () => {
  it("addGithubWatch stores the PAT as an envelope; the row never holds plaintext", () => {
    const row = api.addGithubWatch(CID, "acme/secret", "Acme/Secret", {
      token: "ghp_faketoken_1234567890",
    });
    assert.equal(row.has_token, 1);
    assert.equal(row.token, undefined, "user-facing getter must not carry the column");

    const raw = rawWatchToken(CID, "acme/secret");
    assert.ok(raw.startsWith(ENVELOPE_V2_PREFIX), `raw column must be an envelope, got ${raw.slice(0, 12)}…`);
    assert.notEqual(raw, "ghp_faketoken_1234567890");
    assert.ok(!raw.includes("ghp_faketoken"));
    assert.equal(decryptToken(raw), "ghp_faketoken_1234567890");

    api.removeGithubWatch(CID, "acme/secret");
  });

  it("getAllGithubWatches hands the ticker decrypted plaintext (round-trip)", () => {
    api.addGithubWatch(CID, "acme/roundtrip", "Acme/Roundtrip", { token: "pat-round-trip" });
    const watch = api.getAllGithubWatches().find((w) => w.repo === "acme/roundtrip");
    assert.equal(watch.token, "pat-round-trip");
    api.removeGithubWatch(CID, "acme/roundtrip");
  });

  it("same PAT stored twice yields DIFFERENT ciphertext but equal plaintext (GCM nonce; #193 CAS compares decrypted values)", () => {
    api.addGithubWatch(CID, "acme/nonce", "Acme/Nonce", { token: "pat-same" });
    const first = rawWatchToken(CID, "acme/nonce");
    api.updateGithubWatch(CID, "acme/nonce", { token: "pat-same" });
    const second = rawWatchToken(CID, "acme/nonce");
    assert.notEqual(first, second, "AES-GCM must not be deterministic");
    assert.equal(decryptToken(first), decryptToken(second));
    api.removeGithubWatch(CID, "acme/nonce");
  });

  it("updateGithubWatch token semantics survive encryption (undefined keeps, null clears, string replaces)", () => {
    api.addGithubWatch(CID, "acme/semantics", "Acme/Semantics", { token: "pat-one" });
    const envelope = rawWatchToken(CID, "acme/semantics");
    const kept = api.updateGithubWatch(CID, "acme/semantics", { channelId: null });
    assert.equal(rawWatchToken(CID, "acme/semantics"), envelope, "undefined token keeps the envelope");
    assert.equal(kept.has_token, 1);

    const cleared = api.updateGithubWatch(CID, "acme/semantics", { token: null });
    assert.equal(rawWatchToken(CID, "acme/semantics"), null);
    assert.equal(cleared.has_token, 0);

    api.updateGithubWatch(CID, "acme/semantics", { token: "pat-two" });
    assert.equal(decryptToken(rawWatchToken(CID, "acme/semantics")), "pat-two");

    // Re-add without a token must COALESCE-preserve the stored envelope.
    api.addGithubWatch(CID, "acme/semantics", "Acme/Semantics");
    assert.equal(decryptToken(rawWatchToken(CID, "acme/semantics")), "pat-two");
    api.removeGithubWatch(CID, "acme/semantics");
  });

  it("rows whose envelope cannot be decrypted are skipped LOUDLY (per-row tolerance), healthy rows still flow", () => {
    api.addGithubWatch(CID, "acme/healthy", "Acme/Healthy", { token: "pat-healthy" });
    api.db
      .prepare(
        `INSERT INTO github_watches (community_id, repo, repo_display, token, created_at, updated_at)
         VALUES (?, 'acme/broken', 'Acme/Broken', 'v1.###.!!!.$$$', 1, 1)`
      )
      .run(CID);

    const errors = [];
    const spy = mock.method(console, "error", (...args) => errors.push(args.join(" ")));
    try {
      const watches = api.getAllGithubWatches();
      const repos = watches.filter((w) => w.community_id === CID).map((w) => w.repo);
      assert.ok(repos.includes("acme/healthy"), "healthy row still delivered");
      assert.ok(!repos.includes("acme/broken"), "undecryptable row dropped");
    } finally {
      spy.mock.restore();
    }
    assert.equal(errors.length, 1);
    assert.match(errors[0], /\[github\] Skipping watch acme\/broken \(community \d+\)/);
    assert.match(errors[0], /could not be decrypted/);

    api.removeGithubWatch(CID, "acme/healthy");
    api.db.prepare(`DELETE FROM github_watches WHERE community_id=? AND repo='acme/broken'`).run(CID);
  });

  it("writes with a MISSING key fail loudly and store nothing (no plaintext ever lands)", () => {
    delete process.env[KEY_ENV];
    assert.equal(hasTokenKey(), false);

    assert.throws(
      () => api.addGithubWatch(CID, "acme/nokey", "Acme/NoKey", { token: "ghp_nope" }),
      (err) => {
        assert.equal(err.code, "third_party_token_key_missing");
        assert.match(err.message, /TOKEN_ENCRYPTION_KEY/);
        return true;
      }
    );
    assert.equal(
      api.getGithubWatch(CID, "acme/nokey"),
      null,
      "no partial row may exist after the failed write"
    );

    // Existing row + key vanishes: an update must not clear or plaintext-store.
    process.env[KEY_ENV] = FAKE_TOKEN_ENCRYPTION_KEY;
    api.addGithubWatch(CID, "acme/keep", "Acme/Keep", { token: "pat-keep" });
    const rawBefore = rawWatchToken(CID, "acme/keep");
    delete process.env[KEY_ENV];
    assert.throws(
      () => api.updateGithubWatch(CID, "acme/keep", { token: "pat-new" }),
      { code: "third_party_token_key_missing" }
    );
    assert.equal(rawWatchToken(CID, "acme/keep"), rawBefore, "envelope untouched by failed write");
    // A token-less watch still works without the key.
    api.addGithubWatch(CID, "acme/public", "Acme/Public");
    assert.equal(rawWatchToken(CID, "acme/public"), null);

    process.env[KEY_ENV] = FAKE_TOKEN_ENCRYPTION_KEY;
    api.removeGithubWatch(CID, "acme/keep");
    api.removeGithubWatch(CID, "acme/public");
  });
});

describe("guild_command_permission_oauth repository: ciphertext at rest", () => {
  const CID2 = communityKey("1600000000000000001");

  it("upsert encrypts both token columns; get returns decrypted plaintext (row shape unchanged)", () => {
    api.upsertCommandPermissionOauth(CID, {
      refreshToken: "rt-at-rest",
      accessToken: "at-at-rest",
      accessExpiresAt: 123,
    });
    const raw = rawOauth(CID);
    assert.ok(raw.refresh_token.startsWith(ENVELOPE_V2_PREFIX));
    assert.ok(raw.access_token.startsWith(ENVELOPE_V2_PREFIX));
    assert.notEqual(raw.refresh_token, "rt-at-rest");
    assert.notEqual(raw.access_token, "at-at-rest");
    assert.ok(!JSON.stringify(raw).includes("rt-at-rest"));

    const row = api.getCommandPermissionOauth(CID);
    assert.equal(row.refresh_token, "rt-at-rest");
    assert.equal(row.access_token, "at-at-rest");
    assert.equal(row.access_expires_at, 123); // non-token columns pass through
  });

  it("access-token rotation stores envelopes and the unrotated refresh column stays byte-identical", () => {
    const before = rawOauth(CID);
    api.updateCommandPermissionAccessToken(CID, "at-refreshed", 456);
    const after = rawOauth(CID);
    assert.equal(after.refresh_token, before.refresh_token, "no rotation → column untouched");
    assert.notEqual(after.access_token, before.access_token);
    assert.equal(decryptToken(after.access_token), "at-refreshed");

    api.updateCommandPermissionAccessToken(CID, "at-rot", 789, "rt-rotated");
    const row = api.getCommandPermissionOauth(CID);
    assert.equal(row.refresh_token, "rt-rotated");
    assert.equal(row.access_token, "at-rot");
    assert.ok(rawOauth(CID).refresh_token.startsWith(ENVELOPE_V2_PREFIX));
  });

  it("re-writing the SAME refresh token yields different ciphertext but equal plaintext — the #193 raced-400 check compares decrypted values", () => {
    const plaintextRefresh = api.getCommandPermissionOauth(CID).refresh_token;
    const rawBefore = rawOauth(CID).refresh_token;
    api.upsertCommandPermissionOauth(CID, {
      refreshToken: plaintextRefresh, // winner re-auth with an unrotated refresh token
      accessToken: "at-new",
      accessExpiresAt: 999,
    });
    const rawAfter = rawOauth(CID).refresh_token;
    assert.notEqual(rawAfter, rawBefore, "the fresh envelope differs (GCM nonce) — byte-equality is NOT expected");
    assert.equal(
      api.getCommandPermissionOauth(CID).refresh_token,
      plaintextRefresh,
      "decrypted values stay equal ⇒ oauthTokens CAS (`current.refresh_token !== refreshTokenUsed`, both plaintext) sees no false winner"
    );
  });

  it("reads fail loudly with the key gone (never plaintext passthrough, never raw envelope)", () => {
    delete process.env[KEY_ENV];
    assert.throws(
      () => api.getCommandPermissionOauth(CID),
      (err) => {
        assert.equal(err.code, "third_party_token_key_missing");
        assert.match(err.message, /community \d+ could not be decrypted/);
        assert.match(err.message, /TOKEN_ENCRYPTION_KEY/);
        return true;
      }
    );
    process.env[KEY_ENV] = FAKE_TOKEN_ENCRYPTION_KEY;
    // A tampered ciphertext (right key, corrupted bytes) is equally loud and
    // names the row so logs alone reproduce it.
    api.db
      .prepare(`UPDATE guild_command_permission_oauth SET refresh_token=? WHERE community_id=?`)
      .run(ENVELOPE_PREFIX + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", CID);
    assert.throws(
      () => api.getCommandPermissionOauth(CID),
      (err) => {
        assert.equal(err.code, "third_party_token_envelope_invalid");
        assert.match(err.message, /command-permission OAuth refresh_token for community \d+ could not be decrypted/);
        return true;
      }
    );
  });

  it("writes with a MISSING key fail loudly; the stored row is untouched", () => {
    api.upsertCommandPermissionOauth(CID2, { refreshToken: "rt-original" });
    const rawBefore = rawOauth(CID2);
    delete process.env[KEY_ENV];
    assert.throws(
      () =>
        api.upsertCommandPermissionOauth(CID2, {
          refreshToken: "rt-attacker-plaintext",
          accessToken: "at-attacker",
        }),
      { code: "third_party_token_key_missing" }
    );
    assert.deepEqual(rawOauth(CID2), rawBefore, "failed upsert stores nothing");

    process.env[KEY_ENV] = FAKE_TOKEN_ENCRYPTION_KEY;
    assert.ok(rawOauth(CID2).refresh_token.startsWith(ENVELOPE_V2_PREFIX));
    assert.ok(!JSON.stringify(rawOauth(CID2)).includes("rt-attacker"));
    assert.ok(!JSON.stringify(rawOauth(CID2)).includes("rt-original"), "plaintext never lands");
    assert.equal(api.getCommandPermissionOauth(CID2).refresh_token, "rt-original");
  });

  it("upsert rejects an empty refreshToken (NOT NULL column can no longer be fed '')", () => {
    assert.throws(
      () => api.upsertCommandPermissionOauth(CID2, { refreshToken: "" }),
      /refreshToken is required/
    );
  });

  it("exchangeAuthorizationCode refuses to burn an OAuth code while the key is missing (no token POST)", async () => {
    const prevFetch = global.fetch;
    let called = 0;
    global.fetch = async () => {
      called += 1;
      throw new Error("network must not be reached");
    };
    const prevEnv = {};
    for (const k of ["CLIENT_ID", "CLIENT_SECRET", "TICKET_HTTP_PORT", "TICKET_PUBLIC_BASE_URL"]) {
      prevEnv[k] = process.env[k];
    }
    try {
      process.env.CLIENT_ID = "123456789012345678";
      process.env.CLIENT_SECRET = "fake-client-secret-not-a-real-secret";
      process.env.TICKET_HTTP_PORT = "3777";
      process.env.TICKET_PUBLIC_BASE_URL = "https://bot.example.test";
      delete process.env[KEY_ENV];
      await assert.rejects(
        () => oauthTokens.exchangeAuthorizationCode({ communityId: CID, code: "fake-code" }),
        (err) => {
          assert.equal(err.code, "third_party_token_key_missing");
          assert.match(err.message, /TOKEN_ENCRYPTION_KEY/);
          return true;
        }
      );
      assert.equal(called, 0, "no token POST before the storage pre-check passes");
    } finally {
      global.fetch = prevFetch;
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// ===========================================================================
// #281 — key rotation: lazy forward convergence
// ===========================================================================

describe("key rotation lazy convergence (#281)", () => {
  const crypto = require("crypto");
  const KEY_OLD = Buffer.alloc(32, 0x21).toString("base64");
  const KEY_NEW = Buffer.alloc(32, 0x22).toString("base64");
  const KEY_LOST = Buffer.alloc(32, 0x23).toString("base64");
  const KEY_RETIRED_ENV = "TOKEN_ENCRYPTION_KEY_RETIRED";
  const CIDR = communityKey("1554590611015729990");
  const CIDR2 = communityKey("1554590611015729991");

  /** Hand-rolled v1 envelope (the legacy form new code never writes). */
  function handV1(keyB64, plaintext) {
    const key = Buffer.from(keyB64, "base64");
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return [
      "v1",
      iv.toString("base64"),
      c.getAuthTag().toString("base64"),
      ct.toString("base64"),
    ].join(".");
  }

  async function withKeys(current, retired, fn) {
    const prev = {
      [KEY_ENV]: process.env[KEY_ENV],
      [KEY_RETIRED_ENV]: process.env[KEY_RETIRED_ENV],
    };
    try {
      if (current == null) delete process.env[KEY_ENV];
      else process.env[KEY_ENV] = current;
      if (retired == null) delete process.env[KEY_RETIRED_ENV];
      else process.env[KEY_RETIRED_ENV] = retired;
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("a watch sealed with the pre-rotation key converges on the next read", async () => {
    // Pre-rotation: token stored under the OLD key...
    await withKeys(KEY_OLD, null, () => {
      api.addGithubWatch(CIDR, "acme/rot", "acme/rot", { token: "ghp-rotate-me" });
    });
    const v2OldId = rawWatchToken(CIDR, "acme/rot");
    assert.ok(v2OldId.startsWith("v2."));

    // Rotate: current becomes NEW, OLD demoted to RETIRED.
    const watches = await withKeys(KEY_NEW, KEY_OLD, () => api.getAllGithubWatches());
    const watch = watches.find((w) => w.repo === "acme/rot");
    assert.equal(watch?.token, "ghp-rotate-me", "old-key row reads through the retired key");
    const converged = rawWatchToken(CIDR, "acme/rot");
    assert.ok(
      converged !== v2OldId && converged.startsWith("v2."),
      "row re-sealed forward to a v2 envelope"
    );

    // Converged: further reads are byte-identical (no rewrite churn).
    const again = await withKeys(KEY_NEW, null, () => api.getAllGithubWatches());
    assert.equal(again.find((w) => w.repo === "acme/rot")?.token, "ghp-rotate-me",
      "retired entry can be dropped once rows converged");
    assert.equal(rawWatchToken(CIDR, "acme/rot"), converged, "steady state: no rewrite");
  });

  it("an OAuth grant sealed with the pre-rotation key converges on the next read", async () => {
    await withKeys(KEY_OLD, null, () => {
      api.upsertCommandPermissionOauth(CIDR2, {
        refreshToken: "rt-rot",
        accessToken: "at-rot",
        accessExpiresAt: 999,
        authorizedByUserId: "u1",
      });
    });
    await withKeys(KEY_NEW, KEY_OLD, async () => {
      const row = api.getCommandPermissionOauth(CIDR2);
      assert.equal(row.refresh_token, "rt-rot");
      assert.equal(row.access_token, "at-rot");
    });
    const raw = rawOauth(CIDR2);
    assert.ok(raw.refresh_token.startsWith("v2.") && raw.access_token.startsWith("v2."));
    // Both columns now read WITHOUT the retired entry (converged).
    const after = await withKeys(KEY_NEW, null, () => api.getCommandPermissionOauth(CIDR2));
    assert.equal(after.refresh_token, "rt-rot");
    assert.equal(after.access_token, "at-rot");
  });

  it("a key that was rotated out WITHOUT retiring still fails loud per-site (unchanged)", async () => {
    await withKeys(KEY_LOST, null, () => {
      api.addGithubWatch(CIDR2, "acme/stranded", "acme/stranded", { token: "ghp-stranded" });
      api.upsertCommandPermissionOauth(CIDR, {
        refreshToken: "rt-stranded",
        accessToken: null,
        accessExpiresAt: null,
        authorizedByUserId: "u1",
      });
    });
    await withKeys(KEY_NEW, null, () => {
      // github: per-row skip + log (ticker keeps serving healthy rows)
      const logs = [];
      const orig = console.error;
      console.error = (...a) => logs.push(a.join(" "));
      try {
        const list = api.getAllGithubWatches();
        assert.ok(!list.some((w) => w.repo === "acme/stranded"), "stranded row skipped");
      } finally {
        console.error = orig;
      }
      assert.ok(
        logs.some((l) => l.includes("acme/stranded") && l.includes("could not be decrypted")),
        "the skip names the row"
      );
      // oauth: verbatim throw (contract of the sync path)
      assert.throws(
        () => api.getCommandPermissionOauth(CIDR),
        /could not be decrypted/
      );
    });
  });
});
