/**
 * The guild-shell layout for every authenticated /g/:guildId page
 * (roadmap/web-admin.md §8.2, §8.6 "every /g/:guildId page renders in the
 * shell"; §8.8 Phase 0c "guild switcher shell"; §8.15 UX v1.1 left sidebar;
 * #642 shell rebuild: single dark system, phone-collapsible sidebar,
 * scannable grouped navigation, breadcrumb + flash slot inside <main>).
 *
 * COMPOSED ENTIRELY with the escaped-by-default `html` helper
 * (./escape.js): guild names, user tags and every other interpolated value
 * are HTML-escaped unless explicitly marked safe, so a Discord display name
 * or guild name can never inject markup or attributes (§8.7 XSS; pinned by
 * test/web-views-layout.test.js).
 *
 * NO INLINE HANDLERS (§8.7 CSP): every <script> is an external, nonce'd
 * file under /static; interactivity (guild-switcher navigation, nav toggle,
 * header wiring) lives in /static/app.js, never in on* attributes.
 *
 * JS-IS-ON DOCTRINE (#642): the signed-in console REQUIRES JavaScript —
 * the old <noscript> guild hint is gone (typing /g/<id> is still a URL).
 * The signed-out landing page loads no app.js and is untouched.
 *
 * SHELL STRUCTURE (#642, fixed order; #711 forge chrome):
 *   skip link (first focusable) → header (logo lockup, guild switcher, tier
 *   badge, user box + sign out, Menu button) → [degraded banner] →
 *   .bs-shell grid (sidebar nav + <main id="content">). Inside main the
 *   breadcrumb is the FIRST node; the optional `flash` slot (SafeString)
 *   follows it, BEFORE the single <h1>; `lede` (wins over the supported
 *   `subheading` alias) and the optional `actions` (SafeString) ride under
 *   the h1. A page either passes `flash` or renders one banner in its own
 *   content — never both.
 *
 * ROUTE-AUTHOR API (Phase 1+):
 *   const doc = renderShellPage(req, {
 *     title: "Tickets",
 *     heading: "Tickets",
 *     subheading: "…",            // optional one-liner under the h1
 *     lede: "…",                  // optional; wins over subheading
 *     flash: banner("info", "…"), // optional shell flash slot (SafeString)
 *     actions: raw("…"),          // optional page actions row (SafeString)
 *     content: html`…`,           // page body (escape.js fragment)
 *     guilds: [{ id, name }],     // viewer's switcher list (bot∩user)
 *   });
 *   writeShellHtml(req, res, { status: 200, document: doc });
 * renderShellPage pulls user/tag (req.user), the tier badge
 * (req.guildAccess.tier — set by middleware/guildScope.js), the CSRF token
 * (req.csrfToken — set by middleware/csrf.js), the active-nav path (req.path)
 * and the per-response CSP nonce (res.locals.cspNonce — set by
 * middleware/csp.js) off the request.
 */

const { html, raw } = require("./escape");
const { tierBadge, degradedBanner } = require("./components");
const { readBuildManifest, forgePublicPaths } = require("../assets/stamp");

/**
 * ASSET CACHE-BUSTING (§8.7): /static/* is served immutable, max-age=1y,
 * no ETag/Last-Modified — the URL is the ONLY invalidation lever. UX v1.1
 * proved the doctrine bites: bare "/static/styles.css" pinned one-year-old
 * CSS against new markup (unstyled sidebar). The release version rides as
 * a query and changes on every release.
 * (The static middleware ignores queries when resolving files.)
 * #642: the release version is suffixed per shell-revision so operators on
 * an old immutable copy pick up the rebuilt styles.css/app.js WITHOUT a
 * package version bump; later issues that touch these files bump the suffix.
 */
const ASSET_VERSION = `${require("../../../package.json").version}-shell11`;

/**
 * Vendored Chart.js UMD (Phase 4 charts, operator decision 2026-09-25) —
 * same §8.7 procedure: npm-tarball sha512-verified, version baked
 * into the FILENAME (the cache-buster, /static is immutable), MIT text in
 * public/vendor/LICENSE.md beside it. Classic <script src> from self:
 * CSP `script-src 'self'` admits it without a nonce; the nonce ATTRIBUTE
 * still rides every tag (auditable "the middleware ran", see renderLayout).
 * defer keeps document order → globalThis.Chart exists before app.js runs.
 */
const CHART_SRC = "/static/vendor/chart.4.5.1.min.js";
const APP_SRC = `/static/app.js?v=${ASSET_VERSION}`;
const STYLES_SRC = `/static/styles.css?v=${ASSET_VERSION}`;
/** Header logo lockup (256×256 source, rendered 28×28; alt="" because the
 *  "Boiler Snake" word stays visible at every width — the image is decor). */
const LOGO_SRC = `/static/logo.png?v=${ASSET_VERSION}`;

/** Hashed forge CSS/JS. Cached after the first render (the stamp is stable
 *  for the life of the process; a rebuild restarts the server). */
let forgeAssets = null;
function forgeAssetTags() {
  if (forgeAssets) return forgeAssets;
  try {
    forgeAssets = forgePublicPaths(readBuildManifest());
  } catch (err) {
    throw new Error(
      `[web] forge assets are not built (${err?.message || err}). Run \`npm run assets:build\`.`
    );
  }
  return forgeAssets;
}

/**
 * LEFT SIDEBAR NAV (#642 tree; roadmap/web-admin.md §8.15). Static definition:
 * groups in visual order, items keyed by the path suffix under /g/:guildId.
 * minTier mirrors the ROUTE tier of the target page — the nav only hides
 * what the middleware would deny anyway; it is cosmetic, NEVER a gate.
 * Items the viewer cannot open stay HIDDEN, not disabled. `under: "/events"`
 * children (Events sub-pages) render ONLY while the current path is
 * /events or starts with /events/ — the list stays scannable everywhere else.
 */
const TIER_RANK = Object.freeze({ staff: 1, senior: 2, admin: 3 });
const NAV_GROUPS = Object.freeze([
  {
    label: "Overview",
    items: [
      { suffix: "", label: "Dashboard" },
      { suffix: "/voice", label: "Voice" },
    ],
  },
  {
    label: "People",
    items: [
      { suffix: "/users", label: "Users" },
      { suffix: "/leaderboard", label: "Leaderboard" },
      { suffix: "/xp/grant", label: "Grant XP", minTier: "admin" },
    ],
  },
  {
    label: "Moderation",
    items: [
      { suffix: "/warnings", label: "Warnings" },
      { suffix: "/notes", label: "Staff notes" },
      { suffix: "/tickets", label: "Ticket actions", minTier: "senior" },
      // §8.15 first-class archive: guild-scoped shell view of /t (sidebar
      // stays; transcript docs still served by the canonical /t surface).
      { suffix: "/t", label: "Ticket archive", minTier: "staff" },
    ],
  },
  {
    label: "Community",
    items: [
      // Community Events calendar (#222) — month view, drafts, attendees,
      // archive, presets, series, scheduled posts. Staff tier = the route
      // tier of routes/events.js. Sub-pages surface only under /events*.
      { suffix: "/events", label: "Events", minTier: "staff" },
      { suffix: "/events/archive", label: "Event archive", minTier: "staff", under: "/events" },
      { suffix: "/events/scheduled", label: "Scheduled", minTier: "staff", under: "/events" },
      { suffix: "/events/series", label: "Series", minTier: "staff", under: "/events" },
      { suffix: "/events/presets", label: "Presets", minTier: "staff", under: "/events" },
    ],
  },
  {
    label: "Configuration",
    items: [
      { suffix: "/settings", label: "Settings" },
      { suffix: "/staff", label: "Staff roles" },
      { suffix: "/commands", label: "Command visibility" },
      { suffix: "/integrations", label: "Integrations" },
    ],
  },
  {
    label: "Account",
    items: [
      // Phase 4 self-service session control (shell floor — every console
      // visitor has their own sessions to audit/revoke).
      { suffix: "/sessions", label: "Your sessions", minTier: "staff" },
    ],
  },
  {
    label: "Admin",
    items: [
      { suffix: "/system", label: "System", minTier: "admin" },
      // Phase 4 admin global session control (System-area surface).
      { suffix: "/system/sessions", label: "Web sessions", minTier: "admin" },
      { suffix: "/audit", label: "Audit trail", minTier: "admin" },
    ],
  },
]);

/**
 * Normalize a request path to the shell-relative sub-path ("" = dashboard).
 * "/g/7/tickets" → "/tickets"; "/g/7" → ""; "/t" (passed literally by the
 * transcript view) stays "/t".
 */
function navSubPath(path, base) {
  let sub = typeof path === "string" ? path : "";
  if (base && sub.startsWith(base)) sub = sub.slice(base.length);
  if (!sub.startsWith("/")) sub = `/${sub}`;
  if (sub.length > 1 && sub.endsWith("/")) sub = sub.slice(0, -1);
  if (sub === "/") sub = "";
  return sub;
}

/** True when `sub` is at `suffix` or below it (Dashboard's "" matches "" only). */
function navItemMatches(sub, suffix) {
  if (suffix === "") return sub === "";
  return sub === suffix || sub.startsWith(`${suffix}/`);
}

/**
 * Longest-suffix match: /events/archive marks "Event archive" current, NOT
 * "Events"; /system/sessions marks "Web sessions", NOT "System". Exactly one
 * item can ever be current, so never two links are marked.
 * @returns {{group: object, item: object}|null}
 */
function findActiveNavItem(sub) {
  let best = null;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (
        navItemMatches(sub, item.suffix) &&
        (!best || item.suffix.length > best.item.suffix.length)
      ) {
        best = { group, item };
      }
    }
  }
  return best;
}

/** Events sub-pages stay hidden until the viewer is under /events. */
function navItemVisible(item, sub) {
  if (!item.under) return true;
  return sub === item.under || sub.startsWith(`${item.under}/`);
}

/**
 * Tier-gated sidebar navigation for a guild page. Renders NOTHING without a
 * guild or a resolvable tier. Pure SSR — links only, no JS (§8.2 SSR-first);
 * the phone collapse is app.js adding body.nav-collapsed (never server-side).
 *
 * @param {string|null} guildId
 * @param {string|null} tier viewer tier in this guild
 * @param {string} path current request path (drives the active highlight)
 * @returns {import("./escape").SafeString}
 */
function renderSideNav(guildId, tier, path) {
  const rank = TIER_RANK[tier] ?? 0;
  if (!guildId || rank === 0) return html``;
  const base = `/g/${guildId}`;
  const sub = navSubPath(path, base);
  const active = findActiveNavItem(sub);
  const groups = NAV_GROUPS.map((group) => {
    const items = group.items
      .filter((it) => (TIER_RANK[it.minTier] ?? 1) <= rank)
      .filter((it) => navItemVisible(it, sub))
      .map((it) => {
        const isActive = Boolean(active) && active.item === it;
        return html`<a href="${base}${it.suffix}"${
          isActive ? raw(' class="active" aria-current="page"') : html``
        }>${it.label}</a>`;
      });
    if (!items.length) return html``;
    return html`<div class="bs-nav-group"><h2>${group.label}</h2>${items}</div>`;
  });
  // id="shell-nav" is the Menu button's aria-controls target (#642).
  return html`<aside class="bs-nav" id="shell-nav" aria-label="Console navigation">${groups}</aside>`;
}

/** Display name for a guild entry (never empty — fall back to the id). */
function guildLabel(guild) {
  const name = typeof guild?.name === "string" ? guild.name.trim() : "";
  return name || guild.id;
}

/**
 * The guild-switcher <select>: EXACTLY the viewer's accessible guilds
 * (bot∩user list from auth/guildAccess.js — never the bot's full guild list,
 * never guilds the viewer cannot open; §8.3). Navigation is wired by
 * app.js via the data-guild-switcher attribute (no inline on* handler).
 * Hidden entirely when the list is empty (root/lobby pages render their
 * guild list in the body).
 *
 * @param {Array<{id: string, name?: string|null}>} guilds
 * @param {string|null} currentGuildId
 */
function renderGuildSwitcher(guilds, currentGuildId) {
  // Fluxer PR 2: options LINK by integer community id; entries without a
  // communities row cannot be opened, so they render disabled (label-only).
  const linkId = (g) => (g.communityId != null ? g.communityId : g.id);
  const options = (Array.isArray(guilds) ? guilds : [])
    .map((g) =>
      html`<option value="/g/${linkId(g)}"${
        g.communityId == null ? raw(" disabled") : html``
      }${linkId(g) === currentGuildId ? raw(" selected") : html``}>${guildLabel(g)}</option>\n`
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
 * Breadcrumb: `Guild name / Group / Page` derived from NAV_GROUPS plus the
 * guild label already on the switcher (#642) — zero extra fetches. The guild
 * crumb links to /g/:communityId; the GROUP is text, not a link; the page
 * crumb is the leaf label of the longest-suffix match (a path outside the
 * tree, which only happens on pages that already 404, renders the guild
 * crumb alone).
 *
 * @param {Array<{id: string, communityId?: string|number|null, name?: string|null}>} guilds
 * @param {string|null} currentGuildId
 * @param {string} path
 * @returns {import("./escape").SafeString}
 */
function renderBreadcrumb(guilds, currentGuildId, path) {
  if (!currentGuildId) return html``;
  const current = (Array.isArray(guilds) ? guilds : []).find(
    (g) => (g.communityId ?? g.id) === currentGuildId || g.id === currentGuildId
  );
  const name = current ? guildLabel(current) : String(currentGuildId);
  const base = `/g/${currentGuildId}`;
  const hit = findActiveNavItem(navSubPath(path, base));
  return html`<nav class="breadcrumb" aria-label="Breadcrumb"><a href="${base}">${name}</a>${
    hit
      ? html`<span class="crumb">${hit.group.label}</span><span class="crumb">${hit.item.label}</span>`
      : html``
  }</nav>`;
}

/**
 * Full shell document. Prefer {@link renderShellPage} (derives everything
 * from the request); call this directly only for specially-shaped pages
 * (the root guild list renders with currentGuildId = null → no sidebar).
 *
 * @param {object} opts
 * @param {string} opts.title <title> text
 * @param {import("./escape").SafeString|string} opts.content <main> body
 * @param {string} [opts.heading] h1 text (defaults to title)
 * @param {string} [opts.subheading] one-liner under the h1 (supported alias)
 * @param {string} [opts.lede] one-liner under the h1; wins over subheading
 * @param {import("./escape").SafeString} [opts.flash] shell flash slot
 *   (rendered after the breadcrumb, before the h1 — never pair with a
 *   banner re-rendered inside content)
 * @param {import("./escape").SafeString} [opts.actions] page actions row
 * @param {Array<{id: string, name?: string|null}>} [opts.guilds] switcher list
 * @param {string|null} [opts.currentGuildId]
 * @param {string|null} [opts.tier] current guild tier → badge + nav gate
 * @param {boolean} [opts.degraded] §8.3 degraded-resolver banner
 * @param {{userId?: string, discordTag?: string|null}|null} [opts.user]
 * @param {string|null} [opts.csrfToken] logout-form token
 * @param {string} [opts.nonce] per-response CSP nonce (res.locals.cspNonce)
 * @param {string} [opts.path] request path (sidebar active item + breadcrumb)
 * @returns {import("./escape").SafeString}
 */
function renderLayout(opts) {
  const {
    title,
    content,
    heading = title,
    subheading = null,
    lede = null,
    flash = null,
    actions = null,
    guilds = [],
    currentGuildId = null,
    tier = null,
    degraded = false,
    user = null,
    csrfToken = null,
    nonce = "",
    path = "",
  } = opts;

  // Every <script> tag carries the per-response nonce (external files do not
  // strictly need it under `script-src 'self' 'nonce-…'`, but pinning the
  // nonce on every tag makes "did the middleware run?" unforgeable/auditable).
  const nonceAttr = nonce ? html` nonce="${nonce}"` : html``;
  const homeHref = currentGuildId ? `/g/${currentGuildId}` : "/";
  const userTag = user ? user.discordTag || user.userId || "signed in" : "";
  const switcher =
    Array.isArray(guilds) && guilds.length
      ? renderGuildSwitcher(guilds, currentGuildId)
      : html``;
  const sideNav = renderSideNav(currentGuildId, tier, path);
  const hasNav = String(sideNav) !== "";
  const lead = lede || subheading;
  const shellClass = hasNav ? "bs-shell" : "bs-shell is-solo";
  // Legacy styles first, then forge, so tokens and the shell grid win.
  // The module follows app.js: both are deferred, document order holds,
  // and forge.js skips lookup/user-card when app.js is on the page.
  const forge = forgeAssetTags();
  const forgeCss = forge.css.map((href) => html`<link rel="stylesheet" href="${href}"/>\n`);

  return html`<!DOCTYPE html>
<html lang="en" class="sl-theme-dark">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} · Boiler Snake</title>
<link rel="stylesheet" href="${STYLES_SRC}"/>
${forgeCss}
<script src="${CHART_SRC}" defer${nonceAttr}></script>
<script src="${APP_SRC}" defer${nonceAttr}></script>
<script type="module" src="${forge.js}"${nonceAttr}></script>
</head>
<body data-csrf-token="${csrfToken || ""}">
<a class="skip-link" href="#content">Skip to content</a>
<header class="bs-header">
  <a class="bs-brand" href="${homeHref}"><img class="brand-logo" src="${LOGO_SRC}" alt="" width="28" height="28"/>Boiler Snake</a>
  ${switcher}
  ${tierBadge(tier)}
  <div class="user-box">
    <span class="user-tag">${userTag}</span>
    <form method="post" action="/auth/logout" class="logout-form">
      <input type="hidden" name="_csrf" value="${csrfToken || ""}"/>
      <sl-button type="submit">Sign out</sl-button>
    </form>
  </div>
  ${hasNav
    ? html`<button type="button" class="nav-toggle" data-nav-toggle aria-controls="shell-nav" aria-expanded="false">Menu</button>`
    : html``}
</header>
${degraded ? degradedBanner() : html``}
<div class="${shellClass}">
${sideNav}
<main class="bs-main" id="content">
  ${renderBreadcrumb(guilds, currentGuildId, path)}
  ${flash || html``}
  <h1>${heading}</h1>
  ${lead ? html`<p class="subheading">${lead}</p>` : html``}
  ${actions ? html`<div class="page-actions">${actions}</div>` : html``}
  ${content}
</main>
</div>
<footer class="bs-footer">Boiler Snake web console · <a href="/health">/health</a></footer>
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
 * @param {string} [page.lede]
 * @param {import("./escape").SafeString} [page.flash]
 * @param {import("./escape").SafeString} [page.actions]
 * @param {Array<{id: string, name?: string|null}>} [page.guilds]
 * @param {string} [page.path] override active-nav path (tests); default req.path
 * @param {string} [page.nonce] override (tests); default res.locals.cspNonce
 * @returns {import("./escape").SafeString}
 */
function renderShellPage(req, page) {
  const access = req.guildAccess || {};
  return renderLayout({
    title: page.title,
    heading: page.heading,
    subheading: page.subheading,
    lede: page.lede,
    flash: page.flash,
    actions: page.actions,
    content: page.content || "",
    guilds: page.guilds || [],
    // Fluxer PR 2: /g/ links + sidebar navigate by INTEGER community id.
    currentGuildId: access.communityId ?? access.guildId ?? null,
    tier: access.tier || null,
    degraded: !!access.degraded,
    user: req.user || null,
    csrfToken: req.csrfToken || null,
    nonce: page.nonce ?? (req.res && req.res.locals ? req.res.locals.cspNonce : "") ?? "",
    path: page.path ?? (req.path || ""),
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
  renderSideNav,
  writeShellHtml,
  NAV_GROUPS,
  CHART_SRC,
  APP_SRC,
  STYLES_SRC,
  LOGO_SRC,
};
