/**
 * GET /g/:guildId/staff + GET /g/:guildId/commands — the Phase 1
 * staff-roles view + command-visibility sync status panel (subtask 19,
 * roadmap web-admin.md §8.6 "Staff & roles" + "Command visibility" rows +
 * cross-cutting 404 rule + query budget). HTTP-level net test: real
 * Express app on an ephemeral port, REAL SQLite (temp DB, real
 * staff_roles + guild_command_permission_oauth rows), FAKE Discord via
 * the injected createGuildAccessResolver seam — same harness style as
 * test/web-routes-settings.test.js.
 *
 * Covers:
 *  - tier matrix on BOTH paths: anonymous ⇒ login redirect, stranger ⇒
 *    generic 404, cross-guild ⇒ the SAME 404 bytes, malformed id ⇒ generic
 *    404, junior/senior/admin ⇒ 200 (§8.6);
 *  - seeded staff_roles rows render exact ids / levels / added_at (parity
 *    against api.listStaffRoles — the slash /staff list source of truth);
 *  - role-name seam: cache-only names, escaped, graceful id-only fallback
 *    when the client is absent/broken;
 *  - OAuth panel states: unconfigured env (missing NAMES only — never
 *    values), configured + authorized row (last_sync_at humanized,
 *    authorized-by id), stored last_sync_error XSS probe;
 *  - secrets (§8.1-9/§8.7): the stored fake refresh/access tokens NEVER
 *    appear in any body; projection field list is token-shaped-name-free.
 *  - query budget (§8.6): exactly THREE bounded facade reads on /staff
 *    (listStaffRoles + listLevelRoles + getCommandPermissionOauth), ONE
 *    on /commands, every read guild-scoped to the viewed guild;
 *  - read-only exact paths: POST/PUT/PATCH/DELETE on the EXACT page paths
 *    (/staff, /commands) and every unregistered /g/ subpath stay the
 *    byte-exact app-wide 405 — Phase 2 registered only the five mutation
 *    TEMPLATES (pinned here; behavior in test/web-staff-roles-writes.test.js);
 *  - Phase 2 form rendering: staff-role forms ADMIN-tier viewers only, the
 *    level-role forms for every viewer, all with the hidden _csrf.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// Clearly-fake placeholder only (AGENTS.md: never realistic secrets).
const SESSION_SECRET = "test-staff…cret";

// Clearly-fake token STANDINS used only to prove they never render.
const FAKE_REFRESH = "fake-refre…ERED";
const FAKE_ACCESS = "fake-acces…ERED";

const GUILD_A = "720000000000000001"; // bot + every test user
const GUILD_CROSS = "720000000000000002"; // bot guild the users are NOT in

const USER_ADMIN = "820000000000000001"; // owner:true ⇒ tier admin
const USER_STAFF = "820000000000000002"; // junior staff role ⇒ tier staff
const USER_SENIOR = "820000000000000003"; // senior staff role ⇒ tier senior
const USER_PLAIN = "820000000000000004"; // member, no staff role ⇒ no tier
const USER_AUTHORIZER = "820000000000000009"; // (data only) authorized_by

const PATHS = ["/staff", "/commands"];

/** Stable old ts for the unit projection fixture. */
const UNIT_SYNC_TS = Date.parse("2026-09-01T00:00:00Z");

/**
 * Env the OAuth-config reader looks at. Deleted for the whole suite so the
 * DEFAULT app state is deterministically "not configured"; the configured
 * state is exercised through the oauthConfig seam instead of real env.
 */
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

/** Exactly what ONE /staff page build may read (query budget). Phase 2
 * (subtask 25) added the bounded per-guild listLevelRoles read — the
 * level→role config the staff page now lists and the /staff/levelrole/*
 * forms mutate. /commands still reads NOTHING it does not show. */
const STAFF_PAGE_READS = [
  "listStaffRoles",
  "listLevelRoles",
  "getCommandPermissionOauth",
];

describe("web staff page + command-visibility panel (GET-only, staff tier)", () => {
  /** @type {ReturnType<typeof loadDb>["api"]} */
  let api;
  let tmpDir;
  let savedEnv;

  /** @type {import("http").Server} */
  let server;
  let base;
  /** Last app built by mountApp (methodGate registry inspection). */
  let appRef;

  const cookieOf = {};

  const fakeDiscord = {
    async getUserGuilds(token) {
      const userId = String(token).replace(/^tok-/, "");
      if (userId === USER_ADMIN) {
        return [
          { id: GUILD_A, name: "Alpha HQ", icon: null, owner: true, permissions: "0" },
        ];
      }
      if (userId === USER_PLAIN || userId === USER_STAFF || userId === USER_SENIOR) {
        return [
          {
            id: GUILD_A,
            name: "Alpha HQ",
            icon: null,
            owner: false,
            permissions: "104324673", // no ManageGuild/Administrator bits
          },
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
      if (userId === USER_STAFF) return { roles: ["role-junior-staff"] };
      if (userId === USER_SENIOR) return { roles: ["role-senior-staff"] };
      return { roles: [] };
    },
  };

  let appMod;
  let staffDataMod;
  let sessionPolicy;
  let tokens;
  let usersViews;

  /** Live sessions with encrypted ATs the real resolver can decrypt. */
  function mkSession(userId) {
    const s = sessionPolicy.createSession({ userId, discordTag: `${userId}#0001` });
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken(`tok-${userId}`),
      tokenExpiresAt: Date.now() + 3_600_000,
      scopes: "identify guilds guilds.members.read",
      guildSnapshot: "[]",
    });
    return s.id;
  }

  /**
   * Boot an app with a FRESH resolver on an ephemeral port. Options pass
   * straight through to createWebApp (staffData / oauthConfig / getClient
   * seams), mirroring the settings suite's cache-bleed avoidance.
   * @param {Record<string, unknown>} [extraOptions]
   */
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
    appRef = app; // registry inspection (webMutations lockstep assertions)
    server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  }

  /**
   * @param {string} urlPath
   * @param {{ cookie?: string, method?: string }} [opts]
   */
  async function req(urlPath, { cookie, method = "GET" } = {}) {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      redirect: "manual",
      headers: cookie ? { cookie } : undefined,
    });
    const body = await res.text();
    return { res, body };
  }

  /**
   * Facade proxy that COUNTS the staff-page facade reads while delegating
   * to the real facade (the data module looks methods up per call, so this
   * proxy object IS what runs).
   */
  function startReadCounter() {
    const calls = [];
    const proxy = Object.create(api);
    for (const name of STAFF_PAGE_READS) {
      proxy[name] = (...args) => {
        calls.push({ name, args });
        return api[name](...args);
      };
    }
    return { calls, proxy };
  }

  before(async () => {
    savedEnv = ENV_KEYS.reduce((acc, k) => {
      acc[k] = process.env[k];
      return acc;
    }, {});
    const loaded = loadDb();
    api = loaded.api;
    tmpDir = loaded.tmpDir;
    process.env.SESSION_SECRET = SESSION_SECRET;
    // Deterministic "environment not configured" default state.
    for (const k of ENV_KEYS.slice(3)) delete process.env[k];

    appMod = require("../src/web/app");
    staffDataMod = require("../src/web/data/staffData");
    sessionPolicy = require("../src/web/auth/sessions");
    tokens = require("../src/web/auth/tokens");
    usersViews = require("../src/web/views/users");

    // Tier-resolution roles (also rendered rows — the page lists the SAME
    // staff_roles table the tier math reads).
    api.addStaffRole(GUILD_A, "role-junior-staff", "junior");
    api.addStaffRole(GUILD_A, "role-senior-staff", "senior");
    // Extra seeded rows (exact-render fixtures).
    api.addStaffRole(GUILD_A, "500000000000000001", "senior");
    api.addStaffRole(GUILD_A, "500000000000000002", "junior");

    cookieOf.admin = `web_session=${mkSession(USER_ADMIN)}`;
    cookieOf.staff = `web_session=${mkSession(USER_STAFF)}`;
    cookieOf.senior = `web_session=${mkSession(USER_SENIOR)}`;
    cookieOf.plain = `web_session=${mkSession(USER_PLAIN)}`;

    await mountApp();
  });

  after(() => {
    if (server) {
      server.close();
    }
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
  // Tier matrix (§8.6) + cross-cutting 404 rule — BOTH paths
  // -------------------------------------------------------------------------

  describe("tier matrix", () => {
    for (const path of PATHS) {
      it(`anonymous ${path} ⇒ 302 to /auth/login?guild=…`, async () => {
        const { res, body } = await req(`/g/${GUILD_A}${path}`);
        assert.equal(res.status, 302);
        assert.equal(res.headers.get("location"), `/auth/login?guild=${GUILD_A}`);
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.equal(body, "");
      });

      it(`stranger (live member, no staff role) ${path} ⇒ generic 404, never 403`, async () => {
        const { res, body } = await req(`/g/${GUILD_A}${path}`, { cookie: cookieOf.plain });
        assert.equal(res.status, 404);
        assert.equal(body, "Not found");
        assert.match(res.headers.get("content-type"), /^text\/plain/);
      });

      it(`cross-guild probe ${path} ⇒ the SAME plain 404 bytes (§8.6)`, async () => {
        const stranger = await req(`/g/${GUILD_A}${path}`, { cookie: cookieOf.plain });
        const cross = await req(`/g/${GUILD_CROSS}${path}`, { cookie: cookieOf.staff });
        assert.equal(cross.res.status, 404);
        assert.equal(cross.body, stranger.body);
      });

      it(`malformed guild id with a live session ${path} ⇒ generic 404`, async () => {
        const { res, body } = await req("/g/oops-not-a-snowflake" + path, {
          cookie: cookieOf.admin,
        });
        assert.equal(res.status, 404);
        assert.equal(body, "Not found");
      });

      for (const [label, cookie] of [
        ["junior staff", () => cookieOf.staff],
        ["senior staff", () => cookieOf.senior],
        ["guild owner (admin)", () => cookieOf.admin],
      ]) {
        it(`${label} ⇒ 200 ${path} shell`, async () => {
          const { res, body } = await req(`/g/${GUILD_A}${path}`, { cookie: cookie() });
          assert.equal(res.status, 200);
          assert.match(res.headers.get("content-type"), /^text\/html; charset=utf-8/);
          assert.equal(res.headers.get("cache-control"), "no-store");
          assert.ok(body.includes("Command visibility"), "sync panel present on both views");
          assert.equal(body.match(/\son[a-z]+\s*=\s*["']/i), null);
        });
      }
    }
  });

  // -------------------------------------------------------------------------
  // Seeded staff_roles rows: exact ids / levels / added_at (parity with the
  // repository rows the slash /staff role list reads)
  // -------------------------------------------------------------------------

  describe("staff_roles table renders seeded rows exactly", () => {
    it("every row: role id, level badge and added_at match the DB", async () => {
      await mountApp();
      const rows = api.listStaffRoles(GUILD_A);
      assert.equal(rows.length, 4, "two tier roles + two seeded fixtures");
      const { res, body } = await req(`/g/${GUILD_A}/staff`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      for (const r of rows) {
        assert.ok(
          body.includes(`<code class="role-id">${r.role_id}</code>`),
          `role id ${r.role_id} rendered exactly`
        );
        // Level class comes from the whitelisted junior|senior set.
        assert.ok(
          body.includes(`staff-level-${r.level}`),
          `level ${r.level} pill class for ${r.role_id}`
        );
        // formatWhen embeds the ISO minute stamp ("YYYY-MM-DD HH:mm") —
        // pin THAT part exactly; the relative tail is clock-dependent.
        const iso = new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ");
        assert.ok(body.includes(iso), `added_at ${iso} rendered for ${r.role_id}`);
      }
      assert.ok(body.includes("<strong>4</strong> staff roles"), "count line honest");
      assert.ok(body.includes("· 2 senior · 2 junior"), "level counts honest");
      // Level-gate legend mirrors AGENTS.md §4 intent.
      assert.ok(body.includes("Manage Server OR any"), "staff gate legend");
      assert.ok(body.includes("ticket-channel"), "senior ticket-overwrite legend");
    });

    it("advisory strip: bot-above-roles gotcha + Manage-Server-only writes (§8.6 write tier)", async () => {
      const { body } = await req(`/g/${GUILD_A}/staff`, { cookie: cookieOf.senior });
      assert.ok(body.includes("must sit"), "bot-role-position advisory present");
      assert.ok(body.includes("<strong>above</strong>"), "bot-above-roles wording");
      assert.ok(body.includes("/staff role setlevel"), "mutation slash cross-refs");
      assert.ok(
        body.includes("badge-tier-admin"),
        "write-tier badge says admin (§8.6 Admin column)"
      );
      assert.ok(body.includes("Phase 2"), "web writes land in Phase 2, not here");
    });
  });

  // -------------------------------------------------------------------------
  // Role-name seam (cache-only, escaped, graceful fallback)
  // -------------------------------------------------------------------------

  describe("role name seam via getClient", () => {
    const fakeClient = {
      guilds: {
        cache: {
          get: (gid) =>
            gid === GUILD_A
              ? {
                  roles: {
                    cache: {
                      get: (rid) =>
                        rid === "500000000000000001"
                          ? { name: "Mod<b>&Team</b>" }
                          : undefined,
                    },
                  },
                }
              : undefined,
        },
      },
    };

    it("cached names decorate ids (escaped); unknown roles stay id-only", async () => {
      await mountApp({ getClient: () => fakeClient });
      const { res, body } = await req(`/g/${GUILD_A}/staff`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      assert.ok(body.includes("(Mod&lt;b&gt;&amp;Team&lt;/b&gt;)"), "escaped cached name shown");
      assert.ok(!body.includes("Mod<b>"), "name never live");
      assert.ok(body.includes(`<code class="role-id">500000000000000002</code>`));
    });

    it("absent / THROWING getClient degrade to ids — never a 500, never a fetch", async () => {
      for (const getClient of [null, () => { throw new Error("client exploded"); }]) {
        await mountApp({ getClient });
        const { res, body } = await req(`/g/${GUILD_A}/staff`, { cookie: cookieOf.staff });
        assert.equal(res.status, 200);
        assert.ok(body.includes(`500000000000000001`), "id still rendered");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Command-visibility panel — UNCONFIGURED state (default env, no oauth row)
  // -------------------------------------------------------------------------

  describe("sync panel: unconfigured env + no authorization", () => {
    it("renders missing env NAMES only, says not authorized, triggers nothing", async () => {
      await mountApp(); // no seams → real config reader against deleted env
      const { res, body } = await req(`/g/${GUILD_A}/commands`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      assert.ok(body.includes("not authorized"), "authorization state honest");
      assert.ok(body.includes("environment not configured"), "env state honest");
      // Missing NAMES enumerated (config.missing, names only — §8.10 env).
      assert.ok(body.includes("CLIENT_ID"), "CLIENT_ID named");
      assert.ok(body.includes("CLIENT_SECRET"), "CLIENT_SECRET named");
      assert.ok(body.includes("PUBLIC_HTTP_PORT"), "PUBLIC_HTTP_PORT named");
      assert.ok(body.includes("PUBLIC_BASE_URL"), "PUBLIC_BASE_URL named");
      // Never a value anywhere: no secrets, no tokens, no sync affordances.
      assert.ok(!body.includes(FAKE_REFRESH) && !body.includes(FAKE_ACCESS));
      // View defers the sync ACTION to Phase 3 — the honest rendered claim
      // (the "no OAuth performed by a GET" guarantee is the no-forms
      // assertion below: a view with no POST affordance cannot trigger).
      assert.ok(body.includes("trigger arrives in Phase 3"), "sync action deferred to Phase 3 (§8.8)");
      // No mutation form on the PAGE itself (the shell's logout form is the
      // only POST affordance in the document — slice to <main> to assert it).
      const main = body.slice(body.indexOf("<main"), body.indexOf("</main>"));
      assert.equal(main.match(/<form/i), null, "page body carries no forms at all");
    });
  });

  // -------------------------------------------------------------------------
  // Command-visibility panel — CONFIGURED + AUTHORIZED row (seeded via the
  // real facade so the projection runs on a real SELECT * row)
  // -------------------------------------------------------------------------

  describe("sync panel: configured env + authorized guild with sync history", () => {
    const REDIRECT_URI =
      "https://admin.example.invalid/oauth/command-permissions/callback";
    const LAST_SYNC_AT = Date.parse("2026-09-01T12:00:00Z"); // fixed, old
    const XSS_ERROR = '<img src=x onerror="alert(9)">';

    before(() => {
      api.upsertCommandPermissionOauth(GUILD_A, {
        refreshToken: FAKE_REFRESH,
        accessToken: FAKE_ACCESS,
        accessExpiresAt: Date.now() + 3_600_000,
        authorizedByUserId: USER_AUTHORIZER,
      });
      api.setCommandPermissionSyncResult(GUILD_A, {
        lastSyncAt: LAST_SYNC_AT,
        lastSyncError: XSS_ERROR,
      });
    });

    const configuredEnv = () => ({
      ready: true,
      // Seam stands in for the env-derived values (never real env reads):
      clientId: "123456789012345678",
      clientSecret: "FAKE-SECRET-NEVER-RENDERED",
      redirectUri: REDIRECT_URI,
      port: 8787,
      publicBaseUrl: "https://admin.example.invalid",
      missing: [],
    });

    it("authorized + env-ready: redirect URI, authorizer, exact last_sync_at", async () => {
      await mountApp({ oauthConfig: configuredEnv });
      const { res, body } = await req(`/g/${GUILD_A}/commands`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      assert.ok(body.includes(">authorized<"), "authorized badge");
      assert.ok(body.includes("environment ready"), "env-ready badge");
      assert.ok(body.includes(REDIRECT_URI), "operator redirect URI shown");
      assert.ok(body.includes(`<code>${USER_AUTHORIZER}</code>`), "authorized-by id");
      assert.ok(
        body.includes(new Date(LAST_SYNC_AT).toISOString().slice(0, 16).replace("T", " ")),
        "last_sync_at rendered"
      );
    });

    it("stored last_sync_error renders ESCAPED — XSS probe never live", async () => {
      const { body } = await req(`/g/${GUILD_A}/commands`, { cookie: cookieOf.senior });
      assert.ok(
        body.includes("&lt;img src=x onerror=&quot;alert(9)&quot;&gt;"),
        "stored error escaped"
      );
      assert.ok(!body.includes(`<img src=x`), "no live img element");
      assert.equal(body.match(/\son[a-z]+\s*=\s*["']/i), null, "no on* attribute anywhere");
    });

    it("token columns NEVER render (§8.1-9): not even on the staff page", async () => {
      const { body } = await req(`/g/${GUILD_A}/staff`, { cookie: cookieOf.staff });
      assert.ok(!body.includes(FAKE_REFRESH), "refresh token not rendered");
      assert.ok(!body.includes(FAKE_ACCESS), "access token not rendered");
      assert.ok(!body.includes("FAKE-SECRET-NEVER-RENDERED"), "env secret value not rendered");
    });

    it("staff page embeds the same panel (states consistent across views)", async () => {
      const { body } = await req(`/g/${GUILD_A}/staff`, { cookie: cookieOf.admin });
      assert.ok(body.includes("Command visibility sync"), "panel heading");
      assert.ok(body.includes(REDIRECT_URI), "same data as /commands");
    });
  });

  // -------------------------------------------------------------------------
  // Secrets projection unit (§8.7 — the data module is the guard)
  // -------------------------------------------------------------------------

  describe("oauth status projection is secret-free by construction", () => {
    it("projection emits ONLY the whitelisted status fields", () => {
      const projected = staffDataMod.projectOauthView({
        guild_id: GUILD_A,
        refresh_token: FAKE_REFRESH,
        access_token: FAKE_ACCESS,
        access_expires_at: 1,
        authorized_by_user_id: USER_AUTHORIZER,
        last_sync_at: UNIT_SYNC_TS,
        last_sync_error: null,
        created_at: 2,
        updated_at: 3,
      });
      assert.deepEqual(
        Object.keys(projected).sort(),
        [...staffDataMod.OAUTH_PUBLIC_FIELDS].sort(),
        "projection fields pinned — a new field must be security-reviewed"
      );
      assert.equal(staffDataMod.projectOauthView(null), null);
    });

    it("no whitelisted field name is token/secret-shaped", () => {
      for (const f of staffDataMod.OAUTH_PUBLIC_FIELDS) {
        assert.equal(/token|secret|passw|credential/i.test(f), false, `field ${f}`);
      }
    });

    it("route env-config reader strips clientId/clientSecret (§8.7)", () => {
      const { readEnvConfig } = require("../src/web/routes/staff");
      const out = readEnvConfig(() => ({
        ready: false,
        clientId: "FAKE-CLIENT-ID-VALUE",
        clientSecret: "FAKE-CLIENT-SECRET-VALUE",
        redirectUri: null,
        missing: ["CLIENT_SECRET"],
      }));
      assert.deepEqual(Object.keys(out).sort(), ["available", "missing", "ready", "redirectUri"]);
      assert.ok(!JSON.stringify(out).includes("FAKE-CLIENT"), "no env VALUES escape the sanitizer");
      const broken = readEnvConfig(() => {
        throw new Error("config exploded");
      });
      assert.deepEqual(broken, { available: false, ready: false, redirectUri: null, missing: [] });
    });
  });

  // -------------------------------------------------------------------------
  // Query budget (§8.6, review-blocking)
  // -------------------------------------------------------------------------

  describe("query budget", () => {
    it("/staff = exactly THREE bounded facade reads; /commands = ONE; all guild-scoped", async () => {
      const { calls, proxy } = startReadCounter();
      await mountApp({
        staffData: staffDataMod.createStaffData({ db: proxy }),
      });

      const staffPage = await req(`/g/${GUILD_A}/staff`, { cookie: cookieOf.staff });
      assert.equal(staffPage.res.status, 200);
      assert.deepEqual(
        calls.map((c) => c.name).sort(),
        [...STAFF_PAGE_READS].sort(),
        "exactly one listStaffRoles + one listLevelRoles + one getCommandPermissionOauth"
      );
      assert.deepEqual(
        calls.map((c) => c.args[0]),
        [GUILD_A, GUILD_A, GUILD_A],
        "every read is guild-scoped to the viewed guild"
      );

      calls.length = 0;
      const cmdPage = await req(`/g/${GUILD_A}/commands`, { cookie: cookieOf.staff });
      assert.equal(cmdPage.res.status, 200);
      assert.deepEqual(
        calls.map((c) => c.name),
        ["getCommandPermissionOauth"],
        "the commands page does not read roles it never shows"
      );
    });
  });

  // -------------------------------------------------------------------------
  // Phase 2 mutation forms (subtask 25) — RENDERING policy only; the tier
  // gate lives on the POST routes (behavior in web-staff-roles-writes.test.js)
  // -------------------------------------------------------------------------

  describe("Phase 2 mutation forms", () => {
    it("admin viewer: staff-role + level-role forms with hidden _csrf", async () => {
      await mountApp();
      const { res, body } = await req(`/g/${GUILD_A}/staff`, { cookie: cookieOf.admin });
      assert.equal(res.status, 200);
      for (const action of [
        `/g/${GUILD_A}/staff/role/add`,
        `/g/${GUILD_A}/staff/role/setlevel`,
        `/g/${GUILD_A}/staff/role/remove`,
        `/g/${GUILD_A}/staff/levelrole/set`,
        `/g/${GUILD_A}/staff/levelrole/remove`,
      ]) {
        assert.ok(body.includes(`action="${action}"`), `form posts to ${action}`);
      }
      assert.ok(body.includes('name="_csrf"'), "every page carries the CSRF input");
      assert.ok(body.includes('name="drop_days"'), "level-role set fields present");
      assert.equal(body.match(/\son[a-z]+\s*=\s*["']/i), null, "no inline handlers");
    });

    it("staff/senior viewers: NO admin-tier role forms; level-role forms DO render", async () => {
      await mountApp();
      for (const cookie of [cookieOf.staff, cookieOf.senior]) {
        const { res, body } = await req(`/g/${GUILD_A}/staff`, { cookie });
        assert.equal(res.status, 200);
        for (const action of ["add", "setlevel", "remove"]) {
          assert.ok(
            !body.includes(`/staff/role/${action}"`),
            `role-${action} form is admin-only (§8.6)`
          );
        }
        // /leveltorole gates on isStaff ⇒ every viewer of this page mutates
        // level-roles at the SAME tier the slash handler enforces.
        assert.ok(
          body.includes(`/staff/levelrole/set"`),
          "level-role set form renders for staff tier (slash parity)"
        );
      }
    });

    it("level→role mappings render from the SAME level_roles table slash lists", async () => {
      await mountApp();
      api.upsertLevelRole(GUILD_A, "500000000000000007", 7, 3);
      try {
        const { body } = await req(`/g/${GUILD_A}/staff`, { cookie: cookieOf.admin });
        assert.ok(
          body.includes(`<code class="role-id">500000000000000007</code>`),
          "mapped role id rendered"
        );
        assert.ok(body.includes("Level required"), "mapping table header");
      } finally {
        api.deleteLevelRole(GUILD_A, "500000000000000007");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Exact-path 405 pins (§8.8/§8.6): Phase 2 registered ONLY the five
  // mutation templates. The page paths themselves, other verbs on the
  // registered subpaths, and junk under /staff stay byte-exact 405s.
  // -------------------------------------------------------------------------

  it("405 byte-parity: page paths, non-POST verbs, junk subpaths, sync paths", async () => {
    // (a) The two PAGE paths take no direct POST/PUT/PATCH/DELETE at all.
    for (const path of PATHS) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await fetch(`${base}/g/${GUILD_A}${path}`, {
          method,
          headers: { cookie: cookieOf.staff },
        });
        assert.equal(res.status, 405, `${method} ${path} must hit the app-wide 405 gate`);
        assert.equal(await res.text(), "Method not allowed");
      }
    }
    // (b) Registered mutation templates answer POST ONLY (methodGate is
    //     method-exact): other verbs 405 byte-identically.
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
        assert.equal(res.status, 405, `${method} ${sub} is not a registered mutation`);
        assert.equal(await res.text(), "Method not allowed");
      }
    }
    // (c) Unregistered /g/ subpaths never reach CSRF/router — plain 405.
    for (const path of [
      "/staff/role",
      "/staff/role/unknown",
      "/staff/role/add/extra",
      "/staff/levelrole/unknown",
      "/staff/unknown",
      // Sync trigger = Phase 3 (subtask 31): NO sync/sync-permissions route
      // is registered by Phase 2 (this suite owns that pin).
      "/staff/sync-permissions",
      "/commands/sync",
    ]) {
      const res = await fetch(`${base}/g/${GUILD_A}${path}`, {
        method: "POST",
        headers: { cookie: cookieOf.admin },
      });
      assert.equal(res.status, 405, `POST ${path} stays unregistered (Phase 3 / junk)`);
      assert.equal(await res.text(), "Method not allowed");
    }
  });

  it("methodGate registry contains EXACTLY the five staff mutation templates", () => {
    const registered = appRef.locals.webMutations
      .filter((m) => m.path.startsWith("/g/:guildId/staff/"))
      .map((m) => `${m.method} ${m.path}`)
      .sort();
    assert.deepEqual(registered, [
      "POST /g/:guildId/staff/levelrole/remove",
      "POST /g/:guildId/staff/levelrole/set",
      "POST /g/:guildId/staff/role/add",
      "POST /g/:guildId/staff/role/remove",
      "POST /g/:guildId/staff/role/setlevel",
    ]);
    // NO sync/sync-permissions mutation (command visibility = Phase 3):
    assert.equal(
      appRef.locals.webMutations.some((m) => /sync/i.test(m.path)),
      false,
      "subtask 25 registers ZERO sync mutations (Phase 3 owns the trigger)"
    );
  });
});
