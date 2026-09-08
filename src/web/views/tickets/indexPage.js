/**
 * Archive-index page for the ticket surface (roadmap/web-admin.md §8.4 rule
 * 3 + locked decision §8.1-3; subtask 12 deliverable "src/web/views/tickets/*
 * templates" — replaces the pre-auth standalone archiveIndex view).
 *
 * RENDERS INSIDE THE SUBTASK 11 SHELL (§8.8 Phase 0c "guild switcher
 * shell"): the index is a dynamic, viewer-scoped page, so it gets the shell
 * bar, the guild switcher (EXACTLY the staffed guilds the gate scoped the
 * rows to — the same bot∩user ∩ staff+ list routes/transcripts.js decided
 * with, never a wider list) and the logout form. The shell's no-store write
 * framing (views/layout.js writeShellHtml) applies: with a per-response CSP
 * nonce and the session CSRF token embedded, a cached index body would ship
 * stale nonce/CSRF material — so the OLD `Cache-Control: private,
 * max-age=60` is GONE by design (§8.1-3 posture change; the oracle net
 * asserts the new value).
 *
 * TRANSCRIPT DOCUMENTS ARE DIFFERENT BY DESIGN: /t/{uuid} stays the raw
 * content-archived HTML file, byte-for-byte (self-contained artifact,
 * `private, max-age=300` kept). Wrapping a complete archived document in a
 * second document would corrupt both the archive integrity and the markup.
 * The gate (login + staff-or-participant, §8.4) is identical either way.
 *
 * COMPOSED with the escaped-by-default `html` helper (../escape.js) like
 * every other view: guild ids, subjects and close reasons are Discord-user
 * influenced data and must never inject markup (§8.7 XSS).
 *
 * The pinned markup patterns of the Phase 0a oracle net are preserved
 * verbatim — heading "Archived tickets", the "staff use only" sub line,
 * "Guild filter:"/"All guilds", the `>View</a>` cell, `Page X / Y`,
 * `class="disabled">Next` and "No archived transcripts yet." — ONLY the
 * stale "This index is not login-gated (MVP)" warning is replaced (the
 * decision-3 row in §8.1 explicitly closes it: login is now mandatory).
 */

const { html } = require("../escape");
const { renderLayout } = require("../layout");

/**
 * @param {number|null|undefined} ms
 * @returns {string}
 */
function formatTs(ms) {
  if (ms == null) return "—";
  try {
    return new Date(Number(ms)).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  } catch {
    return "—";
  }
}

/**
 * @param {string|null|undefined} s
 * @param {number} max
 * @returns {string}
 */
function snippet(s, max = 80) {
  const t = String(s || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "—";
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Index body fragment (everything below the shell h1). Pure view over
 * already-scope-filtered rows — this module NEVER decides access; the route
 * hands it only tickets the viewer may see (§8.4).
 * @param {object} opts
 * @param {object[]} opts.tickets
 * @param {number} opts.total
 * @param {number} opts.page
 * @param {number} opts.pageSize
 * @param {string|null} [opts.guildId] honored ?guild= filter (already vetted)
 * @returns {import("../escape").SafeString}
 */
function renderTicketIndexContent({ tickets, total, page, pageSize, guildId }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const filterNote = guildId
    ? html`Guild filter: <code>${guildId}</code>`
    : html`All guilds`;

  const rows = (tickets || []).map((t) => {
    const href = `/t/${encodeURIComponent(t.transcript_token)}`;
    return html`
      <tr>
        <td><a href="${href}">#${String(t.ticket_number)}</a></td>
        <td><code class="gid">${t.guild_id}</code></td>
        <td>${formatTs(t.closed_at)}</td>
        <td class="reason">${snippet(t.reason, 100)}</td>
        <td class="reason">${snippet(t.close_reason, 80)}</td>
        <td><a href="${href}">View</a></td>
      </tr>`;
  });

  const empty = rows.length
    ? html``
    : html`<tr><td colspan="6" class="empty">No archived transcripts yet.</td></tr>`;

  /**
   * Pager href builder. Composed with the html tag (NOT a URLSearchParams
   * string): the literal `&` between params must survive as a raw template
   * character (only INTERPOLATED values are escaped) so the produced URLs
   * match the pinned Phase 0a pagination bytes. The guildId here was
   * already vetted by the route against the viewer's staffed list.
   * @param {number} p
   * @returns {import("../escape").SafeString}
   */
  const hrefFor = (p) => {
    if (guildId && p > 1) return html`/t?guild=${guildId}&page=${p}`;
    if (guildId) return html`/t?guild=${guildId}`;
    if (p > 1) return html`/t?page=${p}`;
    return html`/t`;
  };

  const nav =
    totalPages > 1
      ? html`<nav class="pager">
          ${page > 1
            ? html`<a href="${hrefFor(page - 1)}">← Prev</a>`
            : html`<span class="disabled">← Prev</span>`}
          <span>Page ${page} / ${totalPages}</span>
          ${page < totalPages
            ? html`<a href="${hrefFor(page + 1)}">Next →</a>`
            : html`<span class="disabled">Next →</span>`}
        </nav>`
      : html``;

  return html`
  <p class="subheading">${filterNote} · <strong>${total}</strong> transcript${total === 1 ? "" : "s"} · staff use only</p>
  <div class="banner banner-warn" role="status">
    Login is required for every ticket page (§8.1-3). This index lists archived
    transcripts ONLY for guilds where you hold a staff tier; sensitive tickets
    are never content-archived and never appear here.
  </div>
  ${nav}
  <table>
    <thead>
      <tr>
        <th>Ticket</th>
        <th>Guild</th>
        <th>Closed</th>
        <th>Subject</th>
        <th>Close reason</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      ${rows}
      ${empty}
    </tbody>
  </table>
  ${nav}`;
}

/**
 * Full shell document for the archive index.
 *
 * @param {object} opts
 * @param {object} opts.req Express request (reads user + csrfToken)
 * @param {import("http").ServerResponse} opts.res (reads locals.cspNonce)
 * @param {object[]} opts.tickets route-scope-verified rows (§8.4)
 * @param {number} opts.total
 * @param {number} opts.page
 * @param {number} opts.pageSize
 * @param {string|null} [opts.guildId]
 * @param {Array<{id: string, name?: string|null}>} [opts.guilds] staffed
 *   guilds — the SAME list the route scoped the rows to (switcher can never
 *   offer a guild the gate would not honor, §8.3)
 * @param {boolean} [opts.degraded] §8.3 degraded-resolver banner
 * @returns {import("../escape").SafeString}
 */
function renderTicketIndexPage({
  req,
  res,
  tickets,
  total,
  page,
  pageSize,
  guildId = null,
  guilds = [],
  degraded = false,
}) {
  return renderLayout({
    title: "Archived tickets",
    heading: "Archived tickets",
    content: renderTicketIndexContent({ tickets, total, page, pageSize, guildId }),
    guilds,
    currentGuildId: null, // the ticket index is not guild-scoped by URL
    degraded,
    user: req && req.user ? req.user : null,
    csrfToken: (req && req.csrfToken) || null,
    nonce: (res && res.locals && res.locals.cspNonce) || "",
  });
}

module.exports = {
  renderTicketIndexPage,
  renderTicketIndexContent,
};
