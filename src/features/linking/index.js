/**
 * Account-linking feature module (roadmap/account-linking.md T2).
 *
 * Scope of this file at T2: the module SURFACE. All product logic lives in
 * service.js (codes are minted/verified in codes.js); T3 adds the command
 * builders and the context-API handler. T4 landed the XP fan-out: start()
 * attaches the supervisor so service.fanOutLinkedXp (called from
 * src/services/awardXp.js) can resolve mirror targets via resolveMirrorTarget
 * + supervisor.clientForCommunity. T5 wires gork memory fan-out through
 * service.expandLinkedIds.
 *
 * Boot shape mirrors src/features/bridge/index.js:
 *  - `commands` / `handlers` / `handlerApi` are the registry surface (see
 *    src/features/load.js). T3 landed the `/link` slash command and its ONE
 *    context-API handler (commands.js) — `handlerApi: { link: "context" }`
 *    opts BOTH the Discord slash and the Fluxer prefix path in (the shipped
 *    dispatcher routes `!link …` to the same handler; KD 17: single entry).
 *    The Fluxer prefix tree is built FROM the slash JSON, so no separate
 *    Fluxer registry entry exists (same shape as bridge/xp).
 *  - `registerEvents(supervisor, ctx)` is the event hook. Nothing to wire at
 *    T2 (linking has no gateway listener — the code exchange runs entirely
 *    through the command handlers), so it is an idempotent no-op T4 can grow.
 *  - `start(supervisor, ctx)` arms the link-code expiry sweeper on the shared
 *    core scheduler. Codes expire on their own (redeem checks expires_at and a
 *    spent/expired code can never redeem), so this is space reclamation, not a
 *    security control — a failure to arm degrades to a table that grows.
 *
 * Every boot hook is idempotent and never throws: load.js wraps each hook per
 * feature and logs `[features] linking.<hook> failed` (AGENTS.md), and the
 * guards below keep that path unreachable in normal operation.
 */

const service = require("./service");
const codes = require("./codes");
const { commands, handleLink } = require("./commands");

/** Sweeper cadence: codes live 15 minutes, so hourly sweeps are generous. */
const CODE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Job name on the shared core scheduler (web's job-health bridge lists it). */
const CODE_SWEEP_JOB = "linking-code-expiry";

let sweeperArmed = false;

/**
 * Arm the expired-link-code sweeper once per process.
 * @returns {boolean} true when this call armed the job
 */
function armCodeSweeper() {
  if (sweeperArmed) return false;
  sweeperArmed = true;
  try {
    const { registerJob } = require("../../core/scheduler");
    registerJob({
      name: CODE_SWEEP_JOB,
      intervalMs: CODE_SWEEP_INTERVAL_MS,
      // service.purgeExpiredLinkCodes swallows and logs its own failures, so
      // one bad sweep can never kill the scheduler tick (AGENTS.md rule 1).
      run: () => service.purgeExpiredLinkCodes(),
    });
    return true;
  } catch (err) {
    sweeperArmed = false; // allow a later start() to retry
    console.error("[linking] sweeper job registration failed:", err?.message || err);
    return false;
  }
}

/**
 * Feature boot hook (src/features/load.js): capture the supervisor for the
 * XP fan-out seam (T4) and arm the code sweeper.
 * Idempotent — repeated register/start calls never double-register the job,
 * and attachSupervisor is idempotent (last attach wins).
 *
 * @param {object|null} supervisor platform supervisor ({ discord, fluxer, clientForCommunity })
 * @param {object} [ctx] feature context ({ scheduler, registry, ... }) — unused
 */
function start(supervisor, ctx) {
  void ctx;
  // T4 seam: service.fanOutLinkedXp resolves each mirror target's
  // OutboundClient through supervisor.clientForCommunity. Wrapped so an
  // attach failure can never kill the boot hook (AGENTS.md rule 1): linking
  // degrades to "no client" mirror warnings, the sweeper still arms.
  try {
    service.attachSupervisor(supervisor);
  } catch (err) {
    console.error("[linking] supervisor attach failed:", err?.message || err);
  }
  armCodeSweeper();
}

/**
 * Feature event hook (src/features/linking: no gateway listeners at T2).
 * T3 wires the Fluxer prefix routing through the shared context-API dispatcher
 * (src/platform/fluxer/dispatch.js), not here — same shape bridge uses.
 *
 * @param {object|null} supervisor
 * @param {object} [ctx]
 */
function registerEvents(supervisor, ctx) {
  void supervisor;
  void ctx;
}

module.exports = {
  name: "linking",

  // --- registry surface (T3: /link on Discord slash + Fluxer prefix) ---
  commands,
  handlers: {
    link: handleLink,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): the slash
  // handler receives a CommandContext, and the Fluxer prefix dispatcher only
  // runs "context"-API handlers (src/platform/fluxer/dispatch.js step 5) —
  // ONE implementation serves both surfaces.
  handlerApi: {
    link: "context",
  },

  // --- boot hooks ---
  registerEvents,
  start,

  // --- module surface consumed by T4/T5, web, and tests ---
  service,
  codes,
  createLinkCode: service.createLinkCode,
  redeemLinkCode: service.redeemLinkCode,
  getLinkFor: service.getLinkFor,
  removeLink: service.removeLink,
  configureMirror: service.configureMirror,
  resolveMirrorTarget: service.resolveMirrorTarget,
  expandLinkedIds: service.expandLinkedIds,
  // T4 XP fan-out seam (awardXp consumes fanOutLinkedXp at award time)
  attachSupervisor: service.attachSupervisor,
  getTargetOutbound: service.getTargetOutbound,
  mirrorDelta: service.mirrorDelta,
  fanOutLinkedXp: service.fanOutLinkedXp,
  purgeExpiredLinkCodes: service.purgeExpiredLinkCodes,

  // exposed for tests / docs
  CODE_SWEEP_JOB,
  CODE_SWEEP_INTERVAL_MS,
  armCodeSweeper,
};
