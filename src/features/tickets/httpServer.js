/**
 * Minimal HTTP server for staff ticket transcripts:
 *   GET /t          — index of archived tickets
 *   GET /t/{uuid}   — single HTML transcript
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  getTicketByTranscriptToken,
  listArchivedTickets,
  countArchivedTickets,
} = require("../../db");
const {
  resolveTranscriptAbsolutePath,
  escapeHtml,
} = require("./transcript");
const {
  resolveAssetAbsolutePath,
  contentTypeForFilename,
} = require("./assets");

/** @type {import("http").Server|null} */
let server = null;

const PAGE_SIZE = 50;

/**
 * @returns {{ port: number|null, publicBaseUrl: string|null }}
 */
function getHttpConfig() {
  const portRaw = process.env.TICKET_HTTP_PORT;
  const port =
    portRaw != null && String(portRaw).trim() !== ""
      ? Number(portRaw)
      : null;
  const publicBaseUrl = process.env.TICKET_PUBLIC_BASE_URL
    ? String(process.env.TICKET_PUBLIC_BASE_URL).replace(/\/$/, "")
    : null;
  return {
    port: Number.isFinite(port) && port > 0 ? port : null,
    publicBaseUrl,
  };
}

/**
 * Public URL for a transcript token (null if base URL unset).
 * @param {string} token
 * @returns {string|null}
 */
function transcriptPublicUrl(token) {
  const { publicBaseUrl } = getHttpConfig();
  if (!publicBaseUrl || !token) return null;
  return `${publicBaseUrl}/t/${token}`;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Start listening if TICKET_HTTP_PORT is set. Idempotent.
 * @returns {import("http").Server|null}
 */
function startTicketHttpServer() {
  const { port } = getHttpConfig();
  if (!port) {
    console.log(
      "[tickets] Transcript HTTP server disabled (set TICKET_HTTP_PORT to enable)."
    );
    return null;
  }
  if (server) return server;

  server = http.createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (err) {
      console.error("[tickets] HTTP handler error:", err);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal error");
    }
  });

  server.on("error", (err) => {
    console.error("[tickets] HTTP server error:", err?.message || err);
  });

  server.listen(port, () => {
    console.log(
      `[tickets] Transcript HTTP listening on port ${port} (index: /t)`
    );
  });

  return server;
}

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

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
function handleRequest(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : "ok");
    return;
  }

  // Root → index
  if (url.pathname === "/" || url.pathname === "/t" || url.pathname === "/t/") {
    return serveArchiveIndex(req, res, url);
  }

  // Media: /t/{uuid}/assets/{filename}
  const assetMatch = url.pathname.match(
    /^\/t\/([^/]+)\/assets\/([^/]+)\/?$/
  );
  if (assetMatch) {
    return serveTranscriptAsset(req, res, assetMatch[1], assetMatch[2]);
  }

  // Transcript HTML: /t/{uuid}
  const match = url.pathname.match(/^\/t\/([^/]+)\/?$/);
  if (!match) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const token = decodeURIComponent(match[1]);
  if (!UUID_RE.test(token)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const ticket = getTicketByTranscriptToken(token);
  if (!ticket || !ticket.archived) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const abs = resolveTranscriptAbsolutePath(ticket);
  if (!abs || !fs.existsSync(abs)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Transcript file missing");
    return;
  }

  const resolved = path.resolve(abs);
  const base = path.basename(resolved);
  // Allow nested index.html or legacy {token}.html
  if (base !== "index.html" && base !== `${token}.html`) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const body = fs.readFileSync(resolved);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {string} tokenRaw
 * @param {string} filenameRaw
 */
function serveTranscriptAsset(req, res, tokenRaw, filenameRaw) {
  const token = decodeURIComponent(tokenRaw);
  const filename = decodeURIComponent(filenameRaw);

  if (!UUID_RE.test(token)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const ticket = getTicketByTranscriptToken(token);
  if (!ticket || !ticket.archived) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const abs = resolveAssetAbsolutePath(ticket.guild_id, token, filename);
  if (!abs) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Asset not found");
    return;
  }

  const body = fs.readFileSync(abs);
  res.writeHead(200, {
    "Content-Type": contentTypeForFilename(filename),
    "Cache-Control": "private, max-age=86400",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": body.length,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {URL} url
 */
function serveArchiveIndex(req, res, url) {
  const guildId = url.searchParams.get("guild") || null;
  let page = Number(url.searchParams.get("page") || 1);
  if (!Number.isFinite(page) || page < 1) page = 1;

  const total = countArchivedTickets(guildId ? { guildId } : {});
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > totalPages) page = totalPages;

  const offset = (page - 1) * PAGE_SIZE;
  const tickets = listArchivedTickets({
    guildId: guildId || undefined,
    limit: PAGE_SIZE,
    offset,
  });

  const html = renderArchiveIndexHtml({
    tickets,
    total,
    page,
    pageSize: PAGE_SIZE,
    guildId,
  });

  const body = Buffer.from(html, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, max-age=60",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": body.length,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

/**
 * Stop the server (tests).
 * @returns {Promise<void>}
 */
function stopTicketHttpServer() {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    const s = server;
    server = null;
    s.close(() => resolve());
  });
}

module.exports = {
  getHttpConfig,
  transcriptPublicUrl,
  startTicketHttpServer,
  stopTicketHttpServer,
  handleRequest,
  renderArchiveIndexHtml,
  PAGE_SIZE,
};
