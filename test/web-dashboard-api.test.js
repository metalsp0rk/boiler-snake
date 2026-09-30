/**
 * Dashboard JSON API (Phase 4 charts, operator decision 2026-09-25):
 *   GET /g/:guildId/api/dashboard/activity.json     (line-chart series)
 *   GET /g/:guildId/api/dashboard/xp-leaders.json   (bar-chart series)
 *
 * HTTP-level net test mirroring test/web-routes-dashboard.test.js: real
 * Express app on an ephemeral port, REAL SQLite (temp DB, real staff_roles
 * rows, REAL incrementDaily/topUsers seeds), FAKE Discord through the
 * injected createGuildAccessResolver seam.
 *
 * Covers (acceptance set of web-admin-phase4 subtask 03):
 *  - tier ladder identical to every /g surface: anon ⇒ login redirect,
 *    member-without-tier ⇒ generic 404, cross-guild ⇒ the SAME plain 404
 *    bytes, junior/senior/admin ⇒ 200 (staff floor — §8.6);
 *  - framing: application/json + Cache-Control no-store + nosniff; POST is
 *    the app-wide 405; unknown /api/... paths are the plain router 404;
 *  - shape + real data: 30-day window zero-filled ASCENDING from REAL
 *    user_channel_message_daily rows (outside-window and other-guild rows
 *    never leak in), XP leaders capped at 10 descending;
 *  - §8.6 query budget: one bounded facade read per window; every request
 *    inside the ≥30 s cache window adds ZERO facade reads (fromCache true);
 *  - honesty: empty guild ⇒ empty-but-valid JSON, never 404/500; no
 *    fabricated points.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const { once } = require("node:events");
const { loadDb, communityKey } = require("./helpers/env");

// Clearly-fake placeholder only (AGENTS.md: never realistic secrets).
const SESSION_SECRET = "test-dashapi-sentinel-session-secret-NOT-REAL-042";

const GUILD_A = "710000000000000001"; // bot + every test user
const GUILD_CROSS = "710000000000000002"; // bot guild the users are NOT in
const GUILD_OTHER = "710000000000000003"; // noise: rows that must NEVER leak
const ROLE_JUNIOR = "role-junior-dashapi";
const ROLE_SENIOR = "role-senior-dashapi";

// Fluxer PR 2: integer communities.id for data + /g/<id> route identity
// (assigned in before() right after loadDb binds the temp DB).
let CID_A;
let CID_CROSS;
let CID_OTHER;

const USER_ADMIN = "810000000000000001"; // owner:true ⇒ tier admin
const USER_STAFF = "810000000000000002"; // junior staff role ⇒ tier staff
const USER_SENIOR = "810000000000000003"; // senior staff role ⇒ tier senior
const USER_PLAIN = "810000000000000004"; // member, no staff role ⇒ no tier

const ENV_KEYS = ["SESSION_SECRET", "DB_PATH", "DATA_DIR"];
const BOT_GUILDS = [GUILD_A, GUILD_CROSS, GUILD_OTHER];

// Route ids are the INTEGER community ids, resolved after loadDb — hence
// functions evaluated at test time (before() has assigned them by then).
const ACTIVITY_URL = () => `/g/${CID_A}/api/dashboard/activity.json`;
const LEADERS_URL = () => `/g/${CID_A}/api/dashboard/xp-leaders.json`;

const DAY_MS = 86_400_000;

/** UTC YYYY-MM-DD (same formula as utcDayKey in the repository). */
function dayKey(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

describe("dashboard JSON API (activity.json + xp-leaders.json, staff tier, no-store, cached)", () => {
  let api;
  let tmpDir;
  let savedEnv;

  /** @type {import("http").Server} */
  let server;
  let base;

  let appMod;
  let dashboardDataMod;
  let sessionPolicy;
  let tokens;

  /** role → cookie header value */
  const cookieOf = {};

  /** data-layer clock (advance to expire caches deterministically) */
  let fakeNow = Date.now();

  const fakeDiscord = {
    async getUserGuilds(token) {
      const userId = String(token).replace(/^tok-/, "");
      if (userId === USER_ADMIN) {
        return [{ id: GUILD_A, name: "Alpha HQ", icon: null, owner: true, permissions: "0" }];
      }
      if (userId === USER_PLAIN || userId === USER_STAFF || userId === USER_SENIOR) {
        return [{ id: GUILD_A, name: "Alpha HQ", icon: null, owner: false, permissions: "0" }];
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

  /** Boot a fresh app + fresh (cold-cache) data instance on an ephemeral port. */
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
      dashboardData: dashboardDataMod.createDashboardData({
        now: () => fakeNow,
        ttlMs: 30_000,
      }),
      ...extraOptions,
    });
    server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  }

  async function req(urlPath, { cookie, method = "GET" } = {}) {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      redirect: "manual",
      headers: cookie ? { cookie } : undefined,
    });
    const body = await res.text();
    return { res, body };
  }

  /** Count facade calls per endpoint run (cache + budget proofs). */
  function startCallCounter(names) {
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

  before(async () => {
    savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
    const loaded = loadDb();
    api = loaded.api;
    tmpDir = loaded.tmpDir;
    process.env.SESSION_SECRET = SESSION_SECRET;

    appMod = require("../src/web/app");
    dashboardDataMod = require("../src/web/data/dashboardData");
    sessionPolicy = require("../src/web/auth/sessions");
    tokens = require("../src/web/auth/tokens");

    // Map the Discord fixture ids to their integer community ids (PR 2).
    CID_A = communityKey(GUILD_A);
    CID_CROSS = communityKey(GUILD_CROSS);
    CID_OTHER = communityKey(GUILD_OTHER);

    api.addStaffRole(CID_A, ROLE_JUNIOR, "junior");
    api.addStaffRole(CID_A, ROLE_SENIOR, "senior");

    cookieOf.admin = `web_session=${mkSession(USER_ADMIN)}`;
    cookieOf.staff = `web_session=${mkSession(USER_STAFF)}`;
    cookieOf.senior = `web_session=${mkSession(USER_SENIOR)}`;
    cookieOf.plain = `web_session=${mkSession(USER_PLAIN)}`;

    // ---- REAL daily-counter seeds (repository path, UTC day keys) ---------
    const nowMs = Date.now();
    const today = dayKey(nowMs);
    const twoDaysAgo = dayKey(nowMs - 2 * DAY_MS);
    const fortyDaysAgo = dayKey(nowMs - 40 * DAY_MS); // OUTSIDE the 30-day window
    api.incrementDaily(CID_A, "820000000000000001", "930000000000000001", today, 5);
    api.incrementDaily(CID_A, "820000000000000002", "930000000000000001", today, 3);
    api.incrementDaily(CID_A, "820000000000000001", "930000000000000002", twoDaysAgo, 7);
    api.incrementDaily(CID_A, "820000000000000001", "930000000000000002", fortyDaysAgo, 99);
    // other-guild noise with the same users/days — guild-scoping control
    api.incrementDaily(CID_OTHER, "820000000000000001", "930000000000000001", today, 111);

    // ---- XP seeds: 12 members ⇒ the LIMIT 10 clamp must bite --------------
    for (let i = 0; i < 12; i += 1) {
      api.addXp(CID_A, `8300000000000000${String(i).padStart(2, "0")}`, 100 - i);
    }

    await mountApp();
  });

  after(async () => {
    if (server) {
      server.close();
      await once(server, "close");
    }
    for (const key of ENV_KEYS) {
      if (savedEnv?.[key] === undefined) delete process.env[key];
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

  // --------------------------------------------------------------------------
  // Tier ladder (§8.6): the JSON API shares the HTML surface's gates exactly.
  // --------------------------------------------------------------------------

  describe("tier ladder + framing", () => {
    for (const [label, pathSuffix] of [
      ["activity", "api/dashboard/activity.json"],
      ["xp-leaders", "api/dashboard/xp-leaders.json"],
    ]) {
      // Route ids resolve to the integer community ids set by before().
      const url = () => `/g/${CID_A}/${pathSuffix}`;
      const crossUrl = () => `/g/${CID_CROSS}/${pathSuffix}`;

      it(`${label}: anonymous ⇒ login redirect, empty body, no-store`, async () => {
        const { res, body } = await req(url());
        assert.equal(res.status, 302);
        // PR 2: integer community ids fail the 5–20-digit snowflake gate in
        // loginRedirectTarget, so the anon target is the bare login page.
        assert.equal(res.headers.get("location"), "/auth/login");
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.equal(body, "");
      });

      it(`${label}: member without a staff role ⇒ generic 404 (never 403)`, async () => {
        const { res, body } = await req(url(), { cookie: cookieOf.plain });
        assert.equal(res.status, 404);
        assert.equal(body, "Not found");
        assert.match(res.headers.get("content-type"), /^text\/plain/);
      });

      it(`${label}: cross-guild probe ⇒ the SAME plain 404 bytes`, async () => {
        const cross = await req(
          crossUrl(),
          { cookie: cookieOf.staff }
        );
        assert.equal(cross.res.status, 404);
        assert.equal(cross.body, "Not found");
      });

      it(`${label}: staff+ tiers ⇒ 200 application/json + no-store + nosniff`, async () => {
        for (const cookie of [cookieOf.staff, cookieOf.senior, cookieOf.admin]) {
          const { res, body } = await req(url(), { cookie });
          assert.equal(res.status, 200);
          assert.match(res.headers.get("content-type"), /^application\/json; charset=utf-8$/);
          assert.equal(res.headers.get("cache-control"), "no-store", "session data never caches (§8.7)");
          assert.equal(res.headers.get("x-content-type-options"), "nosniff");
          JSON.parse(body); // parseable JSON — never an HTML error page
        }
      });

      it(`${label}: GET-only — POST/DELETE are the app-wide 405`, async () => {
        for (const method of ["POST", "DELETE"]) {
          const res = await fetch(base + url(), {
            method,
            headers: { cookie: cookieOf.staff },
          });
          assert.equal(res.status, 405, `${method} must hit the methodGate`);
          assert.equal(await res.text(), "Method not allowed");
        }
      });
    }

    it("unknown path under /api/dashboard/ is the plain router 404", async () => {
      const { res, body } = await req(`/g/${CID_A}/api/dashboard/nope.json`, {
        cookie: cookieOf.staff,
      });
      assert.equal(res.status, 404);
      assert.equal(body, "Not found");
    });
  });

  // --------------------------------------------------------------------------
  // Shape + real data (zero-fill window, scoping, LIMITs).
  // --------------------------------------------------------------------------

  describe("activity.json — real daily series", () => {
    before(async () => {
      fakeNow = Date.now();
      await mountApp(); // cold cache for the shape assertions
    });

    it("30 zero-filled ascending days from REAL counter rows", async () => {
      const { body } = await req(ACTIVITY_URL(),{ cookie: cookieOf.staff });
      const data = JSON.parse(body);
      assert.equal(data.series, "daily_activity");
      assert.equal(data.days, 30);
      assert.equal(data.from, dayKey(fakeNow - 29 * DAY_MS));
      assert.equal(data.to, dayKey(fakeNow));
      assert.equal(data.points.length, 30);

      const byDay = Object.fromEntries(data.points.map((p) => [p.day, p.messages]));
      const today = dayKey(fakeNow);
      const twoDaysAgo = dayKey(fakeNow - 2 * DAY_MS);
      assert.equal(byDay[today], 8, "both seeded users count (5+3), same day");
      assert.equal(byDay[twoDaysAgo], 7, "single-user day counts once");
      assert.equal(byDay[dayKey(fakeNow - 40 * DAY_MS)], undefined,
        "OUTSIDE-window rows never appear (windowed read)");
      const todaySum = data.points.reduce((s, p) => s + p.messages, 0);
      assert.equal(todaySum, 15, "ONLY windowed guild-A rows (other guild's 111 excluded)");

      // strictly ascending unique day keys, every day present (zero-filled)
      for (let i = 0; i < 30; i += 1) {
        assert.equal(data.points[i].day, dayKey(fakeNow - (29 - i) * DAY_MS));
      }
      assert.equal(typeof data.generatedAt, "number");
    });

    it("cache: second request inside the window adds ZERO facade reads (fromCache)", async () => {
      const counter = startCallCounter(["guildDailyMessageTotals"]);
      try {
        fakeNow += 10_000; // still inside the 30 s TTL
        const second = JSON.parse((await req(ACTIVITY_URL(),{ cookie: cookieOf.admin })).body);
        assert.equal(counter.calls.length, 0, "cache hit must not touch the facade (§8.6)");
        assert.equal(second.fromCache, true, "freshness reported honestly");

        fakeNow += 31_000; // past the TTL
        const third = JSON.parse((await req(ACTIVITY_URL(),{ cookie: cookieOf.admin })).body);
        assert.equal(counter.calls.length, 1, "expired window re-reads exactly once");
        assert.equal(third.fromCache, false);
        assert.equal(counter.calls[0].args[1].limitDays, 30, "window hard-capped at 30 rows");
      } finally {
        counter.restore();
      }
    });
  });

  describe("xp-leaders.json — real top-10 series", () => {
    before(async () => {
      fakeNow = Date.now();
      await mountApp();
    });

    it("top 10 of 12 members, XP descending, name falls back honestly", async () => {
      const counter = startCallCounter(["topUsers"]);
      try {
        const { body } = await req(LEADERS_URL(),{ cookie: cookieOf.senior });
        const data = JSON.parse(body);
        assert.equal(data.series, "xp_leaders");
        assert.equal(data.limit, 10);
        assert.equal(counter.calls.length, 1);
        assert.equal(counter.calls[0].args[1], 10, "SQL LIMIT 10 (topUsers)");
        assert.equal(data.leaders.length, 10, "12 seeded members clamp to 10");
        assert.equal(data.leaders[0].xp, 100, "descending from the seed");
        assert.equal(data.leaders[9].xp, 91);
        for (let i = 1; i < data.leaders.length; i += 1) {
          assert.ok(data.leaders[i - 1].xp >= data.leaders[i].xp, "never out of order");
        }
        // No bot client wired ⇒ names are null (labels fall back client-side,
        // ids are the honest identity — never a fetch on a request path).
        assert.ok(data.leaders.every((l) => l.name === null), "cache-only names, cold ⇒ null");
        assert.match(data.leaders[0].userId, /^\d{15,20}$/);

        fakeNow += 5_000;
        await req(LEADERS_URL(),{ cookie: cookieOf.senior });
        assert.equal(counter.calls.length, 1, "cached within the window (§8.6)");
      } finally {
        counter.restore();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Honesty: a guild with rows outside the window still answers 200 with a
  // zero-filled window (never a 404/500 "no data" game).
  // --------------------------------------------------------------------------

  describe("empty-window honesty", () => {
    before(async () => {
      fakeNow = Date.now();
      await mountApp();
    });

    it("guild with no in-window rows ⇒ 200 + 30 zero points (real, not fabricated)", async () => {
      // GUILD_OTHER has rows only for today… give GUILD_CROSS the boot
      // treatment instead: it is IN botGuilds but the resolver maps every
      // user's guild list to GUILD_A only — so probe activity on GUILD_A
      // with a far-future clock: the window sits entirely past the data.
      fakeNow = Date.now() + 200 * DAY_MS;
      const cold = dashboardDataMod.createDashboardData({ now: () => fakeNow, ttlMs: 30_000 });
      await mountApp({ dashboardData: cold });
      const { res, body } = await req(ACTIVITY_URL(),{ cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      const data = JSON.parse(body);
      assert.equal(data.points.length, 30);
      assert.equal(data.points.every((p) => p.messages === 0), true,
        "all-zero window = truth (no rows in range), still 200");
      fakeNow = Date.now(); // leave the clock sane for later suites
    });
  });
});
