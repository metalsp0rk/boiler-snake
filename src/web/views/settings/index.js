/**
 * Settings page body for /g/:guildId/settings (roadmap/web-admin.md §8.6
 * Settings row — Phase 1 read view · Phase 2 writes, subtasks 18 + 24).
 *
 * Renders the snapshot from src/web/data/settingsData.js PLUS one plain
 * <form method="post"> per settings cluster. COMPOSED ENTIRELY with the
 * escaped-by-default `html` helper: channel ids, cached channel names, role
 * ids and every free-text-shaped value interpolate through it — nothing here
 * ever wraps DB data in raw(), so a hostile channel-id/role-id value can
 * never inject markup or attributes (§8.7).
 *
 * FORM CONTRACT (Phase 2, §8.6/§8.7):
 *  - every form embeds the session CSRF token as a hidden `_csrf` field
 *    (the app-level CSRF middleware enforces it on /g/ mutations; htmx gets
 *    the same token via the shell's data-csrf-token attribute);
 *  - no inline JS, no on* handlers — plain progressive forms, PRG responses
 *    (302 → ?ok|err=<cluster>) whose whitelisted flag re-renders as one of
 *    the FIXED flash strings below (user input never reflects into markup);
 *  - blank number inputs are OMITTED from the patch (mirrors slash partial
 *    updates: /setxp with an option omitted leaves that column alone);
 *  - command-channel add/remove forms are visible to staff too, but the
 *    ROUTE requires admin — the ADMIN_WRITE_HINT says so honestly.
 *
 * "Which slash command governs this, at which tier" is derived from
 * src/core/commandVisibility.js — the SAME map registration uses — so the
 * cross-reference cannot drift from the actual slash gates (handler gates
 * remain the security source of truth, per that file's header).
 */

const { html } = require("../escape");
const { emptyState, banner } = require("../components");
const { visibilityTier } = require("../../../core/commandVisibility");
const { DEFAULTS } = require("../../data/settingsData");

/** Fixed admin hint (§8.6 per-setting tier: /setcommandchannel = Admin). */
const ADMIN_WRITE_HINT = "Changing this requires Manage Server (server admin).";

/** Honest degradation line for a cluster whose read failed. */
const READ_FAILED = "Unavailable — the settings read failed for this section.";

/**
 * Fixed flash copy for the whitelisted PRG flags (?ok=<key> / ?err=<key>).
 * Keys are the route's FLASH_KEYS whitelist; values are CONSTANTS — the
 * query value only selects a string, it is never rendered itself (§8.7).
 */
const FLASH_MESSAGES = Object.freeze({
  info: Object.freeze({
    xp: "XP, cooldown and level-curve settings saved.",
    decay: "Decay settings saved.",
    logs: "Log channel updated.",
    warn: "Warning log channel updated.",
    channels: "Command-channel allow-list updated.",
  }),
  error: Object.freeze({
    xp: "XP settings were NOT saved — whole numbers only, in range; blank fields stay unchanged.",
    decay:
      "Decay settings were NOT saved — enabled on/off, messages ≥ 0, days ≥ 1, percent 0–95; send at least one field.",
    logs: "Log channel NOT saved — enter a numeric channel id, or use Clear.",
    warn: "Warning log NOT saved — enter a numeric channel id, or use Clear.",
    channels: "Command channels NOT changed — channel ids must be numeric Discord channel ids.",
  }),
});

// ---------------------------------------------------------------------------
// Small read helpers (unchanged from the Phase 1 view)
// ---------------------------------------------------------------------------

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
// Write-form helpers (Phase 2). Every attribute value interpolates through
// html (escaped); `ctx` carries { base, csrf } — null ctx ⇒ no forms
// (read-only degradation for callers that predate Phase 2).
// ---------------------------------------------------------------------------

/** Hidden CSRF field (middleware/csrf.js CSRF_FORM_FIELD). */
function csrfField(ctx) {
  return html`<input type="hidden" name="_csrf" value="${ctx ? ctx.csrf : ""}"/>`;
}

/**
 * One labelled number field. Blank = "leave unchanged" (slash partial-
 * update semantics), so NO required attribute anywhere.
 * @param {{ min?: number, max?: number, step?: string }} [bounds]
 */
function numberField(name, labelText, placeholder, bounds = {}) {
  const minAttr = bounds.min != null ? html` min="${bounds.min}"` : html``;
  const maxAttr = bounds.max != null ? html` max="${bounds.max}"` : html``;
  const stepAttr = bounds.step ? html` step="${bounds.step}"` : html``;
  return html`<label class="setting-field">
    <span class="setting-field-label">${labelText}</span>
    <input class="setting-input setting-input-number" type="number" name="${name}"${minAttr}${maxAttr}${stepAttr}
      placeholder="${placeholder == null ? "" : placeholder}" autocomplete="off"/>
  </label>`;
}

/** Snowflake text field for a channel id (pattern = the route's gate). */
function channelIdField(name = "channel", labelText = "Channel id") {
  return html`<label class="setting-field setting-field-wide">
    <span class="setting-field-label">${labelText}</span>
    <input class="setting-input setting-input-channel" type="text" name="${name}"
      pattern="[0-9]{5,20}" inputmode="numeric" placeholder="123456789012345678"
      autocomplete="off" spellcheck="false"/>
  </label>`;
}

/** Plain <form method=post> into the guild settings mutation surface. */
function postForm(ctx, path, children, submitLabel, opts = {}) {
  if (!ctx || !ctx.base) return html``;
  const submitAttrs = opts.submitName
    ? html` name="${opts.submitName}" value="${opts.submitValue ?? "1"}"`
    : html``;
  const variant = opts.variant === "clear" ? " settings-submit-clear" : "";
  return html`<form class="settings-form${opts.inline ? " settings-form-inline" : ""}" method="post"
    action="${ctx.base}${path}">
    ${csrfField(ctx)}
    ${children}
    <button type="submit" class="btn btn-small${variant}"${submitAttrs}>${submitLabel}</button>
  </form>`;
}

/** Flash banner for the whitelisted ?ok|err PRG flag (fixed strings only). */
function flashBanner(flash) {
  if (!flash || !FLASH_MESSAGES[flash.kind]) return html``;
  const message = FLASH_MESSAGES[flash.kind][flash.key];
  if (typeof message !== "string") return html``; // unknown key ⇒ NO banner
  return banner(flash.kind, message);
}

// ---------------------------------------------------------------------------
// Sections (grouped by area, §8.6 Settings row)
// ---------------------------------------------------------------------------

function generalSection(gs, ctx) {
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
  // One /setxp form covers this panel's four fields (blank = unchanged).
  const form = postForm(
    ctx,
    "/settings/xp",
    html`
      ${numberField("message", "Message XP", gs.msgXp, { min: 0 })}
      ${numberField("reaction", "Reaction XP", gs.reactionXp, { min: 0 })}
      ${numberField("voice", "Voice XP/min", gs.voiceXpPerMin, { min: 0 })}
      ${numberField("factor", "Level factor", gs.levelXpFactor, { min: 1, max: 10000 })}`,
    "Save XP settings"
  );
  return rowSection(
    "General · XP & level curve",
    gs.available !== false,
    html`${rows}${form}<p class="subheading">Mirrors <code>/setxp</code> — blank fields stay unchanged.</p>`
  );
}

function cooldownSection(gs, ctx) {
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
  const form = postForm(
    ctx,
    "/settings/xp",
    html`
      ${numberField("msgcooldown", "Message cooldown (s)", gs.msgCooldownSec, { min: 0 })}
      ${numberField(
        "reactioncooldown",
        "Reaction cooldown (s)",
        gs.reactionCooldownSec,
        { min: 0 }
      )}`,
    "Save cooldowns"
  );
  return rowSection(
    "Cooldowns (per guild)",
    gs.available !== false,
    html`${rows}${form}<p class="subheading">Cooldowns rate-limit XP awards per user/channel; 0 disables a cooldown.</p>`
  );
}

function decaySection(gs, ctx) {
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
  const enabledSelect = html`<label class="setting-field">
    <span class="setting-field-label">Decay enabled</span>
    <select class="setting-input" name="enabled">
      <option value="">keep (${gs.decayEnabled == null ? "?" : gs.decayEnabled ? "on" : "off"})</option>
      <option value="on">on</option>
      <option value="off">off</option>
    </select>
  </label>`;
  const form = postForm(
    ctx,
    "/settings/decay",
    html`
      ${enabledSelect}
      ${numberField("messages", "Min messages", gs.decayMinMessages, { min: 0 })}
      ${numberField("days", "Window (days)", gs.decayWindowDays, { min: 1 })}
      ${numberField("percent", "Percent (0–95)", Math.round((gs.decayPercent ?? 0) * 100), {
        min: 0,
        max: 95,
        step: "any",
      })}`,
    "Save decay settings"
  );
  return rowSection(
    "Decay",
    gs.available !== false,
    html`${rows}${form}<p class="subheading">Mirrors <code>/setdecay</code> — percent is a whole percent (10 = 10%), stored as a fraction like slash.</p>`
  );
}

/** Default percent as display text ("10%") — derived, not hand-typed. */
function percentDefaultText() {
  return `${Math.round(DEFAULTS.decayPercent * 100)}%`;
}

/** Set/Clear channel form for one log stream (slash: channel XOR clear). */
function logChannelForm(ctx, path, stream, label) {
  const hiddenStream = stream
    ? html`<input type="hidden" name="stream" value="${stream}"/>`
    : html``;
  return postForm(
    ctx,
    path,
    html`${hiddenStream}${channelIdField("channel", `${label} channel id`)}`,
    "Set",
    { submitName: undefined }
  );
}

/** Named Clear submit for one log stream (separate form → XOR semantics). */
function logClearForm(ctx, path, stream) {
  const hiddenStream = stream
    ? html`<input type="hidden" name="stream" value="${stream}"/>`
    : html``;
  return postForm(ctx, path, hiddenStream, "Clear", {
    submitName: "clear",
    submitValue: "1",
    variant: "clear",
    inline: true,
  });
}

function logsSection(gs, resolveName, ctx) {
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
  const forms = html`
    <div class="settings-log-forms">
      ${logChannelForm(ctx, "/settings/logs", "audit", "Audit")}
      ${logClearForm(ctx, "/settings/logs", "audit")}
      ${logChannelForm(ctx, "/settings/logs", "message", "Message")}
      ${logClearForm(ctx, "/settings/logs", "message")}
      ${logChannelForm(ctx, "/settings/warn-log", null, "Warn")}
      ${logClearForm(ctx, "/settings/warn-log", null)}
    </div>`;
  return rowSection(
    "Log channels",
    gs.available !== false,
    html`${rows}${forms}<p class="subheading">Channel ids are stored verbatim; a cached name is shown when the bot already knows the channel. Mirrors <code>/setlog audit|message</code> and <code>/setwarn log</code>.</p>`
  );
}

function commandChannelsSection(clusters, ctx) {
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
        ${clusters.ids.map((id) =>
          html`<li class="settings-list-item">
            <code class="channel-id">${id}</code>
            ${postForm(
              ctx,
              "/settings/command-channels/remove",
              html`<input type="hidden" name="channel" value="${id}"/>`,
              "Remove",
              { variant: "clear", inline: true }
            )}
          </li>`
        )}
      </ul>`;
  const addForm = postForm(
    ctx,
    "/settings/command-channels/add",
    channelIdField("channel", "Allow commands in channel id"),
    "Allow channel"
  );
  return section(
    "Command channels (allow-list)",
    html`${body}${addForm}<p class="subheading">${clusters.ids.length} allowed channel${clusters.ids.length === 1 ? "" : "s"} · empty list means every channel · ${governsBadge("setcommandchannel")}</p>`,
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
    html`${body}<p class="subheading">${governsBadge("leveltorole")} · mappings are edited via slash for now.</p>`
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
 * @param {string|null} [input.csrfToken] req.csrfToken — null/absent ⇒
 *   forms render but the middleware rejects every post (fail-closed anyway)
 * @param {string|null} [input.guildId] scopes the form actions to this guild
 * @param {{kind: "info"|"error", key: string}|null} [input.flash] whitelisted
 *   PRG flag from the route; renders one fixed FLASH_MESSAGES string
 * @returns {import("../escape").SafeString}
 */
function renderSettingsBody({ snapshot, resolveChannelName, csrfToken, guildId, flash }) {
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
  const ctx = guildId ? { base: `/g/${guildId}`, csrf: csrfToken || "" } : null;

  return html`
    <div class="settings-grid">
      ${flashBanner(flash)} ${generalSection(gs, ctx)} ${cooldownSection(gs, ctx)}
      ${decaySection(gs, ctx)} ${logsSection(gs, resolveChannelName, ctx)}
      ${commandChannelsSection(clusters, ctx)} ${levelRolesSection(levelRoles)}
      <p class="subheading settings-stamp">
        Every form mirrors the slash command shown on its rows at the same
        tier (levels→role mappings stay slash-only). Values cached at least
        30&nbsp;s per guild (§8.6 query budget); mutations refresh immediately.${stamp}
      </p>
    </div>`;
}

module.exports = {
  renderSettingsBody,
  ADMIN_WRITE_HINT,
  FLASH_MESSAGES,
};
