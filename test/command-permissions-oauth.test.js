const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT (same as test/command-visibility.test.js): loadDb() must stay above
// every `src/` require — it points this process at a private temp DB (fresh
// DB_PATH + src require-cache reset) before those requires load. oauthTokens
// persists tokens through the real db facade, so it runs against this temp DB.
const { cleanup, api: dbApi } = loadDb();

// Closes the tracked DB handles and removes the temp dir (idempotent).
after(cleanup);

// ── Real modules under test ─────────────────────────────────────────────────
// Hold the REAL oauthTokens reference before the require-cache stubs below are
// installed; stubbing the cache entry does not affect an already-held ref.
const oauthTokens = require("../src/features/commandPermissions/oauthTokens");
const {
  getCommandPermissionOAuthConfig,
} = require("../src/features/commandPermissions/config");
const {
  createOAuthState,
  _resetNoncesForTests,
} = require("../src/features/commandPermissions/oauthState");

const TOKEN_URL = "https://discord.com/api/v10/oauth2/token";

// ── Env control ─────────────────────────────────────────────────────────────
// Every value below is a clearly-fake placeholder (AGENTS.md: no real-looking
// secrets anywhere, incl. tests).
const FAKE_CLIENT_ID = "123456789012345678";
const FAKE_CLIENT_SECRET = "fake-client-secret-not-a-real-secret";
const FAKE_PUBLIC_BASE = "https://bot.example.test"; // RFC 2606 reserved TLD
const DERIVED_REDIRECT_URI =
  "https://bot.example.test/oauth/command-permissions/callback";

const OAUTH_ENV_KEYS = [
  "CLIENT_ID",
  "CLIENT_SECRET",
  "PUBLIC_HTTP_PORT",
  "TICKET_HTTP_PORT",
  "PUBLIC_BASE_URL",
  "TICKET_PUBLIC_BASE_URL",
  "OAUTH_REDIRECT_URI",
  "OAUTH_STATE_SECRET",
];

const envSnapshot = Object.fromEntries(
  OAUTH_ENV_KEYS.map((k) => [k, process.env[k] ?? null])
);

/** Point env at a fully-configured OAuth setup with the fake values above. */
function useConfiguredEnv() {
  for (const k of OAUTH_ENV_KEYS) delete process.env[k];
  process.env.CLIENT_ID = FAKE_CLIENT_ID;
  process.env.CLIENT_SECRET = FAKE_CLIENT_SECRET;
  process.env.TICKET_HTTP_PORT = "3777";
  process.env.TICKET_PUBLIC_BASE_URL = FAKE_PUBLIC_BASE;
}

function restoreEnvSnapshot() {
  for (const k of OAUTH_ENV_KEYS) {
    const v = envSnapshot[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
}

// ── fetch mocking ───────────────────────────────────────────────────────────
let prevFetch;

/**
 * Replace global.fetch with a recording responder. Tests never hit network:
 * beforeEach installs a tripwire that throws if any code reaches real fetch.
 * @param {(url: string, opts: object) => object} respond
 * @returns {{ calls: {url: string, opts: object}[] }}
 */
function mockFetch(respond) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return respond(String(url), opts);
  };
  return { calls };
}

/**
 * Minimal fake of the fetch Response surface postToken/oauthTokens use.
 * @param {number} status
 * @param {unknown} payload result of res.json(); pass `{ jsonThrows: true }`
 *   as payload to emulate a non-JSON body.
 */
function tokenResponse(status, payload) {
  const jsonThrows = payload && payload.jsonThrows;
  const body = jsonThrows ? null : payload;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (jsonThrows) throw new Error("body not JSON");
      return body;
    },
    text: async () => (jsonThrows ? "Bad Gateway" : JSON.stringify(body)),
    headers: { get: () => null },
  };
}

/** Body sent by postToken (URLSearchParams) as a plain object. */
function bodyParams(opts) {
  return Object.fromEntries(new URLSearchParams(String(opts.body)));
}

beforeEach(() => {
  prevFetch = global.fetch;
  // Tripwire: any un-mocked network attempt fails the test loudly.
  global.fetch = async (url) => {
    throw new Error(`network is blocked in tests (fetch called: ${url})`);
  };
  useConfiguredEnv();
  _resetNoncesForTests();
  // Fresh stub calls/impls per test (keeps tests order-independent).
  exchangeCalls.length = 0;
  syncCalls.length = 0;
  exchangeImpl = async () => ({ accessToken: "at-from-exchange" });
  syncImpl = async () => ({
    updated: ["note", "setxp"],
    failed: [],
    missingCommands: [],
    roleCount: 2,
  });
});

afterEach(() => {
  global.fetch = prevFetch;
  restoreEnvSnapshot();
});

// ── httpCallback module under test (with stubbed collaborators) ─────────────
// httpCallback destructures its collaborators at require time, so the stubs
// must be in the require cache BEFORE it is first required. Stubbing
// oauthTokens + sync keeps the callback tests deterministic: no real token
// exchange, no discord.js REST (which bypasses global fetch), no sleeps.
// oauthState stays REAL so HMAC state verification genuinely executes.
const exchangeCalls = [];
const syncCalls = [];
let exchangeImpl = async () => ({ accessToken: "at-from-exchange" });
let syncImpl = async () => ({
  updated: ["note", "setxp"],
  failed: [],
  missingCommands: [],
  roleCount: 2,
});

function installModuleStub(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { exports, loaded: true, filename };
}

installModuleStub("../src/features/commandPermissions/oauthTokens", {
  SCOPE: oauthTokens.SCOPE,
  buildAuthorizeUrl: () => {
    throw new Error("unexpected buildAuthorizeUrl call in stub");
  },
  exchangeAuthorizationCode: async (opts) => {
    exchangeCalls.push(opts);
    return exchangeImpl(opts);
  },
  getValidAccessToken: async () => {
    throw new Error("unexpected getValidAccessToken call in stub");
  },
});
installModuleStub("../src/features/commandPermissions/sync", {
  applyGuildCommandPermissions: async (guildId, opts) => {
    syncCalls.push({ guildId, opts });
    return syncImpl(guildId, opts);
  },
  maybeAutoSyncCommandPermissions: async () => {},
});

const {
  handleCommandPermissionOAuthCallback,
} = require("../src/features/commandPermissions/httpCallback");

/** Plain fake of the http req the callback handler reads (method only). */
function makeReq(method = "GET") {
  return { method };
}

/** Plain fake of ServerResponse recording writeHead/end for assertions. */
function makeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    chunks: [],
    ended: false,
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers ?? null;
      return res;
    },
    end(chunk) {
      if (chunk != null) res.chunks.push(String(chunk));
      res.ended = true;
    },
    get body() {
      return res.chunks.join("");
    },
  };
  return res;
}

/** Build the mounted callback URL with query params. */
function callbackUrl(params = {}) {
  const url = new URL(`${FAKE_PUBLIC_BASE}/oauth/command-permissions/callback`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

// ════════════════════════════════════════════════════════════════════════════
describe("oauthTokens.exchangeAuthorizationCode", () => {
  // Objective: "Valid state + code → successful exchange path". This is the
  // token-exchange half of that flow: exchangeAuthorizationCode must POST the
  // authorization-code grant to Discord's token endpoint with exactly the
  // configured credentials/params and persist the returned tokens.
  it("posts authorization_code grant to Discord and persists returned tokens", async () => {
    // Arrange
    const { calls } = mockFetch(() =>
      tokenResponse(200, {
        access_token: "at-ex-1",
        refresh_token: "rt-ex-1",
        expires_in: 600,
        token_type: "Bearer",
      })
    );
    const before = Date.now();

    // Act
    const result = await oauthTokens.exchangeAuthorizationCode({
      guildId: "g-ex-ok",
      code: "the-code",
      authorizedByUserId: "u-auth",
    });
    const after = Date.now();

    // Assert — exactly one request, to the token endpoint
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, TOKEN_URL);
    assert.equal(calls[0].opts.method, "POST");
    assert.equal(
      calls[0].opts.headers["Content-Type"],
      "application/x-www-form-urlencoded"
    );

    // Credentials ride the Basic auth header (not body params): pin that the
    // header decodes to exactly `<CLIENT_ID>:<CLIENT_SECRET>`.
    const basic = Buffer.from(
      calls[0].opts.headers.Authorization.replace(/^Basic /, ""),
      "base64"
    ).toString("utf8");
    assert.equal(basic, `${FAKE_CLIENT_ID}:${FAKE_CLIENT_SECRET}`);

    // Body carries grant_type/code/redirect_uri (redirect derived from
    // TICKET_PUBLIC_BASE_URL), and never leaks the secret into the body.
    const form = bodyParams(calls[0].opts);
    assert.equal(form.grant_type, "authorization_code");
    assert.equal(form.code, "the-code");
    assert.equal(form.redirect_uri, DERIVED_REDIRECT_URI);
    assert.ok(!JSON.stringify(form).includes(FAKE_CLIENT_SECRET));

    // Outcome: access token returned AND persisted for later refresh.
    assert.equal(result.accessToken, "at-ex-1");
    const row = dbApi.getCommandPermissionOauth("g-ex-ok");
    assert.ok(row, "exchange must persist the oauth row");
    assert.equal(row.access_token, "at-ex-1");
    assert.equal(row.refresh_token, "rt-ex-1");
    assert.equal(row.authorized_by_user_id, "u-auth");
    assert.ok(
      row.access_expires_at >= before + 600_000 &&
        row.access_expires_at <= after + 600_000,
      `access_expires_at must be now + expires_in*1000, got ${row.access_expires_at}`
    );
  });

  // Objective: "Discord returns 4xx (e.g. 400 invalid_grant) → surfaced as a
  // SPECIFIC cause" (AGENTS.md error law #3: never generic "unknown error").
  // Negative test: a dead/replayed code must surface Discord's description,
  // carry machine-readable codes, and write NOTHING to the DB.
  it("surfaces Discord's 400 invalid_grant cause and persists nothing", async () => {
    // Arrange
    const { calls } = mockFetch(() =>
      tokenResponse(400, {
        error: "invalid_grant",
        error_description: 'Invalid "code" in OAuth2 RoC grant.',
      })
    );

    // Act
    const err = await oauthTokens
      .exchangeAuthorizationCode({ guildId: "g-ex-badcode", code: "stale-code" })
      .catch((e) => e);

    // Assert
    assert.ok(err instanceof Error, "exchange must reject");
    assert.equal(
      err.message,
      'Invalid "code" in OAuth2 RoC grant.',
      "user-facing message must carry Discord's specific cause, not a generic"
    );
    assert.equal(err.code, "invalid_grant");
    assert.equal(err.status, 400);
    assert.equal(calls.length, 1);
    assert.equal(
      dbApi.getCommandPermissionOauth("g-ex-badcode"),
      null,
      "failed exchange must not persist tokens"
    );
  });

  // Edge: HTTP 200 but a body without the tokens we require → specific error
  // and no half-written row (guards against persisting an unusable grant).
  it("rejects a success response missing refresh_token and writes no row", async () => {
    // Arrange
    mockFetch(() => tokenResponse(200, { access_token: "at-only" }));

    // Act
    const err = await oauthTokens
      .exchangeAuthorizationCode({ guildId: "g-ex-partial", code: "c" })
      .catch((e) => e);

    // Assert
    assert.match(err.message, /missing refresh_token or access_token/i);
    assert.equal(dbApi.getCommandPermissionOauth("g-ex-partial"), null);
  });

  // Objective: "Missing config (CLIENT_SECRET etc.) → the documented gate".
  // Negative test: exchange must fail with the named-missing-var gate BEFORE
  // any network call (fetch tripwire stays armed and must not fire).
  it("gates on missing CLIENT_SECRET/CLIENT_ID naming each var, without network", async () => {
    // Arrange
    const { calls } = mockFetch(() => tokenResponse(200, {}));
    delete process.env.CLIENT_SECRET;
    delete process.env.CLIENT_ID;

    const cfg = getCommandPermissionOAuthConfig();
    assert.equal(cfg.ready, false);
    assert.deepEqual(cfg.missing.slice(0, 2), ["CLIENT_ID", "CLIENT_SECRET"]);

    // Act
    const err = await oauthTokens
      .exchangeAuthorizationCode({ guildId: "g-ex-nocfg", code: "c" })
      .catch((e) => e);

    // Assert
    assert.match(err.message, /^OAuth not configured: missing CLIENT_ID, CLIENT_SECRET/);
    assert.equal(calls.length, 0, "gate must reject before any fetch");
  });

  // Edge: error body is not JSON → cause degrades to the status-specific
  // fallback (still not a bare generic), with token_error code for callers.
  it("falls back to the status-specific cause when the error body is not JSON", async () => {
    // Arrange
    mockFetch(() => tokenResponse(502, { jsonThrows: true }));

    // Act
    const err = await oauthTokens
      .exchangeAuthorizationCode({ guildId: "g-ex-html", code: "c" })
      .catch((e) => e);

    // Assert
    assert.equal(err.message, "token exchange HTTP 502");
    assert.equal(err.code, "token_error");
    assert.equal(err.status, 502);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("oauthTokens.getValidAccessToken", () => {
  // Positive: an unexpired cached token must be served from the DB with zero
  // network (tripwire fetch stays armed — it throws if called at all).
  it("returns the cached token without any network call while unexpired", async () => {
    // Arrange
    dbApi.upsertCommandPermissionOauth("g-tok-fresh", {
      refreshToken: "rt-fresh",
      accessToken: "at-fresh",
      accessExpiresAt: Date.now() + 600_000,
    });

    // Act
    const token = await oauthTokens.getValidAccessToken("g-tok-fresh");

    // Assert
    assert.equal(token, "at-fresh");
  });

  // Refresh path: expired access token → refresh_token grant (no redirect_uri
  // needed), new token persisted, rotated refresh_token stored too.
  it("refreshes an expired token via refresh_token grant and persists rotation", async () => {
    // Arrange
    dbApi.upsertCommandPermissionOauth("g-tok-expired", {
      refreshToken: "rt-old",
      accessToken: "at-old",
      accessExpiresAt: Date.now() - 1000,
    });
    const { calls } = mockFetch(() =>
      tokenResponse(200, {
        access_token: "at-new",
        refresh_token: "rt-rotated",
        expires_in: 3600,
      })
    );

    // Act
    const token = await oauthTokens.getValidAccessToken("g-tok-expired");

    // Assert
    assert.equal(token, "at-new");
    assert.equal(calls.length, 1);
    const form = bodyParams(calls[0].opts);
    assert.equal(form.grant_type, "refresh_token");
    assert.equal(form.refresh_token, "rt-old");
    assert.ok(!("redirect_uri" in form), "refresh grant must not send redirect_uri");
    const row = dbApi.getCommandPermissionOauth("g-tok-expired");
    assert.equal(row.access_token, "at-new");
    assert.equal(row.refresh_token, "rt-rotated", "rotated refresh token must be stored");
    assert.ok(row.access_expires_at > Date.now());
  });

  // Negative: unknown guild → specific "not_authorized" cause with machine
  // code (sync callers translate this to an actionable message).
  it("rejects with not_authorized for a guild that never authorized", async () => {
    // Act
    const err = await oauthTokens
      .getValidAccessToken("g-tok-none")
      .catch((e) => e);

    // Assert
    assert.equal(err.code, "not_authorized");
    assert.match(err.message, /has not authorized command permission sync/);
  });

  // Objective: "Discord returns 4xx → surfaced as a SPECIFIC cause".
  // Negative: a revoked refresh token (400 invalid_grant) must (a) surface
  // Discord's specific description, (b) tag err.code "reauth_required", and
  // (c) drop the dead row so the guild is forced through a fresh consent.
  it("drops the stored grant and tags reauth_required when refresh is 400 invalid_grant", async () => {
    // Arrange
    dbApi.upsertCommandPermissionOauth("g-tok-dead", {
      refreshToken: "rt-dead",
      accessToken: "at-dead",
      accessExpiresAt: Date.now() - 1000,
    });
    mockFetch(() =>
      tokenResponse(400, {
        error: "invalid_grant",
        error_description: "Invalid Refresh Token",
      })
    );

    // Act
    const err = await oauthTokens
      .getValidAccessToken("g-tok-dead")
      .catch((e) => e);

    // Assert
    assert.equal(err.message, "Invalid Refresh Token");
    assert.equal(err.status, 400);
    assert.equal(
      err.code,
      "reauth_required",
      "callers must be able to distinguish re-auth from generic failures"
    );
    assert.equal(
      dbApi.getCommandPermissionOauth("g-tok-dead"),
      null,
      "dead grant must be deleted so a fresh authorize flow is required"
    );
  });

  // Edge: a non-4xx refresh failure (e.g. Discord 500) is transient — the
  // stored grant must SURVIVE so the next attempt can succeed.
  it("keeps the stored grant when refresh fails transiently (500)", async () => {
    // Arrange
    dbApi.upsertCommandPermissionOauth("g-tok-500", {
      refreshToken: "rt-ok",
      accessToken: "at-stale",
      accessExpiresAt: Date.now() - 1000,
    });
    mockFetch(() => tokenResponse(500, { error: "server_error" }));

    // Act
    const err = await oauthTokens
      .getValidAccessToken("g-tok-500")
      .catch((e) => e);

    // Assert
    assert.equal(err.code, "server_error");
    const row = dbApi.getCommandPermissionOauth("g-tok-500");
    assert.ok(row, "transient failure must not delete a potentially valid grant");
    assert.equal(row.refresh_token, "rt-ok");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("oauthTokens.buildAuthorizeUrl", () => {
  // Positive: the URL handed to the guild admin must carry every OAuth param
  // Discord requires for the consent flow (this URL is the ONLY place the
  // scope + derived redirect_uri reach the user).
  it("builds the consent URL with client, scope, derived redirect_uri, state", () => {
    // Act
    const url = new URL(oauthTokens.buildAuthorizeUrl("state-xyz"));

    // Assert
    assert.equal(`${url.origin}${url.pathname}`, "https://discord.com/oauth2/authorize");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("client_id"), FAKE_CLIENT_ID);
    assert.equal(url.searchParams.get("scope"), "applications.commands.permissions.update");
    assert.equal(url.searchParams.get("redirect_uri"), DERIVED_REDIRECT_URI);
    assert.equal(url.searchParams.get("state"), "state-xyz");
    assert.equal(url.searchParams.get("prompt"), "consent");
  });

  // Negative: same documented gate as the exchange — missing config names the
  // missing vars instead of emitting a broken authorize link.
  it("gates on missing config naming the missing vars", () => {
    // Arrange
    delete process.env.CLIENT_SECRET;

    // Act + Assert
    assert.throws(
      () => oauthTokens.buildAuthorizeUrl("s"),
      /^Error: OAuth not configured: missing CLIENT_SECRET/
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("handleCommandPermissionOAuthCallback", () => {
  // Objective: "Tampered/expired/unknown state → rejected with the specific
  // cause, NO token exchange attempted" — the public endpoint must never
  // trade an attacker-forged callback's code for a token.
  it("rejects tampered, expired, unknown, and replayed states without attempting an exchange", async () => {
    // Arrange
    const goodState = createOAuthState({ guildId: "g-cb", userId: "u-cb" });
    const tamperedState =
      goodState.slice(0, -4) + (goodState.endsWith("xxxx") ? "yyyy" : "xxxx");
    const expiredState = createOAuthState({
      guildId: "g-cb",
      userId: "u-cb",
      exp: Date.now() - 1000,
    });

    // Act — first use of goodState succeeds (baseline that the page WOULD
    // accept), every forged/stale/replayed variant must 400.
    const first = makeRes();
    await handleCommandPermissionOAuthCallback(
      makeReq(),
      first,
      callbackUrl({ code: "c1", state: goodState })
    );
    const replay = makeRes();
    await handleCommandPermissionOAuthCallback(
      makeReq(),
      replay,
      callbackUrl({ code: "c2", state: goodState }) // replayed nonce
    );
    const tampered = makeRes();
    await handleCommandPermissionOAuthCallback(
      makeReq(),
      tampered,
      callbackUrl({ code: "c3", state: tamperedState })
    );
    const expired = makeRes();
    await handleCommandPermissionOAuthCallback(
      makeReq(),
      expired,
      callbackUrl({ code: "c4", state: expiredState })
    );
    const unknown = makeRes();
    await handleCommandPermissionOAuthCallback(
      makeReq(),
      unknown,
      callbackUrl({ code: "c5", state: "garbage.notreallyasig" })
    );

    // Assert — the legitimate first callback passed verification and ran
    // exactly one exchange; every rejected callback ran none and got the
    // actionable "run /staff syncpermissions again" cause.
    assert.equal(first.statusCode, 200, "valid state baseline must succeed");
    for (const [label, res] of [
      ["replay", replay],
      ["tampered", tampered],
      ["expired", expired],
      ["unknown", unknown],
    ]) {
      assert.equal(res.statusCode, 400, `${label} state must be rejected with 400`);
      assert.match(res.body, /Invalid or expired link/);
      assert.match(
        res.body,
        /syncpermissions/,
        `${label} rejection must tell the user to get a fresh link`
      );
      assert.ok(
        !res.body.includes("Invalid &quot;code&quot;") &&
          !res.body.includes("token exchange"),
        `${label} rejection must not leak a token-endpoint error`
      );
    }
    assert.equal(
      exchangeCalls.length,
      1,
      "no token exchange may be attempted for forged/stale/replayed state"
    );
    assert.equal(exchangeCalls[0].code, "c1");
    assert.equal(syncCalls.length, 1);
  });

  // Objective: "Valid state + code → successful … session completion/DB
  // write if it writes" — HTTP half: identity from the SIGNED state (never
  // from query params) must drive the exchange, the fresh token must feed the
  // permission sync, and the completion page must summarize the result.
  it("completes the flow: state identities drive the exchange, token feeds sync, 200 page", async () => {
    // Arrange
    const state = createOAuthState({ guildId: "9001", userId: "5001" });
    const res = makeRes();

    // Act
    const handled = await handleCommandPermissionOAuthCallback(
      makeReq(),
      res,
      callbackUrl({ code: "cb-code", state })
    );

    // Assert — exchange got guild/user strictly from the verified state
    assert.equal(handled, true);
    assert.deepEqual(exchangeCalls, [
      { guildId: "9001", code: "cb-code", authorizedByUserId: "5001" },
    ]);
    // sync got the just-exchanged access token (skip-token-load path)
    assert.deepEqual(syncCalls, [
      { guildId: "9001", opts: { accessToken: "at-from-exchange" } },
    ]);
    // session completion page
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["Content-Type"], /^text\/html/);
    assert.match(res.body, /Command visibility synced/);
    assert.match(res.body, /Updated <strong>2<\/strong> staff command/);
    assert.match(res.body, /<code>9001<\/code>/);
    assert.match(res.body, /<strong>2<\/strong> staff role/);
    assert.ok(!res.body.includes("Some commands failed"));
  });

  // Objective: "Discord returns 4xx → surfaced as a SPECIFIC cause" at the
  // HTTP layer (error law #3): the failure page must show the real cause and
  // log it with the feature prefix — never a bare "Unknown error".
  it("renders the specific exchange cause on a 500 page and logs it", async () => {
    // Arrange
    exchangeImpl = async () => {
      const err = new Error('Invalid "code" in OAuth2 RoC grant.');
      err.code = "invalid_grant";
      err.status = 400;
      throw err;
    };
    const state = createOAuthState({ guildId: "g-cb-err", userId: "u1" });
    const logs = [];
    const origError = console.error;
    console.error = (...args) => logs.push(args.join(" "));
    const res = makeRes();

    let handled;
    try {
      // Act
      handled = await handleCommandPermissionOAuthCallback(
        makeReq(),
        res,
        callbackUrl({ code: "bad-code", state })
      );
    } finally {
      console.error = origError;
    }

    // Assert
    assert.equal(handled, true);
    assert.equal(res.statusCode, 500);
    assert.match(res.body, /Sync failed/);
    assert.match(
      res.body,
      /Invalid &quot;code&quot; in OAuth2 RoC grant\./,
      "page must carry the specific cause (HTML-escaped)"
    );
    assert.ok(
      !res.body.includes("Unknown error"),
      "page must not fall back to a generic message when a cause exists"
    );
    assert.ok(
      logs.some(
        (l) =>
          l.includes("[commandPermissions] OAuth callback error:") &&
          l.includes('Invalid "code"')
      ),
      `failure must be logged with feature prefix + cause, got: ${JSON.stringify(logs)}`
    );
    assert.equal(syncCalls.length, 0, "no sync after a failed exchange");
  });

  // Error law #5 (partial failures report partials): the success page must
  // name commands that failed to sync and commands not yet registered.
  it("reports partial sync failures and unregistered commands on the page", async () => {
    // Arrange
    syncImpl = async () => ({
      updated: ["note"],
      failed: [{ name: "warn-admin", error: "PUT permissions failed (403)" }],
      missingCommands: ["gork"],
      roleCount: 1,
    });
    const state = createOAuthState({ guildId: "g-cb-part", userId: "u1" });
    const res = makeRes();

    // Act
    await handleCommandPermissionOAuthCallback(
      makeReq(),
      res,
      callbackUrl({ code: "c", state })
    );

    // Assert
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Some commands failed:<\/strong> warn-admin/);
    assert.match(res.body, /Not registered in this guild yet: gork/);
    assert.match(res.body, /Updated <strong>1<\/strong> staff command/);
  });

  // Negative (hardening): missing code or state is named as the cause, and
  // nothing is attempted.
  it("rejects callbacks missing code or state with 400 naming them", async () => {
    // Arrange — state alone and code alone
    const state = createOAuthState({ guildId: "g-cb-miss", userId: "u1" });

    // Act
    const noCode = makeRes();
    await handleCommandPermissionOAuthCallback(
      makeReq(),
      noCode,
      callbackUrl({ state })
    );
    const noState = makeRes();
    await handleCommandPermissionOAuthCallback(
      makeReq(),
      noState,
      callbackUrl({ code: "only-code" })
    );

    // Assert
    for (const res of [noCode, noState]) {
      assert.equal(res.statusCode, 400);
      assert.match(res.body, /Invalid callback/);
      assert.match(res.body, /Missing <code>code<\/code> or <code>state<\/code>/);
    }
    assert.equal(exchangeCalls.length, 0);
  });

  // Hardening (XSS): Discord-supplied error/error_description comes straight
  // from attacker-influenceable query params — it must be HTML-escaped while
  // still surfacing the specific cause (law #3 at the public HTTP edge).
  it("HTML-escapes Discord error params instead of injecting markup", async () => {
    // Act
    const res = makeRes();
    const handled = await handleCommandPermissionOAuthCallback(
      makeReq(),
      res,
      callbackUrl({
        error: "access_denied",
        error_description: '<script>alert("xss")</script>',
      })
    );

    // Assert
    assert.equal(handled, true);
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /Authorization cancelled/);
    assert.match(res.body, /&lt;script&gt;alert\(&quot;xss&quot;\)/);
    assert.ok(!res.body.includes('<script>alert("xss")'), "raw markup must not reach the page");
    assert.equal(exchangeCalls.length, 0);
  });

  // Negative (hardening): only GET is handled; other methods get 405 without
  // touching the OAuth pipeline.
  it("answers non-GET with 405 and performs no exchange", async () => {
    // Act
    const res = makeRes();
    const handled = await handleCommandPermissionOAuthCallback(
      makeReq("POST"),
      res,
      callbackUrl({ code: "c", state: "whatever" })
    );

    // Assert
    assert.equal(handled, true);
    assert.equal(res.statusCode, 405);
    assert.equal(res.body, "Method not allowed");
    assert.equal(exchangeCalls.length, 0);
  });
});
