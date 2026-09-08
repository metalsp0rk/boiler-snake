/**
 * Web admin console session store (migration 023_web_sessions).
 *
 * The web auth layer owns session-id generation (opaque 32-byte random),
 * sliding/absolute expiry policy, and cookie handling; this repository is
 * pure synchronous data access on the `web_sessions` table. Sliding expiry is
 * expressed by passing a fresh `expiresAt` to `touchWebSession`, which refuses
 * to revive an already-expired row; the absolute 7-day cap is computed by the
 * caller from `created_at` (kept here as the single source of truth).
 *
 * Roadmap: roadmap/web-admin.md §8.3 / §8.5.
 */

const { db, now } = require("../connection");

/**
 * @typedef {object} WebSessionRow
 * @property {string} id opaque session id (cookie value)
 * @property {string} user_id Discord user id
 * @property {string|null} discord_tag display snapshot (not authoritative)
 * @property {number} created_at unix ms (absolute-cap anchor)
 * @property {number} last_seen_at unix ms
 * @property {number} expires_at unix ms (sliding expiry)
 */

/**
 * Insert a new session row (called after a successful OAuth callback, with a
 * freshly generated id — ids are never reused or rotated in place).
 *
 * @param {object} session
 * @param {string} session.id opaque session id
 * @param {string} session.userId Discord user id
 * @param {string|null} [session.discordTag] display snapshot
 * @param {number} session.expiresAt unix ms, computed by the caller
 * @returns {WebSessionRow} the created row
 */
function createWebSession({ id, userId, discordTag = null, expiresAt }) {
  if (!id || typeof id !== "string") {
    throw new TypeError("createWebSession: id is required");
  }
  if (!userId || typeof userId !== "string") {
    throw new TypeError("createWebSession: userId is required");
  }
  if (!Number.isInteger(expiresAt)) {
    throw new TypeError("createWebSession: expiresAt must be an integer unix-ms timestamp");
  }
  const t = now();
  db.prepare(
    `
    INSERT INTO web_sessions (id, user_id, discord_tag, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `
  ).run(id, userId, discordTag, t, t, expiresAt);
  return getWebSession(id);
}

/**
 * Fetch a session by id. Expiry is NOT filtered here — the caller compares
 * `expires_at` to the current time (revocation must be observable, and the
 * auth layer applies the sliding/absolute policy).
 *
 * @param {string} id
 * @returns {WebSessionRow|null}
 */
function getWebSession(id) {
  if (!id) return null;
  return db.prepare(`SELECT * FROM web_sessions WHERE id=?`).get(id) || null;
}

/**
 * Sliding-window touch: bump `last_seen_at` and extend `expires_at`. Refuses
 * to extend (or revive) a session whose `expires_at` has already passed, so
 * an expired session can never slide back to life.
 *
 * @param {string} id
 * @param {number} expiresAt new expiry (unix ms); caller clamps against the
 *   absolute cap derived from the row's `created_at`
 * @param {number} [at] current time override for tests (unix ms)
 * @returns {boolean} true when a live session was touched
 */
function touchWebSession(id, expiresAt, at = now()) {
  if (!id || !Number.isInteger(expiresAt)) return false;
  const result = db
    .prepare(
      `
      UPDATE web_sessions
      SET last_seen_at=?, expires_at=?
      WHERE id=? AND expires_at > ?
    `
    )
    .run(at, expiresAt, id, at);
  return result.changes > 0;
}

/**
 * Delete a session (logout / revocation).
 *
 * @param {string} id
 * @returns {boolean} true when a row was removed
 */
function destroyWebSession(id) {
  if (!id) return false;
  const result = db
    .prepare(`DELETE FROM web_sessions WHERE id=?`)
    .run(id);
  return result.changes > 0;
}

/**
 * Delete all sessions whose `expires_at` has passed (boot sweep + periodic).
 * Uses the prune index on `expires_at` (§8.5).
 *
 * @param {number} [at] cutoff time (unix ms), defaults to now
 * @returns {number} number of rows removed
 */
function pruneWebSessions(at = now()) {
  const result = db
    .prepare(`DELETE FROM web_sessions WHERE expires_at <= ?`)
    .run(at);
  return result.changes;
}

module.exports = {
  createWebSession,
  getWebSession,
  touchWebSession,
  destroyWebSession,
  pruneWebSessions,
};
