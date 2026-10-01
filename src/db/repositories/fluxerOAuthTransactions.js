/**
 * Fluxer web-login OAuth transaction store (roadmap/fluxer.md § PKCE and
 * state; table created by migration 034_communities).
 *
 * One row per in-flight Fluxer login: the PKCE code_verifier is persisted
 * HERE — never in the in-memory `usedNonces` map (the signed state carries
 * only the nonce that keys this row, so the verifier survives a process
 * restart while the state blob stays valid).
 *
 * Single use is enforced HERE, atomically: `consumeOAuthTransaction` is a
 * DELETE…RETURNING filtered on expiry, so a replayed callback gets zero
 * rows, and a failed exchange cannot be retried with the same code (the
 * delete runs before the exchange — spec § PKCE and state).
 *
 * Pure synchronous data access on the `fluxer_oauth_transactions` table
 * (repo doctrine, same as webSessions.js): no policy, no logging of verifier
 * material — the verifier is treated like a secret.
 */

const { db, now } = require("../connection");

/** Nonce shape: 32-hex, exactly what createOAuthState mints/validates. */
const NONCE_RE = /^[0-9a-f]{32}$/;

/**
 * Insert (or replace, keyed by nonce) a pending login transaction.
 * Called by the login start BEFORE the 302 to the authorize URL.
 *
 * @param {object} tx
 * @param {string} tx.nonce 32-hex nonce carried inside the signed state
 * @param {string} tx.codeVerifier PKCE code_verifier (43-char base64url)
 * @param {string} tx.instanceKey normalized Fluxer instance key
 * @param {number} tx.expiresAt unix ms — min(state exp, now + 10 min)
 * @returns {true}
 */
function createOAuthTransaction({ nonce, codeVerifier, instanceKey, expiresAt }) {
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
    throw new TypeError("createOAuthTransaction: nonce must be a 32-char hex string");
  }
  if (typeof codeVerifier !== "string" || codeVerifier === "") {
    throw new TypeError("createOAuthTransaction: codeVerifier is required");
  }
  if (typeof instanceKey !== "string" || instanceKey === "") {
    throw new TypeError("createOAuthTransaction: instanceKey is required");
  }
  if (!Number.isInteger(expiresAt)) {
    throw new TypeError(
      "createOAuthTransaction: expiresAt must be an integer unix-ms timestamp"
    );
  }
  // INSERT OR REPLACE: a reused nonce (astronomically unlikely from
  // randomBytes(16).hex, cheap to be safe about) re-binds the row to the
  // newest login attempt instead of throwing mid-redirect.
  db.prepare(
    `
    INSERT OR REPLACE INTO fluxer_oauth_transactions
      (nonce, code_verifier, instance_key, expires_at)
    VALUES (?, ?, ?, ?)
  `
  ).run(nonce, codeVerifier, instanceKey, expiresAt);
  return true;
}

/**
 * Atomically consume a live (unexpired) transaction: DELETE…RETURNING runs
 * the single-use check and the verifier hand-off in ONE statement, so two
 * racing callbacks can never both receive a verifier.
 *
 * @param {string} nonce the nonce verified inside the signed state
 * @param {number} [at] current time (unix ms) for the expiry filter
 * @returns {{ codeVerifier: string, instanceKey: string }|null} the bound
 *   verifier + instance, or null when no live row existed (unknown, replayed,
 *   or expired nonce).
 */
function consumeOAuthTransaction(nonce, at = now()) {
  if (typeof nonce !== "string" || nonce === "") return null;
  const row = db
    .prepare(
      `
      DELETE FROM fluxer_oauth_transactions
      WHERE nonce = ? AND expires_at > ?
      RETURNING code_verifier AS codeVerifier, instance_key AS instanceKey
    `
    )
    .get(nonce, at);
  return row || null;
}

module.exports = {
  createOAuthTransaction,
  consumeOAuthTransaction,
};
