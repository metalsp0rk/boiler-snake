/**
 * Public sign-in landing page (roadmap/web-admin.md §8.3, user-feedback
 * amendment 2026-09: the site used to bounce every anonymous visitor
 * straight into Discord's OAuth screen — logging out snapped back to
 * sign-in immediately, and nobody ever saw a page explaining WHAT they
 * were signing in to).
 *
 * This page is the signed-out face of the console: what the product is,
 * exactly what "Sign in with Discord" grants, and an explicit
 * "Continue with Discord" action (GET /auth/login?continue=1 — the OAuth
 * redirect only ever fires from there). Every redirect that used to target
 * /auth/login lands here first.
 *
 * SECURITY CONTRACT:
 *  - PUBLIC page: renders ZERO identity data (no user, no guilds, no
 *    csrfToken) — the inputs are server-validated enum flags only.
 *  - `context` and `notice` are whitelisted string enums, never raw query
 *    echoes; the caller (auth/login.js) validates guild/next against the
 *    existing snowflake / ticket-path regexes before naming a context.
 *  - The continue href is built by {@link buildContinueHref} from those
 *    same whitelisted values, so the login round-trip keeps its return
 *    target without ever widening what the callback honors.
 *  - Escaped-by-default templates (views/escape.js); all CSS lives in
 *    /static/styles.css (§8.7 "no new inline styles").
 */

const { html } = require("../escape");
const { banner } = require("../components");
const { STYLES_SRC } = require("../layout");

/** Whitelisted context flags (derived from validated params, never echoed). */
const CONTEXTS = Object.freeze(["guild", "ticket"]);
const NOTICES = Object.freeze(["signedout"]);

/**
 * Continue button href: /auth/login?continue=1 + the whitelisted return
 * params re-encoded. Pure + exported so the whitelist round-trip is
 * unit-testable without a running app.
 *
 * @param {{ guild?: string|null, next?: string|null }} validated
 *   already-validated values (readGuildTarget / readNextTarget output —
 *   null when the raw param was junk, which is simply dropped here)
 * @returns {string}
 */
function buildContinueHref({ guild = null, next = null } = {}) {
  const parts = ["continue=1"];
  if (guild) parts.push(`guild=${encodeURIComponent(guild)}`);
  if (next) parts.push(`next=${encodeURIComponent(next)}`);
  return `/auth/login?${parts.join("&")}`;
}

/** Context-specific one-liner (fixed copy — no values interpolated). */
function contextLine(context) {
  if (context === "ticket") {
    return banner(
      "info",
      "You asked for a ticket transcript — you'll go straight back to it after signing in."
    );
  }
  if (context === "guild") {
    return banner(
      "info",
      "You asked for a guild console — you'll land there right after signing in."
    );
  }
  return html``;
}

/** Notice banner (signed-out confirmation). */
function noticeLine(notice) {
  if (notice === "signedout") {
    return banner("info", "You're signed out. Sign in again any time.");
  }
  return html``;
}

/**
 * Full public landing document.
 *
 * @param {object} input
 * @param {string|null} [input.notice] "signedout" | null
 *   (validated enum, not raw input)
 * @param {string|null} [input.context] "guild" | "ticket" | null (validated)
 * @param {string} input.continueHref href from {@link buildContinueHref}
 * @returns {import("../escape").SafeString}
 */
function renderSignInPage({ notice = null, context = null, continueHref }) {
  return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Sign in · Boiler Snake</title>
<link rel="stylesheet" href="${STYLES_SRC}"/>
</head>
<body class="signin-body">
<main class="signin-card">
  <h1 class="signin-title">Boiler Snake web console</h1>
  ${noticeLine(NOTICES.includes(notice) ? notice : null)}
  <p class="signin-lede">Sign in with your Discord account to open the staff
    console — tickets, XP, moderation tools, and integrations for guilds where
    this bot is installed.</p>
  <section class="signin-what">
    <h2>What signing in does</h2>
    <ul>
      <li>Discord shares your identity, your guild list, and basic member
        info with the bot — after you approve on Discord's own screen.</li>
      <li>The console then shows <strong>only</strong> guilds where this bot
        is installed <em>and</em> you have staff access (ManageGuild or a
        configured staff role).</li>
      <li>Your Discord password is never visible to the bot, and signing in
        does not let it act as you on Discord.</li>
    </ul>
    <p>Signing out ends this browser's session immediately; you can come back
      to this page at any time.</p>
  </section>
  ${contextLine(CONTEXTS.includes(context) ? context : null)}
  <p><a class="btn btn-signin" href="${continueHref}">Continue with Discord</a></p>
  <p class="signin-footnote">Nothing happens until you press the button above
    and approve on Discord.</p>
</main>
</body>
</html>`;
}

module.exports = {
  renderSignInPage,
  buildContinueHref,
  CONTEXTS,
  NOTICES,
};
