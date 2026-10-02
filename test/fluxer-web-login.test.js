/**
 * Fluxer web login vs a MOCKED Fluxer instance (roadmap/fluxer.md PR 10,
 * § Authorize URL / § PKCE and state): a local HTTP server serves
 * /v1/oauth2/token, /v1/oauth2/userinfo and /v1/users/@me/guilds — fully
 * offline, real SQLite (temp DB), node --test. Mirrors the startMockDiscord
 * harness of web-auth-login.test.js.
 *
 * The three handlers come from createFluxerLoginHandlers directly behind a
 * tiny HTTP router matching the C13 route table (createWebApp threads the
 * fluxer options per C12; until that wiring lands this is the sanctioned
 * harness — same spirit as the Discord suite driving createWebApp).
 *
 * Covers:
 *  - GET /auth/fluxer/:slug/login → 302 authorize URL: scopes `identify%20guilds`,
 *    prompt=consent, S256 challenge (43-char base64url), byte-exact redirect URI,
 *    transaction row written BEFORE the redirect, keyed by the state's nonce;
 *  - unknown/malformed slug → 404 (fail closed, nothing minted);
 *  - full round-trip: `web_session_fx` Set-Cookie (NEVER `web_session`),
 *    session row platform='fluxer' + instance_key, encrypted AT + refresh
 *    pair (round-trip decrypt), bot∩user guild snapshot (communities-only,
 *    visibility-confirmed), exchange form carries the stored code_verifier;
 *  - SECOND callback with the same state → 400 (transaction consumed —
 *    single use lives in fluxer_oauth_transactions, not usedNonces);
 *  - Discord-purpose state on the Fluxer callback → 400;
 *  - transaction instance-key mismatch → 400;
 *  - userinfo missing sub → failure page naming ONLY the shape code, no
 *    token material echoed; exchange failure shows ONLY the OAuth error code;
 *  - POST /auth/fluxer/logout clears ONLY web_session_fx and destroys the row.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("crypto");
const fs = require("fs");
const { once } = require("node:events");
const { loadDb, communityKey } = require("./helpers/env");

// Clearly-fake placeholders only (never real-looking secrets, AGENTS.md).
const FX_SESSION_SECRET = "test-fluxe…-abc";
const FX_CLIENT_ID = "fx-client-1";
const FX_CLIENT_SECRET = "fx-client-secret-xyz";
const FX_AT = "FX-AT-PLAINTEST-ZmFrZS10b2tlbg";
const FX_REFRESH = "FX-RT-PLAINTEST-ZmFrZS10b2tlbg";

const INSTANCE_KEY = "https://flx.test";
const FX_USER_ID = "428190112345678901";
const FX_GUILD_SHARED = "910000000000000001"; // community + visible to the bot
const FX_GUILD_VANISHED = "920000000000000002"; // community, fetchGuild → null
const FX_GUILD_FETCH_FAIL = "930000000000000003"; // community, fetchGuild throws
const FX_GUILD_NO_CLIENT = "940000000000000004"; // community, no outbound client
const FX_GUILD_STRANGER = "950000000000000005"; // NOT a registered community

const ENV_KEYS = [
  "PUBLIC_BASE_URL",
  "SESSION_SECRET",
  "OAUTH_STATE_SECRET",
  "CLIENT_SECRET",
  "DB_PATH",
  "DATA_DIR",
];

/**
 * Mock Fluxer instance: /v1/oauth2/token, /v1/oauth2/userinfo,
 * /v1/users/@me/guilds. Records every call for assertions.
 */
async function startMockFlux() {
  const state = {
    tokenCalls: [], // {contentType, authorization, form}
    apiCalls: [], // {path, authorization}
    user: { sub: FX_USER_ID, username: "fx-testy" },
    tokenError: null, // {status, body} forces token-endpoint failures
    userGuilds: [
      {
        id: FX_GUILD_SHARED,
        name: "FX Shared",
        icon: "abc",
        owner: true,
        permissions: "36953089",
      },
      {
        id: FX_GUILD_VANISHED,
        name: "FX Vanished",
        icon: null,
        owner: false,
        permissions: "104324673",
      },
      {
        id: FX_GUILD_FETCH_FAIL,
        name: "FX Fetch Fail",
        icon: null,
        owner: false,
        permissions: "8",
      },
      {
        id: FX_GUILD_NO_CLIENT,
        name: "FX No Client",
        icon: null,
        owner: false,
        permissions: null,
      },
      {
        id: FX_GUILD_STRANGER,
        name: "Not Our Community",
        icon: null,
        owner: false,
        permissions: "0",
      },
    ],
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://mock");
    if (req.method === "POST" && url.pathname === "/v1/oauth2/token") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyText = Buffer.concat(chunks).toString("utf8");
      state.tokenCalls.push({
        contentType: req.headers["content-type"] || "",
        authorization: req.headers.authorization || "",
        form: Object.fromEntries(new URLSearchParams(bodyText)),
      });
      if (state.tokenError) {
        res.writeHead(state.tokenError.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(state.tokenError.body));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: FX_AT,
          token_type: "Bearer",
          expires_in: 604800,
          refresh_token: FX_REFRESH,
          refresh_expires_in: 30 * 24 * 60 * 60,
          scope: "identify guilds",
        })
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/oauth2/userinfo") {
      state.apiCalls.push({ path: url.pathname, authorization: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state.user));
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/users/@me/guilds") {
      state.apiCalls.push({ path: url.pathname, authorization: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state.userGuilds));
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

/** Pull the session id out of a Set-Cookie value for one cookie name. */
function cookieValue(setCookie, name) {
  const m = new RegExp(`^${name}=([^;]+);`).exec(setCookie);
  if (!m) throw new Error(`no ${name} cookie in: ${setCookie}`);
  return m[1];
}

/** Decode the JSON body of a signed state (tests inspect the nonce only). */
function stateBody(state) {
  return JSON.parse(Buffer.from(state.split(".")[0], "base64url").toString("utf8"));
}

describe("fluxer web login (mocked instance, PKCE + SQLite transactions)", () => {
  /** @type {ReturnType<typeof loadDb>["api"]} */
  let api;
  let loaded;
  /** @type {typeof import("../src/web/auth/login")} */
  let loginMod;
  /** @type {typeof import("../src/web/auth/sessions")} */
  let sessions;
  /** @type {typeof import("../src/web/auth/tokens")} */
  let tokens;
  /** @type {typeof import("../src/features/commandPermissions/oauthState")} */
  let oauthState;
  /** @type {Awaited<ReturnType<typeof startMockFlux>>} */
  let mock;
  /** @type {import("http").Server} */
  let appServer;
  /** @type {string} */
  let appBase;
  let savedEnv;

  /** Slug under test: sha256(INSTANCE_KEY) hex prefix. */
  let SLUG;
  /** Registered communities.id values (PR 2 route identity shape). */
  let cidShared;
  let cidVanished;
  let cidFetchFail;
  let cidNoClient;
  /** Arg history of the fake OutboundClient.fetchGuild (see before()). */
  let visibilityCalls;

  /** Minimal router for the C13 route table (see file header). */
  function buildMiniApp(handlers) {
    return http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://fx.local");
      const m = /^\/auth\/fluxer\/([^/]+)\/(login|callback\/?)$/.exec(url.pathname);
      if (m && req.method === "GET") {
        req.params = { slug: decodeURIComponent(m[1]) };
        const run =
          m[2] === "login"
            ? handlers.startFluxerLogin(req, res)
            : handlers.handleFluxerLoginCallback(req, res);
        Promise.resolve(run).catch((err) => {
          console.error("[test] unhandled handler rejection:", err?.message || err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("handler crashed");
          }
        });
        return;
      }
      if (url.pathname === "/auth/fluxer/logout" && req.method === "POST") {
        handlers.fluxerLogout(req, res);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });
  }

  /** Direct-call capture for handlers driven without HTTP. */
  function captureRes() {
    const out = { statusCode: null, headers: {}, setCookies: [], body: "" };
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        out.statusCode = status;
        Object.assign(out.headers, headers || {});
        res.headersSent = true;
      },
      end(body) {
        out.body = body == null ? "" : String(body);
      },
    };
    return { res, out };
  }

  function txRow(nonce) {
    return api.db
      .prepare("SELECT * FROM fluxer_oauth_transactions WHERE nonce=?")
      .get(nonce);
  }

  before(async () => {
    savedEnv = ENV_KEYS.reduce((acc, k) => {
      acc[k] = process.env[k];
      return acc;
    }, {});
    loaded = loadDb();
    api = loaded.api;

    // Suite-scoped env (after() restores ENV_KEYS): config + token + state
    // getters read env live, so the handlers see the fake setup per request.
    process.env.SESSION_SECRET = FX_SESSION_SECRET;
    process.env.CLIENT_SECRET = FX_CLIENT_SECRET;
    delete process.env.OAUTH_STATE_SECRET; // ⇒ state secret falls back to CLIENT_SECRET
    delete process.env.PUBLIC_BASE_URL; // set to appBase once it listens

    loginMod = require("../src/web/auth/login");
    sessions = require("../src/web/auth/sessions");
    tokens = require("../src/web/auth/tokens");
    oauthState = require("../src/features/commandPermissions/oauthState");
    oauthState._resetNoncesForTests();

    mock = await startMockFlux();

    // Communities for THIS instance (the bot's guild list for the snapshot
    // intersection). FX_GUILD_STRANGER is deliberately NOT registered.
    cidShared = communityKey(FX_GUILD_SHARED, "fluxer", INSTANCE_KEY);
    cidVanished = communityKey(FX_GUILD_VANISHED, "fluxer", INSTANCE_KEY);
    cidFetchFail = communityKey(FX_GUILD_FETCH_FAIL, "fluxer", INSTANCE_KEY);
    cidNoClient = communityKey(FX_GUILD_NO_CLIENT, "fluxer", INSTANCE_KEY);

    const instance = {
      instanceKey: INSTANCE_KEY,
      label: "Test Fluxer",
      clientId: FX_CLIENT_ID,
      clientSecret: FX_CLIENT_SECRET,
      apiBase: `${mock.base}/v1`,
    };
    SLUG = require("../src/web/auth/fluxerApi").fluxerInstanceSlug(INSTANCE_KEY);
    assert.match(SLUG, /^[0-9a-f]{16}$/);

    // Recorded args of every OutboundClient.fetchGuild() the callback makes.
    // E2E regression lock (2026-10-02): the pre-fix code passed the EXTERNAL
    // guild id (string), so the real OutboundClient guard threw on every
    // login and the bot-visibility filter silently never ran. A throw-based
    // assert would pass (throw → keep row), so the callback round-trip test
    // asserts these ids are NUMBERS — the integer community id contract.
    visibilityCalls = [];

    const handlers = loginMod.createFluxerLoginHandlers({
      fluxerInstances: () => [instance],
      // Visibility stubs (spec § Guild intersection): null → drop, throw →
      // keep + warn, no client → keep id-only.
      getCommunityClient: (cid) => {
        if (cid === cidVanished) return { fetchGuild: async () => null };
        if (cid === cidFetchFail) {
          return {
            fetchGuild: async () => {
              throw new Error("simulated guild fetch failure");
            },
          };
        }
        if (cid === cidNoClient) return null;
        return {
          fetchGuild: async (id) => {
            visibilityCalls.push(id);
            return { id, name: "ok" };
          },
        };
      },
    });
    // Expose the handlers for the direct-drive logout test below.
    testHandlers = handlers;

    appServer = buildMiniApp(handlers);
    appServer.listen(0, "127.0.0.1");
    await once(appServer, "listening");
    appBase = `http://127.0.0.1:${appServer.address().port}`;
    process.env.PUBLIC_BASE_URL = appBase;
  });

  /** @type {ReturnType<typeof loginMod.createFluxerLoginHandlers>} */
  let testHandlers;

  after(async () => {
    if (appServer) {
      appServer.close();
      await once(appServer, "close");
    }
    if (mock?.server) {
      mock.server.close();
      await once(mock.server, "close");
    }
    for (const key of ENV_KEYS) {
      if (savedEnv?.[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv?.[key];
    }
    if (loaded?.tmpDir) {
      try {
        fs.rmSync(loaded.tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  /** Drive GET /auth/fluxer/:slug/login and parse the authorize URL. */
  async function fluxLoginStart(slug = SLUG, query = "") {
    const res = await fetch(`${appBase}/auth/fluxer/${slug}/login${query}`, {
      redirect: "manual",
    });
    const location = res.headers.get("location");
    return { res, location, authorizeUrl: location ? new URL(location) : null };
  }

  /** Drive GET /auth/fluxer/:slug/callback. */
  async function fluxCallback(slug, state, code, extraQuery = "") {
    const params = new URLSearchParams();
    if (code !== null) params.set("code", code ?? "fx-auth-code");
    if (state !== null) params.set("state", state);
    const res = await fetch(
      `${appBase}/auth/fluxer/${slug}/callback?${params}${extraQuery}`,
      { redirect: "manual" }
    );
    return { res, state };
  }

  // -------------------------------------------------------------------------
  // GET /auth/fluxer/:slug/login — authorize URL + PKCE + transaction row
  // -------------------------------------------------------------------------

  describe("GET /auth/fluxer/:slug/login", () => {
    it("302s with the spec authorize query and writes the verifier row BEFORE the redirect", async () => {
      const { res, location, authorizeUrl } = await fluxLoginStart();
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.getSetCookie().length, 0, "login start sets no cookie");

      assert.equal(authorizeUrl.origin + authorizeUrl.pathname, `${mock.base}/v1/oauth2/authorize`);
      assert.equal(authorizeUrl.searchParams.get("response_type"), "code");
      assert.equal(authorizeUrl.searchParams.get("client_id"), FX_CLIENT_ID);
      assert.equal(authorizeUrl.searchParams.get("scope"), "identify guilds");
      assert.match(location, /scope=identify%20guilds&/, "docs-mandated %20 encoding");
      assert.equal(authorizeUrl.searchParams.get("prompt"), "consent");
      assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
      const challenge = authorizeUrl.searchParams.get("code_challenge");
      assert.match(challenge, /^[A-Za-z0-9_-]{43}$/, "base64url, 43 chars, no padding");
      assert.equal(
        authorizeUrl.searchParams.get("redirect_uri"),
        `${appBase}/auth/fluxer/${SLUG}/callback`,
        "exact instance callback URL under our public base"
      );
      const state = authorizeUrl.searchParams.get("state");
      assert.ok(state, "signed state minted");
      // The URL carries the CHALLENGE only — no verifier-shaped secret next to it.
      assert.ok(!location.includes("code_verifier"));

      // The transaction row landed BEFORE the redirect, keyed by the nonce
      // inside the signed state (spec § PKCE and state).
      const nonce = stateBody(state).n;
      assert.match(nonce, /^[0-9a-f]{32}$/);
      const row = txRow(nonce);
      assert.ok(row, "verifier row exists for the state nonce");
      assert.equal(row.instance_key, INSTANCE_KEY);
      assert.equal(row.code_verifier.length, 43, "32 random bytes → 43 base64url chars");
      const lifeMs = row.expires_at - Date.now();
      assert.ok(
        lifeMs > 9 * 60 * 1000 && lifeMs <= 10 * 60 * 1000,
        `expires_at ≈ +10 min (got ${lifeMs}ms; state TTL 15 min ⇒ 10 min wins)`
      );
      // PKCE binding: challenge = base64url(sha256(verifier)) — S256, never plain.
      assert.equal(
        crypto.createHash("sha256").update(row.code_verifier).digest("base64url"),
        challenge
      );
    });

    it("unknown and malformed slugs 404 (fail closed, nothing minted)", async () => {
      const before = api.db
        .prepare("SELECT COUNT(*) AS n FROM fluxer_oauth_transactions")
        .get().n;

      const unknown = await fluxLoginStart("deadbeefdeadbeef");
      assert.equal(unknown.res.status, 404);
      assert.match(await unknown.res.text(), /not configured/i);

      const malformed = await fluxLoginStart("zz");
      assert.equal(malformed.res.status, 404);

      const short = await fluxLoginStart("abc123");
      assert.equal(short.res.status, 404);

      assert.equal(
        api.db.prepare("SELECT COUNT(*) AS n FROM fluxer_oauth_transactions").get().n,
        before,
        "no transaction rows for dead links"
      );
    });
  });

  // -------------------------------------------------------------------------
  // Full round-trip: login → callback
  // -------------------------------------------------------------------------

  describe("callback round trip", () => {
    it("sets ONLY web_session_fx, stores the encrypted pair + intersection snapshot", async () => {
      const { authorizeUrl } = await fluxLoginStart();
      const state = authorizeUrl.searchParams.get("state");
      const nonce = stateBody(state).n;
      const txBefore = txRow(nonce);
      assert.ok(txBefore, "transaction row from the login start");

      const tokenCallsBefore = mock.state.tokenCalls.length;
      const apiCallsBefore = mock.state.apiCalls.length;

      const { res } = await fluxCallback(SLUG, state, "fx-code-1");
      assert.equal(res.status, 302, "redirect to home");
      assert.equal(res.headers.get("location"), "/");
      assert.equal(res.headers.get("cache-control"), "no-store");

      // --- cookie: exactly ONE, the Fluxer cookie (§ K11) --------------------
      const setCookies = res.headers.getSetCookie();
      assert.equal(setCookies.length, 1, "exactly one Set-Cookie");
      assert.match(setCookies[0], /^web_session_fx=/, "the Fluxer cookie name");
      assert.ok(
        !setCookies.some((c) => c.startsWith("web_session=")),
        "the Discord cookie is never written from a Fluxer path"
      );
      assert.match(setCookies[0], /HttpOnly/);
      assert.match(setCookies[0], /SameSite=Lax/);
      assert.match(setCookies[0], /Path=\//);
      const newId = cookieValue(setCookies[0], "web_session_fx");
      assert.match(newId, /^[0-9a-f]{64}$/, "opaque 64-hex session id");

      // --- session row: platform + instance identity (spec § Session columns)
      const row = api.getWebSession(newId);
      assert.ok(row, "session row exists");
      assert.equal(row.user_id, FX_USER_ID, "user_id is the userinfo sub");
      assert.equal(row.platform, "fluxer");
      assert.equal(row.instance_key, INSTANCE_KEY);

      // --- token storage: ciphertext pair, never plaintext (§8.7) -----------
      const auth = api.getWebSessionAuth(newId);
      assert.ok(auth, "auth row present");
      assert.ok(
        auth.refresh_expires_at > Date.now(),
        "refresh horizon stored (30d from the mock's refresh_expires_in)"
      );
      assert.ok(auth.access_token_enc.startsWith("v1."), "versioned envelope");
      assert.ok(!JSON.stringify(auth).includes(FX_AT));
      assert.ok(!JSON.stringify(auth).includes(FX_REFRESH));
      assert.equal(tokens.decryptAccessToken(auth.access_token_enc), FX_AT);
      assert.ok(auth.refresh_token_enc, "refresh token stored encrypted (spec § Token exchange)");
      assert.equal(tokens.decryptAccessToken(auth.refresh_token_enc), FX_REFRESH);
      const lifeMs = auth.token_expires_at - Date.now();
      assert.ok(
        lifeMs > 604_800_000 - 60_000 && lifeMs <= 604_800_000,
        `token_expires_at ≈ +7d (got ${lifeMs}ms)`
      );
      assert.equal(auth.scopes, "identify guilds");

      // --- guild snapshot: communities ∩ visibility, NOT raw user guilds ----
      const snapshot = JSON.parse(auth.guild_snapshot);
      assert.deepEqual(
        snapshot.map((g) => g.id),
        [FX_GUILD_SHARED, FX_GUILD_FETCH_FAIL, FX_GUILD_NO_CLIENT],
        "registered communities kept (visibility ok, fetch threw, no client); unregistered dropped; vanished dropped"
      );
      assert.equal(snapshot[0].owner, true);
      assert.equal(snapshot[0].permissions, "36953089", "decimal string preserved");
      assert.equal(snapshot[2].permissions, "0", "null permissions → \"0\", never Number()");

      // --- visibility checks are addressed by COMMUNITY ID, not snowflake ---
      // (E2E regression, 2026-10-02: the callback passed the external string
      // id to OutboundClient.fetchGuild, which takes the integer community id;
      // the guard threw on every login and the filter silently no-op'd.)
      assert.ok(visibilityCalls.length > 0, "visibility checks ran");
      for (const id of visibilityCalls) {
        assert.equal(
          typeof id,
          "number",
          `fetchGuild must receive the numeric community id, got ${typeof id} ${JSON.stringify(id)}`
        );
      }

      // --- token exchange call shape (live-docs rules + PKCE verifier) ------
      assert.equal(mock.state.tokenCalls.length, tokenCallsBefore + 1);
      const tok = mock.state.tokenCalls.at(-1);
      assert.match(tok.contentType, /^application\/x-www-form-urlencoded/);
      assert.equal(
        tok.authorization,
        `Basic ${Buffer.from(`${FX_CLIENT_ID}:${FX_CLIENT_SECRET}`).toString("base64")}`
      );
      assert.equal(tok.form.grant_type, "authorization_code");
      assert.equal(tok.form.code, "fx-code-1");
      assert.equal(tok.form.redirect_uri, `${appBase}/auth/fluxer/${SLUG}/callback`);
      assert.equal(
        tok.form.redirect_uri,
        authorizeUrl.searchParams.get("redirect_uri"),
        "redirect_uri rebuilt BYTE-IDENTICAL to the authorize"
      );
      assert.equal(
        tok.form.code_verifier,
        txBefore.code_verifier,
        "the exchange presents the STORED verifier for this nonce"
      );

      // --- API calls ride the bearer AT --------------------------------------
      const apiCalls = mock.state.apiCalls.slice(apiCallsBefore);
      assert.deepEqual(
        apiCalls.map((c) => c.path),
        ["/v1/oauth2/userinfo", "/v1/users/@me/guilds"]
      );
      for (const call of apiCalls) {
        assert.equal(call.authorization, `Bearer ${FX_AT}`);
      }

      // --- single use: the transaction row is consumed -----------------------
      assert.equal(txRow(nonce), undefined, "DELETE…RETURNING consumed the row");
    });

    it("second callback with the same state → 400 (transaction consumed; no second exchange)", async () => {
      const { authorizeUrl } = await fluxLoginStart();
      const state = authorizeUrl.searchParams.get("state");
      const before = mock.state.tokenCalls.length;

      const first = await fluxCallback(SLUG, state, "code-first");
      assert.equal(first.res.status, 302);

      const replay = await fluxCallback(SLUG, state, "code-replay");
      assert.equal(replay.res.status, 400);
      assert.match(await replay.res.text(), /invalid, expired, or already used/i);
      assert.equal(mock.state.tokenCalls.length, before + 1, "the replay never reaches the exchange");
    });

    it("rejects a Discord-purpose (web_login) state on the Fluxer callback", async () => {
      const before = mock.state.tokenCalls.length;
      oauthState._resetNoncesForTests();
      const discordState = oauthState.createOAuthState({ purpose: "web_login" });
      const { res } = await fluxCallback(SLUG, discordState, "code-x");
      assert.equal(res.status, 400);
      assert.equal(mock.state.tokenCalls.length, before);
    });

    it("rejects a transaction bound to a different instance key", async () => {
      const { authorizeUrl } = await fluxLoginStart();
      const state = authorizeUrl.searchParams.get("state");
      const nonce = stateBody(state).n;
      // Simulate a tx row minted for ANOTHER instance under this nonce.
      api.db
        .prepare("UPDATE fluxer_oauth_transactions SET instance_key=? WHERE nonce=?")
        .run("https://other.fluxer.instance", nonce);
      const before = mock.state.tokenCalls.length;

      const { res } = await fluxCallback(SLUG, state, "code-mismatch");
      assert.equal(res.status, 400);
      assert.equal(mock.state.tokenCalls.length, before, "mismatch fails before the exchange");
    });

    it("?error=access_denied → 400 Login cancelled, zero token calls", async () => {
      const before = mock.state.tokenCalls.length;
      const { authorizeUrl } = await fluxLoginStart();
      const state = authorizeUrl.searchParams.get("state");
      const res = await fetch(
        `${appBase}/auth/fluxer/${SLUG}/callback?error=access_denied&state=${encodeURIComponent(state)}`,
        { redirect: "manual" }
      );
      assert.equal(res.status, 400);
      const body = await res.text();
      assert.match(body, /Login cancelled/i);
      assert.match(body, /access_denied/, "the OAuth error code is the cause shown");
      assert.equal(mock.state.tokenCalls.length, before);
    });

    it("missing code or state → 400 (never echoed)", async () => {
      const noCode = await fetch(`${appBase}/auth/fluxer/${SLUG}/callback?state=x`, {
        redirect: "manual",
      });
      assert.equal(noCode.status, 400);
      const noState = await fetch(`${appBase}/auth/fluxer/${SLUG}/callback?code=y`, {
        redirect: "manual",
      });
      assert.equal(noState.status, 400);
    });

    it("userinfo missing sub → failure page names ONLY the shape code, never token material", async () => {
      const user = mock.state.user;
      mock.state.user = { username: "ghost" }; // no sub
      try {
        const { authorizeUrl } = await fluxLoginStart();
        const state = authorizeUrl.searchParams.get("state");
        const { res } = await fluxCallback(SLUG, state, "code-nosub");
        assert.equal(res.status, 500);
        const body = await res.text();
        assert.match(body, /Login failed/i);
        assert.match(body, /fluxer_userinfo_shape/, "the specific shape code is the cause shown");
        assert.ok(!body.includes(FX_AT), "no access token on the page");
        assert.ok(!body.includes(FX_REFRESH), "no refresh token on the page");
      } finally {
        mock.state.user = user;
      }
    });

    it("token exchange failure renders ONLY the OAuth error code (never error_description)", async () => {
      mock.state.tokenError = {
        status: 400,
        body: {
          error: "invalid_grant",
          error_description: "leaky description with code_verifier=SECRET-VALUE",
        },
      };
      try {
        const { authorizeUrl } = await fluxLoginStart();
        const state = authorizeUrl.searchParams.get("state");
        const { res } = await fluxCallback(SLUG, state, "code-bad");
        assert.equal(res.status, 500);
        const body = await res.text();
        assert.match(body, /Login failed/i);
        assert.match(body, /invalid_grant/, "the machine error code is shown");
        assert.ok(!body.includes("leaky description"), "error_description never rendered");
        assert.ok(!body.includes("SECRET-VALUE"), "verifier material never rendered");
      } finally {
        mock.state.tokenError = null;
      }
    });

    it("publishes req.rateLimitUserHint = userinfo sub (§8.7 user bucket)", async () => {
      // Direct-drive so the req object is observable.
      const { authorizeUrl } = await fluxLoginStart();
      const state = authorizeUrl.searchParams.get("state");
      const req = {
        url: `/auth/fluxer/${SLUG}/callback?code=code-hint&state=${encodeURIComponent(state)}`,
        params: { slug: SLUG },
      };
      const { res, out } = captureRes();
      await testHandlers.handleFluxerLoginCallback(req, res);
      assert.equal(out.statusCode, 302);
      assert.equal(req.rateLimitUserHint, FX_USER_ID);
    });
  });

  // -------------------------------------------------------------------------
  // POST /auth/fluxer/logout — clears ONLY the Fluxer cookie (K11)
  // -------------------------------------------------------------------------

  describe("POST /auth/fluxer/logout", () => {
    it("destroys the fluxer session row and clears web_session_fx only", () => {
      const session = sessions.createSession({
        userId: FX_USER_ID,
        platform: "fluxer",
        instanceKey: INSTANCE_KEY,
      });
      const { res, out } = captureRes();
      testHandlers.fluxerLogout({ fluxerSession: session }, res);

      assert.equal(out.statusCode, 302);
      assert.equal(out.headers.Location, "/auth/login?signedout=1");
      const clear = out.headers["Set-Cookie"];
      assert.match(clear, /^web_session_fx=; /, "the Fluxer cookie is cleared");
      assert.match(clear, /Max-Age=0/);
      assert.match(clear, /HttpOnly/);
      assert.ok(
        !clear.startsWith("web_session="),
        "the Discord cookie is never cleared from a Fluxer path (K11)"
      );
      assert.equal(api.getWebSession(session.id), null, "session row destroyed on logout");
    });

    it("anonymous logout is an idempotent 302 (no row, no crash)", () => {
      const { res, out } = captureRes();
      testHandlers.fluxerLogout({}, res);
      assert.equal(out.statusCode, 302);
      assert.equal(out.headers.Location, "/auth/login?signedout=1");
    });
  });
});
