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
 *  - read-only Phase 1: every non-GET on the settings path is 405 (no
 *    mutation routes registered — writes land in Phase 2 subtask 24).
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

    api.addStaffRole(GUILD_A, "role-junior-staff", "junior");
    api.addStaffRole(GUILD_A, "role-senior-staff", "senior");

    cookieOf.admin = `web_session=${mkSession(USER_ADMIN)}`;
    cookieOf.staff = `web_session=${mkSession(USER_STAFF)}`;
    cookieOf.senior = `web_session=${mkSession(USER_SENIOR)}`;
    cookieOf.plain = `web_session=${mkSession(USER_PLAIN)}`;

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

  it("no POST/PUT/PATCH/DELETE routes — app-wide 405 on the settings path", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${base}/g/${GUILD_A}/settings`, {
        method,
        headers: { cookie: cookieOf.staff },
      });
      assert.equal(res.status, 405, `${method} must hit the app-wide 405 gate`);
      assert.equal(await res.text(), "Method not allowed");
    }
  });
});
