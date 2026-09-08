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
const { setBotGuildsProvider } = require("../../web/auth/botGuilds");
const { bindAuditClient } = require("../../web/middleware/audit");

module.exports = {
  name: "web",
  /**
   * @param {import("discord.js").Client} client
   */
  start(client) {
    // Production bot-guild provider (login guild intersection, §8.3): the
    // discord.js v14 guild cache, READ LIVE at every login. It is only
    // complete after READY — a login racing cold boot may briefly see a
    // partial list; the snapshot refreshes on the next login (07 re-checks
    // per TTL). Guarded so tests/harnesses without a client never throw.
    setBotGuildsProvider(() => client?.guilds?.cache?.keyArray?.() ?? []);
    // Bind the client for the audit middleware's best-effort channel-embed
    // mirror (§8.1-7): the admin_audit DB row is authoritative; the embed is
    // fire-and-forget and no-ops cleanly when the client is absent.
    bindAuditClient(client);
    startWebServer();
  },
};
