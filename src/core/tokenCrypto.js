/**
 * Generic AES-256-GCM token envelope (audit-2026-10 C6 core; rotation
 * story = issue #281).
 *
 * TWO ENVELOPE FORMS, both dot-separated canonical base64 segments:
 *   v1.<iv_b64>.<tag_b64>.<ciphertext_b64>          (legacy, READ-ONLY)
 *   v2.<keyid>.<iv_b64>.<tag_b64>.<ciphertext_b64>  (all new writes)
 *
 * v1 stays readable forever; every new seal is v2. The v2 `keyid` is the
 * first 8 hex chars of SHA-256 over a fixed domain string + the key bytes:
 * deterministic from the key, public-safe (a digest of 256-bit random
 * material leaks nothing), and needs ZERO configuration — rotation is an
 * env change, not a schema change.
 *
 * KEY SET per store (rotation story, #281):
 *  - CURRENT key: <ENV> (e.g. TOKEN_ENCRYPTION_KEY). Writes require it;
 *    every new envelope carries its keyid.
 *  - RETIRED keys: <ENV>_RETIRED, comma-separated, each a strict key.
 *    Read-only by construction: encrypt NEVER consults them. Rotate by
 *    moving the old key from <ENV> to <ENV>_RETIRED and setting the new
 *    key in <ENV>; rows converge forward via the lazy re-encrypt-on-read
 *    (needsReencrypt + callers); the retired entry is deleted once no row
 *    still carries v1 or the old keyid.
 *
 * READ rules (fail-loud posture unchanged — invisible corruption stays
 * impossible):
 *  - v1: try CURRENT then each RETIRED entry in order (v1 has no id).
 *  - v2: select EXACTLY by keyid among current+retired. An unknown keyid
 *    fails as envelope_invalid — a blind try-each would paper over a
 *    wrong-key restore.
 *  - Empty key set (no current, no retired) fails as key_missing (the
 *    actionable sentence), for both versions.
 *
 * Contract (identical to the original C6 extraction for everything else):
 *  - Keys: STRICT base64 — the string must round-trip through base64
 *    (Buffer.from is lenient; a hand-typed non-key must not half-work) and
 *    decode to exactly 32 bytes. Invalid retired LIST entries are dropped
 *    silently (never half-used); dropping a needed key surfaces later as
 *    the usual envelope_invalid line.
 *  - `encrypt` returns `null` — NOT a throw — when the current key is
 *    missing or invalid; expected failures are values, not exceptions
 *    (AGENTS.md rule 6).
 *  - `decrypt` throws with a STATIC message and a stable `err.code`
 *    (`<codePrefix>_key_missing` / `<codePrefix>_envelope_invalid`). Error
 *    strings NEVER contain key material, the envelope, or the plaintext.
 *  - `looksLikeEnvelope` / `envelopeVersion` are strict STRUCTURAL checks
 *    only; they prove nothing about decryptability. Migration 039 uses
 *    them to classify rows; a genuine encrypt-check is a successful
 *    `decrypt`. v2 recognition keeps 039 from re-wrapping v2 rows.
 *  - `needsReencrypt(envelope)` is the lazy-migration signal for read
 *    sites: true for v1 rows and v2 rows sealed by a NON-current key,
 *    false for everything else (including when no current key exists —
 *    with no write key there is nothing to converge to).
 *
 * Key access is injectable (per-call `opts.keyGetter` / `opts.retiredGetter`,
 * else the factory's env getters reading at call time) so unit tests supply
 * keys without touching the environment.
 */

const crypto = require("crypto");

const ENVELOPE_VERSION = "v1";
const ENVELOPE_PREFIX = `${ENVELOPE_VERSION}.`;
const WRITE_ENVELOPE_VERSION = "v2";
const ENVELOPE_V2_PREFIX = `${WRITE_ENVELOPE_VERSION}.`;
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_ID_HEX = 8;
/** Domain separator for the public keyid digest — never reuse elsewhere. */
const KEY_ID_CONTEXT = "boiler-snake/at-rest-key-id:v2\n";

/**
 * Decode and validate base64 key material (strict round-trip, see header).
 *
 * @param {() => unknown} getKey
 * @returns {Buffer|null} the 32-byte key, or null when missing/invalid
 */
function decodeKey(getKey) {
  let raw;
  try {
    raw = getKey();
  } catch {
    return null;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let buf;
  try {
    buf = Buffer.from(trimmed, "base64");
  } catch {
    return null;
  }
  if (buf.length !== KEY_BYTES) return null;
  // Strict round-trip: base64 canonical form must reproduce the input.
  if (buf.toString("base64") !== trimmed) return null;
  return buf;
}

/**
 * Decode a RETIRED key LIST: comma-separated strict keys. Invalid entries
 * (empty, wrong length, non-canonical base64) are DROPPED, never
 * half-used; a throwing getter yields the empty set.
 *
 * @param {() => unknown} getRetired
 * @returns {Buffer[]} valid retired keys, in list order
 */
function decodeRetiredKeys(getRetired) {
  let raw;
  try {
    raw = getRetired();
  } catch {
    return [];
  }
  if (typeof raw !== "string") return [];
  const out = [];
  for (const piece of raw.split(",")) {
    const trimmed = piece.trim();
    if (trimmed === "") continue;
    const key = decodeKey(() => trimmed);
    if (key) out.push(key);
  }
  return out;
}

/**
 * The public, deterministic id of a key: 8 hex chars of
 * SHA-256(KEY_ID_CONTEXT || keyBytes). Accepts decoded bytes or a strict
 * base64 string; anything invalid → null.
 *
 * @param {Buffer|string|null|undefined} keyLike
 * @returns {string|null}
 */
function keyIdFor(keyLike) {
  let buf;
  if (Buffer.isBuffer(keyLike)) {
    buf = keyLike.length === KEY_BYTES ? keyLike : null;
  } else if (typeof keyLike === "string") {
    buf = decodeKey(() => keyLike);
  }
  if (!buf) return null;
  return crypto
    .createHash("sha256")
    .update(KEY_ID_CONTEXT, "utf8")
    .update(buf)
    .digest("hex")
    .slice(0, KEY_ID_HEX);
}

/** Canonical-base64 segment check (strict round-trip, non-empty). */
function isCanonicalB64(part) {
  if (typeof part !== "string" || part === "") return false;
  const buf = Buffer.from(part, "base64");
  return buf.toString("base64") === part;
}

/**
 * Strict structural classification: "v1", "v2", or null. v1 keeps the
 * original C6 shape rules; v2 additionally requires an 8-lowercase-hex
 * keyid as segment 1 and the same IV/tag/ciphertext byte lengths.
 *
 * @param {unknown} value
 * @returns {"v1"|"v2"|null}
 */
function envelopeVersion(value) {
  if (typeof value !== "string" || value === "") return null;
  const parts = value.split(".");

  if (parts.length === 4 && parts[0] === ENVELOPE_VERSION) {
    if (!parts.slice(1).every(isCanonicalB64)) return null;
    const iv = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const ciphertext = Buffer.from(parts[3], "base64");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) {
      return null;
    }
    return ENVELOPE_VERSION;
  }

  if (parts.length === 5 && parts[0] === WRITE_ENVELOPE_VERSION) {
    if (!/^[0-9a-f]{8}$/.test(parts[1])) return null;
    if (!parts.slice(2).every(isCanonicalB64)) return null;
    const iv = Buffer.from(parts[2], "base64");
    const tag = Buffer.from(parts[3], "base64");
    const ciphertext = Buffer.from(parts[4], "base64");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) {
      return null;
    }
    return WRITE_ENVELOPE_VERSION;
  }

  return null;
}

/**
 * Strict structural check for either envelope form (see envelopeVersion).
 * Deliberately does NOT decrypt — a shape match can still be a foreign-key
 * or tampered envelope.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function looksLikeEnvelope(value) {
  return envelopeVersion(value) !== null;
}

/**
 * Build a bound envelope codec for one token store.
 *
 * @param {object} opts
 * @param {string} opts.envVarName env var holding the CURRENT 32-byte
 *   base64 key (named in the key-missing error so the operator can act)
 * @param {string} [opts.envVarNameRetired] env var holding the comma-
 *   separated RETIRED key list (default: `${envVarName}_RETIRED`; pass the
 *   literal in bindings so env-parity tooling sees the name)
 * @param {string} opts.codePrefix prefix for stable error codes
 *   (`<codePrefix>_key_missing`, `<codePrefix>_envelope_invalid`)
 * @param {string} opts.label human noun for static error strings
 * @param {() => unknown} [opts.defaultKeyGetter] env getter override
 *   (defaults to `process.env[envVarName]` read at call time)
 * @param {() => unknown} [opts.defaultRetiredKeyGetter] retired env getter
 *   override (defaults to `process.env[envVarNameRetired]` at call time)
 * @returns {{
 *   hasKey: (opts?: { keyGetter?: () => unknown }) => boolean,
 *   encrypt: (plaintext: string, opts?: { keyGetter?: () => unknown }) => string|null,
 *   decrypt: (envelope: string, opts?: { keyGetter?: () => unknown, retiredGetter?: () => unknown }) => string,
 *   needsReencrypt: (envelope: string, opts?: { keyGetter?: () => unknown }) => boolean,
 * }}
 */
function createEnvelopeCrypto({
  envVarName,
  envVarNameRetired = `${envVarName}_RETIRED`,
  codePrefix,
  label,
  defaultKeyGetter,
  defaultRetiredKeyGetter,
}) {
  const readKey = defaultKeyGetter ?? (() => process.env[envVarName]);
  const readRetired =
    defaultRetiredKeyGetter ?? (() => process.env[envVarNameRetired]);

  const fail = (code) => {
    const err = new Error(
      code === "key_missing"
        ? `${label} crypto unavailable: ${envVarName} is not configured`
        : `${label} envelope failed verification`
    );
    err.code = `${codePrefix}_${code}`;
    return err;
  };

  /**
   * @param {{ keyGetter?: () => unknown }} [opts]
   * @returns {boolean} true when a usable CURRENT 32-byte base64 key is
   *   configured (write capability; retired keys never satisfy this).
   */
  function hasKey(opts = {}) {
    return decodeKey(opts.keyGetter ?? readKey) !== null;
  }

  /**
   * Encrypt a plaintext token into a `v2.<keyid>.…` envelope with the
   * CURRENT key. Returns `null` (never throws) when the current key is
   * missing/invalid.
   *
   * @param {string} plaintext
   * @param {{ keyGetter?: () => unknown }} [opts]
   * @returns {string|null}
   */
  function encrypt(plaintext, opts = {}) {
    if (typeof plaintext !== "string" || plaintext === "") return null;
    const key = decodeKey(opts.keyGetter ?? readKey);
    if (!key) return null;

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      WRITE_ENVELOPE_VERSION,
      keyIdFor(key),
      iv.toString("base64"),
      tag.toString("base64"),
      ciphertext.toString("base64"),
    ].join(".");
  }

  /** Raw GCM attempt; throws on any auth/shape failure (caller translates). */
  function openWith(envelope, version, keyid, key) {
    const parts = envelope.split(".");
    const iv = Buffer.from(parts[version === ENVELOPE_VERSION ? 1 : 2], "base64");
    const tag = Buffer.from(parts[version === ENVELOPE_VERSION ? 2 : 3], "base64");
    const ciphertext = Buffer.from(parts[version === ENVELOPE_VERSION ? 3 : 4], "base64");
    if (iv.length !== IV_BYTES || tag.length === 0 || ciphertext.length === 0) {
      throw fail("envelope_invalid");
    }
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }

  /**
   * Decrypt a stored envelope (v1 or v2) back to the token plaintext.
   * Key-set semantics per the header: v1 tries current then retired in
   * order; v2 selects exactly by keyid. Any malformed, tampered, unknown-
   * keyid, or keyless input throws with a STATIC message.
   *
   * @param {string} envelope
   * @param {{ keyGetter?: () => unknown, retiredGetter?: () => unknown }} [opts]
   * @returns {string}
   */
  function decrypt(envelope, opts = {}) {
    if (typeof envelope !== "string" || envelope === "") throw fail("envelope_invalid");
    const version = envelopeVersion(envelope);
    if (!version) throw fail("envelope_invalid");

    const current = decodeKey(opts.keyGetter ?? readKey);
    const retired = decodeRetiredKeys(opts.retiredGetter ?? readRetired);
    if (!current && retired.length === 0) {
      // Key missing is a distinct condition from corruption: callers may
      // surface a key-configuration sentence instead of a damage report.
      throw fail("key_missing");
    }

    if (version === WRITE_ENVELOPE_VERSION) {
      const keyid = envelope.split(".")[1];
      const candidates = [
        ...(current && keyIdFor(current) === keyid ? [current] : []),
        ...retired.filter((k) => keyIdFor(k) === keyid),
      ];
      if (candidates.length === 0) throw fail("envelope_invalid");
      for (const key of candidates) {
        try {
          return openWith(envelope, version, keyid, key);
        } catch {
          throw fail("envelope_invalid");
        }
      }
      throw fail("envelope_invalid");
    }

    // v1: no embedded id — the whole key set is the candidate list,
    // current first (the steady state hits on the first try).
    for (const key of [current, ...retired]) {
      if (!key) continue;
      try {
        return openWith(envelope, version, null, key);
      } catch {
        // next candidate; a failed auth tag on every key is corruption or
        // a key that was NOT retired into the set.
      }
    }
    throw fail("envelope_invalid");
  }

  /**
   * Lazy forward-migration signal for read sites: does this stored value
   * need a re-seal with the CURRENT key? True for v1 rows and for v2 rows
   * whose keyid is not the current key's; false for non-envelopes (the
   * caller's decrypt would have thrown) and when no current key exists
   * (nothing to write with).
   *
   * @param {string} envelope
   * @param {{ keyGetter?: () => unknown }} [opts]
   * @returns {boolean}
   */
  function needsReencrypt(envelope, opts = {}) {
    const version = envelopeVersion(envelope);
    if (!version) return false;
    const current = decodeKey(opts.keyGetter ?? readKey);
    if (!current) return false;
    if (version === ENVELOPE_VERSION) return true;
    return envelope.split(".")[1] !== keyIdFor(current);
  }

  return { hasKey, encrypt, decrypt, needsReencrypt };
}

module.exports = {
  ENVELOPE_VERSION,
  ENVELOPE_PREFIX,
  WRITE_ENVELOPE_VERSION,
  ENVELOPE_V2_PREFIX,
  KEY_ID_HEX,
  decodeKey,
  decodeRetiredKeys,
  keyIdFor,
  envelopeVersion,
  looksLikeEnvelope,
  createEnvelopeCrypto,
};
