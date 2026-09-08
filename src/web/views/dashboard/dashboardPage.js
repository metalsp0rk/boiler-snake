/**
 * Dashboard page body for GET /g/:guildId (subtask 14; §8.6 Phase 1 =
 * DATA TABLES ONLY — charts are explicitly Phase 4).
 *
 * Renders the snapshot shape produced by src/web/data/dashboardData.js.
 * Composed exclusively with the escaped-by-default `html` helper (../
 * escape.js): user ids, ticket reasons and ticker names are Discord/user
 * data and can never inject markup (same contract as views/layout.js).
 * No inline handlers anywhere (§8.7 CSP). Every section degrades to a
 * visible, honest empty/unknown state — missing sources render "unknown"
 * instead of a fabricated zero.
 */

const { html } = require("../escape");

const UNKNOWN = "unknown";

function formatCount(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "–";
  return num.toLocaleString("en-US");
}

/** UTC "YYYY-MM-DD HH:MM" — deterministic across locales/browsers. */
function formatUtc(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "–";
  const iso = new Date(n).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** ms → "h:mm:ss" / "m:ss" for playback position. */
function formatClock(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
}

/** ms → compact "12s" / "4m 30s" / "2h 5m" age display. */
function formatAge(ms) {
  const s = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.floor(s % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderTicketsSection(tickets) {
  if (!tickets || tickets.available !== true) {
    return html`
      <section class="dashboard-panel dashboard-tickets">
        <h2>Open tickets</h2>
        <p class="empty-state">Ticket data is unavailable right now.</p>
      </section>`;
  }
  const countLabel = tickets.openCountSaturated
    ? html`50+`
    : html`${formatCount(tickets.openCount)}`;
  const newest = (Array.isArray(tickets.newest) ? tickets.newest : []).map((t) =>
    html`<tr>
      <td>#${t.ticketNumber}</td>
      <td>${t.reason || html`<em>no reason</em>`}</td>
      <td><code>${t.creatorUserId}</code></td>
      <td>${formatUtc(t.createdAt)}</td>
    </tr>`
  );
  return html`
    <section class="dashboard-panel dashboard-tickets">
      <h2>Open tickets</h2>
      <p class="dashboard-count">${countLabel} open in this guild${tickets.openCountSaturated ? html` (display capped at 50)` : html``}.</p>
      ${newest.length
        ? html`<table class="dashboard-table">
            <thead>
              <tr><th scope="col">#</th><th scope="col">Reason</th><th scope="col">Creator</th><th scope="col">Opened (UTC)</th></tr>
            </thead>
            <tbody>${newest}</tbody>
          </table>`
        : html`<p class="empty-state">Nothing open.</p>`}
    </section>`;
}

function renderActivitySection(activity) {
  const tracking = activity?.messageTracking || null;
  const leaders = Array.isArray(activity?.xpLeaders) ? activity.xpLeaders : null;

  const trackingBlock = tracking
    ? html`<dl class="dashboard-dl">
        <dt>Tracked messages (lifetime)</dt>
        <dd>${formatCount(tracking.trackedMessages)}</dd>
        <dt>Daily counter rows</dt>
        <dd>${formatCount(tracking.dayRows)}</dd>
        <dt>Ignored channels/categories</dt>
        <dd>${formatCount(tracking.ignoreCount)}</dd>
        <dt>Backfill status</dt>
        <dd>
          ${tracking.backfillStatus}${tracking.backfillActive === true
            ? html` <span class="badge badge-tier-staff">running</span>`
            : html``}
        </dd>
      </dl>
      <p class="subheading">
        Lifetime totals from the message-tracking counters (cached ≤ every
        30 s). Per-window (24 h / 7 d) activity helpers do not exist in the
        db layer yet — see the Phase 1 data-source gaps report.
      </p>`
    : html`<p class="empty-state">Activity totals are unavailable right now.</p>`;

  const leadersBlock =
    leaders === null
      ? html`<p class="empty-state">XP leaders are unavailable right now.</p>`
      : leaders.length
        ? html`<ol class="dashboard-leaders">
            ${leaders.map((l) => html`<li><code>${l.userId}</code> — ${formatCount(l.xp)} XP</li>`)}
          </ol>`
        : html`<p class="empty-state">No XP rows yet.</p>`;

  return html`
    <section class="dashboard-panel dashboard-activity">
      <h2>Activity</h2>
      ${trackingBlock}
      <h3>Top XP (all time, top 10)</h3>
      ${leadersBlock}
    </section>`;
}

function renderTickersSection(tickers) {
  const rows = (Array.isArray(tickers) ? tickers : []).map((t) =>
    html`<tr>
      <td>${t.name}</td>
      <td><span class="badge badge-ticker-${t.status || UNKNOWN}">${t.status || UNKNOWN}</span></td>
      <td>${t.lastTickAt ? formatUtc(t.lastTickAt) : UNKNOWN}</td>
      <td>${Number.isFinite(Number(t.ageMs)) && t.lastTickAt ? formatAge(t.ageMs) : ""}</td>
      <td>${t.detail || ""}</td>
    </tr>`
  );
  const body = rows.length
    ? html`<table class="dashboard-table">
        <thead>
          <tr><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Last tick (UTC)</th><th scope="col">Age</th><th scope="col">Detail</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`
    : html`<p class="empty-state">No ticker sources report in yet — status unknown until the tickers expose state.</p>`;

  return html`
    <section class="dashboard-panel dashboard-tickers">
      <h2>Ticker health</h2>
      ${body}
    </section>`;
}

function renderNowPlayingSection(nowPlaying) {
  const np = nowPlaying || { status: UNKNOWN };
  const status = np.status || UNKNOWN;
  let body;
  if (status === "playing") {
    body = html`<p class="dashboard-nowplaying">
        <span class="badge ${np.paused ? "badge-tier-senior" : "badge-tier-staff"}">
          ${np.paused ? "paused" : "playing"}
        </span>
        <strong>${np.title || "Unknown title"}</strong>
        ${np.author ? html` — ${np.author}` : html``}
        ${Number.isFinite(Number(np.positionMs)) ? html` <span class="subheading">@ ${formatClock(np.positionMs)}</span>` : html``}
        ${Number.isFinite(Number(np.upcoming)) ? html` <span class="subheading">· ${formatCount(np.upcoming)} queued</span>` : html``}
      </p>`;
  } else if (status === "idle") {
    body = html`<p class="empty-state">Nothing playing${np.detail ? html` (${np.detail})` : html``}.</p>`;
  } else if (status === "unavailable") {
    body = html`<p class="empty-state">Music node unavailable${np.detail ? html` (${np.detail})` : html``}.</p>`;
  } else {
    body = html`<p class="empty-state">Now-playing status: ${UNKNOWN}.</p>`;
  }
  return html`
    <section class="dashboard-panel dashboard-nowplaying-panel">
      <h2>Music · now playing</h2>
      ${body}
    </section>`;
}

/**
 * Full dashboard body (goes into the shell via renderShellPage).
 * @param {object} data snapshot from src/web/data/dashboardData.js
 *   ({ tickets, activity, tickers, nowPlaying, freshness })
 * @returns {import("../escape").SafeString}
 */
function renderDashboardContent(data) {
  const d = data || {};
  const freshness = d.freshness || null;
  const stamp = freshness
    ? html` <span class="subheading">snapshot ${formatUtc(freshness.generatedAt)} UTC${freshness.fromCache ? html` (cached, ${formatAge(freshness.ageMs || 0)} ago)` : html``}</span>`
    : html``;

  return html`
    <div class="dashboard">
      ${renderTicketsSection(d.tickets)} ${renderActivitySection(d.activity)}
      ${renderTickersSection(d.tickers)} ${renderNowPlayingSection(d.nowPlaying)}
      <p class="subheading dashboard-stamp">Aggregates cached at least 30 s per guild (§8.6 query budget).${stamp}</p>
    </div>`;
}

module.exports = {
  renderDashboardContent,
};
