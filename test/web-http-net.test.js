/**
 * HTTP-level test net for the public ticket/OAuth surface (Phase 0a gate).
 *
 * Replaces the old handleRequest(mockReq, mockRes) seam: the real
 * node:http server is started on an OS-assigned ephemeral port via
 * startTicketHttpServer() and driven exclusively with fetch().
 *
 * Per roadmap/web-admin.md §8.8 (Phase 0a first task) + §8.11:
 * this net must be GREEN against the pre-extraction server and must stay
 * green after the Express 5 extraction (subtask 04 may not start until it is).
 * Real SQLite + offline mocks only; node --test only.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
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
  });

  after(async () => {
    if (httpNet) await httpNet.stopTicketHttpServer();
    restoreHttpEnv(initialEnv);
  });

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
  // /t index (+ root aliases, guild filter, headers)
  // ------------------------------------------------------------------

  it("GET /, /t and /t/ render the archive index with hardened headers", async () => {
    for (const pathName of ["/", "/t", "/t/"]) {
      const res = await fetch(`${baseUrl}${pathName}`);
      assert.equal(res.status, 200, `${pathName} status`);
      assert.match(
        res.headers.get("content-type") || "",
        /^text\/html; charset=utf-8/
      );
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("cache-control"), "private, max-age=60");
      assert.ok(
        Number(res.headers.get("content-length")) > 0,
        `${pathName} Content-Length`
      );

      // All-guilds view spans pages; row fixtures are asserted guild-scoped.
      const body = await res.text();
      assert.match(body, /Archived tickets/i);
      assert.match(body, /staff use only/);
    }
  });

  it("GET /t?guild= filters by guild; unknown guild shows empty state", async () => {
    const filtered = await fetch(`${baseUrl}/t?guild=${guildHttp}`);
    assert.equal(filtered.status, 200);
    const filteredBody = await filtered.text();
    assert.match(filteredBody, /Guild filter/);
    assert.match(filteredBody, new RegExp(guildHttp));
    assert.match(filteredBody, new RegExp(tokenA));

    const empty = await fetch(`${baseUrl}/t?guild=no-such-guild`);
    assert.equal(empty.status, 200);
    assert.match(await empty.text(), /No archived transcripts/i);
  });

  // ------------------------------------------------------------------
  // /t/{uuid} happy path
  // ------------------------------------------------------------------

  it("GET /t/{uuid} serves the transcript with nosniff + private cache", async () => {
    const res = await fetch(`${baseUrl}/t/${tokenA}`);
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
    const slashed = await fetch(`${baseUrl}/t/${tokenA}/`);
    assert.equal(slashed.status, 200);
    assert.match(await slashed.text(), /hello http net/);

    const head = await fetch(`${baseUrl}/t/${tokenA}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });

  // ------------------------------------------------------------------
  // /t/{uuid} error paths
  // ------------------------------------------------------------------

  it("GET /t/{invalid-uuid} → 404 plain", async () => {
    for (const bad of [
      "/t/not-a-uuid",
      "/t/nope",
      "/t/..%2Findex.html", // encoded traversal never survives the uuid gate
    ]) {
      const res = await fetch(`${baseUrl}${bad}`);
      assert.equal(res.status, 404, `${bad} status`);
      assert.match(res.headers.get("content-type") || "", /^text\/plain/);
      assert.equal(await res.text(), "Not found");
    }
  });

  it("GET /t/{valid-but-unknown-uuid} → 404", async () => {
    const unknown = db.generateTranscriptToken();
    const res = await fetch(`${baseUrl}/t/${unknown}`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "Not found");
  });

  it("GET /t/{uuid} on closed-but-unarchived token → 404", async () => {
    const res = await fetch(`${baseUrl}/t/${tokenB}`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "Not found");
  });

  it("GET /t/{uuid} when transcript file is missing → 404 distinct message", async () => {
    const res = await fetch(`${baseUrl}/t/${tokenC}`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "Transcript file missing");
  });

  // ------------------------------------------------------------------
  // assets
  // ------------------------------------------------------------------

  it("GET /t/{uuid}/assets/{file} serves bytes with image/png + long cache", async () => {
    const res = await fetch(`${baseUrl}/t/${tokenA}/assets/001_photo.png`);
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

    const head = await fetch(`${baseUrl}/t/${tokenA}/assets/001_photo.png`, {
      method: "HEAD",
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });

  it("asset route: traversal, missing file, unknown/invalid token → 404", async () => {
    const traversal = await fetch(
      `${baseUrl}/t/${tokenA}/assets/..%2Findex.html`
    );
    assert.equal(traversal.status, 404);

    const missing = await fetch(
      `${baseUrl}/t/${tokenA}/assets/999_nope.png`
    );
    assert.equal(missing.status, 404);

    const unknownToken = await fetch(
      `${baseUrl}/t/${db.generateTranscriptToken()}/assets/001_photo.png`
    );
    assert.equal(unknownToken.status, 404);

    const badUuid = await fetch(
      `${baseUrl}/t/not-a-uuid/assets/001_photo.png`
    );
    assert.equal(badUuid.status, 404);
  });

  // ------------------------------------------------------------------
  // OAuth callback (offline: no code exchange without valid state)
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

    const extraSegment = await fetch(`${baseUrl}/t/${tokenA}/bogus`);
    assert.equal(extraSegment.status, 404);

    const post = await fetch(`${baseUrl}/t`, { method: "POST" });
    assert.equal(post.status, 405);

    const put = await fetch(`${baseUrl}/t/${tokenA}`, { method: "PUT" });
    assert.equal(put.status, 405);
  });

  // ------------------------------------------------------------------
  // pagination (§8.8 0a: /t incl. pagination param)
  // ------------------------------------------------------------------

  it("/t?guild= paginates at PAGE_SIZE: page 1, page 2, clamping", async () => {
    const p1 = await fetch(`${baseUrl}/t?guild=${guildPaged}`);
    assert.equal(p1.status, 200);
    const p1body = await p1.text();
    assert.match(p1body, new RegExp(`Page 1 / 2`));
    assert.match(p1body, /\?guild=g-web-page&page=2/); // Next link target
    assert.match(p1body, new RegExp(lastPagedToken)); // newest on page 1
    assert.doesNotMatch(p1body, new RegExp(firstPagedToken));
    assert.equal((p1body.match(/>View<\/a>/g) || []).length, httpNet.PAGE_SIZE);

    const p2 = await fetch(`${baseUrl}/t?guild=${guildPaged}&page=2`);
    assert.equal(p2.status, 200);
    const p2body = await p2.text();
    assert.match(p2body, /Page 2 \/ 2/);
    assert.match(p2body, new RegExp(firstPagedToken)); // oldest on page 2
    assert.equal((p2body.match(/>View<\/a>/g) || []).length, 1);
    assert.match(p2body, /class="disabled">Next/); // no page 3

    // page beyond the end clamps to the last page
    const clamped = await fetch(`${baseUrl}/t?guild=${guildPaged}&page=999`);
    assert.match(await clamped.text(), /Page 2 \/ 2/);

    // nonsense page coerces to 1
    const nonsense = await fetch(
      `${baseUrl}/t?guild=${guildPaged}&page=abc`
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
