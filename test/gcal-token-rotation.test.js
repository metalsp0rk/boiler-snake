/**
 * #281 — gcal (event_google_links) lazy convergence. freshToken's
 * non-refresh path decrypts with the key SET (current + RETIRED) and
 * re-seals both envelopes with the CURRENT key, so a rotated-out key can
 * be retired and later dropped without a reconnect dance.
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { loadDb, communityKey } = require("./helpers/env");
const { cleanup, api } = loadDb();
after(cleanup);

const events = require("../src/db/repositories/events");
const gcal = require("../src/features/events/gcal");
const { KEY_ENV, ENVELOPE_V2_PREFIX } = require("../src/core/thirdPartyTokens");
const KEY_RETIRED_ENV = "TOKEN_ENCRYPTION_KEY_RETIRED";

const KEY_OLD = Buffer.alloc(32, 0x51).toString("base64");
const KEY_NEW = Buffer.alloc(32, 0x52).toString("base64");

function sealV1(keyB64, plaintext) {
  const key = Buffer.from(keyB64, "base64");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

function rawLink(communityId, userId) {
  return api.db
    .prepare("SELECT access_token_enc, refresh_token_enc FROM event_google_links WHERE community_id=? AND user_id=?")
    .get(communityId, String(userId));
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

describe("gcal link rotation convergence (#281)", () => {
  const CID = (() => {
    const { ensureCommunity } = require("../src/platform/community");
    return ensureCommunity({ platform: "discord", instanceKey: "discord", externalGuildId: "999000111222333444" });
  })();

  it("a v1 link reads through the retired key and converges to v2 (both columns)", async () => {
    const uid = "u-gcal-rot";
    withEnv({ [KEY_ENV]: KEY_OLD }, () => {
      events.upsertEventGoogleLink({
        communityId: CID,
        userId: uid,
        email: "me@example.test",
        accessTokenEnc: sealV1(KEY_OLD, "acc-rot"),
        refreshTokenEnc: sealV1(KEY_OLD, "ref-rot"),
        expiry: Date.now() + 3_600_000, // non-refresh path
      });
    });
    assert.ok(rawLink(CID, uid).access_token_enc.startsWith("v1."));

    const res = await withEnv({ [KEY_ENV]: KEY_NEW, [KEY_RETIRED_ENV]: KEY_OLD }, () =>
      gcal.freshToken(CID, uid)
    );
    assert.equal(res.ok, true, `freshToken must read via retired key: ${res.error}`);
    assert.equal(res.token, "acc-rot");

    const raw = rawLink(CID, uid);
    assert.ok(raw.access_token_enc.startsWith(ENVELOPE_V2_PREFIX), "access converged to v2");
    assert.ok(raw.refresh_token_enc.startsWith(ENVELOPE_V2_PREFIX), "refresh converged too");

    // Retired entry dropped: converged row keeps working, untouched.
    const res2 = await withEnv({ [KEY_ENV]: KEY_NEW, [KEY_RETIRED_ENV]: null }, () =>
      gcal.freshToken(CID, uid)
    );
    assert.equal(res2.ok, true);
    assert.equal(rawLink(CID, uid).access_token_enc, raw.access_token_enc, "steady state: no rewrite");
  });

  it("a link sealed by a never-retired key fails the SAME actionable way (unchanged)", async () => {
    const uid = "u-gcal-strand";
    withEnv({ [KEY_ENV]: KEY_OLD }, () => {
      events.upsertEventGoogleLink({
        communityId: CID,
        userId: uid,
        accessTokenEnc: sealV1(KEY_OLD, "acc-dead"),
        expiry: Date.now() + 3_600_000,
      });
    });
    const res = await withEnv({ [KEY_ENV]: KEY_NEW, [KEY_RETIRED_ENV]: null }, () =>
      gcal.freshToken(CID, uid)
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /Stored token unreadable \(key change\?\)/);
    assert.ok(rawLink(CID, uid).access_token_enc.startsWith("v1."), "row untouched on failure");
  });
});
