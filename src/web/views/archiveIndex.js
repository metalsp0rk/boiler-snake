/**
 * Archive-index HTML view for the public transcript surface (moved verbatim
 * from tickets/httpServer.js during the Phase 0a extraction; output bytes
 * must not change — test/web-http-net.test.js pins them).
 */

const { escapeHtml } = require("../../features/tickets/transcript");

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
 * Render staff index of content-archived tickets.
 * @param {object} opts
 * @param {object[]} opts.tickets
 * @param {number} opts.total
 * @param {number} opts.page
 * @param {number} opts.pageSize
 * @param {string|null} [opts.guildId]
 * @returns {string}
 */
function renderArchiveIndexHtml(opts) {
  const { tickets, total, page, pageSize, guildId } = opts;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const filterNote = guildId
    ? `Guild filter: <code>${escapeHtml(guildId)}</code>`
    : "All guilds";

  const rows = (tickets || [])
    .map((t) => {
      const href = `/t/${encodeURIComponent(t.transcript_token)}`;
      const reason = escapeHtml(snippet(t.reason, 100));
      const closeReason = escapeHtml(snippet(t.close_reason, 80));
      return `
      <tr>
        <td><a href="${href}">#${escapeHtml(String(t.ticket_number))}</a></td>
        <td><code class="gid">${escapeHtml(t.guild_id)}</code></td>
        <td>${escapeHtml(formatTs(t.closed_at))}</td>
        <td class="reason">${reason}</td>
        <td class="reason">${closeReason}</td>
        <td><a href="${href}">View</a></td>
      </tr>`;
    })
    .join("\n");

  const empty =
    !tickets?.length
      ? `<tr><td colspan="6" class="empty">No archived transcripts yet.</td></tr>`
      : "";

  const qs = (p) => {
    const params = new URLSearchParams();
    if (guildId) params.set("guild", guildId);
    if (p > 1) params.set("page", String(p));
    const s = params.toString();
    return s ? `?${s}` : "";
  };

  let nav = "";
  if (totalPages > 1) {
    const prev =
      page > 1
        ? `<a href="/t${qs(page - 1)}">← Prev</a>`
        : `<span class="disabled">← Prev</span>`;
    const next =
      page < totalPages
        ? `<a href="/t${qs(page + 1)}">Next →</a>`
        : `<span class="disabled">Next →</span>`;
    nav = `<nav class="pager">${prev} <span>Page ${page} / ${totalPages}</span> ${next}</nav>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Archived tickets</title>
<style>
  :root { color-scheme: dark light; }
  body { font-family: system-ui, sans-serif; max-width: 1100px; margin: 1.5rem auto; padding: 0 1rem; line-height: 1.45; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  .sub { opacity: 0.75; font-size: 0.9rem; margin-bottom: 1rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.55rem 0.65rem; border-bottom: 1px solid #5553; vertical-align: top; }
  th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; opacity: 0.8; }
  tr:hover td { background: #8881; }
  a { color: #5b9dff; }
  code.gid { font-size: 0.75rem; word-break: break-all; }
  .reason { max-width: 14rem; word-break: break-word; }
  .empty { text-align: center; opacity: 0.7; padding: 2rem !important; }
  .pager { display: flex; gap: 1rem; align-items: center; margin: 1.25rem 0; font-size: 0.9rem; }
  .pager .disabled { opacity: 0.4; }
  footer { margin-top: 2rem; font-size: 0.75rem; opacity: 0.6; }
  .warn { border: 1px solid #c90; background: #c901; padding: 0.65rem 0.85rem; border-radius: 6px; font-size: 0.85rem; margin-bottom: 1rem; }
</style>
</head>
<body>
  <h1>Archived tickets</h1>
  <p class="sub">${filterNote} · <strong>${total}</strong> transcript${total === 1 ? "" : "s"} · staff use only</p>
  <p class="warn">This index is not login-gated (MVP). Keep the host private (VPN, reverse-proxy auth, or firewall). Sensitive tickets never appear here.</p>
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
      ${rows || empty}
    </tbody>
  </table>
  ${nav}
  <footer>Boiler Snake ticket transcripts · <a href="/health">health</a></footer>
</body>
</html>`;
}

module.exports = {
  renderArchiveIndexHtml,
};
