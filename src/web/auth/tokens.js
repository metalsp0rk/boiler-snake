/**
 * Server-side encryption of the per-session Discord ACCESS TOKEN
 * (roadmap/web-admin.md §8.7, §8.1-9; Discord OAuth docs "Token storage":
 * access tokens must be stored "securely and in an encrypted manner").
 *
 * Format (versioned envelope, dot-separated, all parts base64):
 *   v1.<iv_b64>.<authTag_b64>.<ciphertext_b64>
 *
 *  - AES-256-GCM; 12-byte random IV per record; the GCM auth tag gives
 *    integrity (tampered envelopes fail decryption, never return junk);
 *  - the key is HKDF-SHA256-derived from the RESOLVED session secret
 *    (web/config.js getSessionSecret — SESSION_SECRET, CLIENT_SECRET
 *    fallback) with a fixed info/salt: deterministic across restarts so
 *    stored ATs stay decryptable, but never equal to the raw secret, and
 *    cryptographically domain-separated from state/cookie signing;
 *  - rotating SESSION_SECRET silently invalidates stored ATs (decryption
 *    then fails → the session simply forces re-login; acceptable by design);
 *  - token material NEVER appears in logs, error messages, or exports.
 *    Errors here are always static strings.
 */

const crypto = require("crypto");
const { getSessionSecret } = require("../config");

const ENVELOPE_VERSION = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const HKDF_KEY_LEN = 32;
// Fixed KDF context (public constants — NOT secrets). Changing either
// invalidates every stored envelope (they then fail to decrypt → re-login).
const HKDF_SALT = "boiler-snake/web-session-at-v1";
const HKDF_INFO = "discord-access-token";

/**
 * Derive the 32-byte AT encryption key from the resolved session secret.
 * @param {string} secret
 * @returns {Buffer}
 */
function deriveTokenKey(secret) {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.from(HKDF_SALT, "utf8"),
      Buffer.from(HKDF_INFO, "utf8"),
      HKDF_KEY_LEN
    )
  );
}

/**
 * @returns {Error} error whose message NEVER contains key/token material
 */
function secretMissingError() {
  const err = new Error(
    "web session token crypto unavailable: SESSION_SECRET (or CLIENT_SECRET) not configured"
  );
  err.code = "web_token_secret_missing";
  return err;
}

/**
 * Encrypt a plaintext access token into the `v1.…` envelope.
 * @param {string} plaintext
 * @returns {string} envelope (iv + tag + ciphertext, base64 parts)
 */
function encryptAccessToken(plaintext) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new TypeError("encryptAccessToken: plaintext must be a non-empty string");
  }
  const secret = getSessionSecret();
  if (!secret) throw secretMissingError();

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, deriveTokenKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/**
 * Decrypt a stored envelope back to the access token plaintext. Any
 * malformed / tampered / foreign-secret input throws with a STATIC message
 * (never the offending value).
 * @param {string} envelope
 * @returns {string} plaintext access token
 */
function decryptAccessToken(envelope) {
  const decryptError = () => {
    const err = new Error("web session token envelope failed verification");
    err.code = "web_token_envelope_invalid";
    return err;
  };
  if (typeof envelope !== "string" || !envelope) throw decryptError();

  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw decryptError();
  }
  const secret = getSessionSecret();
  if (!secret) throw secretMissingError();

  const [, ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");
  if (iv.length !== IV_BYTES || tag.length === 0 || ciphertext.length === 0) {
    throw decryptError();
  }

  try {
    const decipher = crypto.createDecipheriv(ALGO, deriveTokenKey(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
      // GCM auth failure or corrupt base64 — same static error either way.
      throw decryptError();
  }
}

module.exports = {
  ENVELOPE_VERSION,
  encryptAccessToken,
  decryptAccessToken,
};
