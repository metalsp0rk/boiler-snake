/**
 * Settings page body for /g/:guildId/settings (roadmap/web-admin.md §8.6
 * Settings row — Phase 1 read view · Phase 2 writes · #643 sections).
 *
 * #643 LAYOUT CONTRACT: one `<section id="…" class="panel" data-setting-section>`
 * per cluster, in the frozen order xp, cooldowns, decay, logs,
 * command-channels — the SAME ids the route's `at` parameter writes and
 * reads. The "Find a setting" box (`data-setting-filter`, deliberately NOT
 * wrapped in a <form>) is the primary jump; the anchor list
 * (`<nav class="section-nav">`) stays so hashes and the server `at` have an
 * id. The flash banner renders as the first content node of the section the
 * route named via a validated `at`; unknown/missing `at` leaves the banner
 * to the shell flash slot (routes/settings.js) and this body renders none.
 *
 * NO-PREFILL CONTRACT (#643): inputs NEVER carry a `value` attribute.
 * parseOptionalInt / parseOptionalNumber in data/settingsWrite.js treat ""
 * as "not provided" and omit the column, and buildXpPatch copies every
 * PROVIDED field into the admin_audit details.patch — putting the snapshot
 * into value would submit every sibling, clobber a slash edit the operator
 * never touched, and record columns they did not change. The current
 * snapshot, the default, and the governing slash command are TEXT in each
 * field's .form-help. The four-column .setting-row read wall is gone.
 *
 * Renders the snapshot from src/web/data/settingsData.js PLUS one plain
 * <form method="post"> per settings cluster. COMPOSED ENTIRELY with the
 * escaped-by-default `html` helper: channel ids, cached channel names, role
 * ids and every free-text-shaped value interpolate through it — nothing here
 * ever wraps DB data in raw(), so a hostile channel-id/role-id value can
 * never inject markup or attributes (§8.7).
 *
 * FORM CONTRACT (Phase 2, §8.6/§8.7, #643 form-row style):
 *  - every form embeds the session CSRF token as a hidden `_csrf` field
 *    (the app-level CSRF middleware enforces it on /g/ mutations; JS gets
 *    the same token via the shell's data-csrf-token attribute);
 *  - no inline JS, no on* handlers — plain progressive forms, PRG responses
 *    (302 → ?ok|err=<cluster>&at=<section>#<section>) whose whitelisted flag
 *    re-renders as one of the FIXED flash strings below (user input never
 *    reflects into markup);
 *  - blank number inputs are OMITTED from the patch (mirrors slash partial
 *    updates: /setxp with an option omitted leaves that column alone);
 *  - one `.btn-primary` submit per form (Clear keeps the danger-outline
 *    treatment — a filled primary must not be what a thumb hits first);
 *  - command-channel add/remove forms are visible to staff too, but the
 *    ROUTE requires admin — the ADMIN_WRITE_HINT says so honestly;
 *  - level→role mappings are READ-ONLY on this page — the write surface
 *    lives on /staff#level-roles, linked from the read section.
 *
 * "Which slash command governs this, at which tier" is derived from
 * src/core/commandVisibility.js — the SAME map registration uses — so the
 * cross-reference cannot drift from the actual slash gates (handler gates
 * remain the security source of truth, per that file's header).
 */

const { html } = require("../escape");
// #470 (H1-8): num/formatAge shared with the other console views (#470 census:
// identical private copies). The {kind,key} flash variant below is a
// DIFFERENT contract from the done/error-slug family and stays as-is.
const { num, formatAge, section, channelRef } = require("../_helpers");
const { emptyState, banner } = require("../components");
const { visibilityTier } = require("../../../core/commandVisibility");
const { DEFAULTS } = require("../../data/settingsData");

/** Fixed admin hint (§8.6 per-setting tier: /setcommandchannel = Admin). */
const ADMIN_WRITE_HINT = "Changing this requires Manage Server (server admin).";

/** Honest degradation line for a cluster whose read failed. */
const READ_FAILED = "Unavailable — the settings read failed for this section.";

/**
 * Frozen page-section ids (#643). SINGLE DEFINITION shared with
 * routes/settings.js: the redirect `at` writer, the GET `at` reader, and the
 * banner placement below all validate against this list. Raw query values are
 * never interpolated into an id attribute — section() additionally
 * whitelists ids on its own.
 */
const SECTION_IDS = Object.freeze(["xp", "cooldowns", "decay", "logs", "command-channels"]);

/**
 * Fixed flash copy for the whitelisted PRG flags (?ok=<key> / ?err=<key>).
 * Keys are the route's FLASH_KEYS whitelist; values are CONSTANTS — the
 * query value only selects a string, it is never rendered itself (§8.7).
 * `info.xp` covers XP, cooldowns and the level curve (§8.6); there is NO
 * cooldowns flash key.
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
// Small read helpers (display-only; the four-column .setting-row wall is
// gone with #643 — snapshots now live in .form-help text)
// ---------------------------------------------------------------------------

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

/** Default percent as display text ("10%") — derived, not hand-typed. */
function percentDefaultText() {
  return `${Math.round(DEFAULTS.decayPercent * 100)}%`;
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

// ---------------------------------------------------------------------------
// Write-form helpers (#643 shell form style). Every attribute value
// interpolates through html (escaped); `ctx` carries { base, csrf } — null
// ctx ⇒ no forms (read-only degradation for callers that predate Phase 2).
// ---------------------------------------------------------------------------

/** Hidden CSRF field (middleware/csrf.js CSRF_FORM_FIELD). */
function csrfField(ctx) {
  return html`<input type="hidden" name="_csrf" value="${ctx ? ctx.csrf : ""}"/>`;
}

/**
 * .form-help text block. `fieldKey` is a CODE CONSTANT (a form-field or
 * note name) used as a stable seam for docs/QA greps — never user data.
 */
function formHelp(fieldKey, partsHtml) {
  return html`<p class="form-help" data-help-for="${fieldKey}">${partsHtml}</p>`;
}

/** One labelled field row: label + control, .form-help slot beside/below
 *  it (the shell's two-column ≥720px grid, stacked on phones). */
function formRow(labelText, controlHtml, helpHtml = html``) {
  return html`<div class="form-row">
    <label class="form-row-field">${labelText}${controlHtml}</label>
    ${helpHtml}
  </div>`;
}

/**
 * Per-field help: current snapshot + default + governing slash command
 * (#643). Everything a prefill would have smuggled into the control lives
 * here as text instead. **Label:** value copy style (#471 H2-13).
 */
function settingHelp(fieldKey, currentHtml, defaultHtml, commandName) {
  return formHelp(
    fieldKey,
    html`<strong>Current:</strong> ${currentHtml} · <strong>Default:</strong> ${defaultHtml} · ${governsBadge(commandName)}`
  );
}

/**
 * One labelled number control. NO value attribute (blank = "leave the
 * column unchanged" — slash partial-update semantics), so NO required
 * attribute anywhere either.
 * @param {{ min?: number, max?: number, step?: string }} [bounds]
 */
function numberField(name, bounds = {}) {
  const minAttr = bounds.min != null ? html` min="${bounds.min}"` : html``;
  const maxAttr = bounds.max != null ? html` max="${bounds.max}"` : html``;
  const stepAttr = bounds.step ? html` step="${bounds.step}"` : html``;
  return html`<input class="input" type="number" name="${name}"${minAttr}${maxAttr}${stepAttr} autocomplete="off"/>`;
}

/**
 * Snowflake text control for a channel id (pattern = the route's gate).
 * The placeholder is a FORMAT EXAMPLE constant — never a snapshot value.
 * #645: with a guild ctx the field gains the CACHE-ONLY channel-name
 * typeahead (writes the numeric id; pasting an id still works — the
 * server parsers are the authority, this is an enhancement).
 */
function channelIdField(name = "channel", ctx = null) {
  const lookup = ctx
    ? html` data-lookup="channels" data-lookup-url="${ctx.base}/lookups/channels"`
    : html``;
  return html`<input class="input input-narrow" type="text" name="${name}"${lookup}
    pattern="[0-9]{5,20}" inputmode="numeric" placeholder="123456789012345678"
    autocomplete="off" spellcheck="false"/>`;
}

/**
 * Plain <form method=post> into the guild settings mutation surface, with
 * exactly one submit. Default submit is the section's `.btn-primary`
 * (1rem); `variant: "clear"` keeps the danger-outline treatment.
 */
function postForm(ctx, path, children, submitLabel, opts = {}) {
  if (!ctx || !ctx.base) return html``;
  const submitAttrs = opts.submitName
    ? html` name="${opts.submitName}" value="${opts.submitValue ?? "1"}"`
    : html``;
  const btnClass =
    opts.variant === "clear" ? "btn btn-danger settings-submit-clear" : "btn btn-primary";
  return html`<form class="settings-form${opts.inline ? " settings-form-inline" : ""}" method="post"
    action="${ctx.base}${path}">
    ${csrfField(ctx)}
    ${children}
    <button type="submit" class="${btnClass}"${submitAttrs}>${submitLabel}</button>
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
// Page chrome (#643): local find box + section anchors
// ---------------------------------------------------------------------------

/**
 * Local-only find box (#642 listener in app.js): filters [data-setting-section]
 * panels client-side. Deliberately NOT wrapped in a <form> — it navigates
 * nothing.
 */
function findBox() {
  return html`<div class="find-setting">
    <label for="find-a-setting">Find a setting</label>
    <input id="find-a-setting" class="input" type="text" data-setting-filter
      autocomplete="off" spellcheck="false" placeholder="filter the sections below"/>
  </div>`;
}

/** Anchor list: keeps the ids that URL hashes and the server `at` use. */
function sectionNav() {
  return html`<nav class="section-nav" aria-label="Settings sections">
    <a href="#xp">XP &amp; level curve</a>
    <a href="#cooldowns">Cooldowns</a>
    <a href="#decay">Decay</a>
    <a href="#logs">Log channels</a>
    <a href="#command-channels">Command channels</a>
  </nav>`;
}

/** #643 section chrome: id + data-setting-section on every page panel. */
function pageSection(id, title, bodyHtml, opts = {}) {
  return section(title, bodyHtml, { ...opts, id, cls: "settings-section", dataSection: true });
}

// ---------------------------------------------------------------------------
// Sections (#643 frozen order): xp, cooldowns, decay, logs, command-channels
// ---------------------------------------------------------------------------

function xpSection(gs, ctx, bannerHtml) {
  const title = "XP & level curve";
  if (gs.available === false) {
    return pageSection("xp", title, html`${bannerHtml}${emptyState(READ_FAILED)}`);
  }
  // One /setxp form covers this section's four fields (blank = unchanged).
  const form = postForm(
    ctx,
    "/settings/xp",
    html`
      ${formRow(
        "Message XP",
        numberField("message", { min: 0 }),
        settingHelp("message", num(gs.msgXp), DEFAULTS.msgXp, "setxp")
      )}
      ${formRow(
        "Reaction XP",
        numberField("reaction", { min: 0 }),
        settingHelp("reaction", num(gs.reactionXp), DEFAULTS.reactionXp, "setxp")
      )}
      ${formRow(
        "Voice XP/min",
        numberField("voice", { min: 0 }),
        settingHelp("voice", num(gs.voiceXpPerMin), DEFAULTS.voiceXpPerMin, "setxp")
      )}
      ${formRow(
        "Level curve factor",
        numberField("factor", { min: 1, max: 10000 }),
        settingHelp(
          "factor",
          num(gs.levelXpFactor),
          `${DEFAULTS.levelXpFactor} (level L starts at L²×factor)`,
          "setxp"
        )
      )}
      ${formHelp("xp-form", html`Mirrors <code>/setxp</code> — blank fields stay unchanged.`)}`,
    "Save XP settings"
  );
  return pageSection("xp", title, html`${bannerHtml}${form}`);
}

function cooldownsSection(gs, ctx, bannerHtml) {
  const title = "Cooldowns (per guild)";
  if (gs.available === false) {
    return pageSection("cooldowns", title, html`${bannerHtml}${emptyState(READ_FAILED)}`);
  }
  // Cooldowns ride the SAME /settings/xp route as the XP section (=/setxp);
  // the redirect still lands on #cooldowns via the field-presence rule.
  const form = postForm(
    ctx,
    "/settings/xp",
    html`
      ${formRow(
        "Message cooldown (s)",
        numberField("msgcooldown", { min: 0 }),
        settingHelp("msgcooldown", num(gs.msgCooldownSec, "s"), `${DEFAULTS.msgCooldownSec}s`, "setxp")
      )}
      ${formRow(
        "Reaction cooldown (s)",
        numberField("reactioncooldown", { min: 0 }),
        settingHelp(
          "reactioncooldown",
          num(gs.reactionCooldownSec, "s"),
          `${DEFAULTS.reactionCooldownSec}s`,
          "setxp"
        )
      )}
      ${formHelp("cooldowns-form", html`Cooldowns rate-limit XP awards per user/channel; 0 disables a cooldown. Mirrors <code>/setxp</code> — blank fields stay unchanged.`)}`,
    "Save cooldowns"
  );
  return pageSection("cooldowns", title, html`${bannerHtml}${form}`);
}

function decaySection(gs, ctx, bannerHtml) {
  const title = "Decay";
  if (gs.available === false) {
    return pageSection("decay", title, html`${bannerHtml}${emptyState(READ_FAILED)}`);
  }
  // The empty option means "keep" and stays UNSELECTED (#643): the snapshot
  // is never selected into on/off — that would write the column on submit.
  const enabledSelect = html`<select class="input" name="enabled">
    <option value="">keep (${gs.decayEnabled == null ? "?" : gs.decayEnabled ? "on" : "off"})</option>
    <option value="on">on</option>
    <option value="off">off</option>
  </select>`;
  const form = postForm(
    ctx,
    "/settings/decay",
    html`
      ${formRow(
        "Decay enabled",
        enabledSelect,
        settingHelp("enabled", boolText(gs.decayEnabled), DEFAULTS.decayEnabled ? "on" : "off", "setdecay")
      )}
      ${formRow(
        "Min messages",
        numberField("messages", { min: 0 }),
        settingHelp("messages", num(gs.decayMinMessages), DEFAULTS.decayMinMessages, "setdecay")
      )}
      ${formRow(
        "Window (days)",
        numberField("days", { min: 1 }),
        settingHelp("days", num(gs.decayWindowDays, " days"), `${DEFAULTS.decayWindowDays} days`, "setdecay")
      )}
      ${formRow(
        "Percent (0–95)",
        numberField("percent", { min: 0, max: 95, step: "any" }),
        settingHelp("percent", percent(gs.decayPercent), percentDefaultText(), "setdecay")
      )}
      ${formHelp("decay-form", html`Mirrors <code>/setdecay</code> — percent is a whole percent (10 = 10%), stored as a fraction like slash. Blank fields stay unchanged.`)}`,
    "Save decay settings"
  );
  return pageSection("decay", title, html`${bannerHtml}${form}`);
}

/**
 * One log stream: current-value help + Set form + named Clear form
 * (separate forms → the route's channel XOR clear semantics hold).
 * @param {object} c
 * @param {string} c.path mutation path (logs | warn-log)
 * @param {string|null} c.stream hidden stream field (null = warn-log)
 * @param {string} c.label display label ("Audit", "Message", "Warn")
 * @param {string} c.fieldKey code-constant help seam key
 */
function logStreamCluster(ctx, { path, stream, label, fieldKey, currentHtml, defaultHtml, commandName }) {
  const hiddenStream = stream
    ? html`<input type="hidden" name="stream" value="${stream}"/>`
    : html``;
  const setForm = postForm(
    ctx,
    path,
    html`${hiddenStream}${formRow(`${label} channel id`, channelIdField("channel", ctx))}`,
    "Set"
  );
  const clearForm = postForm(ctx, path, hiddenStream, "Clear", {
    submitName: "clear",
    submitValue: "1",
    variant: "clear",
    inline: true,
  });
  return html`<div class="settings-log-stream">
    ${formHelp(
      fieldKey,
      html`<strong>Current:</strong> ${currentHtml} · <strong>Default:</strong> ${defaultHtml} · ${governsBadge(commandName)}`
    )}
    ${setForm} ${clearForm}
  </div>`;
}

function logsSection(gs, resolveName, ctx, bannerHtml) {
  const title = "Log channels";
  if (gs.available === false) {
    return pageSection("logs", title, html`${bannerHtml}${emptyState(READ_FAILED)}`);
  }
  const clusters = html`
    <div class="settings-log-forms">
      ${logStreamCluster(ctx, {
        path: "/settings/logs",
        stream: "audit",
        label: "Audit",
        fieldKey: "log-audit",
        currentHtml: channelRef(gs.auditLogChannelId, resolveName),
        defaultHtml: "unset (stream disabled)",
        commandName: "setlog",
      })}
      ${logStreamCluster(ctx, {
        path: "/settings/logs",
        stream: "message",
        label: "Message",
        fieldKey: "log-message",
        currentHtml: channelRef(gs.messageLogChannelId, resolveName),
        defaultHtml: "unset (stream disabled)",
        commandName: "setlog",
      })}
      ${logStreamCluster(ctx, {
        path: "/settings/warn-log",
        stream: null,
        label: "Warn",
        fieldKey: "log-warn",
        currentHtml: channelRef(gs.warnLogChannelId, resolveName),
        defaultHtml: "unset (falls back to audit log)",
        commandName: "setwarn",
      })}
    </div>`;
  return pageSection(
    "logs",
    title,
    html`${bannerHtml}${clusters}${formHelp(
      "logs-note",
      html`Channel ids are stored verbatim; a cached name is shown when the bot already knows the channel. Mirrors <code>/setlog audit|message</code> and <code>/setwarn log</code>; Clear unsets the stream's channel.`
    )}`
  );
}

function commandChannelsSection(clusters, ctx, bannerHtml) {
  const title = "Command channels (allow-list)";
  if (!clusters.available) {
    return pageSection("command-channels", title, html`${bannerHtml}${emptyState(READ_FAILED)}`, {
      hint: ADMIN_WRITE_HINT,
    });
  }
  const body = clusters.everywhere
    ? html`<p class="form-help">
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
  // ADD stays a CREATE form (#643): nothing to prefill — the field is blank
  // until the admin names a channel.
  const addForm = postForm(
    ctx,
    "/settings/command-channels/add",
    formRow("Allow commands in channel id", channelIdField("channel", ctx)),
    "Allow channel"
  );
  return pageSection(
    "command-channels",
    title,
    html`${bannerHtml}${body}${addForm}${formHelp(
      "command-channels-note",
      html`${clusters.ids.length} allowed channel${clusters.ids.length === 1 ? "" : "s"} · an empty list means every channel · ${governsBadge("setcommandchannel")}`
    )}`,
    { hint: ADMIN_WRITE_HINT }
  );
}

/**
 * Level → role mappings: READ-ONLY here (#643). The block is not a second
 * write surface — it links to the write form on /staff#level-roles instead
 * of the old "edited via slash for now" dead end.
 */
function levelRolesSection(cluster, ctx) {
  const title = "Level → role mappings";
  if (!cluster.available) {
    return section(title, emptyState(READ_FAILED), { cls: "settings-section", dataSection: true });
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
  const pointer = ctx
    ? html`<p class="form-help" data-help-for="level-roles">
        <strong>Edit on:</strong>
        <a href="${ctx.base}/staff#level-roles">Staff roles → Level→role mappings</a>
        · same service as <code>/leveltorole</code>.
      </p>`
    : html`<p class="form-help">${governsBadge("leveltorole")} · mappings are edited via slash.</p>`;
  return section(title, html`${body}${pointer}`, { cls: "settings-section", dataSection: true });
}

/**
 * Full settings body (goes into the shell via renderShellPage).
 * @param {object} input
 * @param {object} input.snapshot from data/settingsData.js getSettings()
 * @param {(channelId: string) => string|null} [input.resolveChannelName]
 *   cache-only name lookup (getClient seam in the route); absent ⇒ ids only
 * @param {string|null} [input.csrfToken] req.csrfToken — null/absent ⇒
 *   forms render but the middleware rejects every post (fail-closed anyway)
 * @param {number|string|null} [input.guildId] scopes the form actions to this
 *   guild's ROUTE identity (PR 2: integer communities.id)
 * @param {{kind: "info"|"error", key: string}|null} [input.flash] whitelisted
 *   PRG flag from the route; renders one fixed FLASH_MESSAGES string — only
 *   into the section named by a valid `section` (the shell slot otherwise,
 *   which the ROUTE renders; a page never renders both)
 * @param {string|null} [input.section] validated `at` section id (#643);
 *   the flash banner becomes the first content node of that section. The
 *   view re-checks against SECTION_IDS — a raw query value never reaches an
 *   id attribute through any path.
 * @returns {import("../escape").SafeString}
 */
function renderSettingsBody({
  snapshot,
  resolveChannelName,
  csrfToken,
  guildId,
  flash,
  section: sectionAt,
}) {
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

  // #643: the route already whitelisted `at`; re-check here (defense in
  // depth) so a caller bug can never place a banner by raw query. The banner
  // goes to the shell slot (route-side) when this is null.
  const at =
    typeof sectionAt === "string" && SECTION_IDS.includes(sectionAt) ? sectionAt : null;
  const bannerFor = (id) => (at && id === at ? flashBanner(flash) : html``);

  return html`
    <div class="settings-grid">
      ${findBox()} ${sectionNav()}
      ${xpSection(gs, ctx, bannerFor("xp"))} ${cooldownsSection(gs, ctx, bannerFor("cooldowns"))}
      ${decaySection(gs, ctx, bannerFor("decay"))} ${logsSection(gs, resolveChannelName, ctx, bannerFor("logs"))}
      ${commandChannelsSection(clusters, ctx, bannerFor("command-channels"))}
      ${levelRolesSection(levelRoles, ctx)}
      <p class="subheading settings-stamp">
        Every form mirrors the slash command shown in its help text at the
        same tier (levels→role mappings are edited on the staff page). Values
        cached at least 30&nbsp;s per guild (§8.6 query budget); mutations
        refresh immediately.${stamp}
      </p>
    </div>`;
}

module.exports = {
  renderSettingsBody,
  ADMIN_WRITE_HINT,
  FLASH_MESSAGES,
  SECTION_IDS,
};
