/**
 * The guild shell (roadmap/web-admin.md §8.8 Phase 0c: "Guild switcher
 * shell"; §8.6 "every /g/:guildId page renders in the shell").
 *
 * Replaces the subtask-06 login-gate placeholder:
 *  - middleware/guildScope.js is mounted on the /g/:guildId prefix (its
 *    documented Phase 0c mount), so EVERY deep /g route is scoped before it
 *    runs: anonymous / re-auth ⇒ the byte-identical login redirect (the
 *    web-auth-login oracle net pins it), scoped-out / unknown / cross-guild
 *    ⇒ the generic plain "Not found" (§8.6, never 403);
 *  - GET /g/:guildId renders the Console placeholder INSIDE the shell
 *    (header with app name + guild switcher + tier badge + user tag +
 *    logout form, footer with /health). Real dashboard data arrives with
 *    the Phase 1 read views; they reuse the same layout API
 *    (views/layout.js — renderShellPage + writeShellHtml).
 *
 * The switcher list comes from auth/guildAccess.js `listGuilds` — the SAME
 * cached bot∩user access list the scope gate decides on, so a switcher entry
 * can never 404 on click (§8.3).
 *
 * 404 SHAPE DECISION (subtask 11): scoped misses inside /g/* intentionally
 * keep the app-wide plain-text "Not found" — guildScope already answers
 * every deny with it, unmatched /g paths fall through to the app catch-all
 * (same bytes), and unknown/cross-guild/nonexistent must stay
 * indistinguishable. A shell-styled error page exists
 * (views/layout.js renderShellError) for Phase 1 routes that need richer
 * in-shell errors WITHOUT touching that indistinguishability contract.
 */

const { createGuildAccessResolver } = require("../auth/guildAccess");
const { createGuildScopeMiddleware } = require("../middleware/guildScope");
const { renderShellPage, writeShellHtml } = require("../views/layout");
const { html } = require("../views/escape");

/**
 * @param {import("express").Express} app
 * @param {object} [options]
 * @param {{resolve: Function, listGuilds: Function}} [options.guildAccess]
 *   pre-built resolver (tests / future wiring); default builds one from
 *   apiBase / fetchImpl / botGuilds — the same seam createWebApp exposes.
 * @param {string} [options.apiBase] @param {typeof fetch} [options.fetchImpl]
 * @param {() => Promise<string[]>|string[]} [options.botGuilds]
 */
function registerGuildShellRoutes(app, options = {}) {
  const resolver =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });

  // Security gate first — anon/re-auth redirect and generic-404 denies are
  // guildScope's contract (byte-identical to the placeholder's redirect).
  app.use("/g/:guildId", createGuildScopeMiddleware({ resolver }));

  app.get("/g/:guildId", async (req, res) => {
    // Cached (TTL) read of the same list resolve() just gated against —
    // normally zero network. A switcher must always show the guild being
    // viewed even if this degraded read came back empty.
    const listed = await resolver.listGuilds(req.webSession);
    const guilds = listed.guilds.slice();
    const currentId = req.guildAccess.guildId;
    if (!guilds.some((g) => g.id === currentId)) {
      guilds.unshift({ id: currentId, name: currentId });
    }

    const document = renderShellPage(req, {
      title: "Console",
      heading: "Console",
      subheading: "The read-only dashboard (activity, tickets, tickers) lands in Phase 1.",
      content: html`
        <section class="console-placeholder">
          <p>
            Shell online — the header, guild switcher and logout work already;
            guild panels arrive with the Phase 1 read views.
          </p>
        </section>`,
      guilds,
    });
    writeShellHtml(req, res, { status: 200, document });
  });
}

module.exports = {
  registerGuildShellRoutes,
};
