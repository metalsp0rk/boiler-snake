/**
 * AES-256-GCM envelope for relay webhook tokens (roadmap/bridge.md §10.13,
 * §10.7 step 3): `bridge_ends.webhook_token_enc` stores ONLY the envelope
 * string, never the plaintext token.
 *
 * Thin binding of the generic envelope core (src/core/tokenCrypto.js, audit
 * C6 extraction) to the BRIDGE key domain: BRIDGE_TOKEN_KEY, 32 bytes of
 * base64, .env only (the bridge key is used directly, per spec §10.13 —
 * unlike the web-session key which is HKDF-derived from SESSION_SECRET).
 * Key rotation is out of v1: rotating strands existing rows; staff disconnect
 * and reconnect.
 *
 * Key access is an INJECTABLE getter (default `process.env.BRIDGE_TOKEN_KEY`)
 * so unit tests supply a key without touching the environment.
 *
 * Key hygiene (AGENTS.md): no error string here ever contains key material,
 * the envelope, or the plaintext token. Encrypt returns `null` — NOT a throw —
 * when the key is missing/invalid, which is how the service maps the missing
 * key to the §10.2 key-missing sentence.
 */

const core = require("../../core/tokenCrypto");

const api = core.createEnvelopeCrypto({
  envVarName: "BRIDGE_TOKEN_KEY",
  codePrefix: "bridge_token",
  label: "bridge webhook token",
});

/**
 * True when BRIDGE_TOKEN_KEY (32 bytes, base64) is configured. Connect checks
 * this BEFORE any webhook create (spec §10.7 step 3).
 *
 * @param {{ keyGetter?: () => unknown }} [opts]
 * @returns {boolean}
 */
function hasBridgeTokenKey(opts = {}) {
  return api.hasKey(opts);
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
  return api.encrypt(plaintext, opts);
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
  return api.decrypt(envelope, opts);
}

module.exports = {
  ENVELOPE_VERSION: core.ENVELOPE_VERSION,
  hasBridgeTokenKey,
  encryptWebhookToken,
  decryptWebhookToken,
};
