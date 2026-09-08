/**
 * Subtask 22 — system page + admin_audit viewer (roadmap/web-admin.md §8.6
 * "System: health, tickers, OAuth state, audit viewer (admin_audit) | Admin
 * | — | 1 (viewer)", Phase 1 read-only). FULLY OFFLINE integration net over
 * the REAL createWebApp() mount (guildScope → requireTier("admin") → system
 * routes): real SQLite (loadDb), real session rows, fake Discord resolver.
 * node --test only.
 *
 * Suites:
 *  A. Access matrix on BOTH routes (§8.6 System row = Admin): anon 302 ·
 *     plain-member 404 · STAFF/SENIOR 403 (the exact in-guild wrong-tier
 *     side of the boundary) · cross-guild 404 with zero guild-B data (the
 *     other side) · admin 200;
 *  B. Read-only: POST/DELETE ⇒ 405 (methodGate), NO export/delete/detail
 *     subpaths (generic 404 catch-all);
 *  C. /system content: process health (uptime/node/pid/boot), sqlite path,
 *     HONEST unknowns (session prune, empty ticker registry), ticker
 *     registry dump incl. throw-safe degrade (no error text leak), web
 *     surface env projection (names + booleans + port only), OAuth summary
 *     (authorized state WITHOUT tokens — §8.7), SESSION_SECRET source
 *     dedicated/fallback/unset, insecure-HTTP warning echo;
 *  D. /audit viewer: newest-first, origin filter (web|slash|system|all),
 *     invalid origin ⇒ safe default + escaped notice (never 500), LIMIT ≤100
 *     clamp + honest totals + offset clamp, pretty-printed ESCAPED details
 *     (unicode + HTML payloads), link-free rows, no guild-B leakage;
 *  E. Secrets NEVER render: SESSION_SECRET sentinel absent from every page,
 *     OAuth token sentinels absent, env NAMES only; direct unit probes of
 *     the sanitized projections (readSessionSecretState, readOriginFilter,
 *     buildAuditPage facade-contract passthrough).
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
const { api, tmpDir, dbPath } = loadDb();

const { createWebApp } = require("../src/web/app");
const { createGuildAccessResolver } = require("../src/web/auth/guildAccess");
const sessionPolicy = require("../src/web/auth/sessions");
const tokens = require("../src/web/auth/tokens");
const {
  registerTickerHealthSource,
} = require("../src/web/data/tickerHealth");
const systemRoutes = require("../src/web/routes/system");

// Clearly-fake placeholders ONLY (AGENTS.md: never real-looking secrets).
// These double as the §8.7 sentinel canaries asserted ABSENT from HTML.
const SESSION_SECRET_SENTINEL = "test-sys-sentinel-session-secret-NOT-REAL-001";
const CLIENT_SECRET_SENTINEL = "test-sys-sentinel-client-secret-NOT-REAL-002";
const FAKE_OAUTH_ACCESS = "FAKE-OAUTH-ACCESS-TOKEN-NEVER-REAL-111";
const FAKE_OAUTH_REFRESH = "FAKE-OAUTH-REFRESH-TOKEN-NEVER-REAL-222";

const USER_ADMIN = "428190112345678901";
const USER_SENIOR = "428190112345678902";
const USER_STAFF = "428190112345678903";
const USER_PLAIN = "428190112345678904";
const USER_ADMIN2 = "428190112345678905"; // fallback-secret probe

const GUILD_A = "100000000000000001";
const GUILD_B = "200000000000000002";

const ROLE_JUNIOR = "500000000000000011";
const ROLE_SENIOR = "500000000000000012";

/** Fixed seed clock so newest-first ordering is deterministic. */
const BASE = 1_700_000_000_000;

/** Guild-B-only audit canary — must NEVER surface under guild A. */
const B_CANARY = "GUILDB-AUDIT-CANARY";

/** XSS/unicode payload stored in one web-origin audit row's details. */
const XSS_DETAILS = {
  note: `<script>alert("audit-xss")</script>`,
  unicode: "café — 日本語 🐍 \"quoted\"",
  evidence_url: "https://audit-probe.example.invalid/leak",
};

/** Pagination pressure: 100 bulk web rows on top of the probe rows. */
const BULK = 100;
const PAGE_DEFAULT = 25;
const PAGE_MAX = 100;
/** Guild A totals: web = BULK + 2, slash 1, system 1. */
const WEB_TOTAL = BULK + 2;
const TOTAL_A = WEB_TOTAL + 2;

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

function insertAudit(entry) {
  return api.insertAdminAudit(entry);
}

const ENV_KEYS = [
  "SESSION_SECRET",
  "CLIENT_SECRET",
  "CLIENT_ID",
  "PUBLIC_BASE_URL",
  "PUBLIC_HTTP_PORT",
  "TICKET_HTTP_PORT",
  "TICKET_PUBLIC_BASE_URL",
  "OAUTH_REDIRECT_URI",
  "WEB_TIER_CACHE_TTL_MS",
  "DB_PATH",
  "DATA_DIR",
];
let savedEnv;

/** Mutable harness state. */
const suite = { server: null, base: "", cookies: {} };

before(async () => {
  savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
  process.env.SESSION_SECRET = SESSION_SECRET_SENTINEL;
  delete process.env.CLIENT_SECRET;
  delete process.env.CLIENT_ID;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.PUBLIC_HTTP_PORT;
  delete process.env.TICKET_HTTP_PORT;
  delete process.env.TICKET_PUBLIC_BASE_URL;
  delete process.env.OAUTH_REDIRECT_URI;
  delete process.env.WEB_TIER_CACHE_TTL_MS;

  // ---- staff roles (guild A) ---------------------------------------------
  api.addStaffRole(GUILD_A, ROLE_JUNIOR, "junior");
  api.addStaffRole(GUILD_A, ROLE_SENIOR, "senior");

  // ---- command-permission OAuth row (token sentinels must NEVER render) --
  api.upsertCommandPermissionOauth(GUILD_A, {
    refreshToken: FAKE_OAUTH_REFRESH,
    accessToken: FAKE_OAUTH_ACCESS,
    accessExpiresAt: Date.now() + 3_600_000,
    authorizedByUserId: USER_ADMIN,
  });

  // ---- admin_audit seeds (explicit createdAt ⇒ deterministic order) ------
  insertAudit({
    guildId: GUILD_A,
    actorUserId: USER_ADMIN,
    origin: "web",
    action: "settings.command_channel.add",
    targetType: "channel",
    targetId: "700000000000000001",
    details: { channel_id: "700000000000000001", added: true },
    createdAt: BASE + 1,
  });
  insertAudit({
    guildId: GUILD_A,
    actorUserId: USER_SENIOR,
    origin: "slash",
    action: "warnings.issue",
    targetType: "user",
    targetId: "440000000000000001",
    details: { warn_ref: "W-1", reason: "spam incident" },
    createdAt: BASE + 2,
  });
  insertAudit({
    guildId: GUILD_A,
    actorUserId: null, // system rows carry NO actor
    origin: "system",
    action: "decay.apply",
    details: { processed: 12, decayed: 3 },
    createdAt: BASE + 3,
  });
  insertAudit({
    guildId: GUILD_A,
    actorUserId: USER_ADMIN,
    origin: "web",
    action: "audit.unicode_probe",
    targetType: "user",
    targetId: "440000000000000002",
    details: XSS_DETAILS,
    createdAt: BASE + 4,
  });
  for (let i = 0; i < BULK; i += 1) {
    insertAudit({
      guildId: GUILD_A,
      actorUserId: USER_ADMIN,
      origin: "web",
      action: `bulk.probe ${i}`,
      targetType: "user",
      targetId: "440000000000000003",
      details: { i },
      createdAt: BASE + 1000 + i,
    });
  }
  // GUILD B ONLY — cross-guild probe; invisible (404) AND never rendered.
  insertAudit({
    guildId: GUILD_B,
    actorUserId: USER_ADMIN,
    origin: "slash",
    action: "guild.b.canary.action",
    details: { marker: B_CANARY },
    createdAt: BASE + 5000,
  });

  // ---- fake Discord (resolver) --------------------------------------------
  const fakeDiscord = {
    async getUserGuilds(token) {
      const userId = String(token).replace(/^tok-/, "");
      if (
        [USER_ADMIN, USER_SENIOR, USER_STAFF, USER_PLAIN, USER_ADMIN2].includes(userId)
      ) {
        return [
          {
            id: GUILD_A,
            name: "Guild A",
            icon: null,
            owner: userId === USER_ADMIN || userId === USER_ADMIN2,
            permissions:
              userId === USER_ADMIN || userId === USER_ADMIN2 ? "0" : "104324673",
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

  // ---- real app + mount order (guildScope → system routes) -----------------
  const app = createWebApp({ guildAccess: resolver });
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
  const headers = opts.key ? { cookie: `web_session=${suite.cookies[opts.key]}` } : undefined;
  const res = await fetch(`${suite.base}${path}`, {
    method: opts.method || "GET",
    redirect: "manual",
    headers,
  });
  const body = await res.text();
  return { res, body };
}

const SYS = `/g/${GUILD_A}/system`;
const AUD = `/g/${GUILD_A}/audit`;

/** Run fn with an env overlay, restoring the touched keys afterwards. */
async function withEnv(overlay, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(overlay)) {
    prev[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Synchronous twin for pure env-projection unit probes (restores inline). */
function withEnvSync(overlay, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(overlay)) {
    prev[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ===========================================================================
// A. Access matrix — BOTH routes (§8.6 System row = ADMIN, exact boundaries)
// ===========================================================================
describe("access matrix — GET /g/:guildId/system and /audit are Admin-only", () => {
  for (const [label, url] of [
    ["system", SYS],
    ["audit", AUD],
  ]) {
    it(`${label}: anonymous → 302 login redirect (guildScope)`, async () => {
      const { res } = await hit(url);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), `/auth/login?guild=${GUILD_A}`);
    });

    it(`${label}: in-guild member WITHOUT staff role → generic 404 (never 403)`, async () => {
      const { res, body } = await hit(url, { key: "plain" });
      assert.equal(res.status, 404);
      assert.equal(body, "Not found");
    });

    it(`${label}: STAFF and SENIOR (right guild, wrong tier) → 403 "Forbidden" (§8.6 System row)`, async () => {
      for (const key of ["staff", "senior"]) {
        const { res, body } = await hit(url, { key });
        assert.equal(res.status, 403, `${label} via ${key}`);
        assert.equal(body, "Forbidden");
      }
    });

    it(`${label}: admin → 200 shell`, async () => {
      const { res, body } = await hit(url, { key: "admin" });
      assert.equal(res.status, 200);
      assert.match(body, /<!DOCTYPE html>/);
    });

    it(`${label}: cross-guild probe → generic 404 for EVERY tier, zero guild-B data`, async () => {
      for (const key of ["staff", "senior", "admin"]) {
        const { res, body } = await hit(`/g/${GUILD_B}/system`, { key });
        assert.equal(res.status, 404, key);
        assert.equal(body, "Not found");
        assert.ok(!body.includes(B_CANARY));
        const audit = await hit(`/g/${GUILD_B}/audit`, { key });
        assert.equal(audit.res.status, 404, `${key} audit`);
        assert.equal(audit.body, "Not found");
        assert.ok(!audit.body.includes(B_CANARY));
      }
    });
  }

  it("the §8.6 boundary: SAME staff cookie ⇒ 403 in-guild vs 404 cross-guild (both routes)", async () => {
    const inGuild = await hit(SYS, { key: "staff" });
    assert.equal(inGuild.res.status, 403);
    const crossGuild = await hit(`/g/${GUILD_B}/system`, { key: "staff" });
    assert.equal(crossGuild.res.status, 404);

    const inGuildAudit = await hit(AUD, { key: "senior" });
    assert.equal(inGuildAudit.res.status, 403);
    const crossGuildAudit = await hit(`/g/${GUILD_B}/audit`, { key: "senior" });
    assert.equal(crossGuildAudit.res.status, 404);
  });
});

// ===========================================================================
// B. Read-only surface — POST/DELETE 405, no export/delete/detail routes
// ===========================================================================
describe("read-only: mutating verbs 405, no mutation/export routes exist", () => {
  for (const [label, path] of [
    ["system", SYS],
    ["audit", AUD],
  ]) {
    it(`POST ${label} → 405 Method not allowed (admin AND anon — gate runs pre-auth)`, async () => {
      for (const opts of [{ key: "admin", method: "POST" }, { method: "POST" }, { key: "staff", method: "POST" }]) {
        const { res, body } = await hit(path, opts);
        assert.equal(res.status, 405, `${label} via ${JSON.stringify(opts)}`);
        assert.equal(body, "Method not allowed");
      }
    });

    it(`DELETE ${label} → 405 (viewer is read-only: no deletes)`, async () => {
      const { res, body } = await hit(path, { key: "admin", method: "DELETE" });
      assert.equal(res.status, 405);
      assert.equal(body, "Method not allowed");
    });
  }

  it("no /system/reboot, /audit/export, /audit/delete, /audit/:id detail routes exist → generic 404", async () => {
    for (const junk of [
      `${SYS}/reboot`,
      `${SYS}/reset`,
      `${AUD}/export`,
      `${AUD}/delete`,
      `${AUD}/999`,
    ]) {
      const { res, body } = await hit(junk, { key: "admin" });
      assert.equal(res.status, 404, junk);
      assert.equal(body, "Not found", `${junk} must be the plain catch-all`);
    }
  });
});

// ===========================================================================
// C. GET /g/:guildId/system — honest health, unknowns and env NAMES only
// ===========================================================================
describe("GET /g/:guildId/system — process/ticker/web-surface/OAuth panels", () => {
  it("renders real process health + the resolved sqlite path (Admin)", async () => {
    const { res, body } = await hit(SYS, { key: "admin" });
    assert.equal(res.status, 200);
    assert.ok(body.includes(process.version), "node version rendered");
    assert.ok(body.includes(String(process.pid)), "pid rendered");
    assert.ok(body.includes("Uptime"), "uptime row");
    assert.ok(body.includes("Booted"), "boot-time row");
    assert.ok(body.includes("Ticker health"), "ticker panel");
    assert.ok(body.includes("Web surface"), "web-surface panel");
    // The RESOLVED sqlite path (a path — not an env dump):
    assert.ok(body.includes("test.sqlite") && body.includes(dbPath), "resolved db path shown");
    // Session prune — HONEST unknown (not exposed in-process):
    assert.match(body, /Session prune job[\s\S]*unknown/);
    assert.ok(body.includes("not exposed in-process"), "unknown stated honestly, no fabrication");
    // Shared command-visibility panel (subtask-19 component reused):
    assert.ok(body.includes("Command visibility sync"), "shared OAuth panel rendered");
  });

  it("empty ticker registry renders the honest unknown (no fabrication)", async () => {
    const { res, body } = await hit(SYS, { key: "admin" });
    assert.equal(res.status, 200);
    assert.ok(
      body.includes("No ticker health sources are registered"),
      "empty registry states unknown"
    );
  });

  it("ticker registry dump: registered sources render; a THROWING source degrades to fixed detail (no error text)", async () => {
    const offOk = registerTickerHealthSource("voice", () => ({
      lastTickAt: Date.now() - 5_000,
      intervalMs: 60_000,
    }));
    const offBroken = registerTickerHealthSource("decay", () => {
      throw new Error("kaboom-internal-detail-must-not-leak");
    });
    try {
      const { res, body } = await hit(SYS, { key: "admin" });
      assert.equal(res.status, 200);
      assert.ok(body.includes("voice") && body.includes("decay"), "registered names dumped");
      assert.ok(body.includes("badge-ticker-ok"), "healthy ticker badged ok");
      assert.ok(body.includes("source failed"), "throwing source → fixed degrade detail");
      assert.ok(
        !body.includes("kaboom-internal-detail-must-not-leak"),
        "getter error text NEVER reaches the page (§8.7)"
      );
    } finally {
      offOk();
      offBroken();
    }
  });

  it("web surface without PUBLIC_*: not-configured states, dark console note, SESSION_SECRET dedicated (name only)", async () => {
    const { res, body } = await hit(SYS, { key: "admin" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("PUBLIC_HTTP_PORT"), "env NAME rendered");
    assert.ok(body.includes("not configured"), "port dark state");
    assert.ok(body.includes("web console dark"), "dark-mode honesty");
    assert.ok(body.includes("<code>SESSION_SECRET</code>"), "secret SOURCE is the dedicated var");
    assert.ok(!body.includes("<code>CLIENT_SECRET (fallback)</code>"), "no false fallback claim");
    // The sentinel VALUE never appears (see suite E for the full pin):
    assert.ok(!body.includes(SESSION_SECRET_SENTINEL));
  });

  it("web surface WITH loopback PUBLIC_*: configured port + base URL echo, warning not applicable", async () => {
    await withEnv(
      { PUBLIC_HTTP_PORT: "45678", PUBLIC_BASE_URL: "http://localhost:45678" },
      async () => {
        const { res, body } = await hit(SYS, { key: "admin" });
        assert.equal(res.status, 200);
        assert.ok(body.includes("45678"), "configured port echoed (not a secret)");
        assert.ok(body.includes("http://localhost:45678"), "base URL echoed");
        assert.ok(body.includes("not applicable"), "loopback ⇒ no HTTPS warning");
        assert.ok(!body.includes("plain HTTP for a non-localhost host"));
      }
    );
  });

  it("web surface with non-localhost http:// base URL: isSecureBaseUrl warning echoed", async () => {
    await withEnv({ PUBLIC_BASE_URL: "http://bot.example.invalid" }, async () => {
      const { res, body } = await hit(SYS, { key: "admin" });
      assert.equal(res.status, 200);
      assert.ok(
        body.includes("plain HTTP for a non-localhost host"),
        "boot HTTPS validation echoed on the page (§8.7)"
      );
    });
  });

  it("OAuth panel: authorized state WITHOUT token values — statuses + authorized-by only (§8.7/§8.1-9)", async () => {
    const { res, body } = await hit(SYS, { key: "admin" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("authorized"), "authorized badge");
    assert.ok(body.includes("Authorized by") && body.includes(USER_ADMIN), "who authorized");
    assert.ok(body.includes("never completed"), "last-sync status honest");
    assert.ok(body.includes("environment not configured"), "env readiness projected");
    assert.ok(body.includes("CLIENT_SECRET"), "missing env NAMES listed (names only)");
    // The stored token values NEVER leave the projection:
    assert.ok(!body.includes(FAKE_OAUTH_ACCESS), "access token sentinel absent");
    assert.ok(!body.includes(FAKE_OAUTH_REFRESH), "refresh token sentinel absent");
  });
});

// ===========================================================================
// D. GET /g/:guildId/audit — viewer: order, filters, paging, escaping
// ===========================================================================
describe("GET /g/:guildId/audit — newest-first viewer with origin filter + paging", () => {
  it("default page: 25 rows, newest-first, honest guild total, read-only promise", async () => {
    const { res, body } = await hit(AUD, { key: "admin" });
    assert.equal(res.status, 200);
    assert.equal(count(body, 'class="row-audit"'), PAGE_DEFAULT, "default page size 25");
    assert.ok(
      body.indexOf("bulk.probe 99") < body.indexOf("bulk.probe 98"),
      "created_at DESC ordering (newest first)"
    );
    assert.ok(body.includes(`showing 1–${PAGE_DEFAULT} of ${TOTAL_A}`), "honest total");
    assert.ok(body.includes("no exports, no deletes"), "read-only contract stated");
    assert.ok(!body.includes(SESSION_SECRET_SENTINEL), "secret sentinel never leaks onto the viewer");
    assert.ok(body.includes("o=25"), "next-page offset link");
  });

  it("origin filters: web / slash / system each scope honestly", async () => {
    const web = await hit(`${AUD}?origin=web`, { key: "admin" });
    assert.equal(web.res.status, 200);
    assert.ok(web.body.includes(`<strong>${WEB_TOTAL}</strong>`), "web total honest");
    assert.ok(!web.body.includes("decay.apply"), "system-origin row absent from web filter");
    assert.ok(!web.body.includes("warnings.issue"), "slash-origin row absent from web filter");
    assert.ok(web.body.includes('value="web" selected'), "select round-trips the filter");

    const sysRows = await hit(`${AUD}?origin=system`, { key: "admin" });
    assert.equal(sysRows.res.status, 200);
    assert.equal(count(sysRows.body, 'class="row-audit"'), 1, "exactly the one system row");
    assert.ok(sysRows.body.includes("decay.apply"));
    assert.ok(sysRows.body.includes("badge-origin-system"), "origin badge");
    assert.ok(
      sysRows.body.includes("<strong>1</strong> audit entry match"),
      "honest singular count"
    );

    const slash = await hit(`${AUD}?origin=slash`, { key: "admin" });
    assert.equal(count(slash.body, 'class="row-audit"'), 1);
    assert.ok(slash.body.includes("warnings.issue"));
    assert.ok(slash.body.includes(USER_SENIOR), "actor id rendered");
    assert.ok(slash.body.includes("badge-origin-slash"));
  });

  it("invalid origin falls back to ALL with an escaped notice — never 500, never echoed", async () => {
    const junk = await hit(`${AUD}?origin=bogus`, { key: "admin" });
    assert.equal(junk.res.status, 200);
    assert.ok(junk.body.includes("Unknown origin filter ignored"), "notice shown");
    assert.ok(junk.body.includes(`<strong>${TOTAL_A}</strong>`), "fell back to unfiltered");
    assert.equal(count(junk.body, 'class="row-audit"'), PAGE_DEFAULT);
    assert.ok(!junk.body.includes("origin=bogus"), "junk never round-trips through the pager");

    const xss = await hit(`${AUD}?origin=%3Cscript%3Ezz`, { key: "admin" });
    assert.equal(xss.res.status, 200);
    assert.ok(!xss.body.includes("<script>zz"), "junk origin never echoed raw");
    assert.ok(xss.body.includes("Unknown origin filter ignored"));
  });

  it("?n=500 CLAMPS to 100 rows (hard §8.6 cap via the repo's MAX_AUDIT_LIST_LIMIT)", async () => {
    const { res, body } = await hit(`${AUD}?n=500`, { key: "admin" });
    assert.equal(res.status, 200);
    assert.equal(count(body, 'class="row-audit"'), PAGE_MAX, "exactly the 100-row cap");
    assert.ok(body.includes(`of ${TOTAL_A}`), "honest total despite clamp");
  });

  it("tail page (?o=100) shows the four probe rows newest-first with metadata", async () => {
    const { res, body } = await hit(`${AUD}?o=100`, { key: "admin" });
    assert.equal(res.status, 200);
    assert.equal(count(body, 'class="row-audit"'), 4);
    assert.ok(body.includes("showing 101–104 of 104"), "honest tail totals");
    assert.ok(body.includes("prev"), "prev link past the first page");
    assert.ok(
      body.indexOf("audit.unicode_probe") < body.indexOf("decay.apply"),
      "unicode row (BASE+4) outranks system row (BASE+3)"
    );
    assert.ok(body.includes("warnings.issue") && body.includes("settings.command_channel.add"));
  });

  it("absurd offset clamps (bounded, 200, empty state) — never deep-scans", async () => {
    const { res, body } = await hit(`${AUD}?o=999999999`, { key: "admin" });
    assert.equal(res.status, 200);
    assert.equal(count(body, 'class="row-audit"'), 0);
    assert.ok(body.includes("No audit entries match this filter."));
  });

  it("details render PRETTY-PRINTED, ESCAPED, unicode-safe and LINK-FREE", async () => {
    const { res, body } = await hit(`${AUD}?origin=web&o=100`, { key: "admin" });
    assert.equal(res.status, 200);
    assert.equal(count(body, 'class="row-audit"'), 2, "unicode + oldest web row");
    // escaped XSS payload (no raw script survives html``):
    assert.ok(
      !body.includes('<script>alert("audit-xss")</script>'),
      "stored details can never inject markup"
    );
    // (JSON.stringify escaped the inner quotes as \" — so the HTML escape
    // lands on the backslash-escaped form:)
    assert.ok(
      body.includes("&lt;script&gt;alert(\\&quot;audit-xss\\&quot;)"),
      "escaped echo instead"
    );
    // pretty-printed JSON (2-space stringify ⇒ `&quot;note&quot;: &quot;` run):
    assert.ok(body.includes("&quot;note&quot;: &quot;"), "details pretty-printed");
    // unicode passes through unmangled:
    assert.ok(body.includes("café — 日本語 🐍"), "unicode rendered as-is (escaped, not entities)");
    // LINK-FREE: the URL inside details is plain text, never an <a href>:
    assert.ok(
      !body.includes('href="https://audit-probe.example.invalid'),
      "never auto-link URLs found inside details"
    );
    assert.ok(body.includes("audit-probe.example.invalid"), "the URL is still visible as text");
  });

  it("system-origin row renders an honest no-actor dash (no fabricated actor)", async () => {
    const { body } = await hit(`${AUD}?origin=system`, { key: "admin" });
    assert.ok(body.includes('<span class="muted">—</span>'), "null actor → muted dash");
  });

  it("guild A pages never leak the guild-B audit canary (default + every filter)", async () => {
    for (const q of ["", "?origin=web", "?origin=slash", "?origin=system", "?origin=all", "?n=100"]) {
      const { body } = await hit(AUD + q, { key: "admin" });
      assert.ok(!body.includes(B_CANARY), `no canary under ${q || "default"}`);
      assert.ok(!body.includes("guild.b.canary.action"));
    }
  });
});

// ===========================================================================
// E. Secrets NEVER render — sentinel invariants + sanitized projections
// ===========================================================================
describe("§8.7 sentinel invariants — secret values never reach any page", () => {
  it("the SESSION_SECRET sentinel byte-string appears NOWHERE on /system or /audit", async () => {
    for (const url of [SYS, AUD, `${AUD}?origin=web&n=500`, `${AUD}?o=100`]) {
      const { res, body } = await hit(url, { key: "admin" });
      assert.equal(res.status, 200);
      assert.ok(
        !body.includes(SESSION_SECRET_SENTINEL),
        `${url} must not contain the session-secret sentinel`
      );
    }
  });

  it("fallback probe: SESSION_SECRET unset + CLIENT_SECRET set ⇒ source is the FALLBACK NAME, and neither value renders", async () => {
    await withEnv(
      { SESSION_SECRET: null, CLIENT_SECRET: CLIENT_SECRET_SENTINEL },
      async () => {
        // Fresh session encrypted under the FALLBACK secret (token keying
        // derives from the same resolver — decrypt works inside this window).
        const s = sessionPolicy.createSession({ userId: USER_ADMIN2 });
        api.setWebSessionAuth(s.id, {
          accessTokenEnc: tokens.encryptAccessToken(`tok-${USER_ADMIN2}`),
          tokenExpiresAt: Date.now() + 3_600_000,
          scopes: "identify guilds guilds.members.read",
          guildSnapshot: JSON.stringify([
            { id: GUILD_A, name: "A", icon: null, owner: true, permissions: "0" },
          ]),
        });
        const res = await fetch(`${suite.base}${SYS}`, {
          redirect: "manual",
          headers: { cookie: `web_session=${s.id}` },
        });
        const body = await res.text();
        assert.equal(res.status, 200);
        assert.ok(
          body.includes("<code>CLIENT_SECRET (fallback)</code>"),
          "fallback SOURCE named (§8.10 nudge)"
        );
        assert.ok(!body.includes("<code>SESSION_SECRET</code>"), "no false dedicated claim");
        assert.ok(!body.includes(SESSION_SECRET_SENTINEL), "old sentinel gone anyway");
        assert.ok(!body.includes(CLIENT_SECRET_SENTINEL), "fallback VALUE never rendered");
        sessionPolicy.destroySession(s.id);
      }
    );
  });

  it("readSessionSecretState: three honest states from env NAME presence only (unit)", () => {
    const dedicated = systemRoutes.readSessionSecretState();
    assert.deepEqual(dedicated, { configured: true, source: "SESSION_SECRET" });

    const fallback = withEnvSync(
      { SESSION_SECRET: null, CLIENT_SECRET: "fallback-name-check-NOT-REAL" },
      () => systemRoutes.readSessionSecretState()
    );
    assert.deepEqual(fallback, { configured: true, source: "CLIENT_SECRET (fallback)" });

    const unset = withEnvSync(
      { SESSION_SECRET: null, CLIENT_SECRET: null },
      () => systemRoutes.readSessionSecretState()
    );
    assert.deepEqual(unset, { configured: false, source: "unset" });
  });

  it("readWebSurfaceState never surfaces a value for the secret vars (unit)", () => {
    const state = systemRoutes.readWebSurfaceState();
    const json = JSON.stringify(state);
    assert.equal(state.sessionSecret.source, "SESSION_SECRET");
    assert.ok(!json.includes(SESSION_SECRET_SENTINEL), "state object itself is value-free");
    assert.ok(!Object.prototype.hasOwnProperty.call(state.sessionSecret, "value"));
  });
});

// ===========================================================================
// F. Viewer data-contract (Phase 1 read model — parity surface for Phase 3)
// ===========================================================================
describe("audit viewer read model — facade contract, clamps, filter normalization", () => {
  it("readOriginFilter: whitelist via normalizeAuditOrigin, junk → null+invalid, never throws", () => {
    assert.deepEqual(systemRoutes.readOriginFilter(null), { origin: null, invalid: false });
    assert.deepEqual(systemRoutes.readOriginFilter("  All "), { origin: null, invalid: false });
    assert.deepEqual(systemRoutes.readOriginFilter(" WEB "), { origin: "web", invalid: false });
    assert.deepEqual(systemRoutes.readOriginFilter("SYSTEM"), { origin: "system", invalid: false });
    assert.deepEqual(systemRoutes.readOriginFilter("DROP TABLE"), { origin: null, invalid: true });
  });

  it("buildAuditPage: guild-scoped first arg, LIMIT/OFFSET forwarded, origin only when valid (dep-instrumented)", () => {
    const seen = { list: [], count: [] };
    const page = systemRoutes.buildAuditPage(
      GUILD_A,
      { origin: "web", n: "1000", o: "40" },
      {
        listAdminAudit: (guildId, opts) => {
          seen.list.push([guildId, opts]);
          return [];
        },
        countAdminAudit: (guildId, opts) => {
          seen.count.push([guildId, opts]);
          return 0;
        },
      }
    );
    assert.deepEqual(seen.list, [[GUILD_A, { limit: 100, offset: 40, origin: "web" }]], "limit clamped to the 100 web/§8.6 budget");
    assert.deepEqual(seen.count, [[GUILD_A, { origin: "web" }]], "count honors the SAME filter (honest totals)");
    assert.equal(page.pageSize, 100);
    assert.equal(page.offset, 40);
    assert.equal(page.origin, "web");
    assert.equal(page.invalidOrigin, false);

    // Junk origin ⇒ NO origin key reaches the repo (a junk value would throw
    // INVALID_ORIGIN there — proving the whitelist runs first).
    const junkSeen = [];
    systemRoutes.buildAuditPage(GUILD_A, { origin: ";;rm" }, {
      listAdminAudit: (guildId, opts) => {
        junkSeen.push(opts);
        return [];
      },
      countAdminAudit: () => 0,
    });
    assert.equal("origin" in junkSeen[0], false, "invalid origin never reaches SQL");
  });

  it("real facade path: totals match the seed EXACTLY (guild-scoped count)", () => {
    const all = systemRoutes.buildAuditPage(GUILD_A, {});
    assert.equal(all.total, TOTAL_A);
    assert.equal(all.pageSize, PAGE_DEFAULT);
    assert.equal(all.offset, 0);
    assert.equal(all.rows.length, PAGE_DEFAULT);
    const sys = systemRoutes.buildAuditPage(GUILD_A, { origin: "system" });
    assert.equal(sys.total, 1);
    assert.equal(sys.rows[0].action, "decay.apply");
    assert.equal(sys.rows[0].actor_user_id, null);
  });
});
