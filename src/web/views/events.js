/**
 * Web-admin calendar views for Community Events (#222).
 *
 * Server-rendered fragments for the guild shell (layout.renderShellPage owns
 * the document; everything here is `content`). Escaping discipline: the
 * escape.js `html` tagged template escapes every interpolation by default;
 * fragments are SafeStrings and nest DIRECTLY (never String() them — raw()
 * over a SafeString flattens it to "[object Object]"). Arrays of fragments
 * interpolate as-is (renderValue flattens them).
 *
 * No client JS: every action is a POST form carrying the CSRF field,
 * matching routes/settings.js conventions. Routes wrap renders in
 * withReq(req, fn) so fragments read the flash query off req.originalUrl.
 */

const { html } = require("./escape.js");

const pad2 = (n) => String(n).padStart(2, "0");

const STATUS_BADGE = {
  draft: "draft",
  pending_confirm: "draft",
  scheduled: "scheduled",
  post_failed: "failed",
  posted: "posted",
  archived: "archived",
};

// Tiny holder so fragments can read req without threading it everywhere
// (routes set it around each render call).
const reqHolder = { req: null };
function withReq(req, fn) {
  reqHolder.req = req;
  try {
    return fn();
  } finally {
    reqHolder.req = null;
  }
}

/**
 * "Fri, Jun 6, 2026, 8:00 PM" in the guild zone (honest fallback).
 *
 * Never echoes the broken value: a non-numeric instant (legacy rows carried
 * TEXT dates / the string "NaN" — migration 072 repairs them) and an invalid
 * zone BOTH render "—" — the same honest-unknown doctrine as the dashboard.
 * The old `String(ms)` fallback printed literal "NaN" in the calendar.
 */
function fmtTime(ms, zone) {
  if (ms == null) return "—";
  const n = Number(ms);
  if (!Number.isFinite(n)) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone || "UTC",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(n));
  } catch {
    return "—";
  }
}

/** Guild-zone yyyy-mm-dd bucket for the month grid. */
function dayKey(ms, zone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: zone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(Number(ms)));
  } catch {
    return "";
  }
}

/** "Fri, Jun 6" from a yyyy-mm-dd bucket (agenda rows; k carries the zone). */
function dayLabel(k) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(new Date(`${k}T12:00:00Z`));
  } catch {
    return k;
  }
}

const csrf = (token) => html`<input type="hidden" name="_csrf" value="${token || ""}" />`;

/**
 * Hidden body routing (mutation contract): POST paths are literal, so the
 * action + event id ride the form body (see routes/events.js header).
 */
const act = (id, name, idField = "event_id") =>
  html`<input type="hidden" name="action" value="${name}" />
    <input type="hidden" name="${idField}" value="${id}" />`;

const badge = (status) =>
  html`<span class="badge badge--${STATUS_BADGE[status] || "draft"}"
    >${STATUS_BADGE[status] || status}</span
  >`;

const link = (ev, text) =>
  html`<a href="/g/${ev.community_id}/events/${ev.id}">${text ?? ev.title}</a>`;

/**
 * Whitelisted-redirect flash (same discipline as settings.js: read the RAW
 * url, never req.query). `err` messages are produced server-side from
 * service `{ok:false,error}` strings, URL-encoded, and escaped again on
 * render — specific (AGENTS.md error doctrine) without XSS surface.
 */
function flash() {
  const m = /[?&](ok|err)=([^&]*)/.exec(reqHolder.req?.originalUrl || "");
  if (!m) return "";
  const decode = (s) =>
    decodeURIComponent(s.replace(/\+/g, " ")).slice(0, 300).replace(/[\r\n]+/g, " ");
  if (m[1] === "ok") return html`<p class="flash flash--ok">${decode(m[2])}</p>`;
  return html`<p class="flash flash--err">${decode(m[2]) || "Action failed."}</p>`;
}

const msgLink = (ev, linkUrl) =>
  linkUrl
    ? html`<a href="${linkUrl}" rel="noreferrer" target="_blank"
        >Discord message ↗</a
      >`
    : html`<em>not posted yet</em>`;

// ── month view ──────────────────────────────────────────────────────────────

function renderEventsMonth({
  cid,
  year,
  month,
  zone,
  events,
  drafts,
  scheduled,
  nowMs,
  csrfToken,
}) {
  const byDay = new Map();
  for (const ev of events) {
    const k = dayKey(ev.start_at, zone);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(ev);
  }
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // Monday-first grid
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push("");
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${year}-${pad2(month)}-${pad2(d)}`);

  const todayKey = dayKey(nowMs, zone);
  const gridRows = [];
  for (let i = 0; i < cells.length; i += 7) {
    const week = cells.slice(i, i + 7).map((k) => {
      if (!k) return html`<td class="cal-empty"></td>`;
      const evs = (byDay.get(k) || []).map((ev) => {
        const inProgress =
          ev.end_at != null &&
          Number(ev.start_at) <= nowMs &&
          nowMs < Number(ev.end_at);
        return html`<div class="cal-ev">
          ${link(ev)} ${badge(ev.status)}${inProgress
            ? html`<span class="badge badge--live" title="in progress">live</span>`
            : ""}
          <div class="muted">
            ${fmtTime(ev.start_at, zone).split(", ").slice(-1)[0]}
          </div>
        </div>`;
      });
      return html`<td class="${k === todayKey ? "cal-cell cal-today" : "cal-cell"}">
        <div class="cal-day">
          ${Number(k.slice(-2))}${k === todayKey
            ? html` <span class="cal-today-tag">Today</span>`
            : ""}
        </div>
        <div class="cal-evs">${evs}</div>
      </td>`;
    });
    gridRows.push(html`<tr>${week}</tr>`);
  }

  const prev = new Date(Date.UTC(year, month - 2, 1));
  const next = new Date(Date.UTC(year, month, 1));
  const nav = (d, label) =>
    html`<a href="/g/${cid}/events?y=${d.getUTCFullYear()}&m=${d.getUTCMonth() + 1}"
      >${label}</a
    >`;

  const lists = (rows, empty) =>
    rows.length
      ? html`<ul class="cal-list">
          ${rows.map(
            (ev) => html`<li>${link(ev)} ${badge(ev.status)} · ${fmtTime(ev.start_at, zone)}</li>`,
          )}
        </ul>`
      : html`<p class="muted">${empty}</p>`;

  // #650: the agenda is the SAME byDay buckets as the grid — phone users get a
  // list, desktop keeps the month grid; both ship in the HTML and CSS toggles
  // them at the shell's 719px breakpoint. No second query.
  const agendaDays = [];
  for (const k of cells) {
    if (!k) continue;
    const evs = byDay.get(k);
    if (!evs || !evs.length) continue;
    agendaDays.push(html`<li class="cal-agenda-day">
      <div class="cal-agenda-date${k === todayKey ? " cal-today" : ""}">
        ${dayLabel(k)}${k === todayKey ? html` <span class="cal-today-tag">Today</span>` : ""}
      </div>
      <ul class="cal-list">
        ${evs.map(
          (ev) => html`<li>${link(ev)} ${badge(ev.status)} · ${fmtTime(ev.start_at, zone)}</li>`,
        )}
      </ul>
    </li>`);
  }

  return html`
    ${flash()}
    <div class="cal-nav">
      ${nav(prev, "← prev")} · ${year}-${pad2(month)} · ${nav(next, "next →")}
      <span class="muted">(guild zone: ${zone})</span>
    </div>
    <nav class="cal-pages" aria-label="Event pages">
      <a href="/g/${cid}/events/archive">Archive</a>
      <a href="/g/${cid}/events/presets">Signup presets</a>
      <a href="/g/${cid}/events/series">Series</a>
      <a href="/g/${cid}/events/scheduled">Scheduled posts</a>
    </nav>
    <table class="cal-grid">
      <thead>
        <tr>
          ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => html`<th>${d}</th>`)}
        </tr>
      </thead>
      <tbody>${gridRows}</tbody>
    </table>
    <ol class="cal-agenda">
      ${agendaDays.length
        ? agendaDays
        : html`<li class="muted">Nothing scheduled this month.</li>`}
    </ol>
    <div class="cal-panels">
      <section class="bs-panel">
        <h2>Unposted drafts</h2>
        ${lists(drafts, "No drafts waiting.")}
      </section>
      <section class="bs-panel">
        <h2>Queued posts</h2>
        ${lists(scheduled, "Nothing queued to post.")}
      </section>
      <section class="bs-panel">
        <h2>New event (quick)</h2>
        <form method="post" action="/g/${cid}/events" class="form-row">
          ${csrf(csrfToken)}
          <label>Title <input name="title" maxlength="150" required /></label>
          <label
            >Start (guild<br />zone, e.g.<br />"Fri 8pm" or<br />"2026-06-06<br />20:00")<br /><input
              name="start"
              maxlength="60"
              required
          /></label>
          <label>Channel id <input name="channel_id" maxlength="20" autocomplete="off" data-lookup="channels" data-lookup-url="/g/${cid}/lookups/channels" /></label>
          <button type="submit" class="btn btn-primary">Save draft</button>
        </form>
      </section>
    </div>
  `;
}

// ── event detail ────────────────────────────────────────────────────────────

function renderEventDetail({
  cid,
  ev,
  settings,
  zone,
  options,
  signupsByOption,
  waitlist,
  counts,
  reminders,
  activity,
  messageLinkUrl,
  canManage,
  csrfToken,
}) {
  const cutoffText =
    ev.cutoff_at != null
      ? `${fmtTime(ev.cutoff_at, zone)} — signups ${
          Number(ev.cutoff_at) <= Date.now() ? "CLOSED" : "open until then"
        }`
      : "no cutoff";

  const optionRows = options.map((o) => {
    const names = signupsByOption.get(o.id) || [];
    const cap = o.capacity ? `${o.capacity}` : "∞";
    const shown = settings.show_attendees
      ? html`<span class="muted"
          >${names.slice(0, 30).join(", ") +
          (names.length > 30 ? ` …and ${names.length - 30} more` : "") ||
          "—"}</span
        >`
      : html`<span class="muted">hidden (show-attendees off)</span>`;
    return html`<tr>
      <td data-label="Option">${o.label}${o.emoji ? ` ${o.emoji}` : ""}</td>
      <td data-label="Signups">${names.length} / ${cap}</td>
      <td data-label="Names">${shown}</td>
      <td data-label="Waitlist">${o.waitlist_on ? `${(waitlist.get(o.id) || []).length} waiting` : "no waitlist"}</td>
      ${canManage
        ? html`<td>
            <form
              method="post"
              action="/g/${cid}/events/action"
              class="inline"
            >
              ${csrf(csrfToken)}${act(ev.id, "option-remove")}
              <input type="hidden" name="option_id" value="${o.id}" />
              <button class="btn btn-sm" type="submit">Remove</button>
            </form>
          </td>`
        : ""}
    </tr>`;
  });

  const waitRows = [...waitlist.entries()].flatMap(([oid, rows]) =>
    rows.map((r) =>
      html`<li>
        <code>${r.user_id}</code> waiting for
        <strong>${options.find((o) => o.id === oid)?.label ?? `#${oid}`}</strong>
        (position ${r.position})
      </li>`,
    ),
  );

  const reminderRows = reminders.map((r) =>
    html`<tr>
      <td data-label="Fires">${fmtTime(r.fire_at, zone)}</td>
      <td data-label="State">${r.state}${r.attempts ? ` (${r.attempts} tries)` : ""}</td>
      <td data-label="Role">${r.role_id ? html`pings <code>${r.role_id}</code>` : "—"}</td>
      <td data-label="Body">${r.body ? html`${String(r.body).slice(0, 60)}` : "default text"}</td>
      ${canManage
        ? html`<td>
            <form
              method="post"
              action="/g/${cid}/events/action"
              class="inline"
            >
              ${csrf(csrfToken)}${act(ev.id, "reminder-remove")}
              <input type="hidden" name="reminder_id" value="${r.id}" />
              <button class="btn btn-sm" type="submit">Remove</button>
            </form>
          </td>`
        : ""}
    </tr>`,
  );

  const activityRows = activity.slice(0, 40).map((a) => {
    const who = a.actor_id ? html` by <code>${a.actor_id}</code>` : "";
    const det = a.detail ? html` — ${String(a.detail).slice(0, 120)}` : "";
    return html`<li>${fmtTime(a.created_at, zone)} · ${a.action}${who}${det}</li>`;
  });

  // #650: actions group into Post / Signups / Edit / Danger panels (shared
  // .panel card; destructive delete rides .danger-zone). Every action name,
  // field and CSRF posture is unchanged — this is chrome, not behavior.
  const manageForms = canManage
    ? html`
        <section class="bs-panel">
          <h2>Post</h2>
          <div class="cal-actions">
            <form method="post" action="/g/${cid}/events/action" class="inline">
              ${csrf(csrfToken)}${act(ev.id, "publish")}<button class="btn btn-primary" type="submit">Publish / post now</button>
            </form>
            <form method="post" action="/g/${cid}/events/action" class="inline">
              ${csrf(csrfToken)}${act(ev.id, "duplicate")}<button class="btn" type="submit">Duplicate</button>
            </form>
            <form method="post" action="/g/${cid}/events/action" class="inline">
              ${csrf(csrfToken)}${act(ev.id, "retry-sync")}
              <button class="btn btn--warn" type="submit">Retry Discord sync</button>
            </form>
            ${ev.status === "archived"
              ? html`<form method="post" action="/g/${cid}/events/action" class="inline">
                  ${csrf(csrfToken)}${act(ev.id, "unarchive")}<button class="btn" type="submit">Unarchive</button>
                </form>`
              : html`<form method="post" action="/g/${cid}/events/action" class="inline">
                  ${csrf(csrfToken)}${act(ev.id, "archive")}<button class="btn" type="submit">Archive</button>
                </form>`}
          </div>
        </section>

        <section class="bs-panel">
          <h2>Signups</h2>
          <h3>Add option</h3>
          <form method="post" action="/g/${cid}/events/action" class="form-row">
            ${csrf(csrfToken)}${act(ev.id, "option-add")}
            <label>Label <input name="label" maxlength="80" required /></label>
            <label
              >Capacity <input name="capacity" type="number" min="0" max="100000"
            /></label>
            <label
              ><input type="checkbox" name="waitlist" value="1" checked />
              waitlist</label
            >
            <button class="btn" type="submit">Add</button>
          </form>

          <h3>Manage a signup (organizer powers: bypass cutoff/whitelist)</h3>
          <form method="post" action="/g/${cid}/events/action" class="form-row">
            ${csrf(csrfToken)}${act(ev.id, "signup-add")}
            <label>User id <input name="user_id" maxlength="20" required autocomplete="off" data-lookup="users" data-lookup-url="/g/${cid}/lookups/users" /></label>
            <label
              >Option
              <select name="option_id"
                >${options.map((o) => html`<option value="${o.id}">${o.label}</option>`)}</select
              ></label
            >
            <button class="btn" type="submit">Add signup</button>
          </form>
          <form method="post" action="/g/${cid}/events/action" class="form-row">
            ${csrf(csrfToken)}${act(ev.id, "signup-remove")}
            <label>User id <input name="user_id" maxlength="20" required autocomplete="off" data-lookup="users" data-lookup-url="/g/${cid}/lookups/users" /></label>
            <label
              >From option
              <select name="option_id"
                >${options.map((o) => html`<option value="${o.id}">${o.label}</option>`)}</select
              ></label
            >
            <button class="btn" type="submit">Remove signup</button>
          </form>
        </section>

        <section class="bs-panel">
          <h2>Edit</h2>
          <h3>Reminder</h3>
          <form method="post" action="/g/${cid}/events/action" class="form-row">
            ${csrf(csrfToken)}${act(ev.id, "reminder-add")}
            <label
              >Minutes before start
              <input name="minutes" type="number" min="1" max="20160" required
            /></label>
            <label>Role to ping (optional) <input name="role_id" maxlength="20" autocomplete="off" data-lookup="roles" data-lookup-url="/g/${cid}/lookups/roles" /></label>
            <label>Message (optional) <input name="body" maxlength="200" /></label>
            <button class="btn" type="submit">Add reminder</button>
          </form>

          <h3>Edit fields (writes sync back to the Discord message)</h3>
          <form method="post" action="/g/${cid}/events/action" class="form-row">
            ${csrf(csrfToken)}${act(ev.id, "edit")}
            <label>Title <input name="title" maxlength="150" value="${ev.title}" /></label>
            <label>Start (guild zone, empty = keep) <input name="start" maxlength="60" /></label>
            <label>End (guild zone) <input name="end" maxlength="60" /></label>
            <label
              >Description
              <input name="description" maxlength="1000" value="${ev.description || ""}"
            /></label>
            <label
              >Location <input name="location" maxlength="200" value="${ev.location || ""}"
            /></label>
            <label
              >Image URL <input name="image_url" maxlength="400" value="${ev.image_url || ""}"
            /></label>
            <label
              >Color <input name="color" maxlength="9" placeholder="#5865f2" value="${ev.color || ""}"
            /></label>
            <label
              >Cutoff minutes before start (-1 clears)
              <input name="cutoff_minutes" type="number" min="-1" max="20160"
            /></label>
            <label
              >Attendee role id (existing-role mode; empty clears)
              <input
                name="attendee_role_id"
                maxlength="20"
                autocomplete="off"
                data-lookup="roles"
                data-lookup-url="/g/${cid}/lookups/roles"
                value="${ev.attendee_role_id || ""}"
            /></label>
            <label
              >Attendee role is existing
              <select name="attendee_role_existing"
                ><option value="">keep mode</option>
                <option value="1">yes — use the id above</option>
                <option value="0">no — bot-managed temp role</option></select
              ></label
            >
            <button class="btn btn-primary" type="submit">Save</button>
          </form>
        </section>

        <div class="danger-zone">
          <h3>Danger</h3>
          <form
            method="post"
            action="/g/${cid}/events/action"
            class="inline"
          >
            ${csrf(csrfToken)}${act(ev.id, "delete")}
            <label>Type <code>DELETE</code> <input name="confirm" maxlength="10" required /></label>
            <button class="btn btn-danger" type="submit">Permanent delete</button>
          </form>
        </div>
      `
    : html`<p class="muted">
        You are not the creator and do not hold event-edit rights — view only.
      </p>`;

  return html`
    ${flash()}
    <p>
      ${badge(ev.status)} <strong>${ev.title}</strong> · starts
      ${fmtTime(ev.start_at, zone)}${ev.end_at != null
        ? html` · ends ${fmtTime(ev.end_at, zone)}`
        : ""}${ev.location ? html` · 📍 ${ev.location}` : ""}${ev.image_url
        ? html` · image <code>${ev.image_url}</code>`
        : ""}${ev.color ? html` · color <code>${ev.color}</code>` : ""} · ${cutoffText}${ev.thread_id
        ? html` · thread <code>${ev.thread_id}</code>`
        : ""}${ev.attendee_role_id
        ? html` · attendee role <code>${ev.attendee_role_id}</code>`
        : ""}
    </p>
    <p>
      ${msgLink(ev, messageLinkUrl)}${ev.message_id
        ? ""
        : html` <span class="muted">(draft — post to get the message)</span>`}
    </p>
    ${ev.description
      ? html`<blockquote>${String(ev.description).slice(0, 1000)}</blockquote>`
      : ""}

    <h2>Options</h2>
    <table class="bs-table events-table table-stack" data-density="compact">
      <thead>
        <tr>
          <th>Option</th>
          <th>Signups</th>
          <th>Names</th>
          <th>Waitlist</th>
          ${canManage ? html`<th></th>` : ""}
        </tr>
      </thead>
      <tbody>${optionRows}</tbody>
    </table>
    <p class="muted">Attending total: ${counts.attending} · waiting: ${counts.waiting}</p>
    ${waitRows.length
      ? html`<h3>Waitlist</h3>
          <ul class="cal-list">${waitRows}</ul>`
      : ""}

    <h2>Reminders</h2>
    ${reminders.length
      ? html`<table class="bs-table events-table table-stack" data-density="compact">
          <thead>
            <tr>
              <th>Fires</th>
              <th>State</th>
              <th>Role</th>
              <th>Body</th>
              ${canManage ? html`<th></th>` : ""}
            </tr>
          </thead>
          <tbody>${reminderRows}</tbody>
        </table>`
      : html`<p class="muted">No reminder rows (posting arms the guild default).</p>`}

    ${manageForms}

    <h2>Activity</h2>
    ${activityRows.length
      ? html`<ol class="cal-list">${activityRows}</ol>`
      : html`<p class="muted">No activity recorded.</p>`}
  `;
}

// ── simpler pages ───────────────────────────────────────────────────────────

function renderArchive({ cid, rows, zone, csrfToken }) {
  const tr = rows.map((ev) =>
    html`<tr>
      <td data-label="Event">${link(ev)} ${badge(ev.status)}</td>
      <td data-label="Started">${fmtTime(ev.start_at, zone)}</td>
      <td data-label="Actions">
        <form
          method="post"
          action="/g/${cid}/events/action"
          class="events-danger-inline"
        >
          ${csrf(csrfToken)}${act(ev.id, "delete")}
          <label>confirm <input name="confirm" maxlength="10" placeholder="DELETE" /></label>
          <button class="btn btn-sm btn-danger" type="submit">Delete forever</button>
        </form>
      </td>
    </tr>`,
  );
  return html`
    ${flash()}
    <p class="muted">
      Everything this server ever ran — no history window. Permanent delete lives here.
    </p>
    ${rows.length
      ? html`<table class="bs-table events-table table-stack" data-density="compact">
          <thead><tr><th>Event</th><th>Started</th><th></th></tr></thead>
          <tbody>${tr}</tbody>
        </table>`
      : html`<p class="muted">Nothing archived yet.</p>`}
  `;
}

function renderPresets({ cid, presets, csrfToken }) {
  const rows = presets.map((p) =>
    html`<tr>
      <td data-label="Name"><strong>${p.name}</strong></td>
      <td data-label="Options">${(p.options || []).map((o) => o.label).join(" / ") || "—"}</td>
      <td data-label="Actions">
        <form
          method="post"
          action="/g/${cid}/events/presets/delete"
          class="events-danger-inline"
        >
          ${csrf(csrfToken)}${act(p.id, "delete", "preset_id")}
          ${/* #649: typed DELETE confirm (H2-15) — same idiom as the archive/permanent
               delete forms above; the route compares the value verbatim. Styled by
               #650 as a danger-zone field. */ ""}
          <label class="danger-zone danger-zone-inline">confirm <input name="confirm" maxlength="10" autocomplete="off" placeholder="DELETE" /></label>
          <button class="btn btn-sm btn-danger" type="submit">Delete</button>
        </form>
      </td>
    </tr>`,
  );
  return html`
    ${flash()}
    <p class="muted">
      Saved option groups reusable at create time (twins <code>/eventsignup preset</code>
      in Discord).
    </p>
    <form method="post" action="/g/${cid}/events/presets" class="form-row">
      ${csrf(csrfToken)}
      <label>Name <input name="name" maxlength="60" required /></label>
      <label
        >Options (comma-separated labels, optional <code>|capacity</code>
        suffix)
        <input name="spec" maxlength="400" placeholder="Pizza|10, Salad, Cakes|2" required
      /></label>
      <button class="btn btn-primary" type="submit">Save preset</button>
    </form>
    ${rows.length
      ? html`<table class="bs-table events-table table-stack" data-density="compact">
          <thead><tr><th>Name</th><th>Options</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
      : html`<p class="muted">No presets yet.</p>`}
  `;
}

function renderSeries({ cid, series, zone, csrfToken }) {
  const rows = series.map((s) =>
    html`<tr>
      <td data-label="Series">
        <a href="/g/${cid}/events/${s.template_event_id}">template #${s.template_event_id}</a>
      </td>
      <td data-label="Rule">
        ${s.cadence}${s.weekdays?.length
          ? html` (${s.weekdays.join(",")})`
          : s.month_day
            ? html` day ${s.month_day}`
            : ""}
      </td>
      <td data-label="Status">${s.status}</td>
      <td data-label="Next">${s.next_occurrence_at != null ? fmtTime(s.next_occurrence_at, zone) : "—"}</td>
      <td data-label="Created">${s.occurrences_created ?? 0}${s.end_count ? ` / ${s.end_count}` : ""}</td>
      <td data-label="Actions">
        ${s.status === "active"
          ? html`
              <form method="post" action="/g/${cid}/events/series" class="inline">
                ${csrf(csrfToken)}${act(s.id, "skip", "series_id")}
                <button class="btn btn-sm" type="submit">Skip next</button>
              </form>
              <form method="post" action="/g/${cid}/events/series" class="inline">
                ${csrf(csrfToken)}${act(s.id, "stop", "series_id")}
                <button class="btn btn-sm btn--warn" type="submit">Stop</button>
              </form>
            `
          : ""}
      </td>
    </tr>`,
  );
  return html`
    ${flash()}
    <p class="muted">
      Unposted occurrences draft themselves as their due time passes; skip drops
      the next one; stop keeps everything already posted.
    </p>
    ${rows.length
      ? html`<table class="bs-table events-table table-stack" data-density="compact">
          <thead>
            <tr>
              <th>Series</th><th>Rule</th><th>Status</th><th>Next</th><th>Created</th><th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`
      : html`<p class="muted">No series yet.</p>`}
  `;
}

function renderScheduled({ cid, rows, zone, csrfToken }) {
  const tr = rows.map((ev) =>
    html`<tr>
      <td data-label="Event">${link(ev)} ${badge(ev.status)}</td>
      <td data-label="Posts">${ev.post_at != null ? fmtTime(ev.post_at, zone) : "on approval"}</td>
      <td data-label="Last error">
        ${ev.status === "post_failed"
          ? html`<span class="flash--err"
              >${String(ev.last_post_error || "post failed").slice(0, 140)}</span
            >`
          : ""}
      </td>
      <td data-label="Actions">
        <form method="post" action="/g/${cid}/events/action" class="inline">
          ${csrf(csrfToken)}${act(ev.id, "publish")}<button class="btn btn-sm" type="submit">Post now</button>
        </form>
      </td>
    </tr>`,
  );
  return html`
    ${flash()}
    <p class="muted">
      Queued and failed posts. "Post now" runs the same pipeline as the ticker.
    </p>
    ${rows.length
      ? html`<table class="bs-table events-table table-stack" data-density="compact">
          <thead><tr><th>Event</th><th>Posts</th><th>Last error</th><th></th></tr></thead>
          <tbody>${tr}</tbody>
        </table>`
      : html`<p class="muted">Nothing queued.</p>`}
  `;
}

module.exports = {
  fmtTime,
  dayKey,
  withReq,
  renderEventsMonth,
  renderEventDetail,
  renderArchive,
  renderPresets,
  renderSeries,
  renderScheduled,
};
