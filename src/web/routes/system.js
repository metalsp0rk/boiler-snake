/**
 * GET /g/:guildId/system + GET /g/:guildId/audit — the Phase 1 read-only
 * system page and the admin_audit viewer (roadmap/web-admin.md §8.6
 * "System: health, tickers, OAuth state, audit viewer (admin_audit) | Admin
 * | — | 1 (viewer)" — subtask 22).
 *
 * The two Phase-1 pages stay GET-only (the audit viewer is read-only — "no
 * export, no deletes" — and the app-wide methodGate 405s every other verb
 * on their paths). The ONE exception is the Phase-4 System "Web sessions"
 * page, whose revoke mutation registers through registerWebMutation +
 * app.post in lockstep (routes/sessions.js carries the shared selector
 * parser + view vocabulary, so the two session scopes cannot drift).
 *
 * Route position: registered AFTER routes/dashboard.js in app.js, so the
 * shell's `/g/:guildId` guildScope already ran (anon ⇒ login redirect,
 * cross-guild/stranger ⇒ generic 404 — §8.6 cross-cutting rule, never 403).
 * requireTier("admin") inside each route is the explicit §8.6 System-row
 * tier: same-guild staff/senior ⇒ 403 "Forbidden"; cross-guild ⇒ 404.
 *
 * Secrets contract (§8.7 / §8.1-9) — the whole reason this page is Admin:
 *  - env is projected to NAMES + booleans only (SESSION_SECRET source is
 *    "dedicated | fallback | unset", never the value; the command-permission
 *    panel reuses routes/staff.js readEnvConfig — IMPORTED, not forked —
 *    plus the token-stripping projectOauthView projection from
 *    data/staffData.js, so refresh/access token columns cannot reach a view);
 *  - the SQLite file path is the RESOLVED path from db/connection (a path,
 *    not an env dump — no env values are rendered anywhere);
 *  - ticker sources and the session-prune job are reported HONESTLY:
 *    registry-driven, "unknown" where nothing is exposed in-process — the
 *    page never fabricates a status.
 *
 * Audit viewer query-budget (§8.6, review-blocking):
 *  - rows come ONLY from the subtask-03 facade pair listAdminAudit/
 *    countAdminAudit — guild-scoped by construction (first positional arg
 *    is req.guildAccess.guildId; the URL param is never forwarded), newest
 *    first, LIMIT hard-clamped ≤ 100 (repo MAX_AUDIT_LIST_LIMIT), offset
 *    clamped to the shared web MAX_OFFSET (1000) — served by
 *    idx_admin_audit_guild_created;
 *  - the origin filter is whitelisted through the repo's normalizeAuditOrigin
 *    BEFORE the call (junk would throw INVALID_ORIGIN at the repo — the page
 *    degrades to unfiltered + escaped notice instead, like the moderation
 *    junk filters); no free-form SQL ever leaves this module;
 *  - one page build = exactly ONE list + ONE count read. No per-row lookups.
 */

const { createGuildAccessResolver } = require("../auth/guildAccess");
const { requireTier } = require("../middleware/requireTier");
const { renderShellPage, writeShellHtml } = require("../views/layout");
const { renderSystemBody, renderAuditBody } = require("../views/system");
const { resolveMemberNames } = require("./shared/discord-cache");
// Reuse the SANITIZED env projection + the OAuth status read from the staff
// surface (§8.7): imported on purpose so the two surfaces can never diverge.
const { readEnvConfig } = require("./staff");
const { createStaffData } = require("../data/staffData");
// Shared ticker registry (subtask 14) — consume only, never register here.
const { snapshotTickerHealth } = require("../data/tickerHealth");
// Shared web-layer offset clamp + page-size normalization (single
// definitions; system.js must not fork divergent bounds).
const { readOffset } = require("../data/userProfile");
const { readPageSize } = require("../data/moderation");
// Facade-only audit reads (§8.6) — the thin consumer side of the subtask-03
// repository pair (also reachable via middleware/audit listAudit/countAudit;
// the facade is used directly here, matching data/moderation.js).
const {
  listAdminAudit,
  countAdminAudit,
  normalizeAuditOrigin,
} = require("../../db");
// Honest web-surface/env reads (resolved live; VALUES never rendered).
const {
  getHttpConfig,
  getSessionSecret,
  isSecureBaseUrl,
  warnIfInsecurePublicBaseUrl,
} = require("../config");
// The RESOLVED sqlite path (path only — not an env dump).
const { dbPath } = require("../../db/connection");
// Prune cadence constant only (the timer itself is not exposed in-process —
// the panel says "unknown" instead of guessing).
const { DEFAULT_PRUNE_INTERVAL_MS } = require("../auth/sessions");
const { rawParams, readFields, rawFlashQuery } = require("./shared/req.js");
const { shellGuilds } = require("./shared/shell.js");
const { makeFlashRedirect } = require("./shared/flash.js");
// Phase-4 System "Web sessions" (admin global session control): the policy
// layer + the SELF surface's shared vocabulary (selector parser, flash
// tables) — imported on purpose so both scopes validate identically.
const sessionPolicy = require("../auth/sessions");
const {
  parseRevokeField,
} = require("./sessions");
const {
  renderSystemSessionsBody,
  flashFromQuery: flashFromQuerySessions,
  FLASH_DONE: FLASH_DONE_SESSIONS,
  FLASH_ERROR: FLASH_ERROR_SESSIONS,
} = require("../views/sessions");



/* ------------------------------------------------------------------ audit ---- */

/**
 * Normalize the `?origin=` filter. Accepted: web | slash | system | all
 * (blank/absent ≡ all). Junk falls back to ALL with an `invalid` flag the
 * view renders as an escaped notice (moderation junk-filter UX — never a
 * 500, never a raw echo). The repo helper decides validity, so the
// whitelist can never drift from the CHECK constraint.
 * @param {string|null|undefined} raw
 * @returns {{ origin: string|null, invalid: boolean }} origin null = no filter
 */
function readOriginFilter(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s || s === "all") return { origin: null, invalid: false };
  const normalized = normalizeAuditOrigin(s);
  if (normalized.ok) return { origin: normalized.origin, invalid: false };
  return { origin: null, invalid: true };
}

/**
 * One bounded admin_audit page for ONE guild (viewer data half — Phase 3
 * parity checks read this same builder contract).
 *
 * @param {string} guildId MUST be req.guildAccess.guildId (never req.params)
 * @param {{ origin?: string|null, n?: string|null, o?: string|null }} query RAW query values
 * @param {object} [deps] facade overrides (tests)
 * @returns {{ rows: object[], total: number, offset: number, pageSize: number,
 *            origin: string|null, invalidOrigin: boolean }}
 */
function buildAuditPage(guildId, query = {}, deps = {}) {
  const list = deps.listAdminAudit || listAdminAudit;
  const count = deps.countAdminAudit || countAdminAudit;

  const { origin, invalid } = readOriginFilter(query.origin);
  const pageSize = readPageSize(query.n);
  const offset = readOffset(query.o);

  const opts = { limit: pageSize, offset };
  if (origin) opts.origin = origin;
  return {
    // Newest first (created_at DESC, id DESC) — idx_admin_audit_guild_created.
    rows: list(guildId, opts),
    total: count(guildId, origin ? { origin } : {}),
    offset,
    pageSize,
    origin,
    invalidOrigin: invalid,
  };
}

/* ----------------------------------------------------------------- system ---- */

/**
 * SESSION_SECRET source projection (§8.7): NAMES only, never a value.
 * dedicated ≡ a non-empty SESSION_SECRET (getSessionSecret's own trim rule);
 * fallback ≡ configured only via CLIENT_SECRET. Exported for the sentinel
 * test to pin the three states without forcing the app through a secretless
 * decrypt failure.
 * @returns {{ configured: boolean, source: "SESSION_SECRET" | "CLIENT_SECRET (fallback)" | "unset" | "unknown" }}
 */
function readSessionSecretState() {
  try {
    // Call the REAL resolver for the boolean so the precedence rule lives in
    // one place (web/config.getSessionSecret). The returned value is only
    // null-compared — it never leaves this function.
    const configured = getSessionSecret() != null;
    const dedicated = String(process.env.SESSION_SECRET ?? "").trim() !== "";
    const fallback = String(process.env.CLIENT_SECRET ?? "").trim() !== "";
    const source = dedicated
      ? "SESSION_SECRET"
      : configured && fallback
        ? "CLIENT_SECRET (fallback)"
        : "unset";
    return { configured, source };
  } catch {
    return { configured: false, source: "unknown" };
  }
}

/**
 * Web-surface state — booleans, the resolved port, the base URL and NAMES.
 * `insecureHttpWarning` echoes the SAME boot validation
 * (warnIfInsecurePublicBaseUrl): true ⇒ a non-localhost plain-HTTP base URL
 * would trigger (and here does re-emit) the boot console warning. No secret
 * value is read, held or rendered by any branch of this projection.
 * @returns {object}
 */
function readWebSurfaceState() {
  let port = null;
  let publicBaseUrl = null;
  let secureCookies = false;
  let insecureHttpWarning = false;
  try {
    ({ port, publicBaseUrl } = getHttpConfig());
  } catch {
    /* stay honest: nulls */
  }
  try {
    secureCookies = isSecureBaseUrl();
  } catch {
    /* keep false */
  }
  try {
    insecureHttpWarning = warnIfInsecurePublicBaseUrl() === true;
  } catch {
    /* keep false */
  }
  return {
    publicHttpPortConfigured: port != null,
    publicHttpPort: port,
    publicBaseUrl,
    secureCookies,
    insecureHttpWarning,
    sessionSecret: readSessionSecretState(),
  };
}

/**
 * Assemble the /system read model. Everything is in-process or ONE bounded
 * facade read (the command-permission OAuth PK row via the token-stripped
 * staffData projection) — the §8.6 query budget for this surface is one
 * indexed point lookup per page build. Sections degrade honestly.
 *
 * @param {string} guildId MUST be req.guildAccess.guildId
 * @param {object} sources
 * @param {() => Promise<Array<object>>} sources.getTickers ticker registry snapshot (never throws in practice)
 * @param {(guildId: string) => { oauth: { available: boolean, status: object|null } }} sources.getOauthStatus staffData read (token-stripped projection)
 * @param {() => any} sources.oauthConfigFn raw env reader (sanitized by readEnvConfig)
 * @param {number} [now]
 */
async function buildSystemStatus(guildId, sources = {}, now = Date.now()) {
  const uptimeMs = Math.round(
    Math.max(0, Number(process.uptime()) * 1000) || 0
  );

  let tickers = { available: false, rows: [] };
  try {
    const rows = await sources.getTickers();
    tickers = {
      available: true,
      rows: Array.isArray(rows) ? rows : [],
    };
  } catch {
    /* registry snapshot never throws by contract; degrade honestly */
  }

  let oauth = { available: false, status: null };
  try {
    const view = sources.getOauthStatus(guildId);
    oauth = view && view.oauth ? view.oauth : oauth;
  } catch {
    /* degrade: the panel renders "unknown", not a 500 */
  }

  let sqlitePath = null;
  try {
    sqlitePath = typeof dbPath === "string" ? dbPath : null;
  } catch {
    /* keep null */
  }

  return {
    generatedAt: now,
    process: {
      available: true,
      uptimeMs,
      startedAt: Math.round(now - uptimeMs),
      nodeVersion: String(process.version || ""),
      pid: process.pid,
    },
    sqlite: { path: sqlitePath },
    sessionPrune: {
      // auth/sessions.js runs the prune on boot + on an unref'd interval,
      // but exposes NO timer state in-process — report the cadence constant
      // and an HONEST unknown for the live state (subtask-22 spec).
      intervalMs: DEFAULT_PRUNE_INTERVAL_MS,
      state: "unknown",
      detail: "not exposed in-process",
    },
    tickers,
    webSurface: readWebSurfaceState(),
    oauthEnv: readEnvConfig(sources.oauthConfigFn),
    oauth,
  };
}

/**
 * @param {import("express").Express} app
 * @param {object} [options]
 * @param {{resolve: Function, listGuilds: Function}} [options.guildAccess]
 *   pre-built resolver (app.js passes the SAME instance the guild shell
 *   uses — one tier cache, §8.3); default builds one from the seams below.
 * @param {string} [options.apiBase] @param {typeof fetch} [options.fetchImpl]
 * @param {() => string[]|Promise<string[]>} [options.botGuilds]
 * @param {() => Promise<Array<object>>} [options.getTickerHealth] ticker
 *   provider override; default is the data/tickerHealth.js registry snapshot.
 * @param {{getOauthStatus: Function}} [options.staffData] pre-built
 *   createStaffData() instance (tests inject fakes; default is a process-wide
 *   lazily-built singleton — same pattern as routes/staff.js).
 * @param {() => any} [options.oauthConfig] env-config reader; default is the
 *   EXISTING features/commandPermissions/config.js reader (sanitized via the
 *   readEnvConfig imported from routes/staff.js — never re-implemented).
 */
function registerSystemRoutes(app, options = {}) {
  const resolver =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });

  const getTickers = options.getTickerHealth || (() => snapshotTickerHealth());

  let defaultData = null;
  const staffData =
    options.staffData ||
    {
      getOauthStatus: (guildId) => {
        if (!defaultData) defaultData = createStaffData();
        return defaultData.getOauthStatus(guildId);
      },
    };

  const oauthConfigFn =
    options.oauthConfig ||
    require("../../features/commandPermissions/config").getCommandPermissionOAuthConfig;

  // ---- admin: system health page (§8.6 System row = Admin) -----------------
  app.get("/g/:guildId/system", requireTier("admin"), async (req, res) => {
    const guildId = req.guildAccess.guildId; // never req.params (§8.6 scoping)
    const status = await buildSystemStatus(guildId, {
      getTickers,
      getOauthStatus: (id) => staffData.getOauthStatus(id),
      oauthConfigFn,
    });
    const document = renderShellPage(req, {
      title: "System",
      heading: "System",
      subheading:
        "Process health, ticker schedules, web-surface state and command-permission OAuth — status only; secret values are never shown.",
      content: renderSystemBody({ status }),
      guilds: await shellGuilds(resolver, req),
    });
    writeShellHtml(req, res, { status: 200, document });
  });

  // ---- admin: admin_audit viewer (§8.6 System row, Phase 1 read-only) ------
  app.get("/g/:guildId/audit", requireTier("admin"), async (req, res) => {
    const guildId = req.guildAccess.guildId; // guild-scoped ONLY (never from URL body)
    const params = rawParams(req.url);
    const page = buildAuditPage(guildId, {
      origin: params.get("origin"),
      n: params.get("n"),
      o: params.get("o"),
    });
    // §8.15-15.11: actor ids render as names when the member cache knows
    // them (cache-only, never fetch on the request path — misses warm via
    // the background member-fetch queue and self-heal on the next page view).
    const actorIds = [...new Set(
      page.rows.map((row) => row.actor_user_id).filter(Boolean).map(String)
    )].slice(0, 200);
    const names = resolveMemberNames(options.getClient ?? null, guildId, actorIds);
    const document = renderShellPage(req, {
      title: "Audit log",
      heading: "Audit log",
      subheading:
        "The append-only admin_audit trail (web + slash + system origins), newest first. Read-only — no exports, no deletes.",
      content: renderAuditBody(req, { page, names }),
      guilds: await shellGuilds(resolver, req),
    });
    writeShellHtml(req, res, { status: 200, document });
  });

  // =========================================================================
  // Phase 4 — System "Web sessions" (subtask web-admin-phase4-02, operator
  // decision BOTH scopes): ADMIN-tier global session list + revoke.
  //
  // HONEST FRAMING: web_sessions carries NO guild column — sessions are
  // global — so the page lists every live console session system-wide
  // instead of faking a per-guild slice (the guild shell only provides the
  // URL scope + audit guild; the audit viewer's guild-scoping rule does NOT
  // extend to a table that has no guild axis). Tier math is unchanged:
  // requireTier("admin") gates both the page and the mutation (in-guild
  // staff/senior ⇒ 403; cross-guild/stranger/anon ⇒ 404/302 upstream).
  //
  // Revocation semantics are the SELF surface's, verbatim: selector =
  // (target_user_id, created_at) — both non-secret, id NEVER accepted or
  // rendered (§8.7); already-gone ⇒ ?error=session_gone with zero writes;
  // exactly ONE fail-closed admin_audit row per success
  // (action sessions.revoke, details.scope "admin"); revoking the ADMIN'S
  // OWN current session through this page still performs the clean-logout
  // teardown (row + cookie) exactly like the self surface.
  // =========================================================================

  // LAZY require (ticketActions doctrine): app.js loads this module while
  // app.js itself is still loading; register only runs from createWebApp().
  const { registerWebMutation } = require("../app");

  /** Registry entry + Express route minted from ONE template constant. */
  const postSystemMutation = (template, handler) => {
    registerWebMutation(app, "POST", template);
    app.post(template, requireTier("admin"), handler);
  };

  const systemSessionsPageOf = (guildId) =>
    `/g/${encodeURIComponent(guildId)}/system/sessions`;

  const flashSessions = makeFlashRedirect({
    pageOf: systemSessionsPageOf,
    doneTable: FLASH_DONE_SESSIONS,
    errorTable: FLASH_ERROR_SESSIONS,
  });

  // ---- admin: global live-session list (System area) -----------------------
  app.get("/g/:guildId/system/sessions", requireTier("admin"), async (req, res) => {
    const guildId = req.guildAccess.guildId; // shell scope (list is system-wide)
    const sessions = sessionPolicy.listLiveSessions();
    // §8.15-15.11 names from the member cache ONLY (misses show ids; the
    // sessions are global so many owners are legitimately unknown here).
    const userIds = [...new Set(sessions.map((s) => s.userId))]
      .filter((id) => /^[0-9]{5,20}$/.test(String(id)))
      .slice(0, 200);
    const names = resolveMemberNames(options.getClient ?? null, guildId, userIds);
    const document = renderShellPage(req, {
      title: "Web sessions",
      heading: "Web sessions",
      subheading:
        "Every live web console session (system-wide — sessions are not per-guild). Revoke kills a lost or stolen device's cookie immediately.",
      content: renderSystemSessionsBody({
        guildId,
        sessions,
        currentId: req.webSession ? req.webSession.id : null,
        csrfToken: req.csrfToken || null,
        flash: flashFromQuerySessions(rawFlashQuery(req.url)),
        names,
      }),
      guilds: await shellGuilds(resolver, req),
    });
    writeShellHtml(req, res, { status: 200, document });
  });

  // ---- POST revoke ANY session (admin global control) ----------------------
  postSystemMutation("/g/:guildId/system/sessions/revoke", async (req, res) => {
    const guildId = req.guildAccess.guildId;
    const current = req.webSession || null;
    const fields = readFields(req);

    // Validation at the boundary — refusal answers PRG with ZERO write
    // helpers touched (ladder reject contract).
    const parsed = parseRevokeField(fields);
    if (!parsed.ok) {
      flashSessions(res, guildId, "error", parsed.errorSlug);
      return;
    }
    const targetUserId = String(fields.target_user_id == null ? "" : fields.target_user_id).trim();
    if (!/^[0-9]{5,20}$/.test(targetUserId)) {
      flashSessions(res, guildId, "error", "invalid_selection");
      return;
    }

    // Resolve WITHIN the named owner's own live rows (the pair
    // (target_user_id, created_at) must both match a live row — a stale or
    // hostile pairing is the honest session_gone answer, never a guess).
    const owned = sessionPolicy.listLiveSessionsForUser(targetUserId);
    const target = sessionPolicy.pickSessionByCreatedAt(
      owned,
      parsed.createdAt,
      current && current.userId === targetUserId ? current : null
    );
    if (!target) {
      flashSessions(res, guildId, "error", "session_gone");
      return;
    }

    const revoked = sessionPolicy.revokeSessionById(target.id);
    if (!revoked.ok) {
      flashSessions(res, guildId, "error", "session_gone");
      return;
    }

    const isCurrent = !!current && target.id === current.id;
    req.audit({
      action: "sessions.revoke",
      targetType: "session",
      targetId: String(target.createdAt),
      guildId,
      details: {
        scope: "admin",
        target_user_id: target.userId,
        created_at: target.createdAt,
        current: isCurrent,
      },
      // No mirror descriptor: no slash surface mirrors to a channel here.
    });

    if (isCurrent) {
      // The admin revoked their OWN current session through the admin page:
      // same clean-logout teardown as POST /auth/logout (row already gone).
      res.writeHead(302, {
        Location: "/",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Set-Cookie": sessionPolicy.buildClearSessionCookie(),
      });
      res.end();
      return;
    }
    flashSessions(res, guildId, "done", "session_revoked");
  });
}

module.exports = {
  registerSystemRoutes,
  // exported for the viewer-contract tests + Phase 3 parity checks:
  buildAuditPage,
  readOriginFilter,
  readSessionSecretState,
  readWebSurfaceState,
};
