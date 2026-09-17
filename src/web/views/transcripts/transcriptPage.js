/**
 * Themed transcript page (roadmap §8.15 amendment to §8.4 / §8.1-3,
 * 2026-09-19): the console VIEW of an archived ticket, rendered on request
 * from the immutable DB record (tickets row + ticket_messages rows +
 * ai_summary_json). The frozen archive FILE is demoted to an EXPORT served
 * byte-identically at /t/{token}/raw — integrity now means "the record
 * never changes after close", not "the console page is the file".
 *
 * Chrome rules (§8.6 no-enumeration + zero dead links):
 *  - staff+ viewers get the guild shell chrome (switcher + sidebar into the
 *    ticket's guild, tier badge) — tier comes from the SAME live decision
 *    that admitted them, never from the URL;
 *  - participants (§8.4 alternative 2: requesters may read their own
 *    transcript) get the identical CONTENT inside a slim, chrome-free card:
 *    no switcher, no sidebar, no /g/ links (every such link would 404);
 *  - the raw-document link goes to /t/{token}/raw (same gate as everything
 *    here; assets stay on their untouched assets route).
 *
 * All dynamic data goes through the escaped-by-default html tag (§8.7);
 * multi-line message bodies reuse the archive's escape+<br> semantics so
 * what you read is what was archived.
 */

const { html, raw } = require("../escape");
const { renderLayout } = require("../layout");
const { userRef } = require("../components");
const { escapeHtml } = require("../../../features/tickets/transcript");
const { parseAttachmentList, mediaKind } = require("../../../features/tickets/assets");

/** "2026-09-17 00:25:11 UTC" (console house style). */
function formatTs(ms) {
  if (ms == null) return "—";
  try {
    return new Date(Number(ms)).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  } catch {
    return "—";
  }
}

/** Message body with the SAME escaping semantics as the frozen archive. */
function bodyHtml(content) {
  const esc = escapeHtml(content || "");
  return esc ? raw(esc.replace(/\n/g, "<br/>")) : html`<em>(empty)</em>`;
}

function renderAttachments(m) {
  let attachments = [];
  try {
    attachments = parseAttachmentList(m.attachment_urls);
  } catch {
    attachments = [];
  }
  const parts = attachments
    .filter((a) => a && (a.href || a.url))
    .map((a) => {
      const href = a.href || a.url;
      const name = a.name || href || "attachment";
      const kind = mediaKind(name, a.contentType);
      if (kind === "image") {
        return html`<figure class="att att-image">
          <a href="${href}" target="_blank" rel="noopener"><img src="${href}" alt="${name}" loading="lazy"/></a>
          <figcaption><a href="${href}" target="_blank" rel="noopener">${name}</a></figcaption>
        </figure>`;
      }
      if (kind === "video") {
        return html`<div class="att att-video">
          <video controls preload="metadata" src="${href}"></video>
          <div><a href="${href}" target="_blank" rel="noopener">${name}</a></div>
        </div>`;
      }
      if (kind === "audio") {
        return html`<div class="att att-audio">
          <audio controls preload="metadata" src="${href}"></audio>
          <div><a href="${href}" target="_blank" rel="noopener">${name}</a></div>
        </div>`;
      }
      return html`<div class="att att-file"><a href="${href}" target="_blank" rel="noopener">${name}</a></div>`;
    });
  return parts.length ? html`<div class="attachments">${parts}</div>` : html``;
}

function renderMessage(m) {
  return html`
    <article class="tmsg">
      <header class="tmsg-meta">
        <strong class="tmsg-author">${m.author_tag || m.author_id || "unknown"}</strong>
        <span>${formatTs(m.sent_at)}</span>
        <code class="tmsg-id">#${m.message_id || "?"}</code>
      </header>
      <div class="tmsg-body">${bodyHtml(m.content)}</div>
      ${renderAttachments(m)}
    </article>`;
}

/** AI/fallback summary card — the frozen archive NEVER showed this (§8.15). */
function renderSummary(summary) {
  if (!summary || typeof summary !== "object") return html``;
  // THE AI narrative lives in `summary` — the stored paragraph is the
  // point of the whole feature; subject/resolution are context bits.
  // (Bug 2026-09-19: the card rendered the bits but never this field,
  // so AI summaries looked no different from the fallback.)
  const prose = String(summary.summary || "").trim();
  const para = prose
    ? raw(escapeHtml(prose).replace(/\n/g, "<br/>"))
    : null;
  const bits = [];
  if (summary.subject) bits.push(html`<dt>Subject</dt><dd>${summary.subject}</dd>`);
  if (summary.resolution) bits.push(html`<dt>Resolution</dt><dd>${summary.resolution}</dd>`);
  if (summary.close_reason) bits.push(html`<dt>Close reason</dt><dd>${summary.close_reason}</dd>`);
  if (summary.message_count != null) {
    bits.push(html`<dt>Messages</dt><dd>${String(summary.message_count)}</dd>`);
  }
  if (!bits.length && !para) return html``;
  const src =
    summary.source === "ai"
      ? html`AI summary${summary.model ? html` · ${summary.model}` : html``}`
      : html`Auto summary (no AI configured at close time)`;
  return html`
    <section class="panel transcript-summary">
      <h2>Summary <span class="badge">${src}</span></h2>
      ${para ? html`<p class="summary-prose">${para}</p>` : html``}
      ${bits.length ? html`<dl class="dashboard-dl">${bits}</dl>` : html``}
    </section>`;
}

/**
 * Meta card people entry: staff get linked userRefs (they can reach those
 * pages); participants get plain text (a /g/ link would only 404 for them).
 */
function person(staff, guildId, userId, names) {
  if (!userId) return html`—`;
  if (staff) return userRef(guildId, String(userId), names);
  const known = names instanceof Map ? names.get(String(userId)) : null;
  return html`${known || String(userId)}`;
}

/**
 * @param {object} input
 * @param {object} input.req session user/csrf carrier
 * @param {import("http").ServerResponse} input.res nonce source (locals)
 * @param {object} input.ticket tickets row (archived, token-bearing)
 * @param {object[]} input.messages ticket_messages rows (chronological)
 * @param {object|null} input.summary parsed ai_summary_json (or null)
 * @param {boolean} input.staff viewer admitted via staff decision
 * @param {string|null} input.tier viewer's live tier in the ticket's guild
 * @param {Map<string, string|null>} input.names cache-only display names
 * @param {Array<{id:string,name?:string}>} input.guilds switcher guilds (staff only)
 * @param {boolean} [input.degraded] resolver degraded banner flag
 * @returns {import("../escape").SafeString}
 */
function renderTranscriptPage({
  req,
  res,
  ticket,
  messages,
  summary,
  staff,
  tier,
  names,
  guilds = [],
  degraded = false,
}) {
  const guildId = String(ticket.guild_id ?? "");
  const token = String(ticket.transcript_token ?? "");
  const num = String(ticket.ticket_number ?? "?");
  const title = `Ticket #${num} — archived transcript`;

  const meta = html`
    <dl class="dashboard-dl transcript-meta">
      <dt>Requester</dt><dd>${person(staff, guildId, ticket.creator_user_id, names)}</dd>
      <dt>Staff owner</dt><dd>${person(staff, guildId, ticket.staff_owner_id, names)}</dd>
      <dt>Closed by</dt><dd>${person(staff, guildId, ticket.closed_by_user_id, names)}</dd>
      <dt>Opened</dt><dd>${formatTs(ticket.created_at)}</dd>
      <dt>Closed</dt><dd>${formatTs(ticket.closed_at)}</dd>
      <dt>Reason</dt><dd>${ticket.reason || "—"}</dd>
      <dt>Close reason</dt><dd>${ticket.close_reason || "—"}</dd>
      <dt>Guild</dt><dd><code class="gid">${guildId}</code></dd>
    </dl>`;

  const body = (messages || []).length
    ? html`<div class="transcript-messages">${messages.map(renderMessage)}</div>`
    : html`<p class="empty-state">No messages were archived for this ticket.</p>`;

  const content = html`
    <section class="panel transcript-header">
      <p class="subheading">
        Immutable record rendered from the archive database — this page shows
        exactly what was captured at close.
        <a class="transcript-raw-link" href="/t/${token}/raw">View raw archived document →</a>
      </p>
      ${meta}
    </section>
    ${renderSummary(summary)}
    ${body}`;

  // Staff get the shell chrome for the ticket's guild; participants get the
  // SAME content in a chrome-free layout (no switcher/sidebar//g/ links —
  // nothing here may dangle a page they cannot open).
  return renderLayout({
    title,
    heading: `Ticket #${num}`,
    subheading: staff ? "Archived ticket transcript" : "Archived ticket transcript (your copy)",
    content,
    guilds: staff ? guilds : [],
    currentGuildId: staff ? guildId : null,
    tier: staff ? tier : null,
    degraded: staff ? !!degraded : false,
    user: req && req.user ? req.user : null,
    csrfToken: (req && req.csrfToken) || null,
    nonce: (res && res.locals && res.locals.cspNonce) || "",
    // Active nav: the transcript lives on the archive surface, NOT the
    // dashboard. "" used to highlight Dashboard (empty sub ⇒ dashboard's
    // suffix match) — "/t" marks the Ticket archive item active.
    path: "/t",
  });
}

module.exports = {
  renderTranscriptPage,
  formatTs,
};
