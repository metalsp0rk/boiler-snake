/**
 * Generic AES-256-GCM token envelope (audit-2026-10 C6 core).
 *
 * This is the envelope structure already shipped in src/features/bridge/
 * tokenCrypto.js and src/web/auth/tokens.js —
 *   v1.<iv_b64>.<tag_b64>.<ciphertext_b64>
 * — extracted so every at-rest token store shares ONE implementation and one
 * version marker. Each call site binds its own 32-byte base64 key env var
 * (domain separation: rotating one store's key must not strand another's).
 *
 * Contract (identical to the bridge module this was extracted from):
 *  - Keys: STRICT base64 — the string must round-trip through base64
 *    (Buffer.from is lenient; a hand-typed non-key must not half-work) and
 *    decode to exactly 32 bytes.
 *  - `encrypt` returns `null` — NOT a throw — when the key is missing or
 *    invalid; expected failures are values, not exceptions (AGENTS.md rule 6).
 *    The caller decides what a missing key means for its feature.
 *  - `decrypt` throws with a STATIC message and a stable `err.code`
 *    (`<codePrefix>_key_missing` / `<codePrefix>_envelope_invalid`). Error
 *    strings NEVER contain key material, the envelope, or the plaintext.
 *  - `looksLikeEnvelope` is a strict SHAPE check only (version marker + 4
 *    base64 parts + field lengths); it proves nothing about decryptability.
 *    Migration 039 uses it to classify rows; a genuine encrypt-check is a
 *    successful `decrypt`.
 *
 * Key access is an injectable getter (per-call `opts.keyGetter`, else the
 * factory's `defaultKeyGetter` reading env at call time) so unit tests supply
 * a key without touching the environment.
 */

const crypto = require("crypto");

const ENVELOPE_VERSION = "v1";
const ENVELOPE_PREFIX = `${ENVELOPE_VERSION}.`;
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Decode and validate the base64 key material (strict round-trip, see header).
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
 * Strict structural check for the envelope format: exactly four
 * dot-separated parts, the version marker, canonical base64 parts, and the
 * IV/auth-tag byte lengths AES-GCM produces here. Deliberately does NOT
 * decrypt — a shape match can still be a foreign-key or tampered envelope.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function looksLikeEnvelope(value) {
  if (typeof value !== "string" || value === "") return false;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) return false;
  for (const part of parts.slice(1)) {
    if (part === "") return false;
    const buf = Buffer.from(part, "base64");
    // Canonical round-trip: reject "v1.<junk>.<junk>.<junk>" shapes early.
    if (buf.toString("base64") !== part) return false;
  }
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ciphertext = Buffer.from(parts[3], "base64");
  return iv.length === IV_BYTES && tag.length === TAG_BYTES && ciphertext.length > 0;
}

/**
 * Build a bound envelope codec for one token store.
 *
 * @param {object} opts
 * @param {string} opts.envVarName env var holding the 32-byte base64 key
 *   (named in the key-missing error so the operator can act on it)
 * @param {string} opts.codePrefix prefix for stable error codes
 *   (`<codePrefix>_key_missing`, `<codePrefix>_envelope_invalid`)
 * @param {string} opts.label human noun for static error strings,
 *   e.g. "bridge webhook token"
 * @param {() => unknown} [opts.defaultKeyGetter] env getter override
 *   (defaults to `process.env[envVarName]` read at call time)
 * @returns {{
 *   hasKey: (opts?: { keyGetter?: () => unknown }) => boolean,
 *   encrypt: (plaintext: string, opts?: { keyGetter?: () => unknown }) => string|null,
 *   decrypt: (envelope: string, opts?: { keyGetter?: () => unknown }) => string,
 * }}
 */
function createEnvelopeCrypto({ envVarName, codePrefix, label, defaultKeyGetter }) {
  const readKey =
    defaultKeyGetter ?? (() => process.env[envVarName]);

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
   * @returns {boolean} true when a usable 32-byte base64 key is configured
   */
  function hasKey(opts = {}) {
    return decodeKey(opts.keyGetter ?? readKey) !== null;
  }

  /**
   * Encrypt a plaintext token into the `v1.…` envelope. Returns `null`
   * (never throws) when the key is missing/invalid.
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
      ENVELOPE_VERSION,
      iv.toString("base64"),
      tag.toString("base64"),
      ciphertext.toString("base64"),
    ].join(".");
  }

  /**
   * Decrypt a stored envelope back to the token plaintext. Any malformed,
   * tampered, or keyless input throws with a STATIC message.
   *
   * @param {string} envelope
   * @param {{ keyGetter?: () => unknown }} [opts]
   * @returns {string}
   */
  function decrypt(envelope, opts = {}) {
    if (typeof envelope !== "string" || envelope === "") throw fail("envelope_invalid");

    const parts = envelope.split(".");
    if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) throw fail("envelope_invalid");

    const key = decodeKey(opts.keyGetter ?? readKey);
    if (!key) {
      // Key missing is a distinct condition from corruption: callers may
      // surface a key-configuration sentence instead of a damage report.
      throw fail("key_missing");
    }

    const iv = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const ciphertext = Buffer.from(parts[3], "base64");
    if (iv.length !== IV_BYTES || tag.length === 0 || ciphertext.length === 0) {
      throw fail("envelope_invalid");
    }

    try {
      const decipher = crypto.createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw fail("envelope_invalid");
    }
  }

  return { hasKey, encrypt, decrypt };
}

module.exports = {
  ENVELOPE_VERSION,
  ENVELOPE_PREFIX,
  decodeKey,
  looksLikeEnvelope,
  createEnvelopeCrypto,
};
