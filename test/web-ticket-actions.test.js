/**
 * Subtask 30 — PHASE 3 TICKET ACTIONS: claim / close / summary regen
 * (roadmap/web-admin.md §8.6 "Tickets | Senior: claim/close/summary regen";
 * §8.8 Phase 3; §8.11 parity).
 *
 * Everything the web mutations do must be indistinguishable from the SLASH
 * at the service / DB / audit boundary, and everything they refuse must
 * write NOTHING. Mechanism: REAL Express 5 app on an ephemeral port, REAL
 * SQLite, fake Discord transport under the REAL createGuildAccessResolver
 * (Phase-2/3 gate boot discipline — sessions minted offline, csrf derived,
 * one loadDb). Slash parity runs the REAL handleTicket claim/close/
 * summarize handlers against the SAME database (mock interactions, the
 * moderation-actions precedent).
 *
 * What this suite pins:
 *  A. MUTATION CONTRACT — three POST registry entries minted in lockstep
 *     with the mounted routes (one template constant each); the ticket row
 *     id rides the body (methodGate matches :guildId only).
 *  B. ACTIONS PAGE + FLASH (GET) — senior/admin see the forms with hidden
 *     _csrf + the field contract (junior 403: §8.6 senior-only surface,
 *     documented tightening vs slash requireStaff); PRG flash renders ONLY
 *     whitelisted slugs (hostile values never echo; foreign-page slugs
 *     stay invisible).
 *  C. TIER LADDER (POST) — anon 302 · stranger/plain/cross generic 404
 *     (§8.6 never-403 cross-guild) · JUNIOR 403 with ZERO service calls
 *     (the delta (1) assertion) · senior/admin pass.
 *  D. CSRF — missing / tampered ⇒ 403 with ZERO facade calls, zero rows.
 *  E. CLAIM — facade.claimTicket through the recorder (zero route SQL),
 *     slash-identical args, row + ticket_staff owner flip, audit
 *     tickets.claim origin web with the EXACT slash detail shape,
 *     idempotent TAKEOVER (no already-claimed refusal — slash rule),
 *     cache-only channel notice (uncached ⇒ graceful skip, slash's own
 *     null-channel path), NO requester DM, NO channel mirror.
 *  F. VALIDATION — slash status rules mirrored (claim/close OPEN-only —
 *     refusal BEFORE any write helper), ticket id field shape, close
 *     reason ≤ MAX_TICKET_REASON pre-validated; every refusal is a
 *     whitelisted-slug 302 with zero writes and zero audit.
 *  G. CROSS-GUILD TICKET — a row id that exists only in guild B resolves
 *     to the SAME generic 404 bytes as an unknown id (resource-level no
 *     enumeration), guild-B row untouched, zero audit.
 *  H. CLOSE — the slash's OWN softCloseTicket (args recorded): row
 *     transition committed (WHERE status='open'), close_reason, closed_by,
 *     archived stays 0, requester DM via cache, close notice in channel;
 *     uncached channel ⇒ the helper's OWN degraded path (transition
 *     committed, permission/notice skipped as warnings) — the flash claims
 *     only the close transition. staff_note add-on NOT in the web surface
 *     (delta (4)): zero staff_notes rows.
 *  I. SUMMARIZE GUARDS — sensitive ⇒ generic 404 BEFORE any message/AI
 *     read (delta (2)); archived ⇒ ticket_archived; no AI key ⇒
 *     ai_not_configured with ZERO summarize calls (delta (3)); empty
 *     stored rows ⇒ messages_unavailable and NEVER a channel fetch;
 *     happy regen through the slash's OWN summarizeTicket args
 *     (ticket, messages, {}) — audit tickets.summarize shape, done slug by
 *     source, ai_summary_json NOT persisted (slash on-demand persists
 *     nothing); soft-closed (pre-archive) ticket allowed, mirroring
 *     slash status:"any".
 *  J. FAIL-CLOSED — insertAdminAudit throwing ⇒ generic 500, no Location,
 *     no audit row, no mirror (the committed service row is the same
 *     documented contract as moderation/xp: the outcome is never silently
 *     CLAIMED via redirect).
 *  K. SLASH↔WEB PARITY (§8.11) — the REAL handleTicket sub-commands on the
 *     same DB with the SAME actor id: equal tickets-table state, equal
 *     ticket_staff owners, audit rows with identical action/target_type/
 *     actor and DEEP-EQUAL details (only origin differs: 'web' vs
 *     'slash'); summarize parity runs the REAL summarizeTicket on both
 *     transports (no AI key ⇒ identical stats fallback on both sides).
 *
 * Fully offline. Sentinel secrets are clearly fake (AGENTS.md).
 * Runtime ≪ 60s.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// loadDb FIRST: fresh SQLite + src require-cache reset; every require below
// binds to that DB (gate boot discipline).
const { api, tmpDir } = loadDb();

const harness = require("./helpers/access-matrix");
const guildAccessMod = require("../src/web/auth/guildAccess");
const sessionPolicy = require("../src/web/auth/sessions");
const tokens = require("../src/web/auth/tokens");
const csrfMod = require("../src/web/middleware/csrf");
const { bindAuditClient } = require("../src/web/middleware/audit");
const auditLogMod = require("../src/features/logs/auditLog");
const dbFacade = require("../src/db");
const ticketRoutes = require("../src/web/routes/ticketActions");
// ⚠ createWebApp + features/tickets are required ONLY AFTER the facade
// recorder is installed (below): the ticket feature chain
// (routes/transcripts → features/tickets → close.js) DESTRUCTURES its db
// helpers at load time, and only a post-install load binds the recorder's
// wrappers (close.js's markTicketClosed then lands in the windows — the
// deep-parity evidence suite H asserts).

// ---------------------------------------------------------------------------
// Clearly-fake sentinels / placeholders ONLY (AGENTS.md: never realistic).
// ---------------------------------------------------------------------------
const SESSION_SECRET = "test-ticket-actions-sentinel-secret-NOT-REAL-030";

const GUILD_A = "360000000000000001"; // bot + every test user
const GUILD_B = "360000000000000002"; // bot guild the users are NOT in

const USER_ADMIN = "488190112345678901"; // owner snapshot ⇒ tier admin
const USER_JUNIOR = "488190112345678902"; // junior staff role ⇒ tier staff
const USER_SENIOR = "488190112345678903"; // senior staff role ⇒ tier senior
const USER_PLAIN = "488190112345678904"; // guild-A member, no staff role
const USER_STRANGER = "488190112345678905"; // member of NOTHING
const BOT_ID = "999000000000000001";

// Tier-resolution roles (NOT snowflake-shaped — gate trick).
const ROLE_JUNIOR_TIER = "role-junior-staff";
const ROLE_SENIOR_TIER = "role-senior-staff";

const PAGE_PATH = `/g/${GUILD_A}/tickets`;
const CLAIM_PATH = `/g/${GUILD_A}/tickets/claim`;
const CLOSE_PATH = `/g/${GUILD_A}/tickets/close`;
const SUM_PATH = `/g/${GUILD_A}/tickets/summarize`;

const PAGE_TEMPLATE = "/g/:guildId/tickets";
const CLAIM_TEMPLATE = "/g/:guildId/tickets/claim";
const CLOSE_TEMPLATE = "/g/:guildId/tickets/close";
const SUM_TEMPLATE = "/g/:guildId/tickets/summarize";

const ENV_KEYS = [
  "SESSION_SECRET",
  "DB_PATH",
  "DATA_DIR",
  "CLIENT_ID",
  "CLIENT_SECRET",
  "PUBLIC_HTTP_PORT",
  "TICKET_HTTP_PORT",
  "PUBLIC_BASE_URL",
  "TICKET_PUBLIC_BASE_URL",
  "WEB_RATE_LIMIT_MUTATION_MAX",
  "WEB_TIER_CACHE_TTL_MS",
  "AI_API_KEY",
  "OPENAI_API_KEY",
];

// ---------------------------------------------------------------------------
// Fake Discord transport under the REAL resolver (gate boot pattern)
// ---------------------------------------------------------------------------

function userOf(token) {
  return String(token).replace(/^tok-/, "");
}

const fakeDiscord = {
  async getUserGuilds(token) {
    const userId = userOf(token);
    if (userId === USER_ADMIN) {
      return [{ id: GUILD_A, name: "Alpha HQ", icon: null, owner: true, permissions: "0" }];
    }
    if (userId === USER_JUNIOR || userId === USER_SENIOR || userId === USER_PLAIN) {
      return [{ id: GUILD_A, name: "Alpha HQ", icon: null, owner: false, permissions: "0" }];
    }
    return []; // stranger: member of NOTHING ⇒ generic 404 everywhere
  },
  async getUserGuildMember(token, guildId) {
    const userId = userOf(token);
    if (guildId !== GUILD_A) {
      const err = new Error("Unknown Guild");
      err.status = 404;
      throw err;
    }
    if (userId === USER_JUNIOR) return { roles: [ROLE_JUNIOR_TIER] };
    if (userId === USER_SENIOR) return { roles: [ROLE_SENIOR_TIER] };
    return { roles: [] };
  },
};

// ---------------------------------------------------------------------------
// Fake discord.js client — CACHE-ONLY surfaces. Network methods a request
// path might try are ABSENT, so a fetch would crash instead of silently
// leaving the process (the cache-only seam contract, subtask 28/29 doctrine).
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} userId → user mock (with a .send spy) */
const usersCache = new Map();
/** @type {Map<string, object>} channelId → channel mock */
const channelsCache = new Map();
/** Every DM payload attempted: { to, payload }. */
const dmLog = [];
/** Every in-channel payload posted: { channelId, payload }. */
const channelLog = [];

function makeCacheUser(userId, { bot = false, dm = true } = {}) {
  const user = { id: userId, username: `u${userId.slice(-3)}`, tag: `u${userId.slice(-3)}#0001`, bot };
  if (dm) {
    user.send = async (payload) => {
      dmLog.push({ to: userId, payload });
      return { id: `dm-${dmLog.length}` };
    };
  }
  return user;
}

/** Channel mock with spies; passable to BOTH transports (slash receives it
 * as interaction.channel, the web reads it from the same cache). */
function makeCacheChannel(channelId, { overwritesFail = false } = {}) {
  const channel = {
    id: channelId,
    guild: FAKE_GUILD,
    messages: undefined, // NO .messages.fetch — a web fetch attempt CRASHES.
    permissionOverwrites: {
      set: async (list) => {
        if (overwritesFail) throw new Error("Missing Permissions");
        channelLog.push({ channelId, kind: "overwrites", payload: list });
      },
      edit: async () => {
        if (overwritesFail) throw new Error("Missing Permissions");
      },
    },
    send: async (payload) => {
      channelLog.push({ channelId, kind: "send", payload });
      return { id: `msg-${channelLog.length}` };
    },
  };
  channelsCache.set(channelId, channel);
  return channel;
}

const BOT_MEMBER = { id: BOT_ID, roles: { highest: { position: 100 } } };

const FAKE_GUILD = {
  id: GUILD_A,
  name: "Alpha HQ",
  me: undefined,
  members: { me: BOT_MEMBER, cache: new Map([[BOT_ID, BOT_MEMBER]]) }, // NO members.fetch.
  roles: { cache: new Map() },
};

const FAKE_CLIENT = {
  user: { id: BOT_ID, username: "bot" },
  guilds: { cache: { get: (id) => (id === GUILD_A ? FAKE_GUILD : undefined) } },
  users: { cache: usersCache }, // NO users.fetch — cache-only DM seam.
  channels: { cache: { get: (id) => channelsCache.get(id) } }, // NO channels.fetch.
};

// ---------------------------------------------------------------------------
// SERVICE-LAYER counting proxy on the SHARED src/db facade object (gate
// pattern). Installed BEFORE createWebApp so the audit middleware captures
// the wrapped insertAdminAudit, and the route + the lazily-loaded
// features/tickets/close.js bind THE WRAPPED helpers: every service write
// lands in this recorder — proof nothing bypasses the service layer.
// ---------------------------------------------------------------------------

const WATCH = new Set([
  "claimTicket",
  "markTicketClosed",
  "getTicketById",
  "getTicketByChannel",
  "listTicketMessages",
  "listOpenTickets",
  "listTicketStaff",
  "insertAdminAudit",
]);

/** DB-mutating watched helpers — every refusal must call ZERO of these. */
const WRITE_HELPERS = new Set(["claimTicket", "markTicketClosed", "insertAdminAudit"]);

const recorder = { active: false, log: [], auditThrow: false };

function installFacadeRecorder(F) {
  const originals = {};
  for (const name of WATCH) {
    if (typeof F[name] !== "function") {
      throw new Error(`ticket-actions precondition: facade helper "${name}" missing (renamed?)`);
    }
    originals[name] = F[name];
    F[name] = function recorded(...args) {
      if (recorder.active) recorder.log.push({ name, args });
      if (name === "insertAdminAudit" && recorder.auditThrow) {
        const err = new Error("admin_audit insert failed (ticket-actions injection)");
        err.code = "TICKET_AUDIT_INJECT";
        throw err;
      }
      return originals[name].apply(this, args);
    };
  }
  return function restore() {
    for (const name of WATCH) F[name] = originals[name];
  };
}

const restoreFacadeRecorder = installFacadeRecorder(dbFacade);

// Post-install loads (see the ⚠ note above): the app chain and the ticket
// feature chain now bind the WRAPPED facade helpers.
const { createWebApp } = require("../src/web/app");
const { ticket: handleTicket } = require("../src/features/tickets").handlers;

function startWindow() {
  recorder.log = [];
  recorder.active = true;
}
function stopWindow() {
  recorder.active = false;
  return recorder.log.slice();
}
const writeCalls = (log) => log.filter((c) => WRITE_HELPERS.has(c.name));
const namesOf = (log) => log.map((c) => c.name);

// ---------------------------------------------------------------------------
// Service-seam call-through spies (options.services): record the EXACT args
// the web route passes to the slash's OWN helpers, then DELEGATE to the real
// modules (lazy require at CALL time — after the recorder is installed, so
// close.js binds the wrapped markTicketClosed too).
// ---------------------------------------------------------------------------
const softCloseCalls = [];
const overwritesCalls = [];
const summarizeCalls = [];
let summarizeImpl = null; // per-test override; null ⇒ the REAL summarizer
let aiFlag = true; // options.ticketActions.isAiConfigured seam

// ---------------------------------------------------------------------------
// Mirror spy (§8.1-7): the three slash ticket handlers post NO channel
// mirror (no logConfigChange) — so neither may the web. Swapping the
// posters + binding the fake proves NOTHING dispatched.
// ---------------------------------------------------------------------------
const mirrorSpy = { log: [], sendAudit: null, sendWarn: null };
function installMirrorSpy() {
  mirrorSpy.sendAudit = auditLogMod.sendAuditLog;
  mirrorSpy.sendWarn = auditLogMod.sendWarnLog;
  auditLogMod.sendAuditLog = (...args) => {
    mirrorSpy.log.push({ kind: "audit", args });
    return Promise.resolve(true);
  };
  auditLogMod.sendWarnLog = (...args) => {
    mirrorSpy.log.push({ kind: "warn", args });
    return Promise.resolve(true);
  };
  bindAuditClient(FAKE_CLIENT);
}
function restoreMirrorSpy() {
  auditLogMod.sendAuditLog = mirrorSpy.sendAudit;
  auditLogMod.sendWarnLog = mirrorSpy.sendWarn;
  bindAuditClient(null);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// ---------------------------------------------------------------------------
// Synchronous boot: env → tier rows → sessions → spies → APP → SERVER.
// ---------------------------------------------------------------------------
const savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
process.env.SESSION_SECRET = SESSION_SECRET;
for (const k of ENV_KEYS) {
  if (k === "SESSION_SECRET") continue;
  delete process.env[k];
}
process.env.WEB_RATE_LIMIT_MUTATION_MAX = "1000000"; // scripted probes, not humans

api.addStaffRole(GUILD_A, ROLE_JUNIOR_TIER, "junior");
api.addStaffRole(GUILD_A, ROLE_SENIOR_TIER, "senior");

const cookieOf = {};
const csrfOf = {};
const sessionIdOf = {};

function mkSession(userKey, userId) {
  const id = harness.createLoginSession({ api, sessionPolicy, tokens }, userId, {
    token: `tok-${userId}`,
  });
  cookieOf[userKey] = `web_session=${id}`;
  sessionIdOf[userKey] = id;
  csrfOf[userKey] = csrfMod.deriveCsrfToken(id, SESSION_SECRET);
}

mkSession("admin", USER_ADMIN);
mkSession("junior", USER_JUNIOR);
mkSession("senior", USER_SENIOR);
mkSession("plain", USER_PLAIN);
mkSession("stranger", USER_STRANGER);

installMirrorSpy();

const resolver = guildAccessMod.createGuildAccessResolver({
  discord: fakeDiscord,
  botGuilds: async () => [GUILD_A, GUILD_B],
  now: Date.now,
  ttlMs: 3_600_000,
});

const app = createWebApp({
  guildAccess: resolver,
  botGuilds: async () => [GUILD_A, GUILD_B],
  getClient: () => FAKE_CLIENT,
  services: {
    softCloseTicket: async (...args) => {
      softCloseCalls.push(args);
      const { softCloseTicket } = require("../src/features/tickets/close");
      return softCloseTicket(...args);
    },
    applyTicketOverwrites: async (...args) => {
      overwritesCalls.push(args);
      const { applyTicketOverwrites } = require("../src/features/tickets/overwrites");
      return applyTicketOverwrites(...args);
    },
  },
  ticketActions: {
    summarizeTicket: async (...args) => {
      summarizeCalls.push(args);
      if (summarizeImpl) return summarizeImpl(...args);
      const { summarizeTicket } = require("../src/features/tickets/summary");
      return summarizeTicket(...args);
    },
    isAiConfigured: () => aiFlag,
  },
});

/** @type {string} resolved in before(). */
let baseUrl = "";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** urlencoded POST (real form semantics, redirect:manual). */
async function post(path, { cookie, fields } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields || {}).toString(),
  });
  const body = await res.text();
  return { res, body, location: res.headers.get("location") };
}

const claimPost = (fields, key = "senior") =>
  post(CLAIM_PATH, { cookie: cookieOf[key], fields: { ...fields, _csrf: csrfOf[key] } });
const closePost = (fields, key = "senior") =>
  post(CLOSE_PATH, { cookie: cookieOf[key], fields: { ...fields, _csrf: csrfOf[key] } });
const sumPost = (fields, key = "senior") =>
  post(SUM_PATH, { cookie: cookieOf[key], fields: { ...fields, _csrf: csrfOf[key] } });

// ---------------------------------------------------------------------------
// DB readers / seed helpers
// ---------------------------------------------------------------------------

function auditRows(origin) {
  return api.listAdminAudit(GUILD_A, { origin, limit: 200 }).map((r) => ({
    ...r,
    details: r.details_json ? JSON.parse(r.details_json) : null,
  }));
}
const webAuditCount = () => api.countAdminAudit(GUILD_A, { origin: "web" });
const rowsOf = (origin, action) => auditRows(origin).filter((r) => r.action === action);

/** Deterministic ticket ids: reset the AUTOINCREMENT counter before seeds. */
function purgeTickets() {
  api.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'tickets'").run();
}

/**
 * Seed an OPEN ticket. channelId null ⇒ the degraded-path shape.
 * @returns {object} the created row.
 */
function mkTicket({ guildId = GUILD_A, creator, channelId = null, reason = "seed", staffOwner = null } = {}) {
  return api.createTicket({
    guildId,
    creatorUserId: creator,
    channelId,
    reason,
    ...(staffOwner ? { staffOwner } : {}),
  });
}

const ticketCount = () => api.db.prepare("SELECT COUNT(*) AS n FROM tickets").get().n;
const staffNoteCount = () => api.db.prepare("SELECT COUNT(*) AS n FROM staff_notes").get().n;

function lastAuditFor(action, targetId, origin = "web") {
  return auditRows(origin)
    .filter((r) => r.action === action && r.target_id === String(targetId))
    .sort((a, b) => b.id - a.id)[0];
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
before(async () => {
  const httpServer = http.createServer(app);
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  app.__httpServer = httpServer;
});

after(() => {
  const httpServer = app.__httpServer;
  if (httpServer) {
    httpServer.closeAllConnections?.();
    httpServer.close();
  }
  restoreMirrorSpy();
  restoreFacadeRecorder();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ===========================================================================
// A. MUTATION CONTRACT — registry ↔ mounted route lockstep (Phase-2 doctrine)
// ===========================================================================
describe("A. mutation registry lockstep (registerWebMutation ↔ app.post)", () => {
  const TEMPLATES = [CLAIM_TEMPLATE, CLOSE_TEMPLATE, SUM_TEMPLATE];

  it("route module exports the page + three mutation templates (one constant each)", () => {
    assert.equal(ticketRoutes.ACTIONS_PAGE, PAGE_TEMPLATE);
    assert.equal(ticketRoutes.CLAIM_PATH, CLAIM_TEMPLATE);
    assert.equal(ticketRoutes.CLOSE_PATH, CLOSE_TEMPLATE);
    assert.equal(ticketRoutes.SUMMARIZE_PATH, SUM_TEMPLATE);
  });

  it("exactly one registry entry per ticket mutation, /g/:guildId-scoped POSTs", () => {
    for (const template of TEMPLATES) {
      const entries = app.locals.webMutations.filter(
        (m) => m.method === "POST" && m.path === template
      );
      assert.equal(entries.length, 1, `exactly one registration for ${template}`);
    }
    const ticketRegs = app.locals.webMutations.filter((m) =>
      m.path.startsWith("/g/:guildId/tickets")
    );
    assert.deepEqual(
      ticketRegs.map((m) => m.path).sort(),
      [...TEMPLATES].sort(),
      "no other /tickets mutation sneaked in (GET page is not a mutation)"
    );
  });

  it("the mounted POST route templates equal the registry templates (one template constant)", () => {
    const router = app.router || app._router;
    const mounted = [];
    for (const layer of router.stack) {
      const route = layer && layer.route;
      if (!route || !route.methods || route.methods.post !== true) continue;
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      mounted.push(...paths);
    }
    for (const template of TEMPLATES) {
      assert.ok(
        mounted.includes(template),
        `app.post(${template}) mounted with the SAME template the registry carries`
      );
    }
  });

  it("the ticket id is a BODY field (methodGate matches :guildId only — no :id templates)", () => {
    for (const template of [...TEMPLATES, PAGE_TEMPLATE]) {
      const paramSegs = template.split("/").filter((seg) => seg.startsWith(":"));
      assert.deepEqual(
        paramSegs,
        [":guildId"],
        `${template}: :guildId is the ONLY param segment (app.js matchesMutationPath)`
      );
    }
    // Row-id (not T-number) field-shape evidence (route header): slash
    // carries ticket.id internally, audit targetId is String(ticket.id).
    assert.deepEqual(ticketRoutes.parseTicketIdField({ ticket_id: "42" }), { ok: true, ticketId: 42 });
    for (const bad of ["", "0", "007", "1.5", "T-7", " 7x", "-7", "7".repeat(13)]) {
      assert.deepEqual(
        ticketRoutes.parseTicketIdField({ ticket_id: bad }),
        { ok: false, errorSlug: "invalid_ticket_id" },
        `rejects ${JSON.stringify(bad)}`
      );
    }
  });
});

// ===========================================================================
// B. ACTIONS PAGE + FLASH (GET) — senior-only form surface, slugs only
// ===========================================================================
describe("B. GET actions page — senior-only forms + whitelisted-only flash", () => {
  it("anon GET ⇒ 302 login", async () => {
    await harness.runOutcome({
      base: baseUrl,
      url: PAGE_PATH,
      method: "GET",
      cookieId: null,
      expect: harness.expectLoginRedirect(`/auth/login?guild=${GUILD_A}`),
      label: "anon actions page",
    });
  });

  it("junior (staff tier) ⇒ 403 — the §8.6 senior-only surface (delta (1))", async () => {
    await harness.runOutcome({
      base: baseUrl,
      url: PAGE_PATH,
      method: "GET",
      cookieId: sessionIdOf.junior,
      expect: harness.expectForbidden(),
      label: "junior actions page",
    });
  });

  it("senior/admin ⇒ forms rendered with _csrf + the field contract", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, channelId: null, reason: "broken thing" });
    usersCache.set(USER_PLAIN, makeCacheUser(USER_PLAIN, { dm: false }));
    for (const key of ["senior", "admin"]) {
      const w = await harness.request(baseUrl, PAGE_PATH, { cookieId: sessionIdOf[key] });
      assert.equal(w.status, 200, `actions page via ${key}`);
      assert.ok(w.body.includes(harness.SHELL_MARKER), "renders inside the guild shell");
      assert.ok(w.body.includes("<h1>Ticket actions</h1>"), "page heading");
      assert.ok(w.body.includes(`action="${CLAIM_PATH}"`), "claim form posts to the exact mutation path");
      assert.ok(w.body.includes(`action="${CLOSE_PATH}"`), "close form posts to the exact mutation path");
      assert.ok(w.body.includes(`action="${SUM_PATH}"`), "summarize form posts to the exact mutation path");
      for (const field of ['name="ticket_id"', 'name="reason"', 'name="_csrf"']) {
        assert.ok(w.body.includes(field), `form field ${field}`);
      }
      assert.ok(w.body.includes(csrfOf[key]), "embedded _csrf equals the session-derived token");
      assert.ok(w.body.includes(`value="${t.id}"`), "row id offered as the ticket_id control");
      assert.ok(w.body.includes("<td>#1</td>"), "human #1 ticket ref (theme formatTicketRef) rendered alongside");
    }
    // junior form must not exist to be clicked — page itself is 403 (above).
  });

  it("PRG flash renders ONLY whitelisted slugs — hostile values never echo; foreign slugs invisible", async () => {
    const hostile = encodeURIComponent('<script>alert("tick-x")</script>');
    const junk = await harness.request(
      baseUrl,
      `${PAGE_PATH}?error=${hostile}&done=bogus&note=bogus`,
      { cookieId: sessionIdOf.senior }
    );
    assert.equal(junk.status, 200);
    assert.ok(!junk.body.includes("tick-x"), "hostile flash value never echoed (§8.7)");
    assert.ok(!junk.body.includes("banner-"), "unknown slugs render NO banner");

    const known = await harness.request(
      baseUrl,
      `${PAGE_PATH}?error=ticket_not_open`,
      { cookieId: sessionIdOf.senior }
    );
    assert.ok(known.body.includes("banner-"), "the whitelisted slug renders its fixed banner");

    // Cross-page vocabulary isolation: warnings-page slugs stay invisible here.
    const foreign = await harness.request(
      baseUrl,
      `${PAGE_PATH}?done=warn_issued&error=already_voided`,
      { cookieId: sessionIdOf.senior }
    );
    assert.ok(!foreign.body.includes("banner-"), "foreign slugs stay invisible");

    // Every done slug in the frozen vocabulary renders its banner.
    for (const slug of ["ticket_claimed", "ticket_closed", "summary_ai", "summary_fallback"]) {
      const ok = await harness.request(baseUrl, `${PAGE_PATH}?done=${slug}`, { cookieId: sessionIdOf.senior });
      assert.ok(ok.body.includes("banner-"), `done slug ${slug} renders`);
    }
    for (const slug of [
      "invalid_ticket_id",
      "ticket_not_found",
      "ticket_not_open",
      "close_reason_too_long",
      "ticket_archived",
      "ai_not_configured",
      "messages_unavailable",
    ]) {
      const err = await harness.request(baseUrl, `${PAGE_PATH}?error=${slug}`, { cookieId: sessionIdOf.senior });
      assert.ok(err.body.includes("banner-"), `error slug ${slug} renders`);
    }
  });
});

// ===========================================================================
// C. POST TIER LADDER — §8.6 cross-cutting matrix on all three mutations
// ===========================================================================
describe("C. POST tier ladder — anon 302 · stranger/plain/cross 404 · junior 403", () => {
  const ALL = [
    ["claim", CLAIM_PATH],
    ["close", CLOSE_PATH],
    ["summarize", SUM_PATH],
  ];
  const probeFields = (t) => ({ ticket_id: String(t.id), reason: "probe" });

  for (const [label, path] of ALL) {
    it(`${label}: anon POST ⇒ 302 login, NOTHING mutated`, async () => {
      await harness.runOutcome({
        base: baseUrl,
        url: path,
        method: "POST",
        cookieId: null,
        expect: harness.expectLoginRedirect(`/auth/login?guild=${GUILD_A}`),
        label: `anon ${label} POST`,
      });
    });

    it(`${label}: stranger / plain / cross-guild with VALID csrf ⇒ the SAME generic 404 bytes`, async () => {
      const t = mkTicket({ creator: USER_PLAIN, reason: "ladder" });
      const before = { tickets: ticketCount(), audit: webAuditCount() };
      for (const key of ["stranger", "plain"]) {
        const { res, body } = await post(path, {
          cookie: cookieOf[key],
          fields: { ...probeFields(t), _csrf: csrfOf[key] },
        });
        assert.equal(res.status, 404, `${label} via ${key}`);
        assert.equal(body, "Not found");
        assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
      }
      const cross = await post(path.replace(GUILD_A, GUILD_B), {
        cookie: cookieOf.admin,
        fields: { ...probeFields(t), _csrf: csrfOf.admin },
      });
      assert.equal(cross.res.status, 404, `${label} cross-guild never resolves (§8.6)`);
      assert.equal(cross.body, "Not found");
      assert.equal(ticketCount(), before.tickets, `${label}: denials wrote nothing`);
      assert.equal(webAuditCount(), before.audit, `${label}: denials audited nothing`);
      assert.equal(api.getTicketById(t.id).staff_owner_id, null, `${label}: row untouched`);
    });

    it(`${label}: JUNIOR staff with valid csrf ⇒ 403 and ZERO service calls (delta (1))`, async () => {
      const t = mkTicket({ creator: USER_PLAIN, reason: "junior probe" });
      const before = webAuditCount();
      startWindow();
      const { res, body } = await post(path, {
        cookie: cookieOf.junior,
        fields: { ...probeFields(t), _csrf: csrfOf.junior },
      });
      const calls = stopWindow();
      assert.equal(res.status, 403, `${label}: junior denied (senior-only)`);
      assert.equal(body, "Forbidden");
      assert.deepEqual(calls, [], `${label}: denial never reached the service layer`);
      assert.equal(webAuditCount(), before);
      const row = api.getTicketById(t.id);
      assert.equal(row.status, "open");
      assert.equal(row.staff_owner_id, null);
    });
  }

  it("senior + admin both pass the gate (claim smoke on two fresh rows)", async () => {
    for (const key of ["senior", "admin"]) {
      const t = mkTicket({ creator: USER_PLAIN, reason: "gate pass" });
      const r = await claimPost({ ticket_id: String(t.id) }, key);
      assert.equal(r.res.status, 302);
      assert.equal(api.getTicketById(t.id).staff_owner_id, { senior: USER_SENIOR, admin: USER_ADMIN }[key]);
    }
  });
});

// ===========================================================================
// D. CSRF — the gate before the router (§8.7)
// ===========================================================================
describe("D. CSRF — missing/tampered ⇒ 403 with ZERO facade calls and ZERO rows", () => {
  const probes = [
    ["claim", CLAIM_PATH],
    ["close", CLOSE_PATH],
    ["summarize", SUM_PATH],
  ];

  for (const [label, path] of probes) {
    it(`${label}: missing _csrf ⇒ 403, no facade call at all`, async () => {
      const t = mkTicket({ creator: USER_PLAIN, reason: "csrf probe" });
      const before = webAuditCount();
      startWindow();
      const { res, body } = await post(path, {
        cookie: cookieOf.senior,
        fields: { ticket_id: String(t.id) },
      });
      const calls = stopWindow();
      assert.equal(res.status, 403, label);
      assert.equal(body, "Forbidden", label);
      assert.deepEqual(calls, [], `${label}: CSRF denial never reached the service layer`);
      assert.equal(webAuditCount(), before);
      const row = api.getTicketById(t.id);
      assert.equal(row.status, "open");
      assert.equal(row.staff_owner_id, null);
    });

    it(`${label}: tampered _csrf ⇒ 403, same zero-everything`, async () => {
      const t = mkTicket({ creator: USER_PLAIN, reason: "csrf probe" });
      const before = webAuditCount();
      startWindow();
      const { res } = await post(path, {
        cookie: cookieOf.senior,
        fields: { ticket_id: String(t.id), _csrf: "f".repeat(64) },
      });
      const calls = stopWindow();
      assert.equal(res.status, 403, label);
      assert.deepEqual(calls, []);
      assert.equal(webAuditCount(), before);
    });
  }
});

// ===========================================================================
// E. CLAIM — slash twin through the facade recorder (args, rows, audit)
// ===========================================================================
describe("E. claim — service parity through the facade recorder", () => {
  it("happy claim (cached channel): helper args, row, ticket_staff, audit shape, cache-only notice", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, channelId: "710000000000000001", reason: "claim me" });
    makeCacheChannel(t.channel_id);
    const before = webAuditCount();
    const dmBefore = dmLog.length;
    const chanBefore = channelLog.length;
    softCloseCalls.length = 0;
    overwritesCalls.length = 0;

    startWindow();
    const r = await claimPost({ ticket_id: String(t.id) });
    const log = stopWindow();
    assert.equal(r.res.status, 302);
    assert.equal(r.location, `${PAGE_PATH}?done=ticket_claimed`);

    // Helper parity: load via getTicketById, claim via the VERY slash helper.
    const names = namesOf(log);
    assert.ok(names.includes("getTicketById"), "ticket loaded through the facade");
    assert.ok(names.includes("claimTicket"), "claim ran through facade.claimTicket (zero route SQL)");
    assert.deepEqual(log.find((c) => c.name === "claimTicket").args, [t.id, USER_SENIOR]);
    assert.ok(names.includes("insertAdminAudit"), "one audit insert through the facade");

    const row = api.getTicketById(t.id);
    assert.equal(row.staff_owner_id, USER_SENIOR);
    assert.equal(row.status, "open", "claim does not touch status");
    const staff = api.listTicketStaff(t.id);
    assert.equal(staff.find((s) => s.user_id === USER_SENIOR).is_owner, 1);

    // Audit: EXACT slash detail shape (index.js:1651-1661), origin web.
    const audit = lastAuditFor("tickets.claim", t.id);
    assert.ok(audit, "one tickets.claim web audit row");
    assert.equal(audit.origin, "web");
    assert.equal(audit.actor_user_id, USER_SENIOR);
    assert.equal(audit.target_type, "ticket");
    assert.deepEqual(audit.details, {
      ticket_number: row.ticket_number,
      previous_owner: null,
      staff_owner_id: USER_SENIOR,
    });

    // Cache-only channel notice (slash:1678-1682) + best-effort overwrites.
    await tick();
    const chan = channelLog.slice(chanBefore);
    assert.ok(
      chan.some((e) => e.channelId === t.channel_id && e.kind === "send" && String(e.payload).includes("claimed this ticket")),
      "channel notice posted via cache"
    );
    assert.equal(overwritesCalls.length, 1, "best-effort overwrite pass ran once");
    assert.equal(dmLog.length, dmBefore, "claim DMs NOBODY (slash does not either)");
    assert.equal(mirrorSpy.log.length, 0, "claim mirrors NO channel embed");
    assert.equal(webAuditCount(), before + 1);
  });

  it("uncached channel ⇒ graceful skip (slash's own null-channel path), claim still lands", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, channelId: "719999999999999999", reason: "uncached chan" });
    const chanBefore = channelLog.length;
    const r = await claimPost({ ticket_id: String(t.id) });
    assert.equal(r.res.status, 302);
    assert.equal(r.location, `${PAGE_PATH}?done=ticket_claimed`);
    assert.equal(api.getTicketById(t.id).staff_owner_id, USER_SENIOR);
    await tick();
    assert.equal(
      channelLog.slice(chanBefore).filter((e) => e.channelId === t.channel_id).length,
      0,
      "no fabricated channel activity for an uncached channel"
    );
    assert.ok(lastAuditFor("tickets.claim", t.id), "audit still recorded (DB-first)");
  });

  it("idempotent TAKEOVER (slash rule: NO already-claimed refusal)", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, reason: "hand-off" });
    const r1 = await claimPost({ ticket_id: String(t.id) }, "senior");
    assert.equal(r1.location, `${PAGE_PATH}?done=ticket_claimed`);
    const r2 = await claimPost({ ticket_id: String(t.id) }, "admin");
    assert.equal(r2.res.status, 302, "takeover is a SUCCESS, not a refusal");
    assert.equal(r2.location, `${PAGE_PATH}?done=ticket_claimed`);

    const row = api.getTicketById(t.id);
    assert.equal(row.staff_owner_id, USER_ADMIN);
    const staff = api.listTicketStaff(t.id);
    assert.equal(staff.find((s) => s.user_id === USER_SENIOR).is_owner, 0, "old owner demoted");
    assert.equal(staff.find((s) => s.user_id === USER_ADMIN).is_owner, 1, "new owner promoted");

    const audits = auditRows("web")
      .filter((x) => x.action === "tickets.claim" && x.target_id === String(t.id))
      .sort((a, b) => a.id - b.id);
    assert.equal(audits.length, 2);
    assert.equal(audits[1].details.previous_owner, USER_SENIOR, "hand-off recorded in audit");
    assert.equal(audits[1].details.staff_owner_id, USER_ADMIN);
  });
});

// ===========================================================================
// F. VALIDATION / STATUS — slash rules mirrored with ZERO writes
// ===========================================================================
describe("F. validation — every refusal is a whitelisted-slug 302 with zero writes", () => {
  it("claim/close on a NON-OPEN ticket ⇒ ticket_not_open, zero write helpers", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, reason: "already closed" });
    api.claimTicket(t.id, USER_SENIOR);
    api.markTicketClosed(t.id, { closedBy: USER_SENIOR, closeReason: "manual" });

    for (const [label, send] of [
      ["claim", () => claimPost({ ticket_id: String(t.id) })],
      ["close", () => closePost({ ticket_id: String(t.id), reason: "again?" })],
    ]) {
      const before = webAuditCount();
      startWindow();
      const r = await send();
      const log = stopWindow();
      assert.equal(r.location, `${PAGE_PATH}?error=ticket_not_open`, label);
      assert.deepEqual(
        writeCalls(log),
        [],
        `${label}: slash requireOpenTicketChannel enforced BEFORE any write helper`
      );
      assert.equal(webAuditCount(), before);
    }
    // summarize on the same soft-closed ticket is LEGAL (slash status:"any")
    // — asserted in suite I; only claim/close refuse non-open here.
  });

  it("invalid ticket_id field shapes ⇒ invalid_ticket_id, zero facade calls at all", async () => {
    for (const bad of ["", "abc", "0", "1.5", "T-3", "999999999999999999999"]) {
      const before = webAuditCount();
      startWindow();
      const r = await claimPost({ ticket_id: bad });
      const log = stopWindow();
      assert.equal(r.location, `${PAGE_PATH}?error=invalid_ticket_id`, `field ${JSON.stringify(bad)}`);
      assert.deepEqual(log, [], "parse refuses BEFORE even loading the row");
      assert.equal(webAuditCount(), before);
    }
  });

  it("close reason over MAX_TICKET_REASON ⇒ close_reason_too_long, softClose NEVER called", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, reason: "long reason probe" });
    const callsBefore = softCloseCalls.length;
    startWindow();
    const r = await closePost({ ticket_id: String(t.id), reason: "x".repeat(1001) });
    const log = stopWindow();
    assert.equal(r.location, `${PAGE_PATH}?error=close_reason_too_long`);
    assert.deepEqual(writeCalls(log), []);
    assert.equal(softCloseCalls.length, callsBefore, "bound pre-validated — helper never invoked");
    assert.equal(api.getTicketById(t.id).status, "open");
  });

  it("Location is ALWAYS the actions page with a frozen slug only (no echo, ever)", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, reason: "prg probe" });
    const evil = encodeURIComponent('x&done=pwned<script>');
    const locs = [];
    locs.push((await claimPost({ ticket_id: "999999" })).location); // unknown id ⇒ 404 not a redirect
    locs.push((await claimPost({ ticket_id: String(t.id) })).location);
    locs.push((await closePost({ ticket_id: String(t.id), reason: evil })).location);
    const allowed = new Set([
      "ticket_claimed",
      "ticket_closed",
      "summary_ai",
      "summary_fallback",
      "invalid_ticket_id",
      "ticket_not_found",
      "ticket_not_open",
      "close_reason_too_long",
      "ticket_archived",
      "ai_not_configured",
      "messages_unavailable",
    ]);
    for (const loc of locs.filter(Boolean)) {
      assert.match(loc, /^\/g\/360000000000000001\/tickets\?(done|error)=[a-z_]+$/, `PRG shape: ${loc}`);
      const slug = loc.split("=")[1];
      assert.ok(allowed.has(slug), `slug ${slug} is a frozen constant`);
    }
    const closed = api.getTicketById(t.id);
    assert.equal(closed.status, "closed");
    assert.equal(closed.close_reason, evil, "stored value (DB) — never echoed into the redirect");
  });
});

// ===========================================================================
// G. CROSS-GUILD TICKET — resource-level no-enumeration
// ===========================================================================
describe("G. foreign-guild ticket id ⇒ the SAME generic 404 bytes, zero side effects", () => {
  it("a ticket that exists ONLY in guild B is indistinguishable from unknown", async () => {
    const tB = api.createTicket({
      guildId: GUILD_B,
      creatorUserId: "555000000000000001",
      channelId: "720000000000000001",
      reason: "guild B row",
    });
    const auditBefore = { web: webAuditCount(), b: api.countAdminAudit(GUILD_B, {}) };
    const snapshot = { ...api.getTicketById(tB.id) };

    for (const send of [
      () => claimPost({ ticket_id: String(tB.id) }),
      () => closePost({ ticket_id: String(tB.id), reason: "nope" }),
      () => sumPost({ ticket_id: String(tB.id) }),
    ]) {
      startWindow();
      const { res, body } = await send();
      const log = stopWindow();
      assert.equal(res.status, 404, "foreign row id ⇒ generic 404 (§8.6 no-enumeration)");
      assert.equal(body, "Not found");
      assert.deepEqual(writeCalls(log), [], "the guild check runs BEFORE any write helper");
    }
    assert.equal(api.countAdminAudit(GUILD_B, {}), auditBefore.b, "guild B audited nothing");
    assert.equal(webAuditCount(), auditBefore.web, "guild A audited nothing either");
    assert.deepEqual({ ...api.getTicketById(tB.id) }, snapshot, "guild-B row byte-identical");
  });

  it("unknown id (never existed) ⇒ the SAME 404 bytes", async () => {
    const { res, body } = await claimPost({ ticket_id: "999123" });
    assert.equal(res.status, 404);
    assert.equal(body, "Not found");
  });
});

// ===========================================================================
// H. CLOSE — the slash's OWN softCloseTicket (args, transition, DM, degraded)
// ===========================================================================
describe("H. close — slash soft-close parity through the service seam", () => {
  it("happy close (cached channel): helper args, committed transition, DM, notice, audit", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, channelId: "710000000000000002", reason: "close me" });
    usersCache.set(USER_PLAIN, makeCacheUser(USER_PLAIN)); // DM-resolvable creator
    const channel = makeCacheChannel(t.channel_id);
    const dmBefore = dmLog.length;
    softCloseCalls.length = 0;

    startWindow();
    const r = await closePost({ ticket_id: String(t.id), reason: "resolved" });
    const log = stopWindow();
    assert.equal(r.res.status, 302);
    assert.equal(r.location, `${PAGE_PATH}?done=ticket_closed`);

    // The web ran the slash's OWN helper with the slash's OWN args.
    assert.equal(softCloseCalls.length, 1);
    const [opts] = softCloseCalls[0];
    assert.equal(opts.ticket.id, t.id);
    assert.equal(opts.closedBy, USER_SENIOR);
    assert.equal(opts.closeReason, "resolved");
    assert.equal(opts.botMember, BOT_MEMBER, "cache-only bot member seam");
    assert.equal(opts.channel, channel, "cache-only channel seam hands over the SAME object slash would get");

    // Transition (markTicketClosed inside softClose — recorded via facade).
    assert.ok(
      log.some((c) => c.name === "markTicketClosed"),
      "close transition ran through the FACADE (recorder sees inside softClose — lazy-bind proof)"
    );
    const row = api.getTicketById(t.id);
    assert.equal(row.status, "closed");
    assert.equal(row.close_reason, "resolved");
    assert.equal(row.closed_by_user_id, USER_SENIOR);
    assert.equal(Number(row.archived), 0, "soft close does NOT archive (archive stays slash-only)");
    assert.equal(row.channel_id, t.channel_id, "channel binding preserved for /ticket archive");

    // Audit EXACT slash shape (index.js:1410-1420), origin web.
    const audit = lastAuditFor("tickets.close", t.id);
    assert.deepEqual(audit.details, {
      ticket_number: row.ticket_number,
      close_reason: "resolved",
      status: "closed",
    });
    assert.equal(audit.origin, "web");
    assert.equal(audit.actor_user_id, USER_SENIOR);

    await tick();
    assert.ok(
      dmLog.slice(dmBefore).some((e) => e.to === USER_PLAIN),
      "requester DM sent through the slash helper (cache-only user seam)"
    );
    assert.ok(
      channelLog.some((e) => e.channelId === t.channel_id && e.kind === "send" && e.payload?.embeds),
      "close notice embed posted in channel"
    );
    assert.equal(staffNoteCount(), 0, "delta (4): staff_note add-on NOT in the web surface");
    assert.equal(mirrorSpy.log.length, 0, "close mirrors NO channel embed (slash close posts none)");
  });

  it("blank reason ⇒ null (slash `?? null` shape), trimmed reason stored", async () => {
    purgeTickets();
    const t1 = mkTicket({ creator: USER_PLAIN, reason: "blank probe" });
    const t2 = mkTicket({ creator: USER_PLAIN, reason: "trim probe" });
    await closePost({ ticket_id: String(t1.id), reason: "   " });
    await closePost({ ticket_id: String(t2.id), reason: "  done deal \n" });
    assert.equal(api.getTicketById(t1.id).close_reason, null);
    assert.equal(api.getTicketById(t2.id).close_reason, "done deal");
    const a = lastAuditFor("tickets.close", t1.id);
    assert.equal(a.details.close_reason, null, "audit carries the SAME null the slash records");
  });

  it("UNCACHED channel ⇒ the helper's own degraded path (transition committed, flash claims ONLY that)", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, channelId: "719999999999999998", reason: "degraded" });
    const chanBefore = channelLog.length;
    softCloseCalls.length = 0;

    startWindow();
    const r = await closePost({ ticket_id: String(t.id), reason: "server-side only" });
    const log = stopWindow();

    assert.equal(softCloseCalls.length, 1, "the SAME helper runs (degradation lives INSIDE it)");
    const [opts] = softCloseCalls[0];
    assert.equal(opts.channel, null, "cache miss ⇒ null channel handed to the helper (no fetch)");
    assert.equal(r.location, `${PAGE_PATH}?done=ticket_closed`);

    const row = api.getTicketById(t.id);
    assert.equal(row.status, "closed", "DB transition committed FIRST inside softClose (WHERE status='open')");
    assert.equal(row.close_reason, "server-side only");
    assert.ok(log.some((c) => c.name === "markTicketClosed"), "transition through the facade recorder");
    assert.ok(lastAuditFor("tickets.close", t.id), "audited (audit-after-actual-transition)");
    await tick();
    assert.equal(
      channelLog.slice(chanBefore).filter((e) => e.channelId === t.channel_id).length,
      0,
      "no fabricated channel activity — permission pass + notice skipped as the helper's own warnings"
    );
  });

  it("channel whose overwrites THROW ⇒ close still lands (slash try/catch-swallowed warnings)", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, channelId: "710000000000000003", reason: "perm fail" });
    makeCacheChannel(t.channel_id, { overwritesFail: true });
    const r = await closePost({ ticket_id: String(t.id), reason: "ok anyway" });
    assert.equal(r.location, `${PAGE_PATH}?done=ticket_closed`);
    assert.equal(api.getTicketById(t.id).status, "closed");
  });
});

// ===========================================================================
// I. SUMMARIZE — guard ladder, slash args, no persistence, soft-closed OK
// ===========================================================================
describe("I. summarize regen — guards, slash-summarizer parity, no persistence", () => {
  it("SENSITIVE ticket ⇒ generic 404 BEFORE any message/AI read (delta (2))", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, reason: "secret stuff" });
    api.setTicketSensitive(t.id, USER_SENIOR);
    api.saveTicketMessages(t.id, [
      { message_id: "501", author_id: USER_PLAIN, author_tag: "plain#0001", content: "secret", sent_at: 1 },
    ]);
    const callsBefore = summarizeCalls.length;
    startWindow();
    const { res, body } = await sumPost({ ticket_id: String(t.id) });
    const log = stopWindow();
    assert.equal(res.status, 404, "sensitive ⇒ indistinguishable from unknown (§8.4)");
    assert.equal(body, "Not found");
    assert.equal(summarizeCalls.length, callsBefore, "NO summarize attempted on sensitive content");
    assert.deepEqual(writeCalls(log), [], "zero writes");
    assert.ok(!namesOf(log).includes("listTicketMessages"), "messages never even read");
  });

  it("archived ticket ⇒ ticket_archived slug, summarizer NEVER called", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, reason: "done long ago" });
    api.markTicketClosed(t.id, { closedBy: USER_SENIOR, closeReason: "x" });
    api.db.prepare("UPDATE tickets SET archived=1 WHERE id=?").run(t.id);
    const callsBefore = summarizeCalls.length;
    startWindow();
    const r = await sumPost({ ticket_id: String(t.id) });
    const log = stopWindow();
    assert.equal(r.location, `${PAGE_PATH}?error=ticket_archived`);
    assert.equal(summarizeCalls.length, callsBefore);
    assert.deepEqual(writeCalls(log), []);
  });

  it("NO AI configured ⇒ ai_not_configured slug with ZERO summarizer calls (delta (3))", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, reason: "summe me" });
    api.saveTicketMessages(t.id, [
      { message_id: "502", author_id: USER_PLAIN, author_tag: "plain#0001", content: "hi", sent_at: 1 },
    ]);
    aiFlag = false;
    try {
      const callsBefore = summarizeCalls.length;
      startWindow();
      const r = await sumPost({ ticket_id: String(t.id) });
      const log = stopWindow();
      assert.equal(r.location, `${PAGE_PATH}?error=ai_not_configured`);
      assert.equal(summarizeCalls.length, callsBefore, "refusal BEFORE any AI work");
      assert.deepEqual(writeCalls(log), []);
    } finally {
      aiFlag = true;
    }
  });

  it("empty stored rows ⇒ messages_unavailable and NEVER a channel fetch", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, channelId: "710000000000000004", reason: "no msgs" });
    const ch = makeCacheChannel(t.channel_id);
    const callsBefore = summarizeCalls.length;
    startWindow();
    const r = await sumPost({ ticket_id: String(t.id) });
    const log = stopWindow();
    assert.equal(r.location, `${PAGE_PATH}?error=messages_unavailable`);
    assert.equal(summarizeCalls.length, callsBefore);
    assert.deepEqual(writeCalls(log), []);
    // ch.messages is UNDEFINED by design — a fetch attempt would have thrown
    // inside the request and surfaced as a 500, not this clean refusal.
    assert.equal(ch.messages, undefined, "channel mock carries NO fetch surface (cache-only doctrine)");
  });

  it("happy regen (open ticket): slash args (ticket, messages, {}), audit shape, source slug, NO persistence", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, reason: "regen happy" });
    api.saveTicketMessages(t.id, [
      { message_id: "510", author_id: USER_PLAIN, author_tag: "plain#0001", content: "a", sent_at: 1 },
      { message_id: "511", author_id: USER_SENIOR, author_tag: "sen#0001", content: "b", sent_at: 2 },
      { message_id: "512", author_id: USER_PLAIN, author_tag: "plain#0001", content: "c", sent_at: 3 },
    ]);
    summarizeCalls.length = 0;
    summarizeImpl = async () => ({
      source: "ai",
      model: "test-model",
      resolution: "fixed",
      summary: "all good",
      message_count: 3,
    });
    try {
      startWindow();
      const r = await sumPost({ ticket_id: String(t.id) });
      const log = stopWindow();
      assert.equal(r.location, `${PAGE_PATH}?done=summary_ai`);

      assert.equal(summarizeCalls.length, 1);
      const [ticketArg, messagesArg, optsArg] = summarizeCalls[0];
      assert.equal(ticketArg.id, t.id, "same ticket object shape slash passes");
      assert.equal(messagesArg.length, 3, "stored rows, oldest-first (slash source of truth)");
      assert.deepEqual(optsArg, {}, "slash's exact empty-opts call (handleSummarize:2143)");

      const audit = lastAuditFor("tickets.summarize", t.id);
      assert.deepEqual(audit.details, {
        ticket_number: api.getTicketById(t.id).ticket_number,
        source: "ai",
        message_count: 3,
      });
      assert.equal(audit.origin, "web");
      assert.equal(api.getTicketById(t.id).ai_summary_json, null, "on-demand regen persists NOTHING (slash parity — archive owns that column)");
      assert.equal(mirrorSpy.log.length, 0, "summarize mirrors nothing");
    } finally {
      summarizeImpl = null;
    }
  });

  it("fallback source ⇒ summary_fallback slug + fallback in audit", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, reason: "regen fallback" });
    api.saveTicketMessages(t.id, [
      { message_id: "520", author_id: USER_PLAIN, author_tag: "plain#0001", content: "solo", sent_at: 1 },
    ]);
    summarizeImpl = async () => ({
      source: "fallback",
      resolution: "stats only",
      summary: "1 messages",
      message_count: 1,
    });
    try {
      const r = await sumPost({ ticket_id: String(t.id) });
      assert.equal(r.location, `${PAGE_PATH}?done=summary_fallback`);
      assert.equal(lastAuditFor("tickets.summarize", t.id).details.source, "fallback");
    } finally {
      summarizeImpl = null;
    }
  });

  it("SOFT-CLOSED (pre-archive) ticket may be regenerated — slash status:'any' parity", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, reason: "closed but live" });
    api.claimTicket(t.id, USER_SENIOR);
    api.markTicketClosed(t.id, { closedBy: USER_SENIOR, closeReason: "done" });
    api.saveTicketMessages(t.id, [
      { message_id: "530", author_id: USER_PLAIN, author_tag: "plain#0001", content: "thanks", sent_at: 1 },
    ]);
    summarizeImpl = async () => ({ source: "ai", model: "m", resolution: "r", summary: "s", message_count: 1 });
    try {
      const r = await sumPost({ ticket_id: String(t.id) });
      assert.equal(r.location, `${PAGE_PATH}?done=summary_ai`);
      assert.ok(lastAuditFor("tickets.summarize", t.id));
    } finally {
      summarizeImpl = null;
    }
  });
});

// ===========================================================================
// J. FAIL-CLOSED — audit insert throws ⇒ generic 500, NOTHING claimed
// ===========================================================================
describe("J. fail-closed — insertAdminAudit throwing aborts every mutation", () => {
  it("claim with audit-throw ⇒ 500, no Location, no audit row (committed helper row never CLAIMED via redirect)", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, reason: "failclosed claim" });
    recorder.auditThrow = true;
    try {
      startWindow();
      const { res, body, location } = await claimPost({ ticket_id: String(t.id) });
      stopWindow();
      assert.equal(res.status, 500, label_body(res));
      assert.equal(location, null, "no redirect — the outcome is never claimed");
      assert.ok(!/claim/i.test(body), "nothing leaked into the body");
      assert.equal(body, "Internal error");
    } finally {
      recorder.auditThrow = false;
    }
    assert.equal(rowsOf("web", "tickets.claim").find((r) => r.target_id === String(t.id)), undefined, "NO audit row survived");
    await tick();
    assert.equal(mirrorSpy.log.length, 0);
  });

  it("close with audit-throw ⇒ 500, no Location, no audit row", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, reason: "failclosed close" });
    recorder.auditThrow = true;
    try {
      const { res, location } = await closePost({ ticket_id: String(t.id), reason: "x" });
      assert.equal(res.status, 500);
      assert.equal(location, null);
    } finally {
      recorder.auditThrow = false;
    }
    assert.equal(rowsOf("web", "tickets.close").find((r) => r.target_id === String(t.id)), undefined);
  });

  it("summarize with audit-throw ⇒ 500, no Location, no audit row", async () => {
    purgeTickets();
    const t = mkTicket({ creator: USER_PLAIN, reason: "failclosed regen" });
    api.saveTicketMessages(t.id, [
      { message_id: "540", author_id: USER_PLAIN, author_tag: "plain#0001", content: "m", sent_at: 1 },
    ]);
    summarizeImpl = async () => ({ source: "ai", model: "m", resolution: "r", summary: "s", message_count: 1 });
    recorder.auditThrow = true;
    try {
      const { res, location } = await sumPost({ ticket_id: String(t.id) });
      assert.equal(res.status, 500);
      assert.equal(location, null);
    } finally {
      recorder.auditThrow = false;
      summarizeImpl = null;
    }
    assert.equal(rowsOf("web", "tickets.summarize").find((r) => r.target_id === String(t.id)), undefined);
  });
});

/** tiny helper for a readable failure line */
function label_body(res) {
  return `unexpected status ${res.status}`;
}

// ===========================================================================
// K. SLASH↔WEB PARITY (§8.11) — the REAL handleTicket on the SAME database
// ===========================================================================
describe("K. slash ↔ web parity — REAL handlers, same actor, same outcome", () => {
  /** Mock ChatInputCommandInteraction (moderation-actions precedent). */
  function makeTicketInteraction({ sub, ticket, actorId, options = {} }) {
    const channel = channelsCache.get(ticket.channel_id);
    const calls = [];
    return {
      calls,
      interaction: {
        commandName: "ticket",
        guildId: GUILD_A,
        guild: { id: GUILD_A, members: { me: BOT_MEMBER }, roles: FAKE_GUILD.roles },
        channel,
        channelId: ticket.channel_id,
        user: { id: actorId },
        member: { roles: { cache: new Set() } },
        memberPermissions: { has: () => true }, // admin-ish ⇒ requireStaff passes
        client: FAKE_CLIENT,
        deferred: false,
        replied: false,
        options: {
          getSubcommandGroup: () => null,
          getSubcommand: () => sub,
          getString: (name) => (options[name] === undefined ? null : options[name]),
          getUser: () => null,
          getInteger: () => null,
          getBoolean: () => null,
        },
        deferReply: async () => {
          calls.push({ kind: "defer" });
        },
        reply: async (payload) => {
          calls.push({ kind: "reply", payload });
          return {};
        },
        editReply: async (payload) => {
          calls.push({ kind: "editReply", payload });
          return {};
        },
        followUp: async (payload) => {
          calls.push({ kind: "followUp", payload });
          return {};
        },
      },
    };
  }

  it("CLAIM: real slash handleClaim vs web POST — same row state, audit rows differ ONLY in origin", async () => {
    purgeTickets();
    // Slash side
    const ts = mkTicket({ creator: USER_PLAIN, channelId: "730000000000000001", reason: "slash claim" });
    makeCacheChannel(ts.channel_id);
    const { interaction } = makeTicketInteraction({ sub: "claim", ticket: ts, actorId: USER_SENIOR });
    await handleTicket(interaction, { client: FAKE_CLIENT });
    const slashRow = api.getTicketById(ts.id);

    // Web side
    const tw = mkTicket({ creator: USER_PLAIN, channelId: "730000000000000002", reason: "web claim" });
    makeCacheChannel(tw.channel_id);
    await claimPost({ ticket_id: String(tw.id) });
    const webRow = api.getTicketById(tw.id);

    // tickets-table state parity (transport-agnostic columns)
    for (const col of ["status", "staff_owner_id", "archived", "is_sensitive", "close_reason"]) {
      assert.deepEqual({ [col]: webRow[col] }, { [col]: slashRow[col] }, `claim parity on ${col}`);
    }
    assert.equal(webRow.staff_owner_id, USER_SENIOR);

    // ticket_staff parity
    const sStaff = api.listTicketStaff(ts.id);
    const wStaff = api.listTicketStaff(tw.id);
    assert.deepEqual(
      wStaff.map((s) => ({ user_id: s.user_id, is_owner: s.is_owner })),
      sStaff.map((s) => ({ user_id: s.user_id, is_owner: s.is_owner }))
    );

    // audit parity: same action/actor/target_type + DEEP-EQUAL details
    const aS = rowsOf("slash", "tickets.claim").find((r) => r.target_id === String(ts.id));
    const aW = rowsOf("web", "tickets.claim").find((r) => r.target_id === String(tw.id));
    assert.ok(aS && aW, "one audit row on each transport");
    assert.equal(aW.actor_user_id, aS.actor_user_id);
    assert.equal(aW.target_type, aS.target_type);
    assert.notEqual(aW.origin, aS.origin);
    assert.equal(aS.origin, "slash");
    assert.equal(aW.origin, "web");
    // Each side's ticket_number must equal its OWN row's number (two
    // distinct rows carry different numbers) …
    assert.equal(aS.details.ticket_number, slashRow.ticket_number);
    assert.equal(aW.details.ticket_number, webRow.ticket_number);
    // … then the details are DEEP-EQUAL — shape + values are the parity
    // contract, masking only the per-row identity number.
    assert.deepEqual(
      { ...aW.details, ticket_number: 0 },
      { ...aS.details, ticket_number: 0 }
    );
    assert.deepEqual(
      Object.keys(aW.details).sort(),
      ["previous_owner", "staff_owner_id", "ticket_number"],
      "slash's EXACT detail key-set (index.js:1656-1660)"
    );
  });

  it("CLOSE: real slash handleClose vs web POST — same transition state + deep-equal audit details", async () => {
    purgeTickets();
    usersCache.set(USER_PLAIN, makeCacheUser(USER_PLAIN));

    const ts = mkTicket({ creator: USER_PLAIN, channelId: "730000000000000003", reason: "slash close" });
    api.claimTicket(ts.id, USER_SENIOR);
    makeCacheChannel(ts.channel_id);
    const { interaction } = makeTicketInteraction({
      sub: "close",
      ticket: ts,
      actorId: USER_SENIOR,
      options: { reason: "parity reason" },
    });
    await handleTicket(interaction, { client: FAKE_CLIENT });

    const tw = mkTicket({ creator: USER_PLAIN, channelId: "730000000000000004", reason: "web close" });
    api.claimTicket(tw.id, USER_SENIOR);
    makeCacheChannel(tw.channel_id);
    await closePost({ ticket_id: String(tw.id), reason: "parity reason" });

    const s = api.getTicketById(ts.id);
    const w = api.getTicketById(tw.id);
    for (const col of ["status", "close_reason", "closed_by_user_id", "archived"]) {
      assert.deepEqual({ [col]: w[col] }, { [col]: s[col] }, `close parity on ${col}`);
    }
    assert.ok(w.closed_at > 0);
    assert.notEqual(w.closed_at, null, "transition genuinely executed on the web side");

    const aS = rowsOf("slash", "tickets.close").find((r) => r.target_id === String(ts.id));
    const aW = rowsOf("web", "tickets.close").find((r) => r.target_id === String(tw.id));
    assert.ok(aS && aW);
    assert.equal(aW.actor_user_id, aS.actor_user_id);
    assert.equal(aS.details.ticket_number, s.ticket_number);
    assert.equal(aW.details.ticket_number, w.ticket_number);
    assert.deepEqual(
      { ...aW.details, ticket_number: 0 },
      { ...aS.details, ticket_number: 0 }
    );
    assert.deepEqual(
      Object.keys(aW.details).sort(),
      ["close_reason", "status", "ticket_number"],
      "slash's EXACT detail key-set (index.js:1415-1419)"
    );
  });

  it("SUMMARIZE: real slash handleSummarize vs web POST, REAL summarizer (no AI key ⇒ identical fallback)", async () => {
    purgeTickets();
    // Both transports read the SAME message rows; NO AI key (env deleted at
    // boot) ⇒ the REAL summarizeTicket returns its stats fallback on both
    // sides — byte-equal detail outcome without any network.
    const ts = mkTicket({ creator: USER_PLAIN, channelId: "730000000000000005", reason: "slash sum" });
    api.saveTicketMessages(ts.id, [
      { message_id: "560", author_id: USER_PLAIN, author_tag: "plain#0001", content: "one", sent_at: 1 },
      { message_id: "561", author_id: USER_SENIOR, author_tag: "sen#0001", content: "two", sent_at: 2 },
    ]);
    const { interaction } = makeTicketInteraction({ sub: "summarize", ticket: ts, actorId: USER_SENIOR });
    await handleTicket(interaction, { client: FAKE_CLIENT });

    const tw = mkTicket({ creator: USER_PLAIN, channelId: "730000000000000006", reason: "web sum" });
    api.saveTicketMessages(tw.id, [
      { message_id: "570", author_id: USER_PLAIN, author_tag: "plain#0001", content: "one", sent_at: 1 },
      { message_id: "571", author_id: USER_SENIOR, author_tag: "sen#0001", content: "two", sent_at: 2 },
    ]);
    const r = await sumPost({ ticket_id: String(tw.id) });
    assert.equal(r.location, `${PAGE_PATH}?done=summary_fallback`, "web falls back EXACTLY like slash (same real module)");

    const aS = rowsOf("slash", "tickets.summarize").find((r) => r.target_id === String(ts.id));
    const aW = rowsOf("web", "tickets.summarize").find((r) => r.target_id === String(tw.id));
    assert.ok(aS && aW, "summarize audited on BOTH transports");
    assert.equal(aW.actor_user_id, aS.actor_user_id);
    assert.equal(aS.details.ticket_number, api.getTicketById(ts.id).ticket_number);
    assert.equal(aW.details.ticket_number, api.getTicketById(tw.id).ticket_number);
    assert.deepEqual(
      { ...aW.details, ticket_number: 0 },
      { ...aS.details, ticket_number: 0 },
      "fallback {source, message_count} identical (ticket_number equals its own row on both sides)"
    );
    assert.deepEqual(
      Object.keys(aW.details).sort(),
      ["message_count", "source", "ticket_number"],
      "slash's EXACT detail key-set (index.js:2150-2154)"
    );
    assert.equal(aS.details.message_count, 2);
    assert.equal(api.getTicketById(ts.id).ai_summary_json, null);
    assert.equal(api.getTicketById(tw.id).ai_summary_json, null, "neither transport persists on-demand summaries");
  });
});
