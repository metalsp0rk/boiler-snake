/**
 * Web user pages (roadmap/web-admin.md §8.6 "Users" rows, Phase 1 read-only —
 * subtask 15). GET only — no POST/PUT/DELETE exists on this surface (§8.8
 * Phase 1; the app-wide methodGate 405s everything else anyway).
 *
 * Routes (all UNDER the /g/:guildId guildScope mounted by dashboard.js —
 * this module MUST be registered after registerDashboardRoutes in app.js):
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
const { rawParams } = require("./shared/req.js");
const { shellGuilds } = require("./shared/shell.js");
const { memberNameCandidates, resolveMemberNames } = require("./shared/discord-cache");
const { rankSuggestions } = require("./shared/discordInput");
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
  app.get("/g/:guildId/users", requireTier("staff"), async (req, res) => {
    const q = rawParams(req.url).get("q");
    const guilds = await shellGuilds(resolver, req);
    // §8.15-15.10: name queries resolve through the member cache (ranked,
    // ≤50 ids); the data layer still only returns TRACKED rows. Numeric
    // queries keep the pure-DB exact/prefix id search (offline-safe).
    let nameMatchIds = [];
    const trimmed = String(q ?? "").trim();
    if (trimmed && !/^[0-9]{1,20}$/.test(trimmed)) {
      const client = typeof options.getClient === "function" ? options.getClient() : null;
      const guild = client?.guilds?.cache?.get?.(req.guildAccess.guildId) ?? null;
      nameMatchIds = rankSuggestions(
        memberNameCandidates(guild).filter((c) => c.name),
        trimmed.toLowerCase()
      )
        .slice(0, 50)
        .map((c) => c.id);
    }
    const search = searchGuildUsers(req.guildAccess.guildId, q, { nameMatchIds });
    const page = renderUserSearchPage(req, { search });
    const document = renderShellPage(req, {
      title: "Users",
      heading: "Users",
      subheading: "Find a tracked member by user ID to open their unified profile.",
      content: page.content,
      guilds,
    });
    writeShellHtml(req, res, { status: 200, document });
  });

  // ---- staff: unified profile (Activity SECTION gated senior on-page) -----
  app.get("/g/:guildId/users/:userId", requireTier("staff"), async (req, res) => {
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
  });

  // ---- SENIOR: Activity tab (slash /userinfo Activity equivalent) ---------
  // ---- staff: hover PROFILE CARD JSON (§8.15-15.11) ----------------------
  // Powers the [data-user-card] popups in app.js: name, id, avatar and role
  // chips sourced CACHE-ONLY (roles cache is complete without intents;
  // member fields appear as the member-fetch queue warms — first hover may
  // be partial, later hovers complete; nothing here ever fetches on the
  // request path). Staff+ (lives behind guildScope + requireTier like the
  // profile page); generic 404 for malformed ids; no-store JSON.
  app.get("/g/:guildId/users/:userId/card", requireTier("staff"), (req, res) => {
    try {
      const { userId } = req.params;
      if (!USER_ID_RE.test(userId)) {
        respondGenericNotFound(res);
        return;
      }
      const guildId = req.guildAccess.guildId;
      const client = typeof options.getClient === "function" ? options.getClient() : null;
      const guild = client?.guilds?.cache?.get?.(guildId) ?? null;
      const member = guild?.members?.cache?.get?.(userId) ?? null;

      // Cache miss ⇒ background warm-up (self-healing cards, zero API on
      // this path). resolveMemberNames enqueues exactly this id.
      resolveMemberNames(options.getClient ?? null, guildId, [userId]);

      const user = member?.user ?? null;
      let avatar = null;
      try {
        if (user && typeof user.displayAvatarURL === "function") {
          avatar = user.displayAvatarURL({ size: 64 });
        }
      } catch {
        avatar = null;
      }
      if (!avatar) {
        // Discord default-avatar rule for username-migrated users.
        try {
          const idx = Number((BigInt(userId) >> 22n) % 6n);
          avatar = `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
        } catch {
          avatar = null;
        }
      }

      const name = String(
        member?.nickname || member?.displayName || user?.username || ""
      ).trim().slice(0, 100) || null;

      // Role chips: this member's roles by NAME via the complete role
      // cache, @everyone excluded, highest first when positions exist.
      const roleChips = [];
      try {
        const memberRoles = member?.roles?.cache ?? null;
        const guildRoles = guild?.roles?.cache ?? null;
        if (memberRoles && typeof memberRoles.values === "function") {
          for (const r of memberRoles.values()) {
            const rid = String(r?.id ?? "");
            if (!rid || rid === String(guildId)) continue;
            const known = guildRoles?.get?.(rid) ?? r;
            const rname = String(known?.name ?? "").trim().slice(0, 100);
            if (!rname) continue;
            roleChips.push({
              name: rname,
              color: typeof known?.hexColor === "string" ? known.hexColor : null,
            });
          }
        }
      } catch {
        /* partial chips are fine — a card is an enhancement */
      }

      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(JSON.stringify({
        id: userId,
        known: !!member,
        name,
        tag: String(user?.tag || user?.username || "").slice(0, 80) || null,
        avatar,
        roles: roleChips.slice(0, 25),
      }));
    } catch (err) {
      console.error(`[web] user card failed (guild=${req.guildAccess?.guildId}):`, err?.message || err);
      res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "card_failed" }));
    }
  });

  app.get("/g/:guildId/users/:userId/activity", requireTier("senior"), async (req, res) => {
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
  });
}

module.exports = {
  registerUsersRoutes,
};
