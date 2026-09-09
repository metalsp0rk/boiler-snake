/**
 * Subtask 28 — PHASE 3 XP GRANT (roadmap/web-admin.md §8.6 "XP" row: grant xp
 * = ADMIN mutate; §8.8 Phase 3; AGENTS.md §4 "/grantxp ManageGuild-only" +
 * intent 6 "max award 1e9 per event").
 *
 * Everything the web grant does must be indistinguishable from the SLASH at
 * the service / DB / audit boundary, and everything it refuses must write
 * NOTHING. Mechanism: REAL Express 5 app on ephemeral ports, REAL SQLite,
 * fake Discord transport under the REAL createGuildAccessResolver (Phase-2
 * gate boot discipline — sessions minted offline, csrf derived, one loadDb).
 *
 * What this suite pins:
 *  A. MUTATION CONTRACT — the methodGate registry and the mounted POST route
 *     are minted in lockstep from ONE template (POST /g/:guildId/xp/grant).
 *  B. FORM PAGE (GET, same path) — admin-only end to end: admin 200 (shell +
 *     hidden _csrf + the three field names); staff/senior 403; plain/stranger
 *     generic 404; anon 302 login; cross-guild generic 404. PRG flash renders
 *     ONLY whitelisted slugs — a hostile ?error= value never echoes.
 *  C. TIER LADDER (POST) — anon 302 · stranger/plain/cross generic 404 ·
 *     junior AND senior fixed 403 with zero XP change + zero audit (§8.6).
 *  D. CSRF — missing / tampered token ⇒ 403 with ZERO facade calls and ZERO
 *     XP change; the identical body passes only with the valid token (§8.7).
 *  E. SERVICE PARITY — a counting proxy on the shared src/db facade proves
 *     the grant runs THROUGH awardXp (addXp + logActivity recorded INSIDE
 *     the service, insertAdminAudit exactly once) and NEVER touches the
 *     direct-write helpers (setXp / updateGuildSettings / role-mapping
 *     writes) from the route. An activity_log kind='admin_grant' row is the
 *     service's own fingerprint.
 *     A second app with a call-through services.awardXp spy proves the
 *     service receives EXACTLY the slash's argument object
 *     (src/features/xp/index.js:448-455): keys {guild, userId, delta,
 *     activityKind, levelXpFactor, source}, activityKind/source
 *     'admin_grant', guild.id server-derived, cache-only members seam.
 *  F. ROLE SYNC — with a level_roles mapping and the target PRESENT in the
 *     bot's (cache-only) member cache, crossing the level threshold makes the
 *     REAL service call member.roles.add — the route never syncs itself.
 *  G. VALIDATION — mirrors /grantxp: amount must be a whole number in
 *     [1, MAX_XP_AWARD] (0, negative, decimal, >1e9, >10 digits, garbage all
 *     refused; 1 and exactly 1e9 accepted), user a 5–20-digit snowflake
 *     (==guild-id @everyone shape refused), reason ≤200 chars. Every refusal
 *     is a 302 to a WHITELISTED error slug with ZERO writes, ZERO audit, and
 *     no echo of the submitted value in the Location (§8.7).
 *  H. BOTS — refused only when a CACHE PROVES bot membership (slash
 *     `target.bot` refusal, index.js:429), zero writes; never a fetch.
 *  I. UNKNOWN USER — per the slash evidence (no existence check; addXp's
 *     ensureUser auto-creates the row; member-miss only skips role sync,
 *     awardXp.js:49-51): the grant SUCCEEDS, before_xp 0, one audit row.
 *  J. FAIL-CLOSED — insertAdminAudit throwing ⇒ generic 500, no Location,
 *     no audit row, NO channel mirror scheduled (§8.1-7: the outcome is
 *     never silently claimed).
 *  K. SLASH↔WEB PARITY (§8.11) — the REAL handleGrantXp (mock interaction,
 *     real router-free handler invocation on the SAME database) and the web
 *     POST with the same amount/reason/baseline yield EQUAL XP totals and
 *     SAME-SHAPED admin_audit rows (identical columns + deep-equal details;
 *     only origin differs: 'web' vs 'slash').
 *
 * Fully offline. Sentinel secrets are clearly fake (AGENTS.md). Runtime ≪ 60s.
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
const { MAX_XP_AWARD, levelFromXp } = require("../src/core/xpMath");

// ---------------------------------------------------------------------------
// Clearly-fake sentinels / placeholders ONLY (AGENTS.md: never realistic).
// ---------------------------------------------------------------------------
const SESSION_SECRET = "test-xpgrant-sentinel-session-secret-NOT-REAL-028";

const GUILD_A = "320000000000000001"; // bot + every test user
const GUILD_CROSS = "320000000000000002"; // bot guild the users are NOT in

const USER_ADMIN = "458190112345678901"; // owner snapshot ⇒ tier admin
const USER_JUNIOR = "458190112345678902"; // junior staff role ⇒ tier staff
const USER_SENIOR = "458190112345678903"; // senior staff role ⇒ tier senior
const USER_PLAIN = "458190112345678904"; // guild-A member, no staff role
const USER_STRANGER = "458190112345678905"; // member of NOTHING

// Tier-resolution roles (NOT snowflake-shaped, so they can never be confused
// with grant targets — the phase-2-gate trick).
const ROLE_JUNIOR_TIER = "role-junior-staff";
const ROLE_SENIOR_TIER = "role-senior-staff";

// Grant targets (snowflake-shaped; NONE is in the users table unless the
// test seeds it; only the ones the role-sync test adds are in the member
// cache).
const USER_T_POS = "458190112345678911"; // admin positive path
const USER_T_SPY = "458190112345678912"; // service-arg spy path
const USER_T_SYNC = "458190112345678913"; // role-sync path (member cached)
const USER_T_MIN = "458190112345678914"; // amount=1 boundary
const USER_T_CAP = "458190112345678915"; // amount=MAX_XP_AWARD boundary
const USER_T_R200 = "458190112345678916"; // reason=200 boundary
const USER_T_AUDITFAIL = "458190112345678917"; // fail-closed path
const USER_T_REPLAY = "458190112345678923"; // CSRF replay-doctrine path
const USER_T_SLASH = "458190112345678918"; // slash side of the parity test
const USER_T_WEBPARITY = "458190112345678919"; // web side of the parity test
const USER_T_UNKNOWN = "458190112345678920"; // unknown-user parity (no row)
const USER_BOT_USERS = "458190112345678921"; // proven bot via users cache
const USER_BOT_MEMBER = "458190112345678922"; // proven bot via member cache

const ROLE_LEVEL_SYNC = "500000000000000301"; // level→role mapping subject

const GRANT_PATH = `/g/${GUILD_A}/xp/grant`;
const GRANT_TEMPLATE = "/g/:guildId/xp/grant";

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
// Fake Discord transport under the REAL resolver (phase-2-gate pattern)
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
// Fake discord.js client — CACHE-ONLY surfaces. Any network method a request
// path might try is simply absent here, so a fetch would surface as a crash
// instead of silently leaving the process (the cache-only seam contract).
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} userId → member mock (cache-only member seam) */
const membersCache = new Map();
/** @type {Map<string, object>} userId → user mock (cache-only bot probe) */
const usersCache = new Map();

const FAKE_GUILD = {
  id: GUILD_A,
  members: { cache: membersCache }, // NO members.fetch — the route shim must
  // resolve from this cache only and never invent one.
  roles: { cache: { get: () => undefined } },
  channels: { cache: { get: () => undefined } },
  me: { roles: { highest: { position: 100 } } },
};

const FAKE_CLIENT = {
  guilds: { cache: { get: (id) => (id === GUILD_A ? FAKE_GUILD : undefined) } },
  users: { cache: usersCache },
  channels: { cache: { get: () => undefined } },
};

/**
 * A discord.js-shaped member mock whose roles.add/remove RECORD what the
 * (real) service sync calls — never a real Discord write.
 */
function makeMember(userId, { bot = false } = {}) {
  const cache = new Map();
  const member = {
    id: userId,
    guild: FAKE_GUILD,
    user: { id: userId, bot, username: `m${userId.slice(-3)}` },
    added: [],
    removed: [],
    roles: {
      cache,
      async add(roleId) {
        cache.set(roleId, { id: roleId });
        member.added.push(roleId);
      },
      async remove(roleId) {
        cache.delete(roleId);
        member.removed.push(roleId);
      },
    },
  };
  return member;
}

// ---------------------------------------------------------------------------
// SERVICE-LAYER counting proxy on the SHARED src/db facade object (gate
// pattern). Installed BEFORE createWebApp so the audit middleware captures
// the wrapped insertAdminAudit, and BEFORE features/xp is required so the
// awardXp service's top-level `require("../db")` destructure (addXp,
// logActivity, getGuildSettings — services/awardXp.js:1) binds THE WRAPPED
// helpers: every service-internal XP write lands in this recorder.
// ---------------------------------------------------------------------------

const WATCH = new Set([
  "addXp",
  "logActivity",
  "setXp",
  "updateGuildSettings",
  "upsertLevelRole",
  "deleteLevelRole",
  "addStaffRole",
  "removeStaffRole",
  "insertAdminAudit",
]);

/** Writes the DIRECT-DB tripwire refuses on ANY path of this route. */
const FORBIDDEN_WRITES = new Set([
  "setXp",
  "updateGuildSettings",
  "upsertLevelRole",
  "deleteLevelRole",
  "addStaffRole",
  "removeStaffRole",
]);

const recorder = { active: false, log: [], auditThrow: false };

function installFacadeRecorder(F) {
  const originals = {};
  for (const name of WATCH) {
    if (typeof F[name] !== "function") {
      throw new Error(`grant precondition: facade helper "${name}" missing (renamed?)`);
    }
    originals[name] = F[name];
    F[name] = function recorded(...args) {
      if (recorder.active) recorder.log.push({ name, args });
      if (name === "insertAdminAudit" && recorder.auditThrow) {
        const err = new Error("admin_audit insert failed (grant injection)");
        err.code = "GRANT_AUDIT_INJECT";
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
const writeCalls = (log) => log.filter((c) => FORBIDDEN_WRITES.has(c.name));
const namesOf = (log) => log.map((c) => c.name);

// The REAL awardXp the spy delegates to — required AFTER the recorder so its
// destructured facade helpers are the wrapped ones.
const realAwardXp = require("../src/services/awardXp").awardXp;

/**
 * Service call-through spy (registered on the SECOND app via options.services
 * — the same DI seam style as settingsData/integrationsData): records the
 * EXACT arguments the route hands the service, then delegates unchanged.
 */
const serviceSpies = [];
function spyAwardXp(...args) {
  serviceSpies.push(args);
  return realAwardXp(...args);
}

// ---------------------------------------------------------------------------
// Mirror spy (§8.1-7): dispatch resolves the poster properties at dispatch
// time on the real auditLog module object; swapping them + binding a fake
// client proves whether a mirror WAS scheduled.
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
  bindAuditClient({ __grantFakeAuditClient: true });
}
function restoreMirrorSpy() {
  auditLogMod.sendAuditLog = mirrorSpy.sendAudit;
  auditLogMod.sendWarnLog = mirrorSpy.sendWarn;
  bindAuditClient(null);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// ---------------------------------------------------------------------------
// Synchronous boot: env → tier rows → sessions → spies → APPS → servers.
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
  botGuilds: async () => [GUILD_A, GUILD_CROSS],
  now: Date.now,
  ttlMs: 3_600_000,
});

function bootApp(extra = {}) {
  const app = createWebApp({
    guildAccess: resolver,
    botGuilds: async () => [GUILD_A, GUILD_CROSS],
    getClient: () => FAKE_CLIENT,
    ...extra,
  });
  const server = http.createServer(app);
  return { app, server };
}

// The grant route's service override is threaded via options.services (the
// app.js mount passes it through exactly like the sibling data seams).
const main = bootApp();
const spy = bootApp({ services: { awardXp: spyAwardXp } });

/** @type {{app, server}} pair + base urls, resolved in before(). */
let baseUrl = "";
let spyUrl = "";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** urlencoded POST (real form semantics, redirect:manual). */
async function post(urlBase, path, { cookie, fields } = {}) {
  const res = await fetch(`${urlBase}${path}`, {
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

/** Admin-tier valid-token grant POST. */
const grantPost = (fields, urlBase = baseUrl) =>
  post(urlBase, GRANT_PATH, {
    cookie: cookieOf.admin,
    fields: { ...fields, _csrf: csrfOf.admin },
  });

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
const grantRows = (origin, targetId) =>
  auditRows(origin).filter((r) => r.action === "xp.grant" && r.target_id === targetId);
const xpOf = (userId) => api.getXp(GUILD_A, userId);
const activityKinds = (userId) =>
  api.db
    .prepare("SELECT kind FROM activity_log WHERE guild_id = ? AND user_id = ?")
    .all(GUILD_A, userId)
    .map((r) => r.kind);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
before(async () => {
  for (const { server } of [main, spy]) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  baseUrl = `http://127.0.0.1:${main.server.address().port}`;
  spyUrl = `http://127.0.0.1:${spy.server.address().port}`;
});

after(() => {
  main.server.closeAllConnections?.();
  spy.server.closeAllConnections?.();
  main.server.close();
  spy.server.close();
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
  it("exactly ONE POST /g/:guildId/xp/grant registry entry, /g/:guildId-scoped", () => {
    const entries = main.app.locals.webMutations.filter(
      (m) => m.method === "POST" && m.path === GRANT_TEMPLATE
    );
    assert.equal(entries.length, 1, "exactly one grant registration");
    assert.match(entries[0].path, /^\/g\/:guildId\//);
    assert.ok(
      !main.app.locals.webMutations.some(
        (m) => m.path.startsWith("/g/:guildId/xp/") && m.path !== GRANT_TEMPLATE
      ),
      "no other /xp/ mutation sneaked in"
    );
  });

  it("the mounted POST route template equals the registry template (one template constant)", () => {
    const router = main.app.router || main.app._router;
    const mounted = [];
    for (const layer of router.stack) {
      const route = layer && layer.route;
      if (!route || !route.methods || route.methods.post !== true) continue;
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      mounted.push(...paths);
    }
    assert.ok(
      mounted.includes(GRANT_TEMPLATE),
      "app.post(GRANT_TEMPLATE) is mounted with the SAME template the registry carries"
    );
  });
});

// ===========================================================================
// B. GRANT FORM PAGE (GET) — admin-only page + whitelisted PRG flash
// ===========================================================================
describe("B. GET /g/:guildId/xp/grant — admin-only form, whitelist-only flash", () => {
  it("admin ⇒ 200 shell page with the CSRF hidden field + the field contract", async () => {
    const res = await harness.request(baseUrl, GRANT_PATH, { cookieId: sessionIdOf.admin });
    assert.equal(res.status, 200);
    assert.ok(res.body.includes(harness.SHELL_MARKER), "renders inside the guild shell");
    assert.ok(res.body.includes("<h1>Grant XP"), "the page heading");
    assert.ok(
      res.body.includes(`action="/g/${GUILD_A}/xp/grant"`),
      "form posts to the exact mutation path"
    );
    assert.ok(res.body.includes('name="_csrf"'), "hidden CSRF field (double-submit half)");
    for (const field of ['name="user_id"', 'name="amount"', 'name="reason"']) {
      assert.ok(res.body.includes(field), `form field ${field}`);
    }
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("wrong tier in-guild ⇒ FIXED 403: junior and senior never even see a form that 403s", async () => {
    for (const key of ["junior", "senior"]) {
      await harness.runOutcome({
        base: baseUrl,
        url: GRANT_PATH,
        cookieId: sessionIdOf[key],
        expect: harness.expectForbidden(),
        label: `GET ${key}`,
      });
    }
  });

  it("ladder: anon 302 login · plain/stranger generic 404 · cross-guild generic 404", async () => {
    await harness.runOutcome({
      base: baseUrl,
      url: GRANT_PATH,
      expect: harness.expectLoginRedirect(`/auth/login?guild=${GUILD_A}`),
      label: "GET anon",
    });
    for (const key of ["plain", "stranger"]) {
      await harness.runOutcome({
        base: baseUrl,
        url: GRANT_PATH,
        cookieId: sessionIdOf[key],
        expect: harness.expectGenericNotFound({ forbid: [csrfOf.admin] }),
        label: `GET ${key}`,
      });
    }
    await harness.runOutcome({
      base: baseUrl,
      url: `/g/${GUILD_CROSS}/xp/grant`,
      cookieId: sessionIdOf.admin,
      expect: harness.expectGenericNotFound({ forbid: [GUILD_CROSS, csrfOf.admin] }),
      label: "GET cross-guild",
    });
  });

  it("PRG flash renders ONLY whitelisted slugs — a hostile query never echoes", async () => {
    const hostile = encodeURIComponent('<script>alert("xpg-h-1")</script>');
    const junk = await harness.request(baseUrl, `${GRANT_PATH}?error=${hostile}&done=bogus`, {
      cookieId: sessionIdOf.admin,
    });
    assert.equal(junk.status, 200);
    assert.ok(!junk.body.includes("xpg-h-1"), "hostile flash value never echoed (§8.7)");
    assert.ok(!junk.body.includes("banner-"), "unknown slugs render NO banner");

    const known = await harness.request(baseUrl, `${GRANT_PATH}?error=invalid_amount`, {
      cookieId: sessionIdOf.admin,
    });
    assert.equal(known.status, 200);
    assert.ok(
      known.body.includes("Invalid XP amount"),
      "the whitelisted slug renders its FIXED message"
    );
  });
});

// ===========================================================================
// C. POST TIER LADDER — the §8.6 cross-cutting matrix on the mutation
// ===========================================================================
describe("C. POST tier ladder — anon 302 · stranger/plain/cross 404 · junior/senior 403", () => {
  it("anon POST ⇒ 302 login, NOTHING mutated", async () => {
    await harness.runOutcome({
      base: baseUrl,
      url: GRANT_PATH,
      method: "POST",
      cookieId: null,
      expect: harness.expectLoginRedirect(`/auth/login?guild=${GUILD_A}`),
      label: "anon POST",
    });
    assert.equal(xpOf(USER_T_POS), 0, "anon grant changed nothing");
  });

  it("stranger / plain / cross-guild with a VALID csrf ⇒ the SAME generic 404 bytes", async () => {
    for (const key of ["stranger", "plain"]) {
      const { res, body } = await post(baseUrl, GRANT_PATH, {
        cookie: cookieOf[key],
        fields: { user_id: USER_T_POS, amount: "5", _csrf: csrfOf[key] },
      });
      assert.equal(res.status, 404, `${key} status`);
      assert.equal(body, "Not found");
      assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    }
    const cross = await post(baseUrl, `/g/${GUILD_CROSS}/xp/grant`, {
      cookie: cookieOf.admin,
      fields: { user_id: USER_T_POS, amount: "5", _csrf: csrfOf.admin },
    });
    assert.equal(cross.res.status, 404, "cross-guild never resolves (§8.6)");
    assert.equal(cross.body, "Not found");
    assert.equal(xpOf(USER_T_POS), 0, "denials wrote nothing");
    assert.equal(webAuditCount(), 0, "denials audited nothing");
  });

  it("in-guild junior AND senior ⇒ FIXED 403, zero XP change, zero audit, zero writes", async () => {
    for (const key of ["junior", "senior"]) {
      const before = webAuditCount();
      startWindow();
      const { res, body } = await post(baseUrl, GRANT_PATH, {
        cookie: cookieOf[key],
        fields: { user_id: USER_T_POS, amount: "500", reason: "tier probe", _csrf: csrfOf[key] },
      });
      const calls = stopWindow();
      assert.equal(res.status, 403, `${key} on admin-tier grant (AGENTS.md §4)`);
      assert.equal(body, "Forbidden");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.deepEqual(namesOf(calls), [], `${key} denial reached no DB helper`);
      assert.equal(webAuditCount(), before, `${key} denial audited nothing`);
    }
    assert.equal(xpOf(USER_T_POS), 0, "wrong tier left XP untouched");
  });
});

// ===========================================================================
// D. CSRF — the gate before the router (§8.7)
// ===========================================================================
describe("D. CSRF — missing/tampered ⇒ 403 with ZERO XP change and ZERO service reach", () => {
  it("missing _csrf ⇒ 403, no facade call at all", async () => {
    const before = webAuditCount();
    startWindow();
    const { res, body } = await post(baseUrl, GRANT_PATH, {
      cookie: cookieOf.admin,
      fields: { user_id: USER_T_POS, amount: "250" },
    });
    const calls = stopWindow();
    assert.equal(res.status, 403);
    assert.equal(body, "Forbidden");
    assert.deepEqual(calls, [], "CSRF denial never reached the service layer");
    assert.equal(webAuditCount(), before);
    assert.equal(xpOf(USER_T_POS), 0);
  });

  it("tampered _csrf ⇒ 403, same zero-everything", async () => {
    const before = webAuditCount();
    startWindow();
    const { res } = await post(baseUrl, GRANT_PATH, {
      cookie: cookieOf.admin,
      fields: { user_id: USER_T_POS, amount: "250", _csrf: "f".repeat(64) },
    });
    const calls = stopWindow();
    assert.equal(res.status, 403);
    assert.deepEqual(calls, []);
    assert.equal(webAuditCount(), before);
    assert.equal(xpOf(USER_T_POS), 0);
  });

  it("the IDENTICAL body passes with the valid token (replay doctrine)", async () => {
    api.setXp(GUILD_A, USER_T_REPLAY, 0);
    const { res, location, body } = await grantPost({
      user_id: USER_T_REPLAY,
      amount: "250",
      reason: "csrf doctrine",
    });
    assert.equal(res.status, 302);
    assert.equal(location, `${GRANT_PATH}?done=xp_granted`);
    assert.equal(body, "");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(xpOf(USER_T_REPLAY), 250);
  });
});

// ===========================================================================
// E. SERVICE PARITY — the grant runs THROUGH awardXp, never past it
// ===========================================================================
describe("E. service parity — write helpers intercepted INSIDE the service", () => {
  it("admin positive: exact XP delta + service helpers + exactly ONE web audit row", async () => {
    api.setXp(GUILD_A, USER_T_POS, 100);
    const before = webAuditCount();
    mirrorSpy.log.length = 0;
    startWindow();
    const { res, location } = await grantPost({
      user_id: USER_T_POS,
      amount: "250",
      reason: "parity bonus",
    });
    const calls = stopWindow();
    await tick();

    assert.equal(res.status, 302);
    assert.equal(location, `${GRANT_PATH}?done=xp_granted`, "PRG to the grant page, fixed slug");
    assert.equal(xpOf(USER_T_POS), 350, "XP increased EXACTLY by the amount (100 + 250)");

    // The awardXp SERVICE's own writes, intercepted on the shared facade:
    const names = namesOf(calls);
    assert.ok(names.includes("addXp"), "the slash's write helper ran (via the service)");
    assert.ok(names.includes("logActivity"), "the service's activity log ran");
    assert.equal(
      calls.filter((c) => c.name === "insertAdminAudit").length,
      1,
      "exactly one audit insert (route's own — the service writes no audit row)"
    );
    assert.deepEqual(writeCalls(calls), [], "ZERO direct-write helper calls — the route never bypasses the service (§8.6)");
    assert.deepEqual(
      activityKinds(USER_T_POS).filter((k) => k === "admin_grant").length >= 1,
      true,
      "activity_log kind='admin_grant' — the service's fingerprint"
    );

    // AUDIT: one row, slash vocabulary + shape, origin 'web'.
    assert.equal(webAuditCount(), before + 1, "exactly one new web audit row");
    const rows = grantRows("web", USER_T_POS);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.origin, "web");
    assert.equal(row.action, "xp.grant");
    assert.equal(row.target_type, "user", "target=user, mirroring the slash record");
    assert.equal(row.actor_user_id, USER_ADMIN);
    assert.deepEqual(row.details, {
      amount: 250,
      before_xp: 100,
      after_xp: 350,
      reason: "parity bonus",
    });

    // MIRROR: the slash posts logConfigChange "XP granted" → the web mirror
    // must be scheduled exactly once (§8.1-7 DB-first, embed = mirror).
    assert.equal(mirrorSpy.log.length, 1, "channel mirror scheduled once");
    assert.equal(mirrorSpy.log[0].kind, "audit");
  });

  it("service spy: the EXACT slash argument object reaches awardXp (index.js:448–455)", async () => {
    api.setXp(GUILD_A, USER_T_SPY, 0);
    serviceSpies.length = 0;
    const { res, location } = await grantPost(
      { user_id: USER_T_SPY, amount: "250", reason: "spy args" },
      spyUrl
    );
    assert.equal(res.status, 302, "spy app delegates and completes");
    assert.equal(location, `${GRANT_PATH}?done=xp_granted`);
    assert.equal(xpOf(USER_T_SPY), 250, "the call-through spy ran the REAL service");

    assert.equal(serviceSpies.length, 1, "the grant flows through the service exactly once");
    const [clientArg, opts] = serviceSpies[0];
    assert.equal(clientArg, FAKE_CLIENT, "the getClient cache seam is threaded to the service");
    assert.deepEqual(
      Object.keys(opts).sort(),
      ["activityKind", "delta", "guild", "levelXpFactor", "source", "userId"],
      "the service options are EXACTLY the slash handler's arg object"
    );
    assert.equal(opts.userId, USER_T_SPY);
    assert.equal(opts.delta, 250);
    assert.equal(opts.activityKind, "admin_grant");
    assert.equal(opts.source, "admin_grant");
    assert.equal(
      opts.levelXpFactor,
      api.getGuildSettings(GUILD_A).level_xp_factor,
      "levelXpFactor read from guild settings (slash: settings.level_xp_factor)"
    );
    assert.equal(opts.guild.id, GUILD_A, "server-derived guild id (never a form field)");
    assert.equal(typeof opts.guild.members.fetch, "function", "cache-only member seam exists");
    assert.ok(
      !("member" in opts),
      "no member injected — the service resolves it itself, like the slash"
    );
  });

  it("the cache-only guild seam NEVER fetches: an uncached member still grants (slash member-miss parity)", async () => {
    // USER_T_UNKNOWN: valid snowflake, NO users row, NOT in the member cache.
    // Slash evidence: handleGrantXp has NO existence check (index.js:425-455);
    // awardXp auto-creates the row via addXp/ensureUser (users.js:4-11) and a
    // member-resolution miss only nulls level/changes (awardXp.js:44-51) —
    // the GRANT SUCCEEDS. The web mirrors that decision exactly.
    assert.equal(
      api.db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE guild_id = ? AND user_id = ?")
        .get(GUILD_A, USER_T_UNKNOWN).n,
      0,
      "precondition: no users row"
    );
    const before = webAuditCount();
    const { res, location } = await grantPost({ user_id: USER_T_UNKNOWN, amount: "120" });
    assert.equal(res.status, 302);
    assert.equal(location, `${GRANT_PATH}?done=xp_granted`, "unknown-but-valid user grants, like the slash");
    assert.equal(xpOf(USER_T_UNKNOWN), 120, "users row auto-created at the grant amount");
    assert.equal(webAuditCount(), before + 1);
    const row = grantRows("web", USER_T_UNKNOWN)[0];
    assert.deepEqual(row.details, {
      amount: 120,
      before_xp: 0,
      after_xp: 120,
      reason: null,
    });
  });

  it("level-threshold grant with a level_roles mapping ⇒ the SERVICE syncs the role (cache-only member)", async () => {
    // Default level_xp_factor = 100 ⇒ level 3 needs xp ≥ 3²×100 = 900.
    api.upsertLevelRole(GUILD_A, ROLE_LEVEL_SYNC, 3, 0);
    const member = makeMember(USER_T_SYNC);
    membersCache.set(USER_T_SYNC, member);
    api.setXp(GUILD_A, USER_T_SYNC, 0);

    const { res } = await grantPost({ user_id: USER_T_SYNC, amount: "900" });
    assert.equal(res.status, 302);
    assert.equal(xpOf(USER_T_SYNC), 900);
    assert.equal(levelFromXp(900, 100), 3, "fixture math: the grant crosses level 3");
    assert.deepEqual(
      member.added,
      [ROLE_LEVEL_SYNC],
      "member.roles.add was invoked by syncMemberRoles INSIDE awardXp (route synced nothing itself)"
    );
    // The route never touched the level_roles mapping (only the test did):
    const mappings = api.listLevelRoles(GUILD_A);
    assert.equal(mappings.length, 1);
    assert.equal(mappings[0].role_id, ROLE_LEVEL_SYNC);
    assert.equal(mappings[0].level_required, 3);
  });
});

// ===========================================================================
// F. BOTS — cache-proven refusals (slash `target.bot` mirror, index.js:429)
// ===========================================================================
describe("F. bot targets — refused ONLY on proven cache evidence, zero writes", () => {
  it("bot in the USER cache ⇒ error=bot_target slug, nothing mutated", async () => {
    usersCache.set(USER_BOT_USERS, { id: USER_BOT_USERS, bot: true, username: "b0t" });
    const before = webAuditCount();
    startWindow();
    const { res, location } = await grantPost({ user_id: USER_BOT_USERS, amount: "10" });
    const calls = stopWindow();
    assert.equal(res.status, 302);
    assert.equal(location, `${GRANT_PATH}?error=bot_target`);
    assert.deepEqual(writeCalls(calls), []);
    assert.deepEqual(namesOf(calls), [], "the refusal reached NO DB helper");
    assert.equal(webAuditCount(), before);
    assert.equal(xpOf(USER_BOT_USERS), 0);
  });

  it("bot in the MEMBER cache (user.bot) ⇒ same refusal", async () => {
    membersCache.set(USER_BOT_MEMBER, makeMember(USER_BOT_MEMBER, { bot: true }));
    startWindow();
    const { location } = await grantPost({ user_id: USER_BOT_MEMBER, amount: "10" });
    const calls = stopWindow();
    assert.equal(location, `${GRANT_PATH}?error=bot_target`);
    assert.deepEqual(namesOf(calls), []);
    assert.equal(xpOf(USER_BOT_MEMBER), 0);
  });
});

// ===========================================================================
// G. VALIDATION — the /grantxp bounds, refused with slugs and zero side effects
// ===========================================================================
describe("G. validation mirrors /grantxp — slugs only, zero writes, zero audit", () => {
  const probes = [
    // amount: slash IntegerOption 1…MAX_XP_AWARD + validateXpValue + `< 1` guard
    { name: "amount 0 (slash's explicit <1 guard)", fields: { user_id: USER_T_MIN, amount: "0" }, slug: "invalid_amount" },
    { name: "negative amount", fields: { user_id: USER_T_MIN, amount: "-25" }, slug: "invalid_amount" },
    { name: "decimal amount", fields: { user_id: USER_T_MIN, amount: "3.5" }, slug: "invalid_amount" },
    { name: "amount above the 1e9 cap (intent 6)", fields: { user_id: USER_T_MIN, amount: "1000000001" }, slug: "invalid_amount" },
    { name: "absurd digit count", fields: { user_id: USER_T_MIN, amount: "99999999999999" }, slug: "invalid_amount" },
    { name: "empty amount", fields: { user_id: USER_T_MIN, amount: "" }, slug: "invalid_amount" },
    { name: "scientific-notation garbage", fields: { user_id: USER_T_MIN, amount: "1e9" }, slug: "invalid_amount" },
    { name: "word amount", fields: { user_id: USER_T_MIN, amount: "five" }, slug: "invalid_amount" },
    // user: required snowflake (Discord's picker can only ever supply one)
    { name: "garbage user id", fields: { user_id: "not-a-user", amount: "10" }, slug: "invalid_user" },
    { name: "too-short user id", fields: { user_id: "42", amount: "10" }, slug: "invalid_user" },
    { name: "@everyone-shaped id (== guild id)", fields: { user_id: GUILD_A, amount: "10" }, slug: "invalid_user" },
    { name: "missing user field", fields: { amount: "10" }, slug: "invalid_user" },
    // reason: slash setMaxLength(200)
    { name: "reason longer than 200 chars", fields: { user_id: USER_T_MIN, amount: "10", reason: "x".repeat(201) }, slug: "reason_too_long" },
  ];

  for (const probe of probes) {
    it(`refuses: ${probe.name} ⇒ ?error=${probe.slug}, zero writes, zero audit`, async () => {
      const before = webAuditCount();
      startWindow();
      const { res, location } = await grantPost(probe.fields);
      const calls = stopWindow();
      assert.equal(res.status, 302, `${probe.name}: status`);
      assert.equal(
        location,
        `${GRANT_PATH}?error=${probe.slug}`,
        "PRG carries ONLY the whitelisted slug — never the submitted value"
      );
      assert.match(
        location,
        /^\/g\/\d+\/xp\/grant\?error=[a-z_]+$/,
        "Location shape: fixed path + fixed slug (no echo, §8.7)"
      );
      assert.deepEqual(writeCalls(calls), [], `${probe.name}: zero write helpers`);
      assert.deepEqual(namesOf(calls), [], `${probe.name}: no DB helper reached at all`);
      assert.equal(webAuditCount(), before, `${probe.name}: audited NOTHING`);
      assert.equal(xpOf(USER_T_MIN), 0, "no probe moved any XP");
    });
  }

  it("slash bounds ACCEPT at the edges: amount 1, amount 1e9, reason exactly 200", async () => {
    const one = await grantPost({ user_id: USER_T_MIN, amount: "1" });
    assert.equal(one.location, `${GRANT_PATH}?done=xp_granted`, "lower bound (slash min:1)");
    assert.equal(xpOf(USER_T_MIN), 1);

    const cap = await grantPost({ user_id: USER_T_CAP, amount: String(MAX_XP_AWARD) });
    assert.equal(cap.location, `${GRANT_PATH}?done=xp_granted`, "upper bound = MAX_XP_AWARD (slash max)");
    assert.equal(xpOf(USER_T_CAP), MAX_XP_AWARD);

    const r200 = "y".repeat(200);
    const ok = await grantPost({ user_id: USER_T_R200, amount: "10", reason: r200 });
    assert.equal(ok.location, `${GRANT_PATH}?done=xp_granted`);
    const row = grantRows("web", USER_T_R200)[0];
    assert.equal(row.details.reason.length, 200, "reason stored (trimmed) at the slash's max length");
  });
});

// ===========================================================================
// H. FAIL-CLOSED — the outcome is never silently claimed (§8.1-7)
// ===========================================================================
describe("H. audit-fail injection ⇒ generic 500, no claim, no row, no mirror", () => {
  it("insertAdminAudit throwing: 500 'Internal error', zero audit rows, NO mirror", async () => {
    api.setXp(GUILD_A, USER_T_AUDITFAIL, 0);
    const before = webAuditCount();
    mirrorSpy.log.length = 0;
    recorder.auditThrow = true;
    const realError = console.error;
    console.error = () => {}; // the expected 500 logger is noise here
    let out;
    try {
      out = await grantPost({ user_id: USER_T_AUDITFAIL, amount: "77", reason: "fail closed" });
      await tick();
    } finally {
      recorder.auditThrow = false;
      console.error = realError;
    }
    assert.equal(out.res.status, 500, "audit failure must 500 (fail-closed)");
    assert.equal(out.body, "Internal error");
    assert.equal(out.location, null, "no success redirect — the outcome is never claimed");
    assert.equal(webAuditCount(), before, "the injected failure wrote no audit row");
    assert.equal(mirrorSpy.log.length, 0, "a failed insert schedules NO channel mirror");
  });
});

// ===========================================================================
// K. SLASH ↔ WEB PARITY (§8.11) — the real handleGrantXp on the SAME database
// ===========================================================================
describe("K. parity: equal XP totals + same-shaped audit rows (slash = source of truth)", () => {
  it("the SAME grant via the real /grantxp handler and via the web POST is indistinguishable at the DB boundary", async () => {
    // The web side first (real HTTP through the full stack).
    api.setXp(GUILD_A, USER_T_WEBPARITY, 100);
    api.setXp(GUILD_A, USER_T_SLASH, 100);

    const web = await grantPost({
      user_id: USER_T_WEBPARITY,
      amount: "250",
      reason: "  parity twin  ", // both sides trim for the audit record
    });
    assert.equal(web.location, `${GRANT_PATH}?done=xp_granted`);

    // The slash side: the REAL handleGrantXp (src/features/xp/index.js:421)
    // with a minimal interaction — the same code the command router invokes.
    const { PermissionFlagsBits } = require("discord.js");
    const replies = [];
    const slashGuild = { id: GUILD_A, members: { fetch: async () => null } }; // member-miss,
    // exactly what the web's cache-only seam resolves to for this user too.
    const interaction = {
      guildId: GUILD_A,
      guild: slashGuild,
      user: { id: USER_ADMIN },
      memberPermissions: { has: (bit) => bit === PermissionFlagsBits.ManageGuild },
      options: {
        getUser: (name) => {
          assert.equal(name, "user");
          return { id: USER_T_SLASH, bot: false, username: "slice" };
        },
        getInteger: (name) => {
          assert.equal(name, "amount");
          return 250;
        },
        getString: (name) => {
          assert.equal(name, "reason");
          return "  parity twin  ";
        },
      },
      reply: async (payload) => {
        replies.push(payload);
        return {};
      },
    };
    const xpFeature = require("../src/features/xp");
    await xpFeature.handlers.grantxp(interaction, { client: FAKE_CLIENT });

    // EQUAL XP TOTALS:
    assert.equal(xpOf(USER_T_SLASH), 350, "slash: 100 + 250");
    assert.equal(xpOf(USER_T_WEBPARITY), 350, "web: identical outcome");
    assert.match(
      typeof replies[0]?.content === "string" ? replies[0].content : "",
      /Granted \*\*250\*\* XP/,
      "the slash replied with its own success line (sanity: the handler really ran)"
    );

    // SAME-SHAPED AUDIT ROWS — identical columns, deep-equal details, only
    // the origin differs (that is the whole point of the origin column).
    const webRows = grantRows("web", USER_T_WEBPARITY);
    const slashRows = grantRows("slash", USER_T_SLASH);
    assert.equal(webRows.length, 1, "exactly one web row from the web grant");
    assert.equal(slashRows.length, 1, "exactly one slash row from the slash grant");
    const w = webRows[0];
    const s = slashRows[0];

    assert.equal(w.origin, "web");
    assert.equal(s.origin, "slash");
    assert.equal(w.action, s.action);
    assert.equal(w.action, "xp.grant", "shared §8.6 vocabulary");
    assert.equal(w.target_type, s.target_type);
    assert.equal(w.target_type, "user");
    assert.equal(w.actor_user_id, s.actor_user_id, "same actor id on both paths");
    assert.equal(w.guild_id, s.guild_id);
    assert.deepEqual(Object.keys(w).filter((k) => k !== "details"), Object.keys(s).filter((k) => k !== "details"),
      "same row shape — the web audit is not a custom invention");
    assert.deepEqual(
      { ...w.details, after_xp: w.details.after_xp - 100 + 100 },
      s.details,
      "before/after/amount/reason deep-equal (both trim the reason, both read before FIRST)"
    );
    assert.deepEqual(s.details, { amount: 250, before_xp: 100, after_xp: 350, reason: "parity twin" });
  });
});
