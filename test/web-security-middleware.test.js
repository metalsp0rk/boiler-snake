/**
 * Unit tests for the Phase 0b security middlewares (roadmap/web-admin.md
 * §8.7, subtask 08):
 *
 *  - src/web/middleware/csrf.js — HMAC-derived per-session token (no
 *    storage), header/form double-submit against the httpOnly session
 *    cookie, crypto.timingSafeEqual enforcement (spied), fail-closed paths,
 *    /g/ + /auth/ scope, req.requireCsrf + createRequireCsrf wiring, 403/413
 *    generic bodies;
 *  - src/web/middleware/rateLimit.js — fixed-window buckets with fake clock
 *    (rollover), key isolation, unref'd sweep + dispose, auth per-IP+user
 *    and mutation per-user gates, 429 + Retry-After, X-Forwarded-For ONLY
 *    with WEB_TRUST_PROXY (first hop), body-size cap → generic 413;
 *  - mounted app smoke (real SQLite via loadDb, ephemeral port): the new
 *    mounts are invisible to the Phase 0a GET/405/404 surface and the
 *    generic 500 handler still answers without stack/secrets;
 *  - boot validation helpers (HTTPS warning, WEB_* rate config resolution).
 *
 * node --test only; offline; no new deps.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

const {
  CSRF_HEADER,
  CSRF_FORM_FIELD,
  deriveCsrfToken,
  tokenMatches,
  createCsrfMiddleware,
  createRequireCsrf,
} = require("../src/web/middleware/csrf");
const {
  createRateBucketStore,
  createAuthRateLimit,
  createMutationRateLimit,
  createBodyCapMiddleware,
} = require("../src/web/middleware/rateLimit");

// DB-free require chain (config → commandPermissions/config only).
const config = require("../src/web/config");

const SESSION_ID = "ab".repeat(32);
const SECRET = "unit-test-secret-not-real";

// ---------------------------------------------------------------------------
// Fakes + helpers
// ---------------------------------------------------------------------------

/** Run `fn` with env patches (undefined deletes), restoring after. */
function withEnv(patches, fn) {
  const saved = {};
  for (const key of Object.keys(patches)) {
    saved[key] = process.env[key];
    if (patches[key] === undefined) delete process.env[key];
    else process.env[key] = String(patches[key]);
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
 * Async-safe withEnv: env stays patched until the returned promise settles
 * (sync withEnv restores at the first await inside `fn` — wrong for tests
 * that await dispatches).
 */
async function withEnvAsync(patches, fn) {
  const saved = {};
  for (const key of Object.keys(patches)) {
    saved[key] = process.env[key];
    if (patches[key] === undefined) delete process.env[key];
    else process.env[key] = String(patches[key]);
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(patches)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** Minimal ServerResponse stand-in; end() settles the pending dispatch. */
function makeRes(onDone) {
  const res = {
    statusCode: 0,
    headers: {},
    body: "",
    headersSent: false,
    ended: false,
    writeHead(code, headers) {
      res.statusCode = code;
      Object.assign(res.headers, headers || {});
      res.headersSent = true;
      return res;
    },
    end(chunk) {
      res.ended = true;
      if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
        res.body = String(chunk);
      }
      if (onDone) onDone();
      return res;
    },
  };
  return res;
}

/**
 * Dispatch one middleware against a fake req/res. Resolves { passed: true }
 * when next() was called, or { status, body, headers } when the middleware
 * answered. Rejects on next(err) or a rejected async middleware — both are
 * bugs in this layer.
 */
function dispatch(mw, req) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const res = makeRes(() =>
      done({ status: res.statusCode, body: res.body, headers: res.headers })
    );
    let out;
    try {
      out = mw(req, res, (err) => (err ? reject(err) : done({ passed: true })));
    } catch (err) {
      reject(err);
      return;
    }
    if (out && typeof out.then === "function") out.then(undefined, reject);
  });
}

/** Chain middlewares left→right; first denial/answer wins. */
async function dispatchChain(mws, req) {
  for (const mw of mws) {
    const outcome = await dispatch(mw, req);
    if (!outcome.passed) return outcome;
  }
  return { passed: true };
}

/** Plain fake request (no stream) — unsafe methods here have no readable body. */
function makeReq({
  method = "GET",
  url = "/",
  headers = {},
  webSession = null,
  user = undefined,
  ip = "10.0.0.1",
} = {}) {
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: ip },
    webSession,
    // Mirrors the session middleware: a resolved session implies req.user.
    user:
      user !== undefined
        ? user
        : webSession
          ? { userId: webSession.userId, discordTag: webSession.discordTag }
          : null,
  };
}

/** Stream-backed fake (has a body to drain, framed like a real request). */
function makeStreamReq(opts, body, headers = {}) {
  const req = Readable.from([Buffer.from(body, "utf8")]);
  Object.assign(req, makeReq(opts), {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // Real servers always frame bodies (CL or TE); pass
      // `"content-length": undefined` to simulate chunked-only framing.
      "content-length": String(Buffer.byteLength(body, "utf8")),
      ...headers,
    },
  });
  return req;
}

function session(id = SESSION_ID) {
  return { id, userId: "150000000000000001", discordTag: "u#0001" };
}

/** Fake monotonic test clock. */
function makeClock(start = 0) {
  const state = { t: start };
  return {
    state,
    now: () => state.t,
    advance: (ms) => {
      state.t += ms;
    },
  };
}

/**
 * Spy on crypto.timingSafeEqual (module-namespace property — the middlewares
 * resolve it per call). Returns the number of comparisons made.
 */
function spyTimingSafeEqual(fn) {
  const original = crypto.timingSafeEqual;
  const state = { calls: 0 };
  crypto.timingSafeEqual = (a, b) => {
    state.calls += 1;
    return original(a, b);
  };
  try {
    const result = fn();
    return { result, calls: () => state.calls };
  } finally {
    crypto.timingSafeEqual = original;
  }
}

/** Ask the OS for an unused port, then release it (mirrors web-http-net). */
async function reserveEphemeralPort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  probe.close();
  await once(probe, "close");
  return port;
}

/** Raw http.request so path bytes (e.g. lone "%zz") reach the app verbatim. */
function rawRequest(port, { method = "GET", path: reqPath = "/" }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: reqPath },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 1. CSRF derivation + comparison (pure)
// ---------------------------------------------------------------------------

describe("csrf token derivation + timing-safe comparison", () => {
  it("is deterministic per (session, secret) and distinct across them", () => {
    const a = deriveCsrfToken(SESSION_ID, SECRET);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, deriveCsrfToken(SESSION_ID, SECRET));
    assert.notEqual(a, deriveCsrfToken("cd".repeat(32), SECRET), "other session → other token");
    assert.notEqual(a, deriveCsrfToken(SESSION_ID, "other-secret"), "other secret → other token");
  });

  it("returns null when session or secret is missing (callers fail closed)", () => {
    assert.equal(deriveCsrfToken(null, SECRET), null);
    assert.equal(deriveCsrfToken(SESSION_ID, null), null);
    assert.equal(deriveCsrfToken("", SECRET), null);
  });

  it("tokenMatches accepts only the exact token (trim + case-insensitive hex)", () => {
    const token = deriveCsrfToken(SESSION_ID, SECRET);
    assert.equal(tokenMatches(token, token), true);
    assert.equal(tokenMatches(token, token.toUpperCase()), true);
    assert.equal(tokenMatches(token, ` ${token}  `), true);
  });

  it("tokenMatches rejects tampered, malformed, and non-string tokens", () => {
    const token = deriveCsrfToken(SESSION_ID, SECRET);
    const flipped = `${token[0] === "0" ? "1" : "0"}${token.slice(1)}`;
    assert.equal(flipped.length, token.length, "sanity: same length");
    assert.equal(tokenMatches(token, flipped), false);
    assert.equal(tokenMatches(token, "deadbeef"), false); // wrong length
    assert.equal(tokenMatches(token, "z".repeat(64)), false); // not hex
    assert.equal(tokenMatches(token, ""), false);
    assert.equal(tokenMatches(token, undefined), false);
    assert.equal(tokenMatches(token, SESSION_ID), false);
  });
});

// ---------------------------------------------------------------------------
// 2. CSRF middleware
// ---------------------------------------------------------------------------

describe("csrf middleware (app-level, fake req/res)", () => {
  const mw = createCsrfMiddleware({ getSecret: () => SECRET });
  const token = deriveCsrfToken(SESSION_ID, SECRET);

  it("GET with a session attaches req.csrfToken (views/htmx embed it)", async () => {
    const req = makeReq({ url: "/g/42/settings", webSession: session() });
    const outcome = await dispatch(mw, req);
    assert.equal(outcome.passed, true);
    assert.equal(req.csrfToken, token);
    assert.equal(typeof req.requireCsrf, "function", "wiring helper attached");
  });

  it("anonymous GET derives no token and pays no secret lookup", async () => {
    const req = makeReq({ url: "/t/abc" });
    const outcome = await dispatch(mw, req);
    assert.equal(outcome.passed, true);
    assert.equal(req.csrfToken, null);
  });

  it("POST under /g/ with X-CSRF-Token header (htmx) passes and compares timing-safely", async () => {
    const req = makeReq({
      method: "POST",
      url: "/g/42/settings",
      webSession: session(),
      headers: { [CSRF_HEADER]: token },
    });
    const { result: outcome, calls } = spyTimingSafeEqual(() => dispatch(mw, req));
    assert.equal((await outcome).passed, true);
    assert.ok(calls() >= 1, "timingSafeEqual used for the token comparison");
  });

  it("POST /auth mutation (logout path) with header token passes", async () => {
    const req = makeReq({
      method: "POST",
      url: "/auth/logout",
      webSession: session(),
      headers: { [CSRF_HEADER]: token },
    });
    assert.equal((await dispatch(mw, req)).passed, true);
  });

  it("POST under /g/ without any token → generic 403, no comparison run", async () => {
    const req = makeReq({
      method: "POST",
      url: "/g/42/settings",
      webSession: session(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const { result: outcome, calls } = spyTimingSafeEqual(() => dispatch(mw, req));
    const res = await outcome;
    assert.equal(res.status, 403);
    assert.equal(res.body, "Forbidden");
    assert.ok(!res.body.includes(SECRET) && !res.body.includes(token));
    assert.equal(calls(), 0, "nothing to compare when the token is absent");
  });

  it("POST with a same-length tampered token → 403 via timingSafeEqual", async () => {
    const flipped = `${token[0] === "0" ? "1" : "0"}${token.slice(1)}`;
    const req = makeReq({
      method: "POST",
      url: "/g/42/settings",
      webSession: session(),
      headers: { [CSRF_HEADER]: flipped },
    });
    const { result: outcome, calls } = spyTimingSafeEqual(() => dispatch(mw, req));
    const res = await outcome;
    assert.equal(res.status, 403);
    assert.ok(calls() >= 1, "full-shape candidates reach timingSafeEqual, not ===");
  });

  it("POST with a malformed token (wrong length / non-hex) → 403 rejected pre-compare", async () => {
    for (const bad of ["deadbeef", "z".repeat(64), "a".repeat(63), "zzzz"]) {
      const req = makeReq({
        method: "POST",
        url: "/g/42/x",
        webSession: session(),
        headers: { [CSRF_HEADER]: bad },
      });
      const res = await dispatch(mw, req);
      assert.equal(res.status, 403, `expected 403 for ${JSON.stringify(bad)}`);
    }
  });

  it("POST with session-scoped token from ANOTHER session → 403 (session binding)", async () => {
    const other = deriveCsrfToken("cd".repeat(32), SECRET);
    const req = makeReq({
      method: "POST",
      url: "/g/42/x",
      webSession: session(),
      headers: { [CSRF_HEADER]: other },
    });
    assert.equal((await dispatch(mw, req)).status, 403);
  });

  it("POST under /g/ with valid _csrf form field (via body-cap) passes", async () => {
    const bodyCap = createBodyCapMiddleware({ maxBytes: 4096 });
    const req = makeStreamReq(
      { method: "POST", url: "/g/42/x", webSession: session() },
      `${CSRF_FORM_FIELD}=${token}&name=value`
    );
    const outcome = await dispatchChain([bodyCap, mw], req);
    assert.equal(outcome.passed, true);
    assert.equal(req.bodyFields[CSRF_FORM_FIELD], token);
  });

  it("CSRF standalone drains its own urlencoded body for the form token", async () => {
    const req = makeStreamReq(
      { method: "POST", url: "/auth/logout", webSession: session() },
      `${CSRF_FORM_FIELD}=${token}`
    );
    assert.equal((await dispatch(mw, req)).passed, true);
    assert.deepEqual(req.body, { [CSRF_FORM_FIELD]: token }, "req.body materialized for routes");
  });

  it("CSRF self-drain past the cap → generic 413 (standalone path)", async () => {
    const tiny = createCsrfMiddleware({
      getSecret: () => SECRET,
      maxBodyBytes: 16,
    });
    const req = makeStreamReq(
      { method: "POST", url: "/g/42/x", webSession: session() },
      `${CSRF_FORM_FIELD}=${token}padding-padding-padding`
    );
    const res = await dispatch(tiny, req);
    assert.equal(res.status, 413);
    assert.equal(res.body, "Payload too large");
  });

  it("POST with _csrf present but wrong → 403", async () => {
    const bodyCap = createBodyCapMiddleware({ maxBytes: 4096 });
    const req = makeStreamReq(
      { method: "POST", url: "/g/42/x", webSession: session() },
      `${CSRF_FORM_FIELD}=00${token.slice(2)}`
    );
    const outcome = await dispatchChain([bodyCap, mw], req);
    assert.equal(outcome.status, 403);
  });

  it("missing signing secret with a session → 403 fail closed (never fail open)", async () => {
    const noSecret = createCsrfMiddleware({ getSecret: () => null });
    const req = makeReq({
      method: "POST",
      url: "/g/42/x",
      webSession: session(),
      headers: { [CSRF_HEADER]: token }, // even a "right" token cannot be verified
    });
    assert.equal((await dispatch(noSecret, req)).status, 403);
  });

  it("anonymous POST under /auth/ passes untouched (route gates: rate limit + oauth state)", async () => {
    const req = makeReq({ method: "POST", url: "/auth/logout" });
    const outcome = await dispatch(mw, req);
    assert.equal(outcome.passed, true);
    assert.equal(req.csrfToken, null);
  });

  it("HEAD/OPTIONS are safe methods: never token-checked", async () => {
    for (const method of ["HEAD", "OPTIONS"]) {
      const req = makeReq({ method, url: "/g/42/x", webSession: session() });
      assert.equal((await dispatch(mw, req)).passed, true, `${method} must pass`);
    }
  });

  it("paths outside /g/ and /auth/ are NOT auto-enforced but get the wiring helper", async () => {
    const req = makeReq({
      method: "POST",
      url: "/elsewhere/mutate",
      webSession: session(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const outcome = await dispatch(mw, req);
    assert.equal(outcome.passed, true, "scope is /g/ + /auth/ (design §8.6/§8.7)");
    // …and the attached req.requireCsrf enforces when a route opts in:
    const guarded = await new Promise((resolve) => {
      const res = makeRes(() => resolve({ status: res.statusCode, body: res.body }));
      req.requireCsrf(req, res, () => resolve({ passed: true }));
    });
    assert.equal(guarded.status, 403, "opted-in route without token → 403");
  });

  it("createRequireCsrf standalone guard: enforces on token, passes anonymous", async () => {
    const guard = createRequireCsrf({ getSecret: () => SECRET });
    const ok = makeReq({
      method: "POST",
      url: "/somewhere",
      webSession: session(),
      headers: { [CSRF_HEADER]: token },
    });
    assert.equal((await dispatch(guard, ok)).passed, true);

    const missing = makeReq({ method: "POST", url: "/somewhere", webSession: session() });
    assert.equal((await dispatch(guard, missing)).status, 403);

    const anon = makeReq({ method: "POST", url: "/somewhere" });
    assert.equal((await dispatch(guard, anon)).passed, true);
  });

  it("default wiring resolves SESSION_SECRET from env live", async () => {
    const defaultMw = createCsrfMiddleware();
    const req = makeReq({ url: "/g/42/x", webSession: session() });
    await withEnvAsync({ SESSION_SECRET: SECRET, CLIENT_SECRET: undefined }, async () => {
      await dispatch(defaultMw, req);
      assert.equal(req.csrfToken, token, "env secret → same derivation");
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Rate-limit bucket store
// ---------------------------------------------------------------------------

describe("rate bucket store (fixed window, fake clock)", () => {
  it("allows max hits, denies beyond, reports Retry-After within the window", () => {
    const clock = makeClock(1000);
    const store = createRateBucketStore({
      name: "t",
      windowMs: 10_000,
      max: 3,
      now: clock.now,
      autoStartSweep: false,
    });
    for (let i = 0; i < 3; i += 1) {
      const outcome = store.hit("k");
      assert.equal(outcome.allowed, true);
      assert.equal(outcome.remaining, 2 - i);
    }
    clock.advance(4000);
    const denied = store.hit("k");
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterSec, 6, "ceil(6000ms/1000)");
  });

  it("rolls the window after a full window and starts counting fresh", () => {
    const clock = makeClock(0);
    const store = createRateBucketStore({
      windowMs: 1000,
      max: 1,
      now: clock.now,
      autoStartSweep: false,
    });
    assert.equal(store.hit("k").allowed, true);
    clock.advance(999);
    assert.equal(store.hit("k").allowed, false);
    clock.advance(1); // now - windowStart === windowMs
    assert.equal(store.hit("k").allowed, true, "window rolled");
  });

  it("isolates keys: separate windows, separate counters", () => {
    const clock = makeClock(0);
    const store = createRateBucketStore({
      windowMs: 1000,
      max: 1,
      now: clock.now,
      autoStartSweep: false,
    });
    assert.equal(store.hit("alice").allowed, true);
    assert.equal(store.hit("bob").allowed, true, "other key unaffected");
    assert.equal(store.hit("alice").allowed, false);
    assert.equal(store.hit("carol").allowed, true);
  });

  it("sweep drops fully elapsed windows only", () => {
    const clock = makeClock(0);
    const store = createRateBucketStore({
      windowMs: 1000,
      max: 5,
      now: clock.now,
      autoStartSweep: false,
    });
    store.hit("old");
    clock.advance(600);
    store.hit("fresh");
    clock.advance(600); // old: 1200 ≥ 1000 (gone); fresh: 600 < 1000 (kept)
    store.sweep();
    assert.equal(store.size, 1);
  });

  it("sweep timer is unref'd and dispose() clears it", () => {
    const store = createRateBucketStore({
      windowMs: 1000,
      max: 5,
      now: () => Date.now(),
      sweepIntervalMs: 60_000,
    });
    store.hit("k");
    assert.ok(store.timer, "sweep timer started on first hit");
    assert.equal(store.timer.hasRef(), false, "must never keep the bot alive");
    store.dispose();
    assert.equal(store.timer, null, "dispose stops the sweep");
    assert.equal(store.hit("k").allowed, true, "store still works after dispose");
  });
});

// ---------------------------------------------------------------------------
// 4. Rate-limit middleware (auth + mutation gates)
// ---------------------------------------------------------------------------

describe("rate limit middleware (fake req/res, fake clock)", () => {
  const cleanEnv = {
    WEB_TRUST_PROXY: undefined,
    WEB_RATE_LIMIT_WINDOW_MS: undefined,
    WEB_RATE_LIMIT_AUTH_MAX: undefined,
    WEB_RATE_LIMIT_AUTH_USER_MAX: undefined,
    WEB_RATE_LIMIT_MUTATION_MAX: undefined,
    WEB_MAX_BODY_BYTES: undefined,
  };

  it("auth: per-IP bucket trips → 429 with integer Retry-After; other IPs unaffected; window recovers", async () => {
    await withEnvAsync(cleanEnv, async () => {
      const clock = makeClock(0);
      const auth = createAuthRateLimit({
        now: clock.now,
        windowMs: 10_000,
        ipMax: 2,
        userMax: 1000,
      });
      assert.equal((await dispatch(auth, makeReq({ url: "/auth/login", ip: "5.5.5.1" }))).passed, true);
      assert.equal((await dispatch(auth, makeReq({ url: "/auth/login", ip: "5.5.5.1" }))).passed, true);
      const denied = await dispatch(auth, makeReq({ url: "/auth/login", ip: "5.5.5.1" }));
      assert.equal(denied.status, 429);
      assert.equal(denied.body, "Too many requests");
      const retry = Number(denied.headers["Retry-After"]);
      assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 10, `Retry-After=${retry}`);

      const other = await dispatch(auth, makeReq({ url: "/auth/login", ip: "5.5.5.2" }));
      assert.equal(other.passed, true, "different IP has its own bucket");

      clock.advance(10_000);
      assert.equal(
        (await dispatch(auth, makeReq({ url: "/auth/login", ip: "5.5.5.1" }))).passed,
        true,
        "window rolled → recovered"
      );
    });
  });

  it("auth: per-user bucket isolates users behind one IP (rateLimitUserHint honored)", async () => {
    await withEnvAsync(cleanEnv, async () => {
      const clock = makeClock(0);
      const auth = createAuthRateLimit({
        now: clock.now,
        windowMs: 1000,
        ipMax: 1000,
        userMax: 1,
      });
      const mk = (hint) => {
        const req = makeReq({ url: "/auth/login/callback", ip: "9.9.9.9" });
        req.rateLimitUserHint = hint;
        return req;
      };
      assert.equal((await dispatch(auth, mk("user-a"))).passed, true);
      assert.equal((await dispatch(auth, mk("user-b"))).passed, true, "user B isolated from A");
      assert.equal((await dispatch(auth, mk("user-a"))).status, 429, "user A exhausted");
      assert.equal(
        (await dispatch(auth, makeReq({ url: "/auth/login", ip: "9.9.9.9" }))).passed,
        true,
        "no user identity → user gate skipped, IP gate (max 1000) allows"
      );
    });
  });

  it("auth: live session user counts the user gate too", async () => {
    await withEnvAsync(cleanEnv, async () => {
      const clock = makeClock(0);
      const auth = createAuthRateLimit({ now: clock.now, windowMs: 1000, ipMax: 1000, userMax: 1 });
      const req = makeReq({ url: "/auth/logout", webSession: session() });
      assert.equal((await dispatch(auth, req)).passed, true);
      assert.equal((await dispatch(auth, req)).status, 429);
    });
  });

  it("mutation: GET/HEAD never counted; bucket per user; anonymous falls back to IP", async () => {
    await withEnvAsync(cleanEnv, async () => {
      const clock = makeClock(0);
      const mutations = createMutationRateLimit({
        now: clock.now,
        windowMs: 1000,
        max: 1,
      });
      const sess = session();
      for (const method of ["GET", "HEAD"]) {
        for (let i = 0; i < 4; i += 1) {
          const req = makeReq({ method, url: "/g/42/x", webSession: sess });
          assert.equal((await dispatch(mutations, req)).passed, true, `${method} must not consume the bucket`);
        }
      }
      const userA = () => makeReq({ method: "POST", url: "/g/42/x", webSession: sess });
      assert.equal((await dispatch(mutations, userA())).passed, true);
      assert.equal((await dispatch(mutations, userA())).status, 429, "user bucket exhausted");

      const userB = makeReq({
        method: "POST",
        url: "/g/42/x",
        webSession: session("cd".repeat(32)),
        user: { userId: "150000000000000002", discordTag: null },
      });
      assert.equal((await dispatch(mutations, userB)).passed, true, "other user unaffected");

      const anon1 = makeReq({ method: "POST", url: "/auth/logout", ip: "7.7.7.7" });
      const anon2 = makeReq({ method: "POST", url: "/auth/logout", ip: "7.7.7.7" });
      assert.equal((await dispatch(mutations, anon1)).passed, true, "anonymous → IP fallback key");
      assert.equal((await dispatch(mutations, anon2)).status, 429);

      clock.advance(1000);
      assert.equal((await dispatch(mutations, userA())).passed, true, "recovered after window");
    });
  });

  it("X-Forwarded-For is IGNORED by default (socket IP buckets forged traffic together)", async () => {
    await withEnvAsync({ ...cleanEnv, WEB_TRUST_PROXY: undefined }, async () => {
      const clock = makeClock(0);
      const mutations = createMutationRateLimit({ now: clock.now, windowMs: 1000, max: 1 });
      const a = makeReq({ method: "POST", url: "/g/1/x", ip: "10.0.0.9", headers: { "x-forwarded-for": "1.1.1.1" } });
      const b = makeReq({ method: "POST", url: "/g/1/x", ip: "10.0.0.9", headers: { "x-forwarded-for": "2.2.2.2" } });
      assert.equal((await dispatch(mutations, a)).passed, true);
      assert.equal(
        (await dispatch(mutations, b)).status,
        429,
        "distinct XFF values share the socket-IP bucket while WEB_TRUST_PROXY is off"
      );
    });
  });

  it("WEB_TRUST_PROXY=1: first XFF hop (trimmed) keys the bucket; later hops ignored", async () => {
    await withEnvAsync({ ...cleanEnv, WEB_TRUST_PROXY: "1" }, async () => {
      const clock = makeClock(0);
      const mkGate = () => createMutationRateLimit({ now: clock.now, windowMs: 1000, max: 1 });

      const gate = mkGate();
      const first = makeReq({ method: "POST", url: "/g/1/x", ip: "10.0.0.9", headers: { "x-forwarded-for": "1.1.1.1, 9.9.9.9" } });
      const second = makeReq({ method: "POST", url: "/g/1/x", ip: "10.0.0.9", headers: { "x-forwarded-for": "2.2.2.2, 8.8.8.8" } });
      assert.equal((await dispatch(gate, first)).passed, true);
      assert.equal((await dispatch(gate, second)).passed, true, "separate first hops → separate buckets");

      const again = makeReq({ method: "POST", url: "/g/1/x", ip: "10.0.0.9", headers: { "x-forwarded-for": "1.1.1.1 , 7.7.7.7" } });
      assert.equal((await dispatch(gate, again)).status, 429, "same first hop (trimmed) → same bucket");

      const noXff = makeReq({ method: "POST", url: "/g/1/x", ip: "7.7.7.1" });
      const noXff2 = makeReq({ method: "POST", url: "/g/1/x", ip: "7.7.7.1" });
      assert.equal((await dispatch(gate, noXff)).passed, true, "missing XFF → socket address fallback");
      assert.equal((await dispatch(gate, noXff2)).status, 429);
    });
  });

  it("429 bodies/headers never leak the raw IP or user id", async () => {
    await withEnvAsync(cleanEnv, async () => {
      const clock = makeClock(0);
      const mutations = createMutationRateLimit({ now: clock.now, windowMs: 1000, max: 1 });
      const mk = () => makeReq({
        method: "POST",
        url: "/g/42/x",
        ip: "203.0.113.77",
        user: { userId: "159999999999999999", discordTag: null },
      });
      await dispatch(mutations, mk());
      const denied = await dispatch(mutations, mk());
      assert.equal(denied.status, 429);
      assert.ok(!denied.body.includes("203.0.113.77"));
      assert.ok(!denied.body.includes("159999999999999999"));
      const allHeaders = Object.values(denied.headers).join(" ");
      assert.ok(!allHeaders.includes("203.0.113.77"));
      assert.ok(!allHeaders.includes("159999999999999999"));
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Body-size cap
// ---------------------------------------------------------------------------

describe("body cap middleware (fake req/res)", () => {
  it("GET/HEAD pass untouched without touching the stream", async () => {
    const cap = createBodyCapMiddleware({ maxBytes: 64 });
    const req = makeReq({ method: "GET", url: "/t/x", headers: { "content-length": "999999" } });
    const outcome = await dispatch(cap, req);
    assert.equal(outcome.passed, true);
    assert.equal(req.rawBody, undefined, "GET surface untouched (byte parity)");
  });

  it("small urlencoded body → rawBody + bodyFields + req.body exposed", async () => {
    const cap = createBodyCapMiddleware({ maxBytes: 4096 });
    const req = makeStreamReq(
      { method: "POST", url: "/g/42/x" },
      "name=value&other=2",
      { "content-length": "21" }
    );
    const outcome = await dispatch(cap, req);
    assert.equal(outcome.passed, true);
    assert.ok(Buffer.isBuffer(req.rawBody));
    assert.deepEqual(req.bodyFields, { name: "value", other: "2" });
    assert.deepEqual(req.body, { name: "value", other: "2" });
  });

  it("declared content-length past the cap → generic 413 without reading", async () => {
    const cap = createBodyCapMiddleware({ maxBytes: 10 });
    const req = makeReq({
      method: "POST",
      url: "/g/42/x",
      headers: { "content-length": "11", "content-type": "application/x-www-form-urlencoded" },
    });
    const outcome = await dispatch(cap, req);
    assert.equal(outcome.status, 413);
    assert.equal(outcome.body, "Payload too large");
  });

  it("chunked body past the cap → generic 413 + stream destroyed", async () => {
    const cap = createBodyCapMiddleware({ maxBytes: 5 });
    const req = makeStreamReq(
      { method: "POST", url: "/g/42/x" },
      "x".repeat(50),
      { "transfer-encoding": "chunked", "content-length": undefined }
    );
    const outcome = await dispatch(cap, req);
    assert.equal(outcome.status, 413);
    assert.equal(req.destroyed, true, "overflowing stream must be destroyed, not buffered");
  });

  it("unsafe method with no body → passes with empty rawBody (no stall)", async () => {
    const cap = createBodyCapMiddleware({ maxBytes: 100 });
    const req = makeReq({ method: "POST", url: "/auth/logout", headers: {} });
    const outcome = await dispatch(cap, req);
    assert.equal(outcome.passed, true);
    assert.equal(req.rawBody.length, 0);
  });

  it("non-form content types get rawBody but empty bodyFields", async () => {
    const cap = createBodyCapMiddleware({ maxBytes: 100 });
    const req = makeStreamReq(
      { method: "POST", url: "/g/42/x" },
      '{"a":1}',
      { "content-type": "application/json", "content-length": "7" }
    );
    const outcome = await dispatch(cap, req);
    assert.equal(outcome.passed, true);
    assert.equal(req.rawBody.toString("utf8"), '{"a":1}');
    assert.deepEqual(req.bodyFields, {});
  });
});

// ---------------------------------------------------------------------------
// 6. Mounted app — mount transparency + generic 500 + boot validation
// ---------------------------------------------------------------------------

describe("mounted web app (security middlewares vs the 0a surface)", () => {
  let tmpDir;
  let savedEnv;
  /** @type {import("http").Server} */
  let server;
  /** @type {number} */
  let port;

  const ENV_KEYS = [
    "PUBLIC_HTTP_PORT",
    "PUBLIC_BASE_URL",
    "TICKET_HTTP_PORT",
    "TICKET_PUBLIC_BASE_URL",
    "SESSION_SECRET",
    "CLIENT_SECRET",
    "WEB_TRUST_PROXY",
  ];

  before(async () => {
    savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
    const loaded = loadDb(); // fresh tmp SQLite + src module-cache reset
    tmpDir = loaded.tmpDir;

    // Require AFTER loadDb so server + app + db facade bind the fresh tmp
    // SQLite (server.js requires ./app at module top — one fresh chain).
    const { startWebServer } = require("../src/web/server");
    // startWebServer owns the singleton; give it a reserved port via env.
    process.env.PUBLIC_HTTP_PORT = String(await reserveEphemeralPort());
    server = startWebServer();
    assert.ok(server, "server must start once PUBLIC_HTTP_PORT is set");
    await once(server, "listening");
    port = server.address().port;
  });

  after(async () => {
    const { stopWebServer } = require("../src/web/server");
    await stopWebServer();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("GET /health still answers byte-identically ('ok')", async () => {
    const res = await rawRequest(port, { path: "/health" });
    assert.equal(res.status, 200);
    assert.equal(res.body, "ok");
  });

  it("POST anywhere but /auth/logout still 405 at the methodGate (untouched contract)", async () => {
    const res = await rawRequest(port, { method: "POST", path: "/health" });
    assert.equal(res.status, 405);
    assert.equal(res.body, "Method not allowed");
  });

  it("GET unknown paths still 404 'Not found' (mounts are transparent)", async () => {
    // /g/* deliberately not asserted here: the Phase 0b login gate owns
    // /g/:guildId (subtask 06) and its behavior is its test's contract.
    for (const p of ["/nope", "/auth/whatever"]) {
      const res = await rawRequest(port, { path: p });
      assert.equal(res.status, 404, `${p} → 404`);
      assert.equal(res.body, "Not found", `${p} body`);
    }
  });

  it("handler crash → generic 500 without stack, secrets, or cause (§8.7)", async () => {
    // /t/%zz: the transcripts route decodeURIComponents the raw token and
    // throws URIError — Express 5 funnels it into the terminal error handler.
    const res = await rawRequest(port, { path: "/t/%zz" });
    assert.equal(res.status, 500);
    assert.equal(res.body, "Internal error");
    assert.ok(!res.body.includes("at "));
    assert.ok(!res.body.toLowerCase().includes("stack"));
    assert.ok(!res.body.includes("%zz"));
  });

  it("boot with an insecure public base URL logs the HTTPS warning (wired in server.js)", async () => {
    const { stopWebServer } = require("../src/web/server");
    await stopWebServer(); // force a cold boot for the checks
    const seen = [];
    const originalWarn = console.warn;
    process.env.PUBLIC_BASE_URL = "http://panel.example.com";
    process.env.SESSION_SECRET = SECRET;
    console.warn = (...args) => seen.push(args.map(String).join(" "));
    try {
      process.env.PUBLIC_HTTP_PORT = String(await reserveEphemeralPort());
      const started = require("../src/web/server").startWebServer();
      await once(started, "listening");
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(
      seen.some((w) => w.includes("plain HTTP") && w.includes("Secure")),
      `expected HTTPS/Secure boot warning, saw: ${JSON.stringify(seen)}`
    );
    assert.ok(
      !seen.some((w) => w.includes(SECRET)),
      "warnings never contain the secret value"
    );
    await require("../src/web/server").stopWebServer();
  });

  it("boot without any session secret logs the fail-closed SESSION_SECRET warning", async () => {
    const { stopWebServer } = require("../src/web/server");
    await stopWebServer();
    const seen = [];
    const originalWarn = console.warn;
    delete process.env.SESSION_SECRET;
    delete process.env.CLIENT_SECRET;
    process.env.PUBLIC_BASE_URL = "https://panel.example.com";
    console.warn = (...args) => seen.push(args.map(String).join(" "));
    try {
      process.env.PUBLIC_HTTP_PORT = String(await reserveEphemeralPort());
      const started = require("../src/web/server").startWebServer();
      await once(started, "listening");
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(
      seen.some((w) => w.includes("SESSION_SECRET") && w.includes("fail closed")),
      `expected SESSION_SECRET boot warning, saw: ${JSON.stringify(seen)}`
    );
    await require("../src/web/server").stopWebServer();
  });

  it("boot with PUBLIC_HTTP_PORT unset stays dark (returns null, no listener)", async () => {
    const { stopWebServer, startWebServer } = require("../src/web/server");
    await stopWebServer();
    delete process.env.PUBLIC_HTTP_PORT;
    delete process.env.TICKET_HTTP_PORT;
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => logged.push(args.map(String).join(" "));
    try {
      assert.equal(startWebServer(), null, "dark by default (§8.8)");
    } finally {
      console.log = originalLog;
    }
    assert.ok(logged.some((l) => l.includes("disabled")));
  });
});

// ---------------------------------------------------------------------------
// 7. Config resolution (rate env, proxy trust)
// ---------------------------------------------------------------------------

describe("web rate/proxy config resolution", () => {
  it("defaults are sane and documented (§8.7)", () => {
    withEnv(
      {
        WEB_RATE_LIMIT_WINDOW_MS: undefined,
        WEB_RATE_LIMIT_AUTH_MAX: undefined,
        WEB_RATE_LIMIT_AUTH_USER_MAX: undefined,
        WEB_RATE_LIMIT_MUTATION_MAX: undefined,
        WEB_MAX_BODY_BYTES: undefined,
      },
      () => {
        assert.deepEqual(config.getRateLimitConfig(), {
          windowMs: 60_000,
          authMax: 30,
          authUserMax: 10,
          mutationMax: 120,
          maxBodyBytes: 65_536,
        });
      }
    );
  });

  it("env overrides win; invalid values fall back per key", () => {
    withEnv(
      {
        WEB_RATE_LIMIT_WINDOW_MS: "5000",
        WEB_RATE_LIMIT_AUTH_MAX: "7",
        WEB_RATE_LIMIT_AUTH_USER_MAX: "nonsense",
        WEB_RATE_LIMIT_MUTATION_MAX: "-4",
        WEB_MAX_BODY_BYTES: "1024",
      },
      () => {
        const cfg = config.getRateLimitConfig();
        assert.equal(cfg.windowMs, 5000);
        assert.equal(cfg.authMax, 7);
        assert.equal(cfg.authUserMax, 10, "invalid → default");
        assert.equal(cfg.mutationMax, 120, "invalid → default");
        assert.equal(cfg.maxBodyBytes, 1024);
      }
    );
  });

  it("WEB_TRUST_PROXY parses strictly (default off)", () => {
    for (const [raw, expected] of [
      [undefined, false],
      ["", false],
      ["0", false],
      ["garbage", false],
      ["1", true],
      ["true", true],
      ["YES", true],
      ["on", true],
    ]) {
      withEnv({ WEB_TRUST_PROXY: raw }, () => {
        assert.equal(config.isTrustProxyEnabled(), expected, `WEB_TRUST_PROXY=${raw}`);
      });
    }
  });

  it("boot warning matrix: http non-localhost warns; loopback + https stay quiet (§8.10)", () => {
    const run = (baseUrl) => {
      const seen = [];
      const originalWarn = console.warn;
      console.warn = (...args) => seen.push(args.map(String).join(" "));
      try {
        return withEnv(
          { PUBLIC_BASE_URL: baseUrl, TICKET_PUBLIC_BASE_URL: undefined },
          () => ({ warned: config.warnIfInsecurePublicBaseUrl(), seen })
        );
      } finally {
        console.warn = originalWarn;
      }
    };

    const insecure = run("http://bot.example.com");
    assert.equal(insecure.warned, true);
    assert.ok(insecure.seen.some((w) => w.includes("Secure")));

    for (const ok of ["https://bot.example.com", "http://localhost:8080", "http://127.0.0.1:8080"]) {
      const quiet = run(ok);
      assert.equal(quiet.warned, false, `${ok} must not warn`);
    }
  });
});
