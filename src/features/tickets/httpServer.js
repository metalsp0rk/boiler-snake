/**
 * COMPATIBILITY SHIM — the HTTP surface moved to `src/web/` in Phase 0a of
 * the web admin console (roadmap/web-admin.md §8.2). The tickets feature no
 * longer owns the server; the `web` boot feature (src/features/web) starts
 * it. This module path is kept so existing consumers keep working:
 *
 *   - src/features/tickets/close.js  → transcriptPublicUrl()
 *   - test/web-http-net.test.js      → start/stopTicketHttpServer,
 *                                      getHttpConfig, PAGE_SIZE
 *
 * Behavior is identical: every export delegates straight to src/web/.
 * New code must import from src/web/* directly; the ticket-scoped
 * aliases here are frozen and shrink in Phase 0c.
 */

const { startWebServer, stopWebServer } = require("../../web/server");
const {
  getHttpConfig,
  transcriptPublicUrl,
} = require("../../web/config");
const { PAGE_SIZE } = require("../../web/routes/transcripts");

module.exports = {
  getHttpConfig,
  transcriptPublicUrl,
  // Legacy ticket-scoped aliases for the shared web server lifecycle.
  startTicketHttpServer: startWebServer,
  stopTicketHttpServer: stopWebServer,
  PAGE_SIZE,
};
