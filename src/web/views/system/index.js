/**
 * Views for the system page + the admin_audit viewer (roadmap/web-admin.md
 * §8.6 "System: health, tickers, OAuth state, audit viewer | Admin | 1
 * (viewer)" — subtask 22, Phase 1 READ-ONLY: zero forms that mutate; every
 * control is a GET link or a GET filter form).
 *
 * COMPOSED ENTIRELY with the escaped-by-default `html` helper: the sqlite
 * path, ticker names/details, env-variable NAMES, node version and every
 * admin_audit column (action, target, actor id, details JSON — which may
 * contain attacker-influenced text written via the audit middleware)
 * interpolate through it; raw() appears ONLY around static markup
 * constants. XSS + sentinel probes live in test/web-routes-system.test.js.
 *
 * Viewer invariants (pinned by the route + these views):
 *  - LINK-FREE rows: details may contain ids and URLs — ids render as plain
 *    <code> text and URLs are NEVER auto-linked (no <a> in an audit row);
 *  - details_json is pretty-printed, DISPLAY-truncated at the same 4000-char
 *    budget the repo enforces on storage (defense in depth: a legacy/longer
 *    row can never balloon the page), and escaped like everything else;
 *  - every degraded section renders an honest "unknown"/empty state — the
 *    page never fabricates health.
 */

const { html } = require("../escape");
const { emptyState, banner } = require("../components");
const { formatWhen } = require("../users");
// Shared sync-status panel from the staff surface (§8.6 "Command visibility"
// row): imported so /system and /staff can never diverge on the OAuth read
// (already token-stripped upstream by projectOauthView — the panel receives
// status fields ONLY).
const { renderSyncStatusPanel } = require("../staff");

/** Display cap mirroring db MAX_AUDIT_DETAILS_JSON (storage-capped there). */
const AUDIT_DETAILS_DISPLAY_MAX = 4000;

/** Whitelisted audit origins → CSS class suffix (never interpolate raw). */
const ORIGIN_KINDS = Object.freeze({ web: "web", slash: "slash", system: "system" });

/** Whitelisted ticker statuses → the dashboard's badge-ticker-* classes. */
const TICKER_KINDS = Object.freeze({
  ok: "ok",
  stale: "stale",
  down: "down",
  unknown: "unknown",
});

/** ms → compact "12m 5s" / "2h 5m" / "3d 4h" uptime/duration display. */
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** yes/no pill on the honest status rows. */
function stateBadge(ok, yesLabel, noLabel) {
  return ok
    ? html`<span class="badge badge-state badge-state-ok">${yesLabel}</span>`
    : html`<span class="badge badge-state badge-state-none">${noLabel}</span>`;
}

/* ---------------------------------------------------------------- system ---- */

function renderProcessPanel(processInfo) {
  const p = processInfo || { available: false };
  if (!p.available) {
    return html`<section class="panel system-panel">
      <h2>Process</h2>
      ${emptyState("Process health is unavailable.")}
    </section>`;
  }
  return html`<section class="panel system-panel">
    <h2>Process</h2>
    <dl class="kv system-kv">
      <dt>Uptime</dt>
      <dd>${formatDuration(p.uptimeMs)} <span class="muted">(${Math.floor(
        Number(p.uptimeMs) || 0
      )} ms)</span></dd>
      <dt>Booted</dt>
      <dd>${formatWhen(p.startedAt)}</dd>
      <dt>Node</dt>
      <dd><code>${p.nodeVersion || "unknown"}</code></dd>
      <dt>PID</dt>
      <dd><code>${p.pid}</code></dd>
    </dl>
  </section>`;
}

function renderStoragePanel(sqlite, sessionPrune) {
  const db = sqlite || { path: null };
  const prune = sessionPrune || { state: "unknown" };
  return html`<section class="panel system-panel">
    <h2>Storage &amp; background jobs</h2>
    <dl class="kv system-kv">
      <dt>SQLite file</dt>
      <dd class="system-path"><code>${db.path || "unknown"}</code></dd>
      <dt>Session prune job</dt>
      <dd>
        <span class="badge badge-state badge-state-unknown">${prune.state || "unknown"}</span>
        ${prune.detail ? html` <span class="muted">${prune.detail}</span>` : html``}
        ${Number.isFinite(Number(prune.intervalMs))
          ? html` · configured cadence <strong>every ${formatDuration(prune.intervalMs)}</strong> (boot sweep + interval)`
          : html``}
      </dd>
    </dl>
    <p class="hint">The database path is the resolved runtime path — environment variable values are never rendered on this page.</p>
  </section>`;
}

function renderTickersPanel(tickers) {
  const rows = Array.isArray(tickers && tickers.rows) ? tickers.rows : [];
  const body =
    !tickers || !tickers.available
      ? emptyState("Ticker registry unavailable — status unknown.")
      : rows.length
        ? html`<table class="list-table system-table">
            <thead>
              <tr><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Last tick</th><th scope="col">Detail</th></tr>
            </thead>
            <tbody>
              ${rows.map((t) => {
                const kind = TICKER_KINDS[t.status] ? TICKER_KINDS[t.status] : "unknown";
                return html`<tr class="row-ticker">
                  <td>${t.name}</td>
                  <td><span class="badge badge-ticker-${kind}">${kind}</span></td>
                  <td>${t.lastTickAt ? formatWhen(t.lastTickAt) : html`<span class="muted">unknown</span>`}</td>
                  <td>${t.detail || html`<span class="muted">—</span>`}</td>
                </tr>`;
              })}
            </tbody>
          </table>`
        : emptyState(
            "No ticker health sources are registered — tickers do not expose their schedules in-process yet, so their state is honestly unknown."
          );
  return html`<section class="panel system-panel">
    <h2>Ticker health</h2>
    ${body}
    <p class="hint">Registry-driven (voice, decay, reminders, YouTube/Twitch tickers register when they expose state). Unregistered sources stay unknown — this page never fabricates a tick.</p>
  </section>`;
}

function renderWebSurfacePanel(surface) {
  const s = surface || {};
  const secret = s.sessionSecret || { configured: false, source: "unknown" };
  const secretNote =
    secret.source === "CLIENT_SECRET (fallback)"
      ? banner(
          "warn",
          "SESSION_SECRET is unset — session signing falls back to CLIENT_SECRET. Set a dedicated SESSION_SECRET (§8.10)."
        )
      : html``;
  return html`<section class="panel system-panel">
    <h2>Web surface</h2>
    <dl class="kv system-kv">
      <dt>PUBLIC_HTTP_PORT</dt>
      <dd>
        ${stateBadge(s.publicHttpPortConfigured, "configured", "not configured")}
        ${s.publicHttpPortConfigured ? html` · port <code>${s.publicHttpPort}</code>` : html` <span class="muted">(web console dark)</span>`}
      </dd>
      <dt>PUBLIC_BASE_URL</dt>
      <dd>${s.publicBaseUrl ? html`<code class="system-path">${s.publicBaseUrl}</code>` : html`<span class="muted">not set</span>`}</dd>
      <dt>Secure cookies</dt>
      <dd>${stateBadge(s.secureCookies, "on (https base URL)", "off (non-https base URL)")}</dd>
      <dt>Plain-HTTP warning</dt>
      <dd>
        ${s.insecureHttpWarning
          ? banner("warn", "PUBLIC_BASE_URL is plain HTTP for a non-localhost host — the boot HTTPS validation would fire (and re-fires in the server log). Put TLS in front (§8.7).")
          : stateBadge(true, "not applicable", "not applicable")}
      </dd>
      <dt>SESSION_SECRET source</dt>
      <dd><code>${secret.source}</code> ${stateBadge(secret.configured, "configured", "missing")}</dd>
    </dl>
    ${secretNote}
    <p class="hint">Environment NAMES and derived states only — secret values (SESSION_SECRET, CLIENT_SECRET, tokens) are never rendered or logged by this page (§8.7).</p>
  </section>`;
}

/**
 * Body for GET /g/:guildId/system (Admin tier). Input is the route's
 * buildSystemStatus() projection — already secret-free by construction.
 * @param {object} input
 * @param {object} input.status
 */
function renderSystemBody({ status }) {
  const s = status || {};
  return html`<div class="system-grid">
    ${renderProcessPanel(s.process)} ${renderStoragePanel(s.sqlite, s.sessionPrune)}
    ${renderTickersPanel(s.tickers)} ${renderWebSurfacePanel(s.webSurface)}
    ${renderSyncStatusPanel({ oauth: s.oauth, envConfig: s.oauthEnv })}
    <p class="hint">Status view only — nothing here triggers OAuth, a permission sync or any bot action (§8.6 Phase 1 read-only).</p>
  </div>`;
}

/* ----------------------------------------------------------------- audit ---- */

/** Origin badge — whitelisted class suffix, unknown origins degrade to text. */
function originBadge(origin) {
  const kind = ORIGIN_KINDS[origin];
  return kind
    ? html`<span class="badge badge-origin badge-origin-${kind}">${kind}</span>`
    : html`<code>${origin == null ? "—" : String(origin)}</code>`;
}

/**
 * Details cell: pretty-printed JSON when parseable (raw text otherwise),
 * DISPLAY-truncated at AUDIT_DETAILS_DISPLAY_MAX, html``-escaped, and NEVER
 * linkified — a URL inside details renders as plain text inside the <pre>.
 * @param {string|null|undefined} detailsJson repo details_json (already
 *   storage-capped at 4000 chars by the repository guard)
 */
function renderDetailsCell(detailsJson) {
  if (detailsJson == null || detailsJson === "") {
    return html`<span class="muted">—</span>`;
  }
  const rawText = String(detailsJson);
  let text = rawText;
  try {
    text = JSON.stringify(JSON.parse(rawText), null, 2);
  } catch {
    text = rawText; // stored non-JSON text renders verbatim (escaped)
  }
  const truncated = text.length > AUDIT_DETAILS_DISPLAY_MAX;
  const shown = truncated
    ? `${text.slice(0, AUDIT_DETAILS_DISPLAY_MAX)} …[truncated in display]`
    : text;
  return html`<pre class="audit-details">${shown}</pre>`;
}

/** Target cell — "type:id" from row-carried columns only; never a link. */
function targetCell(row) {
  const type = row.target_type ? String(row.target_type) : null;
  const id = row.target_id ? String(row.target_id) : null;
  if (!type && !id) return html`<span class="muted">—</span>`;
  return html`<code class="audit-target">${type && id ? `${type}:${id}` : type || id}</code>`;
}

/**
 * Preserve the validated filters while paging (rebuilt from WHITELISTED
 * pieces only — an invalid origin never round-trips through the URL).
 * @param {string} base
 * @param {{ origin: string|null, n: number, o: number }} q
 */
function pageHref(base, q) {
  const params = new URLSearchParams();
  if (q.origin) params.set("origin", q.origin);
  params.set("n", String(q.n));
  if (q.o > 0) params.set("o", String(q.o));
  return `${base}?${params.toString()}`;
}

/** Pager with honest totals (the count helper ran for this exact filter). */
function pager(base, page) {
  const from = page.total === 0 ? 0 : page.offset + 1;
  const to = page.offset + page.rows.length;
  const common = { origin: page.origin, n: page.pageSize };
  const prev =
    page.offset > 0
      ? html`<a class="pager-prev" href="${pageHref(base, { ...common, o: Math.max(0, page.offset - page.pageSize) })}">← prev</a>`
      : html``;
  const more = page.offset + page.rows.length < page.total;
  const next = more
    ? html` <a class="pager-next" href="${pageHref(base, { ...common, o: page.offset + page.rows.length })}">next →</a>`
    : html``;
  return html`<p class="pager">${prev}showing ${from}–${to} of ${page.total}${next}</p>`;
}

/**
 * Body for GET /g/:guildId/audit — the admin_audit viewer (newest first,
 * guild-scoped rows ONLY — the route scopes by req.guildAccess.guildId).
 * @param {object} req
 * @param {{ page: object }} data page = buildAuditPage() result
 */
function renderAuditBody(req, { page }) {
  const guildId = req.guildAccess.guildId;
  const base = `/g/${guildId}/audit`;
  const filterOrigin = page.origin || "all";

  const list = page.rows.length
    ? html`<table class="list-table audit-table">
        <thead>
          <tr><th scope="col">#</th><th scope="col">Time</th><th scope="col">Actor</th><th scope="col">Origin</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Details</th></tr>
        </thead>
        <tbody>
          ${page.rows.map(
            (row) => html`<tr class="row-audit">
              <td class="audit-id">${row.id}</td>
              <td>${formatWhen(row.created_at)}</td>
              <td>${row.actor_user_id
                ? html`<code class="user-id">${String(row.actor_user_id)}</code>`
                : html`<span class="muted">—</span>`}</td>
              <td>${originBadge(row.origin)}</td>
              <td><code class="audit-action">${row.action}</code></td>
              <td>${targetCell(row)}</td>
              <td class="audit-details-cell">${renderDetailsCell(row.details_json)}</td>
            </tr>`
          )}
        </tbody>
      </table>
      ${pager(base, page)}`
    : emptyState("No audit entries match this filter.");

  return html`<div class="moderation audit">
    ${page.invalidOrigin
      ? banner("warn", "Unknown origin filter ignored — showing every origin.")
      : html``}
    <form class="filter-form" method="get" action="${base}">
      <label for="f-origin">Origin</label>
      <select id="f-origin" name="origin">
        ${[
          ["all", "All origins"],
          ["web", "Web (this console)"],
          ["slash", "Slash commands"],
          ["system", "System jobs"],
        ].map(
          ([value, label]) =>
            html`<option value="${value}"${value === filterOrigin ? html` selected` : html``}>${label}</option>`
        )}
      </select>
      <button type="submit" class="btn">Filter</button>
    </form>
    <p class="counts"><strong>${page.total}</strong> audit entr${page.total === 1 ? "y" : "ies"} match this filter${page.origin ? html` · origin ${page.origin}` : html` · every origin`}.</p>
    ${list}
    <p class="hint">The <code>admin_audit</code> table IS the trail (§8.1-7) — this viewer is read-only: rows are never edited, deleted or exported here, ids are never linked, and detail JSON is escaped plain text. Newest-first, ≤100 rows per page (§8.6 query budget).</p>
  </div>`;
}

module.exports = {
  AUDIT_DETAILS_DISPLAY_MAX,
  formatDuration,
  renderSystemBody,
  renderAuditBody,
  renderDetailsCell,
  originBadge,
};
