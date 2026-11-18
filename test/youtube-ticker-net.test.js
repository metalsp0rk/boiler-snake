/**
 * #858 — youtube ticker real-transport GET (`googleGetOnce`) against local
 * listeners. The production wedge was a request that established and then
 * went silent: no `end`, no `error`, promise never settled, scheduler slot
 * occupied forever. These tests pin the settle-exactly-once contract for
 * every transport outcome: success, API error status, mid-stream abort,
 * connect/keep-alive stall (the wedge itself), and key hygiene in errors.
 *
/**
 * http (not https) is injected as the transport seam — the module shape is
 * identical and no TLS fixtures are needed; production keeps https.
 *
 * #609/#620 discipline: the ticker module's load-time graph reaches src/db
 * (its settings/repo imports), so this file binds its own throwaway DB via
 * the sanctioned top-level binder (opened under the test-env-guard temp
 * dir) before any require of the ticker — the tests themselves never touch
 * the database (googleGetOnce is pure transport).
 */

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

// Sanctioned binder (column-0, before any db-reaching require): #609 pin.
const { cleanup: cleanupTempDb } = require("./helpers/env").loadDb();

const servers = [];

function ticker() {
  return require("../src/features/youtube/ticker");
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port }),
    );
  });
}

after(() => {
  for (const s of servers) s.close();
  cleanupTempDb();
});

test("success: 2xx JSON resolves { ok:true, data } via the real transport", async () => {
  const { port } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items: [{ id: "ch1" }] }));
  });
  const result = await ticker().googleGetOnce(
    { hostname: "127.0.0.1", port, path: "/v3/channels?part=snippet" },
    5000,
    http,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.items, [{ id: "ch1" }]);
});

test("API error status: { ok:false, status, error } carries the cause", async () => {
  const { port } = await startServer((_req, res) => {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "quotaExceeded" } }));
  });
  const result = await ticker().googleGetOnce(
    { hostname: "127.0.0.1", port, path: "/x" },
    5000,
    http,
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.match(result.error, /quotaExceeded/);
});

test("THE WEDGE (#858): a connection that never answers resolves via timeout instead of hanging forever", async () => {
  const { port } = await startServer(() => {
    // accept the request, send NOTHING, keep the socket open: no end, no
    // error — the exact prod failure that skipped 4,681 ticks.
  });
  const started = Date.now();
  const result = await ticker().googleGetOnce(
    { hostname: "127.0.0.1", port, path: "/stall" },
    150,
    http,
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /request timeout after 150ms/);
  assert.ok(Date.now() - started >= 140, "actually waited for the idle timeout");
});

test("mid-stream abort resolves with the aborted failure shape (never a hang)", async () => {
  const { port } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"items":');
    res.socket.destroy(); // server dies mid-body: end never arrives
  });
  const result = await ticker().googleGetOnce(
    { hostname: "127.0.0.1", port, path: "/half" },
    5000,
    http,
  );
  assert.equal(result.ok, false);
  assert.ok(
    /aborted|socket hang up|closed/i.test(result.error),
    `expected an abort/hang-up cause, got: ${result.error}`,
  );
});

test("key hygiene: failure strings never echo the request path (where the key rides)", async () => {
  const { port } = await startServer(() => {
    /* silence → timeout */
  });
  const SECRET = "AIzaFAKE_KEY_NEVER_LOGGED";
  const result = await ticker().googleGetOnce(
    { hostname: "127.0.0.1", port, path: `/v3/channels?key=${SECRET}` },
    120,
    http,
  );
  assert.equal(result.ok, false);
  assert.ok(!result.error.includes(SECRET), `error leaked the path: ${result.error}`);
});
