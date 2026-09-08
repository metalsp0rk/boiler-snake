/**
 * Transcript surface on Express 5 (Phase 0a extraction of the legacy
 * tickets/httpServer.js dispatcher — roadmap/web-admin.md §8.2).
 *
 * Routes served (GET/HEAD only; the method gate in app.js rejects the rest
 * exactly like the legacy server did):
 *   GET /                          — archive index (legacy alias)
 *   GET /t, /t/                    — archive index
 *   GET /t/{uuid}[/]               — single HTML transcript
 *   GET /t/{uuid}/assets/{file}[/] — transcript asset
 *
 * Byte-parity note: the uuid/asset dispatch intentionally re-matches the
 * RAW request URL (decode-free `new URL(...).pathname`) with the legacy
 * regexes instead of using Express path params. path-to-regexp v8 decode /
 * normalization semantics must never decide whether a route exists here —
 * e.g. a `%2F`-encoded segment must still hit the raw-URL UUID gate and a
 * malformed `%` sequence must still surface as a 500, exactly like the
 * pre-extraction server. Express routing is only coarse dispatch.
 */

const fs = require("fs");
const path = require("path");
const {
  getTicketByTranscriptToken,
  listArchivedTickets,
  countArchivedTickets,
} = require("../../db");
const {
  resolveTranscriptAbsolutePath,
} = require("../../features/tickets/transcript");
const {
  resolveAssetAbsolutePath,
  contentTypeForFilename,
} = require("../../features/tickets/assets");
const { renderArchiveIndexHtml } = require("../views/archiveIndex");

const PAGE_SIZE = 50;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @param {import("http").ServerResponse} res
 */
function sendNotFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
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
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {string} tokenRaw
 * @param {string} filenameRaw
 */
function serveTranscriptAsset(req, res, tokenRaw, filenameRaw) {
  const token = decodeURIComponent(tokenRaw);
  const filename = decodeURIComponent(filenameRaw);

  if (!UUID_RE.test(token)) {
    sendNotFound(res);
    return;
  }

  const ticket = getTicketByTranscriptToken(token);
  if (!ticket || !ticket.archived) {
    sendNotFound(res);
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
 * @param {string} tokenRaw
 */
function serveTranscript(req, res, tokenRaw) {
  const token = decodeURIComponent(tokenRaw);
  if (!UUID_RE.test(token)) {
    sendNotFound(res);
    return;
  }

  const ticket = getTicketByTranscriptToken(token);
  if (!ticket || !ticket.archived) {
    sendNotFound(res);
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
    sendNotFound(res);
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
 * Legacy dispatcher: index aliases → asset route → transcript route → 404.
 * Matches on the RAW URL pathname (no percent-decoding before matching),
 * identical to the pre-extraction node:http handler.
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
function dispatchTranscripts(req, res) {
  const url = new URL(req.url || "/", "http://localhost");

  // Root → index (legacy: "/", "/t", "/t/" all render the archive index)
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
    return sendNotFound(res);
  }

  return serveTranscript(req, res, match[1]);
}

/**
 * Register the transcript surface on an Express app (no listen side effect).
 * `/{*splat}` is the Express 5 (path-to-regexp v8) named-wildcard spelling
 * for "any depth under /t"; "/t" and "/t/" are literal aliases. All path
 * semantics are re-decided on the raw URL inside dispatchTranscripts.
 * @param {import("express").Express} app
 */
function registerTranscriptRoutes(app) {
  app.get(["/", "/t", "/t/", "/t/{*splat}"], (req, res) =>
    dispatchTranscripts(req, res)
  );
}

module.exports = {
  registerTranscriptRoutes,
  PAGE_SIZE,
};
