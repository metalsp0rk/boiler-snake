/**
 * Tier gate for routes already inside the guild scope (roadmap/web-admin.md
 * §8.2/§8.6 tier table — subtask 07).
 *
 * Usage (Phase 1+ route authors):
 *
 *   // app mount (subtask 11): app.use("/g/:guildId", createGuildScopeMiddleware({ resolver }))
 *   app.get("/g/:guildId/settings", requireTier("staff"), handler);
 *   app.get("/g/:guildId/activity", requireTier("senior"), handler);   // §8.6 Activity tab
 *   app.post("/g/:guildId/staff/roles", requireTier("admin"), handler); // staff_roles CRUD
 *
 * Reads `req.guildAccess.tier` published by middleware/guildScope.js and
 * compares ladder ranks (staff < senior < admin; a higher tier satisfies
 * every lower requirement, mirroring how isSeniorStaff ⊆ isStaff ⊆ admin
 * work in src/core/permissions.js).
 *
 * Status-code choice (§8.6 nuance, deliberate):
 *  - wrong GUILD stays 404 — that is guildScope's cross-cutting no-
 *    enumeration rule (§8.6 "never 403");
 *  - RIGHT guild but INSUFFICIENT tier ⇒ 403 with a generic fixed body.
 *    The viewer is already proven present in this guild (they passed
 *    guildScope), so a tier denial here reveals nothing enumerable — and a
 *    distinct 403 matches the slash gates' behavior (requireStaff replies
 *    "denied" rather than pretending the command doesn't exist). The body
 *    never names the required tier or the viewer's tier.
 *  - requireTier WITHOUT a preceding guildScope is a mount bug: fail closed
 *    with a generic 500 + loud log (it must never fall open to next()).
 *
 * No re-resolution happens here: guildScope ran moments ago on the same
 * request, and the tier cache (guildAccess TTL) bounds staleness anyway
 * (§8.1-8). Routes that want the freshest read can call the resolver again —
 * the cache absorbs it.
 */

const { TIER_RANK, TIERS } = require("../auth/guildAccess");

/**
 * @param {"staff"|"senior"|"admin"} tier minimum tier the route requires
 * @returns {(req: any, res: import("http").ServerResponse, next: () => void) => void}
 */
function requireTier(tier) {
  if (!TIERS.includes(tier)) {
    // Developer error at mount time — surface immediately, not per request.
    throw new TypeError(
      `requireTier: unknown tier "${tier}" (expected one of: ${TIERS.join(", ")})`
    );
  }
  const requiredRank = TIER_RANK[tier];

  return function requireTierMiddleware(req, res, next) {
    const access = req.guildAccess;
    if (!access || typeof access.tier !== "string" || !(access.tier in TIER_RANK)) {
      console.error(
        "[web] requireTier ran without req.guildAccess — mount guildScope before requireTier"
      );
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal error");
      return;
    }
    if (TIER_RANK[access.tier] >= requiredRank) {
      next();
      return;
    }
    // Generic, fixed — never names tiers or the guild (§8.7 generic bodies).
    res.writeHead(403, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end("Forbidden");
  };
}

module.exports = {
  requireTier,
  TIER_RANK,
  TIERS,
};
