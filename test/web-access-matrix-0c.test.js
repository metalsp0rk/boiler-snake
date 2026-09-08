/**
 * Subtask 13 — PHASE 0c EXIT SUITE (roadmap/web-admin.md §8.8 "0c" exit
 * criteria + §8.11 "Access matrix suite + cross-guild probe"): the
 * program-level gate over the INTEGRATED app.
 *
 * Fully offline (program-gate pattern of §8.11): createWebApp + real
 * SQLite temp DB via loadDb(), REAL createGuildAccessResolver + REAL
 * staff_roles rows over a fake Discord transport, DI seams for botGuilds,
 * real sessions + transcripts + assets, fake clock for TTL bounds,
 * node --test + fetch on an ephemeral port.
 *
 * Suites:
 *  A. TRANSCRIPT MATRIX — every (viewer class × ticket class) cell on the
 *     transcript AND the asset surface: anonymous, in-guild plain member,
 *     cross-guild user (staff of guild B), staff-junior, staff-senior,
 *     admin, creator, added member, named ticket staff, message author,
 *     former member who LEFT the guild — × normal-A / foreign-B / sensitive
 *     (token kept, archived=0) / sensitive-closed (token cleared) /
 *     unknown-uuid tickets. Outcomes 200 / 302-login / 404 ONLY, denied
 *     bodies byte-exact ("Not found"/""), leak-gated against every fixture
 *     secret (§8.4, §8.6).
 *  B. CROSS-GUILD PROBES — guilds A AND B are both SERVED by the bot so no
 *     probe is a trivial bot-absent 404; guild-A-scoped sessions sweep every
 *     mounted /g GET shape (live Express-router enumeration ⇒ sibling
 *     subtasks 19/20 auto-join the sweep the moment they mount), the B
 *     transcript + asset URLs, and index ?guild=B ⇒ generic 404, never 403,
 *     never guild-B data. Positive control: guild-B staff resolves 200 on
 *     the same shapes (the 404s are the GATE, not dead data).
 *  C. LOGIN-MANDATORY SWEEP (§8.1-3) — anonymous GET of every ticket route
 *     + every mounted /g GET shape ⇒ 302 to /auth/login, EMPTY body,
 *     no-store (+ re-auth session variant).
 *  D. SENSITIVE NEVER LEAKS (§8.4) — sensitive rows absent from the index
 *     for EVERY class; direct uuid 404s even the creator and the admin
 *     while the transcript FILE EXISTS on disk (denial proven to be the
 *     gate, not absence).
 *  E. 405 SEMANTICS (§8.8 0a parity) — POST/PUT/DELETE on the ticket
 *     surface answers the legacy "Method not allowed" BEFORE any auth
 *     decision (anonymous requests must 405, not 302).
 *  F. TIER-CACHE BOUNDS (§8.1-8) — staff_roles row deleted ⇒ the NEXT
 *     request denies (uncached table, instant, proven against a warm
 *     role-id cache); Discord-side role stripped ⇒ still works while the
 *     cache is fresh (documented window), denies after TTL expiry (fake
 *     clock).
 *
 * Harness: test/helpers/access-matrix.js (mechanism only, zero route
 * coupling — Phase 1/2/3 suites reuse it; the live route enumeration IS the
 * "skip-if-not-mounted" gate for concurrent subtasks 19/20).
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// loadDb FIRST: fresh SQLite + src require-cache reset; every require below
// binds to that DB (same discipline as web-ticket-gating/web-tier-middleware).
const { api, tmpDir } = loadDb();

const harness = require("./helpers/access-matrix");
const { createGuildAccessResolver } = require("../src/web/auth/guildAccess");
const { createWebApp } = require("../src/web/app");
const sessionPolicy = require("../src/web/auth/sessions");
const tokens = require("../src/web/auth/tokens");
const {
  writeTranscriptFile,
  absoluteAssetsDir,
  resolveTranscriptAbsolutePath,
} = require("../src/features/tickets/transcript");

// Clearly-fake placeholders only (AGENTS.md: never real-looking secrets).
const SESSION_SECRET = "test-ex…-xyz";

// Guild B is deliberately ALSO served by the bot (§8.3 row 1 excluded from
// the probe story): a guild-A session's 404 on /g/B is then provably the
// cross-guild gate (§8.6), never the trivial bot-not-in-guild 404.
const GUILD_A = "100000000000000001";
const GUILD_B = "200000000000000002";
const GUILD_A_NAME = "GA-VISIBLE";
const GUILD_B_NAME = "GB-NEVER-ECHO"; // forbidden in every cross-guild response

const USER_ADMIN = "428190112345678901"; // owner snapshot ⇒ admin fast path
const USER_SENIOR = "428190112345678902"; // senior staff_roles row (guild A)
const USER_JUNIOR = "428190112345678903"; // junior staff_roles row (guild A)
const USER_PLAIN = "428190112345678904"; // guild A member, no staff role
const USER_CREATOR = "428190112345678905"; // creator of ticket A (+sens rows)
const USER_MEMBER = "428190112345678906"; // ticket_members row
const USER_TSTAFF = "428190112345678907"; // ticket_staff row
const USER_AUTHOR = "428190112345678908"; // ticket_messages.author_id
const USER_LEFT = "428190112345678910"; // participant who LEFT guild A
const USER_STAFFB = "428190112345678911"; // staff of guild B ONLY (positive control)
const USER_BROKEN = "428190112345678912"; // corrupt AT ⇒ re-auth
const USER_CACHE = "428190112345678913"; // tier-cache bounds probe (suite F)

const ROLE_JUNIOR_A = "500000000000000011";
const ROLE_SENIOR_A = "500000000000000012";
const ROLE_STAFF_B = "500000000000000013";
const ROLE_CACHE_A = "500000000000000014";

const ASSET_NAME = "001_photo.png";
const TTL_MS = 60_000;

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
// Fake Discord transport + mutable fixtures (REAL resolver on top)
// ---------------------------------------------------------------------------

/** `${userId}:${guildId}` -> string[] role ids; missing entry ⇒ member 404. */
const memberFixture = {};
const calls = { member: 0, guilds: 0 };
let fakeNow = 0; // fake clock (suite F drives it; §8.1-8 TTL bounds)

const A_SIDE_USERS = new Set([USER_SENIOR, USER_JUNIOR, USER_PLAIN, USER_LEFT, USER_CACHE]);

function userOf(token) {
  return String(token).replace(/^tok-/, "");
}

const fakeDiscord = {
  async getUserGuilds(token) {
    calls.guilds += 1;
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
    return []; // participants & stranger: member of NOTHING (§8.4 readers)
  },
  async getUserGuildMember(token, guildId) {
    calls.member += 1;
    const userId = userOf(token);
    const roles = memberFixture[`${userId}:${guildId}`];
    if (!roles) {
      const err = new Error("Unknown Guild");
      err.status = 404;
      throw err;
    }
    return { roles: [...roles] };
  },
};

// ---------------------------------------------------------------------------
// Suite-level fixtures (server, sessions, tickets)
// ---------------------------------------------------------------------------

/** @type {import("http").Server} */
let server;
let base = "";
/** @type {import("express").Express} */
let app;

/** viewer key → session cookie id (null = anonymous). */
const cookies = {};
/** ticket class key → { token, marker, id } */
const T = {};
let sensClosedTokenWas = ""; // the token closeTicketSensitive CLEARED
/** every fixture secret that a DENIED body must never echo */
let ALL_SECRETS = [];

const cookieOf = (key) => (key === "anon" ? null : cookies[key]);

before(async () => {
  savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
  process.env.SESSION_SECRET = SESSION_SECRET;
  for (const k of ENV_KEYS.slice(1)) delete process.env[k];
  fakeNow = Date.now();

  // REAL staff_roles rows — the §8.3/§8.1-5 source of truth, uncached.
  api.addStaffRole(GUILD_A, ROLE_JUNIOR_A, "junior");
  api.addStaffRole(GUILD_A, ROLE_SENIOR_A, "senior");
  api.addStaffRole(GUILD_A, ROLE_CACHE_A, "junior");
  api.addStaffRole(GUILD_B, ROLE_STAFF_B, "junior");

  // Role fixtures (Discord side). USER_LEFT intentionally has NO guild-A
  // member entry ⇒ member 404 ⇒ member_left deny + §8.4 participant right.
  memberFixture[`${USER_JUNIOR}:${GUILD_A}`] = [ROLE_JUNIOR_A];
  memberFixture[`${USER_SENIOR}:${GUILD_A}`] = [ROLE_SENIOR_A];
  memberFixture[`${USER_PLAIN}:${GUILD_A}`] = [];
  memberFixture[`${USER_CACHE}:${GUILD_A}`] = [ROLE_CACHE_A];
  memberFixture[`${USER_STAFFB}:${GUILD_B}`] = [ROLE_STAFF_B];

  // REAL resolver, fake clock + fake transport; the bot serves BOTH guilds,
  // so guild-B denials for A-sessions are pure cross-guild-gate decisions.
  const resolver = createGuildAccessResolver({
    discord: fakeDiscord,
    botGuilds: async () => [GUILD_A, GUILD_B],
    now: () => fakeNow,
    ttlMs: TTL_MS,
  });
  app = createWebApp({ guildAccess: resolver });
  server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;

  // --- sessions -------------------------------------------------------------
  const sessionDeps = { api, sessionPolicy, tokens };
  const snapshotA = (userId) => [
    {
      id: GUILD_A,
      name: GUILD_A_NAME,
      icon: null,
      owner: userId === USER_ADMIN,
      permissions: "0",
    },
  ];
  const snapshotB = [
    { id: GUILD_B, name: GUILD_B_NAME, icon: null, owner: false, permissions: "0" },
  ];
  const seeding = [
    ["anon", null],
    ["admin", USER_ADMIN],
    ["senior", USER_SENIOR],
    ["junior", USER_JUNIOR],
    ["plain", USER_PLAIN],
    ["creator", USER_CREATOR],
    ["member", USER_MEMBER],
    ["tstaff", USER_TSTAFF],
    ["author", USER_AUTHOR],
    ["left", USER_LEFT],
    ["staffB", USER_STAFFB],
    ["broken", USER_BROKEN],
    ["cacheProbe", USER_CACHE],
  ];
  for (const [key, userId] of seeding) {
    if (!userId) continue;
    cookies[key] = harness.createLoginSession(sessionDeps, userId, {
      snapshotEntries: userId === USER_STAFFB ? snapshotB : snapshotA(userId),
      corrupt: key === "broken",
    });
  }

  // --- tickets (every §8.4 participant class on ticket A) -------------------
  const seedDeps = { api, writeTranscriptFile, absoluteAssetsDir, fs, path, png: harness.PNG };

  const a = harness.seedArchivedTicket(seedDeps, {
    guildId: GUILD_A,
    creatorUserId: USER_CREATOR,
    channelId: "ch-exit-a",
    reason: "exit matrix A",
    marker: "EXIT-MARKER-TRANSCRIPT-A-3f7d",
    withAsset: true,
    assetName: ASSET_NAME,
  });
  T.normalA = { token: a.token, marker: "EXIT-MARKER-TRANSCRIPT-A-3f7d", id: a.ticket.id };
  api.addTicketMember(a.ticket.id, USER_MEMBER, USER_ADMIN);
  api.addTicketMember(a.ticket.id, USER_LEFT, USER_ADMIN); // participant who left
  api.addTicketStaff(a.ticket.id, USER_TSTAFF, USER_ADMIN);
  api.saveTicketMessages(a.ticket.id, [
    {
      message_id: "msg-exit-author",
      author_id: USER_AUTHOR,
      author_tag: "speaker",
      content: "I only spoke here",
      sent_at: Date.now(),
    },
  ]);

  const b = harness.seedArchivedTicket(seedDeps, {
    guildId: GUILD_B,
    creatorUserId: "u-b-creator",
    channelId: "ch-exit-b",
    reason: "exit matrix B (foreign)",
    marker: "EXIT-MARKER-TRANSCRIPT-B-81c2",
    withAsset: true,
    assetName: ASSET_NAME,
  });
  T.crossB = { token: b.token, marker: "EXIT-MARKER-TRANSCRIPT-B-81c2", id: b.ticket.id };

  // Sensitive (a): content WAS archived (file on disk!) then flagged
  // sensitive + un-archived ⇒ the route archive-gate 404s EVERYONE (§8.4).
  const s = harness.seedArchivedTicket(seedDeps, {
    guildId: GUILD_A,
    creatorUserId: USER_CREATOR, // same creator cookie must still 404
    channelId: "ch-exit-sens",
    reason: "exit sensitive kept-token",
    marker: "EXIT-MARKER-TRANSCRIPT-SENS-4e5f",
    withAsset: false,
  });
  T.sensA = { token: s.token, marker: "EXIT-MARKER-TRANSCRIPT-SENS-4e5f", id: s.ticket.id };
  api.db.prepare(`UPDATE tickets SET archived=0, is_sensitive=1 WHERE id=?`).run(s.ticket.id);

  // Sensitive (b): the REAL close flow — closeTicketSensitive CLEARS the
  // transcript token ⇒ the old uuid can never resolve again.
  const sc = api.createTicket({
    guildId: GUILD_A,
    creatorUserId: USER_CREATOR,
    channelId: "ch-exit-sens-closed",
    reason: "exit sensitive closed",
  });
  sensClosedTokenWas = api.generateTranscriptToken();
  api.db.prepare(`UPDATE tickets SET transcript_token=? WHERE id=?`).run(sensClosedTokenWas, sc.id);
  T.sensClosed = { token: sensClosedTokenWas, marker: "", id: sc.id };
  api.markTicketClosed(sc.id, { closedBy: "mod" });
  api.closeTicketSensitive(sc.id, { closedBy: "mod" });

  // Unknown: a well-formed uuid with NO row at all.
  T.unknown = { token: api.generateTranscriptToken(), marker: "", id: 0 };

  ALL_SECRETS = [
    T.normalA.token,
    T.crossB.token,
    T.sensA.token,
    sensClosedTokenWas,
    T.normalA.marker,
    T.crossB.marker,
    T.sensA.marker,
    GUILD_A,
    GUILD_B,
    GUILD_A_NAME,
    GUILD_B_NAME,
  ];
});

after(async () => {
  if (server) {
    server.closeAllConnections?.();
    server.close();
    await once(server, "close");
  }
  for (const [guildId, roleId] of [
    [GUILD_A, ROLE_JUNIOR_A],
    [GUILD_A, ROLE_SENIOR_A],
    [GUILD_A, ROLE_CACHE_A],
    [GUILD_B, ROLE_STAFF_B],
  ]) {
    try {
      api.removeStaffRole(guildId, roleId);
    } catch {
      /* db may be gone already */
    }
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

// ===========================================================================
// A. TRANSCRIPT ACCESS MATRIX — every viewer class × every ticket class,
//    on the transcript AND the asset surface (assets inherit the exact
//    gate, §8.4). One call-site per cell via harness.runOutcome.
// ===========================================================================

const MATRIX_TICKETS = ["normalA", "crossB", "sensA", "sensClosed", "unknown"];
const MATRIX_VIEWERS = [
  "anon",
  "plain",
  "staffB", // cross-guild user (staff of guild B only)
  "junior",
  "senior",
  "admin",
  "creator",
  "member",
  "tstaff",
  "author",
  "left", // former member who left the guild
];

/** Who may open which ticket class (§8.4 staff-OR-participant). */
const ALLOWED = {
  normalA: new Set(["admin", "junior", "senior", "creator", "member", "tstaff", "author", "left"]),
  crossB: new Set(["staffB"]), // staff tier of the ticket's GUILD
  sensA: new Set(), // never content-archived ⇒ 404 unchanged
  sensClosed: new Set(), // transcript token cleared ⇒ can never resolve
  unknown: new Set(),
};

function outcome(viewerKey, ticketKey, surface) {
  const t = T[ticketKey];
  if (viewerKey === "anon") return harness.expectLoginRedirect("/auth/login"); // §8.1-3
  if (ALLOWED[ticketKey].has(viewerKey)) {
    return surface === "asset"
      ? harness.expectAssetOk(harness.PNG)
      : harness.expectTranscriptOk(t.marker);
  }
  return harness.expectGenericNotFound({ forbid: ALL_SECRETS });
}

describe("A | transcript access matrix (§8.4/§8.8-0c: every class × every ticket × assets)", () => {
  for (const viewer of MATRIX_VIEWERS) {
    for (const ticketKey of MATRIX_TICKETS) {
      it(`A | ${viewer} × ${ticketKey} (transcript + asset)`, async () => {
        const url = `/t/${T[ticketKey].token}`;
        const assetUrl = `/t/${T[ticketKey].token}/assets/${ASSET_NAME}`;
        await harness.runOutcome({
          base,
          url,
          cookieId: cookieOf(viewer),
          expect: outcome(viewer, ticketKey, "transcript"),
          label: `matrix[${viewer} × ${ticketKey}]`,
        });
        await harness.runOutcome({
          base,
          url: assetUrl,
          cookieId: cookieOf(viewer),
          expect: outcome(viewer, ticketKey, "asset"),
          label: `matrix[${viewer} × ${ticketKey}] asset`,
        });
      });
    }
  }
});

// ===========================================================================
// B. CROSS-GUILD PROBES (§8.6, §8.13-10) — session valid for guild A must
//    find NOTHING at guild B: every mounted /g GET shape (LIVE router
//    enumeration — sibling-mounted routes join automatically), the B
//    transcript + asset, and index ?guild=B. Byte-generic 404, never 403.
// ===========================================================================

const CROSS_VIEWERS = ["admin", "junior", "senior", "plain", "creator", "member", "tstaff", "author", "left"];

/** The Phase-1 mounts that exist today (route-removal regression guard). */
const KNOWN_G_PATHS = [
  "/g/:guildId",
  "/g/:guildId/users",
  "/g/:guildId/users/:userId",
  "/g/:guildId/users/:userId/activity",
  "/g/:guildId/warnings",
  "/g/:guildId/notes",
  "/g/:guildId/settings",
  "/g/:guildId/leaderboard",
  "/g/:guildId/leaderboard/user/:userId",
];

const SUBS_B = { guildId: GUILD_B, userId: USER_PLAIN };

describe("B | cross-guild probes: guild-A sessions see nothing of guild B", () => {
  it("B | live router enumeration finds the guild-scoped surface", () => {
    const found = harness.listGetRoutesUnder(app, "/g/");
    const paths = new Set(found.map((r) => r.path));
    for (const known of KNOWN_G_PATHS) {
      assert.ok(paths.has(known), `mounted GET route ${known} missing from router enumeration`);
    }
    // Sibling subtasks 19/20 (staff/commands/integrations) join once mounted
    // — this suite never hardcodes them; the sweeps below iterate live.
    assert.ok(found.length >= KNOWN_G_PATHS.length, "enumeration regressed");
  });

  it("B | every mounted /g GET shape is a generic 404 for guild-A sessions", async () => {
    const routes = harness.listGetRoutesUnder(app, "/g/");
    assert.ok(routes.length > 0);
    for (const route of routes) {
      const concrete = harness.buildConcretePath(route.path, SUBS_B);
      for (const viewer of CROSS_VIEWERS) {
        await harness.runOutcome({
          base,
          url: concrete,
          cookieId: cookieOf(viewer),
          expect: harness.expectGenericNotFound({ forbid: ALL_SECRETS }),
          label: `cross[${viewer}] ${concrete}`,
        });
      }
    }
  });

  it("B | guild-B transcript + asset URLs 404 for every guild-A session (§8.6)", async () => {
    const urls = [`/t/${T.crossB.token}`, `/t/${T.crossB.token}/assets/${ASSET_NAME}`];
    for (const url of urls) {
      for (const viewer of CROSS_VIEWERS) {
        await harness.runOutcome({
          base,
          url,
          cookieId: cookieOf(viewer),
          expect: harness.expectGenericNotFound({ forbid: ALL_SECRETS }),
          label: `cross[${viewer}] ${url}`,
        });
      }
    }
  });

  it("B | index ?guild=<foreign> leaks nothing: ignored to the scoped default, never 403 (§8.4 rule 3)", async () => {
    // §8.4 pins IGNORE (not 404) for the legacy ?guild= param on the SHARED
    // index: the scoped default must render with ZERO foreign data. The
    // strictest reading "never guild-B data" is asserted byte-wise here.
    const res = await harness.request(base, `/t?guild=${GUILD_B}`, { cookieId: cookies.admin });
    assert.equal(res.status, 200, "scoped default — never 403/302 (§8.4/§8.6)");
    assert.ok(res.body.includes(T.normalA.token), "viewer's own scope still renders");
    assert.ok(!res.body.includes(T.crossB.token), "foreign rows NEVER render");
    assert.ok(!res.body.includes(GUILD_B), "foreign guild id NEVER echoes");
    assert.ok(!res.body.includes(GUILD_B_NAME), "foreign guild name NEVER echoes");
    assert.ok(!res.body.includes("Guild filter"), "foreign param must not filter the list");
  });

  it("B | positive control: guild-B staff resolves guild B everywhere (gate ≠ dead data)", async () => {
    // Same shapes the sweep denied — for a session VALID in B they resolve.
    // Proves the 404s above are the cross-guild GATE, and auto-gates any
    // sibling route (19/20) that mounts guild-scoped staff views.
    const shell = await harness.request(base, `/g/${GUILD_B}`, { cookieId: cookies.staffB });
    assert.equal(shell.status, 200, "guild-B staff opens /g/B");

    await harness.runOutcome({
      base,
      url: `/t/${T.crossB.token}`,
      cookieId: cookies.staffB,
      expect: harness.expectTranscriptOk(T.crossB.marker),
      label: "control staffB transcript",
    });
    await harness.runOutcome({
      base,
      url: `/t/${T.crossB.token}/assets/${ASSET_NAME}`,
      cookieId: cookies.staffB,
      expect: harness.expectAssetOk(harness.PNG),
      label: "control staffB asset",
    });

    const idx = await harness.request(base, `/t?guild=${GUILD_B}`, { cookieId: cookies.staffB });
    assert.equal(idx.status, 200, "?guild= honored for an ACCESSIBLE guild");
    assert.ok(idx.body.includes(T.crossB.token), "own-guild row renders");
    assert.ok(idx.body.includes("Guild filter"), "honored param activates the filter");
    assert.ok(!idx.body.includes(T.normalA.token), "guild A rows never leak into B view");

    // §8.6 "System: health, tickers, OAuth state, audit viewer" is the ONE
    // Admin-tier row among the mounted Phase 1 views (subtask 22) — guild-B
    // staff must TIER-DENY (403) there, never resolve. A 403 (not the
    // cross-guild 404) still proves the route is alive in guild B, so the
    // "gate ≠ dead data" control holds for the admin surfaces too.
    const ADMIN_TIER_VIEWS = new Set(["/g/:guildId/system", "/g/:guildId/audit"]);
    for (const route of harness.listGetRoutesUnder(app, "/g/")) {
      if (route.params.length !== 1 || route.params[0] !== "guildId") continue;
      const url = harness.buildConcretePath(route.path, { guildId: GUILD_B });
      const r = await harness.request(base, url, { cookieId: cookies.staffB });
      if (ADMIN_TIER_VIEWS.has(route.path)) {
        assert.equal(
          r.status,
          403,
          `admin-tier view ${route.path} must tier-deny guild-B staff with 403 (right guild, wrong tier) — never the cross-guild 404`
        );
        continue;
      }
      assert.equal(
        r.status,
        200,
        `guild-B staff must resolve the staff-tier view ${route.path} (got ${r.status})`
      );
    }
  });
});

// ===========================================================================
// C. LOGIN-MANDATORY SWEEP (§8.1-3): anonymous + re-auth sessions on the
//    ticket surface and every mounted /g shape ⇒ 302 login, EMPTY body,
//    no-store. No config flag exists for an escape hatch.
// ===========================================================================

describe("C | login-mandatory sweep (§8.1-3)", () => {
  const TICKET_URLS = () => [
    "/",
    "/t",
    "/t/",
    `/t/${T.normalA.token}`,
    `/t/${T.normalA.token}/assets/${ASSET_NAME}`,
    `/t/${T.unknown.token}`,
  ];

  it("C | anonymous ticket surface → 302 /auth/login, empty body, no-store", async () => {
    for (const url of TICKET_URLS()) {
      await harness.runOutcome({
        base,
        url,
        expect: harness.expectLoginRedirect("/auth/login"),
        label: `anon ${url}`,
      });
    }
  });

  it("C | anonymous EVERY mounted /g GET shape → 302 /auth/login?guild=A", async () => {
    for (const route of harness.listGetRoutesUnder(app, "/g/")) {
      const url = harness.buildConcretePath(route.path, { guildId: GUILD_A, userId: USER_PLAIN });
      await harness.runOutcome({
        base,
        url,
        expect: harness.expectLoginRedirect(`/auth/login?guild=${GUILD_A}`),
        label: `anon ${url}`,
      });
    }
  });

  it("C | re-auth session (corrupt AT) → login redirect on both surfaces, not 404/500", async () => {
    for (const url of [
      "/",
      "/t",
      "/t/",
      `/t/${T.normalA.token}`,
      `/t/${T.normalA.token}/assets/${ASSET_NAME}`,
    ]) {
      await harness.runOutcome({
        base,
        url,
        cookieId: cookies.broken,
        expect: harness.expectLoginRedirect("/auth/login"),
        label: `reauth ${url}`,
      });
    }
    // Precedence contract (routes/transcripts.js): the ROW/archive gate runs
    // BEFORE the access decision — an unknown uuid is the generic 404 even
    // for a live-but-unusable session (never distinguishes re-auth).
    await harness.runOutcome({
      base,
      url: `/t/${T.unknown.token}`,
      cookieId: cookies.broken,
      expect: harness.expectGenericNotFound({ forbid: ALL_SECRETS }),
      label: "reauth unknown-uuid precedence",
    });
    for (const url of [
      `/g/${GUILD_A}`,
      `/g/${GUILD_A}/users`,
      `/g/${GUILD_A}/warnings`,
      `/g/${GUILD_A}/settings`,
      `/g/${GUILD_A}/leaderboard`,
    ]) {
      await harness.runOutcome({
        base,
        url,
        cookieId: cookies.broken,
        expect: harness.expectLoginRedirect(`/auth/login?guild=${GUILD_A}`),
        label: `reauth ${url}`,
      });
    }
  });
});

// ===========================================================================
// D. SENSITIVE NEVER LEAKS (§8.4): rows absent from the index for EVERY
//    class; direct uuid 404 — even creator/admin — while the FILE exists.
// ===========================================================================

describe("D | sensitive tickets never leak (§8.4)", () => {
  const SENSITIVE_TOKENS = () => [T.sensA.token, sensClosedTokenWas];

  it("D | the sensA transcript file EXISTS on disk — denials below are the GATE, not absence", () => {
    const row = api.getTicketById(T.sensA.id);
    assert.equal(row.archived, 0, "fixture: sensitive ⇒ never content-archived");
    assert.equal(row.is_sensitive, 1, "fixture: flagged sensitive");
    const abs = resolveTranscriptAbsolutePath(row);
    assert.ok(abs && fs.existsSync(abs), "archived bytes were written then un-archived (row gate)");
  });

  it("D | direct sensitive uuids 404 for creator AND admin (kept token + cleared token)", async () => {
    for (const token of SENSITIVE_TOKENS()) {
      for (const viewer of ["creator", "admin", "senior", "junior"]) {
        await harness.runOutcome({
          base,
          url: `/t/${token}`,
          cookieId: cookieOf(viewer),
          expect: harness.expectGenericNotFound({ forbid: ALL_SECRETS }),
          label: `sensitive[${viewer}]`,
        });
      }
    }
  });

  it("D | sensitive rows absent from the index for EVERY viewer class", async () => {
    for (const viewer of MATRIX_VIEWERS) {
      const res = await harness.request(base, "/t", { cookieId: cookieOf(viewer) });
      const label = `index[${viewer}]`;
      if (viewer === "anon") {
        assert.equal(res.status, 302, `${label}: login-mandatory`);
        assert.equal(res.body, "", `${label}: empty pre-login`);
        continue;
      }
      assert.equal(res.status, 200, `${label}: scoped default`);
      for (const token of SENSITIVE_TOKENS()) {
        assert.ok(!res.body.includes(token), `${label} echoed sensitive token ${token}`);
      }
      assert.ok(!res.body.includes(T.sensA.marker), `${label} echoed sensitive marker`);
      if (viewer === "staffB") {
        assert.ok(res.body.includes(T.crossB.token), `${label}: own staffed rows still render`);
        assert.ok(!res.body.includes(T.normalA.token), `${label}: guild A rows stay hidden`);
      } else if (["admin", "junior", "senior"].includes(viewer)) {
        assert.ok(res.body.includes(T.normalA.token), `${label}: staffed rows render`);
        assert.ok(!res.body.includes(T.crossB.token), `${label}: foreign rows NEVER render`);
      } else {
        assert.ok(!res.body.includes(T.normalA.token), `${label}: non-staff see no rows`);
        assert.match(res.body, /No archived transcripts/i, `${label}: scoped default`);
      }
    }
  });
});

// ===========================================================================
// E. 405 SEMANTICS (§8.8 Phase 0a parity): the method gate answers BEFORE
//    any auth/access decision — anonymous requests 405, they never 302.
// ===========================================================================

describe("E | 405 semantics intact on the ticket surface (§8.8 0a parity)", () => {
  it("E | POST/PUT/DELETE on every ticket route → legacy 405, before auth", async () => {
    const urls = [
      "/",
      "/t",
      "/t/",
      `/t/${T.normalA.token}`,
      `/t/${T.normalA.token}/assets/${ASSET_NAME}`,
      `/t/${T.unknown.token}`,
      `/g/${GUILD_A}/users`, // methodGate is global — one /g shape proves parity
    ];
    for (const method of ["POST", "PUT", "DELETE"]) {
      for (const url of urls) {
        for (const viewer of [null, "admin"]) {
          await harness.runOutcome({
            base,
            url,
            method,
            cookieId: viewer && cookieOf(viewer),
            expect: harness.expectMethodNotAllowed(),
            label: `${method || "GET"}${viewer ? ` (${viewer})` : " (anon)"} ${url}`,
          });
        }
      }
    }
  });
});

// ===========================================================================
// F. TIER-CACHE BOUNDS (§8.1-8): staff_roles = uncached instant revocation;
//    Discord-side role changes bounded by WEB_TIER_CACHE_TTL_MS (fake clock).
//    Dedicated viewer + role so the matrix fixtures stay untouched.
// ===========================================================================

describe("F | tier-cache bounds (§8.1-8, fake clock)", () => {
  it("F | staff_roles revocation is INSTANT (uncached table, warm role-id cache)", async () => {
    const start = calls.member;
    // Warm BOTH surface caches with cacheProbe's FIRST two requests: the
    // resolve behind them must hit Discord's member endpoint exactly once
    // (per USER+GUILD cache, §8.3) — that warm cache is what makes the
    // instant denial below a proof about the staff_roles read, not a refetch.
    await harness.runOutcome({
      base,
      url: `/t/${T.normalA.token}`,
      cookieId: cookies.cacheProbe,
      expect: harness.expectTranscriptOk(T.normalA.marker),
      label: "cacheProbe transcript warm",
    });
    const g = await harness.request(base, `/g/${GUILD_A}/users`, { cookieId: cookies.cacheProbe });
    assert.equal(g.status, 200, "cacheProbe is staff via ROLE_CACHE_A");
    assert.equal(calls.member, start + 1, "role ids fetched exactly once (then cached)");

    // Revoke in the DB ONLY (Discord side unchanged) — §8.3 "none (cheap)":
    // the NEXT request must deny, cache warmth and all.
    api.removeStaffRole(GUILD_A, ROLE_CACHE_A);
    try {
      const t = await harness.request(base, `/t/${T.normalA.token}`, { cookieId: cookies.cacheProbe });
      assert.equal(t.status, 404, "staff_roles row removed ⇒ next request 404 (§8.1-8)");
      assert.equal(t.body, "Not found");
      const g2 = await harness.request(base, `/g/${GUILD_A}/users`, { cookieId: cookies.cacheProbe });
      assert.equal(g2.status, 404, "same on the /g surface");
      assert.equal(g2.body, "Not found");
      assert.equal(calls.member, start + 1, "denied from the WARM cache: instant, no refetch");
    } finally {
      api.addStaffRole(GUILD_A, ROLE_CACHE_A, "junior");
    }
    // Restored — access returns immediately (still no refetch needed).
    const back = await harness.request(base, `/t/${T.normalA.token}`, { cookieId: cookies.cacheProbe });
    assert.equal(back.status, 200, "row re-added ⇒ instant restore (uncached read)");
    assert.equal(calls.member, start + 1, "restore also served from the warm role-id cache");
  });

  it("F | Discord-side role strip: works while cached, denies after TTL (documented window)", async () => {
    const start = calls.member;
    const t0 = fakeNow;
    // Roles stripped on the DISCORD side only; staff_roles row still grants.
    memberFixture[`${USER_CACHE}:${GUILD_A}`] = [];
    try {
      fakeNow = t0 + 30_000; // < TTL: the documented stale-while-cached window
      const within = await harness.request(base, `/t/${T.normalA.token}`, {
        cookieId: cookies.cacheProbe,
      });
      assert.equal(within.status, 200, "cached role ids ⇒ still staff (bounded staleness, §8.1-8)");
      assert.equal(calls.member, start, "no member fetch inside the TTL window");

      fakeNow = t0 + TTL_MS + 1; // == TTL is stale (`at - cached.at < ttl` is false)
      const after1 = await harness.request(base, `/t/${T.normalA.token}`, {
        cookieId: cookies.cacheProbe,
      });
      assert.equal(after1.status, 404, "past TTL: fresh role ids ⇒ deny (§8.3 re-check at TTL)");
      assert.equal(after1.body, "Not found");
      const after2 = await harness.request(base, `/g/${GUILD_A}/users`, {
        cookieId: cookies.cacheProbe,
      });
      assert.equal(after2.status, 404, "same denial on the /g surface");
      assert.equal(calls.member, start + 1, "exactly one refetch past the TTL (then re-cached)");
    } finally {
      memberFixture[`${USER_CACHE}:${GUILD_A}`] = [ROLE_CACHE_A];
    }
  });
});
