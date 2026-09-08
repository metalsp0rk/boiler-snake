/**
 * POST /g/:guildId/integrations/* — the Phase 2 config mutations (subtask 26,
 * roadmap web-admin.md §8.6 "Integrations … Staff | per-command tier
 * (/honeypot exempt = Admin)"). HTTP-level net test: real Express app on an
 * ephemeral port, REAL SQLite (temp DB, real admin_audit rows), FAKE Discord
 * through the createGuildAccessResolver seam + a CACHE-ONLY fake client for
 * the channel/role preflights — same harness style as
 * test/web-routes-settings.test.js Phase 2 section.
 *
 * Covers per mutation: anonymous ⇒ 302 login, member-without-tier ⇒ the
 * generic 404 (guildScope), junior/senior on the ADMIN-only exempt pair ⇒
 * 403, cross-guild ⇒ 404, CSRF reject ⇒ 403 with NOTHING written or audited,
 * validation rejects ⇒ PRG error slug with no DB change and no audit row,
 * happy path ⇒ PRG done slug + the write is READ BACK through the facade +
 * exactly one admin_audit row with the EXACT slash action and origin 'web'.
 *
 * Honeypot exempt writes land in staff_roles (via the facade aliases) — read
 * back through listStaffRoles, audited staff.role_add/staff.role_remove with
 * details.via "honeypot.exempt" (slash vocabulary).
 *
 * Service seams (lookupYoutubeChannel / resolveTwitchUser /
 * fetchYoutubeChannelInfo / ensureHoneypotWarning) are injected so the tests
 * never touch the network; env vars are clearly-fake sentinels and are
 * restored after (AGENTS.md: never realistic secrets).
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// Clearly-fake placeholders only (AGENTS.md: never realistic secrets).
const SESSION_SECRET = "test-integwri…cret";
const SENTINEL_YT_KEY = "SENTIN…-key";
const SENTINEL_TW_ID = "SENTINEL-TWITCH-ID-clearly-fake";
const SENTINEL_TW_SECRET = "SENTINEL-TWITCH-SECRET-clearly-fake";

const GUILD_A = "720000000000000001"; // bot + every test user
const GUILD_CROSS = "720000000000000002"; // bot guild the users are NOT in

const USER_ADMIN = "820000000000000001"; // owner:true ⇒ tier admin
const USER_STAFF = "820000000000000002"; // junior staff role ⇒ tier staff
const USER_SENIOR = "820000000000000003"; // senior staff role ⇒ tier senior
const USER_PLAIN = "820000000000000004"; // member, no staff role ⇒ no tier

const ENV_KEYS = ["SESSION_SECRET", "DB_PATH", "DATA_DIR"];
const INTEG_ENV_KEYS = ["YOUTUBE_API_KEY", "TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"];
const BOT_GUILDS = [GUILD_A, GUILD_CROSS];

// Cached-entity fixtures (17-20 digit snowflakes, the form format).
const CH_MAIN = "721000000000000111"; // text channel, sendable
const CH_VOICE = "721000000000000112"; // type 2 → wrong for reminders/panels
const CH_BADSEND = "721000000000000113"; // text but send() throws
const CH_UNCACHED = "721000000000000114"; // NOT in the fake cache
const ROLE_PLAIN = "621000000000000201"; // normal role in cache
const ROLE_MANAGED = "621000000000000202"; // integration-managed
const ROLE_UNCACHED = "621000000000000203"; // NOT in the fake cache
const ROLE_EXEMPT = "621000000000000209"; // exempt-pair target (in cache)
const EMOJI_ID = "497312345678901234"; // guild emoji fixture
const MSG_SENT_ID = "950000000000000001"; // fake send() message id

/** Distinct unicode emojis for the option-cap walk (20 > panel cap is fine). */
const EMOJIS_20 = Array.from({ length: 20 }, (_, i) => String.fromCodePoint(0x1f600 + i));

const INTEG_BASE = () => `/g/${GUILD_A}/integrations`;

describe("web integrations writes (POST /g/:guildId/integrations/*)", () => {
  /** @type {ReturnType<typeof loadDb>["api"]} */
  let api;
  let tmpDir;
  let savedEnv;

  /** @type {import("http").Server} */
  let server;
  let base;

  const cookieOf = {};
  const sessionIdOf = {};

  let appMod;
  let integrationsDataMod;
  let sessionPolicy;
  let tokens;
  let csrfMod;

  const fakeDiscord = {
    async getUserGuilds(token) {
      const userId = String(token).replace(/^tok-/, "");
      if (userId === USER_ADMIN) {
        return [{ id: GUILD_A, name: "Alpha HQ", icon: null, owner: true, permissions: "0" }];
      }
      if (userId === USER_PLAIN || userId === USER_STAFF || userId === USER_SENIOR) {
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
      if (userId === USER_STAFF) return { roles: ["role-junior-staff"] };
      if (userId === USER_SENIOR) return { roles: ["role-senior-staff"] };
      return { roles: [] };
    },
  };

  // --------------------------------------------------------------------------
  // Fake cache-only Discord client (guildScope doctrine: the routes only
  // ever READ these caches; the panel channel is the one object that can
  // SEND, mirroring the slash's real TextChannel).
  // --------------------------------------------------------------------------
  function makeFakeClient() {
    const deleted = [];
    const sent = [];
    const channels = new Map();
    const roles = new Map();
    const emojis = new Map();
    const msgStub = { id: MSG_SENT_ID, delete: async () => deleted.push(MSG_SENT_ID) };
    channels.set(CH_MAIN, {
      id: CH_MAIN,
      name: "general",
      type: 0,
      isTextBased: () => true,
      send: async (payload) => {
        sent.push(payload);
        return msgStub;
      },
      messages: { fetch: async (id) => (id ? msgStub : null) },
    });
    channels.set(CH_VOICE, { id: CH_VOICE, name: "voice", type: 2, isTextBased: () => false });
    channels.set(CH_BADSEND, {
      id: CH_BADSEND,
      name: "no-send",
      type: 0,
      isTextBased: () => true,
      send: async () => {
        throw new Error("Missing Permissions");
      },
      messages: { fetch: async () => null },
    });
    roles.set(ROLE_PLAIN, { id: ROLE_PLAIN, name: "Ping Crew", managed: false });
    roles.set(ROLE_MANAGED, { id: ROLE_MANAGED, name: "Bot Integration", managed: true });
    roles.set(ROLE_EXEMPT, { id: ROLE_EXEMPT, name: "Mod Team", managed: false });
    emojis.set(EMOJI_ID, { id: EMOJI_ID, name: "hehe", animated: false });
    const guild = {
      id: GUILD_A,
      channels: { cache: channels },
      roles: { cache: roles },
      emojis: { cache: emojis },
    };
    const client = {
      channels: { cache: channels },
      roles: { cache: roles },
      guilds: { cache: new Map([[GUILD_A, guild]]) },
    };
    return { client, sent, deleted };
  }

  /**
   * Boot an app with a FRESH resolver + mutation-rate-limit store on an
   * ephemeral port (each group remounts → per-mount POST budget never runs
   * out). extraOptions threads the fake client / service seams through
   * createWebApp (the same pass-through the Phase 1 tests use for getClient).
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
      integrationsData: integrationsDataMod.createIntegrationsData({}),
      ...extraOptions,
    });
    server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  }

  function mkSession(userId) {
    const s = sessionPolicy.createSession({ userId, discordTag: `${userId}#0001` });
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken(`tok-${userId}`),
      tokenExpiresAt: Date.now() + 3_600_000,
      scopes: "identify guilds guilds.members.read",
      guildSnapshot: "[]",
    });
    sessionIdOf[userId] = s.id;
    return s.id;
  }

  const tokenFor = (who) => csrfMod.deriveCsrfToken(sessionIdOf[who], SESSION_SECRET);

  /**
   * @param {string} urlPath
   * @param {{ who?: "admin"|"staff"|"senior"|"plain"|null, fields?: Record<string,string>,
   *   token?: string|null, headerToken?: string }|null} [opts]
   *   token omitted ⇒ a VALID token for `who` is sent; token=null ⇒ NO _csrf
   *   field; token="" ⇒ empty field. who=null ⇒ anonymous (no cookie).
   */
  async function post(urlPath, opts = {}) {
    const { who = "staff", fields = {}, token, headerToken } = opts;
    const body = new URLSearchParams(fields);
    if (token === null) {
      /* deliberately NO _csrf field */
    } else {
      body.set("_csrf", token === undefined ? (who ? tokenFor(who) : "") : token);
    }
    const headers = who ? { cookie: cookieOf[who] } : {};
    if (headerToken) headers["x-csrf-token"] = headerToken;
    const res = await fetch(`${base}${urlPath}`, {
      method: "POST",
      redirect: "manual",
      body,
      headers,
    });
    const text = await res.text();
    return { res, body: text, location: res.headers.get("location") };
  }

  async function getPage(who = "staff", query = "") {
    const res = await fetch(`${base}${INTEG_BASE()}${query}`, {
      redirect: "manual",
      headers: { cookie: cookieOf[who] },
    });
    return { res, body: await res.text() };
  }

  /** web-origin audit rows for GUILD_A (newest first) filtered by action. */
  const auditsFor = (action) =>
    api.listAdminAudit(GUILD_A, { origin: "web", limit: 100 }).filter((r) => r.action === action);
  const webAuditCount = () => api.countAdminAudit(GUILD_A, { origin: "web" });

  /**
   * Assert the NEWEST web audit row for `action` (listAdminAudit is newest
   * first). Some actions legitimately fire twice across tests (role set +
   * clear) — per-test "nothing extra was audited" is pinned separately via
   * webAuditCount() deltas in the refusal tests.
   */
  function expectAudit(action, extra) {
    const rows = auditsFor(action);
    assert.ok(rows.length >= 1, `at least one ${action} audit row`);
    const row = rows[0];
    assert.equal(row.origin, "web");
    assert.ok(row.actor_user_id, "actor recorded");
    if (extra) extra(row);
    return row;
  }

  before(async () => {
    savedEnv = ENV_KEYS.reduce((acc, k) => {
      acc[k] = process.env[k];
      return acc;
    }, {});
    for (const key of INTEG_ENV_KEYS) savedEnv[key] = process.env[key];
    const loaded = loadDb();
    api = loaded.api;
    tmpDir = loaded.tmpDir;
    process.env.SESSION_SECRET = SESSION_SECRET;
    for (const key of INTEG_ENV_KEYS) delete process.env[key];

    appMod = require("../src/web/app");
    integrationsDataMod = require("../src/web/data/integrationsData");
    sessionPolicy = require("../src/web/auth/sessions");
    tokens = require("../src/web/auth/tokens");
    csrfMod = require("../src/web/middleware/csrf");

    api.addStaffRole(GUILD_A, "role-junior-staff", "junior");
    api.addStaffRole(GUILD_A, "role-senior-staff", "senior");

    // sessionIdOf is keyed by ROLE NAME (tokenFor("staff") etc.).
    const mk = (role, userId) => {
      const id = mkSession(userId);
      sessionIdOf[role] = id;
      cookieOf[role] = `web_session=${id}`;
    };
    mk("admin", USER_ADMIN);
    mk("staff", USER_STAFF);
    mk("senior", USER_SENIOR);
    mk("plain", USER_PLAIN);
  });

  after(async () => {
    if (server) {
      server.close();
      await once(server, "close");
    }
    for (const key of [...ENV_KEYS, ...INTEG_ENV_KEYS]) {
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

  // =========================================================================
  // Method gate + auth gates (§8.6 cross-cutting rules)
  // =========================================================================

  describe("method gate + auth gates", () => {
    before(async () => {
      await mountApp();
    });

    it("registered mutation templates pass the gate (anon ⇒ 302 login, never 405)", async () => {
      const paths = [
        "/youtube/add",
        "/youtube/remove",
        "/youtube/channel",
        "/twitch/add",
        "/reaction-roles/panel/create",
        "/reaction-roles/option/add",
        "/event-reminders/channel",
        "/honeypot/channel/add",
        "/honeypot/exempt/add",
        "/honeypot/exempt/del",
      ];
      for (const suffix of paths) {
        const { res, location, body } = await post(`${INTEG_BASE()}${suffix}`, {
          who: null,
          fields: {},
        });
        assert.notEqual(res.status, 405, `${suffix} must not be gated out`);
        assert.equal(res.status, 302, `anon ${suffix} ⇒ login redirect`);
        assert.equal(location, `/auth/login?guild=${GUILD_A}`);
        assert.equal(body, "");
      }
    });

    it("page path stays GET-only: POST/PUT/DELETE on the page are byte-405", async () => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await fetch(`${base}${INTEG_BASE()}`, {
          method,
          headers: { cookie: cookieOf.admin },
        });
        assert.equal(res.status, 405, `${method} on the page path`);
        assert.equal(await res.text(), "Method not allowed");
      }
    });

    it("unsafe verbs on mutation templates are byte-405; GET on them is the generic 404", async () => {
      for (const [method, path] of [
        ["PUT", "/event-reminders/channel"],
        ["DELETE", "/youtube/add"],
        ["PATCH", "/youtube/add"],
        ["POST", "/youtube/intervalz"],
        ["POST", "/honeypot/exempt/add/extra"],
        ["POST", "/youtube/add/"],
      ]) {
        const res = await fetch(`${base}${INTEG_BASE()}${path}`, {
          method,
          headers: { cookie: cookieOf.admin },
        });
        assert.equal(res.status, 405, `${method} ${path} must 405`);
        assert.equal(await res.text(), "Method not allowed");
      }
      // GET/HEAD always pass the gate (safe methods) → no GET route → 404.
      const raw = await fetch(`${base}${INTEG_BASE()}/youtube/add`, {
        headers: { cookie: cookieOf.admin },
      });
      assert.equal(raw.status, 404);
      assert.equal(await raw.text(), "Not found");
    });

    it("member without a staff tier ⇒ the generic 404 (never 403, §8.6)", async () => {
      const { res, body } = await post(`${INTEG_BASE()}/youtube/interval`, {
        who: "plain",
        fields: { minutes: "5" },
      });
      assert.equal(res.status, 404);
      assert.equal(body, "Not found");
    });

    it("cross-guild mutation ⇒ the SAME generic 404 bytes", async () => {
      const { res, body } = await post(`/g/${GUILD_CROSS}/integrations/youtube/interval`, {
        who: "staff",
        fields: { minutes: "5" },
      });
      assert.equal(res.status, 404);
      assert.equal(body, "Not found");
    });

    it("honeypot exempt pair is ADMIN-tier: junior AND senior get 403, no write, no audit", async () => {
      for (const who of ["staff", "senior"]) {
        const rolesBefore = api.listStaffRoles(GUILD_A).length;
        const auditsBefore = webAuditCount();
        const { res, body } = await post(`${INTEG_BASE()}/honeypot/exempt/add`, {
          who,
          fields: { role_id: ROLE_EXEMPT },
        });
        assert.equal(res.status, 403, `${who} must not reach the admin gate`);
        assert.equal(body, "Forbidden");
        assert.equal(api.listStaffRoles(GUILD_A).length, rolesBefore, "no staff_roles write");
        assert.equal(webAuditCount(), auditsBefore, "no audit row");
      }
    });
  });

  // =========================================================================
  // CSRF (§8.7)
  // =========================================================================

  describe("CSRF", () => {
    before(async () => {
      await mountApp();
    });

    it("missing _csrf ⇒ 403, nothing written, nothing audited", async () => {
      const settingsBefore = api.getGuildSettings(GUILD_A).event_reminder_channel_id ?? null;
      const auditsBefore = webAuditCount();
      const { res, body } = await post(`${INTEG_BASE()}/event-reminders/channel`, {
        fields: { channel_id: CH_MAIN },
        token: null,
      });
      assert.equal(res.status, 403);
      assert.equal(body, "Forbidden");
      assert.equal(api.getGuildSettings(GUILD_A).event_reminder_channel_id ?? null, settingsBefore);
      assert.equal(webAuditCount(), auditsBefore);
    });

    it("empty and junk tokens ⇒ 403", async () => {
      for (const junk of ["", "deadbeef", "0".repeat(64)]) {
        const { res } = await post(`${INTEG_BASE()}/youtube/interval`, {
          fields: { minutes: "5" },
          token: junk,
        });
        assert.equal(res.status, 403, `token "${junk.slice(0, 8)}…" must be rejected`);
      }
    });

    it("X-CSRF-Token header (htmx path) works without the form field", async () => {
      const { res, location } = await post(`${INTEG_BASE()}/youtube/interval`, {
        fields: { minutes: "9" },
        token: null, // NO form field at all — header only
        headerToken: tokenFor("staff"),
      });
      assert.equal(res.status, 302);
      assert.equal(location, `${INTEG_BASE()}?done=yt_interval_set`);
      assert.equal(api.getGuildSettings(GUILD_A).youtube_polling_interval_minutes, 9);
    });
  });

  // =========================================================================
  // YouTube writes (staff tier)
  // =========================================================================

  describe("youtube writes", () => {
    const fakeLookup = async (username) =>
      username === "daily-uploads"
        ? { id: "UCytresolved00001", name: "daily uploads" }
        : null;
    const fakeInfo = async () => ({ thumbnail_url: "https://img.example/th.jpg" });

    before(async () => {
      process.env.YOUTUBE_API_KEY = SENTINEL_YT_KEY;
      await mountApp({
        getClient: () => makeFakeClient().client,
        lookupYoutubeChannel: fakeLookup,
        fetchYoutubeChannelInfo: fakeInfo,
      });
    });

    after(() => {
      for (const key of INTEG_ENV_KEYS) delete process.env[key];
    });

    it("add @handle resolves through the service seam and audits youtube.channel_add", async () => {
      const { res, location } = await post(`${INTEG_BASE()}/youtube/add`, {
        fields: { url: "https://www.youtube.com/@daily-uploads" },
      });
      assert.equal(res.status, 302);
      assert.equal(location, `${INTEG_BASE()}?done=yt_added`);
      const row = api
        .getYoutubeChannels(GUILD_A)
        .find((c) => c.id === "UCytresolved00001");
      assert.ok(row, "resolved channel id stored");
      assert.equal(row.channel_url, "https://www.youtube.com/@daily-uploads");
      assert.match(row.channel_name, /daily uploads/i);
      assert.equal(row.thumbnail_url, "https://img.example/th.jpg");
      expectAudit("youtube.channel_add", (a) => {
        assert.equal(a.target_id, "UCytresolved00001");
        assert.equal(a.actor_user_id, USER_STAFF);
      });
    });

    it("add without YOUTUBE_API_KEY ⇒ refused (deviation: slash stores unresolved rows), nothing written", async () => {
      delete process.env.YOUTUBE_API_KEY;
      const before = api.getYoutubeChannels(GUILD_A).length;
      const auditsBefore = webAuditCount();
      const { location } = await post(`${INTEG_BASE()}/youtube/add`, {
        fields: { url: "@otherchannel" },
      });
      assert.equal(location, `${INTEG_BASE()}?error=youtube_not_configured`);
      assert.equal(api.getYoutubeChannels(GUILD_A).length, before);
      assert.equal(webAuditCount(), auditsBefore);
      process.env.YOUTUBE_API_KEY = SENTINEL_YT_KEY;
    });

    it("add garbage input ⇒ invalid_input, no row", async () => {
      const before = api.getYoutubeChannels(GUILD_A).length;
      const { location } = await post(`${INTEG_BASE()}/youtube/add`, {
        fields: { url: "not a channel at all" },
      });
      assert.equal(location, `${INTEG_BASE()}?error=invalid_input`);
      assert.equal(api.getYoutubeChannels(GUILD_A).length, before);
    });

    it("remove unknown ⇒ yt_not_found with no audit; remove stored ⇒ gone + audit", async () => {
      const auditsBefore = webAuditCount();
      let r = await post(`${INTEG_BASE()}/youtube/remove`, { fields: { channel_id: "UCnope" } });
      assert.equal(r.location, `${INTEG_BASE()}?error=yt_not_found`);
      assert.equal(webAuditCount(), auditsBefore, "refusal never audits");

      r = await post(`${INTEG_BASE()}/youtube/remove`, {
        fields: { channel_id: "UCytresolved00001" },
      });
      assert.equal(r.location, `${INTEG_BASE()}?done=yt_removed`);
      assert.ok(!api.getYoutubeChannels(GUILD_A).find((c) => c.id === "UCytresolved00001"));
      expectAudit("youtube.channel_remove");
    });

    it("channel: bad id ⇒ invalid_channel_id; UNCACHED id ⇒ channel_missing (picker parity)", async () => {
      let r = await post(`${INTEG_BASE()}/youtube/channel`, { fields: { channel_id: "abc" } });
      assert.equal(r.location, `${INTEG_BASE()}?error=invalid_channel_id`);
      r = await post(`${INTEG_BASE()}/youtube/channel`, { fields: { channel_id: CH_UNCACHED } });
      assert.equal(r.location, `${INTEG_BASE()}?error=channel_missing`);
      assert.equal(api.getGuildSettings(GUILD_A).youtube_notification_channel_id ?? null, null);
    });

    it("channel: cached channel writes the setting + audits previous", async () => {
      const { location } = await post(`${INTEG_BASE()}/youtube/channel`, {
        fields: { channel_id: CH_MAIN },
      });
      assert.equal(location, `${INTEG_BASE()}?done=yt_channel_set`);
      assert.equal(api.getGuildSettings(GUILD_A).youtube_notification_channel_id, CH_MAIN);
      expectAudit("youtube.notify_channel_set", (a) => {
        assert.equal(a.target_id, CH_MAIN);
        assert.equal(JSON.parse(a.details_json).previous_channel_id, null);
      });
    });

    it("interval: out-of-range/garbage ⇒ invalid_interval; valid persists", async () => {
      for (const minutes of ["0", "99", "abc", "-5", "7.5"]) {
        const { location } = await post(`${INTEG_BASE()}/youtube/interval`, {
          fields: { minutes },
        });
        assert.equal(
          location,
          `${INTEG_BASE()}?error=invalid_interval`,
          `minutes "${minutes}" rejected`
        );
      }
      const { location } = await post(`${INTEG_BASE()}/youtube/interval`, {
        fields: { minutes: "7" },
      });
      assert.equal(location, `${INTEG_BASE()}?done=yt_interval_set`);
      assert.equal(api.getGuildSettings(GUILD_A).youtube_polling_interval_minutes, 7);
      expectAudit("youtube.polling_interval_set");
    });

    it("uploadrole: set, uncached-role refusal, empty clears (slash optional-option parity)", async () => {
      let r = await post(`${INTEG_BASE()}/youtube/uploadrole`, {
        fields: { role_id: ROLE_UNCACHED },
      });
      assert.equal(r.location, `${INTEG_BASE()}?error=role_missing`);
      r = await post(`${INTEG_BASE()}/youtube/uploadrole`, { fields: { role_id: "bad!" } });
      assert.equal(r.location, `${INTEG_BASE()}?error=invalid_role_id`);

      r = await post(`${INTEG_BASE()}/youtube/uploadrole`, { fields: { role_id: ROLE_PLAIN } });
      assert.equal(r.location, `${INTEG_BASE()}?done=yt_upload_role_set`);
      assert.equal(api.getGuildSettings(GUILD_A).youtube_upload_role_id, ROLE_PLAIN);

      r = await post(`${INTEG_BASE()}/youtube/uploadrole`, { fields: { role_id: "" } });
      assert.equal(r.location, `${INTEG_BASE()}?done=yt_upload_role_cleared`);
      assert.equal(api.getGuildSettings(GUILD_A).youtube_upload_role_id, null);
      expectAudit("youtube.upload_role_set");
    });
  });

  // =========================================================================
  // Twitch writes (staff tier)
  // =========================================================================

  describe("twitch writes", () => {
    let resolveCalls;
    const fakeResolve = async (login) =>
      login === "ghost" ? null : { id: "btw-1", login, display_name: login.toUpperCase() };

    before(async () => {
      resolveCalls = [];
      await mountApp({
        getClient: () => makeFakeClient().client,
        resolveTwitchUser: async (login) => {
          resolveCalls.push(login);
          return fakeResolve(login);
        },
      });
    });

    it("add WITHOUT TWITCH env ⇒ refused before any network call (slash parity)", async () => {
      for (const key of ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"]) delete process.env[key];
      const { location } = await post(`${INTEG_BASE()}/twitch/add`, { fields: { login: "cool" } });
      assert.equal(location, `${INTEG_BASE()}?error=twitch_not_configured`);
      assert.equal(resolveCalls.length, 0, "never called the resolver");
      assert.equal(api.getTwitchChannels(GUILD_A).length, 0);
    });

    it("add with env resolves+stores+audits; duplicate refused without a second row", async () => {
      process.env.TWITCH_CLIENT_ID = SENTINEL_TW_ID;
      process.env.TWITCH_CLIENT_SECRET = SENTINEL_TW_SECRET;
      const { location } = await post(`${INTEG_BASE()}/twitch/add`, {
        fields: { login: "https://twitch.tv/CoolStreamer" },
      });
      assert.equal(location, `${INTEG_BASE()}?done=tw_added`);
      const rows = api.getTwitchChannels(GUILD_A);
      const row = rows.find((r) => r.login === "coolstreamer");
      assert.ok(row, "normalized login stored");
      assert.equal(row.broadcaster_id, "btw-1");
      expectAudit("twitch.channel_add", (a) => assert.equal(a.target_id, "btw-1"));

      const dup = await post(`${INTEG_BASE()}/twitch/add`, { fields: { login: "coolstreamer" } });
      assert.equal(dup.location, `${INTEG_BASE()}?error=tw_exists`);
      assert.equal(api.getTwitchChannels(GUILD_A).length, 1);
    });

    it("unresolvable login ⇒ tw_resolve_failed, no row", async () => {
      const { location } = await post(`${INTEG_BASE()}/twitch/add`, { fields: { login: "ghost" } });
      assert.equal(location, `${INTEG_BASE()}?error=tw_resolve_failed`);
      assert.equal(api.getTwitchChannels(GUILD_A).length, 1);
    });

    it("remove unknown ⇒ tw_not_found; remove by login goes + audits", async () => {
      const auditsBefore = webAuditCount();
      let r = await post(`${INTEG_BASE()}/twitch/remove`, { fields: { channel: "nobody" } });
      assert.equal(r.location, `${INTEG_BASE()}?error=tw_not_found`);
      assert.equal(webAuditCount(), auditsBefore);

      r = await post(`${INTEG_BASE()}/twitch/remove`, { fields: { channel: "coolstreamer" } });
      assert.equal(r.location, `${INTEG_BASE()}?done=tw_removed`);
      assert.equal(api.getTwitchChannels(GUILD_A).length, 0);
      expectAudit("twitch.channel_remove");
    });

    it("channel/role/interval settings persist with slash actions", async () => {
      let r = await post(`${INTEG_BASE()}/twitch/channel`, { fields: { channel_id: CH_MAIN } });
      assert.equal(r.location, `${INTEG_BASE()}?done=tw_channel_set`);
      assert.equal(api.getGuildSettings(GUILD_A).twitch_notification_channel_id, CH_MAIN);

      r = await post(`${INTEG_BASE()}/twitch/role`, { fields: { role_id: ROLE_PLAIN } });
      assert.equal(r.location, `${INTEG_BASE()}?done=tw_role_set`);
      assert.equal(api.getGuildSettings(GUILD_A).twitch_notify_role_id, ROLE_PLAIN);
      r = await post(`${INTEG_BASE()}/twitch/role`, { fields: { role_id: "" } });
      assert.equal(r.location, `${INTEG_BASE()}?done=tw_role_cleared`);
      assert.equal(api.getGuildSettings(GUILD_A).twitch_notify_role_id, null);

      let bad = await post(`${INTEG_BASE()}/twitch/interval`, { fields: { minutes: "99" } });
      assert.equal(bad.location, `${INTEG_BASE()}?error=invalid_interval`);
      r = await post(`${INTEG_BASE()}/twitch/interval`, { fields: { minutes: "4" } });
      assert.equal(r.location, `${INTEG_BASE()}?done=tw_interval_set`);
      assert.equal(api.getGuildSettings(GUILD_A).twitch_polling_interval_minutes, 4);

      expectAudit("twitch.notify_channel_set");
      expectAudit("twitch.polling_interval_set");
      // role fires twice (set + clear) — assert both are web-origin:
      assert.equal(auditsFor("twitch.notify_role_set").length, 2);
    });
  });

  // =========================================================================
  // Reaction roles writes (staff tier; panel create needs the live client)
  // =========================================================================

  describe("reaction roles writes", () => {
    const PANEL_MSG = "921000000000000301";
    const PANEL_MSG2 = "921000000000000302";

    before(() => {
      api.createReactionRolePanel(GUILD_A, "722000000000000201", PANEL_MSG, "Seeded panel", "d");
      api.upsertReactionRoleOption(GUILD_A, PANEL_MSG, "👍", "👍", ROLE_PLAIN, 0, 1);
      // Second panel pre-FILLED to the option cap (for the limit + upsert
      // exemption walk).
      api.createReactionRolePanel(GUILD_A, "722000000000000202", PANEL_MSG2, "Full panel", "d");
      for (let i = 0; i < 20; i += 1) {
        api.upsertReactionRoleOption(GUILD_A, PANEL_MSG2, EMOJIS_20[i], EMOJIS_20[i], ROLE_PLAIN, 0, 1);
      }
    });

    it("panel create with NO client (dark boot) ⇒ rr_offline (slash unreachable too)", async () => {
      await mountApp();
      const { location } = await post(`${INTEG_BASE()}/reaction-roles/panel/create`, {
        fields: { channel_id: CH_MAIN },
      });
      assert.equal(location, `${INTEG_BASE()}?error=rr_offline`);
    });

    describe("with fake client", () => {
      /** @type {ReturnType<typeof makeFakeClient>} */
      let fake;
      before(async () => {
        fake = makeFakeClient();
        await mountApp({ getClient: () => fake.client });
      });

      it("panel create posts the embed FIRST, stores with the real message id, audits", async () => {
        const { location } = await post(`${INTEG_BASE()}/reaction-roles/panel/create`, {
          fields: { channel_id: CH_MAIN },
        });
        assert.equal(location, `${INTEG_BASE()}?done=rr_panel_created`);
        assert.equal(fake.sent.length, 1, "embed posted through the channel");
        const panel = api.listReactionRolePanels(GUILD_A).find((p) => p.message_id === MSG_SENT_ID);
        assert.ok(panel, "panel stored with the sent message id");
        assert.equal(panel.channel_id, CH_MAIN);
        assert.equal(panel.title, "Reaction Roles");
        expectAudit("reaction_roles.panel_create", (a) => assert.equal(a.target_id, MSG_SENT_ID));
      });

      it("panel create to voice / uncached / unsendable channels are refused without rows", async () => {
        const before = api.listReactionRolePanels(GUILD_A).length;
        let r = await post(`${INTEG_BASE()}/reaction-roles/panel/create`, {
          fields: { channel_id: CH_VOICE },
        });
        assert.equal(r.location, `${INTEG_BASE()}?error=rr_channel_unsendable`);
        r = await post(`${INTEG_BASE()}/reaction-roles/panel/create`, {
          fields: { channel_id: CH_UNCACHED },
        });
        assert.equal(r.location, `${INTEG_BASE()}?error=channel_missing`);
        r = await post(`${INTEG_BASE()}/reaction-roles/panel/create`, {
          fields: { channel_id: CH_BADSEND },
        });
        assert.equal(r.location, `${INTEG_BASE()}?error=rr_post_failed`);
        assert.equal(api.listReactionRolePanels(GUILD_A).length, before, "no half-stored panel");
        assert.equal(auditsFor("reaction_roles.panel_create").length, 1); // only the happy one
      });

      it("option add: unknown panel, bad emoji, missing/managed role, unknown custom emoji all refused", async () => {
        const auditsBefore = webAuditCount();
        const cases = [
          [{ message_id: "999999999999999999", role_id: ROLE_PLAIN, emoji: "👍" }, "rr_panel_not_found"],
          [{ message_id: PANEL_MSG, role_id: ROLE_PLAIN, emoji: "notanemoji" }, "rr_emoji_invalid"],
          [{ message_id: PANEL_MSG, role_id: ROLE_UNCACHED, emoji: "🎉" }, "role_missing"],
          [{ message_id: PANEL_MSG, role_id: ROLE_MANAGED, emoji: "🎉" }, "rr_role_managed"],
          [
            {
              message_id: PANEL_MSG,
              role_id: ROLE_PLAIN,
              emoji: "<:nothere:497312999999999999>",
            },
            "rr_emoji_unavailable",
          ],
        ];
        for (const [fields, slug] of cases) {
          const { location } = await post(`${INTEG_BASE()}/reaction-roles/option/add`, { fields });
          assert.equal(location, `${INTEG_BASE()}?error=${slug}`, `case ${slug}`);
        }
        assert.equal(webAuditCount(), auditsBefore, "refusals never audit");
      });

      it("option add stores the upsert + audits reaction_roles.option_add", async () => {
        const { location } = await post(`${INTEG_BASE()}/reaction-roles/option/add`, {
          fields: {
            message_id: PANEL_MSG,
            role_id: ROLE_PLAIN,
            emoji: "🎉",
            level: "5",
            removable: "0",
          },
        });
        assert.equal(location, `${INTEG_BASE()}?done=rr_option_added`);
        const opt = api.getReactionRoleOption(GUILD_A, PANEL_MSG, "🎉");
        assert.ok(opt, "option stored under the parsed emoji key");
        assert.equal(opt.role_id, ROLE_PLAIN);
        assert.equal(Number(opt.min_level), 5);
        assert.equal(Number(opt.removable), 0);
        expectAudit("reaction_roles.option_add", (a) => {
          assert.equal(a.target_id, PANEL_MSG);
          assert.equal(JSON.parse(a.details_json).min_level, 5);
        });
      });

      it("custom guild emoji is stored with the enriched display", async () => {
        const { location } = await post(`${INTEG_BASE()}/reaction-roles/option/add`, {
          fields: { message_id: PANEL_MSG, role_id: ROLE_PLAIN, emoji: "<:hehe:497312345678901234>" },
        });
        assert.equal(location, `${INTEG_BASE()}?done=rr_option_added`);
        const opt = api.getReactionRoleOption(GUILD_A, PANEL_MSG, EMOJI_ID);
        assert.ok(opt);
        assert.equal(opt.emoji_display, "<:hehe:497312345678901234>");
      });

      it("panel full ⇒ 21st new emoji refused; re-add of an existing emoji still updates", async () => {
        const fresh = String.fromCodePoint(0x1f900); // not on the capped panel
        let r = await post(`${INTEG_BASE()}/reaction-roles/option/add`, {
          fields: { message_id: PANEL_MSG2, role_id: ROLE_PLAIN, emoji: fresh },
        });
        assert.equal(r.location, `${INTEG_BASE()}?error=rr_option_limit`);
        r = await post(`${INTEG_BASE()}/reaction-roles/option/add`, {
          fields: { message_id: PANEL_MSG2, role_id: ROLE_PLAIN, emoji: EMOJIS_20[3], level: "3" },
        });
        assert.equal(r.location, `${INTEG_BASE()}?done=rr_option_added`, "upsert exemption");
        assert.equal(Number(api.getReactionRoleOption(GUILD_A, PANEL_MSG2, EMOJIS_20[3]).min_level), 3);
      });

      it("option remove: unknown emoji refused; stored emoji gone + audits", async () => {
        const auditsBefore = webAuditCount();
        let r = await post(`${INTEG_BASE()}/reaction-roles/option/remove`, {
          fields: { message_id: PANEL_MSG, emoji: "😴" },
        });
        assert.equal(r.location, `${INTEG_BASE()}?error=rr_option_not_found`);
        assert.equal(webAuditCount(), auditsBefore);

        r = await post(`${INTEG_BASE()}/reaction-roles/option/remove`, {
          fields: { message_id: PANEL_MSG, emoji: "👍" },
        });
        assert.equal(r.location, `${INTEG_BASE()}?done=rr_option_removed`);
        assert.equal(api.getReactionRoleOption(GUILD_A, PANEL_MSG, "👍"), null);
        expectAudit("reaction_roles.option_remove");
      });

      it("panel delete: unknown refused; stored panel + option cascade go, audits, message delete attempted", async () => {
        const auditsBefore = webAuditCount();
        let r = await post(`${INTEG_BASE()}/reaction-roles/panel/delete`, {
          fields: { message_id: "999999999999999999" },
        });
        assert.equal(r.location, `${INTEG_BASE()}?error=rr_panel_not_found`);
        assert.equal(webAuditCount(), auditsBefore);

        r = await post(`${INTEG_BASE()}/reaction-roles/panel/delete`, {
          fields: { message_id: MSG_SENT_ID },
        });
        assert.equal(r.location, `${INTEG_BASE()}?done=rr_panel_deleted`);
        assert.ok(!api.getReactionRolePanel(GUILD_A, MSG_SENT_ID));
        assert.equal(api.countReactionRoleOptions(GUILD_A, MSG_SENT_ID), 0, "options cascaded");
        expectAudit("reaction_roles.panel_delete");
        // best-effort Discord cleanup ran through the fake channel:
        assert.ok(fake.deleted.includes(MSG_SENT_ID), "message delete attempted");
      });
    });
  });

  // =========================================================================
  // Event reminders writes (staff tier, setchannel ONLY)
  // =========================================================================

  describe("event reminders writes", () => {
    before(async () => {
      await mountApp({ getClient: () => makeFakeClient().client });
    });

    it("setchannel: bad/uncached/wrong-type refused without writes", async () => {
      const before = api.getGuildSettings(GUILD_A).event_reminder_channel_id ?? null;
      const auditsBefore = webAuditCount();
      for (const [channel_id, slug] of [
        ["nope", "invalid_channel_id"],
        [CH_UNCACHED, "channel_missing"],
        [CH_VOICE, "er_channel_type"],
      ]) {
        const { location } = await post(`${INTEG_BASE()}/event-reminders/channel`, {
          fields: { channel_id },
        });
        assert.equal(location, `${INTEG_BASE()}?error=${slug}`, `channel "${channel_id}"`);
      }
      assert.equal(api.getGuildSettings(GUILD_A).event_reminder_channel_id ?? null, before);
      assert.equal(webAuditCount(), auditsBefore);
    });

    it("setchannel: text channel persists + audits; empty clears (slash optional parity)", async () => {
      let r = await post(`${INTEG_BASE()}/event-reminders/channel`, {
        fields: { channel_id: CH_MAIN },
      });
      assert.equal(r.location, `${INTEG_BASE()}?done=er_channel_set`);
      assert.equal(api.getGuildSettings(GUILD_A).event_reminder_channel_id, CH_MAIN);

      r = await post(`${INTEG_BASE()}/event-reminders/channel`, { fields: { channel_id: "" } });
      assert.equal(r.location, `${INTEG_BASE()}?done=er_channel_cleared`);
      assert.equal(api.getGuildSettings(GUILD_A).event_reminder_channel_id, null);
      expectAudit("event_reminders.channel_set", (a) => {
        assert.ok(JSON.parse(a.details_json).channel_id === null);
      });
    });
  });

  // =========================================================================
  // Honeypot writes (staff tier; the exempt pair is ADMIN)
  // =========================================================================

  describe("honeypot writes", () => {
    const HP_CH = "721000000000000115"; // fresh channel NOT yet a honeypot
    let fake;
    let warningCalls;

    before(async () => {
      fake = makeFakeClient();
      warningCalls = [];
      // the fixture channel for /honeypot channel add must exist in cache:
      fake.client.channels.cache.set(HP_CH, {
        id: HP_CH,
        name: "trap",
        type: 0,
        isTextBased: () => true,
        send: async () => ({ id: "950000000000000002", delete: async () => {} }),
        messages: { fetch: async () => null },
      });
      await mountApp({
        getClient: () => fake.client,
        ensureHoneypotWarning: async (guild, channelId) => {
          warningCalls.push({ guildId: guild?.id, channelId });
          return "posted";
        },
      });
    });

    it("channel add: uncached refused; stored row + warning post + audit", async () => {
      let r = await post(`${INTEG_BASE()}/honeypot/channel/add`, { fields: { channel_id: CH_UNCACHED } });
      assert.equal(r.location, `${INTEG_BASE()}?error=channel_missing`);

      r = await post(`${INTEG_BASE()}/honeypot/channel/add`, { fields: { channel_id: HP_CH } });
      assert.equal(r.location, `${INTEG_BASE()}?done=hp_channel_added`);
      assert.ok(api.isHoneypotChannel(GUILD_A, HP_CH), "stored");
      assert.deepEqual(warningCalls, [{ guildId: GUILD_A, channelId: HP_CH }], "feature ran");
      expectAudit("honeypot.channel_add", (a) => assert.equal(a.target_id, HP_CH));
    });

    it("channel add duplicate ⇒ refused without double-audit", async () => {
      const auditsBefore = auditsFor("honeypot.channel_add").length;
      const { location } = await post(`${INTEG_BASE()}/honeypot/channel/add`, {
        fields: { channel_id: HP_CH },
      });
      assert.equal(location, `${INTEG_BASE()}?error=hp_channel_exists`);
      assert.equal(auditsFor("honeypot.channel_add").length, auditsBefore);
    });

    it("channel del: unknown refused silently; stored removed + audits", async () => {
      const auditsBefore = webAuditCount();
      let r = await post(`${INTEG_BASE()}/honeypot/channel/del`, { fields: { channel_id: HP_CH } });
      assert.equal(r.location, `${INTEG_BASE()}?done=hp_channel_removed`);
      assert.equal(api.isHoneypotChannel(GUILD_A, HP_CH), false);
      expectAudit("honeypot.channel_del");

      const after = webAuditCount();
      r = await post(`${INTEG_BASE()}/honeypot/channel/del`, { fields: { channel_id: HP_CH } });
      assert.equal(r.location, `${INTEG_BASE()}?error=hp_channel_not_found`);
      assert.equal(webAuditCount(), after, "second del did not audit");
    });

    it("banrole add: @everyone arithmetic, managed refusal, duplicate refusal, happy store", async () => {
      let r = await post(`${INTEG_BASE()}/honeypot/banrole/add`, { fields: { role_id: GUILD_A } });
      assert.equal(r.location, `${INTEG_BASE()}?error=hp_role_everyone`);
      r = await post(`${INTEG_BASE()}/honeypot/banrole/add`, { fields: { role_id: ROLE_MANAGED } });
      assert.equal(r.location, `${INTEG_BASE()}?error=hp_role_managed`);
      r = await post(`${INTEG_BASE()}/honeypot/banrole/add`, { fields: { role_id: ROLE_UNCACHED } });
      assert.equal(r.location, `${INTEG_BASE()}?error=role_missing`);

      r = await post(`${INTEG_BASE()}/honeypot/banrole/add`, { fields: { role_id: ROLE_PLAIN } });
      assert.equal(r.location, `${INTEG_BASE()}?done=hp_banrole_added`);
      assert.ok(api.isHoneypotBanRole(GUILD_A, ROLE_PLAIN));
      expectAudit("honeypot.ban_role_add");

      r = await post(`${INTEG_BASE()}/honeypot/banrole/add`, { fields: { role_id: ROLE_PLAIN } });
      assert.equal(r.location, `${INTEG_BASE()}?error=hp_banrole_exists`);
      assert.equal(auditsFor("honeypot.ban_role_add").length, 1);
    });

    it("banrole del: unknown refused; stored removed + audits", async () => {
      const auditsBefore = webAuditCount();
      let r = await post(`${INTEG_BASE()}/honeypot/banrole/del`, { fields: { role_id: ROLE_EXEMPT } });
      assert.equal(r.location, `${INTEG_BASE()}?error=hp_banrole_not_found`);
      assert.equal(webAuditCount(), auditsBefore);

      r = await post(`${INTEG_BASE()}/honeypot/banrole/del`, { fields: { role_id: ROLE_PLAIN } });
      assert.equal(r.location, `${INTEG_BASE()}?done=hp_banrole_removed`);
      assert.equal(api.isHoneypotBanRole(GUILD_A, ROLE_PLAIN), false);
      expectAudit("honeypot.ban_role_del");
    });
  });

  // =========================================================================
  // Honeypot EXEMPT pair (ADMIN tier, §8.6 per-command tier; staff_roles)
  // =========================================================================

  describe("honeypot exempt writes (admin tier)", () => {
    before(async () => {
      await mountApp({ getClient: () => makeFakeClient().client });
    });

    it("add stores staff_roles (senior default) + audits staff.role_add via honeypot.exempt", async () => {
      const { res, location } = await post(`${INTEG_BASE()}/honeypot/exempt/add`, {
        who: "admin",
        fields: { role_id: ROLE_EXEMPT },
      });
      assert.equal(res.status, 302);
      assert.equal(location, `${INTEG_BASE()}?done=hp_exempt_added`);
      const stored = api.listStaffRoles(GUILD_A).find((r) => r.role_id === ROLE_EXEMPT);
      assert.ok(stored, "staff_roles row written through the facade alias");
      assert.equal(stored.level, "senior", "slash exempt default level parity");
      expectAudit("staff.role_add", (a) => {
        assert.equal(a.target_id, ROLE_EXEMPT);
        assert.equal(a.actor_user_id, USER_ADMIN);
        assert.equal(JSON.parse(a.details_json).via, "honeypot.exempt");
      });
    });

    it("@everyone refused; uncached role refused", async () => {
      let r = await post(`${INTEG_BASE()}/honeypot/exempt/add`, {
        who: "admin",
        fields: { role_id: GUILD_A },
      });
      assert.equal(r.location, `${INTEG_BASE()}?error=hp_role_everyone`);
      r = await post(`${INTEG_BASE()}/honeypot/exempt/add`, {
        who: "admin",
        fields: { role_id: ROLE_UNCACHED },
      });
      assert.equal(r.location, `${INTEG_BASE()}?error=role_missing`);
    });

    it("del: unknown refused without audit; stored role removed + audits staff.role_remove", async () => {
      const auditsBefore = webAuditCount();
      let r = await post(`${INTEG_BASE()}/honeypot/exempt/del`, {
        who: "admin",
        fields: { role_id: ROLE_UNCACHED },
      });
      assert.equal(r.location, `${INTEG_BASE()}?error=hp_exempt_not_found`);
      assert.equal(webAuditCount(), auditsBefore);

      r = await post(`${INTEG_BASE()}/honeypot/exempt/del`, {
        who: "admin",
        fields: { role_id: ROLE_EXEMPT },
      });
      assert.equal(r.location, `${INTEG_BASE()}?done=hp_exempt_removed`);
      assert.ok(!api.listStaffRoles(GUILD_A).find((x) => x.role_id === ROLE_EXEMPT));
      expectAudit("staff.role_remove", (a) =>
        assert.equal(JSON.parse(a.details_json).via, "honeypot.exempt")
      );
    });
  });

  // =========================================================================
  // PRG flash safety (query value is a whitelist key, never echoed)
  // =========================================================================

  describe("PRG flash safety", () => {
    before(async () => {
      await mountApp();
    });

    it("POST rejects redirect ONLY to whitelisted slugs (raw input never echoed)", async () => {
      const evil = "<script>alert(1)</script>";
      const { location } = await post(`${INTEG_BASE()}/youtube/interval`, {
        fields: { minutes: evil },
      });
      assert.equal(location, `${INTEG_BASE()}?error=invalid_interval`);
      assert.ok(!location.includes("script"), "location carries a slug, not the value");
    });

    it("GET with junk flash params renders nothing and echoes nothing (§8.7)", async () => {
      const evil = encodeURIComponent("<img src=x onerror=alert(1)>");
      const { body } = await getPage("staff", `?done=${evil}&error=${evil}`);
      assert.equal(body.includes("onerror"), false, "no injection");
      assert.equal(body.includes(evil), false, "no echo");
      // No flash message may appear for unknown slugs (the section's own
      // env-disabled banners are unrelated and legitimately present).
      for (const msg of ["Subscribed to the YouTube channel.", "Could not find a Twitch channel"]) {
        assert.equal(body.includes(msg), false, `flash "${msg}" absent`);
      }
    });

    it("GET with valid slugs renders the fixed flash messages", async () => {
      const { body } = await getPage("staff", "?done=hp_exempt_added");
      assert.ok(body.includes("Role added to staff roles"), "done banner renders");
      assert.ok(body.match(/class="banner banner-info/), "info banner class");
      const err = await getPage("staff", "?error=tw_resolve_failed");
      assert.ok(err.body.includes("Could not find a Twitch channel"), "error banner renders");
      assert.ok(err.body.match(/class="banner banner-warn/), "warn banner class");
    });

    it("successful mutation renders the stored value on the redirected page (cache invalidated)", async () => {
      await mountApp({
        lookupYoutubeChannel: async () => ({ id: "UCcachetest000001", name: "cache probe" }),
        fetchYoutubeChannelInfo: async () => null,
      });
      process.env.YOUTUBE_API_KEY = SENTINEL_YT_KEY;
      const { location } = await post(`${INTEG_BASE()}/youtube/add`, {
        fields: { url: "UCcachetest000001" },
      });
      assert.equal(location, `${INTEG_BASE()}?done=yt_added`);
      const { body } = await getPage("staff", "?done=yt_added");
      assert.ok(body.includes("UCcachetest000001"), "write is visible immediately (no stale cache)");
      // cleanup so the audit-count tests above stay isolated if re-run:
      await post(`${INTEG_BASE()}/youtube/remove`, { fields: { channel_id: "UCcachetest000001" } });
      for (const key of INTEG_ENV_KEYS) delete process.env[key];
    });
  });
});
