/**
 * Ban lifecycle feature module (#772) — tracked bans with DM-before-ban,
 * expiring durations, auto-unban, and the welcome-back path.
 *
 * Thin module on the load.js contract (rss/warnings shape): the command
 * surface (builders, handlers, handlerApi, modalHandlers) comes from
 * ./commands and is re-exported unchanged — applyFeaturesToRegistry claims
 * /ban + /bannotify + the "Ban member" user menu and the `bl:ban:` modal
 * prefix under the owner name below (A2-10 collision guard). NO
 * buttonHandlers: #772 ships no ban buttons (the #773 appeals seam reserves
 * the sibling `bl:appeal:` prefix later).
 *
 * Explicit Fluxer NO-PARITY (epic decision, docs/ban-lifecycle.md): every
 * command arm refuses NOT_ON_FLUXER inside ./commands handlers; this module
 * adds no Fluxer surface.
 *
 * The boot hooks are pure delegations (subtasks 06–08 own the logic):
 *  - registerEvents → ./events (GuildBanRemove + GuildMemberAdd binds; the
 *    load.js guard logs `[features] banLifecycle.registerEvents failed:` if
 *    a raw/foreign supervisor ever reaches it — never a crash);
 *  - start → ./ticker (scheduler job `ban-expiry`, aligned minute cadence,
 *    runImmediately carries the boot sweep + the ONE reconciliation pass).
 *    ticker.start returns the { stop() } loop handle; load.js registers it
 *    with core/lifecycle for the SIGTERM/SIGINT drain (bridge/web idiom).
 *    Double-boot is idempotent: scheduler.registerJob replaces the same-name
 *    job, and stopScheduledJob on an absent job is a no-op.
 */

const {
  commands,
  handlers,
  handlerApi,
  modalHandlers,
} = require("./commands");
const { registerEvents } = require("./events");
const { start: startBanExpiryTicker } = require("./ticker");

/**
 * Gateway binds (#772 §5): GuildBanRemove → external-unban settle + welcome,
 * GuildMemberAdd → the bounded rejoin-welcome retry. No-op on a null
 * supervisor (Discord unconfigured).
 *
 * @param {import("../../platform/boot").Supervisor|null} supervisor
 * @param {object} [featureCtx]
 */
function registerFeatureEvents(supervisor, featureCtx) {
  registerEvents(supervisor, featureCtx);
}

/**
 * Boot hook (guarded per-feature by load.js): register the aligned
 * minute-cadence `ban-expiry` job; the immediate first fire runs the boot
 * reconciliation (§2) plus the due-expiry sweep (§4). Idempotent across
 * restarts (same-name registerJob replaces).
 *
 * @param {import("../../platform/boot").Supervisor|null} supervisor
 * @param {object} [featureCtx]
 * @returns {{ stop: () => void }} loop handle for the graceful-shutdown drain
 */
function start(supervisor, featureCtx) {
  return startBanExpiryTicker(supervisor, featureCtx);
}

module.exports = {
  name: "banLifecycle",
  commands,
  handlers,
  handlerApi,
  modalHandlers,
  registerEvents: registerFeatureEvents,
  start,
};
