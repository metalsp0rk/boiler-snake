/**
 * Transcript surface on Express 5 (Phase 0a extraction of the legacy
 * tickets/httpServer.js dispatcher — roadmap/web-admin.md §8.2 — plus the
 * Phase 0c login/access gate of §8.4, subtask 12).
 *
 * Routes served (GET/HEAD only; the method gate in app.js rejects the rest
 * exactly like the legacy server did):
 *   GET /                          — archive index (legacy alias)
 *   GET /t, /t/                    — archive index
 *   GET /t/{uuid}[/]               — THEMED transcript page (record-rendered,
 *                                     §8.15 amendment; console chrome by decision)
 *   GET /t/{uuid}/raw              — frozen archive document (byte-parity
 *                                     oracle; export of the same record)
 *   GET /t/{uuid}/assets/{file}[/] — transcript asset (untouched)
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
  listArchivedTicketsForUser,
  countArchivedTicketsForUser,
} = require("../../db");
const {
  resolveTranscriptAbsolutePath,
} = require("../../features/tickets/transcript");
const {
  resolveAssetAbsolutePath,
  contentTypeForFilename,
} = require("../../features/tickets/assets");
const { resolveMemberNames } = require("./shared/discord-cache");
const { renderTranscriptPage } = require("../views/transcripts/transcriptPage");
const { listTicketMessages } = require("../../db");
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
function respondLoginRedirect(res, nextPath = null) {
  res.writeHead(302, {
    // §8.15-15.13: carry the ticket path through login so participants
    // (who have NO console surface to land on) come BACK to their ticket
    // instead of the staff home. login.js whitelists this exact shape
    // before signing and again before honoring it — never attacker-widened.
    Location: nextPath
      ? `/auth/login?next=${encodeURIComponent(nextPath)}`
      : "/auth/login",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end();
}

/**
 * The signed return path for THIS /t request (null ⇒ plain /auth/login).
 * Only ever a whitelisted shape (mirrors login.js TICKET_NEXT_RE); assets
 * round-trip to their transcript page.
 * @param {string} pathname raw (undecoded) pathname
 * @returns {string|null}
 */
function ticketLoginNext(pathname) {
  if (pathname === "/t" || pathname === "/t/") return "/t";
  const m = pathname.match(/^\/t\/([0-9a-fA-F-]{36})(?:\/raw|\/assets\/.*)?\/?$/);
  return m ? `/t/${m[1].toLowerCase()}` : null;
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
    respondLoginRedirect(res, req.ticketNext || null);
    return false;
  }
  sendNotFound(res);
  return false;
}

/**
 * GET /t for a viewer with NO staffed guild: "your tickets" (§8.15-15.13).
 * Same rows, same transcript links, same search — but the ROW SET is the
 * participant-scoped query and the page never renders /g/ affordances
 * (console links, people links, type-ahead): none of them would open for
 * this viewer. Data never includes rows the transcript URL would deny.
 * @param {import("http").IncomingMessage & {webSession?: object|null}} req
 * @param {import("http").ServerResponse} res
 * @param {URL} url
 * @param {{guildAccess: object, ticketAccess: object, getClient?: Function}} ctx
 */
async function serveParticipantArchive(req, res, url, ctx) {
  const userId = req.webSession && req.webSession.userId
    ? String(req.webSession.userId)
    : null;
  if (!userId) {
    respondLoginRedirect(res, req.ticketNext || null);
    return;
  }

  const guildFilter = url.searchParams.get("guild") || null; // AND-narrowing only
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 100);
  let page = Number(url.searchParams.get("page") || 1);
  if (!Number.isFinite(page) || page < 1) page = 1;

  const total = countArchivedTicketsForUser(userId, {
    guildId: guildFilter && /^[0-9]{5,20}$/.test(guildFilter) ? guildFilter : null,
    q,
  });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  const offset = (page - 1) * PAGE_SIZE;
  const tickets = listArchivedTicketsForUser(userId, {
    guildId: guildFilter && /^[0-9]{5,20}$/.test(guildFilter) ? guildFilter : null,
    q,
    limit: PAGE_SIZE,
    offset,
  });

  // cache-only display names (plain text in this mode — §8.6 no dead links)
  const namesByGuild = new Map();
  if (typeof ctx.getClient === "function" && tickets.length > 0) {
    const idsByGuild = new Map();
    for (const t of tickets) {
      const ids = idsByGuild.get(t.guild_id) ?? new Set();
      for (const id of [t.creator_user_id, t.staff_owner_id, t.closed_by_user_id]) {
        if (id) ids.add(String(id));
      }
      idsByGuild.set(t.guild_id, ids);
    }
    for (const [g, set] of idsByGuild) {
      if (set.size > 0) {
        namesByGuild.set(g, resolveMemberNames(ctx.getClient, g, [...set]));
      }
    }
  }

  const document = renderTicketIndexPage({
    req,
    res,
    tickets,
    total,
    page,
    pageSize: PAGE_SIZE,
    guildId: guildFilter && /^[0-9]{5,20}$/.test(guildFilter) ? guildFilter : null,
    q,
    namesByGuild,
    consoleLink: null,
    baseUrl: "/t",
    viewerMode: "participant",
  });
  writeShellHtml(req, res, { status: 200, document });
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
    respondLoginRedirect(res, req.ticketNext || null);
    return;
  }

  // §8.15-15.13: NO staffed guild ⇒ PARTICIPANT view of the same surface:
  // the archive rows THIS USER is linked to (requester/handler/member —
  // the exact linkage the transcript gate honors) across all guilds.
  // Staffed viewers keep the staff scope (superset; unchanged behavior).
  if (staffed.guildIds.length === 0) {
    return serveParticipantArchive(req, res, url, ctx);
  }

  const requested = url.searchParams.get("guild") || null;
  const guildId =
    requested && staffed.guildIds.includes(requested) ? requested : null;

  let page = Number(url.searchParams.get("page") || 1);
  if (!Number.isFinite(page) || page < 1) page = 1;

  // §8.15 first-class archive: free-text/number search. The clause is built
  // parameterized in the repo (escapes LIKE wildcards); it narrows rows but
  // NEVER widens scope — guild allow-listing is untouched above.
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 100);

  const scoped = staffed.guildIds.length > 0;
  let total = 0;
  let tickets = [];
  if (scoped) {
    total = guildId
      ? countArchivedTickets({ guildId, q })
      : countArchivedTicketsForGuilds(staffed.guildIds, q);

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > totalPages) page = totalPages;

    const offset = (page - 1) * PAGE_SIZE;
    tickets = guildId
      ? listArchivedTickets({ guildId, limit: PAGE_SIZE, offset, q })
      : listArchivedTicketsForGuilds({
          guildIds: staffed.guildIds,
          limit: PAGE_SIZE,
          offset,
          q,
        });
  }

  // People cells resolve display names per row's guild via the shared
  // cache-only seam (misses enqueue background fetches; §8.6 doctrine).
  const namesByGuild = new Map();
  if (typeof ctx.getClient === "function" && tickets.length > 0) {
    const idsByGuild = new Map();
    for (const t of tickets) {
      const ids = idsByGuild.get(t.guild_id) ?? new Set();
      for (const id of [t.creator_user_id, t.staff_owner_id, t.closed_by_user_id]) {
        if (id) ids.add(String(id));
      }
      idsByGuild.set(t.guild_id, ids);
    }
    for (const [g, set] of idsByGuild) {
      if (set.size > 0) {
        namesByGuild.set(g, resolveMemberNames(ctx.getClient, g, [...set]));
      }
    }
  }

  // Guild-filtered views get an honest way back INTO the console:
  // senior+ sees the open-ticket actions page, staff the guild dashboard
  // (staff has no /tickets actions access — never link a guaranteed 404).
  let consoleLink = null;
  if (guildId) {
    let tier = null;
    try {
      const access = await ctx.guildAccess.resolve(req.webSession, guildId);
      tier = access?.tier ?? null;
    } catch {
      tier = null; // link is a convenience; its absence can't fail the page
    }
    consoleLink =
      tier === "senior" || tier === "admin"
        ? { href: `/g/${guildId}/tickets`, label: "Open tickets →" }
        : tier
          ? { href: `/g/${guildId}`, label: "Guild dashboard →" }
          : null;
  }

  const document = renderTicketIndexPage({
    req,
    res,
    tickets,
    total,
    page,
    pageSize: PAGE_SIZE,
    guildId,
    q,
    namesByGuild,
    consoleLink,
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
 * Themed transcript VIEW (§8.15 amendment): renders the immutable DB record
 * (tickets row + ticket_messages + ai_summary_json) inside console chrome on
 * request. Same gate as everything on this surface — login + staff-or-
 * participant (§8.4), unknown/unarchived/sensitive ⇒ the same generic 404.
 * Chrome level follows the DECISION that admitted the viewer (never the
 * URL): staff get switcher+sidebar for the ticket's guild; participants get
 * the same content chrome-free.
 */
async function serveTranscriptView(req, res, tokenRaw, ctx) {
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

  const decision = await ctx.ticketAccess.resolveTicketAccess(req.webSession, ticket);
  if (!decision.allowed) {
    if (decision.staffStatus === "reauth" || decision.staffStatus === "anon") {
      respondLoginRedirect(res, req.ticketNext || null);
    } else {
      sendNotFound(res);
    }
    return;
  }
  const staff = decision.via === "staff";
  const tier = staff ? decision.tier || null : null;
  const guildId = String(ticket.guild_id ?? "");

  // The record itself. A read failure here is a real outage: let it surface
  // as the app's logged 500 (AGENTS.md) — never a blank "empty" transcript.
  const messages = listTicketMessages(ticket.id);

  const nameIds = [ticket.creator_user_id, ticket.staff_owner_id, ticket.closed_by_user_id]
    .filter(Boolean)
    .map(String);

  let guilds = [];
  let degraded = false;
  if (staff) {
    try {
      const listed = await ctx.guildAccess.listGuilds(req.webSession);
      guilds = (listed && listed.guilds ? listed.guilds : []).slice();
      if (!guilds.some((g) => g.id === guildId)) {
        guilds.unshift({ id: guildId, name: guildId });
      }
      degraded = !!(listed && listed.degraded);
    } catch {
      guilds = [{ id: guildId, name: guildId }];
    }
  }

  let summary = null;
  try {
    if (ticket.ai_summary_json) summary = JSON.parse(ticket.ai_summary_json);
  } catch {
    summary = null; // malformed legacy JSON must not blank the transcript
  }

  const signedInOnce =
    new URL(req.url || "/", "http://local").searchParams.get("logged-in") === "1";
  const document = renderTranscriptPage({
    req,
    res,
    ticket,
    messages,
    summary,
    staff,
    tier,
    signedIn: signedInOnce,
    names: resolveMemberNames(ctx.getClient, guildId, nameIds),
    guilds,
    degraded,
  });
  writeShellHtml(req, res, { status: 200, document });
}

/**
 * Raw frozen archive document — the EXPORT (§8.15 amendment). Byte-for-byte
 * what writeTranscriptFile wrote at close, headers and `private,
 * max-age=300` kept verbatim (the Phase 0a oracle lives HERE now). Missing
 * file is still "Transcript file missing" — while the themed VIEW above
 * keeps rendering from the DB regardless.
 */
async function serveTranscriptRaw(req, res, tokenRaw, ctx) {
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
  const url = new URL(req.url || "/", "http://localhost");
  req.ticketNext = ticketLoginNext(url.pathname);

  if (!req.webSession) {
    respondLoginRedirect(res, req.ticketNext);
    return;
  }

  // Index (UX v1.1 §8.15: "/" moved to the guild list; /t and /t/ serve
  // the archive index)
  if (url.pathname === "/t" || url.pathname === "/t/") {
    return serveArchiveIndex(req, res, url, ctx);
  }

  // Media: /t/{uuid}/assets/{filename}
  const assetMatch = url.pathname.match(
    /^\/t\/([^/]+)\/assets\/([^/]+)\/?$/
  );
  if (assetMatch) {
    return serveTranscriptAsset(req, res, assetMatch[1], assetMatch[2], ctx);
  }

  // Raw frozen document (export): /t/{uuid}/raw
  const rawMatch = url.pathname.match(/^\/t\/([^/]+)\/raw\/?$/);
  if (rawMatch) {
    return serveTranscriptRaw(req, res, rawMatch[1], ctx);
  }

  // Themed transcript page: /t/{uuid}
  const match = url.pathname.match(/^\/t\/([^/]+)\/?$/);
  if (!match) {
    return sendNotFound(res);
  }

  return serveTranscriptView(req, res, match[1], ctx);
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
 * @param {(() => object|null)|null} [options.getClient] live client thunk (names)
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
    // Optional live bot client for name resolution (dark boot ⇒ raw ids).
    getClient: typeof options.getClient === "function" ? options.getClient : null,
  });

  // Express 5 forwards rejected async handlers to the app error middleware
  // (generic 500) — the deliberate §8.4 failure contract lives INSIDE the
  // gate helpers (fail closed); decode/file errors keep the Phase 0a 500.
  app.get(["/t", "/t/", "/t/{*splat}"], (req, res) =>
    dispatchTranscripts(req, res, ctx)
  );
}

module.exports = {
  registerTranscriptRoutes,
  PAGE_SIZE,
};
