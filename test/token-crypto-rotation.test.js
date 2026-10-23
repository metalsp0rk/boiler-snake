/**
 * v2 multi-key envelope + rotation story (#281, audit C6 lineage).
 *
 * v1 (`v1.<iv>.<tag>.<ct>`) stays READABLE forever; every new seal uses
 * `v2.<keyid>.<iv>.<tag>.<ct>` with the current key, where keyid is a
 * deterministic 8-hex digest of the key itself (no configuration). Retired
 * keys come from `<ENV>_RETIRED` (comma-separated strict base64) or an
 * injected getter. Reads: v1 tries the whole key set, v2 selects EXACTLY by
 * keyid — an unknown keyid still fails loud (unchanged posture). Writes:
 * always v2 with the current key. Lazy re-encrypt-on-read converges rows
 * forward; retiring the old key is just deleting the RETIRED entry.
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  ENVELOPE_PREFIX,
  ENVELOPE_V2_PREFIX,
  keyIdFor,
  decodeRetiredKeys,
  looksLikeEnvelope,
  envelopeVersion,
  createEnvelopeCrypto,
} = require("../src/core/tokenCrypto");

// Clearly-fake deterministic keys (AGENTS.md: never realistic secrets).
const KEY_OLD = Buffer.alloc(32, 0x0a).toString("base64");
const KEY_NEW = Buffer.alloc(32, 0x0b).toString("base64");
const KEY_FOREIGN = Buffer.alloc(32, 0x0c).toString("base64");

function codecFor(envVarName = "TEST_TOKEN_KEY") {
  return createEnvelopeCrypto({
    envVarName,
    codePrefix: "test_token",
    label: "test token",
  });
}

/** Hand-roll a v1 envelope with KEY (v1 is read-only history now). */
function handV1(keyB64, plaintext) {
  const key = Buffer.from(keyB64, "base64");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

describe("v2 envelope shape + key ids (#281)", () => {
  it("encrypt emits v2 with the CURRENT key's deterministic keyid", () => {
    const c = codecFor();
    const env = c.encrypt("tok-1", { keyGetter: () => KEY_NEW });
    assert.ok(env.startsWith(ENVELOPE_V2_PREFIX), `v2 prefix: ${env.slice(0, 6)}`);
    const parts = env.split(".");
    assert.equal(parts.length, 5, "v2.<keyid>.<iv>.<tag>.<ct>");
    assert.equal(parts[1], keyIdFor(KEY_NEW));
    assert.match(parts[1], /^[0-9a-f]{8}$/);
    assert.equal(c.decrypt(env, { keyGetter: () => KEY_NEW }), "tok-1");
  });

  it("keyIdFor is deterministic, distinct per key, null on junk", () => {
    assert.equal(keyIdFor(KEY_OLD), keyIdFor(KEY_OLD));
    assert.notEqual(keyIdFor(KEY_OLD), keyIdFor(KEY_NEW));
    assert.equal(keyIdFor("nope!!"), null);
    assert.equal(keyIdFor(null), null);
    assert.equal(keyIdFor(Buffer.alloc(31)), null);
  });

  it("decodeRetiredKeys parses a comma list strictly (invalid entries dropped)", () => {
    const keys = decodeRetiredKeys(() => ` ${KEY_OLD} , junk-not-base64!!,${Buffer.alloc(31).toString("base64")} ,${KEY_NEW}`);
    assert.deepEqual(
      keys.map((k) => k.toString("base64")),
      [KEY_OLD, KEY_NEW],
      "only strict 32-byte canonical entries survive"
    );
    assert.deepEqual(decodeRetiredKeys(() => undefined), []);
    assert.deepEqual(decodeRetiredKeys(() => { throw new Error("boom"); }), []);
  });

  it("looksLikeEnvelope / envelopeVersion classify v1 AND v2, reject junk", () => {
    const c = codecFor();
    const v2 = c.encrypt("tok", { keyGetter: () => KEY_NEW });
    const v1 = handV1(KEY_NEW, "tok");
    assert.equal(looksLikeEnvelope(v1), true);
    assert.equal(looksLikeEnvelope(v2), true);
    assert.equal(envelopeVersion(v1), "v1");
    assert.equal(envelopeVersion(v2), "v2");
    assert.equal(envelopeVersion("v2.zzzzzzzz.me.wvA=.YWJj"), null, "non-hex keyid rejected");
    assert.equal(envelopeVersion("v2.0123456789.me.wvA=.YWJj"), null, "9-hex keyid rejected");
    assert.equal(envelopeVersion("v2.01234567.me.wvA="), null, "4-part v2 rejected");
    assert.equal(envelopeVersion("plain-text"), null);
    assert.equal(envelopeVersion(null), null);
  });
});

describe("multi-key reads: the rotation story (#281)", () => {
  const c = codecFor("ROT_KEY");

  it("v1 rows stay readable with the CURRENT key (zero-rotation regression)", () => {
    const v1 = handV1(KEY_OLD, "legacy-secret");
    assert.equal(c.decrypt(v1, { keyGetter: () => KEY_OLD }), "legacy-secret");
  });

  it("v1 rows decrypt with a RETIRED key after rotation (current=new)", () => {
    const v1 = handV1(KEY_OLD, "legacy-secret");
    assert.equal(
      c.decrypt(v1, { keyGetter: () => KEY_NEW, retiredGetter: () => KEY_OLD }),
      "legacy-secret",
      "rotated-out key keeps old rows readable via <ENV>_RETIRED semantics"
    );
  });

  it("v2 rows decrypt when their key was DEMOTED to retired (exact keyid pick)", () => {
    const sealed = c.encrypt("tok-x", { keyGetter: () => KEY_OLD }); // v2.<id-old>
    assert.equal(
      c.decrypt(sealed, { keyGetter: () => KEY_NEW, retiredGetter: () => KEY_OLD }),
      "tok-x"
    );
  });

  it("v2 with an UNKNOWN keyid fails loud — no blind try-each read", () => {
    const sealed = c.encrypt("tok-y", { keyGetter: () => KEY_FOREIGN });
    // The sealing key is NOT in the set {new, old}: the envelope's keyid
    // cannot be selected → fail loud (unchanged unknown-key posture).
    assert.throws(
      () =>
        c.decrypt(sealed, {
          keyGetter: () => KEY_NEW,
          retiredGetter: () => KEY_OLD,
        }),
      (err) => err.code === "test_token_envelope_invalid" && !/tok-y/.test(err.message),
      "unknown keyid = envelope_invalid, no leak"
    );
  });

  it("v2 whose keyid matches a RETIRED entry decrypts with that entry", () => {
    const sealed = c.encrypt("tok-z", { keyGetter: () => KEY_FOREIGN });
    assert.equal(
      c.decrypt(sealed, { keyGetter: () => KEY_NEW, retiredGetter: () => KEY_FOREIGN }),
      "tok-z"
    );
  });

  it("v1 tries current THEN retired in order (wrong current, right retired)", () => {
    const v1 = handV1(KEY_OLD, "s");
    assert.throws(
      () => c.decrypt(v1, { keyGetter: () => KEY_NEW }),
      (err) => err.code === "test_token_envelope_invalid",
      "wrong current key alone = envelope_invalid (unchanged posture)"
    );
    assert.equal(
      c.decrypt(v1, { keyGetter: () => KEY_NEW, retiredGetter: () => `${KEY_FOREIGN},${KEY_OLD}` }),
      "s",
      "second retired entry hits"
    );
  });

  it("empty key set: key_missing for v1 AND v2 (actionable sentence first)", () => {
    const v1 = handV1(KEY_NEW, "s");
    const v2 = c.encrypt("s", { keyGetter: () => KEY_NEW });
    for (const env of [v1, v2]) {
      assert.throws(
        () => c.decrypt(env, { keyGetter: () => undefined, retiredGetter: () => undefined }),
        (err) => err.code === "test_token_key_missing"
      );
    }
  });

  it("garbage retired entries never decrypt anything (skipped, not half-used)", () => {
    const v1 = handV1(KEY_OLD, "s");
    assert.throws(
      () => c.decrypt(v1, { keyGetter: () => KEY_NEW, retiredGetter: () => "junk,!!!" }),
      (err) => err.code === "test_token_envelope_invalid"
    );
  });

  it("error strings never contain envelope or plaintext (v2 paths)", () => {
    const sealed = c.encrypt("SUPER-SECRET-PLAINTEXT", { keyGetter: () => KEY_NEW });
    assert.throws(
      () => c.decrypt(sealed, { keyGetter: () => KEY_FOREIGN }),
      (err) =>
        !err.message.includes("SUPER-SECRET-PLAINTEXT") &&
        !err.message.includes(sealed) &&
        err.code === "test_token_envelope_invalid"
    );
  });

  it("encrypt still returns null (never throws) with no current key — RETIRED does not enable writes", () => {
    assert.equal(c.encrypt("s", { keyGetter: () => undefined, retiredGetter: () => KEY_OLD }), null);
  });

  it("hasKey reflects the CURRENT (write) key only", () => {
    assert.equal(c.hasKey({ keyGetter: () => undefined, retiredGetter: () => KEY_OLD }), false);
    assert.equal(c.hasKey({ keyGetter: () => KEY_NEW }), true);
  });
});

describe("needsReencrypt: lazy forward-migration signal (#281)", () => {
  const c = codecFor("NR_KEY");

  it("v1 rows ask for migration while v2-with-current-id does not", () => {
    const v1 = handV1(KEY_NEW, "s"); // even sealed WITH the current key
    assert.equal(c.needsReencrypt(v1, { keyGetter: () => KEY_NEW }), true);
    const v2cur = c.encrypt("s", { keyGetter: () => KEY_NEW });
    assert.equal(c.needsReencrypt(v2cur, { keyGetter: () => KEY_NEW }), false);
    const v2old = c.encrypt("s", { keyGetter: () => KEY_OLD });
    assert.equal(
      c.needsReencrypt(v2old, { keyGetter: () => KEY_NEW, retiredGetter: () => KEY_OLD }),
      true,
      "v2 sealed by a demoted key converges on read"
    );
  });

  it("non-envelopes and no-current-key read as false (nothing to converge / no write possible)", () => {
    assert.equal(c.needsReencrypt("plaintext", { keyGetter: () => KEY_NEW }), false);
    assert.equal(c.needsReencrypt(null, { keyGetter: () => KEY_NEW }), false);
    const v1 = handV1(KEY_NEW, "s");
    assert.equal(c.needsReencrypt(v1, { keyGetter: () => undefined }), false);
  });
});

describe("bindings share the v2 codec with domain-separated keys (#281)", () => {
  const { encryptToken, decryptToken, needsTokenReencrypt, KEY_ENV, KEY_RETIRED_ENV } =
    require("../src/core/thirdPartyTokens");
  const { encryptWebhookToken, decryptWebhookToken, needsBridgeTokenReencrypt } =
    require("../src/features/bridge/tokenCrypto");

  it("third-party + bridge bindings produce cross-decryptable v2 envelopes (same core, different keys in prod)", () => {
    const env1 = encryptToken("shared-format", { keyGetter: () => KEY_NEW });
    assert.ok(env1.startsWith(ENVELOPE_V2_PREFIX));
    assert.equal(decryptWebhookToken(env1, { keyGetter: () => KEY_NEW }), "shared-format");
    const env2 = encryptWebhookToken("shared-format", { keyGetter: () => KEY_NEW });
    assert.equal(decryptToken(env2, { keyGetter: () => KEY_NEW }), "shared-format");
  });

  it("bindings expose the re-encrypt signal", () => {
    const env = encryptToken("s", { keyGetter: () => KEY_OLD });
    assert.equal(needsTokenReencrypt(env, { keyGetter: () => KEY_NEW, retiredGetter: () => KEY_OLD }), true);
    assert.equal(needsBridgeTokenReencrypt(env, { keyGetter: () => KEY_NEW, retiredGetter: () => KEY_OLD }), true);
    const fresh = encryptToken("s", { keyGetter: () => KEY_NEW });
    assert.equal(needsTokenReencrypt(fresh, { keyGetter: () => KEY_NEW }), false);
  });

  it("retired env var names are the current name + _RETIRED", () => {
    assert.equal(KEY_ENV, "TOKEN_ENCRYPTION_KEY");
    assert.equal(KEY_RETIRED_ENV, "TOKEN_ENCRYPTION_KEY_RETIRED");
  });

  it("the RETIRED env fallback reads process.env at call time", () => {
    const env = process.env;
    process.env = { ...env, TEST_ROT_KEY: KEY_NEW, TEST_ROT_KEY_RETIRED: KEY_OLD };
    try {
      const c = codecFor("TEST_ROT_KEY");
      const v1 = handV1(KEY_OLD, "from-env-retired");
      assert.equal(c.decrypt(v1), "from-env-retired", "no getters: env read, both names");
    } finally {
      process.env = env;
    }
  });
});
