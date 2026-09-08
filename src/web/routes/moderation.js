/**
 * Web moderation list pages (roadmap/web-admin.md §8.6 "Moderation:
 * warnings list/issue/void, notes | Staff | Staff | 1 read · 3 write",
 * subtask 17 — this file ships the READ half only; issue/void/note writes
 * are Phase 3 / subtask 29 and MUST NOT be added here in Phase 1).
 *
 * Routes (UNDER the /g/:guildId guildScope mounted by dashboard/guildShell —
 * register AFTER registerGuildShellRoutes in app.js, like routes/users.js):
 *   GET /g/:guildId/warnings — staff+ — guild-wide warnings, filters:
 *        u (subject snowflake) · state=active|voided|all (default active,
 *        mirroring slash) · n page size (≤100) · o offset (≤1000)
 *   GET /g/:guildId/notes    — staff+ — guild-wide staff notes, filters:
 *        u · state=active|all (all ≡ slash include_deleted, rows BADGED)
 *        · n · o
 *
 * Access semantics (identical contract to routes/users.js, §8.6):
 *  - anonymous            → 302 /auth/login?guild=…   (guildScope)
 *  - stranger/cross-guild → generic 404 "Not found"   (guildScope, never 403)
 *  - wrong tier in-GUILD  → 403 "Forbidden"           (requireTier — guildScope
 *                           already 404s no-tier members, so staff+ reaches)
 *  - junk `?u=` → unfiltered page + escaped notice banner (list pages
 *   degrade like the users SEARCH page; only path params would 404).
 *
 * Slash data parity (equivalence notes in the completion report):
 *  - /warn list (per-user, page 10, include_voided default false) → the web
 *    page is the guild-wide superset with the same default-hidden-voided
 *    semantics + a web-only voided-only state;
 *  - /note list without `user` (recent guild feed capped 15, offset 0) →
 *    the web page is its proper paginated generalization (≤100/page);
 *  - the subject-scoped views already exist on the user profile page
 *    (routes/users.js) — these pages mirror the SAME rows/filters so no
 *    second source of truth exists: both read the same repositories.
 */

const { createGuildAccessResolver } = require("../auth/guildAccess");
const { requireTier } = require("../middleware/requireTier");
const { renderShellPage, writeShellHtml } = require("../views/layout");
const { renderWarningsBody, renderNotesBody } = require("../views/moderation");
const { buildWarningsPage, buildNotesPage } = require("../data/moderation");

/**
 * Parse the RAW url query (app doctrine: never req.query — the Express 5
 * "simple" parser and path-to-regexp decoding must not decide behavior
 * here; same local helper as routes/users.js, deliberately duplicated
 * rather than reaching into another owner's route module).
 * @param {string} rawUrl
 * @returns {URLSearchParams}
 */
function rawParams(rawUrl) {
  const idx = String(rawUrl || "").indexOf("?");
  return new URLSearchParams(idx === -1 ? "" : String(rawUrl).slice(idx + 1));
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
 */
function registerModerationRoutes(app, options = {}) {
  const resolver =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });

  // ---- staff: guild-wide warnings list -------------------------------------
  app.get("/g/:guildId/warnings", requireTier("staff"), async (req, res, next) => {
    try {
      const guildId = req.guildAccess.guildId;
      const params = rawParams(req.url);
      const page = buildWarningsPage(guildId, {
        u: params.get("u"),
        state: params.get("state"),
        n: params.get("n"),
        o: params.get("o"),
      });
      const document = renderShellPage(req, {
        title: "Warnings",
        heading: "Warnings",
        subheading: "Guild-wide formal record — voided rows stay, badged. Read-only; issuing/voiding lands in Phase 3.",
        content: renderWarningsBody(req, { page }),
        guilds: await shellGuilds(resolver, req),
      });
      writeShellHtml(req, res, { status: 200, document });
    } catch (err) {
      next(err); // → handleAppError: generic 500, nothing leaked
    }
  });

  // ---- staff: guild-wide staff-notes list ----------------------------------
  app.get("/g/:guildId/notes", requireTier("staff"), async (req, res, next) => {
    try {
      const guildId = req.guildAccess.guildId;
      const params = rawParams(req.url);
      const page = buildNotesPage(guildId, {
        u: params.get("u"),
        state: params.get("state"),
        n: params.get("n"),
        o: params.get("o"),
      });
      const document = renderShellPage(req, {
        title: "Staff notes",
        heading: "Staff notes",
        subheading: "Guild-wide staff-only memory — soft-deleted rows stay hidden until revealed, exactly like /note list. Read-only.",
        content: renderNotesBody(req, { page }),
        guilds: await shellGuilds(resolver, req),
      });
      writeShellHtml(req, res, { status: 200, document });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = {
  registerModerationRoutes,
};
