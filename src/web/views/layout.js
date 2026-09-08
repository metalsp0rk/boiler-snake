/**
 * The guild-shell layout for every authenticated /g/:guildId page
 * (roadmap/web-admin.md §8.2, §8.6 "every /g/:guildId page renders in the
 * shell"; §8.8 Phase 0c "guild switcher shell").
 *
 * COMPOSED ENTIRELY with the escaped-by-default `html` helper
 * (./escape.js): guild names, user tags and every other interpolated value
 * are HTML-escaped unless explicitly marked safe, so a Discord display name
 * or guild name can never inject markup or attributes (§8.7 XSS; pinned by
 * test/web-views-layout.test.js).
 *
 * NO INLINE HANDLERS (§8.7 CSP): every <script> is an external, nonce'd
 * file under /static; interactivity (guild-switcher navigation, htmx CSRF
 * header wiring) lives in /static/app.js, never in on* attributes.
 *
 * ROUTE-AUTHOR API (Phase 1+):
 *   const doc = renderShellPage(req, {
 *     title: "Tickets",
 *     heading: "Tickets",
 *     subheading: "…",            // optional one-liner under the h1
 *     content: html`…`,           // page body (escape.js fragment)
 *     guilds: [{ id, name }],     // viewer's switcher list (bot∩user)
 *   });
 *   writeShellHtml(req, res, { status: 200, document: doc });
 * renderShellPage pulls user/tag (req.user), the tier badge
 * (req.guildAccess.tier — set by middleware/guildScope.js), the CSRF token
 * (req.csrfToken — set by middleware/csrf.js) and the per-response CSP nonce
 * (res.locals.cspNonce — set by middleware/csp.js) off the request.
 */

const { html, raw } = require("./escape");
const { tierBadge, degradedBanner } = require("./components");

/** Vendored htmx — bump together with the file under public/vendor (§8.7). */
const HTMX_SRC = "/static/vendor/htmx.2.0.10.min.js";
const APP_SRC = "/static/app.js";
const STYLES_SRC = "/static/styles.css";

/** Display name for a guild entry (never empty — fall back to the id). */
function guildLabel(guild) {
  const name = typeof guild?.name === "string" ? guild.name.trim() : "";
  return name || guild.id;
}

/**
 * The guild-switcher <select>: EXACTLY the viewer's accessible guilds
 * (bot∩user list from auth/guildAccess.js — never the bot's full guild list,
 * never guilds the viewer cannot open; §8.3). Navigation is wired by
 * app.js via the data-guild-switcher attribute (no inline on* handler);
 * <noscript> users keep the page they are on.
 *
 * @param {Array<{id: string, name?: string|null}>} guilds
 * @param {string|null} currentGuildId
 */
function renderGuildSwitcher(guilds, currentGuildId) {
  const options = (Array.isArray(guilds) ? guilds : [])
    .map((g) =>
      html`<option value="/g/${g.id}"${g.id === currentGuildId ? raw(" selected") : html``}>${guildLabel(g)}</option>\n`
    );
  return html`
      <nav class="guild-switcher" aria-label="Guild switcher">
        <label for="guild-switcher">Guild</label>
        <select id="guild-switcher" data-guild-switcher>
          ${options}
        </select>
      </nav>`;
}

/**
 * Full shell document. Prefer {@link renderShellPage} (derives everything
 * from the request); call this directly only for specially-shaped pages.
 *
 * @param {object} opts
 * @param {string} opts.title <title> text
 * @param {import("./escape").SafeString|string} opts.content <main> body
 * @param {string} [opts.heading] h1 text (defaults to title)
 * @param {string} [opts.subheading]
 * @param {Array<{id: string, name?: string|null}>} [opts.guilds] switcher list
 * @param {string|null} [opts.currentGuildId]
 * @param {string|null} [opts.tier] current guild tier → badge
 * @param {boolean} [opts.degraded] §8.3 degraded-resolver banner
 * @param {{userId?: string, discordTag?: string|null}|null} [opts.user]
 * @param {string|null} [opts.csrfToken] logout-form token
 * @param {string} [opts.nonce] per-response CSP nonce (res.locals.cspNonce)
 * @returns {import("./escape").SafeString}
 */
function renderLayout(opts) {
  const {
    title,
    content,
    heading = title,
    subheading = null,
    guilds = [],
    currentGuildId = null,
    tier = null,
    degraded = false,
    user = null,
    csrfToken = null,
    nonce = "",
  } = opts;

  // Every <script> tag carries the per-response nonce (external files do not
  // strictly need it under `script-src 'self' 'nonce-…'`, but pinning the
  // nonce on every tag makes "did the middleware run?" unforgeable/auditable).
  const nonceAttr = nonce ? html` nonce="${nonce}"` : html``;
  const homeHref = currentGuildId ? `/g/${currentGuildId}` : "/";
  const userTag = user ? user.discordTag || user.userId || "signed in" : "";

  return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} · Boiler Snake</title>
<link rel="stylesheet" href="${STYLES_SRC}"/>
<script src="${HTMX_SRC}" defer${nonceAttr}></script>
<script src="${APP_SRC}" defer${nonceAttr}></script>
</head>
<body data-csrf-token="${csrfToken || ""}">
<header class="shell-bar">
  <a class="brand" href="${homeHref}">Boiler Snake</a>
  ${renderGuildSwitcher(guilds, currentGuildId)}
  ${tierBadge(tier)}
  <div class="user-box">
    <span class="user-tag">${userTag}</span>
    <form method="post" action="/auth/logout" class="logout-form">
      <input type="hidden" name="_csrf" value="${csrfToken || ""}"/>
      <button type="submit" class="btn btn-logout">Sign out</button>
    </form>
  </div>
</header>
${degraded ? degradedBanner() : html``}
<noscript><p class="noscript-hint">Guild switching needs JavaScript; every page is still reachable via its /g/&lt;guildId&gt; URL.</p></noscript>
<main class="shell-main">
  <h1>${heading}</h1>
  ${subheading ? html`<p class="subheading">${subheading}</p>` : html``}
  ${content}
</main>
<footer class="shell-footer">Boiler Snake web console · <a href="/health">/health</a></footer>
</body>
</html>`;
}

/**
 * Shell page for a /g/:guildId route (the Phase 1+ convenience wrapper).
 * Everything identity-related is read off the request — the ONLY view inputs
 * are server-derived values (see file header for the contract).
 *
 * @param {object} req Express request (post guildScope + csrf + csp)
 * @param {object} page
 * @param {string} page.title
 * @param {import("./escape").SafeString|string} [page.content]
 * @param {string} [page.heading]
 * @param {string} [page.subheading]
 * @param {Array<{id: string, name?: string|null}>} [page.guilds]
 * @param {string} [page.nonce] override (tests); default res.locals.cspNonce
 * @returns {import("./escape").SafeString}
 */
function renderShellPage(req, page) {
  const access = req.guildAccess || {};
  return renderLayout({
    title: page.title,
    heading: page.heading,
    subheading: page.subheading,
    content: page.content || "",
    guilds: page.guilds || [],
    currentGuildId: access.guildId || null,
    tier: access.tier || null,
    degraded: !!access.degraded,
    user: req.user || null,
    csrfToken: req.csrfToken || null,
    nonce: page.nonce ?? (req.res && req.res.locals ? req.res.locals.cspNonce : "") ?? "",
  });
}

/**
 * Shell-styled error page (404/500 variants for Phase 1 routes that opt in).
 *
 * NOT wired into the app-wide catch-all or middleware/guildScope.js: those
 * keep answering the generic plain-text "Not found"/"Internal error"
 * everywhere — including inside /g/* — because (a) the Phase 0a byte-parity
 * doctrine pins the legacy bodies and (b) scoped misses, cross-guild probes
 * and unknown paths must stay INDISTINGUISHABLE (no surface to probe).
 * Use this only where a distinct in-shell error is strictly better UX and
 * cannot leak access-list membership.
 *
 * @param {object} req
 * @param {{status: number, title?: string, message?: string, guilds?: Array}} err
 */
function renderShellError(req, err) {
  return renderShellPage(req, {
    title: err.title || (err.status === 404 ? "Not found" : "Something went wrong"),
    content: html`<p class="error-body">${err.message || "The requested page is not available."}</p>`,
    guilds: err.guilds,
  });
}

/**
 * Raw writeHead framing for shell HTML (the app doctrine: never
 * res.send()/res.json() — Express framing must never touch a response).
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ status?: number, document: import("./escape").SafeString|string }} out
 */
function writeShellHtml(req, res, { status = 200, document }) {
  const body = Buffer.from(String(document), "utf8");
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    // Authenticated console pages: never cached (tier/CSRF/nonce per response).
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": body.length,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

module.exports = {
  renderLayout,
  renderShellPage,
  renderShellError,
  writeShellHtml,
  HTMX_SRC,
  APP_SRC,
  STYLES_SRC,
};
