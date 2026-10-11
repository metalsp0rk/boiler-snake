/**
 * At-rest encryption for THIRD-PARTY credential material (audit-2026-10 C6,
 * issue #189): the `guild_command_permission_oauth.refresh_token` /
 * `.access_token` columns (Discord user OAuth tokens) and the
 * `github_watches.token` column (GitHub PATs).
 *
 * Policy: these strictly third-party revocable credentials get the SAME
 * AES-256-GCM envelope the codebase already applies to bridge relay webhook
 * tokens — `v1.<iv>.<tag>.<ciphertext>` via src/core/tokenCrypto.js. Rows
 * hold ONLY the envelope; plaintext exists transiently in process memory.
 *
 * Key domain: TOKEN_ENCRYPTION_KEY (32 bytes of base64, .env only, e.g.
 * `openssl rand -base64 32`), deliberately SEPARATE from BRIDGE_TOKEN_KEY
 * and SESSION_SECRET so rotating one store's key never strands another's.
 * This module covers BOTH token tables with one key (they share the
 * "operator-provided third-party credential" trust domain and lifecycle).
 * No key rotation in v1 — same posture as the bridge key: rotating strands
 * existing rows (re-authorize / re-add watches).
 *
 * Migration 039 re-encrypts pre-existing plaintext rows at boot and FAILS
 * LOUD (boot dies) when the key is absent while token material exists —
 * the bot never runs with mixed plaintext/ciphertext columns.
 *
 * Key hygiene (AGENTS.md): error strings NEVER contain key material, the
 * envelope, or the plaintext. Encrypt returns `null` on missing/invalid key;
 * repository callers turn that into a specific, actionable error naming the
 * env var (below). Decrypt throws with a static message and stable codes
 * `third_party_token_key_missing` / `third_party_token_envelope_invalid`.
 */

const core = require("./tokenCrypto");

const KEY_ENV = "TOKEN_ENCRYPTION_KEY";

const api = core.createEnvelopeCrypto({
  envVarName: KEY_ENV,
  codePrefix: "third_party_token",
  label: "third-party token",
});

/**
 * True when TOKEN_ENCRYPTION_KEY (32 bytes of base64) is configured and
 * usable. Command handlers pre-check this so a missing key never costs a
 * wasted GitHub API call or Discord OAuth code burn.
 *
 * @param {{ keyGetter?: () => unknown }} [opts]
 * @returns {boolean}
 */
function hasTokenKey(opts = {}) {
  return api.hasKey(opts);
}

/**
 * Encrypt a third-party credential into the `v1.…` envelope.
 * @param {string} plaintext
 * @param {{ keyGetter?: () => unknown }} [opts]
 * @returns {string|null} envelope, or null when no usable key
 */
function encryptToken(plaintext, opts = {}) {
  return api.encrypt(plaintext, opts);
}

/**
 * Decrypt a stored envelope back to the credential plaintext. Malformed,
 * tampered, foreign-key, or keyless input throws (static message,
 * `third_party_token_*` code).
 *
 * @param {string} envelope
 * @param {{ keyGetter?: () => unknown }} [opts]
 * @returns {string}
 */
function decryptToken(envelope, opts = {}) {
  return api.decrypt(envelope, opts);
}

/**
 * The actionable, user-facing cause for a missing/invalid key at a WRITE
 * site (AGENTS.md rule 3: the reply must be actionable, never generic).
 * Mirrors the bridge docs' key-missing sentence shape.
 *
 * @param {string} noun what could not be stored, e.g. "the GitHub token"
 * @returns {Error} code `third_party_token_key_missing`
 */
function keyMissingError(noun) {
  const err = new Error(
    `Cannot store ${noun}: ${KEY_ENV} (32 bytes of base64, e.g. ` +
      `"openssl rand -base64 32") is not configured. Tokens are never stored ` +
      `in plaintext — set it in .env and restart, then retry.`
  );
  err.code = "third_party_token_key_missing";
  return err;
}

module.exports = {
  KEY_ENV,
  ENVELOPE_VERSION: core.ENVELOPE_VERSION,
  ENVELOPE_PREFIX: core.ENVELOPE_PREFIX,
  looksLikeEnvelope: core.looksLikeEnvelope,
  hasTokenKey,
  encryptToken,
  decryptToken,
  keyMissingError,
};
