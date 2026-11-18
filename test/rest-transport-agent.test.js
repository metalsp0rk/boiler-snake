/**
 * #855 — jsdom's vendored undici@8 hijacks the process-global undici
 * dispatcher (legacy `undici.globalDispatcher.1` symbol) the first time it
 * loads (gork `readPage`). @discordjs/rest resolves undici@6, which reads
 * that same symbol and never sets `.2` — so post-hijack, rest's multipart
 * bodies (built with the NATIVE FormData, which rest cannot avoid: it reads
 * globalThis.FormData) are rejected by undici@8's foreign-FormData gate and
 * every file-carrying reply (/leaderboard's PNG) dies.
 *
 * This test pins BOTH halves of the story in one process:
 *  1. with jsdom loaded and NO explicit agent, a REST multipart send fails
 *     with the exact production error (the hijack, documented and asserted);
 *  2. with the pinned restTransportAgent() as the dispatcher, the identical
 *     send succeeds — the fix.
 *
 * Per-file process isolation (node --test) keeps the jsdom poisoning from
 * leaking into other test files.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { restTransportAgent } = require("../src/core/restTransportAgent");

/** All bytes of the last received request, per request, for assertions. */
const received = [];
let server;
let apiBase;

before(async () => {
  // Poison the global dispatcher FIRST: loading jsdom runs its nested
  // undici@8 lib/global.js, which overwrites undici.globalDispatcher.1.
  require("jsdom");

  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({
        method: req.method,
        url: req.url,
        contentType: req.headers["content-type"] || "",
        body: Buffer.concat(chunks),
      });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  apiBase = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

function probeRest(options = {}) {
  const { REST } = require("discord.js");
  const rest = new REST({ version: "10", api: `${apiBase}/api`, ...options });
  rest.setToken("bogus.test.token");
  return rest;
}

function multipartRequest() {
  return {
    route: "/probe/channels/1/messages",
    body: { type: 4, data: { content: "leaderboard probe" } },
    files: [
      {
        key: "file0",
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        name: "boiler-snake-leaderboard.png",
        contentType: "image/png",
      },
    ],
  };
}

test("restTransportAgent() yields a usable undici Agent singleton", () => {
  const agent = restTransportAgent();
  assert.equal(agent, restTransportAgent(), "must be a lazily built singleton");
  assert.equal(typeof agent?.dispatch, "function", "looks like an undici dispatcher");
});

test("REGRESSION #855: after jsdom loads, an un-pinned REST multipart send dies on the foreign-FormData gate", async () => {
  await assert.rejects(
    () => probeRest().post("/probe/channels/1/messages", multipartRequest()),
    (err) => {
      const text = `${err?.message || ""} ${err?.cause?.message || ""}`;
      assert.match(
        text,
        /FormData created by this undici package instance|other side closed|fetch failed/,
        `expected the #855 foreign-FormData rejection, got: ${text}`,
      );
      assert.match(
        text,
        /FormData created by this undici package instance/,
        `expected the exact #855 hijack message (not an incidental transport error): ${text}`,
      );
      return true;
    },
  );
});

test("FIX #855: with the pinned transport agent, the identical send succeeds after the hijack", async () => {
  const before2 = received.length;
  const agent = restTransportAgent();
  const result = await probeRest({ agent }).post(
    "/probe/channels/1/messages",
    multipartRequest(),
  );
  assert.ok(result, "REST resolves with the parsed response body");
  const hit = received[before2];
  assert.equal(hit.method, "POST");
  assert.match(hit.contentType, /^multipart\/form-data; boundary=/);
  assert.match(hit.body.toString("latin1"), /payload_json/);
  assert.match(hit.body.toString("latin1"), /boiler-snake-leaderboard\.png/);
});
