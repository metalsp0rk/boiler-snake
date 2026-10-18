/**
 * /oauth/* per-IP limiter (#406, audit C1-12): the cmd_perms and gcal
 * callbacks are login-free OAuth shapes exactly like /auth/*, but they were
 * mounted OUTSIDE createAuthRateLimit — §8.7's "OAuth surfaces get per-IP
 * limits" held for two of the four flows. The signed single-use state is
 * authentication, NOT a brake: junk-state sprays hit the HMAC + nonce-map
 * path unthrottled. This pins the brake exists AND is scoped — its buckets
 * are OWN instances, so hammering /oauth can never 429 a victim's /auth.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");

const { loadDb } = require("./helpers/env");

const appMod = require("../src/web/app");

const AUTH_MAX = 3;

let loaded;
let server;
let base;
let prevAuthMax;

async function mountApp() {
  const app = appMod.createWebApp({
    guildAccess: { resolve: async () => ({ status: "anon" }), listGuilds: async () => [] },
    botGuilds: async () => [],
  });
  server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
}

async function get(path) {
  return fetch(`${base}${path}`);
}

test.before(async () => {
  loaded = loadDb();
  prevAuthMax = process.env.WEB_RATE_LIMIT_AUTH_MAX;
  process.env.WEB_RATE_LIMIT_AUTH_MAX = String(AUTH_MAX);
  await mountApp();
});

test.after(async () => {
  if (prevAuthMax === undefined) delete process.env.WEB_RATE_LIMIT_AUTH_MAX;
  else process.env.WEB_RATE_LIMIT_AUTH_MAX = prevAuthMax;
  if (server) {
    server.close();
    await once(server, "close");
  }
  loaded?.cleanup?.();
});

test("the /oauth callbacks run under the auth limiter — spray then 429 (#406)", async () => {
  // Junk state/code: the handlers answer 400-ish on their own — the point
  // is the LIMITER, which must speak FIRST once the IP budget is gone.
  const first = [];
  for (let i = 0; i < AUTH_MAX; i++) {
    const res = await get("/oauth/gcal/callback?state=junk&code=junk");
    first.push(res.status);
  }
  assert.ok(
    first.every((s) => s !== 429),
    `the first ${AUTH_MAX} hits pass the limiter (statuses ${first.join(",")})`,
  );

  const limited = await get("/oauth/gcal/callback?state=junk&code=junk");
  assert.equal(limited.status, 429, "the (N+1)th hit is throttled — the spray has a brake now");
  assert.ok(limited.headers.get("retry-after"), "Retry-After rides (§8.7 plain-text 429 shape)");

  // The other /oauth flow shares the SAME mount identity (prefix limiter),
  // so it is throttled while the window is hot:
  const cmd = await get("/oauth/command-permissions/callback?state=junk&code=junk");
  assert.equal(cmd.status, 429, "cmd_perms rides the same brake — one OAuth surface, one budget");
});

test("/oauth exhaustion never throttles the /auth surface (separate buckets, #406)", async () => {
  // The limiter instance is per-mount: a sprayed /oauth must NOT become a
  // cross-surface DoS lever against real logins.
  const login = await get("/auth/login");
  assert.notEqual(
    login.status,
    429,
    "while /oauth is exhausted, /auth/login still answers (its own bucket is untouched)",
  );
});
