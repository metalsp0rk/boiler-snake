/**
 * Views for the web moderation lists + Phase-3 mutation forms (roadmap/
 * web-admin.md §8.6 "Moderation: warnings list/issue/void, notes | Staff |
 * Staff | 1 read · 3 write"; lists: subtask 17, forms: subtask 29).
 *
 * COMPOSED ENTIRELY with the escaped-by-default `html` helper: reasons,
 * note contents, void reasons and user ids interpolate through it — raw()
 * appears ONLY around static markup constants. XSS probes live in
 * test/web-routes-moderation.test.js (Phase 1 pins) and
 * test/web-moderation-actions.test.js (Phase 3 flash/echo pins).
 *
 * Slash parity markers (the strikethrough states of the embed lists):
 *  - voided warnings   → badged "voided"   (slash `~~voided~~`)
 *  - expiring warnings → "expires …" text  (slash `expires <t:R>`)
 *  - soft-deleted notes→ badged "deleted"  (slash `~~deleted~~`)
 * Formatting reuses the users-page helpers (formatWhen/snippet) so every
 * list speaks one visual language.
 *
 * PRG FLASH vocabulary (Phase 3, xpActions/xpActions doctrine): FROZEN slug
 * maps → fixed messages. The raw query value is only ever a map lookup —
 * unknown/hostile slugs render NOTHING, so a redirect target can never
 * reflect input into markup (§8.7). The warnings and notes pages own
 * SEPARATE vocabularies (an ?error= slug from one page is unknown on the
 * other and stays invisible).
 */

const { html, raw } = require("../escape");
const { emptyState, banner } = require("../components");
const { formatWarnRef, formatNoteRef } = require("../../../core/theme");
const { formatWhen, snippet } = require("../users");

/* ---------------------------------------------------------------- PRG flash -- */

/**
 * Warnings-page flash vocabulary (frozen slugs → fixed messages). Messages
 * mirror the slash /warn add|void replies and refusal reasons where one
 * exists; NOTHING is user-reflective. Slugs are the route's contract.
 */
const WARN_FLASH_DONE = Object.freeze({
  warn_issued: "Warning issued — same pipeline as /warn add (record, warn-log mirror, member DM).",
  warn_voided: "Warning voided — the row stays with the full paper trail, like /warn void.",
});

const WARN_FLASH_ERROR = Object.freeze({
  invalid_user: "Invalid user ID — Discord user IDs are 5–20 digits. Nothing was changed.",
  bot_target: "Warnings are for human members, not bots. Nothing was changed.",
  missing_reason: "Reason cannot be empty. Nothing was changed.",
  reason_too_long: "Reason is too long (max 1000 characters). Nothing was changed.",
  invalid_evidence_url: "Evidence message must be a Discord message link from this server. Nothing was changed.",
  invalid_evidence_text: "Evidence text is too long (max 500 characters). Nothing was changed.",
  invalid_note: "No staff note with that number in this server — use a valid note number or omit it. Nothing was changed.",
  invalid_expiry: "Expiry days must be a whole number 0–3650 (0 = never). Nothing was changed.",
  invalid_warning_number: "Invalid warning number — use the number from the W-… ref (e.g. 12). Nothing was changed.",
  warn_not_found: "No warning with that number in this server. Nothing was changed.",
  already_voided: "That warning is already voided. Nothing was changed.",
  void_reason_missing: "Void reason cannot be empty. Nothing was changed.",
  void_reason_too_long: "Void reason is too long (max 1000 characters). Nothing was changed.",
});

/** Notes-page flash vocabulary (mirrors slash /note add replies). */
const NOTE_FLASH_DONE = Object.freeze({
  note_added: "Staff note created — same as /note add: row, audit trail, warn-log-free staff mirror.",
});

const NOTE_FLASH_ERROR = Object.freeze({
  invalid_user: "Invalid user ID — Discord user IDs are 5–20 digits. Nothing was changed.",
  bot_target: "Staff notes are for human members, not bots. Nothing was changed.",
  content_empty: "Note content cannot be empty. Nothing was changed.",
  content_too_long: "Note content is too long (max 2000 characters). Nothing was changed.",
});

/**
 * Whitelist one page's PRG query against its OWN frozen tables: each value
 * is a KNOWN slug or null. Junk/hostile/foreign values are dropped.
 * @param {{done?: unknown, error?: unknown}} query
 * @param {Readonly<Record<string,string>>} doneTable
 * @param {Readonly<Record<string,string>>} errorTable
 */
function flashFromQuery(query, doneTable, errorTable) {
  const done =
    typeof query?.done === "string" && doneTable[query.done] ? query.done : null;
  const error =
    typeof query?.error === "string" && errorTable[query.error] ? query.error : null;
  return { done, error };
}

/**
 * Flash banner for the PRG round-trip (frozen message chosen by slug —
 * never the raw query value, §8.7).
 * @param {{done: string|null, error: string|null}|null} flash
 * @param {Readonly<Record<string,string>>} doneTable
 * @param {Readonly<Record<string,string>>} errorTable
 */
function flashBanner(flash, doneTable, errorTable) {
  if (!flash) return html``;
  if (flash.error && errorTable[flash.error]) {
    return banner("warn", errorTable[flash.error]);
  }
  if (flash.done && doneTable[flash.done]) {
    return banner("info", doneTable[flash.done]);
  }
  return html``;
}

/* ---------------------------------------------------------- mutation forms -- */

/**
 * Hidden CSRF double-submit half (middleware/csrf.js reads `_csrf` for every
 * /g/ POST). Null token renders EMPTY — the POST then 403s at the gate
 * before any mutation (fail closed, same contract as every Phase-2/3 form).
 * @param {string|null|undefined} csrfToken
 */
function csrfField(csrfToken) {
  return html`<input type="hidden" name="_csrf" value="${csrfToken || ""}"/>`;
}

/**
 * Staff-only "issue warning" form — the fields mirror the slash /warn add
 * options (user/reason/silent/note/message/evidence/expires_days). Bounds
 * here are BROWSER hints only: the route re-validates every field against
 * the same repository validators the slash relies on.
 * @param {object} input
 * @param {string} input.guildId server-derived (guildScope snowflake)
 * @param {string|null} input.csrfToken req.csrfToken
 * @param {number} input.maxReason MAX_WARN_REASON (bound, never data)
 * @param {number} input.maxEvidence MAX_EVIDENCE_TEXT
 * @param {number} input.maxExpiryDays MAX_EXPIRY_DAYS
 */
function renderWarnIssueForm({ guildId, csrfToken, maxReason, maxEvidence, maxExpiryDays }) {
  const actionPath = `/g/${encodeURIComponent(guildId)}/moderation/warnings/issue`;
  return html`
    <section class="panel moderation-write-panel">
      <h2>Issue warning</h2>
      <p class="hint">
        Runs the same pipeline as <code>/warn add</code>: sequential W-ref,
        expiry rules, warn-log mirror, and the member DM unless silent — plus
        the <code>warnings.add</code> audit row.
      </p>
      <form class="integ-write-form warn-issue-form" method="post" action="${actionPath}">
        ${csrfField(csrfToken)}
        <div class="integ-write-fields">
          <label>User ID<input name="user_id" type="text" inputmode="numeric" autocomplete="off" placeholder="Discord user id" maxlength="20"/></label>
          <label>Reason<textarea name="reason" rows="2" maxlength="${maxReason}" placeholder="why this warning is being issued"></textarea></label>
          <label>Note number (optional, N-…)<input name="note" type="number" min="1" step="1"/></label>
          <label>Message evidence link (optional)<input name="message" type="text" autocomplete="off" placeholder="https://discord.com/channels/…/…/…"/></label>
          <label>Evidence notes (staff-only, optional)<textarea name="evidence" rows="2" maxlength="${maxEvidence}" placeholder="staff-only evidence"></textarea></label>
          <label>Expires in days (optional; empty = guild default, 0 = never)<input name="expires_days" type="number" min="0" max="${maxExpiryDays}" step="1"/></label>
          <label class="checkbox-label"><input name="silent" type="checkbox" value="1"/> Silent (skip the member DM)</label>
        </div>
        <button type="submit" class="btn btn-write">Issue warning</button>
      </form>
    </section>`;
}

/**
 * Staff-only "void warning" form — slash /warn void twin (row kept forever
 * with the void paper trail; already-void warnings are rejected).
 * @param {object} input
 * @param {string} input.guildId
 * @param {string|null} input.csrfToken
 * @param {number} input.maxReason MAX_WARN_REASON
 */
function renderWarnVoidForm({ guildId, csrfToken, maxReason }) {
  const actionPath = `/g/${encodeURIComponent(guildId)}/moderation/warnings/void`;
  return html`
    <section class="panel moderation-write-panel">
      <h2>Void warning</h2>
      <p class="hint">
        Same as <code>/warn void</code>: pick the number from the W-… ref
        below; the row stays with the void author + reason.
      </p>
      <form class="integ-write-form warn-void-form" method="post" action="${actionPath}">
        ${csrfField(csrfToken)}
        <div class="integ-write-fields">
          <label>Warning number (e.g. 12 from W-12)<input name="warning_number" type="number" min="1" step="1"/></label>
          <label>Void reason<textarea name="reason" rows="2" maxlength="${maxReason}" placeholder="why this warning is being voided"></textarea></label>
        </div>
        <button type="submit" class="btn btn-write">Void warning</button>
      </form>
    </section>`;
}

/**
 * Staff-only "add note" form — slash /note add twin (2000-char bound; the
 * subject is NEVER notified — notes never DM, same as slash).
 * @param {object} input
 * @param {string} input.guildId
 * @param {string|null} input.csrfToken
 * @param {number} input.maxContent MAX_NOTE_CONTENT
 */
function renderNoteAddForm({ guildId, csrfToken, maxContent }) {
  const actionPath = `/g/${encodeURIComponent(guildId)}/moderation/notes`;
  return html`
    <section class="panel moderation-write-panel">
      <h2>Add staff note</h2>
      <p class="hint">
        Same as <code>/note add</code>: sequential N-ref, staff-only forever.
        The subject is never notified — notes never DM or post to member
        channels.
      </p>
      <form class="integ-write-form note-add-form" method="post" action="${actionPath}">
        ${csrfField(csrfToken)}
        <div class="integ-write-fields">
          <label>User ID<input name="user_id" type="text" inputmode="numeric" autocomplete="off" placeholder="Discord user id" maxlength="20"/></label>
          <label>Note content<textarea name="content" rows="3" maxlength="${maxContent}" placeholder="context for staff — never shown to the member"></textarea></label>
        </div>
        <button type="submit" class="btn btn-write">Add note</button>
      </form>
    </section>`;
}

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
 * @param {{ page: object, flash?: {done: string|null, error: string|null}|null,
 *          csrfToken?: string|null,
 *          bounds?: { maxReason: number, maxEvidence: number, maxExpiryDays: number } }} data
 *   page = buildWarningsPage() result
 */
function renderWarningsBody(req, { page, flash = null, csrfToken = null, bounds = {} }) {
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
    ${flashBanner(flash, WARN_FLASH_DONE, WARN_FLASH_ERROR)}
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
    <p class="hint">Warnings are permanent — voids keep the paper trail (slash parity).</p>
    ${renderWarnIssueForm({ guildId, csrfToken, maxReason: bounds.maxReason ?? 1000, maxEvidence: bounds.maxEvidence ?? 500, maxExpiryDays: bounds.maxExpiryDays ?? 3650 })}
    ${renderWarnVoidForm({ guildId, csrfToken, maxReason: bounds.maxReason ?? 1000 })}
  </div>`;
}

/* ----------------------------------------------------------------- notes page -- */

/**
 * GET /g/:guildId/notes page body. Soft-deleted rows render BADGED when
 * state=all (slash parity: "include deleted" reveals, marked — never
 * silently) and never appear under the default state.
 * @param {object} req
 * @param {{ page: object, flash?: {done: string|null, error: string|null}|null,
 *          csrfToken?: string|null, bounds?: { maxContent: number } }} data
 *   page = buildNotesPage() result
 */
function renderNotesBody(req, { page, flash = null, csrfToken = null, bounds = {} }) {
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
    ${flashBanner(flash, NOTE_FLASH_DONE, NOTE_FLASH_ERROR)}
    ${page.invalidUser
      ? banner("warn", "Invalid user filter ignored — the user filter needs a numeric Discord user id.")
      : html``}
    ${filterForm(base, page, [
      ["active", "Active (hide deleted — slash default)"],
      ["all", "All (incl. soft-deleted)"],
    ])}
    <p class="counts"><strong>${page.total}</strong> note${page.total === 1 ? " matches" : "s match"} this filter${page.userId ? html` · subject ${page.userId}` : html` · guild-wide`}.</p>
    ${list}
    <p class="hint">Notes are staff-only and never shown to the subject. Soft-delete keeps the row for audit (slash parity).</p>
    ${renderNoteAddForm({ guildId, csrfToken, maxContent: bounds.maxContent ?? 2000 })}
  </div>`;
}

module.exports = {
  pill,
  userRef,
  pageHref,
  flashFromQuery,
  flashBanner,
  WARN_FLASH_DONE,
  WARN_FLASH_ERROR,
  NOTE_FLASH_DONE,
  NOTE_FLASH_ERROR,
  renderWarnIssueForm,
  renderWarnVoidForm,
  renderNoteAddForm,
  renderWarningsBody,
  renderNotesBody,
};
