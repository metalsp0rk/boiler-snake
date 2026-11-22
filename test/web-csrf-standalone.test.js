"use strict";

/**
 * #905 item 5 (audit r4 F10e): the STANDALONE csrf guard's raw-body drain
 * used to destroy the request the moment the byte budget was crossed —
 * then the caller wrote its 413 onto the dead socket: clients saw a
 * connection reset instead of the documented "Payload too large". The
 * ordering law (already honored in rateLimit.js): RESPOND FIRST, destroy
 * after. Pinned over a REAL http server on a REAL socket — a fake req/res
 * cannot catch socket-level ordering.
 */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

// DB-binding discipline (test/db-binding-discipline.test.js): csrf.js
// loads src/db-bound config at require time — bind a private temp DB
// BEFORE the first src/** require (#609 class).
const { cleanup: cleanupTempDb } = require("./helpers/env").loadDb();
after(cleanupTempDb);

const { createCsrfMiddleware } = require("../src/web/middleware/csrf");

function post(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/g/1/settings", headers: { "content-type": "application/x-www-form-urlencoded" } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("standalone guard: overflow gets the documented 413, not a socket reset", async () => {
  const guard = createCsrfMiddleware({
    getSecret: () => "s".repeat(32),
    getSessionId: () => "sess-1",
    maxBodyBytes: 64,
  });
  const server = http.createServer((req, res) => {
    guard(req, res, () => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("past the guard");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    // 512 bytes against a 64-byte cap: the drain overflows mid-request.
    const res = await post(port, "a".repeat(512));
    assert.equal(res.status, 413, `expected 413 (got ${res.status}: ${res.text})`);
    assert.match(res.text, /Payload too large/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("in-budget bodies still reach the guard's token stage (403, token missing)", async () => {
  const guard = createCsrfMiddleware({
    getSecret: () => "s".repeat(32),
    getSessionId: () => "sess-1",
    maxBodyBytes: 4096,
  });
  const server = http.createServer((req, res) => {
    guard(req, res, () => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("past the guard");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const res = await post(port, "problem=short");
    assert.equal(res.status, 403, "no valid token → forbidden (drain handed control back)");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
