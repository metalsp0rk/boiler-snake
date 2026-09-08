/**
 * Subtask 16 — web XP leaderboard + per-user XP pages (roadmap/web-admin.md
 * §8.6 "XP: leaderboard, history | Staff" row, Phase 1 read-only). FULLY
 * OFFLINE integration net over the REAL createWebApp() mount (guildScope →
 * requireTier → leaderboard routes): real SQLite (loadDb), real session rows,
 * fake Discord resolver + fake bot member cache. node --test only.
 *
 * Suites:
 *  A. Access matrix (both routes): anon 302 · in-guild non-staff 404 ·
 *     cross-guild (guild B, bot absent) 404 with NO guild-B XP leak ·
 *     staff/senior/admin 200 — never 403 for scoped-out visitors;
 *  B. Pagination math on 105 seeded users (§8.6 budget): default 25/page,
 *     rank windows per page, empty tail page, size hard cap 100, page
 *     overflow CLAMP to the last real page, junk params normalized,
 *     deterministic xp-DESC + user_id-ASC tie order, empty guild state;
 *  C. XP parity: per-row xp sequence + xp multiset == repository topUsers
 *     (slash's source) over the seeded DB; every level label ==
 *     levelFromXp fixture math; XSS-escaped member display names;
 *  D. Per-user page: rank/level/progress fixtures (mirror of
 *     render/leaderboard.js levelProgress: 1234 XP · factor 100 → level 3,
 *     334/700 · 48% · 366 to level 4), history-unavailable note,
 *     unknown-user in-shell 404, garbage id byte-generic 404;
 *  E. Read-only: POST 405 on every path, HEAD 200-empty.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// ---------------------------------------------------------------------------
// loadDb() FIRST (cache clear + DB_PATH bind), then require src modules.
// ---------------------------------------------------------------------------
const { api, tmpDir } = loadDb();

const { createWebApp } = require("../src/web/app");
const { createGuildAccessResolver } = require("../src/web/auth/guildAccess");
const sessionPolicy = require("../src/web/auth/sessions");
const tokens = require("../src/web/auth/tokens");
const { levelFromXp } = require("../src/core/xpMath");
const {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  buildLeaderboardPage,
} = require("../src/web/data/leaderboard");
const { barBucketClass } = require("../src/web/views/leaderboard");

// Clearly-fake placeholder secret (AGENTS.md: never real-looking secrets).
const SESSION_SECRET = "test-l…-xyz";

const USER_ADMIN = "428190112345678901";
const USER_SENIOR = "428190112345678902";
const USER_STAFF = "428190112345678903";
const USER_PLAIN = "428190112345678904";

const GUILD_A = "100000000000000001";
const GUILD_B = "200000000000000002"; // bot NOT in B — cross-guild probe target
const GUILD_C = "300000000000000003"; // bot in C, staff in C, NO users (empty state)

const ROLE_JUNIOR = "500000000000000011";
const ROLE_SENIOR = "500000000000000012";

/** XP fixtures (factor 100): level = floor(sqrt(xp/100)). */
const LB_RICH = "610000000000000001"; // xp 10000 → level 10, progress 0%, 2100 → L11
const LB_MID = "610000000000000002"; // xp 1234  → level 3, 334/700 (48%), 366 → L4
const LB_XSS = "610000000000000003"; // xp 999   → level 3; XSS display name in cache
const XSS_NAME = '"><img src=x onerror=EVIL>nick';

/** Two extra xp=55 users exercising the user_id-ASC tie order (with bulk #55). */
const TIE_A = "8000000000000000001";
const TIE_B = "8000000000000000002";
const bulkId = (i) => `7${String(i).padStart(18, "0")}`; // xp = i, rank = 106 - i
const BULK_COUNT = 100; // total guild-A tracked users = 100 + 3 + 2 = 105

/** Guild-B-only XP user — never visible under guild A. */
const B_ONLY = "9000000000000000001";
const B_XP = 7331;
/** Valid snowflake with NO XP row — friendly-404 target. */
const UNKNOWN_USER = "999999999999999999";

const ENV_KEYS = ["SESSION_SECRET", "CLIENT_SECRET", "PUBLIC_BASE_URL", "WEB_TIER_CACHE_TTL_MS", "DB_PATH", "DATA_DIR"];
let savedEnv;

/** Mutable harness state (declared BEFORE the hooks below reference it). */
const suite = { server: null, base: "", cookies: {} };

/** Count non-overlapping occurrences (cheap DOM-free row counting). */
function count(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

before(async () => {
  savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
  process.env.SESSION_SECRET = SESSION_SECRET;
  delete process.env.CLIENT_SECRET;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.WEB_TIER_CACHE_TTL_MS;

  // ---- staff roles (guild A) -----------------------------------------------
  api.addStaffRole(GUILD_A, ROLE_JUNIOR, "junior");
  api.addStaffRole(GUILD_A, ROLE_SENIOR, "senior");
  // Guild C hosts the EMPTY-leaderboard probe: the same junior role id must be
  // registered in C's OWN staff_roles rows for the staff visitor to resolve a
  // tier there (per-guild registration, exactly like production).
  api.addStaffRole(GUILD_C, ROLE_JUNIOR, "junior");

  // ---- XP fixtures (guild A) ------------------------------------------------
  api.addXp(GUILD_A, LB_RICH, 10000);
  api.addXp(GUILD_A, LB_MID, 1234);
  api.addXp(GUILD_A, LB_XSS, 999);

  // ---- bulk seed: >100 users so pagination math bites ------------------------
  for (let i = 1; i <= BULK_COUNT; i += 1) {
    api.addXp(GUILD_A, bulkId(i), i); // xp=i → rank = 106 - i (105 tracked total)
  }
  api.addXp(GUILD_A, TIE_A, 55); // ties with bulk #55 → deterministic user_id order
  api.addXp(GUILD_A, TIE_B, 55);

  // ---- guild-B-only user (cross-guild probe) ---------------------------------
  api.addXp(GUILD_B, B_ONLY, B_XP);

  // ---- fake Discord (resolver) ------------------------------------------------
  const fakeDiscord = {
    async getUserGuilds(token) {
      const userId = String(token).replace(/^tok-/, "");
      if (userId === USER_STAFF) {
        return [
          { id: GUILD_A, name: "Guild A", icon: null, owner: false, permissions: "104324673" },
          { id: GUILD_C, name: "Guild C (empty)", icon: null, owner: false, permissions: "104324673" },
        ];
      }
      if ([USER_ADMIN, USER_SENIOR, USER_PLAIN].includes(userId)) {
        return [
          {
            id: GUILD_A,
            name: "Guild A",
            icon: null,
            owner: userId === USER_ADMIN,
            permissions: userId === USER_ADMIN ? "0" : "104324673",
          },
        ];
      }
      return [];
    },
    async getUserGuildMember(token, guildId) {
      const userId = String(token).replace(/^tok-/, "");
      if (guildId === GUILD_A || guildId === GUILD_C) {
        if (userId === USER_STAFF) return { roles: [ROLE_JUNIOR] };
        if (userId === USER_SENIOR && guildId === GUILD_A) return { roles: [ROLE_SENIOR] };
        return { roles: [] };
      }
      const err = new Error("Unknown Guild");
      err.status = 404;
      throw err;
    },
  };

  const resolver = createGuildAccessResolver({
    discord: fakeDiscord,
    botGuilds: async () => [GUILD_A, GUILD_C], // bot in A + C, NEVER B
    now: Date.now,
    ttlMs: 60_000,
  });

  // ---- fake bot client cache (display names — slash's name source) -----------
  const fakeGuildA = {
    members: {
      cache: new Map([
        [LB_XSS, { displayName: XSS_NAME }],
        [LB_MID, { displayName: "Midnight Snake" }],
      ]),
    },
  };
  const fakeClient = {
    guilds: { cache: new Map([[GUILD_A, fakeGuildA]]) }, // C absent → cache-miss fallback path
  };

  // ---- real app + mount order (guildScope → leaderboard routes) ---------------
  const app = createWebApp({ guildAccess: resolver, getClient: () => fakeClient });
  suite.server = http.createServer(app);
  suite.server.listen(0, "127.0.0.1");
  await once(suite.server, "listening");
  suite.base = `http://127.0.0.1:${suite.server.address().port}`;

  suite.cookies = {};
  const snapshotFor = (userId) => {
    const guilds = [
      {
        id: GUILD_A,
        name: "A",
        icon: null,
        owner: userId === USER_ADMIN,
        permissions: userId === USER_ADMIN ? "0" : "104324673",
      },
    ];
    if (userId === USER_STAFF) {
      guilds.push({ id: GUILD_C, name: "C", icon: null, owner: false, permissions: "104324673" });
    }
    return JSON.stringify(guilds);
  };
  for (const [key, userId] of [
    ["admin", USER_ADMIN],
    ["senior", USER_SENIOR],
    ["staff", USER_STAFF],
    ["plain", USER_PLAIN],
  ]) {
    const s = sessionPolicy.createSession({ userId });
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken(`tok-${userId}`),
      tokenExpiresAt: Date.now() + 3_600_000,
      scopes: "identify guilds guilds.members.read",
      guildSnapshot: snapshotFor(userId),
    });
    suite.cookies[key] = s.id;
  }
});

after(async () => {
  if (suite.server) {
    suite.server.close();
    await once(suite.server, "close");
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

/** @param {string} path @param {{key?: string, method?: string}} [opts] */
async function hit(path, opts = {}) {
  const res = await fetch(`${suite.base}${path}`, {
    method: opts.method || "GET",
    redirect: "manual",
    headers: opts.key ? { cookie: `web_session=${suite.cookies[opts.key]}` } : undefined,
  });
  const body = await res.text();
  return { res, body };
}

const BOARD = `/g/${GUILD_A}/leaderboard`;
const userXp = (id, gid = GUILD_A) => `/g/${gid}/leaderboard/user/${id}`;

// ===========================================================================
// A. Access matrix — both routes (§8.6; never 403 for scoped-out visitors)
// ===========================================================================
describe("access matrix — leaderboard + per-user XP", () => {
  for (const [label, path] of [
    ["board", BOARD],
    ["user", userXp(LB_MID)],
  ]) {
    it(`${label}: anonymous → 302 login redirect (guildScope contract)`, async () => {
      const { res, body } = await hit(path);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), `/auth/login?guild=${GUILD_A}`);
      assert.equal(body, "");
    });

    it(`${label}: in-guild member WITHOUT staff role → generic 404 (never 403)`, async () => {
      const { res, body } = await hit(path, { key: "plain" });
      assert.equal(res.status, 404);
      assert.equal(body, "Not found");
    });

    it(`${label}: cross-guild (guild B, bot absent) → generic 404, no data leak`, async () => {
      const { res, body } = await hit(
        label === "board" ? `/g/${GUILD_B}/leaderboard` : userXp(LB_MID, GUILD_B),
        { key: "staff" }
      );
      assert.equal(res.status, 404);
      assert.equal(body, "Not found");
      assert.ok(!body.includes(String(B_XP)), "guild-B XP never in a cross-guild deny");
    });

    it(`${label}: staff / senior / admin all 200 (tier ladder staff ≤ all)`, async () => {
      for (const key of ["staff", "senior", "admin"]) {
        const { res } = await hit(path, { key });
        assert.equal(res.status, 200, key);
      }
    });
  }
});

// ===========================================================================
// B. Pagination math on the 105-user seed (§8.6 query budget)
// ===========================================================================
describe("GET /g/:guildId/leaderboard — pagination math", () => {
  it("page 1 default size: 25 rows, ranks 1–25, XP-desc fixtures in order", async () => {
    const { res, body } = await hit(BOARD, { key: "staff" });
    assert.equal(res.status, 200);
    assert.equal(count(body, 'class="row-lb"'), PAGE_SIZE_DEFAULT);
    assert.ok(body.includes("showing ranks 1–25 of 105"), "honest rank window + total");
    assert.ok(body.includes("page 1 of 5"), "ceil(105/25) = 5 pages");
    const iRich = body.indexOf(LB_RICH);
    const iMid = body.indexOf(LB_MID);
    const iXss = body.indexOf(LB_XSS);
    assert.ok(iRich !== -1 && iMid !== -1 && iXss !== -1, "fixture rows present");
    assert.ok(iRich < iMid && iMid < iXss, "xp 10000 > 1234 > 999 row order");
    // rank cells for the top of the board
    assert.match(body, /class="lb-rank">1<\/td>[\s\S]*?class="lb-rank">2<\/td>/);
  });

  // Rank algebra on this seed: bulk #i (xp=i) sits at rank 104-i, or 106-i
  // below the xp-55 tie trio (bulk#55 #49, TIE_A #50, TIE_B #51 by user_id ASC).
  it("page 2 renders ranks 26–50 (window moves, size preserved)", async () => {
    const { res, body } = await hit(`${BOARD}?page=2`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.equal(count(body, 'class="row-lb"'), 25);
    assert.ok(body.includes("showing ranks 26–50 of 105"));
    assert.ok(body.includes("page 2 of 5"));
    assert.ok(body.includes(bulkId(78)), "rank 26 = bulk #78 (104-78)");
    assert.ok(body.includes(bulkId(56)), "rank 48 = bulk #56");
    assert.ok(body.includes(bulkId(55)) && body.includes(TIE_A), "ranks 49–50 = tie head");
    assert.ok(!body.includes(bulkId(79)), "rank 25 = bulk #79 stays on page 1");
    assert.ok(!body.includes(TIE_B), "rank 51 = TIE_B belongs to page 3");
    // ?size survives the next link
    assert.ok(body.includes("page=3"), "next link present");
  });

  it("empty tail: page 5 has exactly 5 rows (ranks 101–105)", async () => {
    const { body } = await hit(`${BOARD}?page=5`, { key: "staff" });
    assert.equal(count(body, 'class="row-lb"'), 5);
    assert.ok(body.includes("showing ranks 101–105 of 105"));
    assert.ok(body.includes(bulkId(1)), "last rank 105 = bulk #1");
    assert.ok(!body.includes("page=6"), "no next link on the last page");
  });

  it("size hard cap: ?size=5000 renders at most 100 rows (§8.6 cap)", async () => {
    const { res, body } = await hit(`${BOARD}?size=5000`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.equal(count(body, 'class="row-lb"'), PAGE_SIZE_MAX);
    assert.ok(body.includes("showing ranks 1–100 of 105"));
    assert.ok(body.includes("page 1 of 2"), "ceil(105/100) = 2 pages at the cap");
  });

  it("page overflow CLAMPS to the last real page (never blank page-9999)", async () => {
    const { res, body } = await hit(`${BOARD}?page=9999&size=100`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.equal(count(body, 'class="row-lb"'), 5);
    assert.ok(body.includes("showing ranks 101–105 of 105 · page 2 of 2"));

    const dflt = await hit(`${BOARD}?page=9999`, { key: "staff" });
    assert.ok(dflt.body.includes("page 5 of 5"), "default size clamps to page 5");
  });

  it("junk params normalize: page=abc → 1, size=3.7 → floor 3 → 35 pages, never 500/echo", async () => {
    const { res, body } = await hit(`${BOARD}?page=abc<size>&size=3.7`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.equal(count(body, 'class="row-lb"'), 3);
    assert.ok(body.includes("page 1 of 35"), "ceil(105/3) = 35 pages");
    assert.ok(!body.includes("<size>"), "junk never echoes unescaped");
  });

  it("tie order is deterministic: xp 55 trio renders bulk#55 < TIE_A < TIE_B", async () => {
    const p2 = (await hit(`${BOARD}?page=2&size=25`, { key: "staff" })).body;
    assert.ok(p2.includes(bulkId(55)), "rank 49 = first xp-55 id (user_id ASC tie-break)");
    assert.ok(p2.includes(TIE_A), "rank 50 = second id");
    assert.ok(p2.indexOf(bulkId(55)) < p2.indexOf(TIE_A), "ties ordered by user_id ASC");
    assert.ok(!p2.includes(TIE_B), "rank 51 is on the next page");
    const p3 = (await hit(`${BOARD}?page=3&size=25`, { key: "staff" })).body;
    assert.ok(p3.includes(TIE_B), "TIE_B renders at rank 51 on page 3");
  });

  it("empty guild (bot-present, zero tracked users) → empty state, 200", async () => {
    const { res, body } = await hit(`/g/${GUILD_C}/leaderboard`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("No XP data yet"));
    assert.ok(body.includes("page 1 of 1"));
    assert.equal(count(body, 'class="row-lb"'), 0);
  });

  it("guild-scoped: guild A board never shows the guild-B-only user", async () => {
    const { body } = await hit(`${BOARD}?size=100`, { key: "staff" });
    assert.ok(!body.includes(B_ONLY), "no cross-guild rows");
  });
});

// ===========================================================================
// C. XP parity — same math as slash, XSS-safe names
// ===========================================================================
describe("leaderboard XP parity + escaping", () => {
  it("page xp sequence == repository topUsers xp sequence over the same DB (slash's source)", () => {
    const repo = api.topUsers(GUILD_A, 200); // slash /leaderboard's exact read
    const seen = [];
    for (let p = 1; p <= 5; p += 1) {
      seen.push(...buildLeaderboardPage(GUILD_A, { page: p, size: 25 }).rows.map((r) => r.xp));
    }
    assert.equal(seen.length, repo.length);
    assert.deepEqual(seen, repo.map((r) => r.xp), "same order, same data (xp DESC)");
    const bag = (xs) => xs.slice().sort((a, b) => a - b);
    assert.deepEqual(bag(seen), bag(repo.map((r) => r.xp)), "multiset parity (no dupes/drops across pages)");
  });

  it("every level label == levelFromXp fixture math (factor 100 default)", () => {
    const settings = api.getGuildSettings(GUILD_A);
    const board = buildLeaderboardPage(GUILD_A, { page: 1, size: 100 });
    for (const row of board.rows) {
      assert.equal(row.level, levelFromXp(row.xp, settings.level_xp_factor), `level for xp ${row.xp}`);
    }
    assert.equal(board.rows[0].level, 10, "xp 10000 → level 10");
    assert.equal(levelFromXp(1234, 100), 3, "xp 1234 → level 3 (users.test fixture)");
  });

  it("member names from the bot cache render; misses fall back to `User <id>` (slash parity)", async () => {
    const { body } = await hit(BOARD, { key: "staff" });
    assert.ok(body.includes("Midnight Snake"), "cached displayName shown");
    assert.ok(body.includes("User " + LB_RICH), "cache-miss fallback like slash buildLeaderboardPagePayload");
  });

  it("XSS: hostile display name is escaped in every position", async () => {
    const { res, body } = await hit(BOARD, { key: "staff" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("&lt;img"), "escaped echo present");
    assert.ok(!body.includes("<img"), "raw markup never rendered");
    assert.ok(!body.includes('"><svg'), "attribute breakout impossible");
    assert.ok(body.includes("&gt;nick"), "full name escaped");
  });
});

// ===========================================================================
// D. Per-user XP page — rank/level/progress + honest 404s + history note
// ===========================================================================
describe("GET /g/:guildId/leaderboard/user/:userId", () => {
  it("LB_MID fixtures: rank #2 of 105 · level 3 · 334/700 · 48% · 366 to level 4", async () => {
    const { res, body } = await hit(userXp(LB_MID), { key: "staff" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("Rank #2 of 105"));
    assert.ok(body.includes("Midnight Snake"), "cached display name");
    assert.ok(body.includes("334/700 XP this level"), "levelProgress math (900→1600 span)");
    assert.ok(body.includes("48%"), "Math.round(334/700*100) = 48");
    assert.ok(body.includes("366 XP to level 4"), "1600 - 1234");
    assert.ok(body.includes("lb-bar-5"), "decile bucket class (0.477 → 5)");
    assert.ok(!body.includes("style="), "no inline style — CSP stays effective");
  });

  it("decile bucket helper maps progress → CSS class (no inline styles)", () => {
    assert.equal(barBucketClass(0), "lb-bar-0");
    assert.equal(barBucketClass(0.477), "lb-bar-5");
    assert.equal(barBucketClass(0.94), "lb-bar-9");
    assert.equal(barBucketClass(1), "lb-bar-10");
    assert.equal(barBucketClass("junk"), "lb-bar-0");
  });

  it("LB_RICH fixtures: rank #1 · level 10 · 0% · 2100 to level 11", async () => {
    const { body } = await hit(userXp(LB_RICH), { key: "staff" });
    assert.ok(body.includes("Rank #1 of 105"));
    assert.ok(body.includes("10000"));
    assert.ok(body.includes("0%"));
    assert.ok(body.includes("2100 XP to level 11"), "12100 - 10000");
    assert.ok(body.includes("lb-bar-0"));
  });

  it("tie users keep list-consistent ranks (TIE_A #50, TIE_B #51)", async () => {
    const a = await hit(userXp(TIE_A), { key: "staff" });
    assert.ok(a.body.includes("Rank #50 of 105"), "one ahead-tie counted, exact-id tie after");
    const b = await hit(userXp(TIE_B), { key: "staff" });
    assert.ok(b.body.includes("Rank #51 of 105"));
  });

  it("history limitation is stated honestly (no xp-history table exists → parity note)", async () => {
    const { body } = await hit(userXp(LB_MID), { key: "staff" });
    assert.ok(body.includes("XP history over time is not stored"));
    assert.ok(body.includes("same data slash /xp displays"));
  });

  it("XSS: hostile display name escaped on the per-user page too", async () => {
    const { res, body } = await hit(userXp(LB_XSS), { key: "staff" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("&lt;img"));
    assert.ok(!body.includes("<img"));
  });

  it("valid snowflake with NO XP row → friendly in-shell 404", async () => {
    const { res, body } = await hit(userXp(UNKNOWN_USER), { key: "staff" });
    assert.equal(res.status, 404);
    assert.match(body, /<!DOCTYPE html>/);
    assert.ok(body.includes("No XP row exists"), "explanatory message");
    assert.ok(body.includes(UNKNOWN_USER), "echoes only the validated digits");
  });

  it("guild-B-only user under guild A → in-shell 404, zero guild-B XP leak", async () => {
    const { res, body } = await hit(userXp(B_ONLY), { key: "senior" });
    assert.equal(res.status, 404);
    assert.ok(body.includes("No XP row exists"));
    assert.ok(!body.includes(String(B_XP)), "guild-B XP never visible under guild A");
  });

  it("garbage/short :userId → byte-generic 404 on both routes (never shell)", async () => {
    for (const junk of ["abc", "1234", "55-66", "%35%35"]) {
      for (const key of ["staff", "senior"]) {
        const { res, body } = await hit(userXp(junk), { key });
        assert.equal(res.status, 404, junk);
        assert.equal(body, "Not found", `${junk} via ${key}`);
      }
    }
  });
});

// ===========================================================================
// E. Read-only surface (§8.8 Phase 1)
// ===========================================================================
describe("read-only: no mutating verbs anywhere", async () => {
  for (const [label, path] of [
    ["board", BOARD],
    ["user", userXp(LB_MID)],
  ]) {
    it(`POST ${label} → 405 Method not allowed (methodGate)`, async () => {
      const { res, body } = await hit(path, { key: "admin", method: "POST" });
      assert.equal(res.status, 405);
      assert.equal(body, "Method not allowed");
    });
  }

  it("HEAD board → 200 with no body (shell pages are safe for HEAD)", async () => {
    const res = await fetch(`${suite.base}${BOARD}`, {
      method: "HEAD",
      headers: { cookie: `web_session=${suite.cookies.staff}` },
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });
});
