/**
 * Identifier LOOKUPS for console inputs (roadmap §8.15 task 15.10):
 *
 *   GET /g/:guildId/lookups/users?q=   → { users: [{id, name}] }
 *   GET /g/:guildId/lookups/roles?q=   → { roles: [{id, name}] }
 *
 * Purpose: power the type-ahead on user/role text fields so operators pick
 * real NAMES instead of pasting snowflakes. Pure READ surface — JSON only,
 * no mutations, no CSRF (GET), same gates as every other /g page via the
 * shared guildScope (anon ⇒ 302, stranger/cross-guild ⇒ generic 404) plus
 * requireTier("staff").
 *
 * Data sources honor the offline doctrine (§8.2, §8.15 15.3):
 *  - roles: the role cache is ALWAYS complete (GUILD_CREATE carries roles
 *    with no intent) — names search with zero API calls;
 *  - users: member cache ONLY (no GuildMembers intent, never fetch on a
 *    request path). An exact id/mention answers even when the name is
 *    unknown, and the cache miss flows through resolveMemberNames →
 *    memberFetchQueue, so the NEXT keystroke knows the name. The cache
 *    warms as the operator browses people pages and grants.
 *
 * Failure contract (AGENTS.md): handler wrapped; a break logs with context
 * and answers 500 JSON — never an HTML page, never a stack in the body.
 */

const { requireTier } = require("../middleware/requireTier");
const { createGuildAccessResolver } = require("../auth/guildAccess");
const {
  resolveMemberNames,
  memberNameCandidates,
} = require("./shared/discord-cache");
const {
  normalizeUserId,
  findRoleIdByName,
  rankSuggestions,
} = require("./shared/discordInput");
const { rawParams } = require("./shared/req.js");

/** Suggestions per response — a picker shows ~10; more is noise. */
const SUGGEST_LIMIT = 15;
/** Query clamp (matches the users search box maxlength). */
const Q_MAX = 64;

function json200(res, payload) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

/**
 * @param {import("express").Express} app
 * @param {object} [options]
 * @param {{resolve: Function, listGuilds: Function}} [options.guildAccess]
 * @param {(() => any)|null} [options.getClient]
 */
function registerLookupRoutes(app, options = {}) {
  const resolver =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });
  const getClient = typeof options.getClient === "function" ? options.getClient : null;

  const qOf = (req) => String(rawParams(req.url).get("q") ?? "").trim().slice(0, Q_MAX);

  // ---- users ---------------------------------------------------------------
  app.get("/g/:guildId/lookups/users", requireTier("staff"), (req, res) => {
    try {
      const guildId = req.guildAccess.guildId;
      const q = qOf(req);
      if (!q) return json200(res, { users: [] });

      // Exact id (or mention): always answer, even cold — the operator may
      // legitimately have only an id. The name resolves itself via the
      // background member-fetch queue on a cache miss.
      const exact = normalizeUserId(q);
      if (exact) {
        const name = resolveMemberNames(getClient, guildId, [exact]).get(exact) ?? null;
        return json200(res, {
          users: [{ id: exact, name }],
          exact: true,
        });
      }

      const client = getClient ? getClient() : null;
      const guild = client?.guilds?.cache?.get?.(guildId) ?? null;
      const users = rankSuggestions(memberNameCandidates(guild), q.toLowerCase())
        .slice(0, SUGGEST_LIMIT);
      return json200(res, { users });
    } catch (err) {
      console.error(`[web] lookups.users failed (guild=${req.guildAccess?.guildId}):`, err?.message || err);
      res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "lookup_failed" }));
    }
  });

  // ---- roles ---------------------------------------------------------------
  app.get("/g/:guildId/lookups/roles", requireTier("staff"), (req, res) => {
    try {
      const guildId = req.guildAccess.guildId;
      const q = qOf(req);
      if (!q) return json200(res, { roles: [] });

      const client = getClient ? getClient() : null;
      const rolesCache = client?.guilds?.cache?.get?.(guildId)?.roles?.cache ?? null;
      const all = [];
      try {
        if (rolesCache && typeof rolesCache.values === "function") {
          for (const r of rolesCache.values()) {
            if (!r?.id || String(r.id) === String(guildId)) continue; // no @everyone
            all.push({ id: String(r.id), name: String(r.name || "") });
          }
        }
      } catch {
        /* partial list fine */
      }
      const roles = rankSuggestions(all, q.toLowerCase()).slice(0, SUGGEST_LIMIT);
      return json200(res, { roles });
    } catch (err) {
      console.error(`[web] lookups.roles failed (guild=${req.guildAccess?.guildId}):`, err?.message || err);
      res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "lookup_failed" }));
    }
  });

  return { resolver };
}

module.exports = { registerLookupRoutes };
