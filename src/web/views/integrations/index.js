/**
 * Integrations page body for GET /g/:guildId/integrations (roadmap/
 * web-admin.md §8.6 "Integrations: YouTube, Twitch, reaction roles, event
 * reminders, honeypot | Staff | per-command tier (/honeypot exempt = Admin)
 * | 1 view · 2 write" — subtask 20, Phase 1 READ-ONLY VIEW).
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
 * exist in the snapshot).
 *
 * Write-tier badges come from the frozen GOVERN map below (view-author
 * constants, whitelisted tier classes) — never from row data. Per §8.6 the
 * integration writes are staff-tier EXCEPT `/honeypot exempt` (Admin); the
 * slash handlers stay the security source of truth (their gates are noted
 * where they differ, e.g. /eventreminder create also accepts the event
 * creator).
 *
 * Phase 1 renders NO forms and NO controls (§8.8): writes arrive in
 * Phase 2 (subtask 26) with the per-command tiers noted on each section.
 */

const { html } = require("../escape");
const { emptyState, banner } = require("../components");
const { DEFAULTS, LIST_CAP, PANEL_CAP } = require("../../data/integrationsData");

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

function youtubeSection(yt, resolveChannelName, resolveRoleName) {
  if (yt.available === false) {
    return section("YouTube", emptyState(READ_FAILED));
  }
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

  return section(
    "YouTube",
    html`
      <p class="integ-cred">Ticker credentials: ${credLine}</p>
      <div class="settings-rows">${configRows}</div>
      ${rows}
      ${truncationNote(yt.total, LIST_CAP)}
      <p class="subheading">${governsBadge("youtubeFeed")}</p>`,
    { notice: yt.disabledReason }
  );
}

// ---------------------------------------------------------------------------
// Twitch section
// ---------------------------------------------------------------------------

function twitchSection(tw, resolveChannelName, resolveRoleName) {
  if (tw.available === false) {
    return section("Twitch", emptyState(READ_FAILED));
  }
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

  return section(
    "Twitch",
    html`
      <div class="settings-rows">${configRows}</div>
      ${rows}
      ${truncationNote(tw.total, LIST_CAP)}
      <p class="subheading">${governsBadge("twitchFeed")}</p>`,
    { notice: tw.disabledReason }
  );
}

// ---------------------------------------------------------------------------
// Reaction roles section
// ---------------------------------------------------------------------------

function reactionRolesSection(rr, resolveChannelName) {
  if (rr.available === false) {
    return section("Reaction roles", emptyState(READ_FAILED));
  }
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
  return section(
    "Reaction roles",
    html`${rows}
      ${truncationNote(rr.total, PANEL_CAP)}
      <p class="subheading">${governsBadge("reactionRoles")} · options are stored per panel (emoji → role).</p>`
  );
}

// ---------------------------------------------------------------------------
// Event reminders section
// ---------------------------------------------------------------------------

function eventRemindersSection(er, resolveChannelName, resolveRoleName) {
  if (er.available === false) {
    return section("Event reminders", emptyState(READ_FAILED));
  }
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
  return section(
    "Event reminders",
    html`
      <div class="settings-rows">${configRows}</div>
      ${rows}
      ${truncationNote(er.total, LIST_CAP)}
      <p class="subheading">
        ${governsBadge("reminderConfig")} · next-fire is derived from stored
        offset rows (no live Discord lookup in Phase 1). Slash
        <code>/eventreminder create</code> additionally lets the <em>event
        creator</em> configure their own event (handler gate).
      </p>`
  );
}

// ---------------------------------------------------------------------------
// Honeypot section
// ---------------------------------------------------------------------------

function honeypotSection(hp, guildId, resolveChannelName, resolveRoleName) {
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

  return section(
    "Honeypot",
    html`
      <h3 class="integ-sub">Trap channels ${governsBadge("honeypotChannels")}</h3>
      ${chanBody}
      <h3 class="integ-sub">Instant-ban roles ${governsBadge("honeypotBanRoles")}</h3>
      ${banBody}
      <h3 class="integ-sub">Exempt roles ${governsBadge("honeypotExempt")}</h3>
      ${exemptBody}
      <p class="subheading">
        Exemption is the <strong>staff roles</strong> list (same table as
        <code>/staff role add</code>) — manage it on the
        <a href="${staffHref}">staff page</a>.
        <code>/honeypot exempt</code> is Manage-Server-only (§8.6);
        editable in Phase 2 (subtask 26).
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
 * @returns {import("../escape").SafeString}
 */
function renderIntegrationsBody({ snapshot, resolveChannelName, resolveRoleName }) {
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

  return html`
    <div class="settings-grid integrations-grid">
      ${youtubeSection(yt, resolveChannelName, resolveRoleName)}
      ${twitchSection(tw, resolveChannelName, resolveRoleName)}
      ${reactionRolesSection(rr, resolveChannelName)}
      ${eventRemindersSection(er, resolveChannelName, resolveRoleName)}
      ${honeypotSection(hp, s.guildId, resolveChannelName, resolveRoleName)}
      <p class="subheading settings-stamp">
        Read-only view — writes arrive in Phase 2 with per-command tiers
        (§8.6). Values cached at least 30&nbsp;s per guild (§8.6 query
        budget).${stamp}
      </p>
    </div>`;
}

module.exports = {
  renderIntegrationsBody,
  GOVERN,
  ADMIN_WRITE_HINT,
};
