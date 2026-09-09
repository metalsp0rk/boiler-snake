/**
 * Transcript surface on Express 5 (Phase 0a extraction of the legacy
 * tickets/httpServer.js dispatcher — roadmap/web-admin.md §8.2 — plus the
 * Phase 0c login/access gate of §8.4, subtask 12).
 *
 * Routes served (GET/HEAD only; the method gate in app.js rejects the rest
 * exactly like the legacy server did):
 *   GET /                          — archive index (legacy alias)
 *   GET /t, /t/                    — archive index
 *   GET /t/{uuid}[/]               — single HTML transcript
 *   GET /t/{uuid}/assets/{file}[/] — transcript asset
 *
 * §8.4 ACCESS CONTRACT (locked decision §8.1-3 — login-mandatory, NO flag):
 *  - every path above (root aliases included) requires a live session;
 *    anonymous / re-auth ⇒ 302 to /auth/login (same framing as
 *    middleware/guildScope.js: Location + no-store + no-referrer);
 *  - a transcript (and its assets) opens for a staff+ tier of the TICKET'S
 *    guild (resolved from the ticket ROW via auth/guildAccess — never a URL
 *    parameter) OR for a §8.4 participant (auth/participants.js);
 *  - everything else is the generic 404 "Not found" — a stranger with a
 *    valid session, an unknown token, an unarchived row, a sensitive ticket
 *    (transcript token cleared on close ⇒ cannot resolve) and a cross-guild
 *    probe are byte-identical (§8.6, never 403);
 *  - the /t index is guild-scoped to the guilds where the viewer resolves
 *    staff+ (§8.6 Tickets row: index = Staff); the legacy ?guild= param is
 *    honored ONLY for one of those guilds, otherwise it is IGNORED (the
 *    scoped default renders — never the requested foreign guild).
 *  - the index renders INSIDE the subtask-11 shell (views/tickets/indexPage
 *    + writeShellHtml ⇒ Cache-Control: no-store, the page embeds per-
 *    response nonce + session CSRF). The archived transcript document
 *    itself stays raw byte-for-byte (§8.4 content archive; max-age=300
 *    kept), assets raw too — the gate is identical either way.
 *
 * Byte-parity note: the uuid/asset dispatch intentionally re-matches the
 * RAW request URL (decode-free `new URL(...).pathname`) with the legacy
 * regexes instead of using Express path params. path-to-regexp v8 decode /
 * normalization semantics must never decide whether a route exists here —
 * e.g. a `%2F`-encoded segment must still hit the raw-URL UUID gate and a
 * malformed `%` sequence must still surface as a 500 (via the app's error
 * middleware — the auth layer adds no catch-all around file/decode work),
 * exactly like the pre-extraction server. Express routing is only coarse
 * dispatch. Responses keep the raw `res.writeHead()/res.end()` framing.
 */

const fs = require("fs");
const path = require("path");
const {
  getTicketByTranscriptToken,
  listArchivedTickets,
  countArchivedTickets,
  listArchivedTicketsForGuilds,
  countArchivedTicketsForGuilds,
} = require("../../db");
const {
  resolveTranscriptAbsolutePath,
} = require("../../features/tickets/transcript");
const {
  resolveAssetAbsolutePath,
  contentTypeForFilename,
} = require("../../features/tickets/assets");
const { renderTicketIndexPage } = require("../views/tickets/indexPage");
const { writeShellHtml } = require("../views/layout");
const { createGuildAccessResolver } = require("../auth/guildAccess");
const { createTicketAccessResolver } = require("../auth/participants");

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
 * §8.4/§8.1-3 login redirect — headers byte-identical to
 * middleware/guildScope.js's respondLoginRedirect (kept local: guildScope's
 * helper is not part of its public exports and guild ids never apply to a
 * ticket URL — the ticket's guild is unknown until its row is loaded, and
 * the login flow's `?guild=` target would skip straight past the ticket).
 * @param {import("http").ServerResponse} res
 */
function respondLoginRedirect(res) {
  res.writeHead(302, {
    Location: "/auth/login",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end();
}

/**
 * Guilds where the viewer resolves staff+ (§8.6 Tickets row). Sequential
 * resolver calls against the guildAccess TTL caches (subtask 07) — cheap
 * after the first pass. Any re-auth (token revoked mid-list) aborts into a
 * redirect decision; any unexpected failure fails CLOSED to an empty scope.
 * Entries keep their display names for the shell's guild switcher — the
 * switcher list is EXACTLY this scoped set (never the wider bot∩user list).
 * @param {{resolve: Function, listGuilds: Function}} guildAccess
 * @param {{id: string, userId: string}} session
 * @returns {Promise<{guilds: Array<{id: string, name: string|null}>, guildIds: string[], reauth: boolean, degraded: boolean}>}
 */
async function listStaffedGuilds(guildAccess, session) {
  try {
    const listed = await guildAccess.listGuilds(session);
    if (listed.reauth) {
      return { guilds: [], guildIds: [], reauth: true, degraded: false };
    }
    const guilds = [];
    for (const guild of listed.guilds || []) {
      const access = await guildAccess.resolve(session, guild.id);
      if (access.status === "reauth" || access.status === "anon") {
        return { guilds: [], guildIds: [], reauth: true, degraded: false };
      }
      if (access.status === "ok") {
        guilds.push({
          id: guild.id,
          name: typeof guild.name === "string" && guild.name.trim() ? guild.name : null,
        });
      }
    }
    return {
      guilds,
      guildIds: guilds.map((g) => g.id),
      reauth: false,
      degraded: !!listed.degraded,
    };
  } catch (err) {
    console.warn(
      "[web] transcripts: staff-guild scope failed closed:",
      err?.code || err?.message || err
    );
    return { guilds: [], guildIds: [], reauth: false, degraded: false };
  }
}

/**
 * Staff+ OR participant gate for one resolved ticket row (§8.4). Maps the
 * access decision onto responses: allow → true (caller serves), re-auth →
 * login redirect, everything else → the generic 404 (cross-guild,
 * stranger-in-guild and unknown-ticket are indistinguishable, §8.6).
 * @param {import("http").IncomingMessage & {webSession?: object|null}} req
 * @param {import("http").ServerResponse} res
 * @param {{ticketAccess: {resolveTicketAccess: Function}}} ctx
 * @param {object} ticket
 * @returns {Promise<boolean>}
 */
async function allowTicketView(req, res, ctx, ticket) {
  const decision = await ctx.ticketAccess.resolveTicketAccess(req.webSession, ticket);
  if (decision.allowed) return true;
  if (decision.staffStatus === "reauth" || decision.staffStatus === "anon") {
    respondLoginRedirect(res);
    return false;
  }
  sendNotFound(res);
  return false;
}

/**
 * GET /t index — shell page (§8.8 Phase 0c shell; subtask 11 layout).
 * Rows + switcher guilds come from the SAME staffed-guild scope, so the
 * page can never show (or offer) a guild the gate would not honor.
 * @param {import("http").IncomingMessage & {webSession?: object|null, user?: object|null, csrfToken?: string|null}} req
 * @param {import("http").ServerResponse} res
 * @param {URL} url
 * @param {{guildAccess: {resolve: Function, listGuilds: Function}}} ctx
 */
async function serveArchiveIndex(req, res, url, ctx) {
  // §8.4 rule 3: rows only from guilds where the viewer is staff+. The URL
  // cannot widen this scope — the legacy ?guild= param is honored ONLY when
  // it names one of these guilds, otherwise it is ignored (scoped default).
  const staffed = await listStaffedGuilds(ctx.guildAccess, req.webSession);
  if (staffed.reauth) {
    respondLoginRedirect(res);
    return;
  }

  const requested = url.searchParams.get("guild") || null;
  const guildId =
    requested && staffed.guildIds.includes(requested) ? requested : null;

  let page = Number(url.searchParams.get("page") || 1);
  if (!Number.isFinite(page) || page < 1) page = 1;

  const scoped = staffed.guildIds.length > 0;
  let total = 0;
  let tickets = [];
  if (scoped) {
    total = guildId
      ? countArchivedTickets({ guildId })
      : countArchivedTicketsForGuilds(staffed.guildIds);

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > totalPages) page = totalPages;

    const offset = (page - 1) * PAGE_SIZE;
    tickets = guildId
      ? listArchivedTickets({ guildId, limit: PAGE_SIZE, offset })
      : listArchivedTicketsForGuilds({
          guildIds: staffed.guildIds,
          limit: PAGE_SIZE,
          offset,
        });
  }

  const document = renderTicketIndexPage({
    req,
    res,
    tickets,
    total,
    page,
    pageSize: PAGE_SIZE,
    guildId,
    guilds: staffed.guilds,
    degraded: staffed.degraded,
  });
  // Shell framing (writeShellHtml): no-store on purpose — the page embeds
  // the per-response CSP nonce and the session CSRF token, so a cached body
  // would carry stale security material (the pre-login `private, max-age=60`
  // dies with §8.1-3, decision-3 row).
  writeShellHtml(req, res, { status: 200, document });
}

/**
 * @param {import("http").IncomingMessage & {webSession?: object|null}} req
 * @param {import("http").ServerResponse} res
 * @param {string} tokenRaw
 * @param {string} filenameRaw
 * @param {{ticketAccess: {resolveTicketAccess: Function}}} ctx
 */
async function serveTranscriptAsset(req, res, tokenRaw, filenameRaw, ctx) {
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

  // §8.4: assets inherit the EXACT gate of their transcript — no separate
  // rule, so an asset can never leak where the transcript itself would 404.
  if (!(await allowTicketView(req, res, ctx, ticket))) return;

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
 * @param {import("http").IncomingMessage & {webSession?: object|null}} req
 * @param {import("http").ServerResponse} res
 * @param {string} tokenRaw
 * @param {{ticketAccess: {resolveTicketAccess: Function}}} ctx
 */
async function serveTranscript(req, res, tokenRaw, ctx) {
  const token = decodeURIComponent(tokenRaw);
  if (!UUID_RE.test(token)) {
    sendNotFound(res);
    return;
  }

  const ticket = getTicketByTranscriptToken(token);
  // Unknown token, unarchived row and sensitive ticket (closeTicketSensitive
  // clears transcript_token) all land in the same generic 404 (§8.4:
  // sensitive tickets "still 404, unchanged") — BEFORE any access decision,
  // so the 404s of strangers and of non-existing tickets stay identical.
  if (!ticket || !ticket.archived) {
    sendNotFound(res);
    return;
  }

  // §8.4 staff-or-participant; deny ⇒ generic 404 (never 403).
  if (!(await allowTicketView(req, res, ctx, ticket))) return;

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
 * Legacy dispatcher: login gate (§8.4/§8.1-3) → index aliases → asset route
 * → transcript route → 404. Matches on the RAW URL pathname (no
 * percent-decoding before matching), identical to the pre-extraction
 * node:http handler — the only pre-existing responses that may now be 302s
 * are the anonymous ones.
 * @param {import("http").IncomingMessage & {webSession?: object|null}} req
 * @param {import("http").ServerResponse} res
 * @param {{guildAccess: object, ticketAccess: object}} ctx
 */
async function dispatchTranscripts(req, res, ctx) {
  // §8.1-3: login required for the ENTIRE ticket surface (index aliases,
  // transcripts, assets) — no config flag, no escape hatch. The methodGate
  // in app.js still 405s non-GET/HEAD BEFORE this gate, so the legacy 405
  // bytes are untouched.
  if (!req.webSession) {
    respondLoginRedirect(res);
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");

  // Root → index (legacy: "/", "/t", "/t/" all render the archive index)
  if (url.pathname === "/" || url.pathname === "/t" || url.pathname === "/t/") {
    return serveArchiveIndex(req, res, url, ctx);
  }

  // Media: /t/{uuid}/assets/{filename}
  const assetMatch = url.pathname.match(
    /^\/t\/([^/]+)\/assets\/([^/]+)\/?$/
  );
  if (assetMatch) {
    return serveTranscriptAsset(req, res, assetMatch[1], assetMatch[2], ctx);
  }

  // Transcript HTML: /t/{uuid}
  const match = url.pathname.match(/^\/t\/([^/]+)\/?$/);
  if (!match) {
    return sendNotFound(res);
  }

  return serveTranscript(req, res, match[1], ctx);
}

/**
 * Register the transcript surface on an Express app (no listen side effect).
 * `/{*splat}` is the Express 5 (path-to-regexp v8) named-wildcard spelling
 * for "any depth under /t"; "/t" and "/t/" are literal aliases. All path
 * semantics are re-decided on the raw URL inside dispatchTranscripts.
 *
 * §8.4 seams (same options shape createWebApp already forwards to the /g
 * shell): a pre-built `guildAccess` resolver for tests/wiring, otherwise a
 * real one is built from apiBase/fetchImpl/botGuilds.
 * @param {import("express").Express} app
 * @param {object} [options]
 * @param {{resolve: Function, listGuilds: Function}} [options.guildAccess]
 * @param {string} [options.apiBase] @param {typeof fetch} [options.fetchImpl]
 * @param {() => Promise<string[]>|string[]} [options.botGuilds]
 */
function registerTranscriptRoutes(app, options = {}) {
  const guildAccess =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });
  const ctx = Object.freeze({
    guildAccess,
    ticketAccess: createTicketAccessResolver({ guildAccess }),
  });

  // Express 5 forwards rejected async handlers to the app error middleware
  // (generic 500) — the deliberate §8.4 failure contract lives INSIDE the
  // gate helpers (fail closed); decode/file errors keep the Phase 0a 500.
  app.get(["/", "/t", "/t/", "/t/{*splat}"], (req, res) =>
    dispatchTranscripts(req, res, ctx)
  );
}

module.exports = {
  registerTranscriptRoutes,
  PAGE_SIZE,
};
