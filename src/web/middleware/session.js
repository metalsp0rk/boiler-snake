/**
 * Cookie → session row → request identity (roadmap/web-admin.md §8.2/§8.3).
 *
 * Resolves the opaque session cookie via auth/sessions.js and attaches:
 *  - req.webSession — normalized live session (camelCase) or null (anon);
 *  - req.user       — { userId, discordTag } or null.
 *
 * NEVER writes the response: login/logout (subtask 06) own Set-Cookie; this
 * middleware cannot perturb the Phase 0a byte-parity surface — anonymous
 * requests do zero DB work and identical bytes flow through.
 *
 * Hardening (§8.7): malformed / tampered / expired / oversized cookie values
 * all resolve to anonymous; the oversized gate runs before any lookup; a
 * lookup failure fails CLOSED (anonymous) and is logged without values.
 *
 * Sliding bumps are throttled (TOUCH_MIN_INTERVAL_MS) so a busy page never
 * hammer-writes the SQLite file shared with the bot process.
 */

const {
  SESSION_COOKIE_NAME,
  MAX_SESSION_COOKIE_VALUE_LENGTH,
  TOUCH_MIN_INTERVAL_MS,
  getSession,
  touchSession,
  shouldTouch,
} = require("../auth/sessions");

/**
 * Extract the session cookie value from the raw `Cookie` header. One fixed
 * opaque name with a hex value — no external cookie parser needed, and
 * nothing to un-escape. Missing/malformed/oversized → null so garbage never
 * reaches the DB (the auth layer re-gates the id shape itself).
 *
 * @param {string|string[]|undefined} header req.headers.cookie
 * @param {string} [cookieName]
 * @returns {string|null}
 */
function parseSessionCookie(header, cookieName = SESSION_COOKIE_NAME) {
  // Node joins duplicate Cookie headers into one string; an array here would
  // mean a non-node transport — treat it as absent rather than guessing.
  if (typeof header !== "string" || header.length === 0) return null;

  const prefix = `${cookieName}=`;
  for (const pair of header.split(";")) {
    const token = pair.trim();
    if (!token.startsWith(prefix)) continue;
    const value = token.slice(prefix.length);
    if (!value || value.length > MAX_SESSION_COOKIE_VALUE_LENGTH) return null;
    return value;
  }
  return null;
}

/**
 * Session middleware factory (pure: all dependencies injectable).
 *
 * @param {object} [options]
 * @param {string} [options.cookieName] override cookie name (tests)
 * @param {() => number} [options.now] clock override (tests)
 * @param {number} [options.touchIntervalMs] sliding-bump throttle (tests)
 * @param {{
 *   getSession: Function,
 *   touchSession: Function,
 *   shouldTouch: Function,
 * }} [options.sessions] session API override (tests / stubs)
 * @returns {(req: import("http").IncomingMessage & {
 *   webSession?: import("../auth/sessions").WebSession | null,
 *   user?: { userId: string, discordTag: string|null } | null,
 * }, res: import("http").ServerResponse, next: () => void) => void}
 */
function createSessionMiddleware(options = {}) {
  const cookieName = options.cookieName || SESSION_COOKIE_NAME;
  const now = options.now || Date.now;
  const minTouchIntervalMs = options.touchIntervalMs ?? TOUCH_MIN_INTERVAL_MS;
  const sessions = options.sessions || { getSession, touchSession, shouldTouch };

  return function sessionMiddleware(req, res, next) {
    req.webSession = null;
    req.user = null;

    const id = parseSessionCookie(req.headers && req.headers.cookie, cookieName);
    if (!id) return next();

    let session = null;
    try {
      const at = now();
      session = sessions.getSession(id, at);
      if (session && sessions.shouldTouch(session, at, minTouchIntervalMs)) {
        session = sessions.touchSession(session, at) || session;
      }
    } catch (err) {
      // Fail closed: a broken lookup must never authenticate a request, and
      // must not crash the handler chain either.
      console.warn("[web] session lookup failed:", err?.message || err);
      req.webSession = null;
      req.user = null;
      return next();
    }

    if (session) {
      req.webSession = session;
      req.user = { userId: session.userId, discordTag: session.discordTag };
    }
    return next();
  };
}

module.exports = {
  createSessionMiddleware,
  parseSessionCookie,
};
