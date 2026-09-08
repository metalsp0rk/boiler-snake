/**
 * GET /g/:guildId/settings — the Phase 1 staff settings view (subtask 18,
 * roadmap web-admin.md §8.6 Settings row + cross-cutting 404 rule + query
 * budget). HTTP-level net test: real Express app on an ephemeral port,
 * REAL SQLite (temp DB, real staff_roles rows, seeded guild_settings /
 * allowed_command_channels / level_roles rows), FAKE Discord through the
 * injected createGuildAccessResolver seam — same harness style as
 * test/web-routes-dashboard.test.js.
 *
 * Covers:
 *  - tier matrix: anonymous ⇒ login redirect, stranger ⇒ generic 404,
 *    cross-guild ⇒ the SAME 404 bytes, malformed id ⇒ generic 404,
 *    junior/senior/admin ⇒ 200;
 *  - defaults + "commands allowed everywhere" note on an UNSEEDED guild
 *    (schema-default parity: the rendered defaults equal the freshly
 *    ensured row the schema DEFAULTs produced);
 *  - seeded exact values (XP awards, cooldowns, decay, log channel ids)
 *    with parity assertions against the live getGuildSettings row;
 *  - XSS probes through free-text-shaped setting values (channel ids,
 *    role ids) — escaped, never live, no on* attributes;
 *  - secrets contract: guild_settings row shape carries no token/secret
 *    columns AND non-whitelisted values (gork prompt text) never render;
 *  - cache TTL + query budget: exactly 3 facade reads per uncached assembly
 *    (ONE per cluster), ZERO inside the cached window, fresh again after;
 *  - channel-name seam: cache-only names, escaped, graceful id-only
 *    fallback when the client is absent/broken;
 *  - method-gate doctrine: the EXACT settings path is GET-only — every verb
 *    on it (and every unregistered/mismatched path+verb) stays a byte-exact
 *    405 (the Phase 1 pins survive Phase 2 registration);
 *  - Phase 2 MUTATIONS (subtask 24): POST /g/:guildId/settings/{xp,decay,
 *    logs,warn-log,command-channels/add,command-channels/remove} — CSRF
 *    (form + header), tier matrix (admin-only command channels),
 *    facade read-backs, exactly-one admin_audit row per success, zero
 *    writes/audits on validation rejects, PRG flash flags, cache
 *    invalidation after every accepted write, slash-patch parity.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// Clearly-fake placeholder only (AGENTS.md: never realistic secrets).
const SESSION_SECRET = "test-sett…cret";

const GUILD_A = "710000000000000001"; // bot + every test user
const GUILD_CROSS = "710000000000000002"; // bot guild the users are NOT in

const USER_ADMIN = "810000000000000001"; // owner:true ⇒ tier admin
const USER_STAFF = "810000000000000002"; // junior staff role ⇒ tier staff
const USER_SENIOR = "810000000000000003"; // senior staff role ⇒ tier senior
const USER_PLAIN = "810000000000000004"; // member, no staff role ⇒ no tier

const ENV_KEYS = ["SESSION_SECRET", "DB_PATH", "DATA_DIR"];
const BOT_GUILDS = [GUILD_A, GUILD_CROSS];

/** The three facade reads the settings page is allowed to make. */
const SETTINGS_READS = [
  "getGuildSettings",
  "listAllowedCommandChannels",
  "listLevelRoles",
];

describe("web settings page (GET /g/:guildId/settings, staff tier, read-only)", () => {
  /** @type {ReturnType<typeof loadDb>["api"]} */
  let api;
  let tmpDir;
  let savedEnv;

  /** @type {import("http").Server} */
  let server;
  let base;

  const cookieOf = {};
  /** Live session ids (parallel to cookieOf) → CSRF tokens can be derived. */
  const sessionIdOf = {};

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
  let settingsDataMod;
  let sessionPolicy;
  let tokens;
  let csrfMod;

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
   * Boot an app with a FRESH resolver on an ephemeral port. Every call gets
   * a fresh settingsData UNLESS the test passes one (mirrors the dashboard
   * suite's cache-bleed avoidance).
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
      settingsData: settingsDataMod.createSettingsData({}),
      ...extraOptions,
    });
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
   * Facade proxy that COUNTS the three settings reads while delegating to
   * the real facade (the data module looks methods up per call, so this
   * proxy object IS what runs).
   */
  function startReadCounter() {
    const calls = [];
    const proxy = Object.create(api);
    for (const name of SETTINGS_READS) {
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

    appMod = require("../src/web/app");
    settingsDataMod = require("../src/web/data/settingsData");
    sessionPolicy = require("../src/web/auth/sessions");
    tokens = require("../src/web/auth/tokens");
    csrfMod = require("../src/web/middleware/csrf");

    api.addStaffRole(GUILD_A, "role-junior-staff", "junior");
    api.addStaffRole(GUILD_A, "role-senior-staff", "senior");

    sessionIdOf.admin = mkSession(USER_ADMIN);
    sessionIdOf.staff = mkSession(USER_STAFF);
    sessionIdOf.senior = mkSession(USER_SENIOR);
    sessionIdOf.plain = mkSession(USER_PLAIN);
    cookieOf.admin = `web_session=${sessionIdOf.admin}`;
    cookieOf.staff = `web_session=${sessionIdOf.staff}`;
    cookieOf.senior = `web_session=${sessionIdOf.senior}`;
    cookieOf.plain = `web_session=${sessionIdOf.plain}`;

    await mountApp();
  });

  after(async () => {
    if (server) {
      server.close();
      await once(server, "close");
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
  // Tier matrix (§8.6) + cross-cutting 404 rule
  // -------------------------------------------------------------------------

  describe("tier matrix", () => {
    it("anonymous ⇒ 302 to /auth/login?guild=…", async () => {
      const { res, body } = await req(`/g/${GUILD_A}/settings`);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), `/auth/login?guild=${GUILD_A}`);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(body, "");
    });

    it("stranger (live member, no staff role) ⇒ generic 404, never 403", async () => {
      const { res, body } = await req(`/g/${GUILD_A}/settings`, { cookie: cookieOf.plain });
      assert.equal(res.status, 404);
      assert.equal(body, "Not found");
      assert.match(res.headers.get("content-type"), /^text\/plain/);
    });

    it("cross-guild probe ⇒ the SAME plain 404 bytes (§8.6)", async () => {
      const stranger = await req(`/g/${GUILD_A}/settings`, { cookie: cookieOf.plain });
      const cross = await req(`/g/${GUILD_CROSS}/settings`, { cookie: cookieOf.staff });
      assert.equal(cross.res.status, 404);
      assert.equal(cross.body, stranger.body);
    });

    it("malformed guild id with a live session ⇒ generic 404 (not echoed)", async () => {
      const { res, body } = await req("/g/oops-not-a-snowflake/settings", {
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
      it(`${label} ⇒ 200 settings shell`, async () => {
        const { res, body } = await req(`/g/${GUILD_A}/settings`, { cookie: cookie() });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type"), /^text\/html; charset=utf-8/);
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.ok(body.includes("Command channels"));
        assert.ok(body.includes("Cooldowns"));
        assert.ok(body.includes("Decay"));
        assert.ok(body.includes("Log channels"));
        assert.equal(body.match(/\son[a-z]+\s*=\s*["']/i), null);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Unseeded guild: schema-default parity + everywhere note (runs BEFORE
  // any settings mutation in this file, so the row still holds DEFAULTs)
  // -------------------------------------------------------------------------

  describe("fresh guild (no config writes yet)", () => {
    it("renders schema defaults + 'commands allowed everywhere' + admin hint", async () => {
      const row = api.getGuildSettings(GUILD_A);
      await mountApp();
      const { body } = await req(`/g/${GUILD_A}/settings`, { cookie: cookieOf.staff });
      // Freshly-ensured row == schema DEFAULTs (drift between this test's
      // expectations and migration 001 fails here first).
      assert.equal(row.msg_cooldown_sec, 20);
      assert.equal(row.reaction_cooldown_sec, 10);
      assert.equal(row.decay_min_messages, 20);
      assert.equal(row.decay_window_days, 7);

      assert.ok(body.includes("default 20s"), "message cooldown default noted");
      assert.ok(body.includes("default 10s"), "reaction cooldown default noted");
      assert.ok(body.includes("default 7 days"), "decay window default noted");
      assert.ok(body.includes("default 100"), "level factor default noted");
      assert.ok(body.includes("everywhere"), "empty allow-list ⇒ everywhere note");
      assert.ok(body.includes("allow-list is empty"));
      assert.ok(
        body.includes("requires Manage Server"),
        "admin-tier write hint visible (§8.6 per-setting tier)"
      );
      assert.ok(body.includes("/setcommandchannel"), "slash cross-reference rendered");
    });
  });

  // -------------------------------------------------------------------------
  // XSS probes through free-text-shaped setting values
  // -------------------------------------------------------------------------

  describe("XSS probes via setting-shaped values", () => {
    before(() => {
      api.addAllowedCommandChannel(GUILD_A, '<svg onload="alert(1)">');
      api.updateGuildSettings(GUILD_A, { warn_log_channel_id: '<img src=x onerror="alert(2)">' });
      api.upsertLevelRole(GUILD_A, '<script>alert(3)</script>', 2, 0);
    });

    it("channel ids / role ids render ESCAPED, never live", async () => {
      await mountApp();
      const { res, body } = await req(`/g/${GUILD_A}/settings`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      assert.ok(body.includes("&lt;svg onload=&quot;alert(1)&quot;&gt;"), "channel id escaped");
      assert.ok(body.includes("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;"), "warn log id escaped");
      assert.ok(body.includes("&lt;script&gt;alert(3)&lt;/script&gt;"), "role id escaped");
      assert.ok(!body.includes(`<svg onload="`), "no live svg");
      assert.ok(!body.includes(`<script>alert(3)`), "no live script payload");
      assert.equal(body.match(/\son[a-z]+\s*=\s*["']/i), null, "no on* attribute anywhere");
    });

    it("empty everywhere note gone once ids exist", async () => {
      const { body } = await req(`/g/${GUILD_A}/settings`, { cookie: cookieOf.senior });
      assert.ok(!body.includes("allow-list is empty"));
    });
  });

  // -------------------------------------------------------------------------
  // Seeded exact values + parity with the guild_settings row (acceptance:
  // "every displayed value reads from the same source the slash config
  // commands use")
  // -------------------------------------------------------------------------

  describe("seeded settings render exact values", () => {
    before(() => {
      api.updateGuildSettings(GUILD_A, {
        msg_xp: 7,
        reaction_xp: 11,
        voice_xp_per_min: 3,
        level_xp_factor: 250,
        msg_cooldown_sec: 33,
        reaction_cooldown_sec: 7,
        decay_enabled: 0,
        decay_min_messages: 42,
        decay_window_days: 9,
        decay_percent: 0.25,
        audit_log_channel_id: "700000000000000011",
        message_log_channel_id: "700000000000000012",
      });
      api.upsertLevelRole(GUILD_A, "6001", 5, 3);
    });

    it("every value on the page equals the row the slash commands read", async () => {
      await mountApp();
      const row = api.getGuildSettings(GUILD_A); // the slash source of truth
      const { body } = await req(`/g/${GUILD_A}/settings`, { cookie: cookieOf.staff });

      const valueCell = (text) => `<span class="setting-value">${text}</span>`;
      assert.ok(body.includes(valueCell(String(row.msg_xp))), "msg_xp exact");
      assert.ok(body.includes(valueCell(String(row.reaction_xp))), "reaction_xp exact");
      assert.ok(body.includes(valueCell(String(row.voice_xp_per_min))), "voice xp exact");
      assert.ok(body.includes(valueCell(String(row.level_xp_factor))), "factor exact");
      assert.ok(body.includes(valueCell(`${row.msg_cooldown_sec}s`)), "msg cooldown exact");
      assert.ok(body.includes(valueCell(`${row.reaction_cooldown_sec}s`)), "reaction cooldown exact");
      assert.ok(body.includes(valueCell(`${Math.round(row.decay_percent * 100)}%`)), "decay % exact");
      assert.ok(body.includes(valueCell("off")), "decay disabled renders off");
      assert.ok(body.includes(String(row.decay_min_messages)), "decay threshold exact");
      assert.ok(body.includes(`700000000000000011`), "audit channel id rendered");
      assert.ok(body.includes(`700000000000000012`), "message log channel id rendered");
      assert.ok(body.includes(`<code>6001</code>`), "level-role id rendered");
      assert.ok(body.includes("default 20s"), "defaults still noted next to custom values");
      // Slash-command cross-references (§8.6 usefulness requirement).
      assert.ok(body.includes("/setxp"), "cooldowns/XP governed by /setxp");
      assert.ok(body.includes("/setdecay"), "decay governed by /setdecay");
      assert.ok(body.includes("/setlog"), "log channels governed by /setlog");
    });

    it("decay percent default + everywhere-flag honesty", async () => {
      // custom 25% shown; DEFAULT line remains 10%.
      const { body } = await req(`/g/${GUILD_A}/settings`, { cookie: cookieOf.admin });
      assert.ok(body.includes("25%"));
      assert.ok(body.includes("default 10%"));
    });
  });

  // -------------------------------------------------------------------------
  // Secrets contract (§8.7)
  // -------------------------------------------------------------------------

  describe("no secrets ever rendered", () => {
    before(() => {
      // Free-text columns NOT in the settings view whitelist:
      api.updateGuildSettings(GUILD_A, {
        gork_keyword: "SECRET-GORK-MARKER",
        gork_extra_rules: "SECRET-GORK-RULES-MARKER",
      });
    });

    it("guild_settings row shape carries no token/secret-shaped columns", () => {
      const row = api.getGuildSettings(GUILD_A);
      const offenders = Object.keys(row).filter((k) =>
        settingsDataMod.isSecretColumnName(k)
      );
      assert.deepEqual(
        offenders,
        [],
        "if a secret-shaped column is ever added to guild_settings this test " +
          "must fire so the settings view whitelist gets re-reviewed"
      );
    });

    it("the whitelist guard itself detects secret-shaped names (unit)", () => {
      assert.equal(settingsDataMod.isSecretColumnName("access_token_enc"), true);
      assert.equal(settingsDataMod.isSecretColumnName("client_secret"), true);
      assert.equal(settingsDataMod.isSecretColumnName("refresh_password"), true);
      assert.equal(settingsDataMod.isSecretColumnName("audit_log_channel_id"), false);
      assert.equal(settingsDataMod.isSecretColumnName("decay_percent"), false);
    });

    it("non-whitelisted setting values never reach the page", async () => {
      await mountApp();
      const { body } = await req(`/g/${GUILD_A}/settings`, { cookie: cookieOf.staff });
      assert.ok(!body.includes("SECRET-GORK-MARKER"), "gork keyword not rendered");
      assert.ok(!body.includes("SECRET-GORK-RULES-MARKER"), "gork prompt rules not rendered");
    });
  });

  // -------------------------------------------------------------------------
  // Cache TTL + query budget (§8.6, review-blocking)
  // -------------------------------------------------------------------------

  describe("cache TTL + query budget", () => {
    it("uncached build = exactly one bounded read per cluster; cache hit = zero; expiry re-reads", async () => {
      let fakeNow = Date.now();
      const { calls, proxy } = startReadCounter();
      await mountApp({
        settingsData: settingsDataMod.createSettingsData({
          db: proxy,
          now: () => fakeNow,
          ttlMs: 30_000,
        }),
      });

      const first = await req(`/g/${GUILD_A}/settings`, { cookie: cookieOf.staff });
      assert.equal(first.res.status, 200);
      const afterFirst = calls.length;
      assert.equal(afterFirst, 3, "exactly 3 facade reads: one per settings cluster");
      assert.deepEqual(
        [...new Set(calls.map((c) => c.name))].sort(),
        [...SETTINGS_READS].sort(),
        "one getGuildSettings + one listAllowedCommandChannels + one listLevelRoles"
      );
      assert.deepEqual(
        calls.map((c) => c.args[0]).filter((a) => a !== GUILD_A),
        [],
        "every read is guild-scoped to the viewed guild — no cross-guild leakage"
      );

      fakeNow += 10_000; // inside the window
      const second = await req(`/g/${GUILD_A}/settings`, { cookie: cookieOf.staff });
      assert.equal(second.res.status, 200);
      assert.equal(calls.length, afterFirst, "cache hit must not touch the facade (§8.6)");
      assert.ok(second.body.includes("(cached)"), "freshness rendered honestly");

      fakeNow += 25_000; // past 30 s
      const third = await req(`/g/${GUILD_A}/settings`, { cookie: cookieOf.staff });
      assert.equal(third.res.status, 200);
      assert.ok(calls.length > afterFirst, "expired cache re-reads the facade");
    });
  });

  // -------------------------------------------------------------------------
  // Channel-name seam (cache-only, escaped, graceful fallback)
  // -------------------------------------------------------------------------

  describe("channel name seam via getClient", () => {
    const fakeClient = {
      channels: {
        cache: {
          get: (id) =>
            id === "700000000000000011" ? { name: "mod<b>&audit</b>" } : undefined,
        },
      },
    };

    it("cached names decorate ids (escaped); unknown channels stay id-only", async () => {
      await mountApp({ getClient: () => fakeClient });
      const { res, body } = await req(`/g/${GUILD_A}/settings`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      assert.ok(body.includes("(mod&lt;b&gt;&amp;audit&lt;/b&gt;)"), "escaped cached name shown");
      assert.ok(!body.includes("mod<b>"), "name never live");
      assert.ok(body.includes(`<code class="channel-id">700000000000000012</code>`));
    });

    it("absent / THROWING getClient degrade to ids — never a 500, never a fetch", async () => {
      for (const getClient of [null, () => { throw new Error("client exploded"); }]) {
        await mountApp({ getClient });
        const { res, body } = await req(`/g/${GUILD_A}/settings`, { cookie: cookieOf.staff });
        assert.equal(res.status, 200);
        assert.ok(body.includes(`700000000000000011`), "id still rendered");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Read-only Phase 1 (§8.8): no mutation routes on this path
  // -------------------------------------------------------------------------

  it("exact settings path is GET-only — POST/PUT/PATCH/DELETE 405 byte-exact", async () => {
    // Phase 2 registers mutations at DEEPER templates (…/settings/xp etc.);
    // the exact path stays GET-only and every mismatched verb/path is still
    // the byte-identical legacy 405 (methodGate lockstep proof, half 1).
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${base}/g/${GUILD_A}/settings`, {
        method,
        headers: { cookie: cookieOf.staff },
      });
      assert.equal(res.status, 405, `${method} must hit the app-wide 405 gate`);
      assert.equal(await res.text(), "Method not allowed");
    }
  });

  // =========================================================================
  // Phase 2 MUTATIONS (subtask 24): the same path family gains POST routes
  // under /g/:guildId/settings/*. Everything runs against the REAL facade +
  // real admin_audit rows; the fake Discord seam supplies the tiers.
  // =========================================================================

  describe("Phase 2 mutations (POST /g/:guildId/settings/*)", () => {
    /** Whitelisted mutation templates (mirror of routes/settings.js). */
    const MUTATION_PATHS = [
      "/settings/xp",
      "/settings/decay",
      "/settings/logs",
      "/settings/warn-log",
      "/settings/command-channels/add",
      "/settings/command-channels/remove",
    ];

    const tokenFor = (who) =>
      csrfMod.deriveCsrfToken(sessionIdOf[who], SESSION_SECRET);

    /**
     * @param {string} urlPath
     * @param {{ cookie?: string, fields?: Record<string,string>,
     *   token?: string, headerToken?: string }|null} [opts] token=null (via
     *   omit) sends NO _csrf; token="" sends an EMPTY field.
     */
    async function post(urlPath, opts = {}) {
      const { cookie, fields = {}, token, headerToken } = opts;
      const body = new URLSearchParams(fields);
      if (token !== undefined) body.set("_csrf", token);
      const headers = cookie ? { cookie } : {};
      if (headerToken) headers["x-csrf-token"] = headerToken;
      const res = await fetch(`${base}${urlPath}`, {
        method: "POST",
        redirect: "manual",
        body,
        headers: Object.keys(headers).length ? headers : undefined,
      });
      const text = await res.text();
      return { res, body: text, location: res.headers.get("location") };
    }

    /** web-origin audit rows for GUILD_A, newest first. */
    const webAudits = () => api.listAdminAudit(GUILD_A, { origin: "web", limit: 100 });
    const webAuditCount = () => api.countAdminAudit(GUILD_A, { origin: "web" });

    const decayColumns = (row) => ({
      decay_enabled: row.decay_enabled,
      decay_min_messages: row.decay_min_messages,
      decay_window_days: row.decay_window_days,
      decay_percent: row.decay_percent,
    });
    const xpColumns = (row) => ({
      msg_xp: row.msg_xp,
      reaction_xp: row.reaction_xp,
      voice_xp_per_min: row.voice_xp_per_min,
      level_xp_factor: row.level_xp_factor,
      msg_cooldown_sec: row.msg_cooldown_sec,
      reaction_cooldown_sec: row.reaction_cooldown_sec,
    });

    // ---------------------------------------------------------------------
    // Method-gate lockstep (half 2): registered templates clear the gate;
    // every unregistered method/path combination stays byte-405.
    // ---------------------------------------------------------------------

    describe("method gate lockstep", () => {
      before(async () => {
        await mountApp();
      });

      it("every registered POST template passes the gate (anon ⇒ 302, never 405)", async () => {
        for (const suffix of MUTATION_PATHS) {
          const { res, body } = await post(`/g/${GUILD_A}${suffix}`, { fields: {} });
          assert.notEqual(res.status, 405, `${suffix} must not be gated out`);
          assert.equal(res.status, 302, `anon ${suffix} ⇒ login redirect`);
          assert.equal(res.headers.get("location"), `/auth/login?guild=${GUILD_A}`);
          assert.equal(body, "");
        }
      });

      it("mismatched verbs/paths are byte-identical 405 (never reaches CSRF)", async () => {
        const mismatches = [
          ["PUT", `/g/${GUILD_A}/settings/decay`],
          ["PATCH", `/g/${GUILD_A}/settings/decay`],
          ["DELETE", `/g/${GUILD_A}/settings/decay`],
          ["PUT", `/g/${GUILD_A}/settings/command-channels/add`],
          ["POST", `/g/${GUILD_A}/settings/decayX`],
          ["POST", `/g/${GUILD_A}/settings/decay/extra`],
          ["POST", `/g/${GUILD_A}/settings/command-channels/add/x`],
          ["POST", `/g/${GUILD_A}/settings/xp/`],
          ["PUT", `/g/${GUILD_A}/settings/xp`],
        ];
        for (const [method, path] of mismatches) {
          const res = await fetch(`${base}${path}`, {
            method,
            headers: { cookie: cookieOf.admin },
            body: `_csrf=${tokenFor("admin")}`,
          });
          assert.equal(res.status, 405, `${method} ${path} must 405`);
          assert.equal(await res.text(), "Method not allowed", `${method} ${path} body`);
        }
      });
    });

    // ---------------------------------------------------------------------
    // CSRF (§8.7) + authn/authz matrix (§8.6)
    // ---------------------------------------------------------------------

    describe("CSRF + tier matrix", () => {
      before(async () => {
        await mountApp();
      });

      it("anonymous POST ⇒ 302 login (guildScope before anything mutates)", async () => {
        const { res, location } = await post(`/g/${GUILD_A}/settings/decay`, {
          fields: { percent: "10" },
        });
        assert.equal(res.status, 302);
        assert.equal(location, `/auth/login?guild=${GUILD_A}`);
      });

      it("missing _csrf ⇒ 403, nothing written, nothing audited", async () => {
        const beforeRow = decayColumns(api.getGuildSettings(GUILD_A));
        const beforeCount = webAuditCount();
        const { res, body } = await post(`/g/${GUILD_A}/settings/decay`, {
          cookie: cookieOf.staff,
          fields: { percent: "50" },
        });
        assert.equal(res.status, 403);
        assert.equal(body, "Forbidden");
        assert.deepEqual(decayColumns(api.getGuildSettings(GUILD_A)), beforeRow);
        assert.equal(webAuditCount(), beforeCount, "CSRF denial never audits");
      });

      it("wrong token shape/value ⇒ 403", async () => {
        for (const bad of ["", "deadbeef", "0".repeat(64)]) {
          const { res, body } = await post(`/g/${GUILD_A}/settings/decay`, {
            cookie: cookieOf.staff,
            fields: { percent: "50", _csrf: "ignored" },
            token: bad,
          });
          assert.equal(res.status, 403, `token "${bad.slice(0, 8)}…" must be denied`);
          assert.equal(body, "Forbidden");
        }
      });

      it("valid X-CSRF-Token header (htmx path) is accepted", async () => {
        const { res, location } = await post(`/g/${GUILD_A}/settings/decay`, {
          cookie: cookieOf.senior,
          fields: { enabled: "on" },
          headerToken: tokenFor("senior"),
        });
        assert.equal(res.status, 302);
        assert.equal(location, `/g/${GUILD_A}/settings?ok=decay`);
      });

      it("stranger (in guild, no staff role) with a VALID token ⇒ generic 404", async () => {
        const { res, body } = await post(`/g/${GUILD_A}/settings/decay`, {
          cookie: cookieOf.plain,
          fields: { percent: "10" },
          token: tokenFor("plain"),
        });
        assert.equal(res.status, 404);
        assert.equal(body, "Not found");
      });

      it("cross-guild mutation ⇒ the SAME generic 404 bytes (never 403)", async () => {
        const { res, body } = await post(`/g/${GUILD_CROSS}/settings/xp`, {
          cookie: cookieOf.staff,
          fields: { message: "9" },
          token: tokenFor("staff"),
        });
        assert.equal(res.status, 404);
        assert.equal(body, "Not found");
      });

      it("staff-tier mutations answer 302 for staff/senior/admin alike", async () => {
        for (const who of ["staff", "senior", "admin"]) {
          const { res, location } = await post(`/g/${GUILD_A}/settings/decay`, {
            cookie: cookieOf[who],
            fields: { enabled: "on" },
            token: tokenFor(who),
          });
          assert.equal(res.status, 302, `${who} must be allowed (staff tier)`);
          assert.equal(location, `/g/${GUILD_A}/settings?ok=decay`);
        }
      });

      it("command-channel mutations are ADMIN-only (staff 403, senior 403)", async () => {
        const beforeCount = webAuditCount();
        for (const who of ["staff", "senior"]) {
          for (const op of ["add", "remove"]) {
            const { res, body } = await post(
              `/g/${GUILD_A}/settings/command-channels/${op}`,
              {
                cookie: cookieOf[who],
                fields: { channel: "700000000000000077" },
                token: tokenFor(who),
              }
            );
            assert.equal(res.status, 403, `${who} on ${op} must be denied`);
            assert.equal(body, "Forbidden");
          }
        }
        assert.equal(webAuditCount(), beforeCount, "403s write no audit rows");
        assert.equal(
          api
            .listAllowedCommandChannels(GUILD_A)
            .some((r) => r.channel_id === "700000000000000077"),
          false,
          "denied add wrote no row"
        );
      });
    });

    // ---------------------------------------------------------------------
    // XP cluster (/setxp parity: values + cooldowns + level factor)
    // ---------------------------------------------------------------------

    describe("xp cluster (POST /settings/xp)", () => {
      before(async () => {
        await mountApp();
      });

      it("happy path: row + exactly one xp.settings_update audit row", async () => {
        const beforeCount = webAuditCount();
        const { res, location } = await post(`/g/${GUILD_A}/settings/xp`, {
          cookie: cookieOf.staff,
          fields: {
            message: "8",
            reaction: "4",
            voice: "2",
            factor: "120",
            msgcooldown: "25",
            reactioncooldown: "12",
          },
          token: tokenFor("staff"),
        });
        assert.equal(res.status, 302);
        assert.equal(location, `/g/${GUILD_A}/settings?ok=xp`);

        const row = api.getGuildSettings(GUILD_A); // facade read-back
        assert.equal(row.msg_xp, 8);
        assert.equal(row.reaction_xp, 4);
        assert.equal(row.voice_xp_per_min, 2);
        assert.equal(row.level_xp_factor, 120);
        assert.equal(row.msg_cooldown_sec, 25);
        assert.equal(row.reaction_cooldown_sec, 12);

        assert.equal(webAuditCount(), beforeCount + 1, "exactly one audit row");
        const entry = webAudits()[0];
        assert.equal(entry.action, "xp.settings_update");
        assert.equal(entry.origin, "web");
        assert.equal(entry.guild_id, GUILD_A);
        assert.equal(entry.actor_user_id, USER_STAFF);
        assert.equal(entry.target_type, "guild");
        assert.equal(entry.target_id, GUILD_A);
        assert.deepEqual(JSON.parse(entry.details_json), {
          patch: {
            msg_xp: 8,
            reaction_xp: 4,
            voice_xp_per_min: 2,
            msg_cooldown_sec: 25,
            reaction_cooldown_sec: 12,
            level_xp_factor: 120,
          },
        });
      });

      it("cooldown 0 is accepted (slash: 0 disables the cooldown)", async () => {
        const { res } = await post(`/g/${GUILD_A}/settings/xp`, {
          cookie: cookieOf.admin,
          fields: { msgcooldown: "0" },
          token: tokenFor("admin"),
        });
        assert.equal(res.status, 302);
        assert.equal(api.getGuildSettings(GUILD_A).msg_cooldown_sec, 0);
      });

      it("validation rejects: negatives, non-numbers, bounds — zero writes, zero audits", async () => {
        const beforeRow = xpColumns(api.getGuildSettings(GUILD_A));
        const beforeCount = webAuditCount();
        const bad = [
          { message: "-5" },
          { message: "abc" },
          { message: "1000000001" }, // > MAX_XP_AWARD (1e9)
          { reaction: "1.5" },
          { msgcooldown: "-1" },
          { factor: "99999" }, // slash bounds 1..10000
          { factor: "0" },
          {}, // empty patch ("No XP settings provided")
        ];
        for (const fields of bad) {
          const { res, location } = await post(`/g/${GUILD_A}/settings/xp`, {
            cookie: cookieOf.staff,
            fields,
            token: tokenFor("staff"),
          });
          assert.equal(res.status, 302, `bad payload ${JSON.stringify(fields)} ⇒ PRG`);
          assert.equal(location, `/g/${GUILD_A}/settings?err=xp`);
        }
        assert.deepEqual(xpColumns(api.getGuildSettings(GUILD_A)), beforeRow);
        assert.equal(webAuditCount(), beforeCount, "rejected writes never audit");
      });

      it("error flash renders the fixed banner (GET ?err=xp)", async () => {
        const { res, body } = await req(`/g/${GUILD_A}/settings?err=xp`, {
          cookie: cookieOf.staff,
        });
        assert.equal(res.status, 200);
        assert.ok(body.includes("banner banner-error"), "error banner rendered");
        assert.ok(body.includes("XP settings were NOT saved"));
      });
    });

    // ---------------------------------------------------------------------
    // Decay cluster (/setdecay parity incl. the percent → fraction clamp)
    // ---------------------------------------------------------------------

    describe("decay cluster (POST /settings/decay)", () => {
      before(async () => {
        await mountApp();
      });

      it("percent is stored as a fraction exactly like slash", async () => {
        const beforeCount = webAuditCount();
        const { res, location } = await post(`/g/${GUILD_A}/settings/decay`, {
          cookie: cookieOf.staff,
          fields: { enabled: "on", percent: "30", days: "14", messages: "5" },
          token: tokenFor("staff"),
        });
        assert.equal(res.status, 302);
        assert.equal(location, `/g/${GUILD_A}/settings?ok=decay`);

        const row = api.getGuildSettings(GUILD_A);
        assert.equal(row.decay_enabled, 1);
        assert.equal(row.decay_percent, 0.3); // 30 / 100
        assert.equal(row.decay_window_days, 14);
        assert.equal(row.decay_min_messages, 5);

        assert.equal(webAuditCount(), beforeCount + 1);
        const entry = webAudits()[0];
        assert.equal(entry.action, "decay.settings_update");
        assert.equal(entry.origin, "web");
        assert.equal(entry.actor_user_id, USER_STAFF);
        assert.equal(entry.target_type, "guild");
        assert.deepEqual(JSON.parse(entry.details_json), {
          patch: {
            decay_enabled: 1,
            decay_min_messages: 5,
            decay_window_days: 14,
            decay_percent: 0.3,
          },
        });
      });

      it("bounds mirror slash: percent>95, days<1, messages<0, empty ⇒ err + nothing", async () => {
        const beforeRow = decayColumns(api.getGuildSettings(GUILD_A));
        const beforeCount = webAuditCount();
        for (const fields of [
          { percent: "120" },
          { percent: "-1" },
          { days: "0" },
          { messages: "-3" },
          { enabled: "maybe" },
          {},
        ]) {
          const { res, location } = await post(`/g/${GUILD_A}/settings/decay`, {
            cookie: cookieOf.staff,
            fields,
            token: tokenFor("staff"),
          });
          assert.equal(res.status, 302);
          assert.equal(location, `/g/${GUILD_A}/settings?err=decay`, `${JSON.stringify(fields)}`);
        }
        assert.deepEqual(decayColumns(api.getGuildSettings(GUILD_A)), beforeRow);
        assert.equal(webAuditCount(), beforeCount);
      });

      it("boundary values 0 and 95 percent are VALID (slash min/max)", async () => {
        for (const p of ["0", "95"]) {
          const { res, location } = await post(`/g/${GUILD_A}/settings/decay`, {
            cookie: cookieOf.admin,
            fields: { percent: p },
            token: tokenFor("admin"),
          });
          assert.equal(res.status, 302);
          assert.equal(location, `/g/${GUILD_A}/settings?ok=decay`);
        }
        assert.equal(api.getGuildSettings(GUILD_A).decay_percent, 0.95);
      });
    });

    // ---------------------------------------------------------------------
    // Log channels (/setlog audit|message XOR clear; /setwarn log)
    // ---------------------------------------------------------------------

    describe("log channels (POST /settings/logs + /settings/warn-log)", () => {
      before(async () => {
        // Fixture: warn column starts clean so audit details are exact.
        api.updateGuildSettings(GUILD_A, { warn_log_channel_id: null });
        await mountApp();
      });

      it("set audit stream ⇒ logs.channel_set (target = channel)", async () => {
        const prev = api.getGuildSettings(GUILD_A).audit_log_channel_id;
        const beforeCount = webAuditCount();
        const { res, location } = await post(`/g/${GUILD_A}/settings/logs`, {
          cookie: cookieOf.staff,
          fields: { stream: "audit", channel: "700000000000000031" },
          token: tokenFor("staff"),
        });
        assert.equal(res.status, 302);
        assert.equal(location, `/g/${GUILD_A}/settings?ok=logs`);
        assert.equal(api.getGuildSettings(GUILD_A).audit_log_channel_id, "700000000000000031");

        assert.equal(webAuditCount(), beforeCount + 1);
        const entry = webAudits()[0];
        assert.equal(entry.action, "logs.channel_set");
        assert.equal(entry.target_type, "channel");
        assert.equal(entry.target_id, "700000000000000031");
        assert.equal(entry.origin, "web");
        assert.deepEqual(JSON.parse(entry.details_json), {
          stream: "audit",
          previous_channel_id: prev,
        });
      });

      it("clear audit stream ⇒ logs.channel_clear (target = guild, column NULL)", async () => {
        const beforeCount = webAuditCount();
        const { res } = await post(`/g/${GUILD_A}/settings/logs`, {
          cookie: cookieOf.senior,
          fields: { stream: "audit", clear: "1" },
          token: tokenFor("senior"),
        });
        assert.equal(res.status, 302);
        assert.equal(api.getGuildSettings(GUILD_A).audit_log_channel_id, null);

        const entry = webAudits()[0];
        assert.equal(entry.action, "logs.channel_clear");
        assert.equal(entry.target_type, "guild");
        assert.equal(entry.target_id, GUILD_A);
        assert.deepEqual(JSON.parse(entry.details_json), {
          stream: "audit",
          previous_channel_id: "700000000000000031",
        });
        assert.equal(webAuditCount(), beforeCount + 1);
      });

      it("message stream set + warn-log set/clear mirror their slash actions", async () => {
        await post(`/g/${GUILD_A}/settings/logs`, {
          cookie: cookieOf.staff,
          fields: { stream: "message", channel: "700000000000000032" },
          token: tokenFor("staff"),
        });
        assert.equal(api.getGuildSettings(GUILD_A).message_log_channel_id, "700000000000000032");
        assert.equal(webAudits()[0].action, "logs.channel_set");

        await post(`/g/${GUILD_A}/settings/warn-log`, {
          cookie: cookieOf.staff,
          fields: { channel: "700000000000000033" },
          token: tokenFor("staff"),
        });
        assert.equal(api.getGuildSettings(GUILD_A).warn_log_channel_id, "700000000000000033");
        const warnSet = webAudits()[0];
        assert.equal(warnSet.action, "warnings.log_channel_set");
        assert.equal(warnSet.target_type, "channel");
        assert.equal(warnSet.target_id, "700000000000000033");

        await post(`/g/${GUILD_A}/settings/warn-log`, {
          cookie: cookieOf.staff,
          fields: { clear: "1" },
          token: tokenFor("staff"),
        });
        assert.equal(api.getGuildSettings(GUILD_A).warn_log_channel_id, null);
        const warnClear = webAudits()[0];
        assert.equal(warnClear.action, "warnings.log_channel_clear");
        assert.equal(warnClear.target_type, "guild");
      });

      it("XSS-shaped and junk channel ids are REJECTED (no write, no audit)", async () => {
        const before = api.getGuildSettings(GUILD_A);
        const beforeMsg = before.message_log_channel_id;
        const beforeWarn = before.warn_log_channel_id;
        const beforeCount = webAuditCount();
        for (const channel of [
          '<svg onload="alert(1)">',
          "not-a-snowflake",
          "1234", // below the 5-digit web snowflake floor
          "x".repeat(21),
        ]) {
          const { res, location } = await post(`/g/${GUILD_A}/settings/logs`, {
            cookie: cookieOf.staff,
            fields: { stream: "message", channel },
            token: tokenFor("staff"),
          });
          assert.equal(res.status, 302);
          assert.equal(location, `/g/${GUILD_A}/settings?err=logs`, `channel "${channel}"`);
        }
        assert.equal(api.getGuildSettings(GUILD_A).message_log_channel_id, beforeMsg);
        assert.equal(api.getGuildSettings(GUILD_A).warn_log_channel_id, beforeWarn);
        assert.equal(webAuditCount(), beforeCount);
      });

      it("channel XOR clear + unknown stream ⇒ err, nothing written", async () => {
        const beforeCount = webAuditCount();
        const before = api.getGuildSettings(GUILD_A).audit_log_channel_id;
        for (const fields of [
          { stream: "audit" }, // neither channel nor clear
          { stream: "audit", channel: "700000000000000031", clear: "1" }, // both
          { stream: "bonkers", channel: "700000000000000031" }, // unknown stream
        ]) {
          const { res, location } = await post(`/g/${GUILD_A}/settings/logs`, {
            cookie: cookieOf.staff,
            fields,
            token: tokenFor("staff"),
          });
          assert.equal(res.status, 302);
          assert.equal(location, `/g/${GUILD_A}/settings?err=logs`);
        }
        assert.equal(api.getGuildSettings(GUILD_A).audit_log_channel_id, before);
        assert.equal(webAuditCount(), beforeCount);
      });
    });

    // ---------------------------------------------------------------------
    // Command channels (ADMIN tier, /setcommandchannel add|remove parity)
    // ---------------------------------------------------------------------

    describe("command channels (POST /settings/command-channels/*)", () => {
      before(async () => {
        await mountApp();
      });

      it("admin add/remove write the allow-list rows + command_channels.* audits", async () => {
        const chan = "700000000000000041";
        assert.equal(
          api.listAllowedCommandChannels(GUILD_A).some((r) => r.channel_id === chan),
          false
        );

        const { res, location } = await post(`/g/${GUILD_A}/settings/command-channels/add`, {
          cookie: cookieOf.admin,
          fields: { channel: chan },
          token: tokenFor("admin"),
        });
        assert.equal(res.status, 302);
        assert.equal(location, `/g/${GUILD_A}/settings?ok=channels`);
        assert.ok(
          api.listAllowedCommandChannels(GUILD_A).some((r) => r.channel_id === chan),
          "allow-list row exists (facade read-back)"
        );
        let entry = webAudits()[0];
        assert.equal(entry.action, "command_channels.add");
        assert.equal(entry.origin, "web");
        assert.equal(entry.guild_id, GUILD_A);
        assert.equal(entry.actor_user_id, USER_ADMIN);
        assert.equal(entry.target_type, "channel");
        assert.equal(entry.target_id, chan);

        const { res: res2 } = await post(`/g/${GUILD_A}/settings/command-channels/remove`, {
          cookie: cookieOf.admin,
          fields: { channel: chan },
          token: tokenFor("admin"),
        });
        assert.equal(res2.status, 302);
        assert.equal(
          api.listAllowedCommandChannels(GUILD_A).some((r) => r.channel_id === chan),
          false,
          "row removed"
        );
        entry = webAudits()[0];
        assert.equal(entry.action, "command_channels.remove");
        assert.equal(entry.target_id, chan);
      });

      it("invalid channel id ⇒ err redirect, no row, no audit (even for admin)", async () => {
        const beforeCount = webAuditCount();
        const { res, location } = await post(`/g/${GUILD_A}/settings/command-channels/add`, {
          cookie: cookieOf.admin,
          fields: { channel: "99; DROP TABLE guild_settings;--" },
          token: tokenFor("admin"),
        });
        assert.equal(res.status, 302);
        assert.equal(location, `/g/${GUILD_A}/settings?err=channels`);
        assert.equal(webAuditCount(), beforeCount);
      });
    });

    // ---------------------------------------------------------------------
    // PRG flash contract + service-layer proof + cache invalidation
    // ---------------------------------------------------------------------

    describe("flash, service layer + cache invalidation", () => {
      it("ok/err flags render FIXED banners; junk flags render nothing (no reflection)", async () => {
        await mountApp();
        const ok = await req(`/g/${GUILD_A}/settings?ok=decay`, { cookie: cookieOf.staff });
        assert.equal(ok.res.status, 200);
        assert.ok(ok.body.includes("banner banner-info"));
        assert.ok(ok.body.includes("Decay settings saved."));

        const junk = await req(
          `/g/${GUILD_A}/settings?ok=${encodeURIComponent("<script>alert(9)</script>")}`,
          { cookie: cookieOf.staff }
        );
        assert.equal(junk.res.status, 200);
        assert.ok(!junk.body.includes("banner banner-info"), "junk flag renders no banner");
        assert.ok(!junk.body.includes("<script>alert(9)"), "flag never reflected");
      });

      it("every accepted write invalidates the per-guild cache snapshot", async () => {
        let fakeNow = Date.now();
        const { calls, proxy } = startReadCounter();
        await mountApp({
          settingsData: settingsDataMod.createSettingsData({
            db: proxy,
            now: () => fakeNow,
            ttlMs: 30_000,
          }),
        });

        await req(`/g/${GUILD_A}/settings`, { cookie: cookieOf.staff });
        const afterBuild = calls.length;
        assert.equal(afterBuild, 3, "uncached build = 3 reads");

        fakeNow += 1_000; // inside the window
        await req(`/g/${GUILD_A}/settings`, { cookie: cookieOf.staff });
        assert.equal(calls.length, afterBuild, "cached GET issues zero reads");

        const { res } = await post(`/g/${GUILD_A}/settings/decay`, {
          cookie: cookieOf.staff,
          fields: { days: "21" },
          token: tokenFor("staff"),
        });
        assert.equal(res.status, 302);

        fakeNow += 1_000; // STILL inside the 30 s window
        const fresh = await req(`/g/${GUILD_A}/settings`, { cookie: cookieOf.staff });
        assert.ok(calls.length > afterBuild, "mutation must invalidate the cache");
        assert.ok(fresh.body.includes("21 days"), "view shows the just-written value");
      });

      it("routes call the shared facade helpers (service-layer spy), never SQL", async () => {
        await mountApp();
        const origUpdate = api.updateGuildSettings;
        const origAdd = api.addAllowedCommandChannel;
        const origRemove = api.removeAllowedCommandChannel;
        const calls = [];
        api.updateGuildSettings = (...args) => {
          calls.push(["updateGuildSettings", ...args]);
          return origUpdate(...args);
        };
        api.addAllowedCommandChannel = (...args) => {
          calls.push(["addAllowedCommandChannel", ...args]);
          return origAdd(...args);
        };
        api.removeAllowedCommandChannel = (...args) => {
          calls.push(["removeAllowedCommandChannel", ...args]);
          return origRemove(...args);
        };
        try {
          // REJECTED payload ⇒ the facade is NEVER touched.
          await post(`/g/${GUILD_A}/settings/decay`, {
            cookie: cookieOf.staff,
            fields: { percent: "400" },
            token: tokenFor("staff"),
          });
          assert.deepEqual(calls, [], "validation rejects must not reach the service layer");

          // ACCEPTED writes ⇒ EXACTLY one point op each (10k-row safe).
          await post(`/g/${GUILD_A}/settings/decay`, {
            cookie: cookieOf.staff,
            fields: { percent: "12" },
            token: tokenFor("staff"),
          });
          assert.equal(calls.filter((c) => c[0] === "updateGuildSettings").length, 1);

          await post(`/g/${GUILD_A}/settings/command-channels/add`, {
            cookie: cookieOf.admin,
            fields: { channel: "700000000000000042" },
            token: tokenFor("admin"),
          });
          assert.equal(calls.filter((c) => c[0] === "addAllowedCommandChannel").length, 1);

          await post(`/g/${GUILD_A}/settings/command-channels/remove`, {
            cookie: cookieOf.admin,
            fields: { channel: "700000000000000042" },
            token: tokenFor("admin"),
          });
          assert.equal(calls.filter((c) => c[0] === "removeAllowedCommandChannel").length, 1);
        } finally {
          api.updateGuildSettings = origUpdate;
          api.addAllowedCommandChannel = origAdd;
          api.removeAllowedCommandChannel = origRemove;
        }
      });
    });

    // ---------------------------------------------------------------------
    // Slash parity checklist (§8.8 Phase 2): the same patch built the slash
    // handler would build — applied directly to a pristine guild — must
    // produce an IDENTICAL guild_settings state to the web form's write.
    // ---------------------------------------------------------------------

    describe("slash↔web parity checklist", () => {
      const PARITY_GUILD_XP = "720000000000000001";
      const PARITY_GUILD_DECAY = "720000000000000002";

      before(async () => {
        await mountApp();
      });

      it("web /setxp form ≡ slash updateGuildSettings(msg/cooldown/factor patch)", async () => {
        const { res } = await post(`/g/${GUILD_A}/settings/xp`, {
          cookie: cookieOf.admin,
          fields: {
            message: "13",
            reaction: "6",
            voice: "3",
            msgcooldown: "31",
            reactioncooldown: "8",
            factor: "222",
          },
          token: tokenFor("admin"),
        });
        assert.equal(res.status, 302);

        // The EXACT patch handleSetXp builds for the same slash options:
        api.updateGuildSettings(PARITY_GUILD_XP, {
          msg_xp: 13,
          reaction_xp: 6,
          voice_xp_per_min: 3,
          msg_cooldown_sec: 31,
          reaction_cooldown_sec: 8,
          level_xp_factor: 222,
        });
        assert.deepEqual(
          xpColumns(api.getGuildSettings(GUILD_A)),
          xpColumns(api.getGuildSettings(PARITY_GUILD_XP)),
          "identical guild_settings state (slash parity — xp cluster)"
        );
      });

      it("web /setdecay form ≡ slash updateGuildSettings(enabled/percent patch)", async () => {
        const { res } = await post(`/g/${GUILD_A}/settings/decay`, {
          cookie: cookieOf.admin,
          fields: { enabled: "off", percent: "55", messages: "7", days: "28" },
          token: tokenFor("admin"),
        });
        assert.equal(res.status, 302);

        // handleSetDecay: enabled→0, Math.max(0,m), Math.max(1,d), min(.95,max(0,p/100))
        api.updateGuildSettings(PARITY_GUILD_DECAY, {
          decay_enabled: 0,
          decay_min_messages: Math.max(0, 7),
          decay_window_days: Math.max(1, 28),
          decay_percent: Math.min(0.95, Math.max(0, 55 / 100)),
        });
        assert.deepEqual(
          decayColumns(api.getGuildSettings(GUILD_A)),
          decayColumns(api.getGuildSettings(PARITY_GUILD_DECAY)),
          "identical guild_settings state (slash parity — decay cluster)"
        );
      });
    });
  });
});
