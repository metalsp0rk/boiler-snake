/**
 * AES-256-GCM envelope for relay webhook tokens (roadmap/bridge.md §10.13,
 * §10.7 step 3): `bridge_ends.webhook_token_enc` stores ONLY the envelope
 * string, never the plaintext token.
 *
 * Follows the envelope structure of src/web/auth/tokens.js —
 *   v1.<iv_b64>.<tag_b64>.<ciphertext_b64>
 * — with its OWN key: BRIDGE_TOKEN_KEY, 32 bytes of base64, .env only
 * (the web-session key is HKDF-derived from SESSION_SECRET; the bridge key
 * is used directly, per spec §10.13: "BRIDGE_TOKEN_KEY, 32 bytes base64").
 * Key rotation is out of v1: rotating strands existing rows; staff disconnect
 * and reconnect.
 *
 * Key access is an INJECTABLE getter (default `process.env.BRIDGE_TOKEN_KEY`)
 * so unit tests supply a key without touching the environment. Production
 * env wiring ships with the activation PR (PR 7).
 *
 * Key hygiene (AGENTS.md): no error string here ever contains key material,
 * the envelope, or the plaintext token. Encrypt returns `null` — NOT a throw —
 * when the key is missing/invalid, which is how the service maps the missing
 * key to the §10.2 key-missing sentence.
 */

const crypto = require("crypto");

const ENVELOPE_VERSION = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Decode and validate the base64 key material. STRICT: the string must
 * round-trip through base64 (Buffer.from is lenient — "abc!" would decode to
 * garbage bytes; a hand-typed non-key must not half-work) and decode to
 * exactly 32 bytes.
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

function defaultGetKey() {
  return process.env.BRIDGE_TOKEN_KEY;
}

/**
 * True when BRIDGE_TOKEN_KEY (32 bytes, base64) is configured. Connect checks
 * this BEFORE any webhook create (spec §10.7 step 3).
 *
 * @param {{ keyGetter?: () => unknown }} [opts]
 * @returns {boolean}
 */
function hasBridgeTokenKey(opts = {}) {
  return decodeKey(opts.keyGetter ?? defaultGetKey) !== null;
}

/**
 * Encrypt a plaintext webhook token into the `v1.…` envelope.
 * Returns `null` (never throws) when the key is missing/invalid — expected
 * failures are values, not exceptions (AGENTS.md rule 6).
 *
 * @param {string} plaintext
 * @param {{ keyGetter?: () => unknown }} [opts]
 * @returns {string|null} envelope, or null when no usable key
 */
function encryptWebhookToken(plaintext, opts = {}) {
  if (typeof plaintext !== "string" || plaintext === "") return null;
  const key = decodeKey(opts.keyGetter ?? defaultGetKey);
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
 * Static-cause decryption errors — the envelope/token never appears in them
 * (same posture as src/web/auth/tokens.js).
 * @param {string} code
 * @returns {Error}
 */
function decryptFailure(code) {
  const err =
    code === "bridge_token_key_missing"
      ? new Error("bridge webhook token crypto unavailable: BRIDGE_TOKEN_KEY is not configured")
      : new Error("bridge webhook token envelope failed verification");
  err.code = code;
  return err;
}

/**
 * Decrypt a stored envelope back to the token plaintext. Any malformed,
 * tampered, or keyless input throws with a STATIC message.
 *
 * @param {string} envelope
 * @param {{ keyGetter?: () => unknown }} [opts]
 * @returns {string}
 */
function decryptWebhookToken(envelope, opts = {}) {
  const fail = () => {
    throw decryptFailure("bridge_token_envelope_invalid");
  };
  if (typeof envelope !== "string" || envelope === "") fail();

  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) fail();

  const key = decodeKey(opts.keyGetter ?? defaultGetKey);
  if (!key) {
    // Key missing is a distinct condition: callers may surface the §10.2
    // key-missing sentence instead of a generic corruption report.
    throw decryptFailure("bridge_token_key_missing");
  }

  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ciphertext = Buffer.from(parts[3], "base64");
  if (iv.length !== IV_BYTES || tag.length === 0 || ciphertext.length === 0) fail();

  try {
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    fail();
  }
}

module.exports = {
  ENVELOPE_VERSION,
  hasBridgeTokenKey,
  encryptWebhookToken,
  decryptWebhookToken,
};
