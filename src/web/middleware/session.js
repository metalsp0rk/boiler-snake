/**
 * Cookie → session row → request identity (roadmap/web-admin.md §8.2/§8.3).
 *
 * Resolves the opaque session cookies via auth/sessions.js and attaches:
 *  - req.discordSession / req.fluxerSession — normalized live session rows
 *    (camelCase) per cookie, null when absent/expired (Fluxer PR 10, K11:
 *    two cookies, `web_session` and `web_session_fx`, each validated against
 *    the ROW's platform — a fluxer id in the Discord cookie and vice versa
 *    is DROPPED with a warn, never honored);
 *  - req.webSession — the Discord session (today's semantics: every Discord-
 *    scoped surface, /, login buttons, keeps reading this). Under /g/:cid,
 *    guildScope re-points it at the community-matched session (PR 10).
 *  - req.user       — { userId, discordTag } from req.webSession or null.
 *
 * Response writes: EXACTLY ONE kind — the renewal of a touched identity's
 * OWN cookie (#401/C1-1). Login/logout (subtask 06 + PR 10) still own
 * issuance and clearing; here a session whose row just slid re-declares its
 * remaining life via Set-Cookie so the browser stops deleting a live cookie
 * at login_time + TTL (§8.3 sliding expiry was unreachable client-side).
 * A renewal rides ONLY when the touch fires (throttled below), the identity
 * matched its slot, and the row is genuinely alive — anonymous and untou-
 * ched requests stay byte-for-byte the Phase 0a parity surface. A later
 * logout response REPLACES the renewal with the clear cookie (setHeader
 * semantics), so logout can never be poisoned by an earlier renewal.
 *
 * Hardening (§8.7): malformed / tampered / expired / oversized cookie values
 * all resolve to anonymous; the oversized gate runs before any lookup; a
 * lookup failure fails CLOSED (anonymous) and is logged without values.
 *
 * Sliding bumps are throttled (TOUCH_MIN_INTERVAL_MS) so a busy page never
 * hammer-writes the SQLite file shared with the bot process. Each cookie's
 * session is touched under its OWN gate — and so is its renewal.
 */

const {
  SESSION_COOKIE_NAME,
  FLUXER_SESSION_COOKIE_NAME,
  MAX_SESSION_COOKIE_VALUE_LENGTH,
  TOUCH_MIN_INTERVAL_MS,
  getSession,
  touchSession,
  shouldTouch,
  renewSessionCookie,
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
 * @param {string} [options.fxCookieName] override Fluxer cookie name (tests)
 * @param {() => number} [options.now] clock override (tests)
 * @param {number} [options.touchIntervalMs] sliding-bump throttle (tests)
 * @param {{
 *   getSession: Function,
 *   touchSession: Function,
 *   shouldTouch: Function,
 * }} [options.sessions] session API override (tests / stubs)
 * @returns {(req: import("http").IncomingMessage & {
 *   webSession?: import("../auth/sessions").WebSession | null,
 *   discordSession?: import("../auth/sessions").WebSession | null,
 *   fluxerSession?: import("../auth/sessions").WebSession | null,
 *   user?: { userId: string, discordTag: string|null } | null,
 * }, res: import("http").ServerResponse, next: () => void) => void}
 */
function createSessionMiddleware(options = {}) {
  const cookieName = options.cookieName || SESSION_COOKIE_NAME;
  const fxCookieName = options.fxCookieName || FLUXER_SESSION_COOKIE_NAME;
  const now = options.now || Date.now;
  const minTouchIntervalMs = options.touchIntervalMs ?? TOUCH_MIN_INTERVAL_MS;
  const sessions = options.sessions || { getSession, touchSession, shouldTouch };
  // #401: seam-injectable for tests; the real renewer mirrors a row's
  // remaining life into Max-Age.
  const renewCookie = options.renewSessionCookie || renewSessionCookie;

  /**
   * Resolve one cookie into a live session, enforcing the cookie/platform
   * pairing (PR 10, K11): the row's `platform` must match the cookie it
   * arrived in. A mismatch is DROPPED (no identity for that slot) and logged
   * without the id — the cookie value is secret material (§8.7). Sessions
   * from stub APIs that predate the platform column read as "discord", so
   * the Discord slot stays byte-compatible; the Fluxer slot requires an
   * explicit fluxer row.
   * @param {string|null} id
   * @param {string} expectedPlatform
   * @returns {object|null}
   */
  /**
   * @returns {{session: object|null, renewed: string|null}} `renewed` is a
   * Set-Cookie earned ONLY when the row was touched AND the identity was
   * honored — a dropped slot (lookup failure, dead row, platform mismatch)
   * never renews anything.
   */
  function resolveCookieSession(id, expectedPlatform, slotName) {
    if (!id) return { session: null, renewed: null };
    let session = null;
    let renewed = null;
    try {
      const at = now();
      session = sessions.getSession(id, at);
      if (session && sessions.shouldTouch(session, at, minTouchIntervalMs)) {
        const touched = sessions.touchSession(session, at);
        if (touched) {
          session = touched;
          // #401: the row just slid — re-declare its remaining life on the
          // SAME slot the identity arrived in (never the other platform's
          // cookie). Emitted only if the identity below survives the gates.
          renewed = renewCookie(touched, at, slotName);
        }
      }
    } catch (err) {
      // Fail closed: a broken lookup must never authenticate a request, and
      // must not crash the handler chain either.
      console.warn("[web] session lookup failed:", err?.message || err);
      return { session: null, renewed: null };
    }
    if (!session) return { session: null, renewed: null };
    const platform = session.platform ?? "discord";
    if (platform !== expectedPlatform) {
      // A mismatch drops the identity — and its earned renewal with it: the
      // cookie on this slot is not this row's cookie to keep alive.
      renewed = null;
      console.warn(
        `[web] session cookie/platform mismatch: ${expectedPlatform} cookie carried a "${platform}" session — dropped`
      );
      return { session: null, renewed: null };
    }
    return { session, renewed };
  }

  return function sessionMiddleware(req, res, next) {
    req.discordSession = null;
    req.fluxerSession = null;
    req.webSession = null;
    req.user = null;

    const header = req.headers && req.headers.cookie;
    const discord = resolveCookieSession(parseSessionCookie(header, cookieName), "discord", cookieName);
    const fluxer = resolveCookieSession(parseSessionCookie(header, fxCookieName), "fluxer", fxCookieName);
    req.discordSession = discord.session;
    req.fluxerSession = fluxer.session;

    // Today's contract for every Discord-scoped surface (/, login, session
    // console, /auth/logout): req.webSession + req.user follow the DISCORD
    // session. guildScope re-points both at the community-matched session
    // for /g/:cid requests (PR 10).
    if (req.discordSession) {
      req.webSession = req.discordSession;
      req.user = {
        userId: req.discordSession.userId,
        discordTag: req.discordSession.discordTag,
      };
    }

    // #401 (C1-1): emit the renewals the slots EARNED above (touch fired and
    // the identity was honored). appendHeader keeps any Set-Cookie a later
    // handler adds; a logout's own setHeader clear still wins outright.
    const earned = [discord.renewed, fluxer.renewed].filter(Boolean);
    if (earned.length > 0 && res) {
      if (typeof res.appendHeader === "function") {
        for (const cookie of earned) res.appendHeader("Set-Cookie", cookie);
      } else if (typeof res.setHeader === "function" && typeof res.getHeader === "function") {
        const prev = res.getHeader("Set-Cookie");
        const list = Array.isArray(prev) ? prev.slice() : prev ? [prev] : [];
        res.setHeader("Set-Cookie", list.concat(earned));
      }
    }
    return next();
  };
}

module.exports = {
  createSessionMiddleware,
  parseSessionCookie,
};
