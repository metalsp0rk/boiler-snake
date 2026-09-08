/**
 * HTTP lifecycle for the public web surface (roadmap/web-admin.md §8.2:
 * ownership of PUBLIC_HTTP_PORT moved here from tickets/httpServer.js).
 *
 * Dark by default: no port configured → nothing listens, boot unchanged
 * (§8.8 "each phase ships dark-by-default"). startWebServer() is idempotent;
 * stopWebServer() exists for tests and resets the singleton so a retry can
 * bind a different port.
 *
 * The server is created with http.createServer(app) rather than
 * app.listen() on purpose: Express 5 routes listen errors (EADDRINUSE)
 * through the listen callback, but the legacy facade exposed them as
 * node:http 'error' events — test/web-http-net.test.js relies on the
 * 'error'/'listening' event pair and the raw Server return value.
 */

const http = require("http");
const { createWebApp } = require("./app");
const { getHttpConfig } = require("./config");

/** @type {import("http").Server|null} */
let server = null;

/**
 * Start listening if PUBLIC_HTTP_PORT / TICKET_HTTP_PORT is set.
 * Idempotent.
 * @returns {import("http").Server|null}
 */
function startWebServer() {
  const { port } = getHttpConfig();
  if (!port) {
    console.log(
      "[http] Public HTTP server disabled (set PUBLIC_HTTP_PORT or TICKET_HTTP_PORT to enable transcripts + OAuth)."
    );
    return null;
  }
  if (server) return server;

  server = http.createServer(createWebApp());

  server.on("error", (err) => {
    console.error("[http] server error:", err?.message || err);
  });

  server.listen(port, () => {
    console.log(
      `[http] Listening on port ${port} (transcripts: /t · OAuth: /oauth/command-permissions/callback)`
    );
  });

  return server;
}

/**
 * Stop the server (tests).
 * @returns {Promise<void>}
 */
function stopWebServer() {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    const s = server;
    server = null;
    s.close(() => resolve());
  });
}

module.exports = {
  startWebServer,
  stopWebServer,
};
