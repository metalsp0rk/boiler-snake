/**
 * Web login/logout vs a MOCKED Discord (roadmap/web-admin.md §8.8 Phase 0b,
 * §8.11): the Discord API base is injectable (createWebApp({apiBase,...})),
 * so this suite fakes /oauth2/token, /users/@me and /users/@me/guilds on a
 * local HTTP server — fully offline, real SQLite (temp DB), node --test.
 *
 * Covers:
 *  - tokens.js AES-256-GCM envelope (ciphertext never plaintext, round-trip,
 *    tamper/rotation failures are static errors — no key leakage);
 *  - oauthState purpose tagging (web_login vs cmd_perms, legacy default,
 *    unknown purpose rejection) — cmd_perms flows keep old behavior;
 *  - GET /auth/login authorize redirect (scopes/%20, prompt, redirect URI);
 *  - GET /auth/login/callback happy path: session cookie + rotation,
 *    encrypted AT + scopes + expiry on the row, bot∩user guild snapshot;
 *  - state tamper / wrong purpose / replay / expiry → 400, never a token
 *    exchange (nonce single-use);
 *  - POST /auth/logout destroys row + clears cookie → anonymous afterwards;
 *  - method gate: POST passes ONLY on exact /auth/logout; everything else
 *    still 405s (Phase 0a oracle semantics);
 *  - unauthenticated /g/* → login redirect (§8.8 0b);
 *  - login tokens never land in guild_command_permission_oauth (§8.1-9).
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// Clearly-fake placeholders only (never real-looking secrets, AGENTS.md).
const SESSION_SECRET = "test-sess…-xyz";
const CLIENT_ID = "123456789012345678";
const CLIENT_SECRET = "test-clien…-abc";
const FAKE_ACCESS_TOKEN = "AT-PLAINTEXT-ZmFrZS1hY2Nlc3MtdG9rZW4";

const USER_ID = "428190112345678901";
const GUILD_SHARED = "100000000000000001"; // bot + user
const GUILD_USER_ONLY = "200000000000000002"; // user only
const GUILD_BOT_ONLY = "300000000000000003"; // bot only
const BOT_GUILD_IDS = [GUILD_SHARED, GUILD_BOT_ONLY];

const ENV_KEYS = [
  "PUBLIC_HTTP_PORT",
  "PUBLIC_BASE_URL",
  "TICKET_HTTP_PORT",
  "TICKET_PUBLIC_BASE_URL",
  "OAUTH_REDIRECT_URI",
  "WEB_LOGIN_REDIRECT_URI",
  "WEB_LOGIN_PROMPT",
  "SESSION_SECRET",
  "OAUTH_STATE_SECRET",
  "CLIENT_ID",
  "CLIENT_SECRET",
  "WEB_RATE_LIMIT_AUTH_MAX",
  "WEB_RATE_LIMIT_AUTH_USER_MAX",
  "WEB_RATE_LIMIT_MUTATION_MAX",
];

/**
 * Run `fn` with env patches (undefined deletes), restoring after.
 * @param {Record<string, string|undefined>} patches
 * @param {() => any} fn
 */
function withEnv(patches, fn) {
  const saved = {};
  for (const key of Object.keys(patches)) {
    saved[key] = process.env[key];
    if (patches[key] === undefined) delete process.env[key];
    else process.env[key] = patches[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(patches)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/**
 * Mock Discord: /api/v10/oauth2/token, /api/v10/users/@me,
 * /api/v10/users/@me/guilds. Records every call for assertions.
 */
async function startMockDiscord() {
  const state = {
    tokenCalls: [], // {contentType, authorization, form}
    apiCalls: [], // {path, authorization}
    user: {
      id: USER_ID,
      username: "testy",
      global_name: "Testy Tester",
      avatar: null,
    },
    userGuilds: [
      {
        id: GUILD_SHARED,
        name: "Shared Guild",
        icon: "aaa",
        owner: true,
        permissions: "36953089",
      },
      {
        id: GUILD_USER_ONLY,
        name: "User Only Guild",
        icon: null,
        owner: false,
        permissions: "104324673",
      },
    ],
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://mock");
    if (req.method === "POST" && url.pathname === "/api/v10/oauth2/token") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyText = Buffer.concat(chunks).toString("utf8");
      state.tokenCalls.push({
        contentType: req.headers["content-type"] || "",
        authorization: req.headers.authorization || "",
        form: Object.fromEntries(new URLSearchParams(bodyText)),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: FAKE_ACCESS_TOKEN,
          token_type: "Bearer",
          expires_in: 604800,
          refresh_token: "REFRESH-NEVER-STORED-IN-V1",
          scope: "identify guilds guilds.members.read",
        })
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v10/users/@me") {
      state.apiCalls.push({ path: url.pathname, authorization: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state.user));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v10/users/@me/guilds") {
      state.apiCalls.push({ path: url.pathname, authorization: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state.userGuilds));
      return;
    }
    const memberMatch = /^\/api\/v10\/users\/@me\/guilds\/([^/]+)\/member$/.exec(
      url.pathname
    );
    if (req.method === "GET" && memberMatch) {
      state.apiCalls.push({ path: url.pathname, authorization: req.headers.authorization });
      if (memberMatch[1] !== GUILD_SHARED) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Unknown Guild", code: 10004 }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ roles: ["r-role-1"], joined_at: "2024-01-01T00:00:00.000Z" })
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Unknown endpoint", code: 0 }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, state };
}

/**
 * Pull the session id out of a Set-Cookie value.
 * @param {string} setCookie
 * @returns {string}
 */
function cookieValue(setCookie) {
  const m = /^web_session=([^;]+);/.exec(setCookie);
  if (!m) throw new Error(`no web_session cookie in: ${setCookie}`);
  return m[1];
}

describe("web login/logout (mocked Discord, purpose-tagged state)", () => {
  /** @type {ReturnType<typeof loadDb>["api"]} */
  let api;
  let tmpDir;
  /** @type {typeof import("../src/web/app")} */
  let appMod;
  /** @type {typeof import("../src/web/auth/sessions")} */
  let sessions;
  /** @type {typeof import("../src/web/auth/tokens")} */
  let tokens;
  /** @type {typeof import("../src/web/auth/login")} */
  let loginMod;
  /** @type {typeof import("../src/web/config")} */
  let webConfig;
  /** @type {typeof import("../src/features/commandPermissions/oauthState")} */
  let oauthState;
  /** @type {typeof import("../src/web/middleware/csrf")} */
  let csrf;
  /** @type {typeof import("../src/web/auth/discordApi")} */
  let discordApi;

  /** @type {Awaited<ReturnType<typeof startMockDiscord>>} */
  let mock;
  /** @type {import("http").Server} */
  let appServer;
  /** @type {string} */
  let appBase;
  let savedEnv;

  /**
   * @param {string|undefined} key
   * @param {string|undefined} value
   */
  function setOrDelete(key, value) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  /**
   * Env patches around an ASYNC fn (withEnv is sync-safe only for sync fns —
   * an awaited fn would run after the restore).
   * @param {Record<string, string|undefined>} patches
   * @param {() => Promise<void>} fn
   */
  async function withEnvAsync(patches, fn) {
    const saved = {};
    for (const key of Object.keys(patches)) {
      saved[key] = process.env[key];
      setOrDelete(key, patches[key]);
    }
    try {
      await fn();
    } finally {
      for (const key of Object.keys(patches)) setOrDelete(key, saved[key]);
    }
  }

  before(async () => {
    savedEnv = ENV_KEYS.reduce((acc, k) => {
      acc[k] = process.env[k];
      return acc;
    }, {});
    const loaded = loadDb();
    api = loaded.api;
    tmpDir = loaded.tmpDir;

    mock = await startMockDiscord();

    // Suite-scoped env (after() restores ENV_KEYS): config getters read env
    // live, so the login routes see the fake OAuth app for every request.
    process.env.SESSION_SECRET = SESSION_SECRET;
    process.env.CLIENT_ID = CLIENT_ID;
    process.env.CLIENT_SECRET = CLIENT_SECRET;
    for (const key of [
      "OAUTH_STATE_SECRET", // ⇒ state secret falls back to CLIENT_SECRET
      "OAUTH_REDIRECT_URI",
      "WEB_LOGIN_REDIRECT_URI",
      "WEB_LOGIN_PROMPT",
      "PUBLIC_HTTP_PORT",
      "TICKET_HTTP_PORT",
      "TICKET_PUBLIC_BASE_URL",
    ]) {
      delete process.env[key];
    }
    // Subtask 08 middlewares snapshot WEB_RATE_LIMIT_* at app creation:
    // this suite fires far more /auth hits per minute than a human would,
    // so the test app gets a huge (finite) budget. Rate limiting itself is
    // tested by the subtask-08 net, not here.
    process.env.WEB_RATE_LIMIT_AUTH_MAX = "100000";
    process.env.WEB_RATE_LIMIT_AUTH_USER_MAX = "100000";
    process.env.WEB_RATE_LIMIT_MUTATION_MAX = "100000";

    appMod = require("../src/web/app");
    sessions = require("../src/web/auth/sessions");
    tokens = require("../src/web/auth/tokens");
    loginMod = require("../src/web/auth/login");
    webConfig = require("../src/web/config");
    oauthState = require("../src/features/commandPermissions/oauthState");
    oauthState._resetNoncesForTests();
    csrf = require("../src/web/middleware/csrf");
    discordApi = require("../src/web/auth/discordApi");

    const app = appMod.createWebApp({
      apiBase: `${mock.base}/api/v10`,
      oauthBase: mock.base,
      botGuilds: () => BOT_GUILD_IDS,
    });
    appServer = http.createServer(app);
    appServer.listen(0, "127.0.0.1");
    await once(appServer, "listening");
    appBase = `http://127.0.0.1:${appServer.address().port}`;
    process.env.PUBLIC_BASE_URL = appBase;
  });

  after(async () => {
    if (appServer) {
      appServer.close();
      await once(appServer, "close");
    }
    if (mock?.server) {
      mock.server.close();
      await once(mock.server, "close");
    }
    sessions?.stopSessionPruneJob();
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

  /**
   * Drive GET /auth/login and return the parsed authorize URL.
   * @param {{ cookie?: string, query?: string }} [opts]
   */
  async function loginStart(opts = {}) {
    const res = await fetch(`${appBase}/auth/login${opts.query || ""}`, {
      redirect: "manual",
      headers: opts.cookie ? { cookie: opts.cookie } : undefined,
    });
    return { res, authorizeUrl: new URL(res.headers.get("location")) };
  }

  /**
   * Drive the callback with a fresh authorize round-trip.
   * @param {{ state?: string, code?: string, cookie?: string, query?: string }} [opts]
   */
  async function loginCallback(opts = {}) {
    let state = opts.state;
    if (state === undefined) {
      const { authorizeUrl } = await loginStart(opts);
      state = authorizeUrl.searchParams.get("state");
    }
    const params = new URLSearchParams();
    params.set("code", opts.code ?? "fake-auth-code");
    if (state !== null) params.set("state", state);
    const res = await fetch(`${appBase}/auth/login/callback?${params}`, {
      redirect: "manual",
      headers: opts.cookie ? { cookie: opts.cookie } : undefined,
    });
    return { res, state };
  }

  // -------------------------------------------------------------------------
  // GET /auth/login
  // -------------------------------------------------------------------------

  describe("GET /auth/login", () => {
    it("302s to the Discord authorize URL with §8.3 scopes and prompt=consent", async () => {
      const { res, authorizeUrl } = await loginStart();
      assert.equal(res.status, 302);
      assert.equal(authorizeUrl.origin + authorizeUrl.pathname, `${mock.base}/oauth2/authorize`);
      assert.equal(authorizeUrl.searchParams.get("response_type"), "code");
      assert.equal(authorizeUrl.searchParams.get("client_id"), CLIENT_ID);
      assert.equal(
        authorizeUrl.searchParams.get("scope"),
        "identify guilds guilds.members.read"
      );
      assert.equal(authorizeUrl.searchParams.get("prompt"), "consent");
      assert.equal(
        authorizeUrl.searchParams.get("redirect_uri"),
        `${appBase}/auth/login/callback`
      );
      assert.ok(authorizeUrl.searchParams.get("state"));
      // Docs-mandated %20 encoding of scope spaces in the raw query.
      assert.match(res.headers.get("location"), /scope=identify%20guilds%20guilds\.members\.read/);
    });

    it("WEB_LOGIN_PROMPT=none is honored; garbage falls back to consent", async () => {
      await withEnvAsync({ WEB_LOGIN_PROMPT: "none" }, async () => {
        const { authorizeUrl } = await loginStart();
        assert.equal(authorizeUrl.searchParams.get("prompt"), "none");
      });
      await withEnvAsync({ WEB_LOGIN_PROMPT: "re-authorize" }, async () => {
        const { authorizeUrl } = await loginStart();
        assert.equal(authorizeUrl.searchParams.get("prompt"), "consent");
      });
    });

    it("503 when OAuth env is incomplete (names only, no values)", async () => {
      await withEnvAsync({ CLIENT_SECRET: undefined }, async () => {
        const res = await fetch(`${appBase}/auth/login`, { redirect: "manual" });
        assert.equal(res.status, 503);
        assert.match(await res.text(), /not configured/i);
      });
    });
  });

  // -------------------------------------------------------------------------
  // GET /auth/login/callback — happy path
  // -------------------------------------------------------------------------

  describe("callback happy path", () => {
    it("sets the session cookie, rotates ids, stores ENCRYPTED AT + guild intersection", async () => {
      const anon = sessions.createSession({ userId: "999000999000999000" });
      const tokenCallsBefore = mock.state.tokenCalls.length;

      const { res } = await loginCallback({ cookie: `web_session=${anon.id}` });
      assert.equal(res.status, 302, "redirect to home");
      assert.equal(res.headers.get("location"), "/");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");

      const setCookies = res.headers.getSetCookie();
      assert.equal(setCookies.length, 1, "exactly one Set-Cookie");
      const sc = setCookies[0];
      const newId = cookieValue(sc);
      assert.match(newId, /^[0-9a-f]{64}$/);
      assert.notEqual(newId, anon.id, "session id rotated on login (§8.3)");
      assert.match(sc, /HttpOnly/);
      assert.match(sc, /SameSite=Lax/);
      assert.match(sc, /Path=\//);

      // Old anonymous id is DEAD (§8.3 rotation kills the pre-login id).
      assert.equal(api.getWebSession(anon.id), null);
      const live = sessions.getSession(newId);
      assert.ok(live);
      assert.equal(live.userId, USER_ID);
      assert.equal(live.discordTag, "Testy Tester");

      // --- token storage: ciphertext, never the plaintext (§8.7) ----------
      const auth = api.getWebSessionAuth(newId);
      assert.ok(auth, "auth row present");
      assert.ok(auth.access_token_enc.startsWith("v1."), "versioned envelope");
      assert.notEqual(auth.access_token_enc, FAKE_ACCESS_TOKEN);
      assert.ok(
        !JSON.stringify(auth).includes(FAKE_ACCESS_TOKEN),
        "plaintext AT must not appear anywhere on the row"
      );
      assert.equal(tokens.decryptAccessToken(auth.access_token_enc), FAKE_ACCESS_TOKEN);
      const lifeMs = auth.token_expires_at - Date.now();
      assert.ok(
        lifeMs > 604_800_000 - 60_000 && lifeMs <= 604_800_000,
        `token_expires_at ≈ +7d (got ${lifeMs}ms)`
      );
      assert.equal(auth.scopes, "identify guilds guilds.members.read");

      // --- guild snapshot = bot ∩ user (guilds scope returns ALL user ones) --
      const snapshot = JSON.parse(auth.guild_snapshot);
      assert.deepEqual(
        snapshot.map((g) => g.id),
        [GUILD_SHARED],
        "intersection keeps only guilds the bot is also in"
      );
      assert.equal(snapshot[0].owner, true);
      assert.equal(snapshot[0].permissions, "36953089", "decimal string preserved for 07");

      // --- Discord API call shape (live-docs rules) ------------------------
      assert.equal(mock.state.tokenCalls.length, tokenCallsBefore + 1);
      const tok = mock.state.tokenCalls.at(-1);
      assert.match(tok.contentType, /^application\/x-www-form-urlencoded/);
      assert.equal(
        tok.authorization,
        `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`
      );
      assert.equal(tok.form.grant_type, "authorization_code");
      assert.equal(tok.form.code, "fake-auth-code");
      assert.equal(tok.form.redirect_uri, `${appBase}/auth/login/callback`);
      for (const call of mock.state.apiCalls.slice(-2)) {
        assert.equal(call.authorization, `Bearer ${FAKE_ACCESS_TOKEN}`);
      }
      assert.deepEqual(
        mock.state.apiCalls.slice(-2).map((c) => c.path),
        ["/api/v10/users/@me", "/api/v10/users/@me/guilds"]
      );

      // Web login tokens stay OUT of the command-permission tables (§8.1-9).
      assert.equal(
        api.db.prepare(`SELECT COUNT(*) AS n FROM guild_command_permission_oauth`).get().n,
        0
      );

      // The new cookie authenticates: /g/:guildId placeholder → 200.
      const gres = await fetch(`${appBase}/g/${GUILD_SHARED}`, {
        redirect: "manual",
        headers: { cookie: `web_session=${newId}` },
      });
      assert.equal(gres.status, 200);

      // Integration with subtask 08: an AUTHENTICATED logout without the
      // double-submit token is denied by middleware/csrf.js (/auth/ scope)
      // and the session SURVIVES the denial.
      const noTok = await fetch(`${appBase}/auth/logout`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: `web_session=${newId}` },
      });
      assert.equal(noTok.status, 403);
      assert.ok(api.getWebSession(newId), "session survives a CSRF denial");

      // Cleanup: tokened logout destroys the row (logout happy path).
      const lres = await fetch(`${appBase}/auth/logout`, {
        method: "POST",
        redirect: "manual",
        headers: {
          cookie: `web_session=${newId}`,
          "x-csrf-token": csrf.deriveCsrfToken(newId, SESSION_SECRET),
        },
      });
      assert.equal(lres.status, 302);
      assert.equal(lres.headers.get("location"), "/");
      const clear = lres.headers.getSetCookie()[0];
      assert.match(clear, /^web_session=; /);
      assert.match(clear, /Max-Age=0/);
      assert.match(clear, /HttpOnly/);
      assert.equal(api.getWebSession(newId), null, "session row destroyed on logout");

      // Subsequent request with the dead cookie is anonymous → /g redirects.
      const anonAfter = await fetch(`${appBase}/g/${GUILD_SHARED}`, {
        redirect: "manual",
        headers: { cookie: `web_session=${newId}` },
      });
      assert.equal(anonAfter.status, 302);
      assert.equal(
        anonAfter.headers.get("location"),
        `/auth/login?guild=${GUILD_SHARED}`
      );
    });

    it("?guild=<snowflake> is signed into the state and returns /g/:guildId", async () => {
      const { authorizeUrl } = await loginStart({ query: `?guild=${GUILD_BOT_ONLY}` });
      const { res } = await loginCallback({
        state: authorizeUrl.searchParams.get("state"),
        code: "code-guild-target",
      });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), `/g/${GUILD_BOT_ONLY}`);
    });

    it("ignores a non-snowflake guild param (redirect stays '/', nothing echoed)", async () => {
      const { authorizeUrl } = await loginStart({
        query: "?guild=..%2Fevil&guild2=1",
      });
      const { res } = await loginCallback({
        state: authorizeUrl.searchParams.get("state"),
        code: "code-bogus-guild",
      });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), "/");
      const auth = api.getWebSessionAuth(cookieValue(res.headers.getSetCookie()[0]));
      assert.ok(auth);
    });

    it("?error=access_denied → 400 page, zero token calls", async () => {
      const before = mock.state.tokenCalls.length;
      const res = await fetch(
        `${appBase}/auth/login/callback?error=access_denied&state=whatever`,
        { redirect: "manual" }
      );
      assert.equal(res.status, 400);
      assert.match(await res.text(), /Login cancelled/i);
      assert.equal(mock.state.tokenCalls.length, before);
    });

    it("missing code or state → 400", async () => {
      const noCode = await fetch(`${appBase}/auth/login/callback?state=x`, {
        redirect: "manual",
      });
      assert.equal(noCode.status, 400);
      const noState = await fetch(`${appBase}/auth/login/callback?code=y`, {
        redirect: "manual",
      });
      assert.equal(noState.status, 400);
    });
  });

  // -------------------------------------------------------------------------
  // state validation (§8.3: no cross-flow substitution, single-use nonce)
  // -------------------------------------------------------------------------

  describe("callback state validation", () => {
    it("rejects a tampered state — and never touches the token endpoint", async () => {
      const before = mock.state.tokenCalls.length;
      const { authorizeUrl } = await loginStart();
      const state = authorizeUrl.searchParams.get("state");
      const tampered = `${state.slice(0, -4)}AAAA`;
      const { res } = await loginCallback({ state: tampered });
      assert.equal(res.status, 400);
      assert.match(await res.text(), /invalid|expired/i);
      assert.equal(mock.state.tokenCalls.length, before);
    });

    it("rejects a cmd_perms state replayed into the web login callback", async () => {
      const before = mock.state.tokenCalls.length;
      const cpState = oauthState.createOAuthState({
        guildId: "100000000000000009",
        userId: USER_ID,
        // purpose omitted ⇒ legacy cmd_perms
      });
      const { res } = await loginCallback({ state: cpState });
      assert.equal(res.status, 400);
      assert.equal(mock.state.tokenCalls.length, before);
    });

    it("rejects a REPLAYED web_login state (nonce is single-use)", async () => {
      const before = mock.state.tokenCalls.length;
      const { authorizeUrl } = await loginStart();
      const state = authorizeUrl.searchParams.get("state");

      const first = await loginCallback({ state, code: "code-first" });
      assert.equal(first.res.status, 302);

      const replay = await loginCallback({ state, code: "code-replay" });
      assert.equal(replay.res.status, 400);
      assert.equal(
        mock.state.tokenCalls.length,
        before + 1,
        "the replayed state never reaches the exchange"
      );
    });

    it("rejects an expired web_login state", async () => {
      const before = mock.state.tokenCalls.length;
      const expired = oauthState.createOAuthState({
        purpose: "web_login",
        exp: Date.now() - 1000,
      });
      const { res } = await loginCallback({ state: expired });
      assert.equal(res.status, 400);
      assert.equal(mock.state.tokenCalls.length, before);
    });

    it("a state signed with a different secret is rejected", async () => {
      const before = mock.state.tokenCalls.length;
      const foreign = await withEnv(
        { OAUTH_STATE_SECRET: "another-s…p-key" },
        () => oauthState.createOAuthState({ purpose: "web_login" })
      );
      const { res } = await loginCallback({ state: foreign });
      assert.equal(res.status, 400);
      assert.equal(mock.state.tokenCalls.length, before);
    });
  });

  // -------------------------------------------------------------------------
  // method gate + placeholder gate
  // -------------------------------------------------------------------------

  describe("method gate + /g placeholder", () => {
    it("POST passes ONLY on exact /auth/logout; everything else still 405s", async () => {
      for (const [method, path, expected] of [
        ["POST", "/health", 405],
        ["POST", "/t", 405],
        ["POST", "/auth/login", 405],
        ["POST", "/auth/logout/", 405], // trailing slash is NOT the exact path
        ["PUT", "/auth/logout", 405],
        ["POST", "/oauth/command-permissions/callback", 405],
        ["DELETE", "/auth/logout", 405],
      ]) {
        const res = await fetch(`${appBase}${path}`, { method });
        assert.equal(res.status, expected, `${method} ${path}`);
        if (expected === 405) {
          assert.equal(await res.text(), "Method not allowed");
        }
      }
      // Exact path POST reaches the handler (anonymous → idempotent 302).
      const ok = await fetch(`${appBase}/auth/logout`, { method: "POST", redirect: "manual" });
      assert.equal(ok.status, 302);
      // GET /auth/logout has no route → legacy 404 body.
      const getLogout = await fetch(`${appBase}/auth/logout`);
      assert.equal(getLogout.status, 404);
      assert.equal(await getLogout.text(), "Not found");
    });

    it("unauthenticated /g/* redirects to /auth/login (guild id only when snowflake)", async () => {
      const good = await fetch(`${appBase}/g/${GUILD_SHARED}`, { redirect: "manual" });
      assert.equal(good.status, 302);
      assert.equal(good.headers.get("location"), `/auth/login?guild=${GUILD_SHARED}`);

      const weird = await fetch(`${appBase}/g/oops`, { redirect: "manual" });
      assert.equal(weird.status, 302);
      assert.equal(weird.headers.get("location"), "/auth/login");
    });
  });

  // -------------------------------------------------------------------------
  // tokens.js unit surface
  // -------------------------------------------------------------------------

  describe("auth/tokens.js", () => {
    it("round-trips; every encryption is unique (random IV); never leaks plaintext", () => {
      const a = tokens.encryptAccessToken("tok-abc-123");
      const b = tokens.encryptAccessToken("tok-abc-123");
      assert.notEqual(a, b, "random IV per record");
      assert.ok(a.startsWith("v1."));
      assert.ok(!a.includes("tok-abc-123"));
      assert.equal(tokens.decryptAccessToken(a), "tok-abc-123");
      assert.equal(tokens.decryptAccessToken(b), "tok-abc-123");
    });

    it("tampered envelopes fail with a STATIC error (no plaintext echoes)", () => {
      const env1 = tokens.encryptAccessToken("super-secret-token-value");
      for (const bad of [
        "garbage",
        "v1.abc",
        "v2.c3V0ZQ==.c3V0ZQ==.c3V0ZQ==",
        "v1.aaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaa=.aaaaaaaaaaa=", // shape ok, bytes junk
      ]) {
        assert.throws(() => tokens.decryptAccessToken(bad), (err) => {
          assert.ok(!String(err.message).includes("super-secret-token-value"));
          return true;
        });
      }
      // Flip a ciphertext char inside a REAL envelope ⇒ GCM auth failure.
      const parts = env1.split(".");
      const ct = parts[3];
      const flipped = `${ct.slice(0, -2)}${ct.slice(-2) === "AA" ? "BB" : "AA"}`;
      assert.throws(
        () => tokens.decryptAccessToken([parts[0], parts[1], parts[2], flipped].join(".")),
        /envelope/
      );
    });

    it("rotating the session secret invalidates stored envelopes (re-login)", () => {
      const sealed = tokens.encryptAccessToken("rotates-out");
      withEnv({ SESSION_SECRET: "a-wholly-new-session-secret" }, () => {
        assert.throws(() => tokens.decryptAccessToken(sealed));
      });
      assert.equal(tokens.decryptAccessToken(sealed), "rotates-out");
    });

    it("missing secret fails closed (no plaintext produced)", () => {
      withEnv({ SESSION_SECRET: undefined, CLIENT_SECRET: undefined }, () => {
        assert.throws(() => tokens.encryptAccessToken("nope"), /not configured/);
        assert.throws(() => tokens.decryptAccessToken("v1.x.y.z"), /not configured/);
      });
    });
  });

  // -------------------------------------------------------------------------
  // oauthState purpose tagging (unit layer; flow layer tested above)
  // -------------------------------------------------------------------------

  describe("oauthState purpose tagging", () => {
    it("web_login states round-trip without guild/user binding; legacy defaults to cmd_perms", () => {
      oauthState._resetNoncesForTests();
      const web = oauthState.verifyOAuthState(
        oauthState.createOAuthState({ purpose: "web_login" })
      );
      assert.ok(web);
      assert.equal(web.purpose, "web_login");
      assert.equal(web.guildId, null);

      const legacy = oauthState.verifyOAuthState(
        oauthState.createOAuthState({ guildId: "g9", userId: "u9" })
      );
      assert.ok(legacy);
      assert.equal(legacy.purpose, "cmd_perms");
      assert.equal(legacy.guildId, "g9");
    });

    it("cmd_perms still requires the guild+user binding; unknown purposes rejected", () => {
      oauthState._resetNoncesForTests();
      assert.equal(
        oauthState.verifyOAuthState(oauthState.createOAuthState({ userId: "u9" })),
        null
      );
      assert.throws(
        () => oauthState.createOAuthState({ purpose: "sudo_login" }),
        /Unknown OAuth state purpose/
      );
    });

    it("web_login guild target survives verification", () => {
      oauthState._resetNoncesForTests();
      const v = oauthState.verifyOAuthState(
        oauthState.createOAuthState({ purpose: "web_login", guildId: "123456789012345678" })
      );
      assert.equal(v?.guildId, "123456789012345678");
      assert.equal(v?.purpose, "web_login");
    });
  });

  // -------------------------------------------------------------------------
  // login.js pure helpers (guildAccess inputs for subtask 07)
  // -------------------------------------------------------------------------

  describe("login.js helpers", () => {
    it("buildGuildSnapshot intersects bot∩user, trims fields, keeps permissions as strings", () => {
      const snap = loginMod.buildGuildSnapshot(
        [
          { id: "1", name: "One", icon: "i1", owner: false, permissions: "8" },
          { id: "2", name: "x".repeat(200), icon: null, owner: true, permissions: "36953089" },
          { id: "3", name: "BotMissing", permissions: "0" },
          { id: "", name: "bad" },
          null,
          { name: "no id" },
        ],
        new Set(["1", "2"])
      );
      assert.deepEqual(snap, [
        { id: "1", name: "One", icon: "i1", owner: false, permissions: "8" },
        {
          id: "2",
          name: "x".repeat(100),
          icon: null,
          owner: true,
          permissions: "36953089",
        },
      ]);
    });

    it("readDiscordTag prefers global_name, trims + caps, tolerates junk", () => {
      assert.equal(loginMod.readDiscordTag({ global_name: "  Gg  ", username: "u" }), "Gg");
      assert.equal(loginMod.readDiscordTag({ username: "u2" }), "u2");
      assert.equal(loginMod.readDiscordTag({}), null);
      assert.equal(loginMod.readDiscordTag({ global_name: "z".repeat(100) }), "z".repeat(64));
    });
  });

  // -------------------------------------------------------------------------
  // discordApi member reader (guildAccess / subtask 07 inputs)
  // -------------------------------------------------------------------------

  describe("auth/discordApi.js", () => {
    it("getUserGuildMember returns role IDs and surfaces 404 as a status error", async () => {
      const api = discordApi.createDiscordApi({ apiBase: `${mock.base}/api/v10` });
      const member = await api.getUserGuildMember(FAKE_ACCESS_TOKEN, GUILD_SHARED);
      assert.deepEqual(member.roles, ["r-role-1"]);
      await assert.rejects(
        () => api.getUserGuildMember(FAKE_ACCESS_TOKEN, GUILD_USER_ONLY),
        (err) => {
          assert.equal(err.status, 404);
          assert.ok(!String(err.message).includes(FAKE_ACCESS_TOKEN));
          return true;
        }
      );
    });
  });

  // -------------------------------------------------------------------------
  // config resolution
  // -------------------------------------------------------------------------

  describe("web/config login knobs", () => {
    it("getLoginRedirectUri derives from PUBLIC_BASE_URL; explicit override wins", () => {
      withEnv({ WEB_LOGIN_REDIRECT_URI: undefined, PUBLIC_BASE_URL: "https://bot.example.com/" }, () => {
        assert.equal(
          webConfig.getLoginRedirectUri(),
          "https://bot.example.com/auth/login/callback"
        );
      });
      withEnv({ WEB_LOGIN_REDIRECT_URI: "https://alt.example.com/cb/" }, () => {
        assert.equal(webConfig.getLoginRedirectUri(), "https://alt.example.com/cb");
      });
      withEnv({ WEB_LOGIN_REDIRECT_URI: undefined, PUBLIC_BASE_URL: undefined, TICKET_PUBLIC_BASE_URL: undefined }, () => {
        assert.equal(webConfig.getLoginRedirectUri(), null);
      });
    });

    it("getWebLoginConfig lists missing var NAMES only", () => {
      withEnv({ CLIENT_ID: undefined, CLIENT_SECRET: undefined, WEB_LOGIN_REDIRECT_URI: undefined, PUBLIC_BASE_URL: undefined }, () => {
        const cfg = webConfig.getWebLoginConfig();
        assert.equal(cfg.ready, false);
        assert.deepEqual(cfg.missing, [
          "CLIENT_ID",
          "CLIENT_SECRET",
          "PUBLIC_BASE_URL (or WEB_LOGIN_REDIRECT_URI)",
        ]);
      });
    });
  });
});
