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
 * Empty-state placeholder for list pages (Phase 1 consumers).
 * @param {string} message
 * @returns {import("../escape").SafeString}
 */
function emptyState(message) {
  return html`<p class="empty-state">${message}</p>`;
}

/**
 * Panel/notice banner (info | warn | error class suffix, message escaped).
 * @param {"info"|"warn"|"error"} kind
 * @param {string} message
 * @returns {import("../escape").SafeString}
 */
function banner(kind, message) {
  const safeKind = ["info", "warn", "error"].includes(kind) ? kind : "info";
  return html`<div class="banner banner-${safeKind}" role="status">${message}</div>`;
}

/** Re-export for view authors composing tables/forms in one import. */
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
  return html`<a class="user-id" href="/g/${guildId}/users/${id}"${
    name ? html` title="${id}"` : html``
  }>${name || id}</a>`;
}

module.exports = {
  userRef,
  TIER_LABELS,
  tierBadge,
  degradedBanner,
  banner,
  emptyState,
  html,
  raw,
  esc,
};
