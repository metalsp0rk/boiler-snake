/**
 * AES-256-GCM envelope for relay webhook tokens (roadmap/bridge.md §10.13,
 * §10.7 step 3): `bridge_ends.webhook_token_enc` stores ONLY the envelope
 * string, never the plaintext token.
 *
 * Thin binding of the generic envelope core (src/core/tokenCrypto.js, audit
 * C6 extraction) to the BRIDGE key domain: BRIDGE_TOKEN_KEY, 32 bytes of
 * base64, .env only (the bridge key is used directly, per spec §10.13 —
 * unlike the web-session key which is HKDF-derived from SESSION_SECRET).
 * ROTATION (#281): BRIDGE_TOKEN_KEY is the CURRENT (write) key;
 * BRIDGE_TOKEN_KEY_RETIRED keeps previous keys readable (comma-separated)
 * while relay reads re-seal webhook envelopes forward on use
 * (needsBridgeTokenReencrypt). Pre-#281 posture for the record: rotation
 * was out of v1 (rotating strands existing rows; staff disconnect and
 * reconnect) — that remains the fallback if the old key is already lost.
 *
 * Key access is an INJECTABLE getter (default `process.env.BRIDGE_TOKEN_KEY`)
 * so unit tests supply a key without touching the environment. Retired keys
 * read `process.env.BRIDGE_TOKEN_KEY_RETIRED` the same way unless a
 * per-call `retiredGetter` is injected.
 *
 * Key hygiene (AGENTS.md): no error string here ever contains key material,
 * the envelope, or the plaintext token. Encrypt returns `null` — NOT a throw —
 * when the key is missing/invalid, which is how the service maps the missing
 * key to the §10.2 key-missing sentence.
 */

const core = require("../../core/tokenCrypto");

const KEY_ENV = "BRIDGE_TOKEN_KEY";
const KEY_RETIRED_ENV = "BRIDGE_TOKEN_KEY_RETIRED";

const api = core.createEnvelopeCrypto({
  envVarName: KEY_ENV,
  envVarNameRetired: KEY_RETIRED_ENV,
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
 * Encrypt a plaintext webhook token into the `v2.…` envelope with the
 * CURRENT key. Returns `null` (never throws) when the key is missing/
 * invalid — expected failures are values, not exceptions (AGENTS.md rule 6).
 *
 * @param {string} plaintext
 * @param {{ keyGetter?: () => unknown }} [opts]
 * @returns {string|null} envelope, or null when no usable key
 */
function encryptWebhookToken(plaintext, opts = {}) {
  return api.encrypt(plaintext, opts);
}

/**
 * Decrypt a stored envelope (v1 or v2) back to the token plaintext. Any
 * malformed, tampered, unknown-keyid, or keyless input throws with a
 * STATIC message.
 *
 * @param {string} envelope
 * @param {{ keyGetter?: () => unknown, retiredGetter?: () => unknown }} [opts]
 * @returns {string}
 */
function decryptWebhookToken(envelope, opts = {}) {
  return api.decrypt(envelope, opts);
}

/**
 * Lazy forward-migration signal (#281): does this stored envelope need a
 * re-seal with the CURRENT BRIDGE_TOKEN_KEY? The relay outbound ports
 * re-seal via repo.setBridgeEndWebhook exactly when this says true.
 *
 * @param {string} envelope
 * @param {{ keyGetter?: () => unknown }} [opts]
 * @returns {boolean}
 */
function needsBridgeTokenReencrypt(envelope, opts = {}) {
  return api.needsReencrypt(envelope, opts);
}

module.exports = {
  KEY_ENV,
  KEY_RETIRED_ENV,
  ENVELOPE_VERSION: core.ENVELOPE_VERSION,
  ENVELOPE_V2_PREFIX: core.ENVELOPE_V2_PREFIX,
  hasBridgeTokenKey,
  encryptWebhookToken,
  decryptWebhookToken,
  needsBridgeTokenReencrypt,
};
