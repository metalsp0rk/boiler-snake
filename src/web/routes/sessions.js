/**
 * GET /g/:guildId/sessions + POST /g/:guildId/sessions/revoke — the
 * self-service "Your sessions" surface (roadmap/web-admin.md §8.3 sessions;
 * subtask web-admin-phase4-02, operator decision: BOTH scopes — this module
 * is the SELF half; the admin half lives on the System area in
 * routes/system.js).
 *
 * WHO SEES WHAT: any logged-in console visitor (requireTier("staff") — the
 * floor every /g/ page already enforces via guildScope, which answers
 * tier-less visitors with the generic 404 upstream). The page lists ONLY
 * the viewer's own live sessions (the read is keyed off req.user.userId —
 * never a request-supplied id), and revoke can ONLY ever touch a session in
 * that same own-user list: another user's sessions are unaddressable here,
 * not merely hidden.
 *
 * REVOCATION DOCTRINE:
 *  - the form selector is created_at (a timestamp the user can already see),
 *    NEVER the session id — a session id is the cookie-equivalent of a
 *    credential and is never rendered, echoed, or accepted as input (§8.7);
 *  - revoking a NON-current row kills it (row gone ⇒ the cookie is dead on
 *    its next request, same resolution as logout);
 *  - revoking the CURRENT row is a clean logout: row destroyed, cookie torn
 *    down (Max-Age=0) and 302 to the signed-out landing
 *    (login.js SIGNED_OUT_TARGET) — byte-shaped like POST /auth/logout
 *    (login.js respondRedirect), so the visitor sees the "signed out"
 *    landing instead of an instant OAuth bounce;
 *  - revoking an already-gone/expired row reports `?error=session_gone`
 *    (known state, zero writes) — never a silent success.
 *
 * TIER + SECURITY CHOREOGRAPHY (ticketActions doctrine, unchanged):
 * methodGate (POST passes only because registerWebMutation carries the exact
 * template) → session → audit middleware → body cap → mutation rate limit →
 * CSRF (auto on /g/, hidden _csrf) → guildScope (anon ⇒ 302 login,
 * cross-guild/stranger ⇒ generic 404, never 403) → requireTier("staff") →
 * handler. One admin_audit row per successful revoke (origin 'web',
 * fail-closed via req.audit); the target is named by NON-secret selectors
 * (targetId = the created_at selector, details carry the human-readable
 * scope + owner) — an id NEVER enters the audit row.
 */

const { createGuildAccessResolver } = require("../auth/guildAccess");
const { SIGNED_OUT_TARGET } = require("../auth/login");
const { requireTier } = require("../middleware/requireTier");
const { renderShellPage, writeShellHtml } = require("../views/layout");
const sessions = require("../auth/sessions");
const { readFields, rawFlashQuery } = require("./shared/req.js");
const { makeFlashRedirect } = require("./shared/flash.js");
const { shellGuilds } = require("./shared/shell.js");
const {
  renderYourSessionsBody,
  flashFromQuery,
  FLASH_DONE,
  FLASH_ERROR,
} = require("../views/sessions");

/** Self-service surface (GET page + the revoke POST share the prefix). */
const SESSIONS_PAGE = "/g/:guildId/sessions";
const REVOKE_PATH = "/g/:guildId/sessions/revoke";

/**
 * created_at selector shape: digits only, ≤ 17 (JS-safe unix-ms). Junk,
 * arrays (readFields yields strings) and negative ids all fail shape-first
 * — zero reads, zero writes — exactly the moderation id-field doctrine.
 */
const CREATED_AT_RE = /^[1-9][0-9]{0,16}$/;

/**
 * Parse + validate the revoke selector field (pure validate-at-boundary).
 * @param {Record<string, unknown>} fields req.bodyFields
 * @returns {{ ok: true, createdAt: number } | { ok: false, errorSlug: string }}
 */
function parseRevokeField(fields) {
  const raw = String(fields.created_at == null ? "" : fields.created_at).trim();
  if (!CREATED_AT_RE.test(raw)) {
    return { ok: false, errorSlug: "invalid_selection" };
  }
  const createdAt = Number(raw);
  if (!Number.isSafeInteger(createdAt)) {
    return { ok: false, errorSlug: "invalid_selection" };
  }
  return { ok: true, createdAt };
}

/**
 * @param {import("express").Express} app
 * @param {object} [options]
 * @param {{resolve: Function, listGuilds: Function}} [options.guildAccess]
 *   pre-built resolver (app.js passes the SAME instance the guild shell
 *   uses — one tier cache, §8.3); default builds one from the seams below.
 * @param {string} [options.apiBase] @param {typeof fetch} [options.fetchImpl]
 * @param {() => string[]|Promise<string[]>} [options.botGuilds]
 */
function registerSessionsRoutes(app, options = {}) {
  const resolver =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });

  // LAZY require: route modules load while app.js itself is still loading
  // (ticketActions doctrine) — registerWebMutation only ever runs from
  // inside createWebApp(), long after ../app's exports are complete.
  const { registerWebMutation } = require("../app");

  /**
   * Structural lockstep: registry entry + Express route minted from ONE
   * template constant. Tier is the SHELL floor (staff): session management
   * is self-service, not a staff privilege — guildScope already denies
   * tier-less visitors upstream with the generic 404.
   */
  const postMutation = (template, handler) => {
    registerWebMutation(app, "POST", template);
    app.post(template, requireTier("staff"), handler);
  };

  const pageOf = (guildId) => `/g/${encodeURIComponent(guildId)}/sessions`;

  /** PRG 302 with a WHITELISTED flash slug (flag + slug re-checked against
   * the view's frozen vocabularies before Location exists — §8.7). */
  const flash = makeFlashRedirect({
    pageOf,
    doneTable: FLASH_DONE,
    errorTable: FLASH_ERROR,
  });

  /**
   * Clean-logout response for the current-session revocation: identical
   * header shape to POST /auth/logout (login.js respondRedirect +
   * buildClearSessionCookie) — the row is already destroyed by the caller;
   * this only tears the cookie down and sends the browser to the signed-out
   * landing (same destination as logout, per Exit C).
   * @param {import("http").ServerResponse} res
   */
  const respondLoggedOut = (res) => {
    res.writeHead(302, {
      Location: SIGNED_OUT_TARGET,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": sessions.buildClearSessionCookie(),
    });
    res.end();
  };

  // ---- staff (shell floor): YOUR sessions — own live rows only ------------
  app.get(SESSIONS_PAGE, requireTier("staff"), async (req, res) => {
    const guildId = req.guildAccess.guildId; // never req.params (§8.6 scoping)
    const mine = sessions.listLiveSessionsForUser(req.user.userId);
    const document = renderShellPage(req, {
      title: "Your sessions",
      heading: "Your sessions",
      subheading:
        "Every browser signed in to this console with your account. Revoke anything you do not recognize — revoking the current row signs you out.",
      content: renderYourSessionsBody({
        guildId,
        sessions: mine,
        currentId: req.webSession ? req.webSession.id : null,
        csrfToken: req.csrfToken || null,
        flash: flashFromQuery(rawFlashQuery(req.url)),
      }),
      guilds: await shellGuilds(resolver, req),
    });
    writeShellHtml(req, res, { status: 200, document });
  });

  // =========================================================================
  // Phase-4 self-service mutation: methodGate registry → CSRF (auto) →
  // requireTier("staff") → selector validation (zero writes on refusal) →
  // resolve WITHIN THE VIEWER'S OWN LIST (Exit C: other users' rows are
  // unaddressable) → revoke → ONE fail-closed req.audit row → PRG flash (or
  // clean logout when the current session itself was the target).
  // =========================================================================
  postMutation(REVOKE_PATH, async (req, res) => {
    const guildId = req.guildAccess.guildId;
    const current = req.webSession || null;

    const parsed = parseRevokeField(readFields(req));
    if (!parsed.ok) {
      flash(res, guildId, "error", parsed.errorSlug);
      return;
    }

    // Selection is scoped to the VIEWER'S OWN live rows by construction —
    // the list key is req.user.userId, never a body field. A selector that
    // matches nothing there is "already revoked or expired" (also the honest
    // answer for another user's id, which can never match here anyway).
    const mine = sessions.listLiveSessionsForUser(req.user.userId);
    const target = sessions.pickSessionByCreatedAt(mine, parsed.createdAt, current);
    if (!target) {
      flash(res, guildId, "error", "session_gone");
      return;
    }

    const revoked = sessions.revokeSessionById(target.id);
    if (!revoked.ok) {
      // Raced with expiry/prune/logout between list and delete: report the
      // known state — never claim a revocation that did not happen.
      flash(res, guildId, "error", "session_gone");
      return;
    }

    const isCurrent = !!current && target.id === current.id;
    // Audit BEFORE the cookie teardown (fail-closed: an audit throw aborts
    // with the generic 500 — the outcome is never silently claimed). The
    // row is already destroyed in that case: the stale cookie is dead on
    // its next request anyway (same fail-closed posture as logout).
    // NO session id anywhere in the entry (§8.7): targetId is the
    // user-visible created_at selector.
    req.audit({
      action: "sessions.revoke",
      targetType: "session",
      targetId: String(target.createdAt),
      guildId,
      details: {
        scope: "self",
        target_user_id: target.userId,
        created_at: target.createdAt,
        current: isCurrent,
      },
      // No mirror descriptor: nothing here mirrors a slash channel embed.
    });

    if (isCurrent) {
      respondLoggedOut(res);
      return;
    }
    flash(res, guildId, "done", "session_revoked");
  });
}

module.exports = {
  registerSessionsRoutes,
  parseRevokeField,
  SESSIONS_PAGE,
  REVOKE_PATH,
};
