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
 * Expired rows the CREATE-path prune deletes at most per call (audit-2026-10
 * #192). createOAuthTransaction is reachable PRE-AUTH (web login start), so
 * this lazy delete bounds unauthenticated table growth even if the scheduled
 * retention sweeper never fires — the gork interaction-log lazy-prune
 * posture, bounded like the sweeper's batches.
 */
const LAZY_EXPIRED_PRUNE_LIMIT = 50;

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

  // Opportunistic expired-row prune (audit-2026-10 #192): this write is
  // reachable PRE-AUTH (web login start), and the only other DELETE
  // (consumeOAuthTransaction) filters unexpired rows — so without this the
  // table grew forever from abandoned logins. A bounded lazy delete on
  // create keeps unauthenticated growth in check even when the scheduled
  // retention sweeper never ran (link-code-sweeper precedent, gork lazy
  // prune shape). Best-effort: one failed prune must NEVER fail the login
  // redirect path; the sweeper job is the backstop.
  try {
    deleteExpiredOAuthTransactions(now(), LAZY_EXPIRED_PRUNE_LIMIT);
  } catch (err) {
    console.error(
      "[db] fluxer_oauth_transactions expired-row lazy prune failed:",
      err?.message || err
    );
  }
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

/**
 * Retention GC (audit-2026-10 #192): delete AT MOST `limit` transactions
 * whose `expires_at` has passed — the row is DEAD the instant it expires
 * (consumeOAuthTransaction only matches `expires_at > at`, so this filter is
 * its exact complement: no gap, no window where a row is both sweeper-safe
 * and callback-live). One bounded batch for the retention sweeper's
 * LIMIT-batched loop; the create path also calls it opportunistically
 * (LAZY_EXPIRED_PRUNE_LIMIT above).
 *
 * @param {number} [at=now()] ms epoch; rows with expires_at <= at die
 * @param {number} [limit=500] max rows deleted by this single batch
 * @returns {number} rows deleted by this batch
 */
function deleteExpiredOAuthTransactions(at = now(), limit = 500) {
  const ts = Number(at);
  if (!Number.isSafeInteger(ts)) {
    throw new TypeError(
      `deleteExpiredOAuthTransactions: at must be an integer ms epoch, got ${String(at)}`
    );
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError(
      `deleteExpiredOAuthTransactions: limit must be a positive integer, got ${String(limit)}`
    );
  }
  return db
    .prepare(`DELETE FROM fluxer_oauth_transactions WHERE expires_at <= ? LIMIT ?`)
    .run(ts, limit).changes;
}

module.exports = {
  createOAuthTransaction,
  consumeOAuthTransaction,
  deleteExpiredOAuthTransactions,
};
