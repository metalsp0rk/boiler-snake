/**
 * Fluxer PR 10 — web SESSION layer (bundle Agent B scope): the dual-cookie
 * session plumbing, community-matched CSRF/audit, the guildAccess Fluxer
 * branch, and the platform-aware display seams. FULLY OFFLINE: fake Fluxer
 * API objects, fake OutboundClient, real SQLite (sessions/communities/staff
 * rows), node --test only. Mirrors the createWebApp injection pattern of
 * test/web-tier-middleware.test.js and test/web-auth-login.test.js.
 *
 * Suites:
 *  A. computeExpiry unit: Fluxer 30-day refresh horizon vs 12h idle; Discord
 *     stays the 7-day clamp; 2-arg calls byte-identical (C2).
 *  B. Cookie serialization: buildFluxerSessionCookie / buildClearFluxerSession
 *     Cookie use ONLY the web_session_fx name (K11); Discord builder unchanged.
 *  C. webSessions repo (C3): platform/instance_key/refresh columns round-trip
 *     through createWebSession / getWebSession / setWebSessionAuth.
 *  D. Session middleware (C7): cookie/platform isolation through createWebApp
 *     with injected stubs — a Fluxer id in web_session is DROPPED; a Discord
 *     cookie leaves req.fluxerSession null; the mismatch warn fires.
 *  E. guildScope/audit/CSRF over HTTP (C8/C9/C10): Fluxer community + Discord
 *     session ⇒ generic 404; Fluxer session ⇒ req.user is the Fluxer subject;
 *     mutations audit the Fluxer user id; a Discord-derived CSRF token 403s on
 *     a Fluxer community while the community-matched token passes.
 *  F. guildAccess Fluxer resolve matrix (C10): anon / platform-mismatch deny /
 *     instance-mismatch deny / no_token / expired-without-refresh reauth /
 *     admin-via-snapshot (no member fetch) / staff via bot fetchMember /
 *     fetch-failure deny+degraded (the §8.3 row-2 mirror).
 *  G. Fluxer refresh ROTATION (C10): 24h window ⇒ refreshToken issued BEFORE
 *     listCurrentUserGuilds, the rotated pair PERSISTED BEFORE USE (asserted
 *     via a scripted api spy that decrypts the stored row at call time), the
 *     second resolve uses the new pair, and invalid_grant ⇒ reauth
 *     token_revoked (old pair untouched).
 *  H. discord-cache + memberFetchQueue (C11): Fluxer routing issues
 *     outbound.fetchUser and NEVER touches the Discord cache; the numeric-key
 *     queue drains through the OutboundClient; legacy string-snowflake keys
 *     keep the Discord path; non-numeric junk logs + returns 0.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const fs = require("fs");
const { once } = require("node:events");
const { loadDb, communityKey } = require("./helpers/env");

// ---------------------------------------------------------------------------
// loadDb() FIRST: clears the src require cache and binds DB_PATH to a temp
// file, so every src module below runs against the test DB.
// ---------------------------------------------------------------------------
const { api, tmpDir, cleanup } = loadDb();

const sessions = require("../src/web/auth/sessions");
const tokens = require("../src/web/auth/tokens");
const { createGuildAccessResolver } = require("../src/web/auth/guildAccess");
const { createSessionMiddleware } = require("../src/web/middleware/session");
const { createCsrfMiddleware, deriveCsrfToken } = require("../src/web/middleware/csrf");
const { createAuditMiddleware } = require("../src/web/middleware/audit");
const { createGuildScopeMiddleware } = require("../src/web/middleware/guildScope");
const discordCache = require("../src/web/routes/shared/discord-cache");
const queue = require("../src/web/services/memberFetchQueue");

// Clearly-fake placeholder secret (AGENTS.md: never real-looking secrets).
const SESSION_SECRET = "test-f…-xyz";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TTL_MS = 12 * HOUR; // pinned via WEB_SESSION_TTL_HOURS=12

const FX_ORIGIN = "https://fluxer.test";
const FX_OTHER = "https://other-fluxer.test";
const FX_API = "https://fluxer.test/v1";
const FX_USER = "777000000000000001"; // Fluxer userinfo `sub`
const DISC_USER = "428190112345678901";
const FX_GUILD = "991000000000000001"; // external guild id on FX_ORIGIN
const LEGACY_GUILD = "199256932081467392"; // 18-digit: never a community id
const ROLE_JUNIOR = "500000000000000011";
const BOT_USER = "777000000000000999";

const ENV_KEYS = [
  "SESSION_SECRET",
  "CLIENT_SECRET",
  "PUBLIC_BASE_URL",
  "WEB_SESSION_TTL_HOURS",
  "WEB_RATE_LIMIT_AUTH_MAX",
  "WEB_RATE_LIMIT_AUTH_USER_MAX",
  "WEB_RATE_LIMIT_MUTATION_MAX",
];
let savedEnv;

// Community ids (created after loadDb; stable for the whole file).
let CID_FX; // fluxer community on FX_ORIGIN
let CID_FX_B; // fluxer community on the OTHER instance
let CID_DISC; // discord community

before(() => {
  savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
  process.env.SESSION_SECRET = SESSION_SECRET;
  delete process.env.CLIENT_SECRET;
  delete process.env.PUBLIC_BASE_URL;
  process.env.WEB_SESSION_TTL_HOURS = "12";
  process.env.WEB_RATE_LIMIT_AUTH_MAX = "100000";
  process.env.WEB_RATE_LIMIT_AUTH_USER_MAX = "100000";
  process.env.WEB_RATE_LIMIT_MUTATION_MAX = "100000";
  CID_FX = communityKey(FX_GUILD, "fluxer", FX_ORIGIN);
  CID_FX_B = communityKey("991000000000000002", "fluxer", FX_OTHER);
  CID_DISC = communityKey(LEGACY_GUILD, "discord", "discord");
  api.addStaffRole(CID_FX, ROLE_JUNIOR, "junior");
});

after(async () => {
  queue.stopMemberFetchQueue();
  discordCache.setCommunityClientProvider(null);
  api.removeStaffRole(CID_FX, ROLE_JUNIOR);
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

/** Let fire-and-forget promise chains settle (warm fetches). */
function ticks(n = 5) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => setImmediate(r)));
  return p;
}

// ===========================================================================
// A. computeExpiry — platform branch (C2, spec §Session columns and cookies)
// ===========================================================================
describe("computeExpiry platform branch", () => {
  const C = 1_700_000_000_000; // fixed created_at (unix ms)

  it("Discord: 2-arg call keeps min(now + TTL, created + 7d) byte-identically", () => {
    assert.equal(sessions.computeExpiry(C, C + DAY), C + DAY + TTL_MS); // idle
    assert.equal(sessions.computeExpiry(C, C + 7 * DAY), C + 7 * DAY); // clamped
    assert.equal(sessions.computeExpiry(C, C + 30 * DAY), C + 7 * DAY); // past cap
  });

  it("Fluxer: 12h idle inside the window; the 30d refresh horizon clamps beyond it", () => {
    const fx = { platform: "fluxer", refreshExpiresAt: C + 30 * DAY };
    assert.equal(sessions.computeExpiry(C, C + DAY, fx), C + DAY + TTL_MS); // idle
    assert.equal(sessions.computeExpiry(C, C + 29 * DAY + 13 * HOUR, fx), C + 30 * DAY);
    assert.equal(sessions.computeExpiry(C, C + 40 * DAY, fx), C + 30 * DAY); // never past
  });

  it("Fluxer without an explicit horizon defaults to created + 30d (spec formula)", () => {
    const fx = { platform: "fluxer", refreshExpiresAt: null };
    assert.equal(sessions.computeExpiry(C, C + 40 * DAY, fx), C + 30 * DAY);
  });

  it("a discord-shaped 3rd argument keeps the 7-day clamp", () => {
    assert.equal(
      sessions.computeExpiry(C, C + 8 * DAY, { platform: "discord", refreshExpiresAt: C + 30 * DAY }),
      C + 7 * DAY
    );
  });

  it("createSession + toSession carry platform/instanceKey/refreshExpiresAt", () => {
    const refreshExpiresAt = Date.now() + 30 * DAY;
    const s = sessions.createSession(
      { userId: FX_USER, platform: "fluxer", instanceKey: FX_ORIGIN, refreshExpiresAt },
      Date.now()
    );
    assert.equal(s.platform, "fluxer");
    assert.equal(s.instanceKey, FX_ORIGIN);
    assert.equal(s.refreshExpiresAt, refreshExpiresAt);
    assert.ok(s.expiresAt > Date.now());
    const row = api.getWebSession(s.id);
    assert.equal(row.platform, "fluxer");
    assert.equal(row.instance_key, FX_ORIGIN);
    assert.equal(row.refresh_expires_at, s.refreshExpiresAt);
    // Sliding idle applies at creation: min(now+12h, created+30d) = 12h-ish.
    assert.ok(s.expiresAt - Date.now() <= TTL_MS + 5_000);
  });
});

// ===========================================================================
// B. Cookie helpers (C2, K11) — one Fluxer name, never the Discord one
// ===========================================================================
describe("Fluxer cookie helpers (K11)", () => {
  const id = "ab".repeat(32); // 64 hex chars

  it("buildFluxerSessionCookie uses ONLY web_session_fx with the standard attributes", () => {
    const cookie = sessions.buildFluxerSessionCookie(id);
    assert.ok(cookie.startsWith(`web_session_fx=${id}; `));
    assert.ok(cookie.includes("Path=/"));
    assert.ok(cookie.includes("HttpOnly"));
    assert.ok(cookie.includes("SameSite=Lax"));
    assert.ok(cookie.includes(`Max-Age=${sessions.sessionCookieMaxAgeSec()}`));
    assert.ok(!cookie.includes("web_session="), "must never touch the Discord cookie name");
  });

  it("buildClearFluxerSessionCookie clears web_session_fx (empty value, Max-Age=0)", () => {
    const cookie = sessions.buildClearFluxerSessionCookie();
    assert.ok(cookie.startsWith("web_session_fx=; "));
    assert.ok(cookie.includes("Max-Age=0"));
    assert.ok(!cookie.includes("web_session=;"));
  });

  it("the Discord builder is untouched and refuses malformed ids", () => {
    const cookie = sessions.buildSessionCookie(id);
    assert.ok(cookie.startsWith(`web_session=${id}; `));
    assert.throws(() => sessions.buildFluxerSessionCookie("zz"), TypeError);
  });
});

// ===========================================================================
// C. webSessions repo (C3) — the 034 columns round-trip
// ===========================================================================
describe("webSessions repo (C3)", () => {
  it("setWebSessionAuth persists and getWebSessionAuth returns the refresh pair", () => {
    const s = sessions.createSession({ userId: FX_USER, platform: "fluxer", instanceKey: FX_ORIGIN });
    const atEnc = tokens.encryptAccessToken("AT-rot");
    const rtEnc = tokens.encryptAccessToken("RT-rot");
    const expiresAt = Date.now() + 6 * 60 * 60 * 1000;
    const refreshExpiresAt = Date.now() + 30 * DAY;
    assert.equal(
      api.setWebSessionAuth(s.id, {
        accessTokenEnc: atEnc,
        tokenExpiresAt: expiresAt,
        scopes: "identify guilds",
        guildSnapshot: JSON.stringify([{ id: FX_GUILD, name: "FX", icon: null, owner: true, permissions: "0" }]),
        refreshTokenEnc: rtEnc,
        refreshExpiresAt,
      }),
      true
    );
    const auth = api.getWebSessionAuth(s.id);
    assert.equal(tokens.decryptAccessToken(auth.access_token_enc), "AT-rot");
    assert.equal(tokens.decryptAccessToken(auth.refresh_token_enc), "RT-rot");
    assert.equal(auth.token_expires_at, expiresAt);
    assert.equal(auth.refresh_expires_at, refreshExpiresAt);
  });

  it("Discord writes keep the new columns NULL (byte-identical defaults)", () => {
    const s = sessions.createSession({ userId: DISC_USER });
    api.setWebSessionAuth(s.id, { accessTokenEnc: tokens.encryptAccessToken("AT-d") });
    const auth = api.getWebSessionAuth(s.id);
    assert.equal(auth.refresh_token_enc, null);
    assert.equal(auth.refresh_expires_at, null);
  });
});

// ===========================================================================
// D. Session middleware — cookie/platform isolation via createWebApp (C7)
// ===========================================================================
describe("session middleware cookie isolation (C7)", () => {
  /** @type {import("http").Server} */
  let server;
  let base;
  let warnLines = [];

  let fxId, discId;

  before(async () => {
    fxId = sessions.createSession({ userId: FX_USER, platform: "fluxer", instanceKey: FX_ORIGIN }).id;
    discId = sessions.createSession({ userId: DISC_USER }).id;

    // The session middleware is exercised on its OWN chain: createWebApp's
    // app registers a terminal catch-all, so a probe route appended AFTER
    // createWebApp() can never match (the 404 responder wins). Suite E shows
    // the working pattern: bare express + the shipped middleware.
    const app = express();
    app.disable("x-powered-by");
    app.use(createSessionMiddleware());
    app.get("/probe", (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        d: req.webSession ? req.webSession.id : null,
        dd: req.discordSession ? req.discordSession.id : null,
        f: req.fluxerSession ? req.fluxerSession.id : null,
        u: req.user ? req.user.userId : null,
      }));
    });
    server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) {
      server.close();
      await once(server, "close");
    }
  });

  async function probe(cookie) {
    const res = await fetch(`${base}/probe`, {
      headers: cookie ? { cookie } : undefined,
    });
    return res.json();
  }

  it("a Fluxer session id in the Discord cookie is DROPPED (+ warn), req stays anon", async () => {
    const realWarn2 = console.warn;
    warnLines = [];
    console.warn = (...a) => warnLines.push(a.join(" "));
    try {
      const body = await probe(`web_session=${fxId}`);
      assert.equal(body.d, null, "req.webSession must not honor a fluxer row");
      assert.equal(body.dd, null);
      assert.equal(body.u, null, "no identity from a mismatched cookie");
      assert.ok(
        warnLines.some((l) => l.includes("[web] session cookie/platform mismatch")),
        "the mismatch is logged"
      );
      assert.ok(
        !warnLines.some((l) => l.includes(fxId)),
        "the session id (secret material) is never logged"
      );
    } finally {
      console.warn = realWarn2;
    }
  });

  it("a valid Discord cookie leaves req.fluxerSession null", async () => {
    const body = await probe(`web_session=${discId}`);
    assert.equal(body.d, discId);
    assert.equal(body.dd, discId);
    assert.equal(body.f, null);
    assert.equal(body.u, DISC_USER);
  });

  it("a valid Fluxer cookie attaches ONLY req.fluxerSession", async () => {
    const body = await probe(`web_session_fx=${fxId}`);
    assert.equal(body.f, fxId);
    assert.equal(body.d, null, "Fluxer identity never impersonates the Discord slot");
    assert.equal(body.u, null);
  });

  it("a Discord session id in the Fluxer cookie is DROPPED", async () => {
    const body = await probe(`web_session_fx=${discId}`);
    assert.equal(body.f, null);
  });
});

// ===========================================================================
// E. guildScope + audit + CSRF over HTTP (C8/C9/C10)
// ===========================================================================
describe("guildScope + audit + CSRF over HTTP (C8/C9/C10)", () => {
  /** @type {import("http").Server} */
  let server;
  let base;

  const liveInstances = () => [
    {
      instanceKey: FX_ORIGIN,
      slug: "0000000000000000",
      label: "FX",
      clientId: "cid",
      clientSecret: "secret",
      apiBase: FX_API,
    },
  ];
  const liveApi = {
    async listCurrentUserGuilds() {
      return [
        { id: FX_GUILD, name: "FX Guild", icon: null, owner: false, permissions: "104324673" },
      ];
    },
  };
  const outbound = {
    botUserId: BOT_USER,
    async fetchMember(cid, userId) {
      return { id: userId, username: "fx-user", bot: false, roleIds: [ROLE_JUNIOR] };
    },
  };

  const resolver = createGuildAccessResolver({
    getFluxerWebInstances: liveInstances,
    getCommunityClient: (cid) => (cid === CID_FX ? outbound : null),
    fluxerTokenApi: (apiBase) => {
      assert.equal(apiBase, FX_API);
      return liveApi;
    },
    ttlMs: 60_000,
  });

  const cookieOf = {};
  const csrfOf = {};
  let fxSessionId;

  before(async () => {
    const app = express();
    app.disable("x-powered-by");
    app.use(createSessionMiddleware());
    app.use(createAuditMiddleware());
    app.use(createCsrfMiddleware());
    app.use("/g/:guildId", createGuildScopeMiddleware({ resolver }));
    app.get("/g/:guildId", (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ user: req.user, access: req.guildAccess }));
    });
    app.post("/g/:guildId/probe", (req, res) => {
      const row = req.audit({ action: "fluxertest.probe", details: { note: "gate" } });
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ user: req.user, actor: row.actor_user_id }));
    });
    server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;

    const fx = sessions.createSession({ userId: FX_USER, platform: "fluxer", instanceKey: FX_ORIGIN });
    fxSessionId = fx.id;
    api.setWebSessionAuth(fx.id, {
      accessTokenEnc: tokens.encryptAccessToken("AT-e"),
      tokenExpiresAt: Date.now() + 72 * HOUR, // outside the refresh window
      scopes: "identify guilds",
      guildSnapshot: JSON.stringify([
        { id: FX_GUILD, name: "FX Guild", icon: null, owner: false, permissions: "104324673" },
      ]),
      refreshTokenEnc: tokens.encryptAccessToken("RT-e"),
      refreshExpiresAt: Date.now() + 30 * DAY,
    });
    const disc = sessions.createSession({ userId: DISC_USER });
    cookieOf.fx = `web_session_fx=${fx.id}`;
    cookieOf.disc = `web_session=${disc.id}`;
    csrfOf.fx = deriveCsrfToken(fx.id, SESSION_SECRET);
    csrfOf.disc = deriveCsrfToken(disc.id, SESSION_SECRET);
  });

  after(async () => {
    if (server) {
      server.close();
      await once(server, "close");
    }
  });

  it("Fluxer community + Discord session ⇒ generic 404 (no enumeration, no 403/302)", async () => {
    const r = await fetch(`${base}/g/${CID_FX}`, { headers: { cookie: cookieOf.disc } });
    assert.equal(r.status, 404, "a Discord cookie cannot open a Fluxer community (spec L983)");
    assert.equal(await r.text(), "Not found");
  });

  it("Fluxer community + matching Fluxer session ⇒ 200 + req.user is the Fluxer sub", async () => {
    const r = await fetch(`${base}/g/${CID_FX}`, { headers: { cookie: cookieOf.fx } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.user.userId, FX_USER);
    assert.equal(body.user.discordTag, null);
    assert.equal(body.access.tier, "staff", "roleIds ∩ staff_roles (real SQLite junior row)");
    assert.equal(body.access.communityId, CID_FX);
    assert.equal(body.access.guildId, FX_GUILD);
    assert.equal(body.access.degraded, false);
  });

  it("anonymous ⇒ 302 login redirect (today's byte-identical anon flow)", async () => {
    const r = await fetch(`${base}/g/${CID_FX}`, { redirect: "manual" });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/auth/login");
  });

  it("CSRF: a Discord-derived token on a Fluxer-community mutation is DENIED (spec: anonymous ⇒ generic 404)", async () => {
    // roadmap/fluxer.md § Session columns and cookies: "a Discord cookie
    // presented to a Fluxer community becomes anonymous on that route
    // (req.user is null, generic 404 from the resolver), even if
    // req.discordSession is live." The CSRF token derives from the
    // COMMUNITY-MATCHED session, so the Discord-derived token grants
    // nothing; the request reaches the resolver as an anon request and
    // guildScope answers with the SAME generic 404 every deny uses —
    // the mutation handler (req.audit) never runs.
    const r = await fetch(`${base}/g/${CID_FX}/probe`, {
      method: "POST",
      headers: { cookie: cookieOf.disc, "x-csrf-token": csrfOf.disc },
    });
    assert.equal(r.status, 404, "cross-platform credentials degrade to anonymous, never to a tier grant");
    assert.equal(await r.text(), "Not found");
    const rows = api.listAdminAudit(CID_FX, { limit: 10 });
    assert.ok(
      !rows.some((row) => row.action === "fluxertest.probe" && String(row.actor_user_id) === DISC_USER),
      "the mutation never executed under Discord credentials"
    );
  });

  it("CSRF: the community-matched (Fluxer) token passes AND the audit row names the Fluxer subject", async () => {
    const r = await fetch(`${base}/g/${CID_FX}/probe`, {
      method: "POST",
      headers: { cookie: cookieOf.fx, "x-csrf-token": csrfOf.fx },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.user.userId, FX_USER, "guildScope re-points req.user at the Fluxer session");
    assert.equal(body.actor, FX_USER, "admin_audit records the Fluxer subject, not the Discord user");
    const rows = api.listAdminAudit(CID_FX, { limit: 10 });
    assert.ok(
      rows.some((row) => row.action === "fluxertest.probe" && String(row.actor_user_id) === FX_USER),
      "the trail row exists under the Fluxer user id"
    );
  });
});

// ===========================================================================
// F. guildAccess Fluxer resolve matrix (C10)
// ===========================================================================
describe("guildAccess fluxer resolve matrix (C10)", () => {
  function fxSession(overrides = {}) {
    const s = sessions.createSession({
      userId: FX_USER,
      platform: "fluxer",
      instanceKey: FX_ORIGIN,
      ...overrides,
    });
    return s;
  }

  function makeResolver(over = {}) {
    return createGuildAccessResolver({
      getFluxerWebInstances: () => [
        {
          instanceKey: FX_ORIGIN,
          slug: "0",
          label: "FX",
          clientId: "cid",
          clientSecret: "secret",
          apiBase: FX_API,
        },
      ],
      getCommunityClient: () => null,
      fluxerTokenApi: () => ({
        async listCurrentUserGuilds() {
          return [{ id: FX_GUILD, name: "FX", icon: null, owner: false, permissions: "104324673" }];
        },
      }),
      ttlMs: 60_000,
      ...over,
    });
  }

  it("null session ⇒ anon", async () => {
    assert.deepEqual(await makeResolver().resolve(null, CID_FX), { status: "anon" });
  });

  it("a DISCORD session against a Fluxer community ⇒ deny not_in_access_list (generic 404)", async () => {
    const disc = sessions.createSession({ userId: DISC_USER });
    const res = await makeResolver().resolve(disc, CID_FX);
    assert.equal(res.status, "deny");
    assert.equal(res.reason, "not_in_access_list");
  });

  it("a Fluxer session for ANOTHER instance ⇒ deny (instance-scoped identity)", async () => {
    const s = fxSession({ instanceKey: FX_OTHER });
    // Session says FX_OTHER; the community is on FX_OTHER for CID_FX_B (match),
    // on FX_ORIGIN for CID_FX (mismatch).
    assert.equal((await makeResolver().resolve(s, CID_FX)).reason, "not_in_access_list");
    const r2 = await makeResolver().resolve(s, CID_FX_B);
    assert.equal(r2.status, "reauth", "the instance-matched community is reachable (token check next)");
    assert.equal(r2.reason, "no_token");
  });

  it("a FLUXER session against a Discord community ⇒ deny", async () => {
    const s = fxSession();
    const res = await makeResolver().resolve(s, CID_DISC);
    assert.equal(res.status, "deny");
    assert.equal(res.reason, "not_in_access_list");
  });

  it("no token row ⇒ reauth no_token", async () => {
    const s = fxSession();
    const res = await makeResolver().resolve(s, CID_FX);
    assert.deepEqual(res, { status: "reauth", reason: "no_token" });
  });

  it("expired AT with NO refresh token ⇒ reauth token_expired (spec: no refresh branch)", async () => {
    const s = fxSession();
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken("AT-x"),
      tokenExpiresAt: Date.now() - 1000,
      scopes: "identify guilds",
      guildSnapshot: "[]",
    });
    const res = await makeResolver().resolve(s, CID_FX);
    assert.deepEqual(res, { status: "reauth", reason: "token_expired" });
  });

  it("admin fast path: granting LIVE entry needs NO member fetch and survives a missing client", async () => {
    // Mirror of the Discord path (getAccessGuilds): the LIVE guild list entry
    // is the tier input; the stored snapshot is the degraded-fallback source
    // only. So the ADMIN grant must appear on the live list — a snapshot with
    // owner:true and a non-admin live entry resolves NO admin (the user's
    // current permissions win over login-time data).
    const s = fxSession();
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken("AT-ok"),
      tokenExpiresAt: Date.now() + 72 * HOUR,
      scopes: "identify guilds",
      guildSnapshot: JSON.stringify([{ id: FX_GUILD, name: "FX", icon: null, owner: true, permissions: "0" }]),
    });
    let memberFetches = 0;
    const res = await makeResolver({
      fluxerTokenApi: () => ({
        async listCurrentUserGuilds() {
          return [{ id: FX_GUILD, name: "FX", icon: null, owner: true, permissions: "8" }];
        },
      }),
      getCommunityClient: (cid) =>
        cid === CID_FX
          ? { async fetchMember() { memberFetches++; return null; } }
          : null,
    }).resolve(s, CID_FX);
    assert.equal(res.status, "ok");
    assert.equal(res.tier, "admin", "owner===true on the live entry is the admin fast path (§8.3 / spec item 4)");
    assert.equal(memberFetches, 0, "the admin fast path skips the member fetch entirely");
    assert.equal(res.degraded, false);
  });

  it("staff tier via the BOT fetchMember + staff_roles rows", async () => {
    const s = fxSession();
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken("AT-ok"),
      tokenExpiresAt: Date.now() + 72 * HOUR,
      scopes: "identify guilds",
      guildSnapshot: JSON.stringify([{ id: FX_GUILD, name: "FX", icon: null, owner: false, permissions: "0" }]),
    });
    const res = await makeResolver({
      getCommunityClient: (cid) =>
        cid === CID_FX
          ? { async fetchMember() { return { id: FX_USER, username: "fx", bot: false, roleIds: [ROLE_JUNIOR] }; } }
          : null,
    }).resolve(s, CID_FX);
    assert.equal(res.status, "ok");
    assert.equal(res.tier, "staff");
  });

  it("member fetch unresolvable (null member) ⇒ deny roles_unavailable + retry + degraded", async () => {
    const s = fxSession();
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken("AT-ok"),
      tokenExpiresAt: Date.now() + 72 * HOUR,
      scopes: "identify guilds",
      guildSnapshot: JSON.stringify([{ id: FX_GUILD, name: "FX", icon: null, owner: false, permissions: "0" }]),
    });
    const res = await makeResolver({
      getCommunityClient: () => ({ async fetchMember() { return null; } }),
    }).resolve(s, CID_FX);
    assert.equal(res.status, "deny");
    assert.equal(res.reason, "roles_unavailable");
    assert.equal(res.retry, true);
    assert.equal(res.degraded, true, "operator banner flag (spec §Guild intersection item 6)");
  });

  it("a snapshot guild the user is NOT in ⇒ deny not_in_access_list", async () => {
    const s = fxSession();
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken("AT-ok"),
      tokenExpiresAt: Date.now() + 72 * HOUR,
      scopes: "identify guilds",
      // Snapshot contains a guild the (fake) user list does not return.
      guildSnapshot: JSON.stringify([{ id: "991000000000000009", owner: true, permissions: "0" }]),
    });
    const res = await makeResolver().resolve(s, CID_FX);
    assert.equal(res.status, "deny");
    assert.equal(res.reason, "not_in_access_list", "user-list ∩ snapshot gates the tier (§ item 2)");
  });

  it("guild-list fetch failure falls back to the stored snapshot (degraded, admin stands)", async () => {
    const s = fxSession();
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken("AT-ok"),
      tokenExpiresAt: Date.now() + 72 * HOUR,
      scopes: "identify guilds",
      guildSnapshot: JSON.stringify([{ id: FX_GUILD, name: "FX", icon: null, owner: true, permissions: "0" }]),
    });
    const boom = () => Object.assign(new Error("fluxer 503"), { status: 503 });
    const res = await makeResolver({
      fluxerTokenApi: () => ({ async listCurrentUserGuilds() { throw boom(); } }),
    }).resolve(s, CID_FX);
    assert.equal(res.status, "ok");
    assert.equal(res.tier, "admin");
    assert.equal(res.degraded, true, "stored-snapshot fallback is flagged (§8.3 row 3)");
  });
});

// ===========================================================================
// G. Fluxer refresh rotation (C10 — the persist-before-use contract)
// ===========================================================================
describe("guildAccess fluxer token rotation (C10)", () => {
  const ROT_GUILD = FX_GUILD;

  function rotSession() {
    return sessions.createSession({
      userId: FX_USER,
      platform: "fluxer",
      instanceKey: FX_ORIGIN,
      refreshExpiresAt: Date.now() + 30 * DAY,
    });
  }

  function rotApiFactory(log) {
    return function factory(apiBase) {
      assert.equal(apiBase, FX_API);
      return {
        async refreshToken({ refreshToken, clientId, clientSecret }) {
          log.push({ method: "refreshToken", refreshToken, clientId, clientSecret });
          const err = new Error("invalid_grant");
          err.code = "fluxer_refresh_denied";
          err.status = 400;
          throw err;
        },
        async listCurrentUserGuilds() {
          return [{ id: ROT_GUILD, name: "FX", icon: null, owner: true, permissions: "0" }];
        },
      };
    };
  }

  it("24h window: refresh is issued BEFORE the guild list and the pair persists first", async () => {
    const s = rotSession();
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken("AT-1"),
      tokenExpiresAt: Date.now() + 1 * HOUR, // INSIDE the 24h window
      scopes: "identify guilds",
      guildSnapshot: JSON.stringify([{ id: ROT_GUILD, name: "FX", icon: null, owner: true, permissions: "0" }]),
      refreshTokenEnc: tokens.encryptAccessToken("RT-1"),
      refreshExpiresAt: Date.now() + 30 * DAY,
    });

    const log = [];
    const resolver = createGuildAccessResolver({
      getFluxerWebInstances: () => [
        { instanceKey: FX_ORIGIN, slug: "0", label: "FX", clientId: "cid", clientSecret: "secret", apiBase: FX_API },
      ],
      getCommunityClient: () => null,
      fluxerTokenApi: () => ({
        async refreshToken({ refreshToken, clientId, clientSecret }) {
          log.push({ method: "refreshToken", refreshToken, clientId, clientSecret });
          return {
            accessToken: "AT-2",
            expiresAt: Date.now() + 7 * DAY,
            refreshToken: "RT-2",
            refreshExpiresAt: Date.now() + 30 * DAY,
            scopes: "identify guilds",
          };
        },
        async listCurrentUserGuilds(token) {
          // PERSIST-BEFORE-USE proof: at the moment the new access token is
          // USED, the stored row must already decrypt to that same token.
          const row = api.getWebSessionAuth(s.id);
          let stored = "undecryptable";
          try {
            stored = tokens.decryptAccessToken(row.access_token_enc);
          } catch {
            /* keep marker */
          }
          log.push({ method: "listCurrentUserGuilds", token, stored });
          return [{ id: ROT_GUILD, name: "FX", icon: null, owner: true, permissions: "0" }];
        },
      }),
      ttlMs: 0, // force fresh guild-list fetch every resolve
    });

    const first = await resolver.resolve(s, CID_FX);
    assert.equal(first.status, "ok");
    assert.equal(first.tier, "admin");

    const refreshAt = log.findIndex((e) => e.method === "refreshToken");
    const listAt = log.findIndex((e) => e.method === "listCurrentUserGuilds");
    assert.equal(refreshAt, 0, "refreshToken is the FIRST fluxer API call");
    assert.ok(listAt > refreshAt, "listCurrentUserGuilds runs AFTER the refresh (rotation before use)");
    assert.equal(log[refreshAt].refreshToken, "RT-1", "the stored refresh token is what gets presented");
    assert.equal(log[refreshAt].clientId, "cid");
    assert.equal(log[refreshAt].clientSecret, "secret");
    assert.equal(log[listAt].token, "AT-2", "the rotated access token is the one used for API calls");
    assert.equal(log[listAt].stored, "AT-2", "PERSIST-BEFORE-USE: the row already carried AT-2 at use time");

    // The rotated pair is durably stored; the login snapshot survives rotation.
    const auth = api.getWebSessionAuth(s.id);
    assert.equal(tokens.decryptAccessToken(auth.access_token_enc), "AT-2");
    assert.equal(tokens.decryptAccessToken(auth.refresh_token_enc), "RT-2");
    assert.ok(auth.token_expires_at > Date.now() + 6 * DAY);
    const snapshot = JSON.parse(auth.guild_snapshot);
    assert.equal(snapshot[0].id, ROT_GUILD, "rotation never blanks the guild snapshot");

    // SECOND resolve: the stored pair is now fresh (7d out) ⇒ NO second refresh,
    // and the guild list uses the new access token.
    const second = await resolver.resolve(s, CID_FX);
    assert.equal(second.status, "ok");
    assert.equal(
      log.filter((e) => e.method === "refreshToken").length,
      1,
      "the rotated expiry sits outside the 24h window — no re-refresh"
    );
    const lastList = log.filter((e) => e.method === "listCurrentUserGuilds").at(-1);
    assert.equal(lastList.token, "AT-2", "the second resolve uses the rotated pair");
  });

  it("invalid_grant ⇒ reauth token_revoked and the stored pair is untouched", async () => {
    const s = rotSession();
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken("AT-keep"),
      tokenExpiresAt: Date.now() + 1 * HOUR,
      scopes: "identify guilds",
      guildSnapshot: "[]",
      refreshTokenEnc: tokens.encryptAccessToken("RT-keep"),
      refreshExpiresAt: Date.now() + 30 * DAY,
    });
    const log = [];
    const resolver = createGuildAccessResolver({
      getFluxerWebInstances: () => [
        { instanceKey: FX_ORIGIN, slug: "0", label: "FX", clientId: "cid", clientSecret: "secret", apiBase: FX_API },
      ],
      getCommunityClient: () => null,
      fluxerTokenApi: rotApiFactory(log),
      ttlMs: 0,
    });
    const res = await resolver.resolve(s, CID_FX);
    assert.equal(res.status, "reauth");
    assert.equal(res.reason, "token_revoked");
    assert.equal(log.filter((e) => e.method === "refreshToken").length, 1, "the dead grant is never retried");
    const auth = api.getWebSessionAuth(s.id);
    assert.equal(tokens.decryptAccessToken(auth.access_token_enc), "AT-keep", "denied rotation never rewrites the row");
    assert.equal(tokens.decryptAccessToken(auth.refresh_token_enc), "RT-keep");
  });

  it("missing creds (instance not configured) ⇒ reauth token_revoked", async () => {
    const s = rotSession();
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken("AT-nc"),
      tokenExpiresAt: Date.now() + 1 * HOUR,
      scopes: "identify guilds",
      guildSnapshot: "[]",
      refreshTokenEnc: tokens.encryptAccessToken("RT-nc"),
      refreshExpiresAt: Date.now() + 30 * DAY,
    });
    const resolver = createGuildAccessResolver({
      getFluxerWebInstances: () => [], // instance entry vanished ⇒ no creds
      getCommunityClient: () => null,
      ttlMs: 0,
    });
    const res = await resolver.resolve(s, CID_FX);
    assert.equal(res.status, "reauth");
    assert.equal(res.reason, "token_revoked");
  });
});

// ===========================================================================
// H. discord-cache + memberFetchQueue Fluxer routing (C11)
// ===========================================================================
describe("display seams route Fluxer off the Discord cache (C11)", () => {
  let outboundCalls;
  let discordGuildReads;
  const USERS = {
    "111000000000000001": { id: "111000000000000001", username: "Aster", bot: false },
    [BOT_USER]: { id: BOT_USER, username: "BotAccount", bot: true },
  };

  function fakeOutbound() {
    return {
      botUserId: BOT_USER,
      async fetchUser(cid, userId) {
        outboundCalls.push(`fetchUser:${cid}:${userId}`);
        return USERS[userId] ?? null;
      },
      async fetchMember(cid, userId) {
        outboundCalls.push(`fetchMember:${cid}:${userId}`);
        return { id: userId, username: "u", bot: false, roleIds: [] };
      },
    };
  }

  const recordingDiscordClient = {
    guilds: { cache: { get: (id) => { discordGuildReads.push(String(id)); return undefined; } } },
    users: { cache: { get: () => undefined } },
  };

  before(() => {
    outboundCalls = [];
    discordGuildReads = [];
  });

  it("resolveMemberNames warms via outbound.fetchUser and NEVER touches the Discord cache", async () => {
    discordCache.setCommunityClientProvider((cid) => (cid === CID_FX ? fakeOutbound() : null));
    const names = discordCache.resolveMemberNames(() => recordingDiscordClient, CID_FX, ["111000000000000001"]);
    assert.equal(names.get("111000000000000001"), null, "first render is id-only (cache-only doctrine)");
    // The warm is fire-and-forget: the fetchUser call lands on a microtask,
    // so its bookkeeping is visible only after the queue drains.
    await ticks();
    assert.deepEqual(outboundCalls, [`fetchUser:${CID_FX}:111000000000000001`], "fetchUser issued on the OUTBOUND client");
    assert.ok(
      !discordGuildReads.includes(String(CID_FX)) && !discordGuildReads.includes("111000000000000001"),
      "the Discord guild/member cache is never consulted for a Fluxer community"
    );
    const named = discordCache.resolveMemberNames(() => recordingDiscordClient, CID_FX, ["111000000000000001"]);
    assert.equal(named.get("111000000000000001"), "Aster", "the warmed name shows up on the NEXT render");
  });

  it("isProvenBot uses the outbound bot identity, not the Discord cache", async () => {
    assert.equal(
      discordCache.isProvenBot(recordingDiscordClient, CID_FX, BOT_USER),
      false,
      "unknown ⇒ unproven (fail-open for humans)"
    );
    discordCache.resolveMemberNames(() => recordingDiscordClient, CID_FX, [BOT_USER]);
    await ticks();
    assert.equal(discordCache.isProvenBot(recordingDiscordClient, CID_FX, BOT_USER), true);
    assert.ok(
      !discordGuildReads.includes(String(CID_FX)),
      "proving a Fluxer bot never reads the Discord cache (spec L760)"
    );
  });

  it("legacy string-snowflake arguments keep the Discord path (byte-identical)", () => {
    const names = discordCache.resolveMemberNames(() => recordingDiscordClient, LEGACY_GUILD, ["999"]);
    assert.equal(names.get("999"), null);
    assert.ok(
      discordGuildReads.includes(LEGACY_GUILD),
      "string snowflake ⇒ discord.js guild cache read with the SAME key"
    );
    assert.ok(
      !outboundCalls.some((c) => c.includes(LEGACY_GUILD)),
      "the Discord path never issues outbound Fluxer fetches"
    );
  });

  it("queueMissingMembers keys numeric ids as String(communityId) and drains via fetchUser", async () => {
    queue.stopMemberFetchQueue();
    // Drain any queue left by the legacy-snowflake test: flushMemberFetchQueue
    // round-robins ONE key per call, and a stale entry would consume the
    // flush this test asserts on (the drain itself is harmless — the fake
    // Discord client has no such guild).
    while (Object.keys(queue.queueStats()).length > 0) {
      await queue.flushMemberFetchQueue();
    }
    const added = queue.queueMissingMembers(() => recordingDiscordClient, CID_FX, ["111000000000000002"]);
    assert.equal(added, 1);
    assert.equal(queue.queueStats()[String(CID_FX)], 1, "pending key is String(communityId) (spec L762)");
    outboundCalls = [];
    // Drain via the public flush. In FULL-suite runs the module's interval
    // ticker may win the race (its flush drains the entry first), so poll
    // ticks + flush (bounded) until the fetchUser call shows up, then assert
    // it was issued EXACTLY once through the OutboundClient.
    for (let i = 0; i < 8 && outboundCalls.length === 0; i++) {
      await ticks(1);
      await queue.flushMemberFetchQueue();
    }
    assert.equal(
      outboundCalls.filter((c) => c === `fetchUser:${CID_FX}:111000000000000002`).length,
      1,
      "the drain issues fetchUser exactly once (resolved via the community registry, spec L762)"
    );
    assert.ok(!discordGuildReads.includes(String(CID_FX)), "the Discord cache is never consulted for a Fluxer community");
    assert.ok(
      !(String(CID_FX) in queue.queueStats()),
      "the drained id leaves the queue (exactly one attempt, then dedupe/cooldown)"
    );
  });

  it("string snowflake keeps the legacy queue contract (pinned by web-member-fetch-queue)", () => {
    queue.stopMemberFetchQueue();
    const added = queue.queueMissingMembers(() => recordingDiscordClient, LEGACY_GUILD, ["888"]);
    assert.equal(added, 1);
    assert.equal(queue.queueStats()[LEGACY_GUILD], 1);
    queue.stopMemberFetchQueue();
  });

  it("non-numeric/non-string ids are loud + return 0", () => {
    queue.stopMemberFetchQueue();
    const realWarn = console.warn;
    const warns = [];
    console.warn = (...a) => warns.push(a.join(" "));
    try {
      assert.equal(queue.queueMissingMembers(() => recordingDiscordClient, { id: CID_FX }, ["777"]), 0);
      assert.equal(queue.queueMissingMembers(() => recordingDiscordClient, 12.5, ["777"]), 0);
    } finally {
      console.warn = realWarn;
    }
    assert.ok(warns.every((w) => w.includes("[web] member-fetch queue:")));
    assert.deepEqual(queue.queueStats(), {}, "nothing queued for invalid ids");
  });

  it("a numeric queue whose community row is gone drains to zero (logged skip)", async () => {
    queue.stopMemberFetchQueue();
    queue.queueMissingMembers(() => recordingDiscordClient, 999999999, ["555"]);
    const realWarn = console.warn;
    const warns = [];
    console.warn = (...a) => warns.push(a.join(" "));
    let attempted;
    try {
      attempted = await queue.flushMemberFetchQueue();
    } finally {
      console.warn = realWarn;
    }
    assert.equal(attempted, 0);
    assert.ok(warns.some((w) => w.includes("no registry row")), "a vanished community is a LOUD skip");
    queue.stopMemberFetchQueue();
  });

  after(() => {
    discordCache.setCommunityClientProvider(null);
    queue.stopMemberFetchQueue();
  });
});
