/**
 * Guild-scoped ticket ARCHIVE inside the shell (roadmap §8.15): GET
 * /g/:guildId/t — the same rows, search and people cells as the
 * canonical /t archive, but rendered INSIDE the guild shell (sidebar,
 * switcher, active nav). Lives under the /g/:guildId guildScope mounted by
 * routes/dashboard.js, so gates are shared, not re-implemented:
 *   anonymous ⇒ login redirect (guildScope), stranger/cross-guild ⇒ generic
 *   404 (guildScope), staff+ ⇒ view (requireTier("staff") — the same tier
 *   the /t index scoping enforces; mutations remain on /g/:guildId/tickets
 *   at senior).
 *
 * The /t surface stays CANONICAL: transcript documents and assets are still
 * only served by routes/transcripts.js (Phase 0a byte-parity doctrine);
 * this route links to /t/{token}, it never serves the document itself.
 *
 * Failure contract (AGENTS.md): the whole handler is wrapped; a break logs
 * with the guild id and answers the generic 500 — never a half-page.
 */

const { renderTicketIndexContent } = require("../views/tickets/indexPage");
const { renderShellPage, writeShellHtml } = require("../views/layout");
const { requireTier } = require("../middleware/requireTier");
const { resolveMemberNames } = require("./shared/discord-cache");
const { createGuildAccessResolver } = require("../auth/guildAccess");
const { listArchivedTickets, countArchivedTickets } = require("../../db");

/** Rows per page — same page size as the /t archive. */
const PAGE_SIZE = 50;

/**
 * @param {import("express").Express} app
 * @param {object} [options]
 * @param {{resolve: Function, listGuilds: Function}} [options.guildAccess]
 * @param {string} [options.apiBase] @param {typeof fetch} [options.fetchImpl]
 * @param {() => Promise<string[]>|string[]} [options.botGuilds]
 * @param {(() => object|null)|null} [options.getClient] live client (names)
 */
function registerGuildArchiveRoutes(app, options = {}) {
  const resolver =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });

  // Single path (no trailing-slash alias): matches EVERY other /g shell page.
  app.get("/g/:guildId/t", requireTier("staff"), async (req, res) => {
    try {
      const guildId = req.guildAccess.guildId;
      const url = new URL(req.url || "/", "http://localhost");
      const q = String(url.searchParams.get("q") || "").trim().slice(0, 100);

      let page = Number(url.searchParams.get("page") || 1);
      if (!Number.isFinite(page) || page < 1) page = 1;

      // Guild comes from the URL PARAM already vetted by guildScope — the
      // query can only ever set q/page, never the guild (§8.6 no-enumeration).
      const total = countArchivedTickets({ guildId, q });
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (page > totalPages) page = totalPages;
      const tickets = listArchivedTickets({
        guildId,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        q,
      });

      const ids = [];
      for (const t of tickets) {
        for (const id of [t.creator_user_id, t.staff_owner_id, t.closed_by_user_id]) {
          if (id) ids.push(String(id));
        }
      }
      const names = resolveMemberNames(options.getClient, guildId, ids);

      // Switcher: same cached staffed list the shell uses; the viewed guild
      // ALWAYS renders (shell doctrine), even when the read degraded.
      let guilds = [{ id: guildId, name: guildId }];
      try {
        const listed = await resolver.listGuilds(req.webSession);
        if (listed && Array.isArray(listed.guilds) && listed.guilds.length > 0) {
          guilds = listed.guilds.slice();
          if (!guilds.some((g) => g.id === guildId)) {
            guilds.unshift({ id: guildId, name: guildId });
          }
        }
      } catch {
        /* switcher is a convenience; the archive body stands without it */
      }

      const document = renderShellPage(req, {
        title: "Ticket archive",
        heading: "Ticket archive",
        content: renderTicketIndexContent({
          tickets,
          total,
          page,
          pageSize: PAGE_SIZE,
          guildId,
          q,
          namesByGuild: new Map([[guildId, names]]),
          baseUrl: `/g/${guildId}/t`,
          inShell: true,
        }),
        guilds,
      });
      writeShellHtml(req, res, { status: 200, document });
    } catch (err) {
      console.error(
        `[web] guild archive failed guild=${req && req.params ? req.params.guildId : "?"}:`,
        err?.message || err
      );
      res.writeHead(500, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end("Internal error");
    }
  });
}

module.exports = {
  registerGuildArchiveRoutes,
  PAGE_SIZE,
};
