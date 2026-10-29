/**
 * Small shell components for the web admin console (roadmap/web-admin.md
 * §8.2 views/components). Everything returns a SafeString from the
 * escaped-by-default `html` helper — no raw HTML unless explicitly raw().
 *
 * Tier values are WHITELISTED ({@link TIER_LABELS}): even though
 * req.guildAccess.tier is server-derived, a component must never interpolate
 * a CSS class from unvalidated input.
 */

const { html, raw, esc } = require("../escape");

/** Whitelist of renderable tiers → label (staff | senior | admin). */
const TIER_LABELS = Object.freeze({ staff: "staff", senior: "senior", admin: "admin" });

/**
 * Tier badge for the guild switcher header. Empty string for anything that
 * is not a known tier (fail-quiet, never class injection).
 * @param {unknown} tier
 * @returns {import("../escape").SafeString}
 */
function tierBadge(tier) {
  const label = TIER_LABELS[/** @type {keyof typeof TIER_LABELS} */ (tier)];
  if (!label) return html``;
  // The tier value is whitelisted above, so the class interpolation is safe;
  // html`` would escape it either way.
  return html`<span class="badge badge-tier badge-tier-${label}" title="Your role in this guild">${label}</span>`;
}

/**
 * Operator banner for degraded tier resolution (§8.3: member-fetch outage /
 * snapshot fallback). Static markup with a dynamic-safe message slot.
 * @param {string} [message]
 * @returns {import("../escape").SafeString}
 */
function degradedBanner(message = "Permission data may be stale — changes can take up to the tier-cache TTL to apply.") {
  return html`<div class="banner banner-degraded" role="status">${message}</div>`;
}

/**
 * Empty-state placeholder for list pages (Phase 1 consumers). Stays callable
 * with a single string (byte-identical to the Phase 1 output). Optional
 * `detail` (second line) and `href` + `actionLabel` (one CTA link) render a
 * composed block (#642). The class stays `empty-state` — later issues and the
 * dashboard literal keep it.
 *
 * @param {string} message
 * @param {{detail?: string|null, href?: string|null, actionLabel?: string|null}} [opts]
 * @returns {import("../escape").SafeString}
 */
function emptyState(message, opts = {}) {
  const detail = opts?.detail ? html`<p class="empty-detail">${opts.detail}</p>` : html``;
  const action =
    opts?.href && opts?.actionLabel
      ? html`<p class="empty-cta"><a class="btn" href="${opts.href}">${opts.actionLabel}</a></p>`
      : html``;
  if (!detail && !action) return html`<p class="empty-state">${message}</p>`;
  return html`<div class="empty-state"><p>${message}</p>${detail}${action}</div>`;
}

/** ARIA live-role per banner kind (#642): problems interrupt, notices stay polite. */
const BANNER_ROLES = Object.freeze({ info: "status", warn: "alert", error: "alert" });

/**
 * Panel/notice banner (info | warn | error class suffix, message escaped).
 * error/warn announce via role="alert", info via role="status" (#642). The
 * node app.js focuses on page load carries data-flash + tabindex="-1" —
 * the shell flash slot and page-level banners share this one focusable
 * convention (first match wins; the slot renders before page content).
 * @param {"info"|"warn"|"error"} kind
 * @param {string} message
 * @returns {import("../escape").SafeString}
 */
function banner(kind, message) {
  const safeKind = BANNER_ROLES[kind] ? kind : "info";
  return html`<div class="banner banner-${safeKind}" role="${BANNER_ROLES[safeKind]}" data-flash tabindex="-1">${message}</div>`;
}

/** A platform user id as text: 5–20 digits (never free-form markup input). */
const USER_ID_OK = /^[0-9]{5,20}$/;

/**
 * User reference: a link into the unified profile, LABELED with the cached
 * display name when one is known (UX v1.1 §8.15 "resolve user ids to
 * names"), falling back to the raw id — same honesty doctrine as the slash
 * commands. names is the Map from shared/discord-cache.resolveMemberNames
 * (cache-only; miss/null ⇒ id label). Non-ids render as plain code.
 * @param {string} guildId
 * @param {string} userId
 * @param {Map<string,string|null>|null} [names]
 * @returns {import("../escape").SafeString}
 */
function userRef(guildId, userId, names = null) {
  const id = String(userId ?? "");
  if (!USER_ID_OK.test(id)) return html`<code class="user-id">${id}</code>`;
  const known = names instanceof Map ? names.get(id) : null;
  const name = typeof known === "string" && known.trim() ? known.trim().slice(0, 100) : null;
  // §8.15-15.11: data-user-card powers the lazy hover profile card
  // (app.js fetches it on hover; card data is cache-only + self-warming).
  return html`<a class="user-id" href="/g/${guildId}/users/${id}" data-user-card="/g/${guildId}/users/${id}/card"${
    name ? html` title="${id}"` : html``
  }>${name || id}</a>${copyControl(id)}`;
}

/**
 * Copy control for a snowflake. Shoelace owns the button; the value is the
 * id itself, never a label. Short non-ids get nothing (the code chip is
 * already the whole value).
 * @param {string} id
 * @returns {import("../escape").SafeString}
 */
function copyControl(id) {
  if (!USER_ID_OK.test(String(id ?? ""))) return html``;
  return html`<sl-copy-button class="bs-copy" value="${id}" copy-label="Copy id"></sl-copy-button>`;
}

module.exports = {
  userRef,
  copyControl,
  TIER_LABELS,
  tierBadge,
  degradedBanner,
  banner,
  emptyState,
  html,
  raw,
  esc,
};
