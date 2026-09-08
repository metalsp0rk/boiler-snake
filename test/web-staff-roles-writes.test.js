/**
 * Phase 2 STAFF-ROLE + LEVEL-ROLE writes (subtask 25, roadmap web-admin.md
 * §8.6 "Staff & roles: staff_roles CRUD + levels | Staff (view) | Admin" +
 * cross-cutting rules + §8.8 Phase 2 exit: "Each mutation: CSRF-gated,
 * tier-correct, service-layer call, admin_audit row; parity checklist vs.
 * slash"). HTTP-level net test — real Express app on an ephemeral port,
 * REAL SQLite (temp DB; real staff_roles / level_roles / admin_audit rows),
 * FAKE Discord through the injected createGuildAccessResolver seam — same
 * harness as test/web-routes-staff.test.js (which stays the GET-side suite).
 *
 * Covers:
 *  - TIER MATRIX on every POST route: anon ⇒ 302 login, stranger/plain ⇒
 *    generic 404 (same bytes as the cross-guild 404 — never 403 for the
 *    wrong guild), junior/senior ⇒ 403 on role add/remove/setlevel (ADMIN
 *    required — mirrors the slash isAdminOrMod gates), level-role set/remove
 *    ⇒ STAFF tier (slash /leveltorole gates on isStaff — handler parity,
 *    NOT the ManageGuild picker default);
 *  - CSRF auto-enforcement on /g/ mutations (missing/bad _csrf ⇒ 403 with
 *    zero db/audit side effects; X-CSRF-Token header accepted — htmx path);
 *  - happy paths: 302 → /g/:guildId/staff (POST-Redirect-GET), correct
 *    staff_roles / level_roles rows via the SAME db helpers the slash calls
 *    (addStaffRole upsert parity, setStaffRoleLevel row-required + same-
 *    level rejection, removeStaffRole only-when-removed audit, unconditional
 *    deleteLevelRole + unconditional audit), GET read-back on the page;
 *  - EXACT slash audit vocabulary + detail shapes with origin "web":
 *    staff.role_add {level, previous_level}, staff.role_setlevel
 *    {previous_level, level}, staff.role_remove {previous_level},
 *    level_roles.set {level_required, drop_grace_days}, level_roles.remove
 *    (no details) — actor, guild, target columns pinned;
 *  - rejections: malformed/non-snowflake role id, @everyone (role id ===
 *    guild id), non-whitelisted level, non-integer level/drop days, unknown
 *    staff role, setlevel to the SAME level, remove of an unconfigured role
 *    — each 400 with FIXED body, NO db write and NO audit row;
 *  - cache-only Discord preflight via the getClient seam: role provably NOT
 *    in the guild cache ⇒ rejected (mirrors the slash role-picker
 *    guarantee); uncacheable (no client / guild not cached) ⇒ check skipped
 *    (slash parity); bot-below-target ⇒ level-role set refused with the
 *    sync.js hierarchy warning surfaced as a USER ERROR, not silent (§8.1-6);
 *  - NO command-visibility sync route is registered here (Phase 3 owns the
 *    trigger) and every unregistered /g/ subpath + non-POST verb on the
 *    registered templates stays the byte-exact app-wide 405.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// Clearly-fake placeholder only (AGENTS.md: never realistic secrets).
const SESSION_SECRET = "test-staffwrites-sentinel-secret-NOT-REAL-025";

const GUILD_A = "720000000000000001"; // bot + every test user
const GUILD_CROSS = "720000000000000002"; // bot guild the users are NOT in

const USER_ADMIN = "820000000000000001"; // owner:true ⇒ tier admin
const USER_STAFF = "820000000000000002"; // junior staff role ⇒ tier staff
const USER_SENIOR = "820000000000000003"; // senior staff role ⇒ tier senior
const USER_PLAIN = "820000000000000004"; // member, no staff role ⇒ no tier

// Tier-resolution roles (staff_roles rows — the SAME table the tier math
// reads; deliberately NOT snowflake-shaped so they can never be confused
// with the web-validated mutation inputs).
const ROLE_JUNIOR_TIER = "role-junior-staff";
const ROLE_SENIOR_TIER = "role-senior-staff";

// Snowflake-shaped role ids used as MUTATION inputs.
const ROLE_NEW = "500000000000000091";
const ROLE_UPSERT = "500000000000000092";
const ROLE_UNCONFIGURED = "500000000000000093"; // valid shape, no staff row
const ROLE_OUT_OF_CACHE = "500000000000000094"; // absent from the fake cache
const ROLE_IN_CACHE = "500000000000000095"; // present in the fake cache
const ROLE_MAPPED = "500000000000000096"; // level-role mapping subject

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
];
const BOT_GUILDS = [GUILD_A, GUILD_CROSS];

describe("web staff-role + level-role writes (Phase 2, subtask 25)", () => {
  /** @type {ReturnType<typeof loadDb>["api"]} */
  let api;
  let tmpDir;
  let savedEnv;

  /** @type {import("http").Server} */
  let server;
  let base;
  let appRef;

  const cookieOf = {};
  const csrfOf = {};
  /** session ids (for CSRF derivation) */
  const sessionIdOf = {};

  const fakeDiscord = {
    async getUserGuilds(token) {
      const userId = String(token).replace(/^tok-/, "");
      if (userId === USER_ADMIN) {
        return [
          { id: GUILD_A, name: "Alpha HQ", icon: null, owner: true, permissions: "0" },
        ];
      }
      if (userId === USER_STAFF || userId === USER_SENIOR || userId === USER_PLAIN) {
        return [
          { id: GUILD_A, name: "Alpha HQ", icon: null, owner: false, permissions: "104324673" },
        ];
      }
      return [];
    },
    async getUserGuildMember(token, guildId) {
      const userId = String(token).replace(/^tok-/, "");
      if (guildId !== GUILD_A) {
        const err = new Error("Unknown Guild");
        err.status = 404;
        throw err;
      }
      if (userId === USER_STAFF) return { roles: [ROLE_JUNIOR_TIER] };
      if (userId === USER_SENIOR) return { roles: [ROLE_SENIOR_TIER] };
      return { roles: [] };
    },
  };

  let appMod;
  let sessionPolicy;
  let tokens;
  let csrfMod;

  function mkSession(userKey, userId) {
    const s = sessionPolicy.createSession({ userId, discordTag: `${userId}#0001` });
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken(`tok-${userId}`),
      tokenExpiresAt: Date.now() + 3_600_000,
      scopes: "identify guilds guilds.members.read",
      guildSnapshot: "[]",
    });
    cookieOf[userKey] = `web_session=${s.id}`;
    sessionIdOf[userKey] = s.id;
    csrfOf[userKey] = csrfMod.deriveCsrfToken(s.id, SESSION_SECRET);
  }

  /** Boot an app with a FRESH resolver on an ephemeral port. */
  async function mountApp(extraOptions = {}) {
    if (server) {
      server.close();
      await once(server, "close");
    }
    const { createGuildAccessResolver } = require("../src/web/auth/guildAccess");
    const resolver = createGuildAccessResolver({
      discord: fakeDiscord,
      botGuilds: async () => BOT_GUILDS,
      now: Date.now,
      ttlMs: 60_000,
    });
    const app = appMod.createWebApp({
      guildAccess: resolver,
      botGuilds: async () => BOT_GUILDS,
      ...extraOptions,
    });
    appRef = app;
    server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  }

  /**
   * urlencoded POST (plain browser form semantics; redirect NOT followed).
   * The content-type MUST be urlencoded: bodyCap parses fields into
   * req.bodyFields ONLY for that content-type (anything else arrives as
   * {} — exactly what a non-form attacker would send).
   */
  async function post(urlPath, { cookie, fields, headers } = {}) {
    const res = await fetch(`${base}${urlPath}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { cookie } : {}),
        ...(headers || {}),
      },
      body: new URLSearchParams(fields || {}).toString(),
    });
    const body = await res.text();
    return { res, body };
  }

  /** GET helper (read-back assertions). */
  async function get(urlPath, { cookie } = {}) {
    const res = await fetch(`${base}${urlPath}`, {
      redirect: "manual",
      headers: cookie ? { cookie } : undefined,
    });
    const body = await res.text();
    return { res, body };
  }

  /** The newest web-origin audit rows for GUILD_A (details parsed). */
  function webAuditRows() {
    return api.listAdminAudit(GUILD_A, { origin: "web", limit: 100 }).map((r) => ({
      ...r,
      details: r.details_json ? JSON.parse(r.details_json) : null,
    }));
  }
  const findRow = (action) => webAuditRows().find((r) => r.action === action) || null;
  const webAuditCount = () => api.countAdminAudit(GUILD_A, { origin: "web" });

  before(async () => {
    savedEnv = ENV_KEYS.reduce((acc, k) => {
      acc[k] = process.env[k];
      return acc;
    }, {});
    const loaded = loadDb();
    api = loaded.api;
    tmpDir = loaded.tmpDir;
    process.env.SESSION_SECRET = SESSION_SECRET;
    for (const k of ENV_KEYS.slice(3)) delete process.env[k];

    appMod = require("../src/web/app");
    sessionPolicy = require("../src/web/auth/sessions");
    tokens = require("../src/web/auth/tokens");
    csrfMod = require("../src/web/middleware/csrf");

    // Tier-resolution roles ONLY (kept out of every mutation subject below).
    api.addStaffRole(GUILD_A, ROLE_JUNIOR_TIER, "junior");
    api.addStaffRole(GUILD_A, ROLE_SENIOR_TIER, "senior");

    mkSession("admin", USER_ADMIN);
    mkSession("staff", USER_STAFF);
    mkSession("senior", USER_SENIOR);
    mkSession("plain", USER_PLAIN);

    await mountApp();
  });

  after(() => {
    if (server) server.close();
    for (const key of ENV_KEYS) {
      if (savedEnv?.[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv?.[key];
    }
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  // -------------------------------------------------------------------------
  // 1. Mutation-gate registry lockstep + 405 byte-parity
  // -------------------------------------------------------------------------

  describe("methodGate registry + 405 byte-parity", () => {
    it("registers EXACTLY the five POST templates (and zero sync mutations)", () => {
      const staffRegs = appRef.locals.webMutations
        .filter((m) => m.path.startsWith("/g/:guildId/staff/"))
        .map((m) => `${m.method} ${m.path}`)
        .sort();
      assert.deepEqual(staffRegs, [
        "POST /g/:guildId/staff/levelrole/remove",
        "POST /g/:guildId/staff/levelrole/set",
        "POST /g/:guildId/staff/role/add",
        "POST /g/:guildId/staff/role/remove",
        "POST /g/:guildId/staff/role/setlevel",
      ]);
      // Scoped to /staff/ on purpose: sibling modules (settings,
      // integrations) own their own registry entries; this pin guards ONLY
      // this module's surface. When subtask 31 lands
      // POST /g/:guildId/staff/sync-permissions it MUST re-pin this list
      // (deliberate tripwire — sync triggering is Phase 3's decision).
      assert.ok(
        !staffRegs.some((entry) => /sync/i.test(entry)),
        "command-visibility sync stays Phase 3 — no sync mutation registered"
      );
    });

    it("non-POST verbs on registered templates + junk subpaths ⇒ byte 405", async () => {
      await mountApp();
      for (const sub of [
        "/staff/role/add",
        "/staff/role/remove",
        "/staff/role/setlevel",
        "/staff/levelrole/set",
        "/staff/levelrole/remove",
      ]) {
        for (const method of ["PUT", "PATCH", "DELETE"]) {
          const res = await fetch(`${base}/g/${GUILD_A}${sub}`, {
            method,
            headers: { cookie: cookieOf.admin },
          });
          assert.equal(res.status, 405, `${method} ${sub}`);
          assert.equal(await res.text(), "Method not allowed");
        }
      }
      for (const path of [
        "/staff/role",
        "/staff/role/unknown",
        "/staff/role/add/extra",
        "/staff/levelrole/unknown",
        "/staff/sync-permissions", // Phase 3 — must NOT be registered
        "/commands/sync",
      ]) {
        const res = await fetch(`${base}/g/${GUILD_A}${path}`, {
          method: "POST",
          headers: { cookie: cookieOf.admin },
        });
        assert.equal(res.status, 405, `POST ${path}`);
        assert.equal(await res.text(), "Method not allowed");
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. Tier matrix (§8.6) — cross-guild 404 before tier 403, anon 302
  // -------------------------------------------------------------------------

  const ROLE_ADD = "/g/" + GUILD_A + "/staff/role/add";

  describe("tier matrix — POST role add (ADMIN tier)", () => {
    it("anonymous ⇒ 302 to /auth/login?guild=…, empty body", async () => {
      const { res, body } = await post(ROLE_ADD, {
        fields: { role_id: ROLE_NEW, level: "junior" }, // no _csrf: anon passes CSRF, guildScope answers
      });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), `/auth/login?guild=${GUILD_A}`);
      assert.equal(body, "");
    });

    it("plain member (in-guild, no staff role) ⇒ generic 404 — never 403", async () => {
      const { res, body } = await post(ROLE_ADD, {
        cookie: cookieOf.plain,
        fields: { role_id: ROLE_NEW, level: "junior", _csrf: csrfOf.plain },
      });
      assert.equal(res.status, 404);
      assert.equal(body, "Not found");
    });

    it("cross-guild probe (valid CSRF) ⇒ the SAME plain 404 bytes", async () => {
      const cross = await post(`/g/${GUILD_CROSS}/staff/role/add`, {
        cookie: cookieOf.staff,
        fields: { role_id: ROLE_NEW, level: "junior", _csrf: csrfOf.staff },
      });
      assert.equal(cross.res.status, 404);
      assert.equal(cross.body, "Not found");
    });

    it("malformed guild id with a live admin session ⇒ generic 404", async () => {
      const { res, body } = await post("/g/oops-not-a-snowflake/staff/role/add", {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_NEW, level: "junior", _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 404);
      assert.equal(body, "Not found");
    });

    it("junior staff ⇒ 403 (ADMIN required — slash isAdminOrMod parity)", async () => {
      const before = webAuditCount();
      const { res, body } = await post(ROLE_ADD, {
        cookie: cookieOf.staff,
        fields: { role_id: ROLE_NEW, level: "junior", _csrf: csrfOf.staff },
      });
      assert.equal(res.status, 403);
      assert.equal(body, "Forbidden");
      assert.equal(api.getStaffRole(GUILD_A, ROLE_NEW), null, "no db write");
      assert.equal(webAuditCount(), before, "no audit row");
    });

    it("senior staff ⇒ 403 on all three role routes (add/remove/setlevel)", async () => {
      const before = webAuditCount();
      for (const sub of ["add", "remove", "setlevel"]) {
        const { res, body } = await post(`/g/${GUILD_A}/staff/role/${sub}`, {
          cookie: cookieOf.senior,
          fields: { role_id: ROLE_NEW, level: "senior", _csrf: csrfOf.senior },
        });
        assert.equal(res.status, 403, `senior POST role/${sub}`);
        assert.equal(body, "Forbidden");
      }
      assert.equal(api.getStaffRole(GUILD_A, ROLE_NEW), null);
      assert.equal(webAuditCount(), before);
    });

    it("admin passes the tier gate (no 403) — full happy path below", async () => {
      const { res } = await post(ROLE_ADD, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_NEW, level: "junior", _csrf: csrfOf.admin },
      });
      assert.notEqual(res.status, 403);
      assert.equal(res.status, 302);
    });
  });

  describe("tier matrix — POST levelrole set (STAFF tier — slash /leveltorole isStaff parity)", () => {
    // SLASH EVIDENCE: src/features/levelRoles/index.js gates with
    //   if (!isStaff(interaction)) return replyDenied(...)
    // — isStaff, NOT isAdminOrMod. The ManageGuild defaultMemberPermissions
    // on that command is picker visibility only ("Handlers remain the
    // security source of truth" — AGENTS.md §4). The web therefore mounts
    // requireTier("staff"): junior staff MUST be allowed.
    it("junior staff ⇒ 302 (isStaff parity — staff tier, not admin)", async () => {
      const { res } = await post(`/g/${GUILD_A}/staff/levelrole/set`, {
        cookie: cookieOf.staff,
        fields: { role_id: ROLE_MAPPED, level: "4", drop_days: "1", _csrf: csrfOf.staff },
      });
      assert.equal(res.status, 302);
      const rows = api.listLevelRoles(GUILD_A);
      assert.ok(
        rows.some((r) => r.role_id === ROLE_MAPPED && r.level_required === 4),
        "staff-tier write landed"
      );
      api.deleteLevelRole(GUILD_A, ROLE_MAPPED); // cleanup
    });

    it("senior staff ⇒ 302 (staff tier ladder covers senior)", async () => {
      const { res } = await post(`/g/${GUILD_A}/staff/levelrole/remove`, {
        cookie: cookieOf.senior,
        fields: { role_id: ROLE_MAPPED, _csrf: csrfOf.senior },
      });
      assert.equal(res.status, 302);
    });

    it("plain member ⇒ 404 and anon ⇒ 302 (cross-cutting guildScope rules)", async () => {
      const plain = await post(`/g/${GUILD_A}/staff/levelrole/set`, {
        cookie: cookieOf.plain,
        fields: { role_id: ROLE_MAPPED, level: "1", drop_days: "0", _csrf: csrfOf.plain },
      });
      assert.equal(plain.res.status, 404);
      const anon = await post(`/g/${GUILD_A}/staff/levelrole/set`, {
        fields: { role_id: ROLE_MAPPED, level: "1", drop_days: "0" },
      });
      assert.equal(anon.res.status, 302);
      assert.equal(anon.res.headers.get("location"), `/auth/login?guild=${GUILD_A}`);
    });

    it("cross-guild ⇒ 404 for the staff cookie too", async () => {
      const { res } = await post(`/g/${GUILD_CROSS}/staff/levelrole/remove`, {
        cookie: cookieOf.staff,
        fields: { role_id: ROLE_MAPPED, _csrf: csrfOf.staff },
      });
      assert.equal(res.status, 404);
    });
  });

  // -------------------------------------------------------------------------
  // 3. CSRF auto-enforcement (§8.7 — /g/ mutations)
  // -------------------------------------------------------------------------

  describe("CSRF enforcement", () => {
    // ROLE_NEW is junior at this point (the admin-tier test above created
    // it) — the CSRF assertions therefore pin "level UNCHANGED", proving
    // the denied request never reached the handler.
    it("missing _csrf ⇒ 403, no db write, no audit row", async () => {
      const before = webAuditCount();
      const { res, body } = await post(ROLE_ADD, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_NEW, level: "senior" },
      });
      assert.equal(res.status, 403);
      assert.equal(body, "Forbidden");
      assert.equal(api.getStaffRole(GUILD_A, ROLE_NEW).level, "junior", "untouched");
      assert.equal(webAuditCount(), before);
    });

    it("wrong _csrf ⇒ 403; the SAME request with the token succeeds", async () => {
      const before = webAuditCount();
      const bad = await post(ROLE_ADD, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_NEW, level: "senior", _csrf: "f".repeat(64) },
      });
      assert.equal(bad.res.status, 403);
      assert.equal(api.getStaffRole(GUILD_A, ROLE_NEW).level, "junior", "untouched");
      assert.equal(webAuditCount(), before);

      const good = await post(ROLE_ADD, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_NEW, level: "senior", _csrf: csrfOf.admin },
      });
      assert.equal(good.res.status, 302);
      assert.equal(api.getStaffRole(GUILD_A, ROLE_NEW).level, "senior", "then applied");
    });

    it("X-CSRF-Token header instead of the form field works (htmx path)", async () => {
      const { res } = await post(`/g/${GUILD_A}/staff/role/remove`, {
        cookie: cookieOf.admin,
        headers: { "X-CSRF-Token": csrfOf.admin },
        fields: { role_id: ROLE_NEW },
      });
      assert.equal(res.status, 302);
      assert.equal(api.getStaffRole(GUILD_A, ROLE_NEW), null, "row removed");
    });
  });

  // -------------------------------------------------------------------------
  // 4. staff_roles mutations — happy paths, exact table + audit state
  // -------------------------------------------------------------------------

  describe("POST role add — db helper + audit parity", () => {
    it("happy: 302 PRG, staff_roles row, staff.role_add audit (origin web)", async () => {
      const { res, body } = await post(ROLE_ADD, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_NEW, level: "junior", _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), `/g/${GUILD_A}/staff`);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(body, "");

      const row = api.getStaffRole(GUILD_A, ROLE_NEW);
      assert.ok(row, "staff_roles row written via the slash helper");
      assert.equal(row.level, "junior");

      const audit = findRow("staff.role_add");
      assert.ok(audit, "audit row written");
      assert.equal(audit.origin, "web");
      assert.equal(audit.actor_user_id, USER_ADMIN);
      assert.equal(audit.guild_id, GUILD_A);
      assert.equal(audit.target_type, "role");
      assert.equal(audit.target_id, ROLE_NEW);
      assert.deepEqual(audit.details, { level: "junior", previous_level: null });
    });

    it("GET read-back: the new row renders on the staff page", async () => {
      const { body } = await get(`/g/${GUILD_A}/staff`, { cookie: cookieOf.admin });
      assert.ok(body.includes(`<code class="role-id">${ROLE_NEW}</code>`));
      assert.ok(body.includes("staff-level-junior"));
    });

    it("re-add upserts (slash parity) and audits previous_level", async () => {
      const { res } = await post(ROLE_ADD, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_NEW, level: "senior", _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 302);
      assert.equal(api.getStaffRole(GUILD_A, ROLE_NEW).level, "senior");
      const audits = webAuditRows().filter((r) => r.action === "staff.role_add");
      assert.equal(audits[0].details.previous_level, "junior", "before/after honest");
      assert.equal(audits[0].details.level, "senior");
    });
  });

  describe("POST role setlevel — slash rejection parity", () => {
    before(() => {
      api.addStaffRole(GUILD_A, ROLE_UPSERT, "junior");
    });

    it("unknown role ⇒ 400, no write, no audit (slash: 'not a staff role')", async () => {
      const before = webAuditCount();
      const { res, body } = await post(`/g/${GUILD_A}/staff/role/setlevel`, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_UNCONFIGURED, level: "senior", _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 400);
      assert.match(body, /not a staff role/i);
      assert.equal(api.getStaffRole(GUILD_A, ROLE_UNCONFIGURED), null);
      assert.equal(webAuditCount(), before);
    });

    it("same level ⇒ 400 (no silent no-op), no write, no audit", async () => {
      const before = webAuditCount();
      const { res, body } = await post(`/g/${GUILD_A}/staff/role/setlevel`, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_UPSERT, level: "junior", _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 400);
      assert.match(body, /already junior staff/i);
      assert.equal(webAuditCount(), before, "duplicate setlevel writes NO audit row");
    });

    it("happy: junior→senior writes the row + staff.role_setlevel audit", async () => {
      const { res } = await post(`/g/${GUILD_A}/staff/role/setlevel`, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_UPSERT, level: "senior", _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), `/g/${GUILD_A}/staff`);
      assert.equal(api.getStaffRole(GUILD_A, ROLE_UPSERT).level, "senior");
      const audit = findRow("staff.role_setlevel");
      assert.ok(audit);
      assert.deepEqual(audit.details, { previous_level: "junior", level: "senior" });
      assert.equal(audit.origin, "web");
      assert.equal(audit.actor_user_id, USER_ADMIN);
    });
  });

  describe("POST role remove — audit ONLY when a row was deleted (slash parity)", () => {
    it("unconfigured role ⇒ 400, no audit", async () => {
      const before = webAuditCount();
      const { res, body } = await post(`/g/${GUILD_A}/staff/role/remove`, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_UNCONFIGURED, _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 400);
      assert.match(body, /not a configured staff role/i);
      assert.equal(webAuditCount(), before);
    });

    it("happy: row gone + staff.role_remove audit with previous_level", async () => {
      const { res } = await post(`/g/${GUILD_A}/staff/role/remove`, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_UPSERT, _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 302);
      assert.equal(api.getStaffRole(GUILD_A, ROLE_UPSERT), null);
      const audit = findRow("staff.role_remove");
      assert.ok(audit);
      assert.deepEqual(audit.details, { previous_level: "senior" });
      assert.equal(audit.origin, "web");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Validation rejections — fixed bodies, zero side effects
  // -------------------------------------------------------------------------

  describe("validation rejections (no db write, no audit row)", () => {
    before(() => {
      // Isolation: drop whatever earlier suites left on ROLE_NEW so every
      // rejection below can pin "row STILL absent" (direct helper — writes
      // no audit row of its own).
      api.removeStaffRole(GUILD_A, ROLE_NEW);
    });

    const rejects = [
      ["non-snowflake role id", { role_id: ROLE_JUNIOR_TIER, level: "junior", _csrf: "" }, /invalid role id/i],
      ["empty role id", { level: "junior", _csrf: "" }, /invalid role id/i],
      [
        "@everyone (role id === guild id)",
        { role_id: GUILD_A, level: "junior", _csrf: "" },
        /@everyone/i,
      ],
      ["non-whitelisted level", { role_id: ROLE_NEW, level: "boss", _csrf: "" }, /invalid staff level/i],
      ["missing level", { role_id: ROLE_NEW, _csrf: "" }, /invalid staff level/i],
    ];

    for (const [label, baseFields, pattern] of rejects) {
      it(`role add: ${label} ⇒ 400 fixed body`, async () => {
        const before = webAuditCount();
        const { res, body } = await post(ROLE_ADD, {
          cookie: cookieOf.admin,
          fields: { ...baseFields, _csrf: csrfOf.admin },
        });
        assert.equal(res.status, 400, label);
        assert.match(body, pattern);
        assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
        assert.equal(api.getStaffRole(GUILD_A, ROLE_NEW), null);
        assert.equal(webAuditCount(), before);
      });
    }

    it("jr/sr aliases normalize through the whitelist (normalizeStaffLevel parity)", async () => {
      const { res } = await post(ROLE_ADD, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_NEW, level: "jr", _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 302);
      assert.equal(api.getStaffRole(GUILD_A, ROLE_NEW).level, "junior");
      api.removeStaffRole(GUILD_A, ROLE_NEW); // cleanup (its own test owns no audit)
    });

    it("levelrole set: fractional / negative / missing numbers ⇒ 400, no row", async () => {
      const before = webAuditCount();
      for (const fields of [
        { role_id: ROLE_MAPPED, level: "1.5", drop_days: "0" },
        { role_id: ROLE_MAPPED, level: "-2", drop_days: "0" },
        { role_id: ROLE_MAPPED, level: "abc", drop_days: "0" },
        { role_id: ROLE_MAPPED, level: "5" }, // drop_days missing (slash: required)
        { role_id: GUILD_A, level: "5", drop_days: "1" }, // @everyone
      ]) {
        const { res, body } = await post(`/g/${GUILD_A}/staff/levelrole/set`, {
          cookie: cookieOf.admin,
          fields: { ...fields, _csrf: csrfOf.admin },
        });
        assert.equal(res.status, 400, JSON.stringify(fields));
        // Fixed bodies only — exactly the two validation messages, NEVER a
        // reflection of the submitted ids/numbers (XSS + enumeration guard).
        assert.ok(
          /^(Invalid number|You cannot use @everyone)/.test(body),
          `unexpected 400 body: ${body}`
        );
        assert.ok(!body.includes(ROLE_MAPPED), "role id never echoed");
      }
      assert.equal(api.listLevelRoles(GUILD_A).find((r) => r.role_id === ROLE_MAPPED), undefined);
      assert.equal(webAuditCount(), before);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Cache-only Discord preflight (getClient seam; NEVER a fetch)
  // -------------------------------------------------------------------------

  describe("cache-only role preflight", () => {
    /** Fake discord.js client exposing ONLY caches (any network call in a
     *  request path would be an unstubbed-method throw in these fakes). */
    function fakeClient({ roles, botHighestPosition }) {
      return {
        guilds: {
          cache: {
            get: (gid) =>
              gid === GUILD_A
                ? {
                    roles: { cache: { get: (rid) => roles[rid] } },
                    ...(botHighestPosition == null
                      ? {}
                      : { me: { roles: { highest: { position: botHighestPosition } } } }),
                  }
                : undefined,
          },
        },
      };
    }

    it("role provably NOT in the guild cache ⇒ 400 + no write + no audit", async () => {
      await mountApp({
        getClient: () => fakeClient({ roles: { [ROLE_IN_CACHE]: { name: "Known Role" } } }),
      });
      const before = webAuditCount();
      const { res, body } = await post(ROLE_ADD, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_OUT_OF_CACHE, level: "junior", _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 400);
      assert.match(body, /does not exist in this guild/i);
      assert.equal(api.getStaffRole(GUILD_A, ROLE_OUT_OF_CACHE), null);
      assert.equal(webAuditCount(), before);
    });

    it("role IS in the cache (no position data) ⇒ preflight passes through", async () => {
      await mountApp({
        getClient: () => fakeClient({ roles: { [ROLE_IN_CACHE]: { name: "Known Role" } } }),
      });
      const { res } = await post(ROLE_ADD, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_IN_CACHE, level: "junior", _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 302);
      assert.equal(api.getStaffRole(GUILD_A, ROLE_IN_CACHE).level, "junior");
    });

    it("no client / guild not cached ⇒ check SKIPPED (slash parity, never blocks)", async () => {
      await mountApp({ getClient: () => null });
      const { res } = await post(ROLE_ADD, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_OUT_OF_CACHE, level: "senior", _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 302);
      assert.equal(api.getStaffRole(GUILD_A, ROLE_OUT_OF_CACHE).level, "senior");
    });

    it("level-role set: bot BELOW the target role ⇒ 400 with the hierarchy warning", async () => {
      await mountApp({
        getClient: () =>
          fakeClient({
            roles: { [ROLE_IN_CACHE]: { name: "Above Bot", position: 10 } },
            botHighestPosition: 3,
          }),
      });
      const before = webAuditCount();
      const { res, body } = await post(`/g/${GUILD_A}/staff/levelrole/set`, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_IN_CACHE, level: "5", drop_days: "2", _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 400);
      assert.match(body, /bot's highest role is below/i, "sync.js warning surfaced, not silent");
      assert.equal(api.listLevelRoles(GUILD_A).find((r) => r.role_id === ROLE_IN_CACHE), undefined);
      assert.equal(webAuditCount(), before);
    });

    it("level-role set: bot ABOVE the target ⇒ accepted", async () => {
      await mountApp({
        getClient: () =>
          fakeClient({
            roles: { [ROLE_IN_CACHE]: { name: "Manageable", position: 4 } },
            botHighestPosition: 12,
          }),
      });
      const { res } = await post(`/g/${GUILD_A}/staff/levelrole/set`, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_IN_CACHE, level: "5", drop_days: "2", _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 302);
      assert.ok(
        api.listLevelRoles(GUILD_A).some((r) => r.role_id === ROLE_IN_CACHE)
      );
      api.deleteLevelRole(GUILD_A, ROLE_IN_CACHE); // cleanup
    });

    it("staff-role ADD ignores the hierarchy (staff rows are never role-assigned)", async () => {
      await mountApp({
        getClient: () =>
          fakeClient({
            roles: { [ROLE_IN_CACHE]: { name: "Above Bot", position: 30 } },
            botHighestPosition: 1,
          }),
      });
      const { res } = await post(ROLE_ADD, {
        cookie: cookieOf.admin,
        // already a staff row from an earlier test; re-add (upsert) proves
        // the position check is NOT applied to staff_roles writes
        fields: { role_id: ROLE_IN_CACHE, level: "senior", _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 302);
    });
  });

  // -------------------------------------------------------------------------
  // 7. level_roles lifecycle (slash /leveltorole parity incl. quirks)
  // -------------------------------------------------------------------------

  describe("level-role mapping lifecycle", () => {
    it("set ⇒ row + level_roles.set audit with exact detail shape", async () => {
      await mountApp();
      const { res } = await post(`/g/${GUILD_A}/staff/levelrole/set`, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_MAPPED, level: "7", drop_days: "3", _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), `/g/${GUILD_A}/staff`);
      const row = api.listLevelRoles(GUILD_A).find((r) => r.role_id === ROLE_MAPPED);
      assert.deepEqual(
        { level: row.level_required, drop: row.drop_grace_days },
        { level: 7, drop: 3 }
      );
      const setAudit = webAuditRows().find(
        (r) => r.action === "level_roles.set" && r.target_id === ROLE_MAPPED
      );
      assert.ok(setAudit);
      assert.deepEqual(setAudit.details, { level_required: 7, drop_grace_days: 3 });
      assert.equal(setAudit.origin, "web");
      assert.equal(setAudit.actor_user_id, USER_ADMIN);
    });

    it("GET read-back: the mapping renders on the staff page", async () => {
      const { body } = await get(`/g/${GUILD_A}/staff`, { cookie: cookieOf.admin });
      assert.ok(body.includes(`<code class="role-id">${ROLE_MAPPED}</code>`));
      assert.ok(body.includes("Level required"));
    });

    it("remove ⇒ row gone + level_roles.remove audit (NO details — slash parity)", async () => {
      const { res } = await post(`/g/${GUILD_A}/staff/levelrole/remove`, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_MAPPED, _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 302);
      assert.equal(
        api.listLevelRoles(GUILD_A).find((r) => r.role_id === ROLE_MAPPED),
        undefined
      );
      const audit = webAuditRows().find(
        (r) => r.action === "level_roles.remove" && r.target_id === ROLE_MAPPED
      );
      assert.ok(audit);
      assert.equal(audit.details, null, "slash /leveltorole remove writes NO details");
    });

    it("remove of an UNMAPPED role still deletes + audits (unconditional slash parity)", async () => {
      const { res } = await post(`/g/${GUILD_A}/staff/levelrole/remove`, {
        cookie: cookieOf.admin,
        fields: { role_id: ROLE_UNCONFIGURED, _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 302);
      assert.ok(
        webAuditRows().some(
          (r) => r.action === "level_roles.remove" && r.target_id === ROLE_UNCONFIGURED
        ),
        "the slash handler audits unconditionally — web mirrors the quirk"
      );
    });
  });

  // -------------------------------------------------------------------------
  // 8. Slash↔web parity vocabulary (roadmap §8.8 Phase 2 checklist row)
  // -------------------------------------------------------------------------

  describe("slash↔web audit vocabulary", () => {
    it("every web mutation reuses the EXACT slash action strings", () => {
      const actions = new Set(
        api.listAdminAudit(GUILD_A, { origin: "web", limit: 100 }).map((r) => r.action)
      );
      for (const action of [
        "staff.role_add", // src/features/staffRoles/index.js handleRoleAdd
        "staff.role_setlevel", // handleRoleSetLevel
        "staff.role_remove", // handleRoleRemove
        "level_roles.set", // src/features/levelRoles/index.js sub=set
        "level_roles.remove", // sub=remove
      ]) {
        assert.ok(actions.has(action), `action ${action} written by the web layer`);
      }
      // The web staff module's ENTIRE audit write-surface is these five
      // slash-vocabulary actions — nothing else may appear under origin
      // "web" for this guild (honest labels, no invented actions).
      const KNOWN = new Set([
        "staff.role_add",
        "staff.role_setlevel",
        "staff.role_remove",
        "level_roles.set",
        "level_roles.remove",
      ]);
      for (const row of api.listAdminAudit(GUILD_A, { origin: "web", limit: 100 })) {
        assert.ok(KNOWN.has(row.action), `unexpected web action: ${row.action}`);
      }
    });
  });
});
