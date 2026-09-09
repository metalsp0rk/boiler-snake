/**
 * Subtask 23 — PHASE 1 ACCEPTANCE GATE (roadmap/web-admin.md §8.8 Phase 1
 * exit: "access matrix passes at scale, query-budget checks pass on seeded
 * DB (10k users/messages), audit viewer tested"; §8.6 tier table + query
 * budget — both review-blocking).
 *
 * Fully offline (program-gate pattern of §8.11, same boot discipline as
 * test/web-access-matrix-0c.test.js): REAL createWebApp on a REAL Express
 * server + REAL SQLite temp DB via loadDb(), seeded to Phase-1 scale by
 * test/helpers/seed-10k.js (10k users, ≥10k message/activity rows, 5k+5k
 * warnings/notes, 2k archived + 60 open tickets, 2k audit rows, integrations
 * config). Discord is the fake-transport seam under the REAL
 * createGuildAccessResolver; sessions are minted offline.
 *
 * Suites (run order MATTERS — the budget pass must hit COLD data caches):
 *  A. FIXTURE SCALE — the seeded DB really is ≥10k-scale (the budget
 *     numbers are meaningless otherwise).
 *  B. QUERY BUDGET + STATEMENT SCOPE — every Phase-1 page, admin viewer,
 *     COLD vs WARM request: per-request SQLite statement capture (the
 *     api.db.prepare tap) with (a) a scope scan — no SELECT against a
 *     guild-scoped table may omit a guild_id predicate (the transcript
 *     surface runs on a PINNED signature set instead — reviewed token-key
 *     point lookups); (b) a LIMIT scan — no read may fetch more than 100
 *     rows per statement (§8.6 "reads paginated (LIMIT ≤100)"); (c) wall
 *     time < 500 ms/page; (d) RATCHET PINS — the STATEMENT_PINS table caps
 *     per-page statement counts at the measured values (§8.6 "measured
 *     budget ceilings"), so any added per-request statement fails the gate.
 *  C. CACHE EFFECTIVENESS (§8.6 floor 30 s) — warm requests issue strictly
 *     fewer statements; a warm dashboard issues ZERO user_channel_message_
 *     daily / activity_log statements; the data modules' TTL constants stay
 *     ≥ the 30 s floor.
 *  D. ACCESS MATRIX @SCALE — every live /g GET route (live router
 *     enumeration — unmounted-phase drift fails the equality assert) ×
 *     viewer classes anon/stranger/plain-member/junior/senior/admin + the
 *     §8.4 transcript participants. Tier denials are the FIXED generic 403
 *     (helper expectForbidden), in-guild-unknown viewers get the generic
 *     404, bodies byte-exact.
 *  E. CROSS-GUILD PROBES @SCALE — guild B is served by the bot (positive
 *     control: B-staff resolves 200 on B), every guild-A session probe of
 *     /g/B/** and /t leakage is the generic 404; guild-B names/tokens never
 *     echo.
 *  F. AUDIT VIEWER @2k ROWS — pagination (n/o), origin filter, strict
 *     (created_at,id) DESC order, 100-row page cap, guild-B rows never
 *     render; the filtered/paged requests are themselves scope+LIMIT
 *     scanned.
 *  G. TRANSCRIPT SURFACE @SCALE — /t index over 2k+ archived rows (guild-
 *     scoped strict scan), the pinned transcript-signature set on a real
 *     open (participant classes open it too), unknown/foreign tokens are
 *     the generic 404.
 *  H. EXPLAIN QUERY PLAN — every statement captured by B/F/G re-planned on
 *     the 10k-scale DB: no bare SCAN of a large table (§8.11 acceptance).
 *  I. GATE REPORT — prints the per-page statement/timing table (§8.8
 *     evidence artifact) to stderr on every run.
 *
 * Locked contracts: helper outcomes are byte-exact (test/helpers/access-
 * matrix.js); statement capture wraps the single better-sqlite3 handle the
 * facade binds at require time — repos prepare per call, so every request
 * statement is recorded. Seeding happens with the recorder INACTIVE.
 * Runtime budget < 60 s: sessions must not mid-run touch (their throttled
 * UPDATE would skew pins); the whole file stays far under that.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// loadDb FIRST: fresh SQLite + src require-cache reset; every require below
// binds to that DB (0c boot discipline).
const { api, tmpDir } = loadDb();

const harness = require("./helpers/access-matrix");
const { seed10k, createRng, detUuid } = require("./helpers/seed-10k");
const { createGuildAccessResolver } = require("../src/web/auth/guildAccess");
const { createWebApp } = require("../src/web/app");
const sessionPolicy = require("../src/web/auth/sessions");
const tokens = require("../src/web/auth/tokens");
const { writeTranscriptFile, absoluteAssetsDir } = require("../src/features/tickets/transcript");
const dashboardData = require("../src/web/data/dashboardData");
const integrationsData = require("../src/web/data/integrationsData");
const voiceData = require("../src/web/data/voiceData");

// Clearly-fake sentinel only (AGENTS.md: never real-looking secrets).
const SESSION_SECRET = "test-gate1-sentinel-session-secret-NOT-REAL-023";

const GUILD_A = "100000000000000001";
const GUILD_B = "200000000000000002";
const GUILD_A_NAME = "GA-VISIBLE";
const GUILD_B_NAME = "GB-NEVER-ECHO"; // forbidden in every A-viewer body

const USER_ADMIN = "428190112345678901"; // owner snapshot ⇒ admin fast path
const USER_SENIOR = "428190112345678902";
const USER_JUNIOR = "428190112345678903";
const USER_PLAIN = "428190112345678904"; // guild-A member, no staff role
const USER_CREATOR = "428190112345678905"; // transcript participant (§8.4)
const USER_MEMBER = "428190112345678906"; // ticket_members row
const USER_TSTAFF = "428190112345678907"; // ticket_staff row
const USER_AUTHOR = "428190112345678908"; // ticket_messages.author_id
const USER_STRANGER = "428190112345678913"; // member of NOTHING
const USER_STAFFB = "428190112345678911"; // guild-B junior ONLY (control)
const USER_B_CREATOR = "428190112345678914"; // creator of the guild-B ticket
const USER_TRACKED = "900000000000000001"; // the seeded rich profile user

const ROLE_JUNIOR_A = "500000000000000011";
const ROLE_SENIOR_A = "500000000000000012";
const ROLE_STAFF_B = "500000000000000013";

const MARKER_A = "GATE1-MARKER-TRANSCRIPT-A-9c21";
const MARKER_B = "GATE1-MARKER-TRANSCRIPT-B-1d34";
const UNKNOWN_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"; // valid shape, no row

const ENV_KEYS = [
  "SESSION_SECRET",
  "CLIENT_SECRET",
  "PUBLIC_BASE_URL",
  "PUBLIC_HTTP_PORT",
  "TICKET_HTTP_PORT",
  "TICKET_PUBLIC_BASE_URL",
  "WEB_TIER_CACHE_TTL_MS",
];
let savedEnv;

// ---------------------------------------------------------------------------
// Fake Discord transport + role fixtures under the REAL resolver (0c pattern)
// ---------------------------------------------------------------------------

/** `${userId}:${guildId}` -> string[] role ids; missing entry ⇒ member 404. */
const memberFixture = {};
let fakeNow = 0; // resolver clock frozen ⇒ its caches never expire mid-run

const A_SIDE_USERS = new Set([USER_SENIOR, USER_JUNIOR, USER_PLAIN]);

function userOf(token) {
  return String(token).replace(/^tok-/, "");
}

const fakeDiscord = {
  async getUserGuilds(token) {
    const userId = userOf(token);
    if (userId === USER_ADMIN) {
      return [{ id: GUILD_A, name: GUILD_A_NAME, icon: null, owner: true, permissions: "0" }];
    }
    if (A_SIDE_USERS.has(userId)) {
      return [{ id: GUILD_A, name: GUILD_A_NAME, icon: null, owner: false, permissions: "0" }];
    }
    if (userId === USER_STAFFB) {
      return [{ id: GUILD_B, name: GUILD_B_NAME, icon: null, owner: false, permissions: "0" }];
    }
    return []; // participants + stranger: member of NOTHING (§8.4 readers)
  },
  async getUserGuildMember(token, guildId) {
    const roles = memberFixture[`${userOf(token)}:${guildId}`];
    if (!roles) {
      const err = new Error("Unknown Guild");
      err.status = 404;
      throw err;
    }
    return { roles: [...roles] };
  },
};

// ---------------------------------------------------------------------------
// Per-request SQLite statement capture (§8.6 query-budget proof machinery)
//
// The repositories prepare statements PER CALL on the ONE better-sqlite3
// handle the facade binds (`api.db`) — so wrapping db.prepare intercepts
// every request-path statement. The returned Proxy records (sql, args) on
// all/get/run/iterate and forwards everything else untouched; the recorder
// is only active around ONE request at a time (tests are sequential, so
// attribution is exact). Seeding runs with the recorder INACTIVE.
// ---------------------------------------------------------------------------

function installStatementTap(db) {
  const realPrepare = db.prepare.bind(db);
  const state = { active: false, recs: [] };

  function wrap(stmt, sql) {
    return new Proxy(stmt, {
      get(target, prop) {
        if (prop === "all" || prop === "get" || prop === "run" || prop === "iterate") {
          return (...args) => {
            if (state.active) state.recs.push({ sql, args });
            return target[prop](...args);
          };
        }
        if (prop === "bind" || prop === "pluck" || prop === "raw" || prop === "safeIntegers") {
          return (...args) => wrap(target[prop](...args), sql);
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  db.prepare = function prepared(sql) {
    return wrap(realPrepare(sql), String(sql));
  };

  return {
    start() {
      state.recs = [];
      state.active = true;
    },
    stop() {
      state.active = false;
      return state.recs.slice();
    },
    restore() {
      state.active = false;
      db.prepare = realPrepare;
    },
  };
}

const tap = installStatementTap(api.db);

/** One request under the recorder: response + wall ms + recorded statements.
 *  Every recorded statement also feeds CAPTURED for the EXPLAIN suite. */
const CAPTURED = [];
async function measure(url, cookieId) {
  tap.start();
  const t0 = process.hrtime.bigint();
  const res = await harness.request(base, url, { cookieId: cookieId ?? null });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const recs = tap.stop();
  CAPTURED.push(...recs);
  return { res, ms, recs };
}

// ---------------------------------------------------------------------------
// Statement scanners: guild-scope rule + LIMIT ceiling (§8.6, both
// review-blocking). Pure functions so B/F/G share one implementation.
// ---------------------------------------------------------------------------

/** Every table that CARRIES guild_id (schema-verified in src/db/migrations)
 *  — a SELECT touching one of these without "guild_id" in its text is a
 *  scoping bug (cross-guild read) unless explicitly reviewed below. */
const GUILD_SCOPED_TABLES = new Set([
  "users",
  "warnings",
  "staff_notes",
  "tickets",
  "admin_audit",
  "user_channel_message_daily",
  "activity_log",
  "voice_sessions",
  "guild_settings",
  "staff_roles",
  "allowed_command_channels",
  "level_roles",
  "youtube_channels",
  "twitch_channels",
  "reaction_role_panels",
  "reaction_role_options",
  "event_reminder_configs",
  "honeypot_channels",
  "honeypot_ban_roles",
  "activity_ignore",
  "user_activity_meta",
  "guild_activity_settings",
]);

/** §8.6: "reads paginated (LIMIT ≤100)" — the dashboard already caps list
 *  reads at 50 and audit at MAX 100; 100 is the ratchet ceiling. */
const MAX_STATEMENT_LIMIT = 100;

/** §8.8 Phase-1 scale target: "p95 < 500 ms/page" — every gate request must
 *  stay under it (single-user offline worst case here is far below). */
const WALL_BUDGET_MS = 500;

/**
 * Reviewed transcript-surface statements on guild-scoped tables WITHOUT a
 * guild_id predicate: the token-key ticket point lookup (§8.4 — the row's
 * OWN guild column decides access; the token is the unguessable capability).
 * Pinned on the FULL normalized shape: a NEW statement shape on the
 * transcript surface fails and must be reviewed here explicitly.
 */
const TRANSCRIPT_REVIEWED = [
  /^select \* from tickets where transcript_token=\?$/,
];

function normalizeSql(sql) {
  return sql.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Scope rule: every recorded SELECT against a guild-scoped table names
 *  guild_id, except a TRANSCRIPT_REVIEWED pinned shape (pass `reviewed`
 *  only for the transcript surface; pages run STRICT). */
function scopeProblems(recs, reviewed = []) {
  const problems = [];
  for (const rec of recs) {
    const norm = normalizeSql(rec.sql);
    if (!norm.startsWith("select")) continue; // DML/DDL/PRAGMA out of scope
    const tables = [...norm.matchAll(/\b(?:from|join)\s+([a-z0-9_]+)/g)].map((m) => m[1]);
    for (const table of tables) {
      if (!GUILD_SCOPED_TABLES.has(table)) continue; // global tables (web_sessions,
      // sqlite_master, ticket_* keyed by ticket_id) carry no guild column.
      if (norm.includes("guild_id")) continue;
      if (reviewed.some((re) => re.test(norm))) continue;
      problems.push(`unscoped SELECT on "${table}": ${norm.slice(0, 180)}`);
    }
  }
  return problems;
}

/** LIMIT rule: literal `LIMIT n` and positional `LIMIT ?` (resolved through
 *  the bound args, e.g. the IN(...) allow-list offset by its placeholders)
 *  must never exceed 100. */
function limitProblems(recs) {
  const problems = [];
  for (const rec of recs) {
    const sql = rec.sql;
    let m;
    const literal = /\blimit\s+(\d+)/gi;
    while ((m = literal.exec(sql)) !== null) {
      if (Number(m[1]) > MAX_STATEMENT_LIMIT) problems.push(`literal LIMIT ${m[1]} in ${sql.slice(0, 120)}`);
    }
    const param = /\blimit\s+\?/gi;
    while ((m = param.exec(sql)) !== null) {
      const before = (sql.slice(0, m.index).match(/\?/g) || []).length;
      const value = Number(rec.args[before]);
      if (Number.isFinite(value) && value > MAX_STATEMENT_LIMIT) {
        problems.push(`LIMIT ? bound to ${value} in ${sql.slice(0, 120)}`);
      }
    }
  }
  return problems;
}

/** Run the full per-request statement review (scope + LIMIT). */
function assertStatements(label, recs, reviewed = []) {
  const problems = [...scopeProblems(recs, reviewed), ...limitProblems(recs)];
  assert.deepEqual(problems, [], `${label}: statement scope/LIMIT review (§8.6)`);
}

// ---------------------------------------------------------------------------
// Route map — Phase 1 surface (tiers verified against the route files,
// headings against renderShellPage callers). Suite D asserts the live router
// enumeration equals this set, so drift is loud, never silent.
// ---------------------------------------------------------------------------

const PAGES = [
  { path: "/g/:guildId", tier: "staff", marker: "<h1>Dashboard" },
  { path: "/g/:guildId/users", tier: "staff", marker: "<h1>Users" },
  { path: "/g/:guildId/users/:userId", tier: "staff", marker: "<h1>User profile" },
  { path: "/g/:guildId/users/:userId/activity", tier: "senior", marker: "<h1>User profile" },
  { path: "/g/:guildId/warnings", tier: "staff", marker: "<h1>Warnings" },
  { path: "/g/:guildId/notes", tier: "staff", marker: "<h1>Staff notes" },
  { path: "/g/:guildId/settings", tier: "staff", marker: "<h1>Settings" },
  { path: "/g/:guildId/leaderboard", tier: "staff", marker: "<h1>XP leaderboard" },
  { path: "/g/:guildId/leaderboard/user/:userId", tier: "staff", marker: "<h1>User XP" },
  { path: "/g/:guildId/staff", tier: "staff", marker: "<h1>Staff roles" },
  { path: "/g/:guildId/commands", tier: "staff", marker: "<h1>Command visibility" },
  { path: "/g/:guildId/integrations", tier: "staff", marker: "<h1>Integrations" },
  { path: "/g/:guildId/voice", tier: "staff", marker: "<h1>Voice" },
  { path: "/g/:guildId/system", tier: "admin", marker: "<h1>System" },
  { path: "/g/:guildId/audit", tier: "admin", marker: "<h1>Audit log" },
  // Phase 3 (subtask 28): admin-only grant-XP form page (§8.6 XP row is the
  // staff READ surface; the GRANT action is the ADMIN mutate — /grantxp twin,
  // AGENTS.md §4 ManageGuild-only). Live router enumeration must see it.
  { path: "/g/:guildId/xp/grant", tier: "admin", marker: "<h1>Grant XP" },
  // Phase 3 (subtask 30): senior-only ticket ACTIONS page (§8.6 Tickets row
  // "Senior: claim/close/summary regen"). Hosts the three POST forms; the
  // one data read is the bounded listOpenTickets (LIMIT ≤50). Junior keeps
  // the untouched Phase-0c READ surfaces; this page is the documented §8.6
  // senior tighten (requireTier("senior") — outcomeFor's ladder proves it).
  { path: "/g/:guildId/tickets", tier: "senior", marker: "<h1>Ticket actions" },
];

/** Pages whose data module caches per guild (§8.6 floor 30 s) — on these,
 *  req2 must be STRICTLY cheaper than req1 (cache proof, not luck). */
const CACHED_PAGES = new Set([
  "/g/:guildId",
  "/g/:guildId/settings",
  "/g/:guildId/integrations",
  "/g/:guildId/voice",
]);

/**
 * RATCHET PINS (§8.6 "measured budget ceilings"): per-page statement counts
 * for the admin viewer, measured on THIS fixture. req2 may never exceed
 * req1's pin; req1 is capped at the measured value (any NEW per-request
 * statement trips the gate). Regenerate deliberately:
 *   GATE_MEASURE=1 node --test test/web-phase1-gate.test.js
 * and paste the printed table back in.
 */
const GATE_MEASURE = process.env.GATE_MEASURE === "1";
/**
 * MEASURED ceilings (GATE_MEASURE run on this exact fixture, admin viewer).
 * users/:userId + activity run 98/89 statements — an N+1 in the profile/
 * activity DATA layer (per-day and per-ticket loops); recorded as a
 * must-improve finding in the subtask-23 report. The pin is the RATCHET:
 * counts may only go DOWN from here.
 */
const STATEMENT_PINS = {
  // pin keyed by ROUTE PATTERN (matches BUDGET_URLS labels): { req1, req2 }
  "/g/:guildId": { req1: 11, req2: 3 },
  "/g/:guildId/users": { req1: 4, req2: 4 },
  "/g/:guildId/users/:userId": { req1: 98, req2: 98 },
  "/g/:guildId/users/:userId/activity": { req1: 89, req2: 89 },
  "/g/:guildId/warnings": { req1: 6, req2: 6 },
  "/g/:guildId/notes": { req1: 6, req2: 6 },
  "/g/:guildId/settings": { req1: 8, req2: 4 },
  "/g/:guildId/leaderboard": { req1: 8, req2: 8 },
  "/g/:guildId/leaderboard/user/:userId": { req1: 9, req2: 9 },
  // 6 → 7 (Phase 2, subtask 25): /staff gained EXACTLY ONE bounded per-guild
  // config read — listLevelRoles(guildId), the level→role mapping table the
  // staff page now lists and the /staff/levelrole/* forms mutate. Indexed
  // guild_id point-range read (same shape as the existing listStaffRoles),
  // no cache added (config must never render stale). Deliberate ratchet
  // update per the GATE_MEASURE regeneration procedure above.
  "/g/:guildId/staff": { req1: 7, req2: 7 },
  "/g/:guildId/commands": { req1: 5, req2: 5 },
  "/g/:guildId/integrations": { req1: 17, req2: 4 },
  "/g/:guildId/voice": { req1: 7, req2: 4 },
  "/g/:guildId/system": { req1: 5, req2: 5 },
  "/g/:guildId/audit": { req1: 6, req2: 6 },
  // Phase 3 (subtask 28): the grant FORM page reads NOTHING but the session/
  // tier plumbing (4 statements: session row, auth column, tier-resolution
  // reads — all guild_id-scoped; the POST's XP reads/writes run through the
  // awardXp service and are pinned by test/web-xp-grant.test.js, not the
  // budget sweep). Measured via GATE_MEASURE=1 on this fixture.
  "/g/:guildId/xp/grant": { req1: 4, req2: 4 },
  // Phase 3 (subtask 30): the ticket ACTIONS page adds EXACTLY ONE bounded
  // read on top of the session/tier plumbing — listOpenTickets(guildId,
  // {limit:50}), a guild_id+status indexed range read with a hard LIMIT
  // (the repo clamps ≤50). The three POST mutations run the pinned ticket
  // helpers, not budget-swept reads. Measured via GATE_MEASURE=1.
  "/g/:guildId/tickets": { req1: 5, req2: 5 },
  "/t": { req1: 5, req2: 5 },
};

/** Collected measurements for the end-of-run gate report (§8.8 evidence). */
const MEASURED = [];

// ---------------------------------------------------------------------------
// Suite-level fixtures
// ---------------------------------------------------------------------------

/** @type {import("http").Server} */
let server;
let base = "";
/** @type {import("express").Express} */
let app;

/** viewer key → cookie id (null = anonymous) */
const cookies = {};
/** seeded artifacts */
let seed = null;
let richA = null; // guild-A archived ticket WITH transcript file + asset
let richB = null; // guild-B archived ticket (cross-guild control)
let allSecrets = [];

const cookieOf = (key) => (key === "anon" ? null : cookies[key]);

before(async () => {
  savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
  process.env.SESSION_SECRET = SESSION_SECRET;
  for (const k of ENV_KEYS.slice(1)) delete process.env[k];
  fakeNow = Date.now();

  // REAL staff_roles rows (source of truth, uncached — §8.1-5).
  api.addStaffRole(GUILD_A, ROLE_JUNIOR_A, "junior");
  api.addStaffRole(GUILD_A, ROLE_SENIOR_A, "senior");
  api.addStaffRole(GUILD_B, ROLE_STAFF_B, "junior");

  memberFixture[`${USER_JUNIOR}:${GUILD_A}`] = [ROLE_JUNIOR_A];
  memberFixture[`${USER_SENIOR}:${GUILD_A}`] = [ROLE_SENIOR_A];
  memberFixture[`${USER_PLAIN}:${GUILD_A}`] = [];
  memberFixture[`${USER_STAFFB}:${GUILD_B}`] = [ROLE_STAFF_B];

  // Phase-1 scale fixture FIRST (recorder inactive ⇒ seeds never count).
  seed = seed10k(api, {
    guildId: GUILD_A,
    trackedUserId: USER_TRACKED,
    staffUserIds: [USER_ADMIN, USER_SENIOR, USER_JUNIOR],
    participantUserIds: [USER_MEMBER, USER_TSTAFF],
    baseMs: fakeNow,
  });

  const resolver = createGuildAccessResolver({
    discord: fakeDiscord,
    botGuilds: async () => [GUILD_A, GUILD_B],
    now: () => fakeNow,
    ttlMs: 60_000,
  });
  app = createWebApp({ guildAccess: resolver });
  server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;

  // --- sessions (offline mint, 0c pattern) ---------------------------------
  const sessionDeps = { api, sessionPolicy, tokens };
  const snapshotA = (userId) => [
    { id: GUILD_A, name: GUILD_A_NAME, icon: null, owner: userId === USER_ADMIN, permissions: "0" },
  ];
  const snapshotB = [
    { id: GUILD_B, name: GUILD_B_NAME, icon: null, owner: false, permissions: "0" },
  ];
  const seeding = [
    ["admin", USER_ADMIN],
    ["senior", USER_SENIOR],
    ["junior", USER_JUNIOR],
    ["plain", USER_PLAIN],
    ["creator", USER_CREATOR],
    ["member", USER_MEMBER],
    ["tstaff", USER_TSTAFF],
    ["author", USER_AUTHOR],
    ["stranger", USER_STRANGER],
    ["staffB", USER_STAFFB],
  ];
  for (const [key, userId] of seeding) {
    cookies[key] = harness.createLoginSession(sessionDeps, userId, {
      snapshotEntries: userId === USER_STAFFB ? snapshotB : snapshotA(userId),
    });
  }

  // --- rich tickets (REAL transcript files — participant matrix + /t) ------
  const seedDeps = { api, writeTranscriptFile, absoluteAssetsDir, fs, path, png: harness.PNG };
  richA = harness.seedArchivedTicket(seedDeps, {
    guildId: GUILD_A,
    creatorUserId: USER_CREATOR,
    channelId: "ch-gate1-a",
    reason: "gate1 ticket A",
    marker: MARKER_A,
    withAsset: true,
    assetName: "001_photo.png",
  });
  richB = harness.seedArchivedTicket(seedDeps, {
    guildId: GUILD_B,
    creatorUserId: USER_B_CREATOR,
    channelId: "ch-gate1-b",
    reason: "gate1 ticket B",
    marker: MARKER_B,
  });

  // §8.4 participant rows on ticket A (direct INSERT — schema per 010):
  // seedArchivedTicket already wrote ONE message authored by the CREATOR.
  api.db
    .prepare(
      `INSERT INTO ticket_members (ticket_id, user_id, added_at, added_by) VALUES (?, ?, ?, ?)`
    )
    .run(richA.ticket.id, USER_MEMBER, Date.now(), USER_CREATOR);
  api.db
    .prepare(
      `INSERT INTO ticket_staff (ticket_id, user_id, is_owner, added_at, added_by) VALUES (?, ?, 1, ?, ?)`
    )
    .run(richA.ticket.id, USER_TSTAFF, Date.now(), USER_ADMIN);
  api.db
    .prepare(
      `INSERT INTO ticket_messages (ticket_id, message_id, author_id, author_tag, content, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(richA.ticket.id, "msg-gate1-author", USER_AUTHOR, "author#0", MARKER_A, Date.now());

  allSecrets = [GUILD_B_NAME, richB.token, MARKER_B];
});

after(async () => {
  tap.restore();
  if (server) {
    server.closeAllConnections?.(); // undici keep-alive sockets (0c pattern)
    server.close();
    await once(server, "close");
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// URL helpers + outcome mapping
// ---------------------------------------------------------------------------

const concrete = (routePath, guildId) =>
  harness.buildConcretePath(routePath, { guildId, userId: USER_TRACKED });

/** Budget pass = every /g page (concrete, guild A) + the /t index. */
const BUDGET_URLS = [
  ...PAGES.map((p) => ({ label: p.path, url: concrete(p.path, GUILD_A) })),
  { label: "/t", url: "/t" },
];

function outcomeFor(viewerKey, page) {
  if (viewerKey === "anon") return harness.expectLoginRedirect(`/auth/login?guild=${GUILD_A}`);
  const noTier = new Set(["stranger", "plain", "creator", "member", "tstaff", "author"]);
  if (noTier.has(viewerKey)) {
    return harness.expectGenericNotFound({ forbid: allSecrets });
  }
  const rank = { junior: 1, senior: 2, admin: 3 }[viewerKey];
  const need = { staff: 1, senior: 2, admin: 3 }[page.tier];
  return rank >= need
    ? harness.expectShellOk(page.marker)
    : harness.expectForbidden();
}

// ---------------------------------------------------------------------------
// A. FIXTURE SCALE — the budget numbers are meaningless on a small DB
// ---------------------------------------------------------------------------

describe("A. fixture scale (10k users / ≥10k message rows)", () => {
  it("seeds the §8.8 Phase-1 scale deterministically", () => {
    assert.ok(seed.counts.users >= 10_000, `users: ${seed.counts.users}`);
    assert.ok(seed.counts.dailyRows >= 10_000, `daily rows: ${seed.counts.dailyRows}`);
    assert.ok(seed.counts.activityLog >= 10_000, `activity log: ${seed.counts.activityLog}`);
    assert.ok(seed.counts.warnings >= 5_000, `warnings: ${seed.counts.warnings}`);
    assert.ok(seed.counts.notes >= 5_000, `staff notes: ${seed.counts.notes}`);
    assert.ok(seed.counts.ticketsArchived >= 2_000, `archived: ${seed.counts.ticketsArchived}`);
    assert.ok(seed.counts.ticketsOpen > 50, `open (dashboard 50-cap must saturate): ${seed.counts.ticketsOpen}`);
    assert.ok(seed.counts.audit >= 2_000, `audit: ${seed.counts.audit}`);
    assert.equal(seed.counts.voiceSessions, 200);
    // determinism proof: the fixed-seed rng reproduces identical tokens
    // (the fixture is byte-stable run to run — required for the pins).
    assert.equal(detUuid(createRng()), detUuid(createRng()), "detUuid is seed-stable");
  });
});

// ---------------------------------------------------------------------------
// B. QUERY BUDGET + STATEMENT SCOPE (admin viewer; COLD then WARM)
// ---------------------------------------------------------------------------

async function runBudget() {
  const failures = [];
  for (const { label, url } of BUDGET_URLS) {
    const req1 = await measure(url, cookieOf("admin"));
    const req2 = await measure(url, cookieOf("admin"));

    assert.equal(req1.res.status, 200, `${label} (admin): page must render for admin`);
    assert.equal(req2.res.status, 200, `${label} (admin): warm re-render 200`);

    try {
      assertStatements(`${label} req1`, req1.recs); // STRICT scope (no reviewed)
      assertStatements(`${label} req2`, req2.recs);
    } catch (err) {
      failures.push(err.message);
      continue;
    }

    assert.ok(req1.ms < WALL_BUDGET_MS, `${label} cold wall ${req1.ms.toFixed(1)}ms < ${WALL_BUDGET_MS}ms`);
    assert.ok(req2.ms < WALL_BUDGET_MS, `${label} warm wall ${req2.ms.toFixed(1)}ms < ${WALL_BUDGET_MS}ms`);

    MEASURED.push({
      url: label,
      req1: req1.recs.length,
      req2: req2.recs.length,
      ms1: +req1.ms.toFixed(1),
      ms2: +req2.ms.toFixed(1),
    });

    if (CACHED_PAGES.has(label)) {
      assert.ok(
        req2.recs.length < req1.recs.length,
        `${label}: WARM must be strictly cheaper (30s data cache; ${req1.recs.length} → ${req2.recs.length})`
      );
    } else {
      assert.ok(
        req2.recs.length <= req1.recs.length,
        `${label}: warm must not read more than cold (${req2.recs.length} > ${req1.recs.length})`
      );
    }

    const pins = STATEMENT_PINS[label];
    assert.ok(pins, `${label}: no pin entry — add it deliberately (ratchet)`);
    if (!GATE_MEASURE) {
      assert.ok(
        req1.recs.length <= pins.req1,
        `${label} COLD statements ${req1.recs.length} exceed pin ${pins.req1} (§8.6 ratchet)`
      );
      assert.ok(
        req2.recs.length <= pins.req2,
        `${label} WARM statements ${req2.recs.length} exceed pin ${pins.req2} (§8.6 ratchet)`
      );
    }
  }
  assert.deepEqual(failures, [], "statement scope/LIMIT review (collected)");
}

describe("B. query budget + statement scope (§8.6)", () => {
  it("every page: scope-clean, LIMIT-bounded, wall < 500ms, cold/warm within pins", async () => {
    await runBudget();
  });
});

// ---------------------------------------------------------------------------
// C. CACHE EFFECTIVENESS (§8.6 floor 30 s)
// ---------------------------------------------------------------------------

describe("C. cache effectiveness", () => {
  it("warm dashboard issues ZERO activity-table statements", async () => {
    const url = concrete("/g/:guildId", GUILD_A);
    await measure(url, cookieOf("admin")); // guarantee a warm cache (no
    const warm = await measure(url, cookieOf("admin")); // timing assumptions)
    assert.equal(warm.res.status, 200);
    const offenders = warm.recs
      .map((r) => normalizeSql(r.sql))
      .filter((sql) => sql.includes("user_channel_message_daily") || sql.includes("activity_log"));
    assert.deepEqual(offenders, [], "dashboard cache hit must skip the activity reads (§8.6)");
  });

  it("data-module TTL constants honor the 30 s floor", () => {
    for (const mod of [dashboardData, integrationsData, voiceData]) {
      assert.ok(mod.DEFAULT_CACHE_TTL_MS >= 30_000, `TTL floor: ${mod.DEFAULT_CACHE_TTL_MS}`);
    }
  });
});

// ---------------------------------------------------------------------------
// D. ACCESS MATRIX @SCALE (live enumeration × tier table §8.6)
// ---------------------------------------------------------------------------

describe("D. access matrix at scale", () => {
  it("live /g route enumeration equals the mapped Phase-1 surface", () => {
    const live = harness.listGetRoutesUnder(app, "/g/").map((r) => r.path).sort();
    const mapped = PAGES.map((p) => p.path).sort();
    assert.deepEqual(live, mapped, "mounted /g GET routes drifted from the gate map — update deliberately");
  });

  it("viewer × page outcomes match the §8.6 tier table", async () => {
    const viewers = ["anon", "stranger", "plain", "creator", "member", "tstaff", "author", "junior", "senior", "admin"];
    for (const viewer of viewers) {
      for (const page of PAGES) {
        await harness.runOutcome({
          base,
          url: concrete(page.path, GUILD_A),
          cookieId: cookieOf(viewer),
          expect: outcomeFor(viewer, page),
          label: `[${viewer}]`,
        });
      }
    }
  });

  it("bad :userId is the generic 404; unknown-but-valid profile is a shell 404", async () => {
    const bad = await harness.request(base, `/g/${GUILD_A}/users/not-a-snowflake`, {
      cookieId: cookies.admin,
    });
    assert.equal(bad.status, 404, "malformed :userId must 404");
    assert.equal(bad.body, "Not found", "malformed :userId body is the generic 404");

    const ghost = await harness.request(base, `/g/${GUILD_A}/users/999999999999999999`, {
      cookieId: cookies.admin,
    });
    assert.equal(ghost.status, 404, "unknown profile user must 404");
    assert.ok(
      ghost.body.includes(harness.SHELL_MARKER) && ghost.body.includes("User not found"),
      "unknown profile renders the shell error page (not the plain-text 404)"
    );
  });
});

// ---------------------------------------------------------------------------
// E. CROSS-GUILD PROBES @SCALE (positive control: guild B is served)
// ---------------------------------------------------------------------------

describe("E. cross-guild probes at scale", () => {
  it("guild-A sessions never touch guild-B surfaces", async () => {
    const bProbes = [...PAGES.map((p) => concrete(p.path, GUILD_B)), `/t/${richB.token}`];
    for (const viewer of ["admin", "senior", "plain", "stranger"]) {
      for (const url of bProbes) {
        await harness.runOutcome({
          base,
          url,
          cookieId: cookieOf(viewer),
          expect: harness.expectGenericNotFound({
            forbid: [GUILD_B_NAME, richB.token, MARKER_B],
          }),
          label: `[${viewer}→B]`,
        });
      }
    }
    // control: guild A itself still serves the admin (the 404s above are
    // the cross-guild GATE, not a dead session — 0c pattern).
    const control = await harness.request(base, `/g/${GUILD_A}`, { cookieId: cookies.admin });
    assert.equal(control.status, 200, "session control: /g/A renders for admin");
  });

  it("positive control: guild-B staff resolves 200 on B and 403 on B-admin/SENIOR pages", async () => {
    // :userId pages are skipped here — guild B has no seeded profile rows
    // (a profile 404 on B would prove nothing); guild A's map coverage is
    // the matrix's job (suite D).
    // staffB holds a JUNIOR staff_roles row ⇒ tier staff: every ABOVE-staff
    // page (admin AND the Phase-3 senior ticket-actions page) must 403.
    for (const page of PAGES.filter((p) => !p.path.includes(":userId"))) {
      await harness.runOutcome({
        base,
        url: concrete(page.path, GUILD_B),
        cookieId: cookies.staffB,
        expect:
          page.tier !== "staff"
            ? harness.expectForbidden()
            : harness.expectShellOk(page.marker),
        label: "[staffB]",
      });
    }
  });

  it("/t for guild-B staff lists only guild-B rows (no guild-A token echo)", async () => {
    const res = await harness.request(base, "/t", { cookieId: cookies.staffB });
    assert.equal(res.status, 200, "staffB has a staffed guild ⇒ /t renders");
    assert.ok(res.body.includes(richB.token), "B's own ticket row is listed");
    assert.ok(!res.body.includes(richA.token), "guild-A ticket must not leak into B's index");
    assert.ok(!res.body.includes(GUILD_A_NAME), "guild-A name must not leak into B's index");
  });
});

// ---------------------------------------------------------------------------
// F. AUDIT VIEWER @2k ROWS (§8.8 "audit viewer tested")
// ---------------------------------------------------------------------------

describe("F. audit viewer at 2k rows", () => {
  const auditUrl = (qs) => `/g/${GUILD_A}/audit${qs ? `?${qs}` : ""}`;

  it("renders a 100-row first page in strict (created_at,id) DESC order", async () => {
    const res = await measure(auditUrl("n=100"), cookies.admin);
    assert.equal(res.res.status, 200);
    assertStatements("audit n=100", res.recs);
    assert.ok(res.ms < WALL_BUDGET_MS, `audit wall ${res.ms.toFixed(1)}ms`);

    const ids = [...res.res.body.matchAll(/class="audit-id">(\d+)</g)].map((m) => Number(m[1]));
    assert.equal(ids.length, 100, "n=100 renders exactly 100 rows at 2k scale");
    for (let i = 1; i < ids.length; i++) {
      assert.ok(ids[i] < ids[i - 1], `ids strictly DESC at row ${i} (${ids[i - 1]} → ${ids[i]})`);
    }
    // newest seeded guild-A row = the last tracked-trail insert
    const expectedTop = Math.max(...seed.auditIds.web, ...seed.auditIds.slash, ...seed.auditIds.system) + 6;
    assert.equal(ids[0], expectedTop, "first row is the newest audit row (created_at DESC, id DESC)");

    // guild-B rows NEVER render on A's viewer (200 foreign rows exist).
    assert.ok(!res.res.body.includes("b-hidden-"), "guild-B audit rows leaked into guild A (§8.6)");
    assert.ok(!res.res.body.includes(GUILD_B), "guild-B id never echoes");
  });

  it("pagination is gapless and the page cap holds", async () => {
    const p1 = await harness.request(base, auditUrl("n=100"), { cookieId: cookies.admin });
    const p2 = await harness.request(base, auditUrl("n=100&o=100"), { cookieId: cookies.admin });
    const ids1 = [...p1.body.matchAll(/class="audit-id">(\d+)</g)].map((m) => Number(m[1]));
    const ids2 = [...p2.body.matchAll(/class="audit-id">(\d+)</g)].map((m) => Number(m[1]));
    assert.equal(ids2.length, 100, "page 2 also full at this scale");
    assert.ok(new Set([...ids1, ...ids2]).size === 200, "pages must not overlap (OFFSET math)");
    assert.ok(ids2[0] < ids1[ids1.length - 1], "page 2 continues the DESC order");

    // the server clamps over-large n to the 100-row budget ceiling
    const greedy = await harness.request(base, auditUrl("n=5000"), { cookieId: cookies.admin });
    const greedyIds = [...greedy.body.matchAll(/class="audit-id">(\d+)</g)].map(() => 1).length;
    assert.ok(greedyIds <= 100, `n=5000 must clamp to ≤100 rows (got ${greedyIds})`);
  });

  it("origin filter shows only matching origins and stays LIMIT-bounded", async () => {
    const res = await measure(auditUrl("origin=web&n=100"), cookies.admin);
    assert.equal(res.res.status, 200);
    assertStatements("audit origin=web", res.recs);
    const actions = [...res.res.body.matchAll(/class="audit-action">([^<]+)</g)].map((m) => m[1]);
    assert.ok(actions.length >= 30, `origin=web has many rows at scale (got ${actions.length})`);
    for (const action of actions) {
      assert.match(
        action,
        /^gate\.(web|tracked)-\d{5}$/,
        `origin=web page must only render web-origin rows (saw ${action})`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// G. TRANSCRIPT SURFACE @SCALE — pinned signatures + index over 2k rows
// ---------------------------------------------------------------------------

describe("G. transcript surface at scale", () => {
  it("/t index over 2k archived rows is guild-scoped and paginates at 50", async () => {
    const res = await measure("/t", cookies.admin);
    assert.equal(res.res.status, 200);
    assertStatements("/t index", res.recs); // STRICT scan (no reviewed)
    assert.ok(res.res.body.includes("<h1>Archived tickets"), "index heading");
    const gids = [...res.res.body.matchAll(/class="gid">(\d+)</g)].map((m) => m[1]);
    assert.equal(gids.length, 50, `full 50-row page at this scale (got ${gids.length})`);
    for (const gid of gids) {
      assert.equal(gid, GUILD_A, "index rows are guild A only (§8.4 guild allow-list)");
    }
    assert.ok(!res.res.body.includes(richB.token), "guild-B token never echoes (§8.6)");
    assert.ok(!res.res.body.includes(GUILD_B_NAME), "guild-B name never echoes");

    // The harness ticket closed at the REAL clock while the bulk fixture
    // carries future-shifted closed_at stamps ⇒ its rank is exactly
    // (archived-1) = 2002 rows deep ⇒ page floor(2002/50)+1 = 41. The last
    // page must resolve it (pagination reaches the tail of 2k+ rows).
    const tail = await harness.request(base, "/t?page=41", { cookieId: cookies.admin });
    assert.equal(tail.status, 200);
    assert.ok(
      tail.body.includes(richA.token),
      "the newest REAL-clock archived ticket sits on page 41 of the 2k index"
    );
    const tailGids = [...tail.body.matchAll(/class="gid">(\d+)</g)].map((m) => m[1]);
    assert.ok(tailGids.length > 0 && tailGids.length < 50, `tail page is partial (${tailGids.length} rows)`);
    for (const gid of tailGids) {
      assert.equal(gid, GUILD_A, "tail rows stay guild-scoped");
    }
  });

  it("opening a transcript runs ONLY the reviewed statement signatures", async () => {
    const res = await measure(`/t/${richA.token}`, cookies.admin);
    assert.equal(res.res.status, 200);
    assert.ok(res.res.body.includes(MARKER_A), "transcript body renders the fixture marker");
    assertStatements(`transcript open`, res.recs, TRANSCRIPT_REVIEWED);
    // The unscoped-but-reviewed token lookup must be the ONLY tickets read:
    const ticketReads = res.recs
      .map((r) => normalizeSql(r.sql))
      .filter((sql) => /\bfrom tickets\b/.test(sql));
    assert.deepEqual(ticketReads, ["select * from tickets where transcript_token=?"],
      "transcript page touches tickets via the pinned token lookup ONLY (§8.4 signature set)");
  });

  it("every §8.4 participant class opens ticket A; others get the generic 404", async () => {
    for (const viewer of ["creator", "member", "tstaff", "author"]) {
      await harness.runOutcome({
        base,
        url: `/t/${richA.token}`,
        cookieId: cookies[viewer],
        expect: harness.expectTranscriptOk(MARKER_A),
        label: `[${viewer}]`,
      });
    }
    for (const viewer of ["plain", "stranger"]) {
      await harness.runOutcome({
        base,
        url: `/t/${richA.token}`,
        cookieId: cookies[viewer],
        expect: harness.expectGenericNotFound({ forbid: [MARKER_A, richA.token] }),
        label: `[${viewer}]`,
      });
    }
    // anonymous ⇒ login redirect (shape asserted loosely here — the exact
    // bytes are already pinned by web-access-matrix-0c.test.js)
    const anon = await harness.request(base, `/t/${richA.token}`);
    assert.equal(anon.status, 302);
    assert.ok(String(anon.location).startsWith("/auth/login"), "anon → login");
  });

  it("unknown and foreign tokens are the generic 404 (byte-exact)", async () => {
    await harness.runOutcome({
      base,
      url: `/t/${UNKNOWN_UUID}`,
      cookieId: cookies.admin,
      expect: harness.expectGenericNotFound({ forbid: [MARKER_A] }),
      label: "[unknown uuid]",
    });
    await harness.runOutcome({
      base,
      url: `/t/${richB.token}`,
      cookieId: cookies.admin,
      expect: harness.expectGenericNotFound({ forbid: [MARKER_B, richB.token, GUILD_B_NAME] }),
      label: "[A-admin → B ticket]",
    });
  });
});

// ---------------------------------------------------------------------------
// H. EXPLAIN QUERY PLAN — no bare SCANs of the large seeded tables
//    (subtask acceptance: "EXPLAIN QUERY PLAN shows no SCAN on large
//    tables"). Runs on the REAL statements captured by B/F/G with their
//    real bound args — the planner sees the 10k-scale statistics.
// ---------------------------------------------------------------------------

/** Tables past this row count must never be bare-SCANNed (§8.11). */
const LARGE_TABLE_ROWS = 1_000;

describe("H. EXPLAIN QUERY PLAN (no SCAN on large tables)", () => {
  it("every captured statement avoids a bare table SCAN at 10k scale", () => {
    const bigTables = new Map();
    for (const table of GUILD_SCOPED_TABLES) {
      const row = api.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(); // table names from our own const set
      if (Number(row?.n || 0) > LARGE_TABLE_ROWS) bigTables.set(table, Number(row.n));
    }
    assert.ok(bigTables.size >= 6, `fixture should be large across tables: ${[...bigTables.keys()]}`);

    const problems = [];
    const seen = new Set();
    for (const rec of CAPTURED) {
      const key = normalizeSql(rec.sql);
      if (seen.has(key)) continue;
      seen.add(key);
      const planRows = api.db.prepare(`EXPLAIN QUERY PLAN ${rec.sql}`).all(...rec.args);
      for (const planRow of planRows) {
        const detail = String(planRow.detail || "");
        const scan = /^SCAN\s+([a-z0-9_]+)/i.exec(detail);
        if (!scan) continue;
        const table = scan[1].toLowerCase();
        if (!bigTables.has(table)) continue; // small/global tables are free
        // "USE TEMP B-TREE FOR ORDER BY" is a sort, not a table scan; a
        // SCAN that runs THROUGH AN INDEX is accepted only as a REVIEWED
        // compromise — list it here if one ever appears, with a finding.
        problems.push(`${table} (${bigTables.get(table)} rows): ${detail}`);
      }
    }
    assert.deepEqual(problems, [], "EXPLAIN QUERY PLAN bare SCANs on large tables (§8.11)");
  });
});

// ---------------------------------------------------------------------------
// I. GATE REPORT — the evidence artifact (§8.8), printed every run.
// ---------------------------------------------------------------------------

describe("I. gate report", () => {
  it("prints the statement-budget + timing table", () => {
    if (GATE_MEASURE) {
      process.stderr.write(`\nGATE-MEASURE ${JSON.stringify(MEASURED, null, 0)}\n`);
    }
    const lines = [
      "",
      "═══ PHASE-1 GATE REPORT (subtask 23) ═══",
      "url                                    req1  req2   cold_ms  warm_ms",
      ...MEASURED.map(
        (m) =>
          `${m.url.padEnd(40)} ${String(m.req1).padStart(4)} ${String(m.req2).padStart(5)} ` +
          `${String(m.ms1).padStart(8)} ${String(m.ms2).padStart(9)}`
      ),
      `scale: users=${seed?.counts.users} daily=${seed?.counts.dailyRows} audit=${seed?.counts.audit} ` +
        `archived=${seed?.counts.ticketsArchived} open=${seed?.counts.ticketsOpen}`,
      "",
    ];
    process.stderr.write(`${lines.join("\n")}\n`);
    assert.ok(MEASURED.length === BUDGET_URLS.length, "budget suite populated the report");
  });
});
