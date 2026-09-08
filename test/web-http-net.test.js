/**
 * HTTP-level test net for the public ticket/OAuth surface (Phase 0a gate,
 * updated for the Phase 0c login gate — subtask 12).
 *
 * Replaces the old handleRequest(mockReq, mockRes) seam: the real
 * node:http server is started on an OS-assigned ephemeral port via
 * startTicketHttpServer() and driven exclusively with fetch().
 *
 * Per roadmap/web-admin.md §8.8 (Phase 0a first task) + §8.11:
 * this net must be GREEN against the pre-extraction server and must stay
 * green after the Express 5 extraction (subtask 04 may not start until it is).
 * Real SQLite + offline mocks only; node --test only.
 *
 * §8.4 (subtask 12) INTENTIONALLY changed the auth behavior of the ticket
 * surface — login is now mandatory (locked decision §8.1-3, no flag). This
 * net therefore runs TWO servers against the SAME SQLite + DATA_DIR:
 *  - the REAL production server (startTicketHttpServer): keeps every public
 *    byte assertion (/health, method gate, OAuth callback, catch-all 404)
 *    and now asserts the ANONYMOUS ticket-surface redirect semantics (§8.4);
 *  - an authenticated mirror (createWebApp({guildAccess: fake}) + a staff
 *    session cookie): keeps the FULL Phase 0a byte-identity assertions
 *    (index/asset headers, 404 bodies, %2F gate, aliases, pagination) for a
 *    staff viewer — no non-auth assertion was weakened, only the login
 *    posture of the request moved.
 * The mirror injects a fake guildAccess resolver (documented seam) because
 * the fixture guild ids are not snowflakes; the real resolver's matrix lives
 * in test/web-ticket-gating.test.js.
 *
 * ONE more §8.1-3-authorized change: the INDEX page now renders inside the
 * Phase 0c shell (subtask 12), whose doctrine is `Cache-Control: no-store` —
 * the body embeds the per-response CSP nonce and the session CSRF token, so
 * caching it would ship stale security material (the old `private,
 * max-age=60` is retired with the "not login-gated (MVP)" warning it
 * belonged to). Transcript + asset cache headers are UNTOUCHED.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

const HTTP_ENV_KEYS = [
  "PUBLIC_HTTP_PORT",
  "PUBLIC_BASE_URL",
  "TICKET_HTTP_PORT",
  "TICKET_PUBLIC_BASE_URL",
];

function snapshotHttpEnv() {
  return HTTP_ENV_KEYS.reduce((acc, key) => {
    acc[key] = process.env[key];
    return acc;
  }, {});
}

function restoreHttpEnv(snapshot) {
  for (const key of HTTP_ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

/**
 * Ask the OS for an unused port, then release it. The server config rejects
 * port 0, so we reserve-then-close instead of letting listen(0) assign.
 * @returns {Promise<number>}
 */
async function reserveEphemeralPort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  probe.close();
  await once(probe, "close");
  return port;
}

/**
 * Start the real server, retrying on a different port if the reserved one
 * got snipped between probe and listen (EADDRINUSE).
 * @param {typeof import("../src/features/tickets/httpServer")} mod
 * @returns {Promise<import("http").Server>}
 */
async function startServerOnFreePort(mod) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    process.env.TICKET_HTTP_PORT = String(await reserveEphemeralPort());
    const server = mod.startTicketHttpServer();
    assert.ok(
      server,
      "startTicketHttpServer must return a server when a port is configured"
    );
    const failure = await new Promise((resolve) => {
      server.once("listening", () => resolve(null));
      server.once("error", (err) => resolve(err));
    });
    if (!failure) return server;
    lastErr = failure;
    await mod.stopTicketHttpServer(); // reset the module singleton for retry
  }
  throw new Error(
    `could not bind test HTTP server: ${lastErr?.message || lastErr}`
  );
}

describe("web http net (tickets + oauth callback)", () => {
  /** @type {ReturnType<typeof loadDb>["api"]} */
  let db;
  let tmpDir;
  /** @type {typeof import("../src/features/tickets/httpServer")} */
  let httpNet;
  /** @type {import("http").Server} */
  let server;
  /** @type {string} */
  let baseUrl;
  let initialEnv;

  // --- §8.4 authenticated mirror (staff viewer) -----------------------------
  /** @type {import("http").Server} */
  let authServer;
  /** @type {string} */
  let authBase;
  /** @type {string} */
  let staffCookie;

  // Seeded fixtures (created in before)
  const guildHttp = "g-web-http";
  const guildPaged = "g-web-page";
  /** happy-path archived ticket */
  let tokenA;
  let pngBytes;
  /** closed-but-unarchived ticket that still carries a token */
  let tokenB;
  /** archived ticket whose transcript file is missing on disk */
  let tokenC;
  /** first (oldest) + last (newest) of PAGE_SIZE+1 paged tickets */
  let firstPagedToken;
  let lastPagedToken;

  /**
   * Fake guildAccess resolver for the authenticated mirror (§8.4 seam):
   * staff+ on the two fixture guilds, deny everywhere else. The REAL
   * resolver's staff/participant/cross-guild matrix is covered offline in
   * test/web-ticket-gating.test.js with snowflake ids — the fixture guild
   * ids here are deliberately NOT snowflakes (legacy fixtures), which the
   * production resolver shape-gates.
   */
  function makeFakeGuildAccess(staffGuilds) {
    return {
      async resolve(session, guildId) {
        if (!session) return { status: "anon" };
        if (staffGuilds.has(guildId)) {
          return { status: "ok", tier: "staff", guildId };
        }
        return { status: "deny", reason: "not_in_access_list" };
      },
      async listGuilds(session) {
        if (!session) return { guilds: [], degraded: false, reauth: true };
        return {
          guilds: [...staffGuilds].map((id) => ({ id, name: id })),
          degraded: false,
        };
      },
    };
  }

  before(async () => {
    initialEnv = snapshotHttpEnv();
    const loaded = loadDb(); // fresh SQLite + resets src module cache
    db = loaded.api;
    tmpDir = loaded.tmpDir;
    process.env.DATA_DIR = tmpDir;

    // Require AFTER loadDb so this module binds the fresh db + DATA_DIR.
    httpNet = require("../src/features/tickets/httpServer");
    const {
      writeTranscriptFile,
      absoluteAssetsDir,
    } = require("../src/features/tickets/transcript");

    // PUBLIC_* aliases would take precedence in getPublicHttpConfig(); pin
    // to the TICKET_* pair for the lifetime of the server.
    delete process.env.PUBLIC_HTTP_PORT;
    delete process.env.PUBLIC_BASE_URL;

    server = await startServerOnFreePort(httpNet);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.TICKET_PUBLIC_BASE_URL = baseUrl;

    // --- fixture: archived ticket with transcript file + asset -----------
    tokenA = db.generateTranscriptToken();
    const ticketA = db.createTicket({
      guildId: guildHttp,
      creatorUserId: "u-web",
      channelId: "ch-web-http-serve",
      reason: "web http net subject",
    });
    const written = writeTranscriptFile(
      { ...ticketA, close_reason: "done", closed_at: Date.now() },
      tokenA,
      [
        {
          message_id: "m1",
          author_id: "u-web",
          author_tag: "web user",
          content: "hello http net",
          attachment_urls: [
            {
              href: `/t/${tokenA}/assets/001_photo.png`,
              name: "photo.png",
              kind: "image",
            },
          ],
          sent_at: Date.now(),
        },
      ]
    );
    pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    const assetsDir = absoluteAssetsDir(guildHttp, tokenA);
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, "001_photo.png"), pngBytes);

    db.markTicketClosed(ticketA.id, {
      closedBy: "mod",
      closeReason: "done",
    });
    db.closeTicketArchived(ticketA.id, {
      closedBy: "mod",
      closeReason: "done",
      transcriptToken: tokenA,
      transcriptPath: written.relativePath,
      aiSummaryJson: null,
    });

    // --- fixture: closed, token set, but archived=0 (never indexed) ------
    tokenB = db.generateTranscriptToken();
    const ticketB = db.createTicket({
      guildId: guildHttp,
      creatorUserId: "u-web",
      channelId: "ch-web-http-unarchived",
      reason: "token without archive",
    });
    db.markTicketClosed(ticketB.id, { closedBy: "mod", closeReason: "done" });
    // token present but no path ⇒ archived stays 0 (see repo behavior)
    db.closeTicketArchived(ticketB.id, {
      closedBy: "mod",
      closeReason: "done",
      transcriptToken: tokenB,
      transcriptPath: null,
    });

    // --- fixture: archived row whose transcript file is missing ----------
    tokenC = db.generateTranscriptToken();
    const ticketC = db.createTicket({
      guildId: guildHttp,
      creatorUserId: "u-web",
      channelId: "ch-web-http-missing-file",
      reason: "missing transcript file",
    });
    db.markTicketClosed(ticketC.id, { closedBy: "mod", closeReason: "done" });
    db.closeTicketArchived(ticketC.id, {
      closedBy: "mod",
      closeReason: "done",
      transcriptToken: tokenC,
      transcriptPath: `ticket-transcripts/${guildHttp}/${tokenC}.html`,
    });

    // --- fixture: PAGE_SIZE + 1 archived tickets on one guild ------------
    const total = httpNet.PAGE_SIZE + 1;
    for (let i = 1; i <= total; i += 1) {
      const token = db.generateTranscriptToken();
      const ticket = db.createTicket({
        guildId: guildPaged,
        creatorUserId: "u-pager",
        channelId: `ch-web-page-${i}`,
        reason: `paged ticket ${i}`,
      });
      db.markTicketClosed(ticket.id, { closedBy: "mod", closeReason: "done" });
      db.closeTicketArchived(ticket.id, {
        closedBy: "mod",
        closeReason: "done",
        transcriptToken: token,
        transcriptPath: `ticket-transcripts/${guildPaged}/${token}.html`,
      });
      if (i === 1) firstPagedToken = token;
      if (i === total) lastPagedToken = token;
    }

    // --- §8.4 authenticated mirror server ---------------------------------
    // Same createWebApp the production server wraps, with the documented
    // guildAccess seam + a real session row (the fake resolver only reads
    // session presence). Byte-identical SQLite + DATA_DIR ⇒ byte-identical
    // responses for the staff viewer.
    const { createWebApp } = require("../src/web/app");
    const sessionPolicy = require("../src/web/auth/sessions");
    const app = createWebApp({
      guildAccess: makeFakeGuildAccess(new Set([guildHttp, guildPaged])),
    });
    authServer = http.createServer(app);
    authServer.listen(0, "127.0.0.1");
    await once(authServer, "listening");
    authBase = `http://127.0.0.1:${authServer.address().port}`;
    staffCookie = `web_session=${
      sessionPolicy.createSession({ userId: "u-net-staff" }).id
    }`;
  });

  after(async () => {
    if (authServer) {
      authServer.close();
      await once(authServer, "close");
    }
    if (httpNet) await httpNet.stopTicketHttpServer();
    restoreHttpEnv(initialEnv);
  });

  /**
   * §8.4: fetch the AUTHENTICATED mirror as a staff viewer of both fixture
   * guilds. redirect:"manual" so a future regression-to-login can never be
   * silently followed into a 200.
   */
  async function authFetch(pathName, init = {}) {
    return fetch(`${authBase}${pathName}`, {
      redirect: "manual",
      ...init,
      headers: { cookie: staffCookie, ...(init.headers || {}) },
    });
  }

  // ------------------------------------------------------------------
  // /health + method gate
  // ------------------------------------------------------------------

  it("GET /health → 200 plain ok; HEAD works; POST → 405", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /^text\/plain/);
    assert.equal(await res.text(), "ok");

    const head = await fetch(`${baseUrl}/health`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    const post = await fetch(`${baseUrl}/health`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(await post.text(), "Method not allowed");
  });

  // ------------------------------------------------------------------
  // §8.4 login gate on the anonymous ticket surface (public server)
  // ------------------------------------------------------------------

  it(
    "§8.4/§8.1-3: ANONYMOUS ticket routes (index aliases, /t/{uuid}, assets) " +
      "redirect to /auth/login — no content before login",
    async () => {
      for (const pathName of [
        "/",
        "/t",
        "/t/",
        "/t?guild=no-such-guild",
        `/t/${tokenA}`,
        `/t/${tokenA}/`,
        `/t/${tokenA}/assets/001_photo.png`,
        "/t/not-a-uuid",
        `/t/${tokenA}/bogus`,
      ]) {
        const res = await fetch(`${baseUrl}${pathName}`, {
          redirect: "manual",
        });
        assert.equal(res.status, 302, `${pathName} → login redirect`);
        assert.equal(res.headers.get("location"), "/auth/login");
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.equal(res.headers.get("referrer-policy"), "no-referrer");
        assert.equal(await res.text(), "", "no body leaks before login");
      }
    }
  );

  // ------------------------------------------------------------------
  // /t index (+ root aliases, guild filter, headers) — authenticated
  // staff viewer (§8.4). Byte assertions unchanged from the pre-auth net;
  // only the request posture moved.
  // ------------------------------------------------------------------

  it("GET /, /t and /t/ render the archive index with hardened headers", async () => {
    for (const pathName of ["/", "/t", "/t/"]) {
      const res = await authFetch(pathName);
      assert.equal(res.status, 200, `${pathName} status`);
      assert.match(
        res.headers.get("content-type") || "",
        /^text\/html; charset=utf-8/
      );
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      // §8.4/§8.1-3 posture change: the index is a shell page now (per-
      // response nonce + session CSRF embedded) → never cached. The pre-auth
      // `private, max-age=60` belonged to the MVP "not login-gated" page
      // that decision 3 retired; transcript/asset headers stay pinned.
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.ok(
        Number(res.headers.get("content-length")) > 0,
        `${pathName} Content-Length`
      );

      // All-guilds view spans pages; row fixtures are asserted guild-scoped.
      const body = await res.text();
      assert.match(body, /Archived tickets/i);
      assert.match(body, /staff use only/);
      // Stale MVP warning must be gone (login is mandatory now, §8.1-3).
      assert.doesNotMatch(body, /not login-gated/);
    }
  });

  it("GET /t?guild= filters by guild; non-staff guild param is IGNORED (scoped default)", async () => {
    const filtered = await authFetch(`/t?guild=${guildHttp}`);
    assert.equal(filtered.status, 200);
    const filteredBody = await filtered.text();
    assert.match(filteredBody, /Guild filter/);
    assert.match(filteredBody, new RegExp(guildHttp));
    assert.match(filteredBody, new RegExp(tokenA));

    // §8.4 (subtask 12 choice): the legacy ?guild= probe is honored ONLY for
    // guilds the viewer is staff+ for. A guild OUTSIDE the access list is
    // IGNORED (never filtered-to-empty, never foreign rows): the response is
    // the viewer's own scoped index — same 200 shape, but no "Guild filter"
    // and no leak of the requested guild's contents.
    const outside = await authFetch(`/t?guild=no-such-guild`);
    assert.equal(outside.status, 200);
    const outsideBody = await outside.text();
    assert.doesNotMatch(outsideBody, /Guild filter/, "ignored param must not filter");
    assert.doesNotMatch(outsideBody, /no-such-guild/, "never echoes the foreign guild");
    // The scoped default (page 1, closed_at DESC over ALL staffed guilds)
    // renders the viewer's own rows — newest fixture is always on page 1.
    assert.match(outsideBody, new RegExp(lastPagedToken), "viewer's own scoped rows render");
    assert.match(outsideBody, /All guilds/, "scoped default, not the ignored param");
  });

  // ------------------------------------------------------------------
  // /t/{uuid} happy path — authenticated staff viewer
  // ------------------------------------------------------------------

  it("GET /t/{uuid} serves the transcript with nosniff + private cache", async () => {
    const res = await authFetch(`/t/${tokenA}`);
    assert.equal(res.status, 200);
    assert.match(
      res.headers.get("content-type") || "",
      /^text\/html; charset=utf-8/
    );
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "private, max-age=300");

    const body = await res.text();
    assert.match(body, /hello http net/);
    assert.match(body, /Ticket #/);

    // Trailing slash variant is the same document
    const slashed = await authFetch(`/t/${tokenA}/`);
    assert.equal(slashed.status, 200);
    assert.match(await slashed.text(), /hello http net/);

    const head = await authFetch(`/t/${tokenA}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });

  // ------------------------------------------------------------------
  // /t/{uuid} error paths — authenticated staff viewer (non-auth
  // assertions kept verbatim: bodies, plain content-type, distinct messages)
  // ------------------------------------------------------------------

  it("GET /t/{invalid-uuid} → 404 plain", async () => {
    for (const bad of [
      "/t/not-a-uuid",
      "/t/nope",
      "/t/..%2Findex.html", // encoded traversal never survives the uuid gate
    ]) {
      const res = await authFetch(bad);
      assert.equal(res.status, 404, `${bad} status`);
      assert.match(res.headers.get("content-type") || "", /^text\/plain/);
      assert.equal(await res.text(), "Not found");
    }
  });

  it("GET /t/{valid-but-unknown-uuid} → 404", async () => {
    const unknown = db.generateTranscriptToken();
    const res = await authFetch(`/t/${unknown}`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "Not found");
  });

  it("GET /t/{uuid} on closed-but-unarchived token → 404", async () => {
    const res = await authFetch(`/t/${tokenB}`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "Not found");
  });

  it("GET /t/{uuid} when transcript file is missing → 404 distinct message", async () => {
    const res = await authFetch(`/t/${tokenC}`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "Transcript file missing");
  });

  // ------------------------------------------------------------------
  // assets — authenticated staff viewer
  // ------------------------------------------------------------------

  it("GET /t/{uuid}/assets/{file} serves bytes with image/png + long cache", async () => {
    const res = await authFetch(`/t/${tokenA}/assets/001_photo.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("cache-control"), "private, max-age=86400");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      Number(res.headers.get("content-length")),
      pngBytes.length
    );
    assert.deepEqual(
      Buffer.from(await res.arrayBuffer()),
      pngBytes
    );

    const head = await authFetch(`/t/${tokenA}/assets/001_photo.png`, {
      method: "HEAD",
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });

  it("asset route: traversal, missing file, unknown/invalid token → 404", async () => {
    const traversal = await authFetch(
      `/t/${tokenA}/assets/..%2Findex.html`
    );
    assert.equal(traversal.status, 404);

    const missing = await authFetch(
      `/t/${tokenA}/assets/999_nope.png`
    );
    assert.equal(missing.status, 404);

    const unknownToken = await authFetch(
      `/t/${db.generateTranscriptToken()}/assets/001_photo.png`
    );
    assert.equal(unknownToken.status, 404);

    const badUuid = await authFetch(
      "/t/not-a-uuid/assets/001_photo.png"
    );
    assert.equal(badUuid.status, 404);
  });

  // ------------------------------------------------------------------
  // OAuth callback (offline: no code exchange without valid state)
  // — stays PUBLIC (§8.1-3): "Only /health and OAuth endpoints stay public"
  // ------------------------------------------------------------------

  it("oauth callback: ?error= → 400 cancellation page", async () => {
    const res = await fetch(
      `${baseUrl}/oauth/command-permissions/callback` +
        `?error=access_denied&error_description=user+cancelled`
    );
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type") || "", /^text\/html/);
    const body = await res.text();
    assert.match(body, /Authorization cancelled/);
    assert.match(body, /user cancelled/);
  });

  it("oauth callback: missing code/state → 400 invalid callback (alias too)", async () => {
    for (const route of [
      "/oauth/command-permissions/callback",
      "/oauth/command-permissions/callback/",
    ]) {
      const res = await fetch(`${baseUrl}${route}`);
      assert.equal(res.status, 400, `${route} status`);
      assert.match(res.headers.get("content-type") || "", /^text\/html/);
      const body = await res.text();
      assert.match(body, /Invalid callback/);
      assert.match(body, /Missing/);
    }
  });

  it("oauth callback: tampered state → 400 expired link (never hits Discord)", async () => {
    const res = await fetch(
      `${baseUrl}/oauth/command-permissions/callback` +
        "?code=fake-code&state=ZmFrZS5zaWctbm90LXJlYWw"
    );
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.match(body, /Invalid or expired link/);
  });

  // ------------------------------------------------------------------
  // unknown routes / methods
  // ------------------------------------------------------------------

  it("unknown paths → 404; non-GET/HEAD methods → 405", async () => {
    const unknown = await fetch(`${baseUrl}/other`);
    assert.equal(unknown.status, 404);
    assert.match(unknown.headers.get("content-type") || "", /^text\/plain/);
    assert.equal(await unknown.text(), "Not found");

    // §8.4 note: under the /t prefix an anonymous miss is now the LOGIN
    // redirect (asserted above); the pre-existing 404 byte stays asserted
    // for the authenticated viewer, where the bogus sub-path still 404s.
    const extraSegment = await authFetch(`/t/${tokenA}/bogus`);
    assert.equal(extraSegment.status, 404);
    assert.equal(await extraSegment.text(), "Not found");

    // Method gate runs BEFORE the login gate (app.js order) — the legacy
    // 405 bytes are unchanged even for anonymous ticket requests.
    const post = await fetch(`${baseUrl}/t`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(await post.text(), "Method not allowed");

    const put = await fetch(`${baseUrl}/t/${tokenA}`, { method: "PUT" });
    assert.equal(put.status, 405);
    assert.equal(await put.text(), "Method not allowed");
  });

  // ------------------------------------------------------------------
  // pagination (§8.8 0a: /t incl. pagination param) — authenticated staff
  // viewer; guild honored (staff+ on guildPaged) so byte behavior is intact
  // ------------------------------------------------------------------

  it("/t?guild= paginates at PAGE_SIZE: page 1, page 2, clamping", async () => {
    const p1 = await authFetch(`/t?guild=${guildPaged}`);
    assert.equal(p1.status, 200);
    const p1body = await p1.text();
    assert.match(p1body, new RegExp(`Page 1 / 2`));
    assert.match(p1body, /\?guild=g-web-page&page=2/); // Next link target
    assert.match(p1body, new RegExp(lastPagedToken)); // newest on page 1
    assert.doesNotMatch(p1body, new RegExp(firstPagedToken));
    assert.equal((p1body.match(/>View<\/a>/g) || []).length, httpNet.PAGE_SIZE);

    const p2 = await authFetch(`/t?guild=${guildPaged}&page=2`);
    assert.equal(p2.status, 200);
    const p2body = await p2.text();
    assert.match(p2body, /Page 2 \/ 2/);
    assert.match(p2body, new RegExp(firstPagedToken)); // oldest on page 2
    assert.equal((p2body.match(/>View<\/a>/g) || []).length, 1);
    assert.match(p2body, /class="disabled">Next/); // no page 3

    // page beyond the end clamps to the last page
    const clamped = await authFetch(`/t?guild=${guildPaged}&page=999`);
    assert.match(await clamped.text(), /Page 2 \/ 2/);

    // nonsense page coerces to 1
    const nonsense = await authFetch(
      `/t?guild=${guildPaged}&page=abc`
    );
    assert.match(await nonsense.text(), /Page 1 \/ 2/);
  });

  // ------------------------------------------------------------------
  // env config helpers (pure env reads, no HTTP)
  // ------------------------------------------------------------------

  it("getHttpConfig + transcriptPublicUrl read env live", () => {
    const saved = snapshotHttpEnv();
    try {
      for (const key of HTTP_ENV_KEYS) delete process.env[key];
      assert.equal(httpNet.getHttpConfig().port, null);
      assert.equal(httpNet.transcriptPublicUrl("abc"), null);

      process.env.TICKET_HTTP_PORT = "9099";
      process.env.TICKET_PUBLIC_BASE_URL = "https://tickets.example.com/";
      assert.equal(httpNet.getHttpConfig().port, 9099);
      assert.equal(
        httpNet.transcriptPublicUrl("uuid-here"),
        "https://tickets.example.com/t/uuid-here"
      );

      // PUBLIC_* aliases win over the TICKET_* pair
      process.env.PUBLIC_HTTP_PORT = "9100";
      process.env.PUBLIC_BASE_URL = "https://public.example.com";
      assert.equal(httpNet.getHttpConfig().port, 9100);
      assert.equal(httpNet.getHttpConfig().publicBaseUrl, "https://public.example.com");

      // invalid ports normalize to null (server stays disabled)
      delete process.env.PUBLIC_HTTP_PORT;
      process.env.TICKET_HTTP_PORT = "not-a-number";
      assert.equal(httpNet.getHttpConfig().port, null);
    } finally {
      restoreHttpEnv(saved);
    }
  });

  it("smoke: temp dir used and server listening on ephemeral port", () => {
    assert.ok(tmpDir && fs.existsSync(tmpDir));
    assert.ok(server.listening);
    assert.notEqual(server.address().port, 0);
  });
});
