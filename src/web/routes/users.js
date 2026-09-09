/**
 * Web user pages (roadmap/web-admin.md §8.6 "Users" rows, Phase 1 read-only —
 * subtask 15). GET only — no POST/PUT/DELETE exists on this surface (§8.8
 * Phase 1; the app-wide methodGate 405s everything else anyway).
 *
 * Routes (all UNDER the /g/:guildId guildScope mounted by guildShell.js —
 * this module MUST be registered after registerGuildShellRoutes in app.js):
 *   GET /g/:guildId/users                    — staff+ — ID search (≤50 rows)
 *   GET /g/:guildId/users/:userId            — staff+ — unified profile
 *   GET /g/:guildId/users/:userId/activity   — SENIOR — /userinfo Activity
 *
 * Access semantics (exact, §8.6 + requireTier contract):
 *  - anonymous            → 302 /auth/login?guild=…   (guildScope)
 *  - stranger/cross-guild → generic 404 "Not found"   (guildScope, never 403)
 *  - wrong tier in-GUILD  → 403 "Forbidden"           (requireTier — mirrors
 *                           slash denial semantics: the gate answers, it does
 *                           not pretend the page doesn't exist)
 *  - :userId that is not a snowflake → the SAME generic 404 bytes as the
 *    catch-all (garbage never renders a distinguishing page);
 *  - valid snowflake with NO bot data → friendly in-shell 404 (renderShellError
 *    opt-in, documented as Phase-1-allowed in layout.js).
 *
 * Activity parity: data set = features/userActivity service output (channel/
 * category rankings + tracking meta), identical call path to the slash
 * /userinfo Activity gate; the senior staff-role gate (not ManageGuild alone)
 * is enforced by requireTier("senior") over the tier resolver which is proven
 * ⇔ src/core/permissions.js in test/web-tier-middleware.test.js.
 */

const { createGuildAccessResolver, TIER_RANK } = require("../auth/guildAccess");
const { requireTier } = require("../middleware/requireTier");
const { renderShellPage, renderShellError, writeShellHtml } = require("../views/layout");
const {
  renderUserSearchPage,
  renderUserProfileBody,
  renderUserActivityBody,
  renderUserNotFoundBody,
} = require("../views/users");
const {
  USER_ID_RE,
  readOffset,
  userHasData,
  buildUserProfile,
  buildUserActivity,
  searchGuildUsers,
} = require("../data/userProfile");

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
 * Best-effort guild/member reads from the BOT's in-process caches (labels +
 * join date for the Activity tab — the same discord.js objects the slash
 * card passes to the service). Cache-only: no network fetch on a request
 * path. Absent client (dark boot / tests) ⇒ nulls; the service degrades
 * exactly like slash does for unresolvable channels/join dates.
 * @param {(() => any)|null|undefined} getClient
 * @param {string} guildId
 * @param {string} userId
 */
function resolveDiscordContext(getClient, guildId, userId) {
  try {
    const client = typeof getClient === "function" ? getClient() : null;
    const guild = client?.guilds?.cache?.get?.(guildId) ?? null;
    const member = guild?.members?.cache?.get?.(userId) ?? null;
    return { guild, joinedMs: member?.joinedTimestamp ?? null, memberKnown: !!member };
  } catch {
    return { guild: null, joinedMs: null, memberKnown: false };
  }
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
 * senior+ per the tier ladder published by guildScope (staff < senior <
 * admin). This is the §8.6 "Users: Activity tab = Senior" gate: senior
 * STAFF-ROLE level satisfies it, junior staff (tier "staff") does not.
 * @param {object} req
 */
function isSeniorTier(req) {
  const tier = req.guildAccess?.tier;
  return !!tier && TIER_RANK[tier] >= TIER_RANK.senior;
}

/**
 * @param {import("express").Express} app
 * @param {object} [options]
 * @param {{resolve: Function, listGuilds: Function}} [options.guildAccess] pre-built resolver (tests)
 * @param {string} [options.apiBase] @param {typeof fetch} [options.fetchImpl]
 * @param {() => string[]|Promise<string[]>} [options.botGuilds]
 * @param {(() => import("discord.js").Client|null)|null} [options.getClient]
 *   live bot client (channel labels + join date from the member cache;
 *   null in tests/dark boot → graceful slash-style degradation)
 */
function registerUsersRoutes(app, options = {}) {
  const resolver =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });

  // ---- staff: search index ------------------------------------------------
  app.get("/g/:guildId/users", requireTier("staff"), async (req, res, next) => {
    try {
      const q = rawParams(req.url).get("q");
      const guilds = await shellGuilds(resolver, req);
      const search = searchGuildUsers(req.guildAccess.guildId, q);
      const page = renderUserSearchPage(req, { search });
      const document = renderShellPage(req, {
        title: "Users",
        heading: "Users",
        subheading: "Find a tracked member by user ID to open their unified profile.",
        content: page.content,
        guilds,
      });
      writeShellHtml(req, res, { status: 200, document });
    } catch (err) {
      next(err); // → handleAppError: generic 500, nothing leaked
    }
  });

  // ---- staff: unified profile (Activity SECTION gated senior on-page) -----
  app.get("/g/:guildId/users/:userId", requireTier("staff"), async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!USER_ID_RE.test(userId)) {
        respondGenericNotFound(res);
        return;
      }
      const guildId = req.guildAccess.guildId;
      const params = rawParams(req.url);
      const { guild, joinedMs, memberKnown } = resolveDiscordContext(options.getClient, guildId, userId);

      const profile = buildUserProfile(guildId, userId, {
        warnOffset: readOffset(params.get("w_off")),
        noteOffset: readOffset(params.get("n_off")),
        ticketOffset: readOffset(params.get("t_off")),
      });

      if (!profile.known && !memberKnown) {
        const document = renderShellError(req, {
          status: 404,
          title: "User not found",
          message: String(renderUserNotFoundBody({ userId })),
          guilds: await shellGuilds(resolver, req),
        });
        writeShellHtml(req, res, { status: 404, document });
        return;
      }

      // Senior-only Activity SUMMARY (totals only; the ranking table lives on
      // the senior route). Staff get the slash denial sentence instead —
      // zero activity data leaves this function for lower tiers.
      const visible = isSeniorTier(req);
      const activity = visible
        ? { visible: true, ...buildUserActivity(guildId, userId, { guild, joinedMs }) }
        : { visible: false };

      const document = renderShellPage(req, {
        title: `User ${userId}`,
        heading: "User profile",
        subheading: `Unified view · XP + warnings + notes + tickets · activity ${visible ? "visible (senior)" : "restricted"}`,
        content: renderUserProfileBody(req, { profile, activity }),
        guilds: await shellGuilds(resolver, req),
      });
      writeShellHtml(req, res, { status: 200, document });
    } catch (err) {
      next(err);
    }
  });

  // ---- SENIOR: Activity tab (slash /userinfo Activity equivalent) ---------
  app.get("/g/:guildId/users/:userId/activity", requireTier("senior"), async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!USER_ID_RE.test(userId)) {
        respondGenericNotFound(res);
        return;
      }
      const guildId = req.guildAccess.guildId;
      const { guild, joinedMs, memberKnown } = resolveDiscordContext(options.getClient, guildId, userId);

      if (!userHasData(guildId, userId) && !memberKnown) {
        const document = renderShellError(req, {
          status: 404,
          title: "User not found",
          message: String(renderUserNotFoundBody({ userId })),
          guilds: await shellGuilds(resolver, req),
        });
        writeShellHtml(req, res, { status: 404, document });
        return;
      }

      const params = rawParams(req.url);
      const activity = {
        visible: true,
        ...buildUserActivity(guildId, userId, {
          win: params.get("win"),
          page: params.get("page"),
          guild,
          joinedMs,
        }),
      };

      const document = renderShellPage(req, {
        title: `Activity · ${userId}`,
        heading: "User profile",
        subheading: `Activity tab (senior staff) · user ${userId}`,
        content: renderUserActivityBody(req, { profile: { userId }, activity }),
        guilds: await shellGuilds(resolver, req),
      });
      writeShellHtml(req, res, { status: 200, document });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = {
  registerUsersRoutes,
};
