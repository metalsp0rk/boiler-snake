/**
 * Subtask 15 — web user pages (roadmap/web-admin.md §8.6 "Users" rows,
 * Phase 1 read-only). FULLY OFFLINE integration net over the REAL
 * createWebApp() mount (guildScope → requireTier → users routes): real
 * SQLite (loadDb), real session rows, fake Discord resolver + fake bot client
 * cache. node --test only.
 *
 * Suites:
 *  A. Profile access matrix: anon 302 · stranger/plain-member 404 ·
 *     cross-guild B id via guild A ⇒ 404 with NO guild-B data leak ·
 *     staff 200 WITHOUT any activity data (exact boundary: seeded channel ids,
 *     labels and totals are absent; slash-parity senior denial sentence is
 *     present) · senior/admin 200 WITH the senior summary;
 *  B. Activity route (Senior+): staff 403 "Forbidden" (in-guild wrong tier —
 *     same denial semantics as slash requireSeniorStaff), senior/admin 200
 *     with the /userinfo parity ranking, anon 302, stranger 404, window/page
 *     params normalized, categories rollup, member-known-without-DB-data;
 *  C. Search: staff+ only, XSS-escaped echo, guild scoping, 50-row cap on a
 *     60-match prefix, digit-guard no-scan path;
 *  D. 404 semantics: garbage/short :userId ⇒ byte-generic 404 · valid-but-
 *     unknown ⇒ friendly in-shell 404 · member-cache-known ⇒ 200;
 *  E. Boundedness: 105 seeded warnings/notes render EXACTLY 10 rows with
 *     offset paging ("showing 11–20 of 105");
 *  F. Read-only: POST on every users path 405s (methodGate) — no mutations.
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
const { SENIOR_DENIED_MESSAGE } = require("../src/web/views/users");

// Clearly-fake placeholder secret (AGENTS.md: never real-looking secrets).
const SESSION_SECRET = "test-u…-xyz";

const USER_ADMIN = "428190112345678901";
const USER_SENIOR = "428190112345678902";
const USER_STAFF = "428190112345678903";
const USER_PLAIN = "428190112345678904";

const GUILD_A = "100000000000000001";
const GUILD_B = "200000000000000002";

const ROLE_JUNIOR = "500000000000000011";
const ROLE_SENIOR = "500000000000000012";

/** Profile subject (rich data in GUILD_A). */
const SUBJECT = "555000000000000055";
/** Bulk-data subject (>LIST cap warnings + notes, guild A). */
const BULK = "555000000000000066";
/** Has XP ONLY in GUILD_B — cross-guild probe target. */
const B_SUBJECT = "555000000000000077";
const B_XP = 7331;
/** In the fake member cache only — NO DB footprint (memberKnown path). */
const KNOWN_MEMBER = "555000000000000088";
/** Valid snowflake with NO data anywhere — friendly-404 target. */
const UNKNOWN_USER = "999999999999999999";
/** Unrelated creator for ticket #2 (kept far from UNKNOWN_USER). */
const OTHER_CREATOR = "555000000000000099";

const CH_PUB = "770000000000000001";
const CH_SEC = "770000000000000002";

/** Cap mirrors the data layer (web user page list cap). */
const LIST_LIMIT = 10;
const SEARCH_LIMIT = 50;

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

  // ---- staff roles (guild A) ----------------------------------------------
  api.addStaffRole(GUILD_A, ROLE_JUNIOR, "junior");
  api.addStaffRole(GUILD_A, ROLE_SENIOR, "senior");

  // ---- subject data (guild A) ----------------------------------------------
  api.addXp(GUILD_A, SUBJECT, 1234); // level = floor(sqrt(1234/100)) = 3
  for (let i = 0; i < 12; i += 1) {
    api.createWarning({
      guildId: GUILD_A,
      userId: SUBJECT,
      issuerId: USER_ADMIN,
      reason: `spam incident ${i}`,
    });
  }
  api.voidWarning(GUILD_A, 12, { voidedBy: USER_ADMIN, voidReason: "appeal upheld" });
  for (let i = 0; i < 3; i += 1) {
    api.createStaffNote({
      guildId: GUILD_A,
      userId: SUBJECT,
      authorId: USER_SENIOR,
      content: `pattern note ${i}`,
    });
  }

  // Tickets: #1 created BY the subject, #2 subject added as member.
  api.createTicket({
    guildId: GUILD_A,
    creatorUserId: SUBJECT,
    channelId: "880000000000000001",
    reason: "broken role",
  });
  const t2 = api.createTicket({
    guildId: GUILD_A,
    creatorUserId: OTHER_CREATOR,
    channelId: "880000000000000002",
    reason: "report about subject",
  });
  api.addTicketMember(t2.id, SUBJECT, USER_STAFF);

  // Activity daily counters: 7 recent days × 3 on #general (21) + one old
  // day (60d ago) × 3 + 2 on #staff-only → lifetime 26, 7-day window 23.
  const recentDay = api.utcDayKey();
  const oldDay = api.utcDayKeyDaysAgo(60);
  for (let d = 0; d < 7; d += 1) {
    const day = api.utcDayKeyDaysAgo(d);
    api.incrementDaily(GUILD_A, SUBJECT, CH_PUB, day, 3);
  }
  api.incrementDaily(GUILD_A, SUBJECT, CH_PUB, oldDay, 3);
  api.incrementDaily(GUILD_A, SUBJECT, CH_SEC, recentDay, 2);
  api.upsertUserActivityMeta(GUILD_A, SUBJECT, {
    tracking_since_ms: Date.now() - 90 * 86400000,
    backfill_status: "done",
  });

  // ---- bulk subject (cap probes) -------------------------------------------
  api.addXp(GUILD_A, BULK, 42); // tracked (searchable) + cap data below
  for (let i = 0; i < 105; i += 1) {
    api.createWarning({
      guildId: GUILD_A,
      userId: BULK,
      issuerId: USER_ADMIN,
      reason: `bulk warning ${i}`,
    });
    api.createStaffNote({
      guildId: GUILD_A,
      userId: BULK,
      authorId: USER_ADMIN,
      content: `bulk note ${i}`,
    });
  }

  // ---- guild-B-only user (cross-guild probe) --------------------------------
  api.addXp(GUILD_B, B_SUBJECT, B_XP);

  // ---- search-cap seed: 60 users sharing a digit prefix in guild A ----------
  for (let i = 0; i < 60; i += 1) {
    api.addXp(GUILD_A, `9${String(i).padStart(17, "0")}`, i);
  }

  // ---- fake Discord (resolver) ----------------------------------------------
  const fakeDiscord = {
    async getUserGuilds(token) {
      const userId = String(token).replace(/^tok-/, "");
      if ([USER_ADMIN, USER_SENIOR, USER_STAFF, USER_PLAIN].includes(userId)) {
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
      if (guildId === GUILD_A) {
        if (userId === USER_STAFF) return { roles: [ROLE_JUNIOR] };
        if (userId === USER_SENIOR) return { roles: [ROLE_SENIOR] };
        return { roles: [] };
      }
      const err = new Error("Unknown Guild");
      err.status = 404;
      throw err;
    },
  };

  const resolver = createGuildAccessResolver({
    discord: fakeDiscord,
    botGuilds: async () => [GUILD_A], // bot ONLY in guild A
    now: Date.now,
    ttlMs: 60_000,
  });

  // ---- fake bot client cache (labels + join dates for the Activity tab) ----
  const fakeGuild = {
    channels: {
      cache: new Map([
        [CH_PUB, { id: CH_PUB, name: "general", parentId: null, type: 0, isThread: () => false }],
        [CH_SEC, { id: CH_SEC, name: "staff-only", parentId: null, type: 0, isThread: () => false }],
      ]),
    },
    members: {
      cache: new Map([
        [SUBJECT, { joinedTimestamp: Date.now() - 30 * 86400000 }],
        [KNOWN_MEMBER, { joinedTimestamp: null }],
      ]),
    },
  };
  const fakeClient = { guilds: { cache: new Map([[GUILD_A, fakeGuild]]) } };

  // ---- real app + mount order (guildScope → users routes) -------------------
  const app = createWebApp({
    guildAccess: resolver,
    getClient: () => fakeClient,
  });
  suite.server = http.createServer(app);
  suite.server.listen(0, "127.0.0.1");
  await once(suite.server, "listening");
  suite.base = `http://127.0.0.1:${suite.server.address().port}`;

  suite.cookies = {};
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
      guildSnapshot: JSON.stringify([
        {
          id: GUILD_A,
          name: "A",
          icon: null,
          owner: userId === USER_ADMIN,
          permissions: userId === USER_ADMIN ? "0" : "104324673",
        },
      ]),
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

// ===========================================================================
// A. Profile route — access matrix + exact senior boundary
// ===========================================================================
describe("GET /g/:guildId/users/:userId — unified profile", () => {
  const url = `/g/${GUILD_A}/users/${SUBJECT}`;

  it("anonymous → 302 login redirect (guildScope contract)", async () => {
    const { res } = await hit(url);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `/auth/login?guild=${GUILD_A}`);
  });

  it("in-guild member WITHOUT staff role → generic 404 (never 403)", async () => {
    const { res, body } = await hit(url, { key: "plain" });
    assert.equal(res.status, 404);
    assert.equal(body, "Not found");
  });

  it("stranger session (unknown guild) → generic 404", async () => {
    // USER_PLAIN's list contains only guild A; probe guild B directly.
    const { res, body } = await hit(`/g/${GUILD_B}/users/${SUBJECT}`, { key: "staff" });
    assert.equal(res.status, 404);
    assert.equal(body, "Not found");
  });

  it("staff sees the FULL profile (identity, XP/level, warnings incl. voided, notes, tickets)", async () => {
    const { res, body } = await hit(url, { key: "staff" });
    assert.equal(res.status, 200);
    assert.match(body, /<!DOCTYPE html>/);
    assert.ok(body.includes(SUBJECT), "identity id shown");
    assert.ok(body.includes("1234"), "XP shown");
    assert.ok(body.includes("W-1"), "warning ref shown");
    assert.ok(body.includes("voided"), "voided state shown (parity with /warn list)");
    assert.ok(body.includes("N-1"), "note ref shown");
    assert.ok(body.includes("broken role"), "ticket reason shown");
    assert.ok(body.includes("creator"), "ticket role column shown");
    // 12 warnings → capped at 10 + pager truth
    assert.equal(count(body, '<tr class="row-warn"'), LIST_LIMIT);
    assert.ok(body.includes("showing 1–10 of 12"), "bounded pager reflects real total");
    assert.equal(count(body, '<li class="row-note"'), 3);
  });

  it("staff sees NO activity data — the senior boundary is exact", async () => {
    const { res, body } = await hit(url, { key: "staff" });
    assert.equal(res.status, 200);
    // No channel ids, labels, ranking table, or activity totals — at all:
    assert.ok(!body.includes(CH_PUB), "channel id must not leak");
    assert.ok(!body.includes(CH_SEC), "channel id must not leak");
    assert.ok(!body.includes("#general"), "channel label must not leak");
    assert.ok(!body.includes("row-activity"), "ranking rows must not render");
    assert.ok(!body.includes("26 posts"), "lifetime total must not render");
    assert.ok(!body.includes("Open Activity tab"), "no deep-link for lower tier");
    // …instead the SAME denial wording family as the slash requireSeniorStaff:
    assert.ok(body.includes("Activity requires senior staff"), "slash-parity denial shown");
    assert.ok(body.includes(SENIOR_DENIED_MESSAGE), "exact message constant rendered");
  });

  it("senior sees the Activity summary (slash Activity data set, senior-gated)", async () => {
    const { res, body } = await hit(url, { key: "senior" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("26 posts"), "lifetime total (21+3+2 = 26)");
    assert.ok(body.includes("Open Activity tab"), "deep link for senior");
    assert.ok(body.includes("Backfill"), "meta backfill status surfaced like slash footer");
  });

  it("admin (owner snapshot) also sees Activity (tier ladder)", async () => {
    const { res, body } = await hit(url, { key: "admin" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("26 posts"));
  });

  it("offset paging: w_off=10 renders the second warnings page", async () => {
    const { res, body } = await hit(`${url}?w_off=10`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("showing 11–12 of 12"), "page 2 of 12 warnings");
    assert.equal(count(body, '<tr class="row-warn"'), 2);
  });
});

// ===========================================================================
// B. Activity route — Senior+ only (§8.6 row + slash gate mirror)
// ===========================================================================
describe("GET /g/:guildId/users/:userId/activity — Senior-only", () => {
  const url = `/g/${GUILD_A}/users/${SUBJECT}/activity`;

  it("anonymous → 302 login", async () => {
    const { res } = await hit(url);
    assert.equal(res.status, 302);
  });

  it("plain member → generic 404 (no enumeration)", async () => {
    const { res, body } = await hit(url, { key: "plain" });
    assert.equal(res.status, 404);
    assert.equal(body, "Not found");
  });

  it("staff (junior staff-role) → 403 Forbidden — wrong-tier in-guild ⇒ denial, like slash", async () => {
    const { res, body } = await hit(url, { key: "staff" });
    assert.equal(res.status, 403, "§8.6: right guild, insufficient tier ⇒ 403");
    assert.equal(body, "Forbidden");
    assert.ok(!body.includes(CH_PUB), "no activity data in a denial");
  });

  it("senior gets the full /userinfo Activity parity set", async () => {
    const { res, body } = await hit(url, { key: "senior" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("Activity · Channels · All time"), "slash title parity");
    assert.ok(body.includes("#general"), "channel LABEL from bot cache (slash parity)");
    assert.ok(body.includes("#staff-only"), "second channel ranked");
    assert.ok(body.includes("<dd>26</dd>"), "lifetime total");
    assert.ok(body.includes("<dd>23</dd>") === false, "all-time window is 26, not 23");
    assert.equal(count(body, '<tr class="row-activity"'), 2, "both channels ranked");
    assert.ok(body.includes("backfill: done") || body.includes("<dd>done</dd>"), "backfill status");
    assert.ok(body.includes("weeks since join"), "all-time rate methodology note (slash footer)");
  });

  it("window param mirrors slash windows: ?win=7 → window total 23 (old day excluded)", async () => {
    const { res, body } = await hit(`${url}?win=7`, { key: "senior" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("Last 7 days"), "window label parity");
    assert.ok(body.includes("<dd>23</dd>"), "7-day window total");
    assert.ok(body.includes("<dd>26</dd>"), "lifetime unchanged");
    assert.ok(body.includes("in window"), "rate methodology switches to per-window");
  });

  it("junk window/page params normalize (never echoed raw, never 500)", async () => {
    const { res, body } = await hit(`${url}?win=99<script>&page=zz`, { key: "senior" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("All time"), "normalizeWindow fallback");
    assert.ok(!body.includes("<script>"), "junk never echoes unescaped");
  });

  it("categories page (?page=ca) rolls up like slash buildCategoryRanking", async () => {
    const { res, body } = await hit(`${url}?page=ca`, { key: "senior" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("Categories"));
    assert.ok(body.includes("Uncategorized"), "null-category rollup label parity");
    assert.equal(count(body, '<tr class="row-activity"'), 1);
  });

  it("member-known-without-DB-data → empty ranking (not 404) — slash resolveUser parity", async () => {
    const { res, body } = await hit(`/g/${GUILD_A}/users/${KNOWN_MEMBER}/activity`, { key: "senior" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("No tracked messages yet"));
  });
});

// ===========================================================================
// C. Search page
// ===========================================================================
describe("GET /g/:guildId/users?q= — search (staff+)", () => {
  const base = `/g/${GUILD_A}/users`;

  it("anon 302 · plain 404 · staff 200", async () => {
    assert.equal((await hit(base)).res.status, 302);
    const plain = await hit(base, { key: "plain" });
    assert.equal(plain.res.status, 404);
    const staff = await hit(base, { key: "staff" });
    assert.equal(staff.res.status, 200);
    assert.ok(staff.body.includes('name="q"'));
  });

  it("XSS: markup in q is escaped in every echo position (html`` contract)", async () => {
    const { res, body } = await hit(`${base}?q=${encodeURIComponent('"><svg onload=EVIL>')}`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.ok(!body.includes('"><svg'), "attribute-position quote breakout impossible");
    assert.ok(!body.includes("<svg onload=EVIL>"), "no raw markup echo");
    assert.ok(body.includes("&lt;svg"), "escaped echo instead");
  });

  it("digit prefix finds tracked guild-A users only (never guild-B rows)", async () => {
    const { body } = await hit(`${base}?q=555`, { key: "staff" });
    assert.ok(body.includes(SUBJECT));
    assert.ok(body.includes(BULK));
    assert.ok(!body.includes(B_SUBJECT), "guild-scoped: guild-B user absent");
  });

  it("60 prefix matches render ≤50 rows (hard search cap)", async () => {
    const { body } = await hit(`${base}?q=90`, { key: "staff" });
    const rows = count(body, '<tr class="row-user"');
    assert.ok(rows > 0 && rows <= SEARCH_LIMIT, `rows=${rows} within cap`);
    assert.equal(rows, SEARCH_LIMIT, "cap reached exactly on a 60-match prefix");
  });

  it("non-digit query short-circuits to no-results (no-scan guard)", async () => {
    const { body } = await hit(`${base}?q=nobody`, { key: "staff" });
    assert.ok(body.includes("No tracked users match"));
    assert.equal(count(body, '<tr class="row-user"'), 0);
  });
});

// ===========================================================================
// D. 404 semantics
// ===========================================================================
describe("404 semantics", () => {
  it("garbage/short :userId → byte-generic 404 (never shell, never enumerated)", async () => {
    for (const junk of ["abc", "1234", "55-66", "%35%35"]) {
      for (const key of ["staff", "senior"]) {
        const { res, body } = await hit(`/g/${GUILD_A}/users/${junk}`, { key });
        assert.equal(res.status, 404, junk);
        assert.equal(body, "Not found", `${junk} via ${key}`);
      }
    }
  });

  it("garbage :userId on the senior activity route → byte-generic 404 too", async () => {
    const { res, body } = await hit(`/g/${GUILD_A}/users/oops/activity`, { key: "senior" });
    assert.equal(res.status, 404);
    assert.equal(body, "Not found");
  });

  it("valid snowflake with NO footprint → friendly in-shell 404 (staff sees the explanation)", async () => {
    const { res, body } = await hit(`/g/${GUILD_A}/users/${UNKNOWN_USER}`, { key: "staff" });
    assert.equal(res.status, 404);
    assert.match(body, /<!DOCTYPE html>/);
    assert.ok(body.includes("No bot data exists"), "friendly message");
    assert.ok(body.includes(UNKNOWN_USER), "echoes only the validated digits");
  });

  it("guild-B user via guild A → 404 AND zero guild-B XP leakage (no cross-guild join)", async () => {
    const { res, body } = await hit(`/g/${GUILD_A}/users/${B_SUBJECT}`, { key: "senior" });
    assert.equal(res.status, 404);
    assert.ok(body.includes("No bot data exists"));
    assert.ok(!body.includes(String(B_XP)), "guild-B XP never visible under guild A");
  });

  it("member-cache-known user without DB rows → 200 profile marked untracked", async () => {
    const { res, body } = await hit(`/g/${GUILD_A}/users/${KNOWN_MEMBER}`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("no XP row yet"), "explicit untracked marker instead of fake zeros");
  });
});

// ===========================================================================
// E. Boundedness under data pressure (§8.6 query budget)
// ===========================================================================
describe("bounded rendering under 105-row pressure", () => {
  it("105 warnings + 105 notes render exactly the 10-row caps", async () => {
    const { res, body } = await hit(`/g/${GUILD_A}/users/${BULK}`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.equal(count(body, '<tr class="row-warn"'), LIST_LIMIT);
    assert.equal(count(body, '<li class="row-note"'), LIST_LIMIT);
    assert.ok(body.includes("showing 1–10 of 105"), "honest totals above the cap");
  });

  it("deep offsets clamp and stay bounded", async () => {
    const { res, body } = await hit(`/g/${GUILD_A}/users/${BULK}?w_off=100`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.equal(count(body, '<tr class="row-warn"'), 5, "tail page 101–105");
    assert.ok(body.includes("showing 101–105 of 105"));
    // Absurd offset clamps to MAX_OFFSET (no crash, still bounded)
    const absurd = await hit(`/g/${GUILD_A}/users/${BULK}?w_off=999999999`, { key: "staff" });
    assert.equal(absurd.res.status, 200);
    assert.equal(count(absurd.body, '<tr class="row-warn"'), 0);
  });
});

// ===========================================================================
// F. Read-only surface (§8.8 Phase 1)
// ===========================================================================
describe("read-only: no mutating verbs anywhere", async () => {
  for (const [label, path] of [
    ["search", `/g/${GUILD_A}/users`],
    ["profile", `/g/${GUILD_A}/users/${SUBJECT}`],
    ["activity", `/g/${GUILD_A}/users/${SUBJECT}/activity`],
  ]) {
    it(`POST ${label} → 405 Method not allowed (methodGate)`, async () => {
      const { res, body } = await hit(path, { key: "admin", method: "POST" });
      assert.equal(res.status, 405);
      assert.equal(body, "Method not allowed");
    });
  }

  it("HEAD profile → 200 with no body (shell pages are safe for HEAD)", async () => {
    const res = await fetch(`${suite.base}/g/${GUILD_A}/users/${SUBJECT}`, {
      method: "HEAD",
      headers: { cookie: `web_session=${suite.cookies.staff}` },
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });
});
