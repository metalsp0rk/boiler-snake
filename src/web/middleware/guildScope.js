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
 *  - on success attaches `req.guildAccess = { communityId, guildId, tier,
 *    degraded }` (tier ∈ staff|senior|admin) for requireTier and the route
 *    handlers. `guildId` is the community's Discord-facing external id
 *    (REST/display); repositories take `communityId` (integer).
 *  - Fluxer PR 10 (§Session columns and cookies): the middleware loads the
 *    community row and re-points `req.webSession`/`req.user` at the session
 *    whose platform AND instanceKey match that community — audit and route
 *    handlers can never act as the wrong provider's user. The resolver is
 *    handed the session the browser PRESENTED (see presentedSessionFor) so
 *    a cross-platform cookie lands on its generic 404, never a login
 *    redirect. Requests with no session at all keep today's 302.
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

/**
 * Snowflake gate (login redirect targets) + PR 2 community-id route gate:
 * `/g/:id` carries the INTEGER communities.id; snowflake ids no longer route
 * (parseCommunityIdParam → null → generic 404, §8.6 indistinguishable).
 */
const {
  URL_ID_RE: GUILD_ID_RE,
  parseCommunityIdParam,
} = require("../shared/snowflake");
const { getCommunityById } = require("../../platform/community");

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
 * The session the client PRESENTED for a community (PR 10): the slot of the
 * community's platform first, falling back to the other slot so the resolver
 * can see a CROSS-PLATFORM session and answer with its generic 404 (spec
 * §Session columns and cookies: "a Discord cookie presented to a Fluxer
 * community is anonymous for that route (req.user null, generic 404 from
 * the resolver)" — a login redirect would leak the platform split).
 * A legacy caller with no platform fields on its sessions (hand-built test
 * rows) keeps today's behavior: `req.webSession` IS the discord session.
 * @param {any} req
 * @param {{platform: string}|null} community
 * @returns {object|null}
 */
function presentedSessionFor(req, community) {
  if (!community) return req.webSession ?? null;
  if (community.platform === "fluxer") {
    return req.fluxerSession ?? req.discordSession ?? req.webSession ?? null;
  }
  return req.discordSession ?? req.fluxerSession ?? req.webSession ?? null;
}

/**
 * The session fully MATCHING a community row (platform AND instanceKey —
 * K11: a session for another Fluxer instance is not identity here). Only a
 * full match may own req.user / req.webSession (audit subject, CSRF, route
 * handlers); a platform/instance mismatch leaves the request anonymous.
 * @param {any} req
 * @param {{platform: string, instanceKey: string}|null} community
 * @returns {object|null}
 */
function matchedSessionFor(req, community) {
  const session = presentedSessionFor(req, community);
  if (!session) return null;
  if (!community) return session; // unknown row → keep legacy req.webSession flow
  const platform = session.platform ?? "discord";
  const instanceKey = session.instanceKey ?? "discord";
  return platform === community.platform && instanceKey === community.instanceKey
    ? session
    : null;
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
      const guildIdParam = req.params ? req.params[param] : undefined;

      // Anonymous: same login redirect the standalone shell already serves.
      // PR 10: EITHER cookie slot can carry identity for the community this
      // route targets, so "anonymous" means NEITHER slot resolved a session.
      if (!req.webSession && !req.fluxerSession) {
        respondLoginRedirect(res, loginRedirectTarget(guildIdParam, loginPath));
        return;
      }

      // Missing param = mounted without a :guildId segment. That is a wiring
      // bug, not a security event: 500 (generic body) so it surfaces loudly
      // instead of silently scoping to `undefined`.
      if (typeof guildIdParam !== "string" || guildIdParam.length === 0) {
        console.error(
          `[web] guildScope mounted without req.params.${param} — refusing to scope`
        );
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal error");
        return;
      }

      // PR 2: the path parameter is the INTEGER community id. Anything else
      // (17–20-digit snowflakes included) fails the gate → generic 404.
      const communityId = parseCommunityIdParam(guildIdParam);
      if (communityId == null) {
        respondGenericNotFound(res);
        return;
      }

      // Fluxer PR 10 (§Session columns and cookies): load the community row
      // FIRST and bind req.webSession/req.user to the session that MATCHES
      // it (platform + instanceKey). A Discord cookie on a Fluxer community
      // (and vice versa) leaves the request anonymous for the route + audit
      // layers; the resolver still sees the PRESENTED session so a platform
      // mismatch is its generic 404 (deny not_in_access_list), not a login
      // redirect that hints at the platform split. A community lookup that
      // THROWS keeps the legacy flow — the resolver's own lookup then fails
      // closed to the same 404 it already renders (store_unavailable).
      let community = null;
      let communityLookupFailed = false;
      try {
        community = getCommunityById(communityId);
      } catch (err) {
        communityLookupFailed = true;
        console.warn(
          "[web] guildScope: community lookup failed:",
          err?.code || err?.message || err
        );
      }

      const presented = communityLookupFailed
        ? req.webSession ?? null
        : presentedSessionFor(req, community);
      if (!communityLookupFailed) {
        const matched = matchedSessionFor(req, community);
        req.webSession = matched;
        req.user = matched
          ? { userId: matched.userId, discordTag: matched.discordTag ?? null }
          : null;
      }

      const access = await resolver.resolve(presented, communityId);

      if (access.status === "ok") {
        req.guildAccess = {
          communityId,
          // Discord-facing external id for REST/display (may be null if the
          // community has no external mapping — data layers handle null).
          guildId: access.guildId ?? null,
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
        respondLoginRedirect(res, loginRedirectTarget(guildIdParam, loginPath));
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
