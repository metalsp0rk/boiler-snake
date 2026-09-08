/**
 * GET /g/:guildId — the Phase 1 staff dashboard (subtask 14, roadmap
 * web-admin.md §8.6 row 1 + the cross-cutting 404 rule + the §8.6 query
 * budget). HTTP-level net test: real Express app on an ephemeral port,
 * REAL SQLite (temp DB, real staff_roles rows, seeded users/tickets),
 * FAKE Discord through the injected createGuildAccessResolver seam — the
 * same harness style as test/web-views-layout.test.js §C.
 *
 * Covers:
 *  - tier matrix: anonymous ⇒ login redirect, stranger (member, no staff
 *    role) ⇒ generic 404, cross-guild ⇒ generic 404 (indistinguishable),
 *    malformed id ⇒ generic 404, junior/senior/admin tiers ⇒ 200;
 *  - content: open-ticket count + newest rows (incl. ESCAPED reason),
 *    XP leaders, tickers "unknown", now-playing states;
 *  - degraded sources: no lavalink / no ticker wiring / throwing providers
 *    still render 200 with honest unknown/unavailable text;
 *  - cache TTL honored: second request inside the window issues ZERO
 *    dashboard queries (facade methods wrapped with a call counter);
 *  - query budget on a seeded DB (600 users, 60 open tickets): capped
 *    facade args (topUsers 10, listOpenTickets ≤ 50), 50+ saturation
 *    display, ≤5 ticket rows + ≤10 leader rows rendered;
 *  - read-only Phase 1: every non-GET on the dashboard path is the
 *    app-wide 405 (no mutation routes exist here).
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// Clearly-fake placeholder only (AGENTS.md: never realistic secrets).
const SESSION_SECRET = "test-dash…cret";

const GUILD_A = "700000000000000001"; // bot + every test user
const GUILD_CROSS = "700000000000000002"; // bot guild the users are NOT in
const GUILD_USER_ONLY = "700000000000000003"; // user guild without the bot
const ROLE_JUNIOR = "role-junior-staff";
const ROLE_SENIOR = "role-senior-staff";

const USER_ADMIN = "800000000000000001"; // owner:true ⇒ tier admin
const USER_STAFF = "800000000000000002"; // junior staff role ⇒ tier staff
const USER_SENIOR = "800000000000000003"; // senior staff role ⇒ tier senior
const USER_PLAIN = "800000000000000004"; // member, no staff role ⇒ no tier

const ENV_KEYS = ["SESSION_SECRET", "DB_PATH", "DATA_DIR"];

/** Members the bot serves (GUILD_USER_ONLY is user-only noise). */
const BOT_GUILDS = [GUILD_A, GUILD_CROSS];

describe("web dashboard (GET /g/:guildId, staff tier, query budget)", () => {
  /** @type {ReturnType<typeof loadDb>["api"]} */
  let api;
  let tmpDir;
  let savedEnv;

  /** @type {import("http").Server} */
  let server;
  let base;

  /** role → cookie header value */
  const cookieOf = {};

  const fakeDiscord = {
    async getUserGuilds(token) {
      const userId = String(token).replace(/^tok-/, "");
      if (userId === USER_ADMIN) {
        return [
          { id: GUILD_A, name: "Alpha HQ", icon: null, owner: true, permissions: "0" },
          { id: GUILD_USER_ONLY, name: "UserOnly", icon: null, owner: false, permissions: "0" },
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
          { id: GUILD_USER_ONLY, name: "UserOnly", icon: null, owner: false, permissions: "0" },
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
      if (userId === USER_STAFF) return { roles: [ROLE_JUNIOR] };
      if (userId === USER_SENIOR) return { roles: [ROLE_SENIOR] };
      return { roles: [] };
    },
  };

  /** @type {import("../src/web/app")} */
  let appMod;
  /** @type {import("../src/web/data/dashboardData")} */
  let dashboardDataMod;
  let sessionPolicy;
  let tokens;

  /**
   * Live sessions backed by REAL web_sessions rows + an encrypted AT the
   * real resolver can decrypt (mirrors the subtask-11 layout suite).
   * @param {string} userId
   */
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
   * Boot an app with a fresh resolver + the given createWebApp options and
   * bind it to an ephemeral port (one app per describe-block via mountApp()).
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

  /** Wrap the five facade reads dashboardData performs, counting calls. */
  function startCallCounter() {
    const names = [
      "guildActivityStats",
      "getGuildActivitySettings",
      "guildHasActiveBackfill",
      "topUsers",
      "listOpenTickets",
    ];
    const calls = [];
    const originals = {};
    for (const name of names) {
      originals[name] = api[name];
      api[name] = (...args) => {
        calls.push({ name, args });
        return originals[name](...args);
      };
    }
    return {
      calls,
      restore() {
        for (const name of names) api[name] = originals[name];
      },
    };
  }

  /**
   * Seed helpers (real facade writes).
   */
  function seedTicket(guildId, creatorUserId, reason) {
    return api.createTicket({
      guildId,
      creatorUserId,
      channelId: `ch-${Math.random().toString(36).slice(2, 12)}`,
      reason,
    });
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
    dashboardDataMod = require("../src/web/data/dashboardData");
    sessionPolicy = require("../src/web/auth/sessions");
    tokens = require("../src/web/auth/tokens");

    // REAL staff_roles rows — the same tables memberHasStaffRole reads.
    api.addStaffRole(GUILD_A, ROLE_JUNIOR, "junior");
    api.addStaffRole(GUILD_A, ROLE_SENIOR, "senior");

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
  // Tier matrix (§8.6): staff+ ⇒ 200; stranger/anon/cross-guild ⇒ 404/302
  // -------------------------------------------------------------------------

  describe("tier matrix", () => {
    it("anonymous ⇒ 302 to /auth/login?guild=… (byte-identical redirect)", async () => {
      const { res, body } = await req(`/g/${GUILD_A}`);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), `/auth/login?guild=${GUILD_A}`);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(body, "");
    });

    it("stranger (live member, no staff role) ⇒ generic 404, never 403", async () => {
      const { res, body } = await req(`/g/${GUILD_A}`, { cookie: cookieOf.plain });
      assert.equal(res.status, 404);
      assert.equal(body, "Not found");
      assert.match(res.headers.get("content-type"), /^text\/plain/);
    });

    it("cross-guild probe ⇒ the SAME plain 404 bytes as the stranger row", async () => {
      const cross = await req(`/g/${GUILD_CROSS}`, { cookie: cookieOf.staff });
      assert.equal(cross.res.status, 404);
      assert.equal(cross.body, "Not found");
    });

    it("malformed guild id with a live session ⇒ generic 404 (not echoed)", async () => {
      const { res, body } = await req("/g/oops-not-a-snowflake", {
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
      it(`${label} ⇒ 200 shell dashboard`, async () => {
        const { res, body } = await req(`/g/${GUILD_A}`, { cookie: cookie() });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type"), /^text\/html; charset=utf-8/);
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.equal(res.headers.get("x-content-type-options"), "nosniff");
        assert.ok(body.includes("Open tickets"));
        assert.ok(body.includes("Ticker health"));
        assert.ok(body.includes("now playing"));
        assert.ok(!body.includes("<script>alert"), "no live script payload");
        assert.equal(body.match(/\son[a-z]+\s*=\s*["']/i), null);
      });
    }

    it("read-only Phase 1: no mutation routes on the dashboard path", async () => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await fetch(`${base}/g/${GUILD_A}`, {
          method,
          headers: { cookie: cookieOf.staff },
        });
        assert.equal(res.status, 405, `${method} must hit the app-wide 405 gate`);
        assert.equal(await res.text(), "Method not allowed");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Content: tickets section (count, newest rows, escaping)
  // -------------------------------------------------------------------------

  describe("open tickets section", () => {
    before(async () => {
      // fresh 30s-cache data instance per suite → no bleed from matrix runs
      seedTicket(GUILD_A, "900000000000000001", "Refund question");
      seedTicket(GUILD_A, "900000000000000002", "Report a member");
      seedTicket(GUILD_A, "900000000000000003", '<svg onload="alert(1)">');
      await mountApp({ dashboardData: dashboardDataMod.createDashboardData({}) });
    });

    it("renders the open count + newest rows with ESCAPED reasons", async () => {
      const { body } = await req(`/g/${GUILD_A}`, { cookie: cookieOf.staff });
      assert.match(body, /3 open in this guild/, "open count from capped list");
      assert.ok(body.includes("Refund question"));
      assert.ok(body.includes("Report a member"));
      assert.ok(
        body.includes("&lt;svg onload=&quot;alert(1)&quot;&gt;"),
        "ticket reason escaped in the table cell"
      );
      assert.ok(!body.includes(`<svg onload="`), "no live svg payload");
    });
  });

  // -------------------------------------------------------------------------
  // Degraded sources: unwired/throwing providers still render 200
  // -------------------------------------------------------------------------

  describe("degraded sources", () => {
    it("no lavalink, no ticker wiring ⇒ 200 with honest unknown text", async () => {
      await mountApp({ dashboardData: dashboardDataMod.createDashboardData({}) });
      const { res, body } = await req(`/g/${GUILD_A}`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      assert.ok(body.includes("Now-playing status: unknown"));
      assert.ok(
        body.includes("No ticker sources report in yet"),
        "tickers render 'unknown' until sources register"
      );
    });

    it("providers that THROW degrade the section, not the page", async () => {
      await mountApp({
        dashboardData: dashboardDataMod.createDashboardData({
          getNowPlaying: () => {
            throw new Error("lavalink exploded");
          },
          getTickerHealth: async () => {
            throw new Error("registry exploded");
          },
        }),
      });
      const { res, body } = await req(`/g/${GUILD_A}`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      assert.ok(body.includes("Now-playing status: unknown"));
      assert.ok(body.includes("No ticker sources report in yet"));
    });

    it("a wired now-playing provider renders the snapshot", async () => {
      await mountApp({
        dashboardData: dashboardDataMod.createDashboardData({
          getNowPlaying: () => ({
            status: "playing",
            title: "Test Track",
            author: "Test Band",
            paused: false,
            positionMs: 65_000,
            upcoming: 3,
          }),
        }),
      });
      const { body } = await req(`/g/${GUILD_A}`, { cookie: cookieOf.staff });
      assert.ok(body.includes("Test Track"));
      assert.ok(body.includes("Test Band"));
      assert.ok(body.includes("1:05"), "position rendered as m:ss");
      assert.ok(body.includes("3 queued"));
    });
  });

  // -------------------------------------------------------------------------
  // Cache: §8.6 acceptance — second request in the window issues NO new
  // dashboard aggregate queries (facade calls counted).
  // -------------------------------------------------------------------------

  describe("cache TTL", () => {
    it("second request within the TTL issues zero dashboard queries; after it, one fresh set", async () => {
      let fakeNow = Date.now();
      const counter = startCallCounter();
      try {
        await mountApp({
          dashboardData: dashboardDataMod.createDashboardData({
            now: () => fakeNow,
            ttlMs: 30_000,
          }),
        });

        const first = await req(`/g/${GUILD_A}`, { cookie: cookieOf.staff });
        assert.equal(first.res.status, 200);
        const afterFirst = counter.calls.length;
        assert.ok(afterFirst > 0, "first request reads through the facade");

        fakeNow += 10_000; // inside the window
        const second = await req(`/g/${GUILD_A}`, { cookie: cookieOf.staff });
        assert.equal(second.res.status, 200);
        assert.equal(
          counter.calls.length,
          afterFirst,
          "cache hit must not touch the facade again (§8.6)"
        );
        assert.ok(second.body.includes("(cached,"), "freshness rendered honestly");

        fakeNow += 25_000; // past the 30s window
        const third = await req(`/g/${GUILD_A}`, { cookie: cookieOf.staff });
        assert.equal(third.res.status, 200);
        assert.ok(
          counter.calls.length > afterFirst,
          "expired cache re-reads the facade"
        );
      } finally {
        counter.restore();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Query budget on a seeded DB (§8.6, review-blocking)
  // -------------------------------------------------------------------------

  describe("query budget on seeded data (600 users, 60 open tickets)", () => {
    before(async () => {
      for (let i = 0; i < 600; i += 1) {
        api.addXp(GUILD_A, `u-seed-${i}`, 10 + i);
      }
      for (let i = 0; i < 60; i += 1) {
        seedTicket(GUILD_A, "920000000000000001", `bulk ticket ${i}`);
      }
    });

    it("bounded facade args + bounded rendered rows regardless of seed size", async () => {
      const counter = startCallCounter();
      try {
        await mountApp({ dashboardData: dashboardDataMod.createDashboardData({}) });
        const { res, body } = await req(`/g/${GUILD_A}`, { cookie: cookieOf.staff });
        assert.equal(res.status, 200);

        const listCalls = counter.calls.filter((c) => c.name === "listOpenTickets");
        const topCalls = counter.calls.filter((c) => c.name === "topUsers");
        assert.equal(listCalls.length, 1);
        assert.equal(topCalls.length, 1);
        assert.ok(listCalls[0].args[1].limit <= 50, "open-ticket read capped ≤50");
        assert.ok(topCalls[0].args[1] <= 10, "XP leaders read capped ≤10");

        // Saturation is DISPLAYED, never hidden (§8.6 capped-read honesty).
        assert.ok(body.includes("50+"), "60 open tickets render as '50+'");
        // Rendered sections are hard-bounded: 5 newest tickets, 10 leaders.
        assert.equal((body.match(/<td>#/g) || []).length, 5);
        assert.equal((body.match(/<li>/g) || []).length, 10);
        // One uncached assembly = a small constant facade footprint.
        assert.ok(
          counter.calls.length <= 5,
          `expected ≤5 facade reads per uncached dashboard, got ${counter.calls.length}`
        );
      } finally {
        counter.restore();
      }
    });
  });
});
