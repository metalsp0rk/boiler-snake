/**
 * Integrations page body for GET /g/:guildId/integrations (roadmap/
 * web-admin.md §8.6 "Integrations: YouTube, Twitch, reaction roles, event
 * reminders, honeypot | Staff | per-command tier (/honeypot exempt = Admin)
 * — Phase 1 view from subtask 20, Phase 2 write forms from subtask 26).
 *
 * Renders the snapshot from src/web/data/integrationsData.js. COMPOSED
 * ENTIRELY with the escaped-by-default `html` helper: YouTube channel
 * names/urls, Twitch display names/logins, panel titles/descriptions,
 * reminder shortnames, channel/role/message ids — everything — interpolates
 * through it. Nothing here ever wraps DB data in raw(), so a hostile row can
 * never inject markup or attributes (§8.7).
 *
 * "Configured vs effective": the YouTube and Twitch tickers need
 * environment credentials. When the env is absent the section shows the
 * feature's OWN operator message (variable NAMES only — the data module
 * already reduced the env to a boolean + missing-var list; values can never
 * exist in the snapshot). API keys/secrets are NEVER form fields — the write
 * forms carry ids and numbers only (§8.7: keys live in the environment).
 *
 * Write-tier badges come from the frozen GOVERN map below (view-author
 * constants, whitelisted tier classes) — never from row data. Per §8.6 the
 * integration writes are staff-tier EXCEPT `/honeypot exempt` (Admin): the
 * exempt forms render only for tier === "admin" viewers (the POST routes
 * carry requireTier("admin") as the actual gate). Per-command deviations
 * stay slash-only: event-reminder create/edit/clear/sync (creator axis has
 * no web notion — v1 keeps web reminders at the staff setchannel mutation)
 * and the reaction-role emoji pickers are mirrored by a plain emoji text
 * field (the console collects what the slash's pending-emoji wait collects).
 *
 * PRG flash (POST-REDIRECT-GET): ?done=<slug> / ?error=<slug> render a
 * banner ONLY when the slug exists in the frozen FLASH maps below — the raw
 * query value is never echoed, so a hostile redirect target is inert.
 */

const { html } = require("../escape");
const { emptyState, banner } = require("../components");
const { DEFAULTS, LIST_CAP, PANEL_CAP } = require("../../data/integrationsData");
const { MAX_OPTIONS_PER_PANEL } = require("../../../features/reactionRoles/service");

/** Fixed admin hint (§8.6: /honeypot exempt = Admin) — same wording as the settings page. */
const ADMIN_WRITE_HINT = "Changing this requires Manage Server (server admin).";

/** Honest degradation line for a cluster whose read failed. */
const READ_FAILED = "Unavailable — the integrations read failed for this section.";

/**
 * Governing slash commands + §8.6 write tier (staff except the honeypot
 * exempt list, which mutates staff_roles behind a ManageGuild-only gate).
 * Frozen view-author constants — the badge tier class is only ever taken
 * from this map, never from data.
 */
const GOVERN = Object.freeze({
  youtubeFeed: { cmd: "youtube add|remove", tier: "staff" },
  youtubeConfig: { cmd: "setyoutube channel|interval|uploadrole", tier: "staff" },
  twitchFeed: { cmd: "twitch add|remove", tier: "staff" },
  twitchConfig: { cmd: "settwitch channel|role|interval", tier: "staff" },
  reactionRoles: { cmd: "reactionrole panel|option …", tier: "staff" },
  reminderConfig: { cmd: "eventreminder create|edit|clear", tier: "staff" },
  reminderChannel: { cmd: "eventreminder setchannel", tier: "staff" },
  honeypotChannels: { cmd: "honeypot channel add|del", tier: "staff" },
  honeypotBanRoles: { cmd: "honeypot banrole add|del", tier: "staff" },
  honeypotExempt: { cmd: "honeypot exempt add|del", tier: "admin" },
});

// ---------------------------------------------------------------------------
// PRG flash vocabulary (frozen slugs → fixed messages; the *query value* is
// only ever a map lookup — unknown slugs render nothing, values never echo).
// Messages mirror the slash replies where one exists.
// ---------------------------------------------------------------------------

const FLASH_DONE = Object.freeze({
  yt_added: "Subscribed to the YouTube channel.",
  yt_removed: "Unsubscribed from the YouTube channel.",
  yt_channel_set: "YouTube notification channel updated.",
  yt_interval_set: "YouTube polling interval updated.",
  yt_upload_role_set: "YouTube upload mention role set.",
  yt_upload_role_cleared: "YouTube upload notifications no longer mention a role.",
  tw_added: "Subscribed to the Twitch channel.",
  tw_removed: "Unsubscribed from the Twitch channel.",
  tw_channel_set: "Twitch notification channel updated.",
  tw_role_set: "Twitch go-live mention role set.",
  tw_role_cleared: "Twitch go-live notifications no longer mention a role.",
  tw_interval_set: "Twitch polling interval updated.",
  rr_panel_created: "Reaction-role panel created.",
  rr_panel_deleted: "Reaction-role panel deleted.",
  rr_option_added: "Reaction-role option saved.",
  rr_option_removed: "Reaction-role option removed.",
  er_channel_set: "Event reminder default channel updated.",
  er_channel_cleared: "Event reminder default channel cleared — configs must override per event.",
  hp_channel_added:
    "Channel marked as a honeypot — anyone who posts there is banned (unless exempt).",
  hp_channel_removed: "Channel removed from the honeypot list.",
  hp_banrole_added:
    "Role marked as a honeypot ban role — granting it bans the member (unless exempt).",
  hp_banrole_removed: "Role removed from the honeypot ban-role list.",
  hp_exempt_added:
    "Role added to staff roles (also grants honeypot exemption).",
  hp_exempt_removed: "Role removed from staff roles (honeypot exemption revoked).",
});

const FLASH_ERROR = Object.freeze({
  missing_field: "Missing required field — nothing was changed.",
  invalid_input:
    "Invalid YouTube input — use a full channel URL, an @username, or a UC…/HC… channel ID.",
  invalid_channel_id: "Invalid channel ID — Discord channel IDs are 17–20 digits.",
  invalid_role_id: "Invalid role ID — Discord role IDs are 17–20 digits.",
  invalid_message_id: "Invalid panel message ID.",
  invalid_interval: "Polling interval must be between 1 and 60 minutes.",
  invalid_level: "Invalid minimum level (a non-negative whole number).",
  rr_emoji_invalid:
    "That doesn't look like an emoji — send a unicode emoji (e.g. 👍), a custom emoji like <:name:id>, or a known shortcode like +1.",
  channel_missing:
    "That channel is not in this server (bot cache) — nothing was changed.",
  role_missing: "That role is not in this server (bot cache) — nothing was changed.",
  youtube_not_configured: "YouTube is not configured on this bot — not configured: YOUTUBE_API_KEY.",
  twitch_not_configured:
    "Twitch is not configured on this bot. Set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` first.",
  yt_not_found: "No subscription found.",
  tw_not_found: "No matching subscription found.",
  tw_resolve_failed: "Could not find a Twitch channel for that login. Check the login and try again.",
  tw_exists: "That Twitch channel is already subscribed in this server.",
  rr_panel_not_found: "No reaction-role panel with that message ID.",
  rr_option_limit: `This panel already has ${MAX_OPTIONS_PER_PANEL} options (Discord reaction limit). Remove one first.`,
  rr_emoji_unavailable:
    "That custom emoji is not available in this server (or the bot can't access it) — use a unicode emoji or one from this server.",
  rr_channel_unsendable: "That channel cannot receive messages.",
  rr_post_failed: "Could not post the panel — the bot may be missing Send Messages in that channel.",
  rr_offline:
    "The bot client is not attached right now — create panels with /reactionrole panel create once it is online.",
  rr_option_not_found: "No option with that emoji on this panel.",
  rr_role_managed:
    "That role is managed by an integration and cannot be assigned by the bot.",
  er_channel_type: "Only text or announcement channels can receive event reminders.",
  hp_channel_exists: "That channel is already set up as a honeypot channel.",
  hp_channel_not_found: "That channel was not a honeypot channel.",
  hp_banrole_exists: "That role is already a honeypot ban role.",
  hp_banrole_not_found: "That role was not a honeypot ban role.",
  hp_exempt_not_found: "That role is not a configured staff role.",
  hp_role_everyone: "You cannot use @everyone as a honeypot ban role.",
  hp_role_managed:
    "That role is managed by an integration. Prefer a normal server role for ban-role honeypots.",
});

/**
 * Whitelist the PRG query: returns { done, error } where each value is a
 * KNOWN slug or null. Anything else (junk, arrays, hostile strings) is
 * dropped — the flash map lookup is the only consumer.
 * @param {{done?: unknown, error?: unknown}|undefined|null} query
 */
function flashFromQuery(query) {
  const done = typeof query?.done === "string" && FLASH_DONE[query.done] ? query.done : null;
  const error = typeof query?.error === "string" && FLASH_ERROR[query.error] ? query.error : null;
  return { done, error };
}

/**
 * Flash banner for the PRG round-trip (frozen message chosen by slug).
 * @param {{done: string|null, error: string|null}|null} flash
 */
function flashBanner(flash) {
  if (!flash) return html``;
  if (flash.error && FLASH_ERROR[flash.error]) return banner("warn", FLASH_ERROR[flash.error]);
  if (flash.done && FLASH_DONE[flash.done]) return banner("info", FLASH_DONE[flash.done]);
  return html``;
}

// ---------------------------------------------------------------------------
// Write-form helpers (plain HTML; the POST routes re-validate everything)
// ---------------------------------------------------------------------------

/** One label+input pair sized for the compact write forms. */
function formField(label, name, { type = "text", placeholder = "", value = "" } = {}) {
  return html`<label>${label}<input type="${type}" name="${name}" placeholder="${placeholder}" value="${value}"/></label>`;
}

/**
 * One POST form inside a section. The hidden `_csrf` field is the CSRF
 * double-submit half (middleware/csrf.js reads it for /g/ mutations).
 */
function writeForm(actionPath, csrfToken, fieldsHtml, submitLabel) {
  return html`<form class="integ-write-form" method="post" action="${actionPath}">
    <input type="hidden" name="_csrf" value="${csrfToken || ""}"/>
    <div class="integ-write-fields">${fieldsHtml}</div>
    <button type="submit" class="btn btn-write">${submitLabel}</button>
  </form>`;
}

/** <select> of stored ids (labels are ids + optional short decoration). */
function idSelect(name, rows, labelOf, placeholder) {
  const options = rows.map((r) => {
    const id = String(r);
    return html`<option value="${id}">${labelOf ? labelOf(r) : id}</option>`;
  });
  return html`<label><select name="${name}">${placeholder
    ? html`<option value="">${placeholder}</option>`
    : html``}${options}</select></label>`;
}

/**
 * Channel reference — settings.js twin (id is the source-of-truth value;
 * an OPTIONAL cache-only name decorates it; absent ⇒ id alone).
 */
function channelRef(channelId, resolveName) {
  if (!channelId) return html`<em class="muted">not configured</em>`;
  const name = typeof resolveName === "function" ? resolveName(channelId) : null;
  return html`<code class="channel-id">${channelId}</code>${name
    ? html` <span class="channel-name">(${name})</span>`
    : html``}`;
}

/** Role reference — same cache-only contract as channelRef. */
function roleRef(roleId, resolveName) {
  if (!roleId) return html`<em class="muted">not configured</em>`;
  const name = typeof resolveName === "function" ? resolveName(roleId) : null;
  return html`<code class="role-id">${roleId}</code>${name
    ? html` <span class="channel-name">(${name})</span>`
    : html``}`;
}

/** Integer-ish display that never invents a number for null. */
function num(value, suffix = "") {
  return value == null ? html`<em class="muted">unset</em>` : html`${value}${suffix}`;
}

/**
 * Deterministic UTC stamp for stored epoch-ms values (no locale drift,
 * no fake "relative" times). null → honest em-dash.
 */
function utcMs(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return html`<em class="muted">—</em>`;
  let iso;
  try {
    iso = new Date(Number(ms)).toISOString();
  } catch {
    return html`<em class="muted">invalid</em>`;
  }
  return html`${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * Governance badge: the slash command that owns this row + its §8.6 write
 * tier. Tier/class come ONLY from the frozen GOVERN values (whitelist) —
 * unknown keys degrade to label text, never a class from data.
 * @param {keyof typeof GOVERN} key
 */
function governsBadge(key) {
  const g = GOVERN[key];
  if (!g) return html`<span class="setting-govern">via slash command</span>`;
  const admin = g.tier === "admin";
  return html`<span class="setting-govern">via <code>/${g.cmd}</code> · write tier
    <span class="badge badge-tier badge-tier-${admin ? "admin" : "staff"}">${admin ? "admin" : "staff"}</span></span>`;
}

/** One definition-list row (same shape as the settings page). */
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
    <section class="panel settings-panel integrations-panel">
      <h2>${title}</h2>
      ${opts.hint ? html`<p class="setting-admin-hint">${opts.hint}</p>` : html``}
      ${opts.notice ? banner("warn", opts.notice) : html``}
      ${bodyHtml}
    </section>`;
}

/** Whitelisted state pill (live/off) — kind is a view constant. */
function pill(kind, label) {
  const safe = kind === "live" || kind === "off" ? kind : "off";
  return html`<span class="integ-pill integ-pill-${safe}">${label}</span>`;
}

/** Truncation honesty line for a capped list (caps are the DATA module's). */
function truncationNote(total, cap) {
  if (total <= cap) return html``;
  return html`<p class="subheading">
    Showing the first ${cap} of ${total} rows (§8.6 list cap — more exist).
  </p>`;
}

// ---------------------------------------------------------------------------
// YouTube section
// ---------------------------------------------------------------------------

function youtubeSection(yt, ctx) {
  if (yt.available === false) {
    return section("YouTube", emptyState(READ_FAILED));
  }
  const { resolveChannelName, resolveRoleName, guildId, csrfToken } = ctx;
  const credLine = yt.enabled
    ? pill("live", "API key configured")
    : pill("off", "API key missing");
  const configRows = html`
    ${settingRow(
      "Notification channel",
      channelRef(yt.notifyChannelId, resolveChannelName),
      html`default: unset`,
      governsBadge("youtubeConfig")
    )}
    ${settingRow(
      "Upload ping role",
      roleRef(yt.uploadRoleId, resolveRoleName),
      html`default: unset`,
      governsBadge("youtubeConfig")
    )}
    ${settingRow(
      "Polling interval",
      num(yt.pollIntervalMinutes, " min"),
      html`default ${DEFAULTS.youtubePollingIntervalMinutes} min`,
      governsBadge("youtubeConfig")
    )}`;

  const rows = yt.rows.length
    ? html`<table class="list-table settings-table">
        <thead>
          <tr><th scope="col">Channel</th><th scope="col">URL</th><th scope="col">Last video</th><th scope="col">Last checked</th></tr>
        </thead>
        <tbody>
          ${yt.rows.map((r) => html`<tr>
            <td>${r.channelName ?? html`<em class="muted">—</em>`}<br/><code>${r.id ?? "—"}</code></td>
            <td class="integ-url">${r.channelUrl ?? html`<em class="muted">—</em>`}</td>
            <td>${r.lastVideoId ? html`<code>${r.lastVideoId}</code>` : html`<em class="muted">—</em>`}</td>
            <td>${utcMs(r.lastChecked)}</td>
          </tr>`)}
        </tbody>
      </table>`
    : emptyState("No subscribed channels.");

  const base = `/g/${encodeURIComponent(String(guildId || ""))}/integrations/youtube`;
  const forms = html`
    <details class="integ-write">
      <summary>Subscriptions (staff)</summary>
      ${writeForm(`${base}/add`, csrfToken,
        formField("Channel URL, @username or UC/HC id", "url", { placeholder: "https://www.youtube.com/@somechannel" }),
        "Subscribe (adds channel)")}
      ${yt.rows.length
        ? writeForm(`${base}/remove`, csrfToken,
            idSelect("channel_id", yt.rows.map((r) => r.id).filter(Boolean),
              (r) => `${r.channelName ?? "—"} (${r.id})`, null),
            "Unsubscribe")
        : html``}
    </details>
    <details class="integ-write">
      <summary>Settings (staff — API keys stay in the environment)</summary>
      ${writeForm(`${base}/channel`, csrfToken,
        formField("Notify channel id", "channel_id", { placeholder: "123456789012345678" }),
        "Set notify channel")}
      ${writeForm(`${base}/uploadrole`, csrfToken,
        formField("Upload ping role id (empty clears)", "role_id", { placeholder: "123456789012345678" }),
        "Set upload role")}
      ${writeForm(`${base}/interval`, csrfToken,
        formField("Polling minutes (1-60)", "minutes", { type: "number", placeholder: "5" }),
        "Set interval")}
    </details>`;

  return section(
    "YouTube",
    html`
      <p class="integ-cred">Ticker credentials: ${credLine}</p>
      <div class="settings-rows">${configRows}</div>
      ${rows}
      ${truncationNote(yt.total, LIST_CAP)}
      ${forms}
      <p class="subheading">${governsBadge("youtubeFeed")}</p>`,
    { notice: yt.disabledReason }
  );
}

// ---------------------------------------------------------------------------
// Twitch section
// ---------------------------------------------------------------------------

function twitchSection(tw, ctx) {
  if (tw.available === false) {
    return section("Twitch", emptyState(READ_FAILED));
  }
  const { resolveChannelName, resolveRoleName, guildId, csrfToken } = ctx;
  // Mirrors /settwitch settings ("Bot credentials: configured|not
  // configured") — a STATE line; the credential values never exist here.
  const credLine = tw.enabled ? "configured" : "not configured";
  const configRows = html`
    <div class="setting-row">
      <span class="setting-label">Bot credentials</span>
      <span class="setting-value">${credLine}</span>
      <span class="setting-default">env-gated</span>
      <span class="setting-slash">set in the bot environment</span>
    </div>
    ${settingRow(
      "Notification channel",
      channelRef(tw.notifyChannelId, resolveChannelName),
      html`default: unset`,
      governsBadge("twitchConfig")
    )}
    ${settingRow(
      "Ping role",
      roleRef(tw.notifyRoleId, resolveRoleName),
      html`default: unset`,
      governsBadge("twitchConfig")
    )}
    ${settingRow(
      "Polling interval",
      num(tw.pollIntervalMinutes, " min"),
      html`default ${DEFAULTS.twitchPollingIntervalMinutes} min`,
      governsBadge("twitchConfig")
    )}`;

  const rows = tw.rows.length
    ? html`<table class="list-table settings-table">
        <thead>
          <tr><th scope="col">Broadcaster</th><th scope="col">Login</th><th scope="col">Status</th><th scope="col">Last stream</th><th scope="col">Last checked</th></tr>
        </thead>
        <tbody>
          ${tw.rows.map((r) => html`<tr>
            <td>${r.displayName ?? html`<em class="muted">—</em>`}<br/><code>${r.broadcasterId ?? "—"}</code></td>
            <td><code>${r.login ?? "—"}</code></td>
            <td>${r.isLive ? pill("live", "LIVE") : pill("off", "offline")}</td>
            <td>${r.lastStreamId ? html`<code>${r.lastStreamId}</code>` : html`<em class="muted">—</em>`}</td>
            <td>${utcMs(r.lastChecked)}</td>
          </tr>`)}
        </tbody>
      </table>`
    : emptyState("No subscribed channels.");

  const base = `/g/${encodeURIComponent(String(guildId || ""))}/integrations/twitch`;
  const forms = html`
    <details class="integ-write">
      <summary>Subscriptions (staff — needs TWITCH_CLIENT_ID/SECRET configured)</summary>
      ${writeForm(`${base}/add`, csrfToken,
        formField("Twitch login or URL", "login", { placeholder: "coolstreamer" }),
        "Subscribe (resolves via Twitch API)")}
      ${tw.rows.length
        ? writeForm(`${base}/remove`, csrfToken,
            idSelect("channel", tw.rows.map((r) => r.login).filter(Boolean),
              (r) => `${r.displayName ?? "—"} (${r.login})`, null),
            "Unsubscribe")
        : html``}
    </details>
    <details class="integ-write">
      <summary>Settings (staff)</summary>
      ${writeForm(`${base}/channel`, csrfToken,
        formField("Notify channel id", "channel_id", { placeholder: "123456789012345678" }),
        "Set notify channel")}
      ${writeForm(`${base}/role`, csrfToken,
        formField("Go-live ping role id (empty clears)", "role_id", { placeholder: "123456789012345678" }),
        "Set ping role")}
      ${writeForm(`${base}/interval`, csrfToken,
        formField("Polling minutes (1-60)", "minutes", { type: "number", placeholder: "2" }),
        "Set interval")}
    </details>`;

  return section(
    "Twitch",
    html`
      <div class="settings-rows">${configRows}</div>
      ${rows}
      ${truncationNote(tw.total, LIST_CAP)}
      ${forms}
      <p class="subheading">${governsBadge("twitchFeed")}</p>`,
    { notice: tw.disabledReason }
  );
}

// ---------------------------------------------------------------------------
// Reaction roles section
// ---------------------------------------------------------------------------

function reactionRolesSection(rr, ctx) {
  if (rr.available === false) {
    return section("Reaction roles", emptyState(READ_FAILED));
  }
  const { resolveChannelName, guildId, csrfToken } = ctx;
  const rows = rr.panels.length
    ? html`<table class="list-table settings-table">
        <thead>
          <tr><th scope="col">Panel</th><th scope="col">Channel</th><th scope="col">Message ID</th><th scope="col">Options</th></tr>
        </thead>
        <tbody>
          ${rr.panels.map((p) => html`<tr>
            <td>${p.title ?? html`<em class="muted">—</em>`}${p.description
              ? html`<br/><span class="integ-desc">${p.description}</span>`
              : html``}</td>
            <td>${channelRef(p.channelId, resolveChannelName)}</td>
            <td><code>${p.messageId ?? "—"}</code></td>
            <td>${p.optionCount == null ? html`<em class="muted">—</em>` : html`${p.optionCount}`}</td>
          </tr>`)}
        </tbody>
      </table>`
    : emptyState("No reaction-role panels stored.");

  const base = `/g/${encodeURIComponent(String(guildId || ""))}/integrations/reaction-roles`;
  const panelSelect = (name) =>
    idSelect(name, rr.panels.map((p) => p.messageId).filter(Boolean),
      (p) => `${p.title ?? "panel"} (${p.messageId})`, null);
  const forms = html`
    <details class="integ-write">
      <summary>Panel (staff — create posts a live embed in the channel)</summary>
      ${writeForm(`${base}/panel/create`, csrfToken,
        html`${formField("Channel id", "channel_id", { placeholder: "123456789012345678" })}
        ${formField("Title (optional)", "title", { placeholder: "Reaction Roles" })}
        ${formField("Description (optional)", "description", { placeholder: "React to get a role." })}`,
        "Create panel")}
      ${rr.panels.length
        ? writeForm(`${base}/panel/delete`, csrfToken, panelSelect("message_id"), "Delete panel")
        : html``}
    </details>
    <details class="integ-write">
      <summary>Options (staff — emoji maps to a role; the console collects
        directly what slash asks for as a follow-up emoji message)</summary>
      ${writeForm(`${base}/option/add`, csrfToken,
        html`${rr.panels.length ? panelSelect("message_id") : formField("Panel message id", "message_id", {})}
        ${formField("Role id", "role_id", { placeholder: "123456789012345678" })}
        ${formField("Emoji (👍, &lt;:name:id&gt; or +1)", "emoji", { placeholder: "👍" })}
        ${formField("Min level (default 0)", "level", { type: "number", placeholder: "0" })}
        <label><input type="hidden" name="removable" value="0"/><input type="checkbox" name="removable" value="1" checked/> removable</label>`,
        "Add/update option")}
      ${rr.panels.length
        ? writeForm(`${base}/option/remove`, csrfToken,
            html`${panelSelect("message_id")} ${formField("Emoji to remove", "emoji", { placeholder: "👍" })}`,
            "Remove option")
        : html``}
    </details>`;

  return section(
    "Reaction roles",
    html`${rows}
      ${truncationNote(rr.total, PANEL_CAP)}
      ${forms}
      <p class="subheading">${governsBadge("reactionRoles")} · options are stored per panel (emoji → role).</p>`
  );
}

// ---------------------------------------------------------------------------
// Event reminders section
// ---------------------------------------------------------------------------

function eventRemindersSection(er, ctx) {
  if (er.available === false) {
    return section("Event reminders", emptyState(READ_FAILED));
  }
  const { resolveChannelName, resolveRoleName, guildId, csrfToken } = ctx;
  const configRows = html`
    ${settingRow(
      "Default notify channel",
      channelRef(er.defaultChannelId, resolveChannelName),
      html`per-event override possible`,
      governsBadge("reminderChannel")
    )}`;
  const rows = er.configs.length
    ? html`<table class="list-table settings-table">
        <thead>
          <tr><th scope="col">Shortname</th><th scope="col">Event ID</th><th scope="col">Ping role</th><th scope="col">Channel</th><th scope="col">Next fire</th><th scope="col">Reminders (sent/unsent)</th></tr>
        </thead>
        <tbody>
          ${er.configs.map((c) => html`<tr>
            <td>${c.shortname ?? html`<em class="muted">—</em>`}${c.persistent
              ? html`<br/><span class="integ-desc">persistent</span>`
              : html``}</td>
            <td><code>${c.scheduledEventId ?? "—"}</code></td>
            <td>${roleRef(c.roleId, resolveRoleName)}</td>
            <td>${c.channelId ? channelRef(c.channelId, resolveChannelName) : html`<em class="muted">default</em>`}</td>
            <td>${utcMs(c.nextFireAt)}</td>
            <td>${c.sentCount} / ${c.unsentCount}</td>
          </tr>`)}
        </tbody>
      </table>`
    : emptyState("No active reminder configs.");

  const base = `/g/${encodeURIComponent(String(guildId || ""))}/integrations/event-reminders`;
  const forms = writeForm(`${base}/channel`, csrfToken,
    formField("Default channel id (empty clears)", "channel_id", { placeholder: "123456789012345678" }),
    "Set default channel");

  return section(
    "Event reminders",
    html`
      <div class="settings-rows">${configRows}</div>
      ${rows}
      ${truncationNote(er.total, LIST_CAP)}
      ${forms}
      <p class="subheading">
        ${governsBadge("reminderConfig")} · next-fire is derived from stored
        offset rows (no live Discord lookup). Reminders are created/edited/cleared
        with <code>/eventreminder create|edit|clear</code> — the web console keeps
        only the staff setchannel write, because slash additionally lets the
        <em>event creator</em> (not staff) configure their own event and the
        console has no per-event ownership notion.
      </p>`
  );
}

// ---------------------------------------------------------------------------
// Honeypot section
// ---------------------------------------------------------------------------

function honeypotSection(hp, ctx) {
  const { guildId, csrfToken, tier, resolveChannelName, resolveRoleName } = ctx;
  const chans = hp.channels || { available: false, rows: [] };
  const bans = hp.banRoles || { available: false, roleIds: [] };
  const ex = hp.exemptRoles || { available: false, rows: [] };

  const chanBody = !chans.available
    ? emptyState(READ_FAILED)
    : chans.rows.length
      ? html`<table class="list-table settings-table">
          <thead>
            <tr><th scope="col">Channel</th><th scope="col">Warning message</th></tr>
          </thead>
          <tbody>
            ${chans.rows.map((c) => html`<tr>
              <td>${channelRef(c.channelId, resolveChannelName)}</td>
              <td>${c.warningMessageId ? html`<code>${c.warningMessageId}</code>` : html`<em class="muted">pending</em>`}</td>
            </tr>`)}
          </tbody>
        </table>`
      : emptyState("No honeypot channels.");

  const banBody = !bans.available
    ? emptyState(READ_FAILED)
    : bans.roleIds.length
      ? html`<ul class="settings-list">
          ${bans.roleIds.map((id) => html`<li>${roleRef(id, resolveRoleName)}</li>`)}
        </ul>`
      : emptyState("No ban roles configured.");

  const staffHref = `/g/${encodeURIComponent(String(guildId || ""))}/staff`;
  const exemptBody = !ex.available
    ? emptyState(READ_FAILED)
    : ex.rows.length
      ? html`<ul class="settings-list">
          ${ex.rows.map(
            (r) => html`<li>${roleRef(r.roleId, resolveRoleName)}${r.level ? html` <em class="muted">(${r.level})</em>` : html``}</li>`
          )}
        </ul>`
      : emptyState("No exempt roles — every member who posts in a honeypot channel gets banned.");

  const base = `/g/${encodeURIComponent(String(guildId || ""))}/integrations/honeypot`;
  const chanSelect = (name) =>
    idSelect(name, chans.rows.map((c) => c.channelId).filter(Boolean), null, null);
  const staffForms = html`
    <details class="integ-write">
      <summary>Trap channels (staff — add posts a warning image, del removes it)</summary>
      ${writeForm(`${base}/channel/add`, csrfToken,
        formField("Channel id", "channel_id", { placeholder: "123456789012345678" }),
        "Add honeypot channel")}
      ${chans.rows.length
        ? writeForm(`${base}/channel/del`, csrfToken, chanSelect("channel_id"), "Remove honeypot channel")
        : html``}
    </details>
    <details class="integ-write">
      <summary>Ban roles (staff — granting a listed role bans the member)</summary>
      ${writeForm(`${base}/banrole/add`, csrfToken,
        formField("Role id", "role_id", { placeholder: "123456789012345678" }),
        "Add ban role")}
      ${bans.roleIds.length
        ? writeForm(`${base}/banrole/del`, csrfToken,
            idSelect("role_id", bans.roleIds, null, null),
            "Remove ban role")
        : html``}
    </details>`;

  // §8.6 per-command tier: exempt add/del are ADMIN-only (the POST routes
  // requireTier("admin"); the form only renders for admin viewers).
  const isAdmin = tier === "admin";
  const exemptForms = isAdmin
    ? html`
        <details class="integ-write">
          <summary>Exempt roles (ADMIN — writes staff_roles)</summary>
          ${writeForm(`${base}/exempt/add`, csrfToken,
            formField("Role id to exempt", "role_id", { placeholder: "123456789012345678" }),
            "Add exempt role")}
          ${ex.rows.length
            ? writeForm(`${base}/exempt/del`, csrfToken,
                idSelect("role_id", ex.rows.map((r) => r.roleId).filter(Boolean),
                  (r) => r.roleId, null),
                "Remove exempt role")
            : html``}
        </details>`
    : html``;

  return section(
    "Honeypot",
    html`
      <h3 class="integ-sub">Trap channels ${governsBadge("honeypotChannels")}</h3>
      ${chanBody}
      ${staffForms}
      <h3 class="integ-sub">Instant-ban roles ${governsBadge("honeypotBanRoles")}</h3>
      ${banBody}
      <h3 class="integ-sub">Exempt roles ${governsBadge("honeypotExempt")}</h3>
      ${exemptBody}
      ${exemptForms}
      ${isAdmin ? html`` : html`<p class="subheading">Sign in with a Manage-Server account to edit exemptions here, or manage the same list on the <a href="${staffHref}">staff page</a>.</p>`}
      <p class="subheading">
        Exemption is the <strong>staff roles</strong> list (same table as
        <code>/staff role add</code>)${isAdmin
          ? html``
          : html`, managed via the <a href="${staffHref}">staff page</a>`}.
        <code>/honeypot exempt</code> is Manage-Server-only (§8.6) — the web
        exempt forms carry the same admin gate.
      </p>`,
    { hint: ADMIN_WRITE_HINT }
  );
}

// ---------------------------------------------------------------------------
// Page body
// ---------------------------------------------------------------------------

/** Compact age for the freshness stamp (settings-page twin). */
function formatAge(ms) {
  const s = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${Math.floor(s % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Full integrations body (goes into the shell via renderShellPage).
 * @param {object} input
 * @param {object} input.snapshot from data/integrationsData.js getIntegrations()
 * @param {(id: string) => string|null} [input.resolveChannelName] cache-only (getClient seam)
 * @param {(id: string) => string|null} [input.resolveRoleName] cache-only (getClient seam)
 * @param {string|null} [input.csrfToken] req.csrfToken (forms embed it as _csrf)
 * @param {string|null} [input.tier] req.guildAccess.tier (admin-only forms gate)
 * @param {{done: string|null, error: string|null}|null} [input.flash] whitelisted PRG flash
 * @returns {import("../escape").SafeString}
 */
function renderIntegrationsBody({ snapshot, resolveChannelName, resolveRoleName, csrfToken, tier, flash }) {
  const s = snapshot || {};
  const emptyCluster = { available: false };
  const yt = s.youtube || emptyCluster;
  const tw = s.twitch || emptyCluster;
  const rr = s.reactionRoles || emptyCluster;
  const er = s.eventReminders || emptyCluster;
  const hp = s.honeypot || { channels: emptyCluster, banRoles: emptyCluster, exemptRoles: emptyCluster };
  const f = s.freshness || null;
  const stamp = f
    ? html` <span class="subheading">snapshot ${formatAge(f.ageMs || 0)} old${f.fromCache ? html` (cached)` : html``}</span>`
    : html``;

  const ctx = {
    resolveChannelName,
    resolveRoleName,
    guildId: s.guildId,
    csrfToken: csrfToken || null,
    tier: tier || null,
  };

  return html`
    ${flashBanner(flash)}
    <div class="settings-grid integrations-grid">
      ${youtubeSection(yt, ctx)}
      ${twitchSection(tw, ctx)}
      ${reactionRolesSection(rr, ctx)}
      ${eventRemindersSection(er, ctx)}
      ${honeypotSection(hp, ctx)}
      <p class="subheading settings-stamp">
        Slash commands stay the security source of truth — these forms post the
        same service writes with CSRF + per-command tiers (§8.6). Values cached
        at least 30&nbsp;s per guild (§8.6 query budget); successful writes
        invalidate the cache immediately.${stamp}
      </p>
    </div>`;
}

module.exports = {
  renderIntegrationsBody,
  GOVERN,
  ADMIN_WRITE_HINT,
  FLASH_DONE,
  FLASH_ERROR,
  flashFromQuery,
  flashBanner,
};
