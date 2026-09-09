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
module.exports = {
  TIER_LABELS,
  tierBadge,
  degradedBanner,
  banner,
  emptyState,
  html,
  raw,
  esc,
};
