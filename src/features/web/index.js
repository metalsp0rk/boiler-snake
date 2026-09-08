/**
 * `web` boot feature (roadmap/web-admin.md §8.2): owns starting the public
 * HTTP server when PUBLIC_HTTP_PORT / TICKET_HTTP_PORT is set. Unset →
 * nothing listens (dark-by-default boot, §8.8 "each phase ships
 * dark-by-default").
 *
 * Phase 0a: start only — ownership moved out of the tickets feature.
 * Phase 0b+ grows this module into the web feature contract (route
 * contributions via a `web` descriptor, session/auth wiring) collected at
 * boot the way commands/handlers are today.
 */

const { startWebServer } = require("../../web/server");

module.exports = {
  name: "web",
  /**
   * @param {import("discord.js").Client} _client
   */
  start(_client) {
    startWebServer();
  },
};
