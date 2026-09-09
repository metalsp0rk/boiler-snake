/**
 * Subtask 31 — PHASE 3 COMMAND-VISIBILITY SYNC TRIGGER (roadmap/web-admin.md
 * §8.6 "Command visibility: sync status + trigger | Staff (view) | Admin
 * (sync)" row + §8.8 Phase 3; AGENTS.md §4 "/staff syncpermissions is
 * ManageGuild-ONLY" ⇒ web twin ADMIN, zero delta).
 *
 * The whole point of this surface is SERVICE PARITY: the web POST and the
 * slash handler must run the SAME core (features/commandPermissions/
 * syncTrigger.js → sync.js) against the SAME stored guild_command_permission_
 * oauth authorization, so this suite captures the OUTBOUND Discord sequence
 * (discord.js REST.get spy + patched global.fetch for the PUTs / token
 * refresh) for BOTH transports and deep-equals them, then deep-equals the
 * admin_audit rows (identical action/target/details; only origin differs).
 *
 * Mechanism: REAL Express 5 app on an ephemeral port, REAL SQLite, fake
 * Discord transport under the REAL createGuildAccessResolver (xp-grant /
 * moderation-actions boot discipline — sessions minted offline, csrf derived,
 * one loadDb). NOTHING here touches the network: global.fetch is replaced by
 * a recording mock that THROWS on any unexpected URL, and discord.js
 * REST.prototype.get is spied, so a leaked real call would fail loudly
 * instead of hanging. Decision 9 (web login tokens never leave for Discord)
 * is a first-class assertion: every captured Authorization header must be
 * the seeded STORED access token, and no "tok-" session token may EVER
 * appear in an outbound header.
 *
 * What this suite pins:
 *  A. MUTATION CONTRACT — registry entry and mounted POST route minted in
 *     lockstep from ONE template (POST /g/:guildId/commands/sync).
 *  B. RENDER POLICY — the trigger form renders ONLY on the staff page, ONLY
 *     for admin viewers WITH a stored authorization; /commands stays
 *     forms-free (Phase-1 pin); PRG flash renders whitelisted slugs only —
 *     hostile ?error= values never echo (§8.7).
 *  C. TIER LADDER — anon 302 · stranger/plain/cross generic 404 · junior AND
 *     senior fixed 403 with ZERO Discord calls and ZERO audit (§8.6).
 *  D. CSRF — missing / tampered ⇒ 403, zero service calls, zero audit.
 *  E. PRECONDITION REFUSALS — env-missing (named-var slug) and
 *     not-authorized run slash: ZERO Discord calls, ZERO audit, whitelist
 *     slug only; hostile `return` refused with invalid_return at the
 *     DEFAULT surface (never echoed).
 *  F. HAPPY PATH — 302 ?done=sync_completed; GET command list once; one
 *     Bearer-PUT per resolvable staff-tier command with the STORED token
 *     (never the web session token); permissions = the staff_roles allow
 *     list; oauth row last_sync_at stamped / last_sync_error cleared;
 *     EXACTLY ONE web audit row (action/targetType/targetId/details —
 *     shared details builder shape); NO channel mirror (slash parity).
 *  G. PARTIAL — a failing PUT ⇒ ?done=sync_partial, audit STILL written
 *     (commands_updated counts successes only), last_sync_error persisted
 *     by the shared sync layer (never fabricated away).
 *  H. DEAD AUTHORIZATION — expired token + refused refresh ⇒
 *     ?error=reauth_required, zero command-list GET / PUTs, zero audit,
 *     stored row deleted (getValidAccessToken's contract, unchanged).
 *  I. HARD FAILURE — transport outage ⇒ ?error=sync_failed, ZERO audit
 *     (slash parity: recordSlashAudit sits after a resolved result only).
 *  J. FAIL-CLOSED — audit insert throwing ⇒ generic 500, NO Location, no
 *     audit row, no mirror (§8.1-7: the outcome is never silently claimed).
 *  K. SLASH↔WEB PARITY (§8.11) — the REAL handleSyncPermissions (mock
 *     interaction, same database, same mocks) and the web POST produce
 *     deep-equal REST sequences (GET path, PUT urls/bodies/Authorization)
 *     and audit rows equal on every column but origin + actor.
 *
 * Fully offline. Sentinel secrets are clearly fake (AGENTS.md). Runtime ≪ 60s
 * (3 seeded guild commands keep the shared 150 ms pacing budget small).
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// loadDb FIRST: fresh SQLite + src require-cache reset; every require below
// binds to that DB (phase-2-gate boot discipline).
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
const { REST } = require("discord.js");
const staffRolesFeature = require("../src/features/staffRoles");
const {
  SYNC_AUDIT_ACTION,
} = require("../src/features/commandPermissions/syncTrigger");
const { SYNC_PATH } = require("../src/web/routes/syncAction");

// ---------------------------------------------------------------------------
// Clearly-fake sentinels / placeholders ONLY (AGENTS.md: never realistic).
// ---------------------------------------------------------------------------
const SESSION_SECRET = "test-visync-sentinel-session-secret-NOT-REAL-031";

const GUILD_A = "330000000000000001"; // bot + every test user
const GUILD_CROSS = "330000000000000002"; // bot guild the users are NOT in

const USER_ADMIN = "469190112345678901"; // owner snapshot ⇒ tier admin
const USER_JUNIOR = "469190112345678902"; // junior staff role ⇒ tier staff
const USER_SENIOR = "469190112345678903"; // senior staff role ⇒ tier senior
const USER_PLAIN = "469190112345678904"; // guild-A member, no staff role
const USER_STRANGER = "469190112345678905"; // member of NOTHING

// Tier-resolution roles (NOT snowflake-shaped; they double as the STAFF ROLE
// ALLOW LIST the sync must PUT — role_count 2 on every happy probe).
const ROLE_JUNIOR_TIER = "role-junior-staff";
const ROLE_SENIOR_TIER = "role-senior-staff";

const FAKE_CLIENT_ID = "901000000000000001";
const FAKE_CLIENT_SECRET = "test-command-perm-sentinel-secret-NOT-REAL";
const FAKE_BOT_TOKEN = "test-bot-token-sentinel-NOT-REAL-031";
// The STORED slash-OAuth access token (what the PUTs must carry):
const STORED_AT = "stored-at-sentinel-NOT-REAL-AXXA";
const STORED_RT = "stored-rt-sentinel-NOT-REAL-BB01";
// The web session token shape is "tok-<userId>" (access-matrix) — NONE of
// these may ever appear in an outbound Authorization header (decision 9).

// Three of the 17 staff-tier sync commands resolve in the fake guild command
// list (alphabetical targets order = activityconfig, gork, note). The other
// 14 land in missingCommands (no PUTs, no pacing sleeps).
const GUILD_COMMANDS_DEFAULT = [
  { name: "activityconfig", id: "930000000000000001" },
  { name: "gork", id: "930000000000000002" },
  { name: "note", id: "930000000000000003" },
];

const SYNC_CONCRETE = `/g/${GUILD_A}/commands/sync`;

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
  "OAUTH_REDIRECT_URI",
  "DISCORD_TOKEN",
  "WEB_RATE_LIMIT_MUTATION_MAX",
  "WEB_TIER_CACHE_TTL_MS",
];

// ---------------------------------------------------------------------------
// Fake Discord transport under the REAL resolver (xp-grant pattern)
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

const FAKE_CLIENT = {
  guilds: {
    cache: {
      get: (id) =>
        id === GUILD_A
          ? {
              id: GUILD_A,
              roles: { cache: { get: (rid) => (rid === ROLE_JUNIOR_TIER || rid === ROLE_SENIOR_TIER ? { id: rid, name: rid } : undefined) } },
              members: { cache: new Map() },
              channels: { cache: { get: () => undefined } },
            }
          : undefined,
    },
  },
  users: { cache: new Map() },
  channels: { cache: { get: () => undefined } },
};

// ---------------------------------------------------------------------------
// OUTBOUND DISCORD MOCKS (the heart of the parity evidence)
//  - global.fetch: PUT permissions + OAuth token refresh ONLY; anything else
//    THROWS (a real network call cannot hide behind a 200).
//  - discord.js REST.prototype.get: the bot-token guild command list.
//  - test post()/GET helpers bind the CAPTURED real fetch.
// ---------------------------------------------------------------------------
const realFetch = global.fetch;

const discord = {
  log: [], // ordered {kind, ...} entries — the captured REST SEQUENCE
  guildCommands: GUILD_COMMANDS_DEFAULT.slice(),
  putFailIds: new Set(),
  tokenRefreshOk: false,
  restGetThrows: false,
};

function resetDiscord() {
  discord.log = [];
  discord.guildCommands = GUILD_COMMANDS_DEFAULT.slice();
  discord.putFailIds = new Set();
  discord.tokenRefreshOk = false;
  discord.restGetThrows = false;
}

function mockRes(status, bodyObj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => bodyObj,
    text: async () => JSON.stringify(bodyObj),
  };
}

const savedFetch = global.fetch;
const savedRestGet = REST.prototype.get;

function installDiscordMocks() {
  REST.prototype.get = async function spiedRestGet(path, ...rest) {
    if (discord.restGetThrows) {
      const err = new Error("synthetic transport outage (test)");
      err.name = "TestOutage";
      throw err;
    }
    discord.log.push({ kind: "rest-get", path });
    return discord.guildCommands.map((c) => ({ id: c.id, name: c.name }));
  };

  global.fetch = async function mockedFetch(url, opts = {}) {
    const u = String(url);
    const method = String(opts.method || "GET").toUpperCase();

    if (u.includes("/oauth2/token")) {
      discord.log.push({
        kind: "token-post",
        auth: String(opts?.headers?.Authorization || ""),
      });
      if (discord.tokenRefreshOk) {
        return mockRes(200, {
          access_token: "refreshed-at-sentinel-NOT-REAL",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "rotated-rt-sentinel-NOT-REAL",
        });
      }
      return mockRes(400, { error: "invalid_grant" });
    }

    const putMatch = u.match(/\/commands\/([^/]+)\/permissions$/);
    if (method === "PUT" && putMatch) {
      const entry = {
        kind: "put",
        commandId: putMatch[1],
        url: u,
        auth: String(opts?.headers?.Authorization || ""),
        body: String(opts?.body || ""),
      };
      discord.log.push(entry);
      if (discord.putFailIds.has(putMatch[1])) {
        return mockRes(500, { message: "synthetic Discord meltdown (test)" });
      }
      return mockRes(200, { id: putMatch[1] });
    }

    throw new Error(`UNEXPECTED OFF-TEST HTTP: ${method} ${u}`);
  };
}

function restoreDiscordMocks() {
  global.fetch = savedFetch;
  REST.prototype.get = savedRestGet;
}

const puts = () => discord.log.filter((e) => e.kind === "put");
const restGets = () => discord.log.filter((e) => e.kind === "rest-get");

// ---------------------------------------------------------------------------
// FACADE RECORDER + AUDIT-FAIL INJECTION (xp-grant pattern, installed BEFORE
// createWebApp so the audit middleware captures the wrapped insertAdminAudit
// and sync/oauthTokens' top-level destructures bind the wrappers).
// ---------------------------------------------------------------------------
const WATCH = new Set([
  "insertAdminAudit",
  "setCommandPermissionSyncResult",
  "upsertCommandPermissionOauth",
  "updateCommandPermissionAccessToken",
  "deleteCommandPermissionOauth",
  "addStaffRole",
  "removeStaffRole",
]);

const recorder = { active: false, log: [], auditThrow: false };

function installFacadeRecorder(F) {
  const originals = {};
  for (const name of WATCH) {
    if (typeof F[name] !== "function") {
      throw new Error(`visync precondition: facade helper "${name}" missing (renamed?)`);
    }
    originals[name] = F[name];
    F[name] = function recorded(...args) {
      if (recorder.active) recorder.log.push({ name, args });
      if (name === "insertAdminAudit" && recorder.auditThrow) {
        const err = new Error("admin_audit insert failed (sync injection)");
        err.code = "SYNC_AUDIT_INJECT";
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
const namesOf = (log) => log.map((c) => c.name);

// ---------------------------------------------------------------------------
// MIRROR SPY (§8.1-7): the sync path mirrors NOTHING on EITHER transport —
// any scheduled embed is a parity break.
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
  bindAuditClient({ __visyncFakeAuditClient: true });
}
function restoreMirrorSpy() {
  auditLogMod.sendAuditLog = mirrorSpy.sendAudit;
  auditLogMod.sendWarnLog = mirrorSpy.sendWarn;
  bindAuditClient(null);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// ---------------------------------------------------------------------------
// Synchronous boot: env → tier rows → sessions → spies → APP → server.
// ---------------------------------------------------------------------------
const savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
process.env.SESSION_SECRET = SESSION_SECRET;
for (const k of ENV_KEYS) {
  if (k === "SESSION_SECRET") continue;
  delete process.env[k];
}
process.env.WEB_RATE_LIMIT_MUTATION_MAX = "1000000"; // scripted probes, not humans

// The staff_roles allow-list the sync PUTs (role_count 2).
api.addStaffRole(GUILD_A, ROLE_JUNIOR_TIER, "junior");
api.addStaffRole(GUILD_A, ROLE_SENIOR_TIER, "senior");

const cookieOf = {};
const csrfOf = {};

function mkSession(userKey, userId) {
  const id = harness.createLoginSession({ api, sessionPolicy, tokens }, userId, {
    token: `tok-${userId}`,
  });
  cookieOf[userKey] = `web_session=${id}`;
  sessionIdKey(userKey, id);
  csrfOf[userKey] = csrfMod.deriveCsrfToken(id, SESSION_SECRET);
}
function sessionIdKey(userKey, id) {
  (mkSession.ids ||= {})[userKey] = id;
}

mkSession("admin", USER_ADMIN);
mkSession("junior", USER_JUNIOR);
mkSession("senior", USER_SENIOR);
mkSession("plain", USER_PLAIN);
mkSession("stranger", USER_STRANGER);

installMirrorSpy();
installDiscordMocks();

const resolver = guildAccessMod.createGuildAccessResolver({
  discord: fakeDiscord,
  botGuilds: async () => [GUILD_A, GUILD_CROSS],
  now: Date.now,
  ttlMs: 3_600_000,
});

const app = createWebApp({
  guildAccess: resolver,
  botGuilds: async () => [GUILD_A, GUILD_CROSS],
  getClient: () => FAKE_CLIENT,
});

/** @type {http.Server} */
let server = null;
let base = "";

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

/** Env as commandPermissions/config.js needs it for `ready` (all names). */
function envConfigured() {
  process.env.CLIENT_ID = FAKE_CLIENT_ID;
  process.env.CLIENT_SECRET = FAKE_CLIENT_SECRET;
  process.env.PUBLIC_HTTP_PORT = "3101";
  process.env.PUBLIC_BASE_URL = "http://127.0.0.1:3101";
  process.env.DISCORD_TOKEN = FAKE_BOT_TOKEN;
}

/** Break exactly ONE named variable (env-slug evidence). */
function envBreakSecret() {
  delete process.env.CLIENT_SECRET;
}

function oauthSeedFresh() {
  api.upsertCommandPermissionOauth(GUILD_A, {
    refreshToken: STORED_RT,
    accessToken: STORED_AT,
    accessExpiresAt: Date.now() + 3_600_000,
    authorizedByUserId: USER_ADMIN,
  });
}

function oauthSeedExpired() {
  api.upsertCommandPermissionOauth(GUILD_A, {
    refreshToken: STORED_RT,
    accessToken: STORED_AT,
    accessExpiresAt: Date.now() - 1000, // past → refresh path
    authorizedByUserId: USER_ADMIN,
  });
}

function oauthClear() {
  api.deleteCommandPermissionOauth(GUILD_A);
}

/** Full happy-stage setup: env + stored authorization + quiet Discord log. */
function stageReady() {
  envConfigured();
  oauthSeedFresh();
  resetDiscord();
  mirrorSpy.log.length = 0;
}

// ---------------------------------------------------------------------------
// HTTP helpers (CAPTURED real fetch — the mock governs only the SERVICE layer)
// ---------------------------------------------------------------------------

async function get(path, { cookie } = {}) {
  const res = await realFetch(`${base}${path}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
  const body = await res.text();
  return { res, body, location: res.headers.get("location") };
}

async function post(path, { cookie, fields } = {}) {
  const res = await realFetch(`${base}${path}`, {
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

const syncPost = (fields = {}, userKey = "admin") =>
  post(SYNC_CONCRETE, {
    cookie: cookieOf[userKey],
    fields: { _csrf: csrfOf[userKey], ...fields },
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
const syncRows = (origin) =>
  auditRows(origin).filter((r) => r.action === SYNC_AUDIT_ACTION);

after(() => {
  if (server) server.close();
  restoreDiscordMocks();
  restoreMirrorSpy();
  restoreFacadeRecorder();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (tmpDir) {
    try {
      require("fs").rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

before(async () => {
  server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});

// ===========================================================================
// A. MUTATION CONTRACT — lockstep registry ↔ mounted route (one template)
// ===========================================================================

describe("A. mutation contract: registry + mounted POST minted from ONE template", () => {
  it("registry contains EXACTLY one sync mutation: POST /g/:guildId/commands/sync", () => {
    const syncRegs = app.locals.webMutations
      .filter((m) => /sync/i.test(m.path))
      .map((m) => `${m.method} ${m.path}`);
    assert.deepEqual(syncRegs, ["POST /g/:guildId/commands/sync"]);
  });

  it("the mounted POST route template equals SYNC_PATH (structural lockstep)", () => {
    const router = app.router || app._router;
    const mounted = [];
    for (const layer of router.stack) {
      const route = layer && layer.route;
      if (!route || !route.methods || route.methods.post !== true) continue;
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      mounted.push(...paths);
    }
    assert.ok(
      mounted.includes(SYNC_PATH),
      `mounted POST routes must include ${SYNC_PATH} (got: ${mounted.join(", ")})`
    );
    assert.equal(SYNC_PATH, "/g/:guildId/commands/sync");
  });

  it("GET on the sync path ⇒ generic 404 (GET surfaces never 405); other verbs byte 405", async () => {
    // Anti-enumeration: a GET that matches no page surface renders the SAME
    // generic 404 as any unknown path (a 405 on GET would advertise the
    // mutation). Non-GET, non-POST verbs on a REGISTERED template 405.
    const g = await realFetch(`${base}${SYNC_CONCRETE}`, {
      method: "GET",
      headers: { cookie: cookieOf.admin },
    });
    assert.equal(g.status, 404, "GET on the sync path");
    assert.equal(await g.text(), "Not found");
    for (const method of ["PUT", "DELETE"]) {
      const res = await realFetch(`${base}${SYNC_CONCRETE}`, {
        method,
        headers: { cookie: cookieOf.admin },
      });
      assert.equal(res.status, 405, `${method} on the sync path`);
      assert.equal(await res.text(), "Method not allowed");
    }
  });
});

// ===========================================================================
// B. RENDER POLICY — form surface + whitelist-only flash (§8.6 / §8.7)
// ===========================================================================

describe("B. staff-page trigger form + whitelisted flash", () => {
  before(() => stageReady());
  after(() => oauthClear());

  it("admin on /staff with a stored authorization ⇒ trigger form (csrf + return bound)", async () => {
    const { res, body } = await get(`/g/${GUILD_A}/staff`, { cookie: cookieOf.admin });
    assert.equal(res.status, 200);
    assert.ok(body.includes("Sync command visibility now"), "form renders for admin");
    assert.ok(body.includes(`action="${SYNC_CONCRETE}"`), "POSTs to the sync path");
    assert.ok(body.includes('name="return" value="staff"'), "return target is the staff page");
    assert.ok(body.includes('name="_csrf"'), "CSRF hidden field present");
  });

  it("senior AND junior on /staff ⇒ NO trigger form (admin-tier render policy)", async () => {
    for (const key of ["senior", "junior"]) {
      const { res, body } = await get(`/g/${GUILD_A}/staff`, { cookie: cookieOf[key] });
      assert.equal(res.status, 200, `${key} still views the staff page`);
      assert.ok(
        !body.includes("Sync command visibility now"),
        `${key} must not see the trigger form`
      );
    }
  });

  it("anonymous ⇒ 302 login; cross-guild ⇒ generic 404 on /staff (shell doctrine)", async () => {
    const anon = await get(`/g/${GUILD_A}/staff`);
    assert.equal(anon.res.status, 302);
    const cross = await get(`/g/${GUILD_CROSS}/staff`, { cookie: cookieOf.admin });
    assert.equal(cross.res.status, 404);
    assert.equal(cross.body, "Not found");
  });

  it("/commands stays FORMS-FREE (Phase-1 pin) even for an authorized admin", async () => {
    const { res, body } = await get(`/g/${GUILD_A}/commands`, { cookie: cookieOf.admin });
    assert.equal(res.status, 200);
    const main = body.slice(body.indexOf("<main"), body.indexOf("</main>"));
    assert.equal(main.match(/<form/i), null, "no form on /commands — the trigger lives on /staff");
    assert.ok(body.includes("authorized"), "status panel still honest");
  });

  it("unauthorized guild ⇒ admin sees NO form + honest advice (never runs OAuth itself)", async () => {
    oauthClear();
    const { res, body } = await get(`/g/${GUILD_A}/staff`, { cookie: cookieOf.admin });
    assert.equal(res.status, 200);
    assert.ok(!body.includes("Sync command visibility now"), "no form without a stored auth");
    assert.ok(body.includes("never runs OAuth itself"), "honest advice text");
    oauthSeedFresh();
  });

  it("PRG flash: whitelisted slugs render; HOSTILE values never echo (§8.7)", async () => {
    const ok = await get(`/g/${GUILD_A}/commands?done=sync_completed`, {
      cookie: cookieOf.staff || cookieOf.junior,
    });
    assert.equal(ok.res.status, 200);
    assert.ok(ok.body.includes("Command visibility synced"), "success slug renders its fixed message");

    const env = await get(
      // %2B is what the route's PRG Location carries (raw "+" in a query
      // would form-decode to a SPACE and fail the whitelist — never sent).
      `/g/${GUILD_A}/commands?error=env_not_configured:client_secret%2Bbase_url`,
      { cookie: cookieOf.junior }
    );
    assert.ok(env.body.includes("CLIENT_SECRET"), "env NAMES (from the frozen table) render");
    assert.ok(env.body.includes("PUBLIC_BASE_URL"), "both named tokens render");

    const hostile = await get(
      `/g/${GUILD_A}/commands?error=%3Cscript%3Exss-probe-91%3C%2Fscript%3E&done=%3Cimg%3E`,
      { cookie: cookieOf.junior }
    );
    assert.equal(hostile.res.status, 200);
    assert.ok(!hostile.body.includes("xss-probe-91"), "raw hostile query value NEVER echoes");
    assert.ok(!hostile.body.includes("Command visibility synced"), "junk done= renders nothing");

    const forged = await get(`/g/${GUILD_A}/commands?error=env_not_configured:evil_token`, {
      cookie: cookieOf.junior,
    });
    assert.ok(!forged.body.includes("evil_token"), "unknown env slug token NEVER echoes");
  });

  it("staff-page flash renders on the sync panel (PRG may target either surface)", async () => {
    const { body } = await get(`/g/${GUILD_A}/staff?done=sync_partial`, {
      cookie: cookieOf.admin,
    });
    assert.ok(body.includes("Sync finished with failures"), "partial slug renders on /staff");
  });
});

// ===========================================================================
// C. TIER LADDER (POST)
// ===========================================================================

describe("C. tier ladder — POST /g/:guildId/commands/sync", () => {
  before(() => stageReady());

  it("anonymous ⇒ 302 /auth/login?guild=… — guildScope answers before anything runs", async () => {
    const { res, location } = await post(SYNC_CONCRETE, { fields: { _csrf: "irrelevant" } });
    assert.equal(res.status, 302);
    assert.equal(location, `/auth/login?guild=${GUILD_A}`);
    assert.deepEqual(discord.log, [], "no Discord call for an anon");
  });

  it("stranger AND in-guild plain member (VALID csrf) ⇒ generic 404 bytes", async () => {
    for (const key of ["stranger", "plain"]) {
      const { res, body } = await syncPost({}, key);
      assert.equal(res.status, 404, `${key} ⇒ 404`);
      assert.equal(body, "Not found");
      assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    }
    assert.deepEqual(discord.log, [], "no Discord call for 404s");
  });

  it("cross-guild (VALID csrf) ⇒ the SAME generic 404 (never 403/302)", async () => {
    const { res, body } = await post(`/g/${GUILD_CROSS}/commands/sync`, {
      cookie: cookieOf.admin,
      fields: { _csrf: csrfOf.admin },
    });
    assert.equal(res.status, 404);
    assert.equal(body, "Not found");
  });

  it("wrong-tier: junior AND senior ⇒ FIXED 403, zero Discord, zero audit", async () => {
    const before = webAuditCount();
    for (const key of ["junior", "senior"]) {
      resetDiscord();
      const { res, body } = await syncPost({}, key);
      assert.equal(res.status, 403, `${key} on admin-tier sync`);
      assert.equal(body, "Forbidden");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.deepEqual(discord.log, [], `${key} denial touched nothing`);
    }
    assert.equal(webAuditCount(), before, "tier denials audited nothing");
  });

  it("admin is NEVER 403 (positive-path evidence)", async () => {
    envConfigured();
    oauthClear(); // authorized=false is fine for the ladder evidence
    const { res } = await syncPost({});
    assert.notEqual(res.status, 403);
  });
});

// ===========================================================================
// D. CSRF
// ===========================================================================

describe("D. CSRF — missing / tampered on the sync mutation", () => {
  before(() => stageReady());

  it("missing _csrf ⇒ 403 Forbidden; zero facade writes; zero Discord; zero audit", async () => {
    const before = webAuditCount();
    startWindow();
    const { res, body } = await post(SYNC_CONCRETE, {
      cookie: cookieOf.admin,
      fields: { return: "staff" },
    });
    const calls = stopWindow();
    assert.equal(res.status, 403);
    assert.equal(body, "Forbidden");
    assert.deepEqual(namesOf(calls), [], "CSRF denial never reached the service layer");
    assert.deepEqual(discord.log, []);
    assert.equal(webAuditCount(), before);
  });

  it("tampered _csrf ⇒ 403; identical valid-token POST passes the gate (§8.7 replay doctrine)", async () => {
    startWindow();
    const { res } = await post(SYNC_CONCRETE, {
      cookie: cookieOf.admin,
      fields: { _csrf: "f".repeat(64), return: "staff" },
    });
    const calls = stopWindow();
    assert.equal(res.status, 403);
    assert.deepEqual(namesOf(calls), []);

    envConfigured();
    oauthSeedFresh();
    resetDiscord();
    const ok = await syncPost({ return: "staff" });
    assert.equal(ok.location, `/g/${GUILD_A}/staff?done=sync_completed`);
  });
});

// ===========================================================================
// E. PRECONDITION REFUSALS — zero Discord, zero audit, whitelist slugs
// ===========================================================================

describe("E. precondition refusals (run BEFORE any Discord call)", () => {
  it("env missing (CLIENT_SECRET) ⇒ named-var slug at the DEFAULT return surface; zero Discord, zero audit", async () => {
    envConfigured();
    envBreakSecret();
    oauthSeedFresh();
    resetDiscord();
    const before = webAuditCount();
    const { res, location } = await syncPost({});
    assert.equal(res.status, 302);
    assert.equal(location, `/g/${GUILD_A}/commands?error=env_not_configured:client_secret`);
    assert.deepEqual(discord.log, [], "env refusal touched Discord ZERO times");
    assert.equal(webAuditCount(), before, "precondition refusal audited nothing");
  });

  it("env missing honors return=staff for the redirect target (still slug-whitelisted)", async () => {
    envConfigured();
    delete process.env.PUBLIC_BASE_URL; // base_url + redirect_uri both go missing
    resetDiscord();
    const { location } = await syncPost({ return: "staff" });
    assert.equal(
      location,
      `/g/${GUILD_A}/staff?error=env_not_configured:base_url%2Bredirect_uri`
    );
    assert.deepEqual(discord.log, []);
  });

  it("no stored authorization ⇒ not_authorized_run_slash; zero Discord, zero audit", async () => {
    envConfigured();
    oauthClear();
    resetDiscord();
    const before = webAuditCount();
    const { res, location } = await syncPost({ return: "staff" });
    assert.equal(res.status, 302);
    assert.equal(location, `/g/${GUILD_A}/staff?error=not_authorized_run_slash`);
    assert.deepEqual(discord.log, [], "the web NEVER starts an OAuth flow or syncs un-authorized");
    assert.equal(webAuditCount(), before);
  });

  it("hostile return target ⇒ invalid_return at the DEFAULT surface; value NEVER echoed (§8.7)", async () => {
    stageReady();
    const { res, location } = await syncPost({ return: "<script>alert(1)</script>" });
    assert.equal(res.status, 302);
    assert.equal(location, `/g/${GUILD_A}/commands?error=invalid_return`);
    assert.ok(!location.includes("script"), "submitted value never shapes a Location");
    assert.deepEqual(discord.log, []);
  });
});

// ===========================================================================
// F. HAPPY PATH — REST sequence + stored-token discipline + ONE audit row
// ===========================================================================

describe("F. happy path — synced via the SHARED core", () => {
  let webAudit;
  before(async () => {
    stageReady();
    const before = webAuditCount();
    const { res, body, location } = await syncPost({ return: "staff" });
    assert.equal(res.status, 302, `body was: ${body}`);
    assert.equal(location, `/g/${GUILD_A}/staff?done=sync_completed`);
    assert.equal(body, "");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(webAuditCount(), before + 1, "exactly ONE audit row");
    webAudit = syncRows("web")[0];
    await tick();
  });

  it("exactly one bot-token GET of the guild command list, then one PUT per resolvable command", () => {
    assert.equal(restGets().length, 1, "one command-list GET");
    assert.equal(
      restGets()[0].path,
      `/applications/${FAKE_CLIENT_ID}/guilds/${GUILD_A}/commands`,
      "the shared sync.js GET path (bot token)"
    );
    const seq = puts().map((p) => p.commandId);
    assert.deepEqual(
      seq,
      GUILD_COMMANDS_DEFAULT.map((c) => c.id),
      "PUTs in targets order; the 14 unregistered names cost zero PUTs"
    );
  });

  it("Bearer = the STORED slash token on every PUT; the web session token NEVER leaves", () => {
    for (const p of puts()) {
      assert.equal(p.auth, `Bearer ${STORED_AT}`, "stored slash OAuth token (decision 9)");
      assert.ok(!p.auth.includes("tok-"), "web session token shape never appears");
    }
    assert.ok(
      discord.log.every((e) => !String(e.auth || "").includes("tok-")),
      "no captured outbound header ever carries a web session token"
    );
  });

  it("PUT bodies carry the staff_roles allow-list (shared permissions payload)", () => {
    for (const p of puts()) {
      const parsed = JSON.parse(p.body);
      const ids = parsed.permissions.map((x) => x.id).sort();
      assert.deepEqual(ids, [ROLE_JUNIOR_TIER, ROLE_SENIOR_TIER].sort());
      for (const entry of parsed.permissions) {
        assert.equal(entry.type, 1, "role permission type");
        assert.equal(entry.permission, true, "allow");
      }
    }
  });

  it("oauth row: last_sync_at stamped, last_sync_error cleared (shared persist path)", () => {
    const row = api.getCommandPermissionOauth(GUILD_A);
    assert.ok(row && Number(row.last_sync_at) > 0, "last_sync_at written by sync.js");
    assert.equal(row.last_sync_error, null);
    assert.equal(row.access_token, STORED_AT, "the stored token is untouched (no refresh needed)");
  });

  it("audit row: action/target/details match the SHARED entry shape; origin web; NO mirror", () => {
    assert.ok(webAudit, "web sync row exists");
    assert.equal(webAudit.action, "staff.sync_permissions");
    assert.equal(webAudit.target_type, "guild");
    assert.equal(webAudit.target_id, GUILD_A);
    assert.equal(webAudit.origin, "web");
    assert.equal(webAudit.actor_user_id, USER_ADMIN);
    assert.equal(webAudit.guild_id, GUILD_A);
    assert.deepEqual(webAudit.details, { role_count: 2, commands_updated: 3 });
    assert.deepEqual(mirrorSpy.log, [], "sync mirrors NO channel embed (slash parity)");
  });
});

// ===========================================================================
// G. PARTIAL — honest slug, audit kept, error persisted by the shared layer
// ===========================================================================

describe("G. partial sync — sync_partial + audit + persisted last_sync_error", () => {
  before(async () => {
    stageReady();
    discord.putFailIds.add("930000000000000002"); // "gork" PUT fails (500)
    const before = webAuditCount();
    const { location } = await syncPost({});
    assert.equal(location, `/g/${GUILD_A}/commands?done=sync_partial`);
    assert.equal(webAuditCount(), before + 1, "a RESOLVED partial still audits (slash parity)");
    await tick();
  });

  it("successes counted, failures surfaced; commands_updated = successes only", () => {
    assert.equal(puts().length, 3, "no 401-abort: all three PUTs attempted");
    const row = syncRows("web")[0];
    assert.deepEqual(row.details, { role_count: 2, commands_updated: 2 });
    const oauth = api.getCommandPermissionOauth(GUILD_A);
    assert.ok(String(oauth.last_sync_error).includes("gork"), "failure persisted by sync.js");
  });
});

// ===========================================================================
// H. DEAD AUTHORIZATION — reauth_required, row deleted, zero command PUTs
// ===========================================================================

describe("H. expired authorization — refresh refused ⇒ reauth_required", () => {
  before(async () => {
    stageReady();
    oauthSeedExpired(); // access token past expiry (skew) → refresh path
    discord.tokenRefreshOk = false; // refresh refused (400) — Discord revoked
    const before = webAuditCount();
    const { location } = await syncPost({ return: "staff" });
    assert.equal(location, `/g/${GUILD_A}/staff?error=reauth_required`);
    assert.equal(webAuditCount(), before, "hard sync failure audits NOTHING (slash parity)");
  });

  it("one token POST, ZERO command-list GETs and PUTs; stored row deleted", () => {
    assert.equal(discord.log.filter((e) => e.kind === "token-post").length, 1);
    assert.deepEqual(restGets(), [], "aborted before the command list");
    assert.deepEqual(puts(), [], "aborted before any PUT");
    assert.equal(api.getCommandPermissionOauth(GUILD_A), null, "getValidAccessToken deleted the row");
  });

  it("refresh SUCCEEDS after expiry ⇒ sync proceeds with the refreshed token", async () => {
    stageReady();
    oauthSeedExpired();
    discord.tokenRefreshOk = true;
    const { location } = await syncPost({});
    assert.equal(location, `/g/${GUILD_A}/commands?done=sync_completed`);
    for (const p of puts()) {
      assert.equal(p.auth, "Bearer refreshed-at-sentinel-NOT-REAL", "refreshed token persisted+used");
    }
    assert.equal(
      api.getCommandPermissionOauth(GUILD_A).access_token,
      "refreshed-at-sentinel-NOT-REAL"
    );
  });
});

// ===========================================================================
// I. HARD SYNC FAILURE — sync_failed slug, zero audit
// ===========================================================================

describe("I. transport outage mid-sync ⇒ sync_failed, nothing claimed", () => {
  before(async () => {
    stageReady();
    discord.restGetThrows = true;
    const before = webAuditCount();
    const { location } = await syncPost({});
    assert.equal(location, `/g/${GUILD_A}/commands?error=sync_failed`);
    assert.equal(webAuditCount(), before, "a THROWN sync writes NO audit row (slash parity)");
    assert.equal(
      api.getCommandPermissionOauth(GUILD_A).access_token,
      STORED_AT,
      "a transport outage does NOT burn the stored authorization"
    );
  });
});

// ===========================================================================
// J. FAIL-CLOSED — audit insert throws ⇒ generic 500, outcome unclaimed
// ===========================================================================

describe("J. fail-closed audit injection ⇒ 500, no Location, no mirror (§8.1-7)", () => {
  it("insertAdminAudit throwing on the sync route ⇒ 500 'Internal error'", async () => {
    stageReady();
    const before = webAuditCount();
    mirrorSpy.log.length = 0;
    recorder.auditThrow = true;
    const realError = console.error;
    console.error = () => {}; // expected 500 logging is noise here
    let out;
    try {
      out = await syncPost({ return: "staff" });
      await tick();
    } finally {
      recorder.auditThrow = false;
      console.error = realError;
    }
    assert.equal(out.res.status, 500);
    assert.equal(out.body, "Internal error");
    assert.equal(out.location, null, "the outcome is NEVER silently claimed");
    assert.equal(webAuditCount(), before, "the injected failure wrote no audit row");
    assert.deepEqual(mirrorSpy.log, [], "a failed insert schedules NO mirror");
  });
});

// ===========================================================================
// K. SLASH↔WEB PARITY (§8.11) — deep-equal REST sequences + audit rows
// ===========================================================================

describe("K. parity: real handleSyncPermissions vs the web POST", () => {
  let slashSeq;
  let webSeq;
  let slashAudit;
  let webAudit;

  /** Minimal ChatInputCommandInteraction-shaped mock (xp-grant/moderation precedent). */
  function makeSyncInteraction() {
    const replies = [];
    let deferred = null;
    return {
      replies,
      get deferred() {
        return deferred;
      },
      interaction: {
        guildId: GUILD_A,
        guild: { id: GUILD_A, name: "Alpha HQ" },
        user: { id: USER_ADMIN, username: "owner", tag: "owner#0001" },
        client: FAKE_CLIENT,
        memberPermissions: {
          has: (bit) => bit === require("discord.js").PermissionFlagsBits.ManageGuild,
        },
        options: {
          getSubcommand: () => "syncpermissions",
          getSubcommandGroup: () => null,
          getBoolean: (name) => (name === "force_reauth" ? false : null),
        },
        deferReply: async (payload) => {
          deferred = payload || true;
          return true;
        },
        editReply: async (payload) => {
          replies.push(payload);
          return {};
        },
      },
    };
  }

  /** Normalize the captured discord.log into the comparable sequence. */
  const captureSeq = () =>
    discord.log.map((e) => ({
      kind: e.kind,
      ...(e.kind === "rest-get" ? { path: e.path } : {}),
      ...(e.kind === "put"
        ? {
            url: e.url,
            auth: e.auth,
            permissions: JSON.parse(e.body).permissions.map((p) => [p.id, p.type, p.permission]),
          }
        : {}),
    }));

  before(async () => {
    // ---- slash side: the REAL handler (router-free, like the moderation suite)
    stageReady();
    const mock = makeSyncInteraction();
    await staffRolesFeature.handlers.staff(mock.interaction, {});
    assert.ok(mock.deferred, "the slash deferred before the sync (choreography intact)");
    assert.match(
      String((mock.replies[0] || {}).content || ""),
      /Synced slash-command visibility/,
      "the slash replied with its own success message (sanity: the handler ran)"
    );
    slashSeq = captureSeq();
    slashAudit = syncRows("slash")[0];

    // ---- web side: same stage, same mocks, same database
    stageReady();
    const { location } = await syncPost({});
    assert.equal(location, `/g/${GUILD_A}/commands?done=sync_completed`);
    webSeq = captureSeq();
    webAudit = syncRows("web")[0];
  });

  it("REST sequences deep-equal: same GET, same PUT urls/bodies/Authorization", () => {
    assert.ok(slashAudit, "the slash run wrote its audit row");
    assert.ok(webAudit, "the web run wrote its audit row");
    assert.deepEqual(
      webSeq,
      slashSeq,
      "web transport replays the slash's EXACT outbound Discord sequence (GET + Bearer PUTs)"
    );
    assert.ok(
      slashSeq.every((e) => e.kind !== "put" || e.auth === `Bearer ${STORED_AT}`),
      "both transports read the SAME stored slash token"
    );
  });

  it("audit rows identical except origin (action/target/details deep-equal)", () => {
    assert.equal(webAudit.origin, "web");
    assert.equal(slashAudit.origin, "slash");
    for (const col of ["action", "target_type", "target_id", "guild_id", "actor_user_id"]) {
      assert.equal(webAudit[col], slashAudit[col], `column ${col} equal across transports`);
    }
    assert.deepEqual(
      webAudit.details,
      slashAudit.details,
      "details deep-equal — ONE shared buildSyncAuditDetails"
    );
    assert.deepEqual(webAudit.details, { role_count: 2, commands_updated: 3 });
    assert.equal(webAudit.action, slashAudit.action);
  });

  it("neither transport schedules a channel mirror (§8.6 parity)", async () => {
    await tick();
    assert.deepEqual(mirrorSpy.log, [], "syncpermissions mirrors NOTHING anywhere");
  });
});
