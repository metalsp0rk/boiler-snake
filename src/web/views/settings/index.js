/**
 * Settings page body for GET /g/:guildId/settings (roadmap/web-admin.md
 * §8.6 Settings row — subtask 18, Phase 1 READ-ONLY VIEW).
 *
 * Renders the snapshot from src/web/data/settingsData.js. COMPOSED
 * ENTIRELY with the escaped-by-default `html` helper: channel ids, cached
 * channel names, role ids and every free-text-shaped value interpolate
 * through it — nothing here ever wraps DB data in raw(), so a hostile
 * channel-id/role-id value can never inject markup or attributes (§8.7).
 *
 * "Which slash command governs this, at which tier" is derived from
 * src/core/commandVisibility.js — the SAME map registration uses — so the
 * cross-reference cannot drift from the actual slash gates (handler gates
 * remain the security source of truth, per that file's header).
 *
 * Phase 1 renders NO forms and NO controls (§8.8): writes arrive in
 * Phase 2 (subtask 24) with the per-setting tiers noted on each section.
 */

const { html } = require("../escape");
const { emptyState } = require("../components");
const { visibilityTier } = require("../../../core/commandVisibility");
const { DEFAULTS } = require("../../data/settingsData");

/** Fixed admin hint (§8.6 per-setting tier: /setcommandchannel = Admin). */
const ADMIN_WRITE_HINT = "Changing this requires Manage Server (server admin).";

/** Honest degradation line for a cluster whose read failed. */
const READ_FAILED = "Unavailable — the settings read failed for this section.";

/** Integer-ish display that never invents a number for null. */
function num(value, suffix = "") {
  return value == null ? html`<em class="muted">unset</em>` : html`${value}${suffix}`;
}

/** Boolean (on/off) display with honest unset. */
function boolText(value) {
  if (value == null) return html`<em class="muted">unset</em>`;
  return html`${value ? "on" : "off"}`;
}

/** Fraction → "10%" display (mirrors the slash /settings percent math). */
function percent(fraction) {
  if (fraction == null || !Number.isFinite(Number(fraction))) {
    return html`<em class="muted">unset</em>`;
  }
  return html`${Math.round(Number(fraction) * 100)}%`;
}

/**
 * Governance badge: the slash command that owns this setting + the write
 * tier per src/core/commandVisibility.js. Whitelisted class suffix —
 * tier strings come from the frozen TIERS map, never from data.
 * @param {string} commandName commandVisibility key (e.g. "setxp")
 */
function governsBadge(commandName) {
  let tier = "staff";
  try {
    tier = visibilityTier(commandName);
  } catch {
    // Unknown command name is a view-author bug: degrade to "staff" label
    // text only — never interpolate the unknown value into a class.
    return html`<span class="setting-govern">via <code>/${commandName || "?"}</code></span>`;
  }
  const admin = tier === "admin";
  return html`<span class="setting-govern">via <code>/${commandName}</code> · write tier
    <span class="badge badge-tier badge-tier-${tier === "admin" ? "admin" : "staff"}">${admin ? "admin" : "staff"}</span></span>`;
}

/** One definition-list row: label / current value / default note / governs. */
function settingRow(label, valueHtml, defaultHtml, governsHtml) {
  return html`<div class="setting-row">
    <span class="setting-label">${label}</span>
    <span class="setting-value">${valueHtml}</span>
    <span class="setting-default">${defaultHtml}</span>
    <span class="setting-slash">${governsHtml}</span>
  </div>`;
}

function section(title, bodyHtml, opts = {}) {
  return html`
    <section class="panel settings-panel">
      <h2>${title}</h2>
      ${opts.hint ? html`<p class="setting-admin-hint">${opts.hint}</p>` : html``}
      ${bodyHtml}
    </section>`;
}

/** Value rows behind one shared "row read failed" degradation. */
function rowSection(title, available, rowsHtml) {
  if (!available) return section(title, emptyState(READ_FAILED));
  return section(title, html`<div class="settings-rows">${rowsHtml}</div>`);
}

/**
 * Channel reference: the ID is the source-of-truth value (no Discord
 * lookups required). An OPTIONAL cached name (bot member cache via the
 * getClient seam) is appended in parentheses when present — cache-only,
 * never fetched; absent ⇒ id alone (graceful fallback).
 */
function channelRef(channelId, resolveName) {
  if (!channelId) return html`<em class="muted">not configured</em>`;
  const name = typeof resolveName === "function" ? resolveName(channelId) : null;
  return html`<code class="channel-id">${channelId}</code>${name
    ? html` <span class="channel-name">(${name})</span>`
    : html``}`;
}

// ---------------------------------------------------------------------------
// Sections (grouped by area, §8.6 Settings row)
// ---------------------------------------------------------------------------

function generalSection(gs) {
  const rows = html`
    ${settingRow(
      "XP per message",
      num(gs.msgXp),
      html`default ${DEFAULTS.msgXp}`,
      governsBadge("setxp")
    )}
    ${settingRow(
      "XP per reaction",
      num(gs.reactionXp),
      html`default ${DEFAULTS.reactionXp}`,
      governsBadge("setxp")
    )}
    ${settingRow(
      "XP per voice minute",
      num(gs.voiceXpPerMin),
      html`default ${DEFAULTS.voiceXpPerMin}`,
      governsBadge("setxp")
    )}
    ${settingRow(
      "Level curve factor",
      num(gs.levelXpFactor),
      html`default ${DEFAULTS.levelXpFactor} (level L starts at L²×factor)`,
      governsBadge("setxp")
    )}`;
  return rowSection("General · XP & level curve", gs.available !== false, rows);
}

function cooldownSection(gs) {
  const rows = html`
    ${settingRow(
      "Message XP cooldown",
      num(gs.msgCooldownSec, "s"),
      html`default ${DEFAULTS.msgCooldownSec}s`,
      governsBadge("setxp")
    )}
    ${settingRow(
      "Reaction XP cooldown",
      num(gs.reactionCooldownSec, "s"),
      html`default ${DEFAULTS.reactionCooldownSec}s`,
      governsBadge("setxp")
    )}`;
  return rowSection(
    "Cooldowns (per guild)",
    gs.available !== false,
    html`${rows}<p class="subheading">Cooldowns rate-limit XP awards per user/channel; 0 disables a cooldown.</p>`
  );
}

function decaySection(gs) {
  const rows = html`
    ${settingRow(
      "Decay enabled",
      boolText(gs.decayEnabled),
      html`default ${DEFAULTS.decayEnabled ? "on" : "off"}`,
      governsBadge("setdecay")
    )}
    ${settingRow(
      "Min messages to stay active",
      num(gs.decayMinMessages),
      html`default ${DEFAULTS.decayMinMessages}`,
      governsBadge("setdecay")
    )}
    ${settingRow(
      "Decay window",
      num(gs.decayWindowDays, " days"),
      html`default ${DEFAULTS.decayWindowDays} days`,
      governsBadge("setdecay")
    )}
    ${settingRow(
      "XP loss when inactive",
      percent(gs.decayPercent),
      html`default ${percentDefaultText()}`,
      governsBadge("setdecay")
    )}`;
  return rowSection("Decay", gs.available !== false, rows);
}

/** Default percent as display text ("10%") — derived, not hand-typed. */
function percentDefaultText() {
  return `${Math.round(DEFAULTS.decayPercent * 100)}%`;
}

function logsSection(gs, resolveName) {
  const rows = html`
    ${settingRow(
      "Audit log channel",
      channelRef(gs.auditLogChannelId, resolveName),
      html`default: unset (stream disabled)`,
      governsBadge("setlog")
    )}
    ${settingRow(
      "Message log channel",
      channelRef(gs.messageLogChannelId, resolveName),
      html`default: unset (stream disabled)`,
      governsBadge("setlog")
    )}
    ${settingRow(
      "Warn log channel",
      channelRef(gs.warnLogChannelId, resolveName),
      html`default: unset (falls back to audit log)`,
      governsBadge("setwarn")
    )}`;
  return rowSection(
    "Log channels",
    gs.available !== false,
    html`${rows}<p class="subheading">Channel ids are stored verbatim; a cached name is shown when the bot already knows the channel.</p>`
  );
}

function commandChannelsSection(clusters) {
  if (!clusters.available) {
    return section("Command channels", emptyState(READ_FAILED), {
      hint: ADMIN_WRITE_HINT,
    });
  }
  const body = clusters.everywhere
    ? html`<p class="setting-note">
        Commands allowed <strong>everywhere</strong> — the allow-list is empty, so no
        channel restriction is in effect (mirrors <code>/setcommandchannel</code>
        semantics).
      </p>`
    : html`<ul class="settings-list">
        ${clusters.ids.map((id) => html`<li><code class="channel-id">${id}</code></li>`)}
      </ul>`;
  return section(
    "Command channels (allow-list)",
    html`${body}<p class="subheading">${clusters.ids.length} allowed channel${clusters.ids.length === 1 ? "" : "s"} · empty list means every channel · ${governsBadge("setcommandchannel")}</p>`,
    { hint: ADMIN_WRITE_HINT }
  );
}

function levelRolesSection(cluster) {
  if (!cluster.available) {
    return section("Level → role mappings", emptyState(READ_FAILED));
  }
  const body = cluster.rows.length
    ? html`<table class="list-table settings-table">
        <thead>
          <tr><th scope="col">Role ID</th><th scope="col">Level required</th><th scope="col">Drop grace (days)</th></tr>
        </thead>
        <tbody>
          ${cluster.rows.map((r) => html`<tr>
            <td><code>${r.roleId ?? "—"}</code></td>
            <td>${num(r.levelRequired)}</td>
            <td>${num(r.dropGraceDays)}</td>
          </tr>`)}
        </tbody>
      </table>`
    : emptyState("None configured.");
  return section(
    "Level → role mappings",
    html`${body}<p class="subheading">${governsBadge("leveltorole")}</p>`
  );
}

/** Compact age for the freshness stamp. */
function formatAge(ms) {
  const s = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${Math.floor(s % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Full settings body (goes into the shell via renderShellPage).
 * @param {object} input
 * @param {object} input.snapshot from data/settingsData.js getSettings()
 * @param {(channelId: string) => string|null} [input.resolveChannelName]
 *   cache-only name lookup (getClient seam in the route); absent ⇒ ids only
 * @returns {import("../escape").SafeString}
 */
function renderSettingsBody({ snapshot, resolveChannelName }) {
  const s = snapshot || {};
  const gs = s.guildSettings && s.guildSettings.available === false
    ? { available: false }
    : s.guildSettings || {};
  const clusters = s.commandChannels || { available: false, ids: [], everywhere: false };
  const levelRoles = s.levelRoles || { available: false, rows: [] };
  const f = s.freshness || null;
  const stamp = f
    ? html` <span class="subheading">snapshot ${formatAge(f.ageMs || 0)} old${f.fromCache ? html` (cached)` : html``}</span>`
    : html``;

  return html`
    <div class="settings-grid">
      ${generalSection(gs)} ${cooldownSection(gs)} ${decaySection(gs)}
      ${logsSection(gs, resolveChannelName)}
      ${commandChannelsSection(clusters)} ${levelRolesSection(levelRoles)}
      <p class="subheading settings-stamp">
        Read-only view — editing arrives in Phase 2 with per-setting tiers.
        Values cached at least 30&nbsp;s per guild (§8.6 query budget).${stamp}
      </p>
    </div>`;
}

module.exports = {
  renderSettingsBody,
  ADMIN_WRITE_HINT,
};
