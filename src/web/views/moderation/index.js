/**
 * Views for the web moderation lists (roadmap/web-admin.md §8.6
 * "Moderation: warnings list … notes | Staff | 1 read", subtask 17 —
 * Phase 1 READ-ONLY: zero forms that mutate, every control is a GET link
 * or a GET form).
 *
 * COMPOSED ENTIRELY with the escaped-by-default `html` helper: reasons,
 * note contents, void reasons and user ids interpolate through it — raw()
 * appears ONLY around static markup constants. XSS probes live in
 * test/web-routes-moderation.test.js.
 *
 * Slash parity markers (the strikethrough states of the embed lists):
 *  - voided warnings   → badged "voided"   (slash `~~voided~~`)
 *  - expiring warnings → "expires …" text  (slash `expires <t:R>`)
 *  - soft-deleted notes→ badged "deleted"  (slash `~~deleted~~`)
 * Formatting reuses the users-page helpers (formatWhen/snippet) so every
 * Phase 1 list speaks one visual language.
 */

const { html, raw } = require("../escape");
const { emptyState, banner } = require("../components");
const { formatWarnRef, formatNoteRef } = require("../../../core/theme");
const { formatWhen, snippet } = require("../users");

/** Whitelisted pill kinds → CSS class suffix (never interpolate a raw state). */
const PILL_KINDS = Object.freeze({
  active: "active",
  voided: "voided",
  deleted: "deleted",
  expiring: "expiring",
});

function pill(kind, label) {
  const cls = PILL_KINDS[kind] ? PILL_KINDS[kind] : "active";
  return html`<span class="state-pill state-pill-${cls}">${label}</span>`;
}

/** Digits-only user id → link into the unified profile; anything else plain. */
function userRef(guildId, userId) {
  const id = String(userId ?? "");
  if (!/^[0-9]{5,20}$/.test(id)) return html`<code class="user-id">${id}</code>`;
  return html`<a class="user-id" href="/g/${guildId}/users/${id}">${id}</a>`;
}

/**
 * Preserve the current filters while paging: rebuild the query from
 * validated pieces only (u = digits, state = whitelist, n/o = integers).
 * @param {string} base
 * @param {{ u: string|null, state: string, n: number, o: number }} q
 */
function pageHref(base, q) {
  const params = new URLSearchParams();
  if (q.u) params.set("u", q.u);
  params.set("state", q.state);
  params.set("n", String(q.n));
  if (q.o > 0) params.set("o", String(q.o));
  return `${base}?${params.toString()}`;
}

/**
 * Pager with honest totals (the count helper ran for this exact filter).
 * @param {string} base
 * @param {{ userId: string|null, state: string, pageSize: number }} filters
 * @param {{ offset: number, total: number, shown: number }} page
 */
function pager(base, filters, page) {
  const from = page.total === 0 ? 0 : page.offset + 1;
  const to = page.offset + page.shown;
  const common = {
    u: filters.userId,
    state: filters.state,
    n: filters.pageSize,
  };
  const prev =
    page.offset > 0
      ? html`<a class="pager-prev" href="${pageHref(base, { ...common, o: Math.max(0, page.offset - page.pageSize) })}">← prev</a>`
      : html``;
  const more = page.offset + page.shown < page.total;
  const next = more
    ? html` <a class="pager-next" href="${pageHref(base, { ...common, o: page.offset + page.shown })}">next →</a>`
    : html``;
  return html`<p class="pager">${prev}showing ${from}–${to} of ${page.total}${next}</p>`;
}

/* ---------------------------------------------------------------- filter UI -- */

/**
 * GET-only filter bar. `q` values are already normalized server-side
 * (whitelist/digits), and html`` escapes every attribute echo regardless.
 * @param {string} action
 * @param {{ userId: string|null, invalidUser: boolean, state: string }} page
 * @param {Array<[string, string]>} stateOptions [value, label] pairs
 */
function filterForm(action, page, stateOptions) {
  return html`
    <form class="filter-form" method="get" action="${action}">
      <label for="f-u">User ID</label>
      <input id="f-u" type="search" name="u" value="${page.userId || ""}" placeholder="subject user id…" maxlength="20"/>
      <label for="f-state">State</label>
      <select id="f-state" name="state">
        ${stateOptions.map(
          ([value, label]) =>
            html`<option value="${value}"${value === page.state ? raw(" selected") : html``}>${label}</option>`
        )}
      </select>
      <button type="submit" class="btn">Filter</button>
    </form>`;
}

/* ------------------------------------------------------------- warnings page -- */

/** State column mirror of the slash /warn list line markers. */
function warnStatePill(w, nowMs) {
  if (w.voided_at != null) return pill("voided", "voided");
  const exp = Number(w.expires_at);
  if (Number.isFinite(exp) && exp > 0) {
    if (exp <= nowMs) return pill("voided", "expired (auto-void pending)");
    return pill("expiring", `expires ${formatWhen(exp)}`);
  }
  return pill("active", "active");
}

/** Secondary row metadata: void paper trail + staff evidence + linked note. */
function warnMeta(w) {
  const parts = [];
  if (w.voided_at != null) {
    parts.push(
      html`<span class="void-meta">voided ${formatWhen(w.voided_at)} by ${String(w.voided_by ?? "?")}</span>`,
      w.void_reason ? html`<span class="void-reason">— ${snippet(w.void_reason)}</span>` : html``
    );
  }
  if (w.evidence_text) {
    parts.push(html`<span class="evidence-meta">evidence: ${snippet(w.evidence_text)}</span>`);
  }
  // evidence_message_url is repository-canonicalized (normalizeEvidence-
  // MessageUrl) — still interpolated through html`` (attribute-escaped).
  if (w.evidence_message_url) {
    parts.push(html`<a class="evidence-link" href="${w.evidence_message_url}" rel="noopener noreferrer">message evidence</a>`);
  }
  if (w.related_note_id != null) {
    // Row-carried field only — NO per-row staff_notes lookup (query budget;
    // the slash /warn list does not resolve it either).
    parts.push(html`<span class="related-note">related note #${w.related_note_id}</span>`);
  }
  return parts.length
    ? html`<div class="warn-meta">${parts}</div>`
    : html``;
}

/**
 * GET /g/:guildId/warnings page body. Caller wraps via renderShellPage.
 * @param {object} req
 * @param {{ page: object }} data page = buildWarningsPage() result
 */
function renderWarningsBody(req, { page }) {
  const guildId = req.guildAccess.guildId;
  const base = `/g/${guildId}/warnings`;
  const emptyMessage =
    page.state === "active"
      ? "No active warnings match this filter."
      : "No warnings match this filter.";
  const list = page.rows.length
    ? html`<table class="list-table moderation-table">
        <thead>
          <tr><th>Ref</th><th>Subject</th><th>Issuer</th><th>Created</th><th>State</th><th>Reason</th></tr>
        </thead>
        <tbody>
          ${page.rows.map((w) => html`
            <tr class="row-warn${w.voided_at != null ? raw(" row-voided") : html``}">
              <td>${formatWarnRef(w.warning_number)}</td>
              <td>${userRef(guildId, w.user_id)}</td>
              <td>${userRef(guildId, w.issuer_id)}</td>
              <td>${formatWhen(w.created_at)}</td>
              <td>${warnStatePill(w, Date.now())}</td>
              <td class="reason-cell">${snippet(w.reason)}${warnMeta(w)}</td>
            </tr>`)}
        </tbody>
      </table>
      ${pager(base, page, { offset: page.offset, total: page.total, shown: page.rows.length })}`
    : emptyState(emptyMessage);

  return html`<div class="moderation">
    ${page.invalidUser
      ? banner("warn", "Invalid user filter ignored — the user filter needs a numeric Discord user id.")
      : html``}
    ${filterForm(base, page, [
      ["active", "Active (hide voided — slash default)"],
      ["voided", "Voided only"],
      ["all", "All (incl. voided)"],
    ])}
    <p class="counts"><strong>${page.total}</strong> warning${page.total === 1 ? " matches" : "s match"} this filter${page.userId ? html` · subject ${page.userId}` : html` · guild-wide`}.</p>
    ${list}
    <p class="hint">Warnings are permanent — voids keep the paper trail. Issuing/voiding lives in slash today (<code>/warn add</code> / <code>/warn void</code>); web writes land in Phase 3 (§8.8).</p>
  </div>`;
}

/* ----------------------------------------------------------------- notes page -- */

/**
 * GET /g/:guildId/notes page body. Soft-deleted rows render BADGED when
 * state=all (slash parity: "include deleted" reveals, marked — never
 * silently) and never appear under the default state.
 * @param {object} req
 * @param {{ page: object }} data page = buildNotesPage() result
 */
function renderNotesBody(req, { page }) {
  const guildId = req.guildAccess.guildId;
  const base = `/g/${guildId}/notes`;
  const emptyMessage =
    page.state === "active"
      ? "No active staff notes match this filter."
      : "No staff notes match this filter.";
  const list = page.rows.length
    ? html`<table class="list-table moderation-table">
        <thead>
          <tr><th>Ref</th><th>Subject</th><th>Author</th><th>Created</th><th>State</th><th>Content</th></tr>
        </thead>
        <tbody>
          ${page.rows.map((n) => html`
            <tr class="row-note${n.deleted_at != null ? raw(" row-deleted") : html``}">
              <td>${formatNoteRef(n.note_number)}</td>
              <td>${userRef(guildId, n.user_id)}</td>
              <td>${userRef(guildId, n.author_id)}</td>
              <td>${formatWhen(n.created_at)}</td>
              <td>${n.deleted_at != null
                ? pill("deleted", "deleted")
                : pill("active", "active")}</td>
              <td class="reason-cell">${snippet(n.content)}${n.deleted_at != null
                ? html`<div class="warn-meta"><span class="void-meta">soft-deleted ${formatWhen(n.deleted_at)} by ${String(n.deleted_by ?? "?")}</span></div>`
                : html``}${n.edited_at != null
                ? html`<div class="warn-meta"><span class="void-meta">edited ${formatWhen(n.edited_at)} by ${String(n.edited_by ?? "?")}</span></div>`
                : html``}</td>
            </tr>`)}
        </tbody>
      </table>
      ${pager(base, page, { offset: page.offset, total: page.total, shown: page.rows.length })}`
    : emptyState(emptyMessage);

  return html`<div class="moderation">
    ${page.invalidUser
      ? banner("warn", "Invalid user filter ignored — the user filter needs a numeric Discord user id.")
      : html``}
    ${filterForm(base, page, [
      ["active", "Active (hide deleted — slash default)"],
      ["all", "All (incl. soft-deleted)"],
    ])}
    <p class="counts"><strong>${page.total}</strong> note${page.total === 1 ? " matches" : "s match"} this filter${page.userId ? html` · subject ${page.userId}` : html` · guild-wide`}.</p>
    ${list}
    <p class="hint">Notes are staff-only and never shown to the subject. Soft-delete keeps the row for audit (slash parity). Adding notes lands in Phase 3 (§8.8).</p>
  </div>`;
}

module.exports = {
  pill,
  userRef,
  pageHref,
  renderWarningsBody,
  renderNotesBody,
};
