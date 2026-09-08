/**
 * Views for the web user pages (roadmap/web-admin.md §8.6 Users rows,
 * Phase 1 read-only — subtask 15).
 *
 * COMPOSED ENTIRELY with the escaped-by-default `html` helper: user ids,
 * reasons, note content, search echo and channel labels interpolate through
 * it — nothing here ever wraps request/DB data in raw(). Constant markup with
 * quotes uses raw() only for static attributes.
 *
 * Tier contract (rendered, not decided, here — requireTier decides):
 *  - staff sees the profile WITHOUT any activity data; the Activity area is
 *    replaced with the slash requireSeniorStaff denial sentence (parity with
 *    src/core/permissions.js — same words, markup stripped);
 *  - senior+ sees the Activity summary on the profile and the full ranking
 *    page (window + channels/categories controls as plain GET links — Phase 1
 *    is read-only, so no buttons that could mutate).
 */

const { html, raw } = require("../escape");
const { emptyState } = require("../components");
const { formatNoteRef, formatWarnRef } = require("../../../core/theme");
const { formatWeeklyRate } = require("../../../features/userActivity/service");

/** Same message src/core/permissions.js requireSeniorStaff replies with. */
const SENIOR_DENIED_MESSAGE =
  "Activity requires senior staff (or Manage Server). Ask an admin to set your role with /staff role setlevel.";

/** Snippet length mirrors the slash userinfo card (SNIPPET_LEN = 80). */
const SNIPPET_LEN = 80;

/** "2026-09-08 14:02 UTC · 3d ago" — web replacement for Discord <t:…:R>. */
function formatWhen(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const d = new Date(n);
  const iso = d.toISOString().slice(0, 16).replace("T", " ");
  const diff = Date.now() - n;
  let rel;
  if (diff < 0) rel = "now";
  else if (diff < 60_000) rel = "just now";
  else if (diff < 3_600_000) rel = `${Math.floor(diff / 60_000)}m ago`;
  else if (diff < 86_400_000) rel = `${Math.floor(diff / 3_600_000)}h ago`;
  else rel = `${Math.floor(diff / 86_400_000)}d ago`;
  return `${iso} UTC · ${rel}`;
}

function snippet(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= SNIPPET_LEN) return s || "—";
  return `${s.slice(0, SNIPPET_LEN - 1)}…`;
}

/** "showing X–Y of Z" + next link for a 10-row page. */
function pager(baseHref, param, { offset, total, shown }) {
  const from = offset + 1;
  const to = offset + shown;
  const more = shown > 0 && (offset + shown < (total ?? offset + shown));
  const next = more
    ? html` <a class="pager-next" href="${baseHref}${baseHref.includes("?") ? "&" : "?"}${param}=${offset + shown}">next →</a>`
    : html``;
  return html`<p class="pager">showing ${from}–${to}${total != null ? html` of ${total}` : html``}${next}</p>`;
}

/** Copyable-ish id display. */
function userRef(userId) {
  return html`<code class="user-id">${userId}</code>`;
}

/**
 * Identity + XP block: mirrors the slash overview card fields the web can
 * source locally (id, XP, level, tracked). Display names/join dates are
 * Discord-side data the DB does not store — flagged in the parity notes.
 */
function identityCard(profile) {
  return html`
    <section class="panel user-identity">
      <h2>Identity</h2>
      <dl class="kv">
        <dt>User ID</dt>
        <dd>${userRef(profile.userId)}</dd>
        <dt>XP</dt>
        <dd>${profile.xp}${profile.tracked ? html`` : html` <em class="muted">(no XP row yet)</em>`}</dd>
        <dt>Level</dt>
        <dd>${profile.level}</dd>
      </dl>
    </section>`;
}

function warningsSection(profile, baseHref) {
  const { rows, offset, total } = profile.warnings;
  const { warnsActive, warnsTotal } = profile.counts;
  const list = rows.length
    ? html`<table class="list-table">
        <thead>
          <tr><th>Ref</th><th>By</th><th>Created</th><th>Expires</th><th>Status</th><th>Reason</th></tr>
        </thead>
        <tbody>
          ${rows.map((w) => html`
            <tr class="row-warn">
              <td>${formatWarnRef(w.warning_number)}</td>
              <td>${w.issuer_id}</td>
              <td>${formatWhen(w.created_at)}</td>
              <td>${w.expires_at ? formatWhen(w.expires_at) : "never"}</td>
              <td>${w.voided_at != null ? raw("voided") : raw("active")}</td>
              <td class="reason-cell">${snippet(w.reason)}</td>
            </tr>`)}
        </tbody>
      </table>
      ${pager(baseHref, "w_off", { offset, total, shown: rows.length })}`
    : emptyState("No warnings on record.");
  return html`
    <section class="panel user-warnings">
      <h2>Warnings</h2>
      <p class="counts"><strong>${warnsActive}</strong> active · <strong>${warnsTotal}</strong> total (incl. voided)</p>
      ${list}
    </section>`;
}

function notesSection(profile, baseHref) {
  const { rows, offset, total } = profile.notes;
  const { notesActive, notesTotal } = profile.counts;
  const list = rows.length
    ? html`<ul class="note-list">
        ${rows.map((n) => html`
          <li class="row-note">
            <strong>${formatNoteRef(n.note_number)}</strong> · by ${n.author_id} · ${formatWhen(n.created_at)}
            <blockquote class="note-content">${snippet(n.content)}</blockquote>
          </li>`)}
      </ul>
      ${pager(baseHref, "n_off", { offset, total, shown: rows.length })}`
    : emptyState("No active staff notes.");
  return html`
    <section class="panel user-notes">
      <h2>Staff notes</h2>
      <p class="counts"><strong>${notesActive}</strong> active · <strong>${notesTotal}</strong> total (incl. deleted — deleted stay hidden here, as in slash)</p>
      ${list}
    </section>`;
}

function ticketsSection(profile, baseHref) {
  const { rows, offset, hasMore } = profile.tickets;
  const list = rows.length
    ? html`<table class="list-table">
        <thead>
          <tr><th>Ticket</th><th>Role</th><th>Status</th><th>Created</th><th>Reason</th></tr>
        </thead>
        <tbody>
          ${rows.map((t) => html`
            <tr class="row-ticket">
              <td>#${t.ticket_number}${t.archived ? html` <em class="muted">(archived)</em>` : html``}</td>
              <td>${t.is_creator ? raw("creator") : raw("member/staff")}</td>
              <td>${t.status}</td>
              <td>${formatWhen(t.created_at)}</td>
              <td class="reason-cell">${snippet(t.reason)}</td>
            </tr>`)}
        </tbody>
      </table>
      ${pager(baseHref, "t_off", { offset, total: hasMore ? offset + rows.length + 1 : null, shown: rows.length })}`
    : emptyState("No tickets involving this user.");
  return html`
    <section class="panel user-tickets">
      <h2>Recent tickets</h2>
      ${list}
    </section>`;
}

/**
 * Activity area on the PROFILE page. Senior: compact summary (totals only —
 * no channel data) + link to the full tab. Staff: the exact slash denial
 * sentence, no data (acceptance: staff profile contains no activity content).
 */
function activityArea(profile, activity) {
  const base = `/g/${activity.guildId}/users/${profile.userId}`;
  if (!activity.visible) {
    return html`
      <section class="panel user-activity-denied">
        <h2>Activity</h2>
        <p class="activity-denied">${SENIOR_DENIED_MESSAGE}</p>
      </section>`;
  }
  const { ranking } = activity;
  return html`
    <section class="panel user-activity">
      <h2>Activity</h2>
      <dl class="kv">
        <dt>Window (${ranking.windowLabel})</dt>
        <dd>${ranking.windowTotal} posts</dd>
        <dt>Lifetime</dt>
        <dd>${ranking.lifetimeTotal} posts · ~${formatWeeklyRate(ranking.lifetimeWeekly)} since join</dd>
        <dt>Tracking</dt>
        <dd>${ranking.trackingDay ? html`from ${ranking.trackingDay}` : raw("no counters yet · forward tracking + optional backfill (slash)")}</dd>
        ${ranking.meta && ranking.meta.backfill_status && ranking.meta.backfill_status !== "none"
          ? html`<dt>Backfill</dt><dd>${ranking.meta.backfill_status}</dd>`
          : html``}
      </dl>
      <p><a class="btn" href="${base}/activity">Open Activity tab →</a></p>
    </section>`;
}

/** Window + page controls for the Activity tab (GET links, normalized ids). */
function activityControls(baseHref, win, page) {
  const pageTok = page === "categories" ? "ca" : "ch";
  const link = (w, label) =>
    html`<a class="${w === win ? raw("active") : raw("")}" href="${baseHref}?win=${w}&page=${pageTok}">${label}</a>`;
  const pageLink = (p, label) =>
    html`<a class="${p === pageTok ? raw("active") : raw("")}" href="${baseHref}?win=${win}&page=${p}">${label}</a>`;
  return html`
    <nav class="activity-controls" aria-label="Activity controls">
      <span class="ctl-group">${link("a", "All")} ${link("7", "7d")} ${link("30", "30d")} ${link("90", "90d")}</span>
      <span class="ctl-group">${pageLink("ch", "Channels")} ${pageLink("ca", "Categories")}</span>
    </nav>`;
}

function rankingTable(ranking, page) {
  if (!ranking.ranked.length) {
    return emptyState("No tracked messages yet. Backfill history (slash) or wait for new posts.");
  }
  const entityLabel = page === "categories" ? "Category" : "Channel";
  return html`<table class="list-table activity-table">
    <thead>
      <tr><th>#</th><th>${entityLabel}</th><th>Posts</th><th>Share</th><th>Rate</th></tr>
    </thead>
    <tbody>
      ${ranking.ranked.map((r, i) => html`
        <tr class="row-activity">
          <td>${i + 1}</td>
          <td class="channel-label">${r.label}</td>
          <td>${r.count}</td>
          <td>${r.pct.toFixed(1)}%</td>
          <td>${formatWeeklyRate(r.weekly)}</td>
        </tr>`)}
    </tbody>
  </table>`;
}

/* ---------------------------------------------------------------- pages -- */

/**
 * GET /g/:guildId/users — search page (staff+). `q` is echoed through html``
 * only (attribute + text positions are both in the escaped set).
 */
function renderUserSearchPage(req, { guilds, search }) {
  const base = `/g/${req.guildAccess.guildId}/users`;
  const rows = search.results.map((r) => html`
    <tr class="row-user">
      <td><a href="${base}/${r.user_id}">${r.user_id}</a></td>
      <td>${r.xp}</td>
      <td>${r.level}</td>
    </tr>`);
  const content = html`
    <form class="search-form" method="get" action="${base}">
      <label for="q">User ID</label>
      <input id="q" type="search" name="q" value="${search.query}" placeholder="digits of a user ID…" maxlength="64"/>
      <button type="submit" class="btn">Search</button>
    </form>
    <p class="hint">Search matches tracked users by ID (exact or prefix) — display-name search is not available offline. Results are capped at 50.</p>
    ${search.searched
      ? rows.length
        ? html`<table class="list-table">
            <thead><tr><th>User ID</th><th>XP</th><th>Level</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`
        : emptyState("No tracked users match that ID.")
      : html``}`;
  return { title: "Users", content };
}

/** Profile page body (tab: profile). Caller wraps via renderShellPage. */
function renderUserProfileBody(req, { profile, activity }) {
  const base = `/g/${req.guildAccess.guildId}/users/${profile.userId}`;
  const tabs = activity.visible
    ? html`<a class="tab active" href="${base}">Profile</a>
        <a class="tab" href="${base}/activity">Activity</a>`
    : html`<a class="tab active" href="${base}">Profile</a>
        <span class="tab tab-disabled" title="Senior staff only">Activity</span>`;
  return html`
    <nav class="tabs">${tabs}</nav>
    ${identityCard(profile)}
    ${warningsSection(profile, base)}
    ${notesSection(profile, base)}
    ${ticketsSection(profile, base)}
    ${activityArea(profile, { ...activity, guildId: req.guildAccess.guildId })}`;
}

/** Activity tab page body (senior+ only route). */
function renderUserActivityBody(req, { profile, activity }) {
  const base = `/g/${req.guildAccess.guildId}/users/${profile.userId}`;
  const actBase = `${base}/activity`;
  const { ranking } = activity;
  const rate = ranking.windowWeekly != null ? ranking.windowWeekly : ranking.lifetimeWeekly;
  const rateSuffix = ranking.window === "a" ? "since join" : "in window";
  return html`
    <nav class="tabs">
      <a class="tab" href="${base}">Profile</a>
      <a class="tab active" href="${actBase}">Activity</a>
    </nav>
    <section class="panel user-activity-full">
      <h2>Activity · ${activity.page === "categories" ? "Categories" : "Channels"} · ${ranking.windowLabel}</h2>
      ${activityControls(actBase, activity.window, activity.page)}
      <dl class="kv">
        <dt>Window total</dt><dd>${ranking.windowTotal}</dd>
        <dt>Lifetime</dt><dd>${ranking.lifetimeTotal}</dd>
        <dt>Rate</dt><dd>~${formatWeeklyRate(rate)} ${rateSuffix}</dd>
        <dt>Tracking</dt>
        <dd>${ranking.trackingDay ? html`data from ${ranking.trackingDay}` : raw("no counters yet · forward tracking + optional backfill (slash)")}</dd>
        ${ranking.meta && ranking.meta.backfill_status && ranking.meta.backfill_status !== "none"
          ? html`<dt>Backfill</dt><dd>${ranking.meta.backfill_status}</dd>`
          : html``}
        ${profile.userId && ranking.window === "a" && activity.joinedMs == null
          ? html`<dt>Join date</dt><dd>unknown · rate uses min 1 week</dd>`
          : html``}
      </dl>
      ${rankingTable(ranking, activity.page)}
      <p class="hint">Senior staff · posts/wk = ${ranking.window === "a" ? "lifetime ÷ weeks since join" : "window posts ÷ weeks in window"}. Backfill controls stay slash-only (§8.9).</p>
    </section>`;
}

/**
 * Friendly in-shell 404 MESSAGE (plain text — renderShellError escapes and
 * wraps it; userId is digits-only by the route's snowflake gate).
 */
function renderUserNotFoundBody({ userId }) {
  return `No bot data exists for user ${userId} in this guild — XP, warnings, notes, tickets and activity are all empty. Nothing to show.`;
}

module.exports = {
  SENIOR_DENIED_MESSAGE,
  SNIPPET_LEN,
  formatWhen,
  snippet,
  renderUserSearchPage,
  renderUserProfileBody,
  renderUserActivityBody,
  renderUserNotFoundBody,
};
