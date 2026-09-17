/**
 * §8.15 task 15.13 — participant login round-trip + "your tickets" list.
 *
 * THE bug this pins: a non-staff user opening their ticket URL bounced to
 * login and landed on the STAFF HOME ("/") with no way back. Fix: ticket
 * gates carry a whitelisted ?next=, the OAuth state SIGNS it (HMAC — same
 * machinery as the guild return target), and the callback honors it. The
 * participant /t index now lists exactly the tickets their transcript URL
 * would open (creator/handler/member linkage), never staff-scoped rows.
 *
 * Harness = web-auth-login.test.js (mock Discord OAuth over HTTP, real
 * SQLite) + a scripted guildAccess resolver for the access decisions.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

const SESSION_SECRET = "test-rt13-verylongtestsecret";
const CLIENT_ID = "123456789012345679";
const CLIENT_SECRET = "test-client-secret-rt13-abc";
const FAKE_AT = "AT-PLAINTEXT-rt13-ZmFrZQ";

const MOCK_USER = "428190198765432100"; // whoever logs in through the mock
const GUILD_A = "760000000000000001";
const STAFF_ROLE = "rt13-role-staff";
const OTHER_CREATOR = "760000000000000099";

const ENV_KEYS = [
  "SESSION_SECRET", "CLIENT_ID", "CLIENT_SECRET", "OAUTH_STATE_SECRET",
  "OAUTH_REDIRECT_URI", "WEB_LOGIN_REDIRECT_URI", "WEB_LOGIN_PROMPT",
  "PUBLIC_HTTP_PORT", "PUBLIC_BASE_URL", "TICKET_HTTP_PORT",
  "TICKET_PUBLIC_BASE_URL", "DB_PATH", "DATA_DIR",
  "WEB_RATE_LIMIT_AUTH_MAX", "WEB_RATE_LIMIT_AUTH_USER_MAX",
  "WEB_RATE_LIMIT_MUTATION_MAX",
];

function decodeState(state) {
  const body = state.split(".")[0];
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}

describe("participant ticket round-trip + own-tickets list (§8.15-15.13)", () => {
  let api, tmpDir, savedEnv;
  /** @type {http.Server} */ let mockServer;
  let mockBase;
  /** @type {http.Server} */ let appServer;
  let appBase;
  let appMod, sessions, tokens;
  let tokenFor, ticketToken, otherToken, markerReason;

  before(async () => {
    savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
    const loaded = loadDb();
    api = loaded.api;
    tmpDir = loaded.tmpDir;

    // ---- mock Discord OAuth/API --------------------------------------------
    tokenFor = (at) => `rt13tok-${at}`;
    mockServer = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://mock");
      if (req.method === "POST" && url.pathname.endsWith("/oauth2/token")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: FAKE_AT, token_type: "Bearer", expires_in: 604800 }));
        return;
      }
      if (url.pathname.endsWith("/users/@me")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: MOCK_USER, username: "participiant", global_name: "Pia Ticipant", avatar: null }));
        return;
      }
      if (url.pathname.endsWith("/users/@me/guilds")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([
          { id: GUILD_A, name: "Alpha HQ", icon: null, owner: false, permissions: "0" },
        ]));
        return;
      }
      const memberMatch = url.pathname.match(/\/users\/@me\/guilds\/[^/]+\/member$/);
      if (memberMatch) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ roles: [] })); // NO console role, ever
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("mock: unexpected");
    });
    mockServer.listen(0, "127.0.0.1");
    await once(mockServer, "listening");
    mockBase = `http://127.0.0.1:${mockServer.address().port}`;

    process.env.SESSION_SECRET = SESSION_SECRET;
    process.env.CLIENT_ID = CLIENT_ID;
    process.env.CLIENT_SECRET = CLIENT_SECRET;
    for (const k of ["OAUTH_STATE_SECRET", "OAUTH_REDIRECT_URI", "WEB_LOGIN_REDIRECT_URI",
      "WEB_LOGIN_PROMPT", "PUBLIC_HTTP_PORT", "TICKET_HTTP_PORT", "TICKET_PUBLIC_BASE_URL"]) {
      delete process.env[k];
    }
    process.env.WEB_RATE_LIMIT_AUTH_MAX = "100000";
    process.env.WEB_RATE_LIMIT_AUTH_USER_MAX = "100000";
    process.env.WEB_RATE_LIMIT_MUTATION_MAX = "100000";

    appMod = require("../src/web/app");
    sessions = require("../src/web/auth/sessions");
    tokens = require("../src/web/auth/tokens");

    // seeded archive: MY ticket + someone else's
    markerReason = "my lost hydrogen";
    const mine = seedArchived({ creator: MOCK_USER, reason: markerReason });
    ticketToken = mine;
    otherToken = seedArchived({ creator: OTHER_CREATOR, reason: "someone elses business" });

    const { createGuildAccessResolver } = require("../src/web/auth/guildAccess");
    const resolver = createGuildAccessResolver({
      discord: {
        async getUserGuilds() {
          return [{ id: GUILD_A, name: "Alpha HQ", icon: null, owner: false, permissions: "0" }];
        },
        async getUserGuildMember() {
          return { roles: [] }; // no staff roles → participant-only viewer
        },
      },
      botGuilds: async () => [GUILD_A],
      now: Date.now,
      ttlMs: 60_000,
    });

    const app = appMod.createWebApp({
      guildAccess: resolver,
      apiBase: `${mockBase}/api/v10`,
      oauthBase: mockBase,
      botGuilds: () => [GUILD_A],
      getClient: () => null,
    });
    appServer = http.createServer(app);
    appServer.listen(0, "127.0.0.1");
    await once(appServer, "listening");
    appBase = `http://127.0.0.1:${appServer.address().port}`;
    process.env.PUBLIC_BASE_URL = appBase;
  });

  after(() => {
    appServer?.closeAllConnections?.();
    appServer?.close();
    mockServer?.close();
    sessions?.stopSessionPruneJob?.();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  function seedArchived({ creator, reason }) {
    const token = api.generateTranscriptToken();
    const t = api.createTicket({ guildId: GUILD_A, creatorUserId: creator, channelId: `ch-${token}`, reason });
    api.markTicketClosed(t.id, { closedBy: MOCK_USER, closeReason: "done" });
    api.closeTicketArchived(t.id, {
      closedBy: MOCK_USER,
      closeReason: "done",
      transcriptToken: token,
      transcriptPath: `tickets/${token}/index.html`,
    });
    return token;
  }

  async function get(pathName, cookie) {
    const res = await fetch(`${appBase}${pathName}`, {
      redirect: "manual",
      headers: cookie ? { cookie } : undefined,
    });
    return { res, body: await res.text() };
  }

  /** Full login flow → { cookie, location } from the callback. */
  async function login(next) {
    const q = next ? `?next=${encodeURIComponent(next)}` : "";
    const start = await fetch(`${appBase}/auth/login${q}`, { redirect: "manual" });
    const authorize = new URL(start.headers.get("location"));
    const state = authorize.searchParams.get("state");
    const cb = await fetch(
      `${appBase}/auth/login/callback?code=fake&state=${encodeURIComponent(state)}`,
      { redirect: "manual" }
    );
    const setCookie = cb.headers.get("set-cookie") || "";
    const m = setCookie.match(/web_session=([^;]+)/);
    return {
      state,
      location: cb.headers.get("location"),
      cookie: m ? `web_session=${m[1]}` : "",
    };
  }

  // --------------------------------------------------------------------------

  it("ticket login gate hands out a whitelisted ?next", async () => {
    const { res } = await get(`/t/${ticketToken}`);
    assert.equal(res.status, 302);
    assert.equal(
      res.headers.get("location"),
      `/auth/login?next=${encodeURIComponent(`/t/${ticketToken}`)}`
    );
  });

  it("the next target survives signing and lands the participant ON the ticket", async () => {
    const { state, location, cookie } = await login(`/t/${ticketToken}`);
    assert.ok(cookie, "session cookie issued");
    // signed payload carries the return path
    assert.equal(decodeState(state).nx, `/t/${ticketToken}`);
    // callback returns to the ticket, acknowledging the sign-in once
    assert.equal(location, `/t/${ticketToken}?logged-in=1`);

    const { res, body } = await get(`/t/${ticketToken}?logged-in=1`, cookie);
    assert.equal(res.status, 200, "participant opens their transcript directly");
    assert.ok(body.includes(markerReason), "the record renders");
    assert.ok(!body.includes('<aside class="shell-nav"'), "still chrome-free");
    assert.ok(body.includes("Signed in with Discord"), "landing banner shown");
  });

  it("the participant /t list shows exactly their own archived tickets", async () => {
    const { cookie } = await login(`/t/${ticketToken}`);
    const { res, body } = await get("/t", cookie);
    assert.equal(res.status, 200);
    assert.match(body, /Your tickets/);
    assert.ok(body.includes(markerReason), "own ticket listed");
    assert.ok(!body.includes("someone elses business"), "foreign tickets NEVER listed");
    assert.ok(!body.includes(otherToken), "no foreign token echoes");
    // and the listed row links the transcript the viewer CAN open
    assert.ok(body.includes(`/t/${ticketToken}`), "row links their transcript");
  });

  it("non-whitelisted next values are dropped — never an open redirect", async () => {
    for (const bad of ["/g/123", "//evil.example/x", "https://evil.example", "/t/../x", "/t/zz"]) {
      const { location } = await login(bad);
      assert.equal(location, "/", `next=${bad} must fall back to home`);
    }
  });

  it("forged nx inside the state is re-checked and dropped", async () => {
    const oauthState = require("../src/features/commandPermissions/oauthState");
    // sign a state that WOULD have carried nx=/g/999 — minted through the
    // same secret; the callback's whitelist re-check is the last line.
    const forged = oauthState.createOAuthState({
      purpose: "web_login",
      next: "/g/999",
    });
    const res = await fetch(
      `${appBase}/auth/login/callback?code=fake&state=${encodeURIComponent(forged)}`,
      { redirect: "manual" }
    );
    assert.equal(res.headers.get("location"), "/", "non-ticket nx never honored");
  });

  it("no next ⇒ login lands on home (staff switcher flow unchanged)", async () => {
    const { location } = await login(null);
    assert.equal(location, "/");
  });
});
