/**
 * Web XP leaderboard pages (roadmap/web-admin.md §8.6 "XP: leaderboard,
 * history | Staff" row, Phase 1 read-only — subtask 16). GET only — the
 * grant-xp MUTATION is Admin and belongs to Phase 3 (subtask 28); nothing
 * here writes (§8.8 Phase 1; the app-wide methodGate 405s every POST).
 *
 * Routes (all UNDER the /g/:guildId guildScope mounted by guildShell.js —
 * this module MUST be registered after registerGuildShellRoutes in app.js,
 * exactly like routes/users.js):
 *   GET /g/:guildId/leaderboard              — staff+ — paginated top-XP
 *   GET /g/:guildId/leaderboard/user/:userId — staff+ — rank/XP/level/
 *                                              progress (no history table
 *                                              exists — see data header)
 *
 * Access semantics (identical to routes/users.js, §8.6 + requireTier):
 *  - anonymous            → 302 /auth/login?guild=…   (guildScope)
 *  - stranger/cross-guild → generic 404 "Not found"   (never 403)
 *  - in-guild member without a staff tier → 404 (guildScope has no tier for
 *    them — the same deny shape the users/profile route shows)
 *  - :userId that is not a snowflake → the SAME generic 404 bytes as the
 *    catch-all (garbage never renders a distinguishing page);
 *  - valid snowflake with NO XP row in THIS guild → friendly in-shell 404
 *    (renderShellError opt-in — the digits were already validated, and the
 *    absence of an XP row leaks nothing about access lists).
 *
 * Query params (?page, ?size) parse off the RAW url (app doctrine: never
 * req.query) and are normalized by the data layer: size hard-caps at 100,
 * page caps at MAX_PAGE, overflow clamps to the last real page.
 */

const { createGuildAccessResolver } = require("../auth/guildAccess");
const { requireTier } = require("../middleware/requireTier");
const { renderShellPage, renderShellError, writeShellHtml } = require("../views/layout");
const {
  renderLeaderboardBody,
  renderUserXpBody,
  renderUserXpNotFoundBody,
} = require("../views/leaderboard");
const {
  USER_ID_RE,
  PAGE_SIZE_DEFAULT,
  buildLeaderboardPage,
  buildUserXpSummary,
} = require("../data/leaderboard");

/**
 * The generic 404 — byte-identical to guildScope/app.js catch-alls so an
 * invalid :userId is indistinguishable from a nonexistent path (§8.6).
 * @param {import("http").ServerResponse} res
 */
function respondGenericNotFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

/**
 * Parse the RAW url query (app doctrine: never req.query — the Express 5
 * "simple" parser and path-to-regexp decoding must not decide behavior here).
 * @param {string} rawUrl
 * @returns {URLSearchParams}
 */
function rawParams(rawUrl) {
  const idx = String(rawUrl || "").indexOf("?");
  return new URLSearchParams(idx === -1 ? "" : String(rawUrl).slice(idx + 1));
}

/**
 * Cache-only display-name read — the leaderboard counterpart of users.js
 * resolveDiscordContext: bot client cache ONLY, never a network fetch on a
 * request path. Absent client (dark boot / tests) ⇒ nulls; the view falls
 * back to `User ${id}` exactly like slash does on a member-cache miss.
 * @param {(() => any)|null|undefined} getClient
 * @param {string} guildId
 * @param {string[]} userIds
 * @returns {Map<string, string|null>}
 */
function resolveMemberNames(getClient, guildId, userIds) {
  const names = new Map();
  let client = null;
  try {
    client = typeof getClient === "function" ? getClient() : null;
  } catch {
    client = null;
  }
  const members = client?.guilds?.cache?.get?.(guildId)?.members?.cache ?? null;
  for (const userId of userIds) {
    let name = null;
    try {
      const m = members?.get?.(userId) ?? null;
      name = m?.displayName || m?.user?.username || null;
    } catch {
      name = null;
    }
    names.set(userId, name);
  }
  return names;
}

/** Shared switcher list for shell pages (never fails the page open/closed). */
async function shellGuilds(resolver, req) {
  const listed = await resolver.listGuilds(req.webSession);
  const guilds = listed.guilds.slice();
  const currentId = req.guildAccess.guildId;
  if (!guilds.some((g) => g.id === currentId)) {
    guilds.unshift({ id: currentId, name: currentId });
  }
  return guilds;
}

/**
 * @param {import("express").Express} app
 * @param {object} [options]
 * @param {{resolve: Function, listGuilds: Function}} [options.guildAccess] pre-built resolver (tests)
 * @param {string} [options.apiBase] @param {typeof fetch} [options.fetchImpl]
 * @param {() => string[]|Promise<string[]>} [options.botGuilds]
 * @param {(() => import("discord.js").Client|null)|null} [options.getClient]
 *   live bot client (display names from the member cache; null in
 *   tests/dark boot → slash-style `User <id>` fallback)
 */
function registerLeaderboardRoutes(app, options = {}) {
  const resolver =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });

  // ---- staff: paginated top-XP leaderboard ---------------------------------
  app.get("/g/:guildId/leaderboard", requireTier("staff"), async (req, res, next) => {
    try {
      const params = rawParams(req.url);
      const guildId = req.guildAccess.guildId;
      const board = buildLeaderboardPage(guildId, {
        page: params.get("page"),
        size: params.get("size"),
      });
      const names = resolveMemberNames(
        options.getClient,
        guildId,
        board.rows.map((r) => r.user_id)
      );
      const guilds = await shellGuilds(resolver, req);

      const document = renderShellPage(req, {
        title: "Leaderboard",
        heading: "XP leaderboard",
        subheading: `Top XP in this guild · page ${board.page} of ${board.totalPages} · ${board.size} per page (cap 100)`,
        content: renderLeaderboardBody(req, { board, names }),
        guilds,
      });
      writeShellHtml(req, res, { status: 200, document });
    } catch (err) {
      next(err); // → handleAppError: generic 500, nothing leaked
    }
  });

  // ---- staff: per-user XP (rank + level progress; history is not stored) --
  app.get("/g/:guildId/leaderboard/user/:userId", requireTier("staff"), async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!USER_ID_RE.test(userId)) {
        respondGenericNotFound(res);
        return;
      }
      const guildId = req.guildAccess.guildId;

      const summary = buildUserXpSummary(guildId, userId);
      if (!summary) {
        const document = renderShellError(req, {
          status: 404,
          title: "User not found",
          message: renderUserXpNotFoundBody({ userId }),
          guilds: await shellGuilds(resolver, req),
        });
        writeShellHtml(req, res, { status: 404, document });
        return;
      }

      const names = resolveMemberNames(options.getClient, guildId, [userId]);
      const document = renderShellPage(req, {
        title: `XP · ${userId}`,
        heading: "User XP",
        subheading: `Rank #${summary.rank} of ${summary.total} · Level ${summary.level} · ${summary.xp} XP`,
        content: renderUserXpBody(req, { summary, name: names.get(userId) ?? null }),
        guilds: await shellGuilds(resolver, req),
      });
      writeShellHtml(req, res, { status: 200, document });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = {
  registerLeaderboardRoutes,
  PAGE_SIZE_DEFAULT,
};
