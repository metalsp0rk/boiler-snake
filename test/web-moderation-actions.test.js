/**
 * Subtask 29 — PHASE 3 MODERATION ACTIONS: warn issue / warn void / note add
 * (roadmap/web-admin.md §8.6 "Moderation: warnings list/issue/void, notes |
 * Staff | Staff" + "Users (add note = Staff)"; §8.8 Phase 3; §8.11 parity).
 *
 * Everything the web mutations do must be indistinguishable from the SLASH
 * at the service / DB / audit boundary, and everything they refuse must
 * write NOTHING. Mechanism: REAL Express 5 app on an ephemeral port, REAL
 * SQLite, fake Discord transport under the REAL createGuildAccessResolver
 * (Phase-2 gate boot discipline — sessions minted offline, csrf derived,
 * one loadDb). Slash parity runs the REAL handleWarn/handleNote handlers
 * against the SAME database (mock interactions, same xp-grant precedent).
 *
 * What this suite pins:
 *  A. MUTATION CONTRACT — three POST registry entries minted in lockstep
 *     with the mounted routes (one template constant each); warning_number
 *     rides the body (methodGate matches :guildId only).
 *  B. FORMS + FLASH (GET) — staff/senior/admin see the forms with hidden
 *     _csrf + the field contract; PRG flash renders ONLY whitelisted slugs
 *     (hostile values never echo; foreign-page slugs stay invisible).
 *  C. TIER LADDER (POST) — anon 302 · stranger/plain/cross generic 404
 *     (§8.6 never-403 cross-guild) · staff/senior/admin pass.
 *  D. CSRF — missing / tampered ⇒ 403 with ZERO facade calls, zero rows.
 *  E. ISSUE PARITY — createWarning through the facade recorder (zero route
 *     SQL): slash-identical args, warn row (trimmed reason, sequential
 *     W-ref, guild-default vs override expiry incl. 0=never), audit
 *     warnings.add origin web with the EXACT slash detail shape, warn-log
 *     channel mirror (kind "warn"), member DM per warn_dm_members + the
 *     silent flag through a CACHE-ONLY seam (uncached ⇒ graceful skip).
 *  F. VALIDATION — slash bounds mirrored (reason ≤1000, evidence ≤500,
 *     guild-scoped message link, note link, expires 0…3650, bot refusal on
 *     proven cache evidence); every refusal is a whitelisted-slug 302 with
 *     zero writes and zero audit.
 *  G. VOID — happy void stamps author+reason; ALREADY_VOIDED rejected with
 *     the row untouched and zero audit; a warning number that exists only
 *     in guild B resolves to NOTHING here (cross-guild zero side effects).
 *  H. NOTE — createStaffNote twin (2000-char bound PRE-validated: a
 *     refusal never reaches a write helper); notes mirror to the AUDIT
 *     channel kind and NEVER DM the subject.
 *  I. FAIL-CLOSED — insertAdminAudit throwing ⇒ generic 500, no claim, no
 *     audit row, NO mirror.
 *  J. SLASH↔WEB PARITY (§8.11) — the REAL handlers on the same DB: equal
 *     warnings/staff_notes outcomes + audit rows with identical action/
 *     vocabulary/deep-equal details (only origin differs: 'web' vs 'slash').
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
// binds to that DB (Phase-2 gate boot discipline).
const { api, tmpDir } = loadDb();

const harness = require("./helpers/access-matrix");
const guildAccessMod = require("../src/web/auth/guildAccess");
const { createWebApp } = require("../src/web/app");
const sessionPolicy = require("../src/web/auth/sessions");
const tokens = require("../src/web/auth/tokens");
const csrfMod = require("../src/web/middleware/csrf");
const { bindAuditClient } = require("../src/web/middleware/audit");
const auditLogMod = require("../src/features/logs/auditLog");
const dbFacade = require("../src/db");
const moderationRoutes = require("../src/web/routes/moderation");

// ---------------------------------------------------------------------------
// Clearly-fake sentinels / placeholders ONLY (AGENTS.md: never realistic).
// ---------------------------------------------------------------------------
const SESSION_SECRET = "test-moderation-actions-sentinel-secret-NOT-REAL-029";

const GUILD_A = "330000000000000001"; // bot + every test user
const GUILD_B = "330000000000000002"; // bot guild the users are NOT in

const USER_ADMIN = "468190112345678901"; // owner snapshot ⇒ tier admin
const USER_JUNIOR = "468190112345678902"; // junior staff role ⇒ tier staff
const USER_SENIOR = "468190112345678903"; // senior staff role ⇒ tier senior
const USER_PLAIN = "468190112345678904"; // guild-A member, no staff role
const USER_STRANGER = "468190112345678905"; // member of NOTHING

// Tier-resolution roles (NOT snowflake-shaped — gate trick).
const ROLE_JUNIOR_TIER = "role-junior-staff";
const ROLE_SENIOR_TIER = "role-senior-staff";

// Mutation targets (snowflake-shaped; only the ones the tests cache are
// DM-resolvable).
const T_ISSUE = "468190112345678911"; // first positive issue (DM cached)
const T_MEMBER = "468190112345678912"; // DM resolves via MEMBER cache only
const T_UNCACHE = "468190112345678913"; // uncached ⇒ DM gracefully skipped
const T_VOID = "468190112345678914"; // void happy path
const T_NOTE = "468190112345678915"; // note happy path
const T_BOT_U = "468190112345678916"; // proven bot via users cache
const T_BOT_M = "468190112345678917"; // proven bot via member cache
const T_SLASH = "468190112345678918"; // slash side of the warn parity
const T_WEBP = "468190112345678919"; // web side of the warn parity
const T_SLASH_N = "468190112345678920"; // slash side of the note parity
const T_WEB_N = "468190112345678921"; // web side of the note parity
const T_FAILOPEN = "468190112345678922"; // fail-closed injection target
const T_EVIDENCE = "468190112345678923"; // evidence / expiry bound probes
const B_SUBJECT = "468190112345678924"; // guild-B subject (cross-guild probe)

const ISSUE_PATH = `/g/${GUILD_A}/moderation/warnings/issue`;
const VOID_PATH = `/g/${GUILD_A}/moderation/warnings/void`;
const NOTE_PATH = `/g/${GUILD_A}/moderation/notes`;
const WARNINGS_PAGE = `/g/${GUILD_A}/warnings`;
const NOTES_PAGE = `/g/${GUILD_A}/notes`;

const ISSUE_TEMPLATE = "/g/:guildId/moderation/warnings/issue";
const VOID_TEMPLATE = "/g/:guildId/moderation/warnings/void";
const NOTE_TEMPLATE = "/g/:guildId/moderation/notes";

const DAY_MS = 86_400_000;

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
// leaving the process (the cache-only seam contract, subtask 28 doctrine).
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} userId → user mock (with a .send spy) */
const usersCache = new Map();
/** @type {Map<string, object>} userId → member mock */
const membersCache = new Map();
/** Every DM payload the route attempted: { to, payload }. */
const dmLog = [];

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

function makeCacheMember(userId, { bot = false } = {}) {
  return { id: userId, user: makeCacheUser(userId, { bot }) };
}

const FAKE_GUILD = {
  id: GUILD_A,
  name: "Alpha HQ",
  members: { cache: membersCache }, // NO members.fetch — cache-only seam.
};

const FAKE_CLIENT = {
  guilds: { cache: { get: (id) => (id === GUILD_A ? FAKE_GUILD : undefined) } },
  users: { cache: usersCache },
  channels: { cache: { get: () => undefined } },
};

// ---------------------------------------------------------------------------
// SERVICE-LAYER counting proxy on the SHARED src/db facade object (gate
// pattern). Installed BEFORE createWebApp so the audit middleware captures
// the wrapped insertAdminAudit, and the route's facade property lookups bind
// THE WRAPPED helpers: every service write lands in this recorder — proof
// the route never writes SQL itself (§8.6 service-layer rule).
// ---------------------------------------------------------------------------

const WATCH = new Set([
  "createWarning",
  "voidWarning",
  "createStaffNote",
  "getStaffNote",
  "getWarning",
  "countActiveWarnings",
  "getGuildSettings",
  "insertAdminAudit",
]);

/** DB-mutating watched helpers — validation rejections must call ZERO. */
const WRITE_HELPERS = new Set([
  "createWarning",
  "voidWarning",
  "createStaffNote",
  "insertAdminAudit",
]);

const recorder = { active: false, log: [], auditThrow: false };

/** Last createWarning/createStaffNote args (service-ARG parity evidence). */
const lastArgs = { createWarning: null, voidWarning: null, createStaffNote: null };

function installFacadeRecorder(F) {
  const originals = {};
  for (const name of WATCH) {
    if (typeof F[name] !== "function") {
      throw new Error(`moderation precondition: facade helper "${name}" missing (renamed?)`);
    }
    originals[name] = F[name];
    F[name] = function recorded(...args) {
      if (recorder.active) recorder.log.push({ name, args });
      // ARG capture is ALWAYS on (window-independent): it is pure parity
      // evidence, never the basis of a zero-call assertion.
      if (name in lastArgs) lastArgs[name] = args;
      if (name === "insertAdminAudit" && recorder.auditThrow) {
        const err = new Error("admin_audit insert failed (moderation injection)");
        err.code = "MOD_AUDIT_INJECT";
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
// Mirror spy (§8.1-7): the audit middleware dispatches mirrors through the
// REAL auditLog module object (posters resolve at dispatch time) with the
// bound client. Swapping the two posters + binding a fake proves WHICH
// channel path the slash's own helper uses (warn-log kind vs audit kind).
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
  // Bind the SAME cache-rich fake: the moderation route's client seam falls
  // back to getBoundAuditClient (the app.js moderation mount predates the
  // getClient option), and the mirror dispatch reads boundAuditClient at
  // dispatch time. The fake has CACHE-ONLY surfaces — a fetch attempt throws.
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
});

/** @type {{server, base}} resolved in before(). */
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

const issuePost = (fields, key = "junior") =>
  post(ISSUE_PATH, { cookie: cookieOf[key], fields: { ...fields, _csrf: csrfOf[key] } });
const voidPost = (fields, key = "junior") =>
  post(VOID_PATH, { cookie: cookieOf[key], fields: { ...fields, _csrf: csrfOf[key] } });
const notePost = (fields, key = "junior") =>
  post(NOTE_PATH, { cookie: cookieOf[key], fields: { ...fields, _csrf: csrfOf[key] } });

// ---------------------------------------------------------------------------
// DB readers
// ---------------------------------------------------------------------------

function auditRows(origin) {
  return api.listAdminAudit(GUILD_A, { origin, limit: 100 }).map((r) => ({
    ...r,
    details: r.details_json ? JSON.parse(r.details_json) : null,
  }));
}
const webAuditCount = () => api.countAdminAudit(GUILD_A, { origin: "web" });
const rowsOf = (origin, action) => auditRows(origin).filter((r) => r.action === action);

const lastWarn = (guildId = GUILD_A) =>
  api.db
    .prepare("SELECT * FROM warnings WHERE guild_id = ? ORDER BY id DESC LIMIT 1")
    .get(guildId);
const warnCount = () => api.db.prepare("SELECT COUNT(*) AS n FROM warnings").get().n;
const lastNote = () =>
  api.db
    .prepare("SELECT * FROM staff_notes WHERE guild_id = ? ORDER BY id DESC LIMIT 1")
    .get(GUILD_A);
const noteCount = () =>
  api.db.prepare("SELECT COUNT(*) AS n FROM staff_notes").get().n;
const warnByNumber = (n, guildId = GUILD_A) => api.getWarning(guildId, n);

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
  const TEMPLATES = [ISSUE_TEMPLATE, VOID_TEMPLATE, NOTE_TEMPLATE];

  it("route module exports the three mutation templates (one constant each)", () => {
    assert.equal(moderationRoutes.WARN_ISSUE_PATH, ISSUE_TEMPLATE);
    assert.equal(moderationRoutes.WARN_VOID_PATH, VOID_TEMPLATE);
    assert.equal(moderationRoutes.NOTE_ADD_PATH, NOTE_TEMPLATE);
  });

  it("exactly one registry entry per moderation template, /g/:guildId-scoped POSTs", () => {
    for (const template of TEMPLATES) {
      const entries = app.locals.webMutations.filter(
        (m) => m.method === "POST" && m.path === template
      );
      assert.equal(entries.length, 1, `exactly one registration for ${template}`);
    }
    const moderationRegs = app.locals.webMutations.filter((m) =>
      m.path.startsWith("/g/:guildId/moderation/")
    );
    assert.deepEqual(
      moderationRegs.map((m) => m.path).sort(),
      [...TEMPLATES].sort(),
      "no other /moderation/ mutation sneaked in"
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

  it("the warning number is a BODY field (methodGate matches :guildId only — no :id templates)", () => {
    for (const template of TEMPLATES) {
      const paramSegs = template.split("/").filter((seg) => seg.startsWith(":"));
      assert.deepEqual(
        paramSegs,
        [":guildId"],
        `${template}: :guildId is the ONLY param segment (app.js matchesMutationPath)`
      );
    }
    // The warning number itself rides the form body (warning_number) — the
    // happy-path void below proves the body routing works end to end.
  });
});

// ===========================================================================
// B. FORMS + FLASH on the list pages (staff sees forms; slugs only)
// ===========================================================================
describe("B. GET list pages — mutation forms + whitelisted-only flash", () => {
  it("staff/senior/admin ⇒ forms rendered with _csrf + the field contract", async () => {
    for (const key of ["junior", "senior", "admin"]) {
      const w = await harness.request(baseUrl, WARNINGS_PAGE, { cookieId: sessionIdOf[key] });
      assert.equal(w.status, 200, `warnings via ${key}`);
      assert.ok(w.body.includes(harness.SHELL_MARKER), "renders inside the guild shell");
      assert.ok(w.body.includes(`action="${ISSUE_PATH}"`), "issue form posts to the exact mutation path");
      assert.ok(w.body.includes(`action="${VOID_PATH}"`), "void form posts to the exact mutation path");
      for (const field of ['name="user_id"', 'name="reason"', 'name="warning_number"', 'name="silent"', 'name="_csrf"']) {
        assert.ok(w.body.includes(field), `warnings form field ${field}`);
      }
      const n = await harness.request(baseUrl, NOTES_PAGE, { cookieId: sessionIdOf[key] });
      assert.equal(n.status, 200, `notes via ${key}`);
      assert.ok(n.body.includes(`action="${NOTE_PATH}"`), "note form posts to the exact mutation path");
      assert.ok(n.body.includes('name="content"'), "note form field content");
      assert.ok(n.body.includes('name="_csrf"'), "hidden CSRF field (double-submit half)");
    }
  });

  it("PRG flash renders ONLY whitelisted slugs — hostile values never echo; foreign slugs invisible", async () => {
    const hostile = encodeURIComponent('<script>alert("mod-x")</script>');
    const junk = await harness.request(
      baseUrl,
      `${WARNINGS_PAGE}?error=${hostile}&done=bogus&note=bogus`,
      { cookieId: sessionIdOf.junior }
    );
    assert.equal(junk.status, 200);
    assert.ok(!junk.body.includes("mod-x"), "hostile flash value never echoed (§8.7)");
    assert.ok(!junk.body.includes("banner-"), "unknown slugs render NO banner");

    const known = await harness.request(
      baseUrl,
      `${WARNINGS_PAGE}?error=already_voided`,
      { cookieId: sessionIdOf.junior }
    );
    assert.ok(known.body.includes("already voided"), "the whitelisted slug renders its FIXED message");

    // Cross-page vocabulary isolation: a DONE slug from the warnings page is
    // unknown on the notes page and must render NOTHING there.
    const foreign = await harness.request(
      baseUrl,
      `${NOTES_PAGE}?done=warn_issued`,
      { cookieId: sessionIdOf.junior }
    );
    assert.ok(!foreign.body.includes("banner-"), "foreign slug stays invisible");
    const noteKnown = await harness.request(
      baseUrl,
      `${NOTES_PAGE}?error=content_too_long`,
      { cookieId: sessionIdOf.junior }
    );
    assert.ok(noteKnown.body.includes("too long"), "notes slug renders its fixed message");
  });
});

// ===========================================================================
// C. POST TIER LADDER — the §8.6 cross-cutting matrix on all three mutations
// ===========================================================================
describe("C. POST tier ladder — anon 302 · stranger/plain/cross generic 404", () => {
  const ALL = [
    ["issue", ISSUE_PATH],
    ["void", VOID_PATH],
    ["note", NOTE_PATH],
  ];

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
      const before = warnCount() + noteCount();
      for (const key of ["stranger", "plain"]) {
        const { res, body } = await post(path, {
          cookie: cookieOf[key],
          fields: { user_id: T_ISSUE, reason: "probe", warning_number: "1", content: "probe", _csrf: csrfOf[key] },
        });
        assert.equal(res.status, 404, `${label} via ${key}`);
        assert.equal(body, "Not found");
        assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
      }
      const cross = await post(path.replace(GUILD_A, GUILD_B), {
        cookie: cookieOf.admin,
        fields: { user_id: T_ISSUE, reason: "probe", warning_number: "1", content: "probe", _csrf: csrfOf.admin },
      });
      assert.equal(cross.res.status, 404, `${label} cross-guild never resolves (§8.6)`);
      assert.equal(cross.body, "Not found");
      assert.equal(warnCount() + noteCount(), before, `${label}: denials wrote nothing`);
      assert.equal(webAuditCount(), 0, `${label}: denials audited nothing`);
    });
  }
});

// ===========================================================================
// D. CSRF — the gate before the router (§8.7)
// ===========================================================================
describe("D. CSRF — missing/tampered ⇒ 403 with ZERO facade calls and ZERO rows", () => {
  const probes = [
    ["issue", ISSUE_PATH, { user_id: T_ISSUE, reason: "csrf probe" }],
    ["void", VOID_PATH, { warning_number: "1", reason: "csrf probe" }],
    ["note", NOTE_PATH, { user_id: T_NOTE, content: "csrf probe" }],
  ];

  for (const [label, path, fields] of probes) {
    it(`${label}: missing _csrf ⇒ 403, no facade call at all`, async () => {
      const before = webAuditCount();
      startWindow();
      const { res, body } = await post(path, { cookie: cookieOf.junior, fields });
      const calls = stopWindow();
      assert.equal(res.status, 403, label);
      assert.equal(body, "Forbidden", label);
      assert.deepEqual(calls, [], `${label}: CSRF denial never reached the service layer`);
      assert.equal(webAuditCount(), before);
      assert.equal(warnCount() + noteCount(), 0, `${label}: nothing stored`);
    });

    it(`${label}: tampered _csrf ⇒ 403, same zero-everything`, async () => {
      const before = webAuditCount();
      startWindow();
      const { res } = await post(path, {
        cookie: cookieOf.junior,
        fields: { ...fields, _csrf: "f".repeat(64) },
      });
      const calls = stopWindow();
      assert.equal(res.status, 403, label);
      assert.deepEqual(calls, []);
      assert.equal(webAuditCount(), before);
    });
  }
});

// ===========================================================================
// E. ISSUE positive — slash-identical args, row, audit, mirror, DM
// ===========================================================================
describe("E. warn issue — service parity through the facade recorder", () => {
  it("staff-tier issue ⇒ W-row + one web audit row (slash detail shape) + warn-log mirror", async () => {
    usersCache.set(T_ISSUE, makeCacheUser(T_ISSUE));
    api.updateGuildSettings(GUILD_A, { warn_dm_members: 1, warn_expiry_days: 0 });
    const before = webAuditCount();
    const dmBefore = dmLog.length;
    mirrorSpy.log.length = 0;
    startWindow();
    const { res, location } = await issuePost({
      user_id: T_ISSUE,
      reason: "  spam incident  ", // both sides trim for storage
    });
    const calls = stopWindow();
    await tick();

    assert.equal(res.status, 302);
    assert.equal(location, `${WARNINGS_PAGE}?done=warn_issued`, "PRG fixed slug");
    assert.equal(res.headers.get("cache-control"), "no-store");

    // ROW: the createWarning SERVICE's own work (sequential number, trim).
    const w = lastWarn();
    assert.ok(w, "warning row created");
    assert.equal(w.guild_id, GUILD_A);
    assert.equal(w.user_id, T_ISSUE);
    assert.equal(w.issuer_id, USER_JUNIOR, "issuer is the session actor");
    assert.equal(w.reason, "spam incident", "stored reason trimmed (repo parity)");
    assert.equal(w.warning_number, 1, "sequential W-ref allocation (repo's own)");
    assert.equal(w.voided_at, null);
    assert.equal(w.expires_at, null, "guild default 0 ⇒ never expires");

    // SERVICE LAYER: the slash helper ran THROUGH the facade; zero route SQL.
    const names = namesOf(calls);
    assert.ok(names.includes("createWarning"), "the slash's write helper ran via the facade");
    assert.equal(
      calls.filter((c) => c.name === "insertAdminAudit").length,
      1,
      "exactly one audit insert"
    );

    // SERVICE ARGS: slash handleAdd's exact createWarning contract (the web
    // omits ONLY what slash Discord enforces — everything else identical).
    const [issueArgs] = lastArgs.createWarning;
    assert.equal(issueArgs.guildId, GUILD_A);
    assert.equal(issueArgs.userId, T_ISSUE);
    assert.equal(issueArgs.issuerId, USER_JUNIOR);
    assert.equal(issueArgs.reason, "spam incident");
    assert.equal(issueArgs.relatedNoteId, null);
    assert.equal(issueArgs.expiresDays, null, "omitted ⇒ guild default (slash IntegerOption null)");
    assert.equal(issueArgs.guildDefaultDays, 0);
    assert.equal(issueArgs.evidenceMessageUrl, null);
    assert.equal(issueArgs.evidenceText, null);

    // AUDIT: one row, EXACT slash vocabulary + detail shape.
    assert.equal(webAuditCount(), before + 1);
    const rows = rowsOf("web", "warnings.add").filter((r) => r.target_id === T_ISSUE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin, "web");
    assert.equal(rows[0].target_type, "user");
    assert.equal(rows[0].actor_user_id, USER_JUNIOR);
    assert.deepEqual(rows[0].details, {
      warning_id: w.id,
      warning_number: 1,
      reason: "spam incident",
      expires_at: null,
      silent: false,
    });

    // MIRROR (§8.1-7): slash logWarnEvent path = warn-kind channel post.
    assert.equal(mirrorSpy.log.length, 1, "one channel mirror scheduled");
    assert.equal(mirrorSpy.log[0].kind, "warn", "warn-log channel (dedicated with audit fallback)");

    // DM: warn_dm_members ON + cached user ⇒ attempted through the seam.
    assert.equal(dmLog.length, dmBefore + 1, "member DM attempted");
    assert.equal(dmLog[dmBefore].to, T_ISSUE);
    const embed = dmLog[dmBefore].payload.embeds[0];
    assert.ok(embed.title.includes("Warning issued in Alpha HQ"), "guild name from cache");
    assert.ok(embed.fields.some((f) => f.name === "Warning" && f.value === "W-1"));
    assert.ok(embed.fields.some((f) => f.name === "Reason" && f.value === "spam incident"));
  });

  it("silent=1 skips the DM (slash silent option parity) but records silent:true", async () => {
    const dmBefore = dmLog.length;
    const { location } = await issuePost({ user_id: T_ISSUE, reason: "silent probe", silent: "1" });
    assert.equal(location, `${WARNINGS_PAGE}?done=warn_issued`);
    assert.equal(dmLog.length, dmBefore, "silent skips the member DM");
    const row = lastWarn();
    const audit = rowsOf("web", "warnings.add").find((r) => r.details.warning_id === row.id);
    assert.equal(audit.details.silent, true, "slash detail vocabulary carries silent");
  });

  it("warn_dm_members=0 skips the DM for everyone", async () => {
    api.updateGuildSettings(GUILD_A, { warn_dm_members: 0 });
    const dmBefore = dmLog.length;
    const { location } = await issuePost({ user_id: T_ISSUE, reason: "dm off probe" });
    assert.equal(location, `${WARNINGS_PAGE}?done=warn_issued`);
    assert.equal(dmLog.length, dmBefore, "guild DM toggle off ⇒ no DM (warnDmEnabled parity)");
    api.updateGuildSettings(GUILD_A, { warn_dm_members: 1 });
  });

  it("DM resolves via the MEMBER cache too; uncached members degrade like slash's member-miss (skipped, mutation still lands)", async () => {
    membersCache.set(T_MEMBER, makeCacheMember(T_MEMBER));
    const dmBefore = dmLog.length;
    const r1 = await issuePost({ user_id: T_MEMBER, reason: "member cache probe" });
    assert.equal(r1.location, `${WARNINGS_PAGE}?done=warn_issued`);
    assert.equal(dmLog.length, dmBefore + 1, "member.user resolved from cache ⇒ DM sent");

    // T_UNCACHE: valid snowflake, in NEITHER cache — honest skip, the warn
    // still lands (a web request never fetches).
    const r2 = await issuePost({ user_id: T_UNCACHE, reason: "uncached probe" });
    assert.equal(r2.location, `${WARNINGS_PAGE}?done=warn_issued`);
    assert.equal(dmLog.length, dmBefore + 1, "uncached ⇒ graceful skip, never a fetch");
    assert.ok(lastWarn().user_id === T_UNCACHE, "the warning itself is real");
  });

  it("guild default expiry applies; the override wins; 0 = never", async () => {
    api.updateGuildSettings(GUILD_A, { warn_expiry_days: 10 });
    await issuePost({ user_id: T_EVIDENCE, reason: "default expiry probe" });
    const def = lastWarn();
    assert.equal(
      def.expires_at - def.created_at,
      10 * DAY_MS,
      "guild default warn_expiry_days applied (slash resolveExpiryDays path)"
    );

    await issuePost({ user_id: T_EVIDENCE, reason: "override probe", expires_days: "5" });
    const over = lastWarn();
    assert.equal(over.expires_at - over.created_at, 5 * DAY_MS, "per-warn override wins (slash parity)");

    await issuePost({ user_id: T_EVIDENCE, reason: "never probe", expires_days: "0" });
    assert.equal(lastWarn().expires_at, null, "explicit 0 = never (slash min:0 semantics)");

    await issuePost({ user_id: T_EVIDENCE, reason: "max expiry probe", expires_days: "3650" });
    assert.equal(lastWarn().expires_at - lastWarn().created_at, 3650 * DAY_MS, "slash max:3650 edge");
    api.updateGuildSettings(GUILD_A, { warn_expiry_days: 0 });
  });

  it("evidence + linked note are stored exactly like /warn add", async () => {
    const note = api.createStaffNote({
      guildId: GUILD_A,
      userId: T_NOTE,
      authorId: USER_SENIOR,
      content: "link me probe",
    });
    const evidenceUrl = `https://discord.com/channels/${GUILD_A}/770000000000000001/770000000000000555`;
    const { location } = await issuePost({
      user_id: T_EVIDENCE,
      reason: "evidence probe",
      message: `${evidenceUrl}/`, // trailing slash → canonicalized
      evidence: "staff-only evidence",
      note: String(note.note_number),
    });
    assert.equal(location, `${WARNINGS_PAGE}?done=warn_issued`);
    const w = lastWarn();
    assert.equal(w.evidence_message_url, evidenceUrl, "repo-canonical link stored");
    assert.equal(w.evidence_text, "staff-only evidence");
    assert.equal(w.related_note_id, note.id, "note NUMBER resolved to the note row id (slash path)");
  });

  it("senior and admin can also issue (staff ≤ all tiers)", async () => {
    for (const key of ["senior", "admin"]) {
      const { location } = await issuePost({ user_id: T_ISSUE, reason: `issued by ${key}` }, key);
      assert.equal(location, `${WARNINGS_PAGE}?done=warn_issued`, `${key} passes the staff gate`);
    }
  });
});

// ===========================================================================
// F. VALIDATION — the /warn add + /note add bounds, slugs, zero side effects
// ===========================================================================
describe("F. validation mirrors slash bounds — slugs only, zero writes, zero audit", () => {
  const probes = [
    // issue — user
    { name: "issue: garbage user id", path: ISSUE_PATH, fields: { user_id: "not-a-user", reason: "x" }, location: `${WARNINGS_PAGE}?error=invalid_user` },
    { name: "issue: too-short user id", path: ISSUE_PATH, fields: { user_id: "42", reason: "x" }, location: `${WARNINGS_PAGE}?error=invalid_user` },
    { name: "issue: @everyone-shaped id (== guild id)", path: ISSUE_PATH, fields: { user_id: GUILD_A, reason: "x" }, location: `${WARNINGS_PAGE}?error=invalid_user` },
    { name: "issue: missing user field", path: ISSUE_PATH, fields: { reason: "x" }, location: `${WARNINGS_PAGE}?error=invalid_user` },
    // issue — reason
    { name: "issue: empty reason", path: ISSUE_PATH, fields: { user_id: T_ISSUE, reason: "" }, location: `${WARNINGS_PAGE}?error=missing_reason` },
    { name: "issue: whitespace reason", path: ISSUE_PATH, fields: { user_id: T_ISSUE, reason: "   \n " }, location: `${WARNINGS_PAGE}?error=missing_reason` },
    { name: "issue: reason 1001 chars", path: ISSUE_PATH, fields: { user_id: T_ISSUE, reason: "x".repeat(1001) }, location: `${WARNINGS_PAGE}?error=reason_too_long` },
    // issue — evidence
    { name: "issue: evidence message not a discord link", path: ISSUE_PATH, fields: { user_id: T_ISSUE, reason: "ok", message: "http://evil.example/x" }, location: `${WARNINGS_PAGE}?error=invalid_evidence_url` },
    { name: "issue: evidence message from ANOTHER guild", path: ISSUE_PATH, fields: { user_id: T_ISSUE, reason: "ok", message: `https://discord.com/channels/${GUILD_B}/1/2` }, location: `${WARNINGS_PAGE}?error=invalid_evidence_url` },
    { name: "issue: evidence text 501 chars", path: ISSUE_PATH, fields: { user_id: T_ISSUE, reason: "ok", evidence: "e".repeat(501) }, location: `${WARNINGS_PAGE}?error=invalid_evidence_text` },
    // issue — note link / expiry
    { name: "issue: unknown linked note number", path: ISSUE_PATH, fields: { user_id: T_ISSUE, reason: "ok", note: "99999" }, location: `${WARNINGS_PAGE}?error=invalid_note` },
    { name: "issue: note number 0 / junk", path: ISSUE_PATH, fields: { user_id: T_ISSUE, reason: "ok", note: "0" }, location: `${WARNINGS_PAGE}?error=invalid_note` },
    { name: "issue: expiry -1", path: ISSUE_PATH, fields: { user_id: T_ISSUE, reason: "ok", expires_days: "-1" }, location: `${WARNINGS_PAGE}?error=invalid_expiry` },
    { name: "issue: expiry 3651 (slash max 3650)", path: ISSUE_PATH, fields: { user_id: T_ISSUE, reason: "ok", expires_days: "3651" }, location: `${WARNINGS_PAGE}?error=invalid_expiry` },
    { name: "issue: expiry decimal", path: ISSUE_PATH, fields: { user_id: T_ISSUE, reason: "ok", expires_days: "3.5" }, location: `${WARNINGS_PAGE}?error=invalid_expiry` },
    // void
    { name: "void: junk warning number", path: VOID_PATH, fields: { warning_number: "x", reason: "ok" }, location: `${WARNINGS_PAGE}?error=invalid_warning_number` },
    { name: "void: warning number 0 (slash min:1)", path: VOID_PATH, fields: { warning_number: "0", reason: "ok" }, location: `${WARNINGS_PAGE}?error=invalid_warning_number` },
    { name: "void: empty void reason", path: VOID_PATH, fields: { warning_number: "1", reason: "" }, location: `${WARNINGS_PAGE}?error=void_reason_missing` },
    { name: "void: reason 1001 chars", path: VOID_PATH, fields: { warning_number: "1", reason: "r".repeat(1001) }, location: `${WARNINGS_PAGE}?error=void_reason_too_long` },
    // note
    { name: "note: garbage user id", path: NOTE_PATH, fields: { user_id: "<script>", content: "ok" }, location: `${NOTES_PAGE}?error=invalid_user` },
    { name: "note: empty content", path: NOTE_PATH, fields: { user_id: T_NOTE, content: "" }, location: `${NOTES_PAGE}?error=content_empty` },
    { name: "note: whitespace content", path: NOTE_PATH, fields: { user_id: T_NOTE, content: " \t " }, location: `${NOTES_PAGE}?error=content_empty` },
    { name: "note: content 2001 chars", path: NOTE_PATH, fields: { user_id: T_NOTE, content: "c".repeat(2001) }, location: `${NOTES_PAGE}?error=content_too_long` },
  ];

  for (const probe of probes) {
    it(`refuses: ${probe.name} ⇒ Location is the slug ONLY, zero writes, zero audit`, async () => {
      const warnBefore = warnCount();
      const noteBefore = noteCount();
      const auditBefore = webAuditCount();
      startWindow();
      const { res, location } = await post(probe.path, {
        cookie: cookieOf.junior,
        fields: { ...probe.fields, _csrf: csrfOf.junior },
      });
      const calls = stopWindow();
      assert.equal(res.status, 302, `${probe.name}: status`);
      assert.equal(location, probe.location, "PRG carries ONLY the whitelisted slug");
      assert.match(
        location,
        /^\/g\/\d+\/(warnings|notes)\?error=[a-z_]+$/,
        "Location shape: fixed path + fixed slug (no echo, §8.7)"
      );
      assert.deepEqual(writeCalls(calls), [], `${probe.name}: zero write helpers reached`);
      assert.equal(webAuditCount(), auditBefore, `${probe.name}: audited NOTHING`);
      assert.equal(warnCount(), warnBefore, `${probe.name}: no warning row`);
      assert.equal(noteCount(), noteBefore, `${probe.name}: no note row`);
    });
  }

  it("slash bounds ACCEPT at the edges: reason 1000, evidence 500", async () => {
    usersCache.set(T_EVIDENCE, makeCacheUser(T_EVIDENCE, { dm: false }));
    const r1000 = "a".repeat(1000);
    const ok = await issuePost({
      user_id: T_EVIDENCE,
      reason: r1000,
      evidence: "e".repeat(500),
    });
    assert.equal(ok.location, `${WARNINGS_PAGE}?done=warn_issued`, "slash max lengths accepted");
    const w = lastWarn();
    assert.equal(w.reason.length, 1000, "reason stored at the slash's max length");
    assert.equal(w.evidence_text.length, 500);

    const c2000 = "n".repeat(2000);
    const noteOk = await notePost({ user_id: T_NOTE, content: c2000 });
    assert.equal(noteOk.location, `${NOTES_PAGE}?done=note_added`);
    assert.equal(lastNote().content.length, 2000, "MAX_NOTE_CONTENT bound accepted");
  });

  it("bots are refused ONLY on proven cache evidence (slash target.bot parity)", async () => {
    usersCache.set(T_BOT_U, makeCacheUser(T_BOT_U, { bot: true, dm: false }));
    membersCache.set(T_BOT_M, makeCacheMember(T_BOT_M, { bot: true }));
    const warnBefore = warnCount();
    const auditBefore = webAuditCount();
    for (const target of [T_BOT_U, T_BOT_M]) {
      startWindow();
      const { location } = await issuePost({ user_id: target, reason: "warn a bot" });
      const calls = stopWindow();
      assert.equal(location, `${WARNINGS_PAGE}?error=bot_target`, `${target}: issue refused`);
      assert.deepEqual(namesOf(calls), [], "the refusal reached NO DB helper");
      startWindow();
      const note = await notePost({ user_id: target, content: "note a bot" });
      const noteCalls = stopWindow();
      assert.equal(note.location, `${NOTES_PAGE}?error=bot_target`, `${target}: note refused`);
      assert.deepEqual(namesOf(noteCalls), []);
    }
    assert.equal(warnCount(), warnBefore, "zero warnings written");
    assert.equal(webAuditCount(), auditBefore, "zero audit");
  });
});

// ===========================================================================
// G. VOID — happy / already-voided / cross-guild-zero-effects
// ===========================================================================
describe("G. warn void — slash /warn void twin", () => {
  let voidTarget = null; // the warn the happy path voids

  it("staff/senior/admin happy paths ⇒ void stamped with actor + reason (voidable rows)", async () => {
    // T_VOID gets three fresh warnings to void (one per tier actor).
    let juniorVoidArgs = null; // args of the JUNIOR void (service-arg parity)
    for (const key of ["junior", "senior", "admin"]) {
      const issue = await issuePost({ user_id: T_VOID, reason: `void target ${key}` }, key);
      assert.equal(issue.location, `${WARNINGS_PAGE}?done=warn_issued`);
      const w = lastWarn();
      if (key === "junior") voidTarget = w;
      usersCache.set(T_VOID, makeCacheUser(T_VOID));
      const dmBefore = dmLog.length;
      const { res, location } = await voidPost(
        { warning_number: String(w.warning_number), reason: `appeal upheld by ${key}` },
        key
      );
      // Capture THIS iteration's facade args (lastArgs holds only the latest
      // call; the junior iteration is the audit-parity subject below).
      if (key === "junior") juniorVoidArgs = [...lastArgs.voidWarning];
      assert.equal(res.status, 302);
      assert.equal(location, `${WARNINGS_PAGE}?done=warn_voided`, `${key} passes the staff gate`);
      const after = warnByNumber(w.warning_number);
      assert.ok(after.voided_at != null, "voided_at stamped");
      assert.equal(after.voided_by, { junior: USER_JUNIOR, senior: USER_SENIOR, admin: USER_ADMIN }[key]);
      assert.equal(after.void_reason, `appeal upheld by ${key}`);
      assert.equal(dmLog.length, dmBefore + 1, "void DM attempted (warn_dm_members on)");
    }

    // AUDIT: EXACT slash vocabulary + detail shape on the junior row.
    const rows = rowsOf("web", "warnings.void").filter((r) => r.target_id === String(voidTarget.id));
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.origin, "web");
    assert.equal(row.target_type, "warning", "slash targets the warning ROW");
    assert.equal(row.actor_user_id, USER_JUNIOR);
    assert.deepEqual(row.details, {
      warning_number: voidTarget.warning_number,
      subject_user_id: T_VOID,
      void_reason: "appeal upheld by junior",
    });

    // juniorVoidArgs = the facade call's ARGUMENT LIST (not a calls array):
    // [guildId, warningNumber, { voidedBy, voidReason }] — guild-scoped call.
    const voidArgs = juniorVoidArgs;
    assert.equal(voidArgs[0], GUILD_A, "guild-scoped by construction");
    assert.equal(voidArgs[1], voidTarget.warning_number);
    assert.equal(voidArgs[2].voidedBy, USER_JUNIOR);
    assert.deepEqual(voidArgs[2].voidReason, "appeal upheld by junior");
  });

  it("already-voided ⇒ rejected, the row untouched, ZERO new writes/audit", async () => {
    const before = warnByNumber(voidTarget.warning_number);
    const auditBefore = webAuditCount();
    const { location } = await voidPost({
      warning_number: String(voidTarget.warning_number),
      reason: "second void attempt",
    });
    assert.equal(location, `${WARNINGS_PAGE}?error=already_voided`);
    const after = warnByNumber(voidTarget.warning_number);
    assert.equal(after.voided_at, before.voided_at, "row byte-unchanged (already_voided throws pre-update)");
    assert.equal(after.void_reason, before.void_reason);
    assert.equal(webAuditCount(), auditBefore, "re-void audited NOTHING");
  });

  it("a warning number that exists ONLY in guild B resolves to NOTHING here — zero side effects", async () => {
    // Seed guild B with one MORE warning than guild A has numbers, so the
    // freshest B number does not exist in guild A at all.
    const maxA = api.db
      .prepare("SELECT COALESCE(MAX(warning_number), 0) AS n FROM warnings WHERE guild_id = ?")
      .get(GUILD_A).n;
    let bWarn = null;
    for (let n = 0; n <= maxA; n += 1) {
      bWarn = api.createWarning({
        guildId: GUILD_B,
        userId: B_SUBJECT,
        issuerId: USER_ADMIN,
        reason: `guild B row ${n}`,
      });
    }
    const auditBefore = webAuditCount();
    const { location } = await voidPost({
      warning_number: String(bWarn.warning_number),
      reason: "cross-guild probe",
    });
    assert.equal(location, `${WARNINGS_PAGE}?error=warn_not_found`);
    const bAfter = api.getWarning(GUILD_B, bWarn.warning_number);
    assert.equal(bAfter.voided_at, null, "guild B's warning was NEVER touched (§8.6 scoping)");
    assert.equal(webAuditCount(), auditBefore, "not-found audited NOTHING");
  });
});

// ===========================================================================
// H. NOTE add — row + audit + audit-channel mirror + NEVER DM the subject
// ===========================================================================
describe("H. note add — slash /note add twin", () => {
  it("happy path ⇒ row + web audit (slash detail shape) + AUDIT-kind mirror + NO DM ever", async () => {
    usersCache.set(T_NOTE, makeCacheUser(T_NOTE));
    const dmBefore = dmLog.length;
    const auditBefore = webAuditCount();
    mirrorSpy.log.length = 0;
    startWindow();
    const { res, location } = await notePost({ user_id: T_NOTE, content: "  context probe  " });
    const calls = stopWindow();
    await tick();

    assert.equal(res.status, 302);
    assert.equal(location, `${NOTES_PAGE}?done=note_added`);

    const n = lastNote();
    assert.equal(n.user_id, T_NOTE);
    assert.equal(n.author_id, USER_JUNIOR);
    assert.equal(n.content, "context probe", "stored trimmed (repo INVALID_CONTENT path)");

    const names = namesOf(calls);
    assert.ok(names.includes("createStaffNote"), "the slash's write helper ran via the facade");

    const rows = rowsOf("web", "notes.add").filter((r) => r.target_id === String(n.id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin, "web");
    assert.equal(rows[0].action, "notes.add");
    assert.equal(rows[0].target_type, "note");
    assert.equal(rows[0].actor_user_id, USER_JUNIOR);
    assert.deepEqual(rows[0].details, {
      note_number: n.note_number,
      subject_user_id: T_NOTE,
      content: "context probe", // snippet(≤500) of the short body
    });
    assert.equal(webAuditCount(), auditBefore + 1);

    // MIRROR: notes use the logConfigChange AUDIT channel kind (slash parity)
    // — never the warn-log channel, and NEVER a member DM.
    assert.equal(mirrorSpy.log.length, 1);
    assert.equal(mirrorSpy.log[0].kind, "audit");
    assert.equal(dmLog.length, dmBefore, "notes NEVER DM the subject (slash parity)");
  });
});

// ===========================================================================
// I. FAIL-CLOSED — the outcome is never silently claimed (§8.1-7)
// ===========================================================================
describe("I. audit-fail injection ⇒ generic 500, no claim, no audit row, no mirror", () => {
  it("insertAdminAudit throwing on issue: 500 'Internal error', no Location, NO mirror", async () => {
    api.updateGuildSettings(GUILD_A, { warn_dm_members: 0 });
    const auditBefore = webAuditCount();
    mirrorSpy.log.length = 0;
    recorder.auditThrow = true;
    const realError = console.error;
    console.error = () => {}; // the expected 500 logger is noise here
    let out;
    try {
      out = await issuePost({ user_id: T_FAILOPEN, reason: "fail closed probe" });
      await tick();
    } finally {
      recorder.auditThrow = false;
      console.error = realError;
    }
    assert.equal(out.res.status, 500, "audit failure must 500 (fail-closed)");
    assert.equal(out.body, "Internal error");
    assert.equal(out.location, null, "no success redirect — the outcome is never silently claimed");
    assert.equal(webAuditCount(), auditBefore, "the injected failure wrote no audit row");
    assert.equal(mirrorSpy.log.length, 0, "a failed insert schedules NO channel mirror");
    // Contract note: the SERVICE row (warnings) is already committed when the
    // audit insert throws — the response aborts (500), exactly like the
    // xp-grant fail-closed precedent. Re-voiding/auditing is a staff call.
  });

  it("insertAdminAudit throwing on note add: same generic 500 discipline", async () => {
    const auditBefore = webAuditCount();
    mirrorSpy.log.length = 0;
    recorder.auditThrow = true;
    const realError = console.error;
    console.error = () => {};
    let out;
    try {
      out = await notePost({ user_id: T_WEB_N, content: "fail closed note" });
      await tick();
    } finally {
      recorder.auditThrow = false;
      console.error = realError;
    }
    assert.equal(out.res.status, 500);
    assert.equal(out.location, null);
    assert.equal(webAuditCount(), auditBefore);
    assert.equal(mirrorSpy.log.length, 0);
  });
});

// ===========================================================================
// J. SLASH ↔ WEB PARITY (§8.11) — the real handlers on the SAME database
// ===========================================================================
describe("J. parity: equal table outcomes + same-shaped audit rows (slash = source of truth)", () => {
  /** Minimal slash-interaction mock (ManageGuild ⇒ requireStaff passes). */
  function makeInteraction({ options, userId = USER_JUNIOR, client = FAKE_CLIENT }) {
    const replies = [];
    return {
      replies,
      interaction: {
        guildId: GUILD_A,
        guild: { id: GUILD_A, name: "Alpha HQ" },
        user: { id: userId, username: "mod", tag: "mod#0001" },
        client,
        memberPermissions: { has: (bit) => bit === require("discord.js").PermissionFlagsBits.ManageGuild },
        reply: async (payload) => {
          replies.push(payload);
          return {};
        },
        options,
      },
    };
  }

  it("issue parity: web POST vs real handleWarn(add) — equal row outcome, audit differs ONLY by origin", async () => {
    api.updateGuildSettings(GUILD_A, { warn_dm_members: 0, warn_expiry_days: 0 });
    usersCache.set(T_SLASH, makeCacheUser(T_SLASH));

    // ---- web side (real HTTP through the full stack) ----
    const web = await issuePost({
      user_id: T_WEBP,
      reason: "parity incident",
      expires_days: "5",
      evidence: "shared evidence body",
    });
    assert.equal(web.location, `${WARNINGS_PAGE}?done=warn_issued`);
    const wWeb = lastWarn();

    // ---- slash side: the REAL handleWarn "add" (features/warnings) ----
    const { handlers: warnHandlers } = require("../src/features/warnings");
    const { interaction, replies } = makeInteraction({
      options: {
        getSubcommand: () => "add",
        getUser: (name) => {
          assert.equal(name, "user");
          return usersCache.get(T_SLASH); // cached user with a DM spy
        },
        getString: (name) => {
          if (name === "reason") return "parity incident";
          if (name === "message") return null;
          if (name === "evidence") return "shared evidence body";
          throw new Error(`unexpected getString ${name}`);
        },
        getBoolean: () => null,
        getInteger: (name) => (name === "expires_days" ? 5 : null),
      },
    });
    await warnHandlers.warn(interaction, {});
    assert.match(
      JSON.stringify(replies[0] || {}),
      /parity incident/,
      "the slash replied with its own success embed (sanity: the handler ran)"
    );
    const wSlash = lastWarn();
    assert.notEqual(wSlash.id, wWeb.id, "slash created its own row");

    // EQUAL WARNINGS-TABLE OUTCOME on every transport-independent column.
    // The SUBJECTS differ BY DESIGN (two different members were warned);
    // per-row ids/numbers/absolute ms are each transport's own row truth.
    assert.equal(wWeb.user_id, T_WEBP, "web row targets the web subject");
    assert.equal(wSlash.user_id, T_SLASH, "slash row targets the slash subject");
    for (const col of [
      "guild_id", "issuer_id", "reason", "voided_at", "voided_by",
      "void_reason", "related_note_id", "evidence_message_url", "evidence_text",
    ]) {
      assert.deepEqual(wWeb[col], wSlash[col], `column ${col} equal across transports`);
    }
    assert.equal(wWeb.expires_at - wWeb.created_at, 5 * DAY_MS);
    assert.equal(wSlash.expires_at - wSlash.created_at, 5 * DAY_MS, "same expiry semantics");

    // AUDIT: identical vocabulary/columns; details deep-equal once the
    // per-row identifiers (id/number/absolute timestamp) are checked against
    // each transport's OWN row — only origin differs (the whole point).
    const aWeb = rowsOf("web", "warnings.add").find((r) => r.details.warning_id === wWeb.id);
    const aSlash = rowsOf("slash", "warnings.add").find((r) => r.details.warning_id === wSlash.id);
    assert.ok(aWeb && aSlash, "one audit row per transport");
    assert.equal(aWeb.origin, "web");
    assert.equal(aSlash.origin, "slash");
    assert.equal(aWeb.action, aSlash.action);
    assert.equal(aWeb.target_type, aSlash.target_type);
    assert.equal(aWeb.actor_user_id, aSlash.actor_user_id, "same actor id on both paths");
    assert.deepEqual(
      { ...aWeb.details, warning_id: 0, warning_number: 0, expires_at: 0 },
      { ...aSlash.details, warning_id: 0, warning_number: 0, expires_at: 0 },
      "detail KEYS + reason + silent deep-equal across transports"
    );
    assert.equal(aWeb.details.reason, "parity incident");
    assert.equal(aWeb.details.silent, false);
    assert.equal(aSlash.details.silent, false);
    assert.equal(aWeb.details.warning_number, wWeb.warning_number, "details carry the transport's own row truth");
    assert.equal(aSlash.details.warning_number, wSlash.warning_number);
  });

  it("void parity: web void vs real handleVoid — equal row stamps, audit deep-equal modulo the row ref", async () => {
    const { handlers: warnHandlers } = require("../src/features/warnings");

    // ---- slash void ----
    const wSlash = lastWarn(); // the slash-issued parity warning
    const { interaction } = makeInteraction({
      options: {
        getSubcommand: () => "void",
        getInteger: (name) => {
          assert.equal(name, "id");
          return wSlash.warning_number;
        },
        getString: (name) => {
          assert.equal(name, "reason");
          return "appeal upheld — parity";
        },
      },
    });
    await warnHandlers.warn(interaction, {});
    const sStamped = api.getWarning(GUILD_A, wSlash.warning_number);
    assert.ok(sStamped.voided_at != null, "slash voided its row");

    // ---- web void (the web-issued parity warning) ----
    const wWeb = lastWarnBeforeSlashIssue(); // locate the WEB-issued twin below
    const target = rowsOf("web", "warnings.add").find((r) => r.details.warning_id === wWeb.id);
    assert.ok(target, "web parity warning has its audit row");
    const v = await voidPost({
      warning_number: String(wWeb.warning_number),
      reason: "appeal upheld — parity",
    });
    assert.equal(v.location, `${WARNINGS_PAGE}?done=warn_voided`);
    const wStamped = api.getWarning(GUILD_A, wWeb.warning_number);

    for (const col of ["voided_by", "void_reason"]) {
      assert.deepEqual(wStamped[col], sStamped[col], `void stamp ${col} equal across transports`);
    }

    const aWeb = rowsOf("web", "warnings.void").find((r) => r.target_id === String(wWeb.id));
    const aSlash = rowsOf("slash", "warnings.void").find((r) => r.target_id === String(wSlash.id));
    assert.ok(aWeb && aSlash, "one void audit row per transport");
    assert.equal(aWeb.origin, "web");
    assert.equal(aSlash.origin, "slash");
    assert.deepEqual(
      Object.keys(aWeb.details).sort(),
      Object.keys(aSlash.details).sort(),
      "same void detail keys across transports"
    );
    assert.equal(aWeb.details.subject_user_id, T_WEBP, "per-side subject (by design)");
    assert.equal(aSlash.details.subject_user_id, T_SLASH);
    assert.deepEqual(aWeb.details.void_reason, aSlash.details.void_reason);
    assert.equal(aWeb.details.warning_number, wWeb.warning_number);
    assert.equal(aSlash.details.warning_number, wSlash.warning_number);
  });

  it("note parity: web POST vs real handleNote(add) — equal note + audit deep-equal", async () => {
    api.updateGuildSettings(GUILD_A, { warn_dm_members: 0 });
    const { handlers: noteHandlers } = require("../src/features/staffNotes");

    const web = await notePost({ user_id: T_WEB_N, content: "parity note body" });
    assert.equal(web.location, `${NOTES_PAGE}?done=note_added`);
    const nWeb = lastNote();

    const { interaction } = makeInteraction({
      options: {
        getSubcommand: () => "add",
        getUser: (name) => {
          assert.equal(name, "user");
          return { id: T_SLASH_N, bot: false, username: "subject", tag: "subject#0001" };
        },
        getString: (name) => {
          assert.equal(name, "content");
          return "parity note body";
        },
      },
    });
    await noteHandlers.note(interaction, {});
    const nSlash = lastNote();

    // Equal outcome on every transport-independent column; the SUBJECTS
    // differ by design (two different members were noted).
    for (const col of ["guild_id", "author_id", "deleted_at"]) {
      assert.deepEqual(nWeb[col], nSlash[col], `column ${col} equal across transports`);
    }
    assert.equal(nWeb.user_id, T_WEB_N, "web row targets the web subject");
    assert.equal(nSlash.user_id, T_SLASH_N, "slash row targets the slash subject");
    assert.equal(nWeb.content, nSlash.content, "same stored body");

    const aWeb = rowsOf("web", "notes.add").find((r) => r.target_id === String(nWeb.id));
    const aSlash = rowsOf("slash", "notes.add").find((r) => r.target_id === String(nSlash.id));
    assert.ok(aWeb && aSlash, "one note audit row per transport");
    assert.equal(aWeb.origin, "web");
    assert.equal(aSlash.origin, "slash");
    assert.deepEqual(
      Object.keys(aWeb.details).sort(),
      Object.keys(aSlash.details).sort(),
      "same note detail keys across transports"
    );
    assert.equal(aWeb.details.subject_user_id, T_WEB_N, "per-side subject (by design)");
    assert.equal(aSlash.details.subject_user_id, T_SLASH_N);
    assert.deepEqual(aWeb.details.content, aSlash.details.content, "snippet(500) content equal");
    assert.equal(aWeb.details.note_number, nWeb.note_number);
    assert.equal(aSlash.details.note_number, nSlash.note_number);
  });
});

/** Locate the WEB-issued parity warning (suite J ordering helper). */
function lastWarnBeforeSlashIssue() {
  return api.db
    .prepare("SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1")
    .get(GUILD_A, T_WEBP);
}

// ===========================================================================
// K. Stored hostile input stays escaped (Phase-1 XSS pins hold on new rows)
// ===========================================================================
describe("K. hostile stored content renders escaped (§8.7, Phase-1 pins)", () => {
  it("a stored warning reason with markup renders ONLY escaped in the list", async () => {
    const evil = `<script>alert("mod-issue")</script>`;
    const { location } = await issuePost({ user_id: T_EVIDENCE, reason: evil });
    assert.equal(location, `${WARNINGS_PAGE}?done=warn_issued`, "in-bounds hostile text is a normal warn");
    const page = await harness.request(baseUrl, `${WARNINGS_PAGE}?u=${T_EVIDENCE}`, {
      cookieId: sessionIdOf.admin,
    });
    assert.equal(page.status, 200);
    assert.ok(!page.body.includes(`<script>alert("mod-issue")`), "no raw script from a stored reason");
    assert.ok(page.body.includes("&lt;script&gt;alert(&quot;mod-issue&quot;)"), "escaped echo instead");
  });

  it("a stored note body with attribute breakout renders escaped", async () => {
    const evil = `"><svg onload=MODPROBE>`;
    const { location } = await notePost({ user_id: T_NOTE, content: evil });
    assert.equal(location, `${NOTES_PAGE}?done=note_added`);
    const page = await harness.request(baseUrl, `${NOTES_PAGE}?u=${T_NOTE}`, {
      cookieId: sessionIdOf.admin,
    });
    assert.ok(!page.body.includes('"><svg onload=MODPROBE>'), "no attribute-position breakout");
    assert.ok(page.body.includes("&quot;&gt;&lt;svg onload=MODPROBE&gt;"), "escaped echo instead");
  });
});
