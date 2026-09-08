/**
 * Express 5 app factory for the public HTTP surface (roadmap/web-admin.md
 * §8.2). PURE FACTORY: no listen(), no env reads, no module-level state —
 * createWebApp() returns a ready app that server.js (or a test) binds to an
 * ephemeral port itself.
 *
 * Byte-identical mode (Phase 0a contract, test/web-http-net.test.js is the
 * oracle):
 *  - responses go through raw `res.writeHead()/res.end()` only — never
 *    res.send()/res.json() — so Express adds no ETag, charset, or extra
 *    framing versus the legacy node:http handler;
 *  - a GET/HEAD method gate runs BEFORE the router: the Express 5 router
 *    would answer method mismatches with its own 405 + Allow header, but
 *    the legacy server answered every non-GET/HEAD with
 *    `405 "Method not allowed"` (plain text) on every path, known or not;
 *  - handlers parse the RAW req.url (never req.query) so the Express 5
 *    "simple" query-parser default and path-to-regexp decoding cannot
 *    change behavior;
 *  - x-powered-by disabled, etag generation off (defense in depth).
 */

const express = require("express");
const { registerTranscriptRoutes } = require("./routes/transcripts");
const { registerOauthRoutes } = require("./routes/oauth");

/**
 * Legacy dispatch gate: anything but GET/HEAD is rejected before routing.
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {() => void} next
 */
function methodGate(req, res, next) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }
  next();
}

/**
 * Liveness probe (stays public even after Phase 0c login-gating).
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
function handleHealth(req, res) {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(req.method === "HEAD" ? undefined : "ok");
}

/**
 * Catch-all 404 for paths no route claimed (matches the legacy body).
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
function handleNotFound(req, res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

/**
 * Terminal error middleware (arity must stay exactly 4 — Express 5 skips
 * non-4-arg functions). Mirrors the legacy wrapper around handleRequest.
 * @param {Error} err
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {(err: Error) => void} next
 */
function handleAppError(err, req, res, next) {
  console.error("[http] handler error:", err);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Internal error");
}

/**
 * Build the web admin / transcript app (no I/O, no listener).
 * @returns {import("express").Express}
 */
function createWebApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  app.use(methodGate);
  app.get("/health", handleHealth);
  registerOauthRoutes(app);
  registerTranscriptRoutes(app);

  app.use(handleNotFound);
  app.use(handleAppError);
  return app;
}

module.exports = {
  createWebApp,
};
