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
 *
 * Fluxer PR 10 (spec §Boot, roadmap L748-762): on top of the PR 7
 * `start(supervisor)` signature, this module wires the Fluxer providers —
 * `getFluxerWebInstances()` (login instances with lazily DISCOVERED api
 * bases) and `getCommunityClient(communityId)` (the supervisor's
 * OutboundClient lookup). The Discord client keeps flowing through
 * `getClient: () => client` exactly as PR 7 shipped; the argument shape is
 * additive options only.
 */

const { startWebServer } = require("../../web/server");
const { setBotGuildsProvider } = require("../../web/auth/botGuilds");
const { bindAuditClient } = require("../../web/middleware/audit");
const { parseFluxerInstances } = require("../../config");
const { discoverInstance } = require("../../platform/fluxer/discovery");
const { fluxerInstanceSlug } = require("../../web/auth/fluxerApi");

/**
 * Build the Fluxer login-instance provider (spec PR 10 / bundle C12):
 * parse FLUXER_INSTANCES ONCE, keep the entries that carry clientId AND
 * clientSecret (the login-capable ones), map to
 * {instanceKey, slug, label, clientId, clientSecret, origin}, and resolve
 * `apiBase` LAZILY through discovery: the first getter call kicks off
 * discoverInstance(origin) per instance (fire-and-forget); entries report
 * apiBase null until discovery resolves, and a failed discovery caches null
 * so the login route renders the "Login unavailable" 503 naming discovery.
 * Never throws at boot — a malformed FLUXER_INSTANCES disables Fluxer login
 * for this process (web login keeps Discord working).
 * @param {{ fetchImpl?: Function }} [opts]
 * @returns {() => Array<object>}
 */
function buildFluxerWebInstancesProvider({ fetchImpl } = {}) {
  let entries;
  try {
    entries = parseFluxerInstances(process.env.FLUXER_INSTANCES ?? "", {
      allowInsecure: process.env.FLUXER_ALLOW_INSECURE === "1",
    });
  } catch (err) {
    console.warn(
      "[web] FLUXER_INSTANCES is invalid — Fluxer web login disabled:",
      err?.message || err
    );
    return () => [];
  }
  const loginEntries = entries
    .filter((e) => e.clientId && e.clientSecret)
    .map((e) => ({
      instanceKey: e.instanceKey,
      slug: fluxerInstanceSlug(e.instanceKey),
      label: e.label,
      clientId: e.clientId,
      clientSecret: e.clientSecret,
      origin: e.origin,
    }));

  /** instanceKey → resolved apiPublic (null once discovery has FAILED). */
  const apiBaseByKey = new Map();
  const inFlight = new Set();
  for (const entry of loginEntries) {
    if (inFlight.has(entry.instanceKey)) continue;
    inFlight.add(entry.instanceKey);
    // Fire-and-forget (boot must not await the network). Own catch: one
    // dead instance cannot take the web boot down.
    Promise.resolve()
      .then(() =>
        discoverInstance(entry.origin, fetchImpl ? { fetchImpl } : {})
      )
      .then((discovered) => {
        apiBaseByKey.set(entry.instanceKey, discovered.apiPublic);
      })
      .catch((err) => {
        console.warn(
          `[web] fluxer discovery failed for instance ${entry.instanceKey}:`,
          err?.message || err
        );
        apiBaseByKey.set(entry.instanceKey, null); // 503 page names discovery
      })
      .finally(() => {
        inFlight.delete(entry.instanceKey);
      });
  }

  return function getFluxerWebInstances() {
    return loginEntries.map((e) => ({
      ...e,
      apiBase: apiBaseByKey.get(e.instanceKey) ?? null,
    }));
  };
}

module.exports = {
  name: "web",
  /**
   * @param {import("../../platform/boot").Supervisor} supervisor
   * @param {object} [ctx]
   */
  start(supervisor, ctx) {
    // PR 7 (spec § Supervisor + § Boot): the Discord client comes from the
    // supervisor; null (no DISCORD_TOKEN) keeps the empty-cache fallback below.
    const client = supervisor?.discord ?? null;
    // Production bot-guild provider (login guild intersection, §8.3): the
    // discord.js v14 guild cache, READ LIVE at every login. It is only
    // complete after READY — a login racing cold boot may briefly see a
    // partial list; the snapshot refreshes on the next login (07 re-checks
    // per TTL). Guarded so tests/harnesses without a client never throw.
    // NOTE: spread [...keys()] — discord.js 14.26 (@discordjs/collection v4)
    // removed Collection#keyArray; an optional-call on it fails SILENTLY to []
    // and every guild disappears from the console (prod incident 2026-09-17).
    setBotGuildsProvider(() => (client?.guilds?.cache ? [...client.guilds.cache.keys()] : []));
    // Bind the client for the audit middleware's best-effort channel-embed
    // mirror (§8.1-7): the admin_audit DB row is authoritative; the embed is
    // fire-and-forget and no-ops cleanly when the client is absent.
    bindAuditClient(client);
    // Cache-only Discord seam (§8.6): routes resolve channel/role names +
    // do cache-only staff preflights through getClient(). In production
    // this is the live client cache; tests inject a fake via createWebApp.
    // Absent/degraded ⇒ graceful id-only fallback (never throws/fetches).
    //
    // Fluxer PR 10 additions (additive options — the PR 7 argument shape
    // stands): getFluxerWebInstances feeds the Fluxer login routes + the
    // resolver's refresh rotation; getCommunityClient is the supervisor's
    // per-community OutboundClient lookup, consumed by the Fluxer login
    // guild-visibility checks, the staff-tier member fetch, and the Fluxer
    // routing inside discord-cache/memberFetchQueue.
    startWebServer({
      getClient: () => client,
      getFluxerWebInstances: buildFluxerWebInstancesProvider(),
      getCommunityClient: (communityId) => {
        try {
          return supervisor?.clientForCommunity?.(communityId) ?? null;
        } catch (err) {
          console.warn(
            `[web] clientForCommunity(${communityId}) failed:`,
            err?.message || err
          );
          return null;
        }
      },
    });
  },
};
