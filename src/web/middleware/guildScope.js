/**
 * Guild-scope gate for every `/g/:guildId...` route (roadmap/web-admin.md
 * §8.2/§8.3, cross-cutting 404 rule §8.6 — subtask 07).
 *
 * Contract:
 *  - `:guildId` NOT in the viewer's access list ⇒ 404 with the SAME generic
 *    body as the app-wide catch-all 404 — NEVER 403 and never a distinguishing
 *    message: the panel must not leak which guild ids exist (§8.6, §8.13-10).
 *  - anonymous ⇒ 302 to /auth/login (guild query only for snowflake ids),
 *    byte-identical to the /g shell's placeholder redirect that
 *    test/web-auth-login.test.js already pins — so mounting this ahead of
 *    the shell (subtask 11) keeps that oracle green. A live-but-unusable
 *    session (decrypt failure / expired or revoked AT ⇒ resolver 'reauth')
 *    takes the SAME redirect: the user is, panel-speaking, anonymous.
 *  - on success attaches `req.guildAccess = { guildId, tier, degraded }`
 *    (tier ∈ staff|senior|admin) for requireTier and the route handlers.
 *
 * Mount (subtask 11): `app.use("/g/:guildId", createGuildScopeMiddleware({ resolver }))`
 * — Express 5 (path-to-regexp v8) matches the single-segment param as a
 * prefix, so every deeper /g/<id>/... path flows through with
 * req.params.guildId set.
 *
 * Responses use raw writeHead/end framing (Phase 0a convention of this app;
 * no Express res.send). Unexpected errors fail CLOSED to the generic 404 —
 * an attacker learns nothing from an outage, and the visitor retries.
 */

/** Same snowflake gate as login.js GUILD_TARGET_RE / routes/dashboard.js. */
const { URL_ID_RE: GUILD_ID_RE } = require("../shared/snowflake");

/**
 * Login target for the anonymous/reauth redirect — mirrors the shell's
 * placeholder exactly: snowflake ⇒ `?guild=` return target (signed into the
 * purpose-tagged state by login.js, never trusted raw), anything else ⇒ bare
 * /auth/login (never echo junk back through a query param).
 * @param {unknown} guildId
 * @param {string} loginPath
 * @returns {string}
 */
function loginRedirectTarget(guildId, loginPath = "/auth/login") {
  return typeof guildId === "string" && GUILD_ID_RE.test(guildId)
    ? `${loginPath}?guild=${guildId}`
    : loginPath;
}

/**
 * 302 to login, auth-page headers (no-store + no-referrer, §8.7).
 * @param {import("http").ServerResponse} res
 * @param {string} target
 */
function respondLoginRedirect(res, target) {
  res.writeHead(302, {
    Location: target,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end();
}

/**
 * The generic 404 — body and framing IDENTICAL to app.js's handleNotFound
 * catch-all, so scoped/nonexistent/cross-guild are indistinguishable.
 * @param {import("http").ServerResponse} res
 */
function respondGenericNotFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

/**
 * guildScope middleware factory (pure: resolver injected).
 *
 * @param {object} options
 * @param {{resolve: Function}} options.resolver
 *   createGuildAccessResolver() instance (auth/guildAccess.js)
 * @param {string} [options.param="guildId"] route param carrying the guild id
 * @param {string} [options.loginPath="/auth/login"]
 * @returns {(req: any, res: import("http").ServerResponse, next: () => void) => Promise<void>}
 */
function createGuildScopeMiddleware({ resolver, param = "guildId", loginPath = "/auth/login" } = {}) {
  if (!resolver || typeof resolver.resolve !== "function") {
    throw new TypeError("createGuildScopeMiddleware: resolver with resolve() is required");
  }

  return async function guildScope(req, res, next) {
    try {
      const guildId = req.params ? req.params[param] : undefined;

      // Anonymous: same login redirect the standalone shell already serves.
      if (!req.webSession) {
        respondLoginRedirect(res, loginRedirectTarget(guildId, loginPath));
        return;
      }

      // Missing param = mounted without a :guildId segment. That is a wiring
      // bug, not a security event: 500 (generic body) so it surfaces loudly
      // instead of silently scoping to `undefined`.
      if (typeof guildId !== "string" || guildId.length === 0) {
        console.error(
          `[web] guildScope mounted without req.params.${param} — refusing to scope`
        );
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal error");
        return;
      }

      const access = await resolver.resolve(req.webSession, guildId);

      if (access.status === "ok") {
        req.guildAccess = {
          guildId,
          tier: access.tier,
          degraded: !!access.degraded, // §8.3 operator-banner flag (Phase 1 renders it)
        };
        next();
        return;
      }

      // Live session whose Discord token cannot be trusted anymore:
      // decrypt failure / expired / revoked ⇒ re-auth (login rotates the
      // session anyway; we do NOT destroy rows from a GET).
      if (access.status === "reauth" || access.status === "anon") {
        respondLoginRedirect(res, loginRedirectTarget(guildId, loginPath));
        return;
      }

      // Every deny (not_in_access_list, member_left, no_tier, retry rows of
      // the degradation matrix) renders the identical generic 404: cross-guild
      // is indistinguishable from nonexistent, and "you are not staff here"
      // leaks nothing beyond what a 404 already hides (§8.6 — never 403).
      respondGenericNotFound(res);
    } catch (err) {
      // Fail closed, generic body — nothing distinguishing, nothing echoed.
      console.error("[web] guildScope failed closed:", err?.code || err?.message || err);
      if (!res.headersSent) respondGenericNotFound(res);
    }
  };
}

module.exports = {
  GUILD_ID_RE,
  loginRedirectTarget,
  createGuildScopeMiddleware,
};
