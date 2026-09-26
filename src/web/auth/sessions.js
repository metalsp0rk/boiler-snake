/**
 * Web session lifecycle (roadmap/web-admin.md §8.3) — the POLICY layer on top
 * of the web_sessions repository (src/db/repositories/webSessions.js, which
 * stays pure synchronous data access).
 *
 * Owns here:
 *  - opaque 32-byte session ids (crypto-random lowercase hex);
 *  - sliding expiry `min(now + WEB_SESSION_TTL_HOURS, created_at + 7 d)` —
 *    the absolute cap anchors on the row's created_at so a touch can never
 *    extend total lifetime past 7 days;
 *  - id rotation on login (new id, old id destroyed — never rotated in
 *    place, so a stolen cookie cannot outlive a login);
 *  - destroy on logout; boot sweep + periodic prune job;
 *  - cookie policy for subtasks 06/07: the Set-Cookie value carries the
 *    OPAQUE ID ONLY (no user data), with HttpOnly + SameSite=Lax +
 *    Secure-iff-https base URL and Max-Age mirroring the sliding TTL.
 *
 * Cookie PARSING lives in middleware/session.js; this module never touches
 * the response.
 */

const crypto = require("crypto");
const {
  createWebSession,
  getWebSession,
  touchWebSession,
  destroyWebSession,
  pruneWebSessions,
} = require("../../db");
// Administration helpers below call the facade through this MODULE OBJECT
// (property access at CALL time, not a top-level destructure) so test/gate
// recorders installed on the shared src/db facade are the functions the
// handlers actually run — same recorder doctrine as routes/ticketActions.js.
const dbFacade = require("../../db");
const { getSessionTtlMs, isSecureBaseUrl } = require("../config");

const SESSION_COOKIE_NAME = "web_session";
const SESSION_ID_BYTES = 32;
/** Generated ids are lowercase hex of SESSION_ID_BYTES (64 chars). */
const SESSION_ID_RE = /^[0-9a-f]{64}$/;
/** Cookie values longer than this are rejected before any DB work (§8.7). */
const MAX_SESSION_COOKIE_VALUE_LENGTH = 512;
/** §8.3 absolute cap: a session never lives past created_at + 7 days. */
const ABSOLUTE_CAP_MS = 7 * 24 * 60 * 60 * 1000;
/** Sliding-bump throttle: middleware writes at most once per this window. */
const TOUCH_MIN_INTERVAL_MS = 60_000;
/** Periodic prune cadence beside the boot sweep. */
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * @typedef {object} WebSession
 * @property {string} id opaque id (cookie value)
 * @property {string} userId Discord user id
 * @property {string|null} discordTag display snapshot (not authoritative)
 * @property {number} createdAt unix ms — absolute-cap anchor
 * @property {number} lastSeenAt unix ms
 * @property {number} expiresAt unix ms (sliding expiry)
 */

/**
 * Generate a fresh opaque session id (32 random bytes → 64 hex chars).
 * @returns {string}
 */
function newSessionId() {
  return crypto.randomBytes(SESSION_ID_BYTES).toString("hex");
}

/**
 * Shape gate for session ids: rejects garbage/tampered/uppercase values
 * cheaply, before they ever hit the database.
 * @param {unknown} value
 * @returns {boolean}
 */
function isSessionId(value) {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

/**
 * Normalize a snake_case repo row to the camelCase web-layer shape.
 * @param {import("../../db/repositories/webSessions").WebSessionRow} row
 * @returns {WebSession}
 */
function toSession(row) {
  return {
    id: row.id,
    userId: row.user_id,
    discordTag: row.discord_tag ?? null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Sliding expiry clamped by the absolute cap: min(now + TTL, created + 7d).
 * @param {number} createdAt row creation time (unix ms)
 * @param {number} now current time (unix ms)
 * @returns {number} new expires_at (unix ms)
 */
function computeExpiry(createdAt, now) {
  return Math.min(now + getSessionTtlMs(), createdAt + ABSOLUTE_CAP_MS);
}

/**
 * Create a live session for a user (login calls this via rotateSession).
 * @param {object} user
 * @param {string} user.userId Discord user id
 * @param {string|null} [user.discordTag] display snapshot
 * @param {number} [now]
 * @returns {WebSession}
 */
function createSession({ userId, discordTag = null }, now = Date.now()) {
  // Repo validates userId/expiresAt; created_at ≈ now anchors the cap.
  const row = createWebSession({
    id: newSessionId(),
    userId,
    discordTag,
    expiresAt: computeExpiry(now, now),
  });
  return toSession(row);
}

/**
 * Resolve a session id to a LIVE session. Missing, shape-invalid, and
 * expired ids all resolve to null — an expired row is indistinguishable
 * from a destroyed one to callers (idle expiry, §8.3).
 * @param {string|null} id cookie value
 * @param {number} [now]
 * @returns {WebSession|null}
 */
function getSession(id, now = Date.now()) {
  if (!isSessionId(id)) return null;
  const row = getWebSession(id);
  if (!row || row.expires_at <= now) return null;
  return toSession(row);
}

/**
 * Pure throttle predicate for the sliding bump (middleware calls this so the
 * DB write happens at most once per minIntervalMs per session).
 * @param {WebSession|null} session
 * @param {number} [now]
 * @param {number} [minIntervalMs]
 * @returns {boolean}
 */
function shouldTouch(session, now = Date.now(), minIntervalMs = TOUCH_MIN_INTERVAL_MS) {
  return !!session && now - session.lastSeenAt >= minIntervalMs;
}

/**
 * Sliding touch with the cap applied: extends expiry to
 * min(now + TTL, createdAt + 7d) and stamps last_seen_at. Returns the new
 * session snapshot (never mutates the argument), or null when the row is
 * gone/expired — the repo refuses to revive expired rows.
 * @param {WebSession} session
 * @param {number} [now]
 * @returns {WebSession|null}
 */
function touchSession(session, now = Date.now()) {
  if (!session) return null;
  const expiresAt = computeExpiry(session.createdAt, now);
  const bumped = touchWebSession(session.id, expiresAt, now);
  if (!bumped) return null;
  return { ...session, lastSeenAt: now, expiresAt };
}

/**
 * Destroy a session row (logout / revocation).
 * @param {string|null} id
 * @returns {boolean} true when a row was removed
 */
function destroySession(id) {
  return destroyWebSession(id);
}

/**
 * Rotate the session id on login (§8.3): create a fresh row for the user,
 * then destroy the old id — never rotate in place. Pass null when the
 * browser sent no (valid) old session; passing an old id that is already
 * gone is fine.
 * @param {WebSession|string|null} [oldSessionOrId]
 * @param {{ userId: string, discordTag?: string|null }} user
 * @param {number} [now]
 * @returns {WebSession} the new live session
 */
function rotateSession(oldSessionOrId, user = {}, now = Date.now()) {
  const created = createSession(user, now);
  const oldId =
    typeof oldSessionOrId === "string" ? oldSessionOrId : oldSessionOrId?.id;
  if (oldId && oldId !== created.id) destroySession(oldId);
  return created;
}

/**
 * Delete all sessions past their sliding expiry (boot sweep + periodic).
 * @param {number} [now] cutoff
 * @returns {number} rows removed
 */
function pruneExpiredSessions(now = Date.now()) {
  return pruneWebSessions(now);
}

// ---------------------------------------------------------------------------
// Session ADMINISTRATION (Phase 4: self-service "Your sessions" + admin
// session control). Policy layer only — audit + response shaping belong to
// the routes; this module never touches req/res (§8.2 layering).
// ---------------------------------------------------------------------------

/**
 * One user's LIVE sessions (newest activity first, bounded by
 * MAX_SESSION_LIST_LIMIT at the repo). Rows past their sliding expiry are
 * filtered HERE (the policy layer owns the live/expired decision): the
 * console never presents a dead session as revocable, and "already revoked
 * or expired" stays the single honest answer for both states.
 * @param {string} userId
 * @param {number} [now]
 * @param {{ limit?: number }} [opts]
 * @returns {WebSession[]}
 */
function listLiveSessionsForUser(userId, now = Date.now(), opts = {}) {
  if (!userId) return [];
  return dbFacade
    .listWebSessionsByUser(String(userId), opts)
    .map(toSession)
    .filter((s) => s.expiresAt > now);
}

/**
 * EVERY live session in the store (system-wide — web_sessions carries no
 * guild column, and no per-guild list is faked), bounded + policy-filtered
 * exactly like listLiveSessionsForUser.
 * @param {number} [now]
 * @param {{ limit?: number }} [opts]
 * @returns {WebSession[]}
 */
function listLiveSessions(now = Date.now(), opts = {}) {
  return dbFacade
    .listAllWebSessions(opts)
    .map(toSession)
    .filter((s) => s.expiresAt > now);
}

/**
 * Revoke one session by id. Honest outcome, never a silent success: deleting
 * an already-gone row answers `{ ok: false }` so the caller can report the
 * known state instead of claiming a revocation that did not happen.
 * @param {string} id
 * @returns {{ ok: true, session: WebSession } | { ok: false }}
 */
function revokeSessionById(id) {
  const row = dbFacade.deleteWebSessionById(id);
  if (!row) return { ok: false };
  return { ok: true, session: toSession(row) };
}

/**
 * Resolve a session from a list by its NON-SECRET selector (created_at):
 * the browser never learns or carries a session id — the console lists
 * timestamps, and the revoke form names the row by (owner, created_at).
 * On a created_at collision the CURRENT row wins (deterministic, and the
 * current session is the one a user means by "this device").
 * @param {WebSession[]} sessions already-listed live sessions to search
 * @param {number} createdAt selector (unix ms)
 * @param {WebSession|null} [currentSession] the caller's own live session
 * @returns {WebSession|null}
 */
function pickSessionByCreatedAt(sessions, createdAt, currentSession = null) {
  if (!Number.isInteger(createdAt)) return null;
  if (
    currentSession &&
    currentSession.createdAt === createdAt &&
    sessions.some((s) => s.id === currentSession.id)
  ) {
    return currentSession;
  }
  return sessions.find((s) => s.createdAt === createdAt) || null;
}

/** @type {NodeJS.Timeout|null} */
let pruneTimer = null;

/**
 * Session prune job (§8.3 "prune job on boot"): one immediate sweep plus an
 * unref'd periodic sweep so the timer never keeps the process (or tests)
 * alive. Idempotent for the timer; safe to call on every server start. A DB
 * hiccup is logged, never allowed to crash boot.
 * @param {{ intervalMs?: number }} [options]
 */
function startSessionPruneJob({ intervalMs = DEFAULT_PRUNE_INTERVAL_MS } = {}) {
  try {
    pruneExpiredSessions();
  } catch (err) {
    console.warn("[web] session prune failed:", err?.message || err);
  }
  if (pruneTimer) return;
  pruneTimer = setInterval(() => {
    try {
      pruneExpiredSessions();
    } catch (err) {
      console.warn("[web] session prune failed:", err?.message || err);
    }
  }, intervalMs);
  pruneTimer.unref?.();
}

/** Stop the periodic prune sweep (tests / shutdown). */
function stopSessionPruneJob() {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Cookie serialization (policy shared by login/logout routes, subtasks 06/07)
// ---------------------------------------------------------------------------

/**
 * Max-Age seconds mirroring the sliding TTL (cookie lifetime tracks the
 * idle window; the DB rows enforce the rest).
 * @returns {number}
 */
function sessionCookieMaxAgeSec() {
  return Math.floor(getSessionTtlMs() / 1000);
}

/**
 * Serialize the Set-Cookie value. Attribute order is fixed; the value is
 * always the opaque id (or empty when clearing) — NEVER user data (§8.7).
 * @param {string} id session id ("" to clear)
 * @param {{ secure: boolean, maxAgeSec: number }} attrs
 * @returns {string}
 */
function serializeSessionCookie(id, { secure, maxAgeSec }) {
  const attrs = ["Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) attrs.push("Secure");
  attrs.push(`Max-Age=${maxAgeSec}`);
  return `${SESSION_COOKIE_NAME}=${id}; ${attrs.join("; ")}`;
}

/**
 * Set-Cookie value for a live session: opaque id, HttpOnly, SameSite=Lax,
 * Secure iff the resolved base URL is https, Max-Age = sliding TTL (§8.3).
 * @param {string} id
 * @returns {string}
 */
function buildSessionCookie(id) {
  if (!isSessionId(id)) {
    throw new TypeError("buildSessionCookie: invalid session id");
  }
  return serializeSessionCookie(id, {
    secure: isSecureBaseUrl(),
    maxAgeSec: sessionCookieMaxAgeSec(),
  });
}

/**
 * Set-Cookie value that clears the browser's copy on logout (empty value,
 * Max-Age=0; attribute set mirrors buildSessionCookie so the browser
 * replaces the original cookie).
 * @returns {string}
 */
function buildClearSessionCookie() {
  return serializeSessionCookie("", {
    secure: isSecureBaseUrl(),
    maxAgeSec: 0,
  });
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_ID_BYTES,
  MAX_SESSION_COOKIE_VALUE_LENGTH,
  ABSOLUTE_CAP_MS,
  TOUCH_MIN_INTERVAL_MS,
  DEFAULT_PRUNE_INTERVAL_MS,
  newSessionId,
  isSessionId,
  toSession,
  computeExpiry,
  createSession,
  getSession,
  shouldTouch,
  touchSession,
  rotateSession,
  destroySession,
  pruneExpiredSessions,
  MAX_SESSION_LIST_LIMIT: dbFacade.MAX_SESSION_LIST_LIMIT,
  listLiveSessionsForUser,
  listLiveSessions,
  revokeSessionById,
  pickSessionByCreatedAt,
  startSessionPruneJob,
  stopSessionPruneJob,
  sessionCookieMaxAgeSec,
  buildSessionCookie,
  buildClearSessionCookie,
};
