/**
 * Boot orchestration (roadmap/fluxer.md § Boot + § Supervisor).
 *
 * One process, N endpoints: the Discord client (when DISCORD_TOKEN is set)
 * plus one handle per configured Fluxer instance. Each endpoint logs in
 * independently; one failed login never takes down the others. An INITIAL
 * Discord login rejection is TERMINAL for the Discord endpoint (audit C7,
 * issue #190): one specific fatal, the dead client is released, and the
 * feature layer arms on the surviving endpoint(s) instead of waiting on a
 * ready event that can never fire. A later gateway disconnect/reconnect
 * loop is NOT terminal (the login promise already settled). A one-shot
 * watchdog logs what the feature gate is still waiting on when it never
 * opens. The process exits non-zero ONLY when every configured endpoint
 * failed — boot reports that via `{ ok: false, exitCode: 1 }` and the entry
 * point (src/index.js) drains through core/lifecycle and exits, so tests
 * can exercise boot() safely.
 *
 * PR 7 (spec § Supervisor) is the cutover: feature hooks receive the
 * SUPERVISOR as their FIRST argument (`start(supervisor, ctx)` /
 * `registerEvents(supervisor, ctx)`), and features read the Discord client
 * from `supervisor.discord` (null when Discord is not configured).
 * `featureCtx` no longer carries a `client` property.
 */

const { Events } = require("discord.js");

const features = require("../features");
const { registerAllFeatureEvents, startAllFeatures } = require("../features/load");
const { registerOrderedPipelines } = require("../bot/pipelines");
const { handleInteraction } = require("../commands/router");
const { buildDefaultRegistry } = require("../commands/registry");
const { createClient } = require("../client");
const { getDiscordOutbound } = require("./discord/outbound");
const { getCommunityById } = require("./community");
const { parseFluxerInstances } = require("../config");
const { ensureHoneypotWarning } = require("../features/honeypot");
const { createFluxerHandle } = require("./fluxer/client");
const {
  installProcessGuards,
  registerShutdownHandle,
} = require("../core/lifecycle");
const schedulerApi = require("../core/scheduler");
const { stopMemberFetchQueue } = require("../web/services/memberFetchQueue");

/**
 * @typedef {object} Supervisor
 * @property {import("discord.js").Client|null} discord
 * @property {Map<string, object>} fluxer  // instanceKey → handle; not ClientCluster (K6)
 * @property {(communityId: number) => object|null} clientForCommunity
 * @property {(listener: (handle: object) => void) => void} [onFluxerReady]
 *   subscribe to Fluxer handles that finish connecting AFTER feature
 *   registration (the bridge DM consumer wires late-arriving handles).
 */

/**
 * Read and validate the Fluxer entries from the environment. A malformed
 * block throws (spec rule 2: never ignore a broken Fluxer block) — the
 * message is specific, and assertRuntimeEnv performs the same validation
 * earlier in src/index.js.
 *
 * @returns {Array<object>} validated entries (empty array = no Fluxer block)
 */
function readFluxerEntries() {
  const raw = process.env.FLUXER_INSTANCES;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    return parseFluxerInstances(raw);
  } catch (err) {
    console.error(`[fluxer] FLUXER_INSTANCES rejected: ${err?.message || err}`);
    throw err;
  }
}

// Feature event hooks are registered at most once per supervisor (guarded):
// the bridge's DM wiring needs registration to run on Fluxer-only boots too,
// where the Discord client never logs in (spec §10.10 — the DM connect path
// is live with or without a Discord client in the process).
const eventsRegistered = new WeakSet();

/**
 * Default feature-gate watchdog window (audit C7, issue #190): when the
 * feature layer has not armed within this window, boot logs a specific
 * warning naming what the gate is still waiting on — "features never
 * start" must never be silent again. Override with the
 * FEATURE_GATE_WATCHDOG_MS env var (0 disables the watchdog).
 */
const DEFAULT_FEATURE_GATE_WATCHDOG_MS = 120_000;

/**
 * Resolve the watchdog window: boot option first (tests inject explicit
 * values), then FEATURE_GATE_WATCHDOG_MS, then the 120s default. Anything
 * unparseable falls back to the default; 0 disables.
 *
 * @param {unknown} explicit boot({ featureGateWatchdogMs }) value
 * @returns {number} milliseconds (>= 0; 0 = watchdog disabled)
 */
function resolveFeatureGateWatchdogMs(explicit) {
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const raw = process.env.FEATURE_GATE_WATCHDOG_MS;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    console.error(
      `[boot] FEATURE_GATE_WATCHDOG_MS "${raw}" is not a number >= 0 — using the ${DEFAULT_FEATURE_GATE_WATCHDOG_MS}ms default`,
    );
  }
  return DEFAULT_FEATURE_GATE_WATCHDOG_MS;
}

function registerFeatureEventsOnce(supervisor, featureList, ctx) {
  if (eventsRegistered.has(supervisor)) return;
  eventsRegistered.add(supervisor);
  registerAllFeatureEvents(supervisor, featureList, ctx);
}

/**
 * Start every configured platform endpoint and build the supervisor.
 *
 * Feature lifecycle (spec § Boot, updated for audit C7 / issue #190):
 * features arm when at least ONE endpoint is READY. Discord fires this on
 * ClientReady; a Fluxer handle fires it whenever Discord is not live —
 * including the C7 case where the INITIAL Discord login rejected (terminal
 * for that endpoint, `supervisor.discord` back to null). With no endpoint
 * live the gate stays shut: the all-endpoints-failed outcome is owned by
 * the `{ ok: false }` report + the entry point's drain-and-exit, never by
 * a feature layer running on a dead process. `startAllFeatures` is called
 * exactly once per process.
 *
 * @param {{ registry?: object,
 *   setTimeoutFn?: (fn: Function, ms: number) => unknown,
 *   clearTimeoutFn?: (id: unknown) => void,
 *   featureGateWatchdogMs?: number }} [options] registry to share with
 *   features and prefix dispatch (defaults to buildDefaultRegistry());
 *   the timer seams + window control the feature-gate watchdog (tests
 *   inject fakes; house pattern from core/lifecycle)
 * @returns {Promise<{ ok: boolean, exitCode: number, supervisor: Supervisor }>}
 */
async function boot({
  registry,
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn = (id) => clearTimeout(id),
  featureGateWatchdogMs,
} = {}) {
  // Fail loudly on a bad seam: silently keeping the real timers here would
  // turn a test typo into a wall-clock race (same policy as lifecycle).
  if (typeof setTimeoutFn !== "function") {
    throw new TypeError("boot: options.setTimeoutFn must be a function");
  }
  if (typeof clearTimeoutFn !== "function") {
    throw new TypeError("boot: options.clearTimeoutFn must be a function");
  }
  // C8/C9 (audit §6 P0.4): process-level crash net + SIGTERM/SIGINT drain,
  // installed exactly once per process (idempotent — repeated boot() calls
  // in tests never stack listeners). See src/core/lifecycle.js for policy.
  installProcessGuards();

  const commandRegistry = registry ?? buildDefaultRegistry();
  const entries = readFluxerEntries();
  const discordToken = process.env.DISCORD_TOKEN;

  /** @type {Supervisor} */
  const supervisor = {
    discord: null,
    fluxer: new Map(),
    clientForCommunity,
  };

  // Listeners fired with each Fluxer handle that finishes connecting (the
  // bridge DM consumer attaches to late-arriving handles this way).
  const fluxerReadyListeners = [];
  supervisor.onFluxerReady = function onFluxerReady(listener) {
    if (typeof listener === "function") fluxerReadyListeners.push(listener);
  };

  // --- Graceful-shutdown handles for the endpoints (audit C9) --------------
  // Registered FIRST so the drain stops them LAST (handles drain LIFO):
  // feature-start loops (web/tickers/relay, registered in startFeaturesOnce)
  // close before the sockets they send through. Each handle reads the LIVE
  // supervisor, so handles created after boot (late Fluxer logins) are
  // covered too. Failures per handle are logged and the drain continues.
  registerShutdownHandle("fluxer", async () => {
    for (const [instanceKey, handle] of supervisor.fluxer) {
      try {
        if (typeof handle?.destroy === "function") await handle.destroy();
      } catch (err) {
        console.error(
          `[shutdown] fluxer ${instanceKey} destroy failed:`,
          err?.message || err,
        );
      }
    }
  });
  registerShutdownHandle("discord", async () => {
    const client = supervisor.discord;
    if (client && typeof client.destroy === "function") await client.destroy();
  });

  /**
   * Map a community id to the OutboundClient that can speak to it.
   * Loads the `communities` row (spec § Supervisor — the only lookup).
   * Missing client → null; callers log and skip (never throw out of a tick).
   */
  function clientForCommunity(communityId) {
    let row;
    try {
      row = getCommunityById(communityId);
    } catch (err) {
      // A bad/unknown id is a programming error: log it with the id, return
      // null, and let the caller skip (spec § Supervisor).
      console.error(
        `[boot] clientForCommunity(${communityId}) failed: ${err?.message || err}`,
      );
      return null;
    }
    if (!row) return null;
    if (row.platform === "discord") {
      return supervisor.discord ? getDiscordOutbound(supervisor.discord) : null;
    }
    const handle = supervisor.fluxer.get(row.instanceKey);
    return handle ? handle.outbound : null;
  }

  const featureCtx = {
    // PR 7 cutover (spec § Supervisor): features read the Discord client from
    // ctx.supervisor.discord — featureCtx no longer carries `client`.
    supervisor,
    registry: commandRegistry,
    ensureHoneypotWarning,
  };

  let featuresStarted = false;
  let discordReady = false;
  /** True once the Discord endpoint failed TERMINALLY for this process
   *  (initial login rejection / client construction failure — audit C7).
   *  A gateway reconnect loop after a successful login is NOT terminal. */
  let discordTerminal = false;
  /** Configured Fluxer entries whose login has not settled yet (drives the
   *  watchdog's "what am I waiting on" list). */
  let fluxerPending = entries.length;
  /** @type {unknown} pending feature-gate watchdog timer (fake-timer seam) */
  let featureGateTimer = null;

  function clearFeatureGateWatchdog() {
    if (featureGateTimer == null) return;
    const timer = featureGateTimer;
    featureGateTimer = null;
    try {
      clearTimeoutFn(timer);
    } catch (err) {
      console.error(
        `[boot] feature-gate watchdog clear failed: ${err?.message || err}`,
      );
    }
  }

  /**
   * What the feature gate is still waiting on, as human-readable parts
   * (empty when nothing is pending: every configured endpoint settled, the
   * all-endpoints-failed fatal owns that outcome instead).
   */
  function featureGateWaitsOn() {
    const waiting = [];
    if (supervisor.discord && !discordReady) {
      waiting.push("discord login/ClientReady (client constructed, not ready)");
    }
    if (fluxerPending > 0) {
      waiting.push(
        `fluxer handles (${supervisor.fluxer.size}/${entries.length} ready, ${fluxerPending} still connecting)`,
      );
    }
    return waiting;
  }

  function startFeaturesOnce() {
    if (featuresStarted) return;
    // Feature-gate contract (spec § Boot, updated for audit C7 / issue #190):
    // the layer arms when at least ONE endpoint is READY — and only when one
    // actually is. A constructed Discord client keeps ownership of the
    // trigger (ClientReady) while its login is still in flight; a Fluxer
    // handle arms the gate whenever Discord is NOT live — including the C7
    // case where the initial Discord login REJECTED: that is terminal for
    // the endpoint, the client is released and supervisor.discord returns to
    // null, so the boot proceeds exactly like a Fluxer-only one. With no
    // endpoint live (e.g. every login failed) the gate stays SHUT — arming
    // tickers/web/relay on a dead process is the C7 zombie; the
    // all-endpoints-failed report owns that outcome instead.
    if (supervisor.discord && !discordReady) return;
    if (!discordReady && supervisor.fluxer.size === 0) return;
    featuresStarted = true;
    clearFeatureGateWatchdog();
    // A Fluxer-only boot registers feature events HERE (no Discord branch ran):
    // the bridge DM consumer must exist even when Discord never logs in.
    registerFeatureEventsOnce(supervisor, features, featureCtx);
    // PR 7 cutover (spec § Supervisor): the FIRST argument is the supervisor;
    // features read the Discord client from supervisor.discord themselves.
    // Where Discord went terminal mid-boot, supervisor.discord is null and
    // load.js isolates each feature: a Discord-hard feature throws on the
    // missing client and is logged + skipped (`[features] <name>.start
    // failed:`), Fluxer-tier features arm normally.
    startAllFeatures(supervisor, features, featureCtx);
    // C9: periodic work drains BEFORE the endpoints — registered AFTER the
    // feature-start handles (which self-register their `{ stop }` loops via
    // load.js) so LIFO drains member-fetch-queue → scheduler → feature loops
    // → endpoints. scheduler.stop() covers every named job, including the
    // bridge relay tick and expiry sweeper.
    registerShutdownHandle("scheduler", () => schedulerApi.stop());
    registerShutdownHandle("member-fetch-queue", () => stopMemberFetchQueue());
  }

  /**
   * The Discord endpoint went terminal for THIS process: the INITIAL login
   * rejected (invalid token / intents rejected) or the client could not be
   * wired. Terminal ≠ process death — the surviving endpoint(s) keep the
   * bot useful (audit C7; documented decision: a dead Discord does NOT
   * exit the process, one loud specific fatal + degraded operation does).
   * Only ever called for the initial handshake: discord.js settles the
   * login promise exactly once, so a later disconnect/reconnect loop can
   * never reach this path.
   */
  async function markDiscordTerminal(cause, deadClient) {
    console.error(
      `[boot] discord login failed: ${cause} — endpoint disabled for this process; ` +
        "features arm on the surviving endpoint(s)",
    );
    discordTerminal = true;
    // Release the dead client best-effort so no internal timer/socket of
    // the failed handshake keeps the process or the drain hostage.
    try {
      if (deadClient && typeof deadClient.destroy === "function") {
        await deadClient.destroy();
      }
    } catch (err) {
      console.error(
        `[boot] discord cleanup after failed login: ${err?.message || err}`,
      );
    }
    // Back to "as if Discord were not configured" — every feature already
    // treats supervisor.discord === null as its degrade signal.
    supervisor.discord = null;
    // The gate may now open: immediately when a surviving endpoint is
    // already ready, otherwise when that endpoint's ready path fires.
    startFeaturesOnce();
  }

  /** One boolean promise per configured endpoint: true = that endpoint came up. */
  const endpointJobs = [];

  // --- Discord (identical sequence to today's src/index.js) ---
  if (discordToken) {
    let discordLogin = null;
    let client = null;
    try {
      client = createClient();
      supervisor.discord = client;
      registerFeatureEventsOnce(supervisor, features, featureCtx);
      registerOrderedPipelines(client);
      client.once(Events.ClientReady, () => {
        // Console parity with the pre-Fluxer entry point (PR 6 bundle).
        console.log(`Boiler Snake logged in as ${client.user.tag}`);
        discordReady = true;
        startFeaturesOnce();
      });
      client.on(Events.InteractionCreate, (interaction) => {
        // C8: the router already wraps every handler; this catch is the
        // last-resort net so an escaped rejection from the dispatch promise
        // is logged with the interaction's identity instead of hitting the
        // process-level net (or, pre-fix, killing the process).
        handleInteraction(interaction, featureCtx).catch((err) =>
          console.error(
            `[discord] interaction dispatch failed (${interaction?.commandName ?? interaction?.type ?? "unknown"}):`,
            err?.message || err,
          ),
        );
      });
      discordLogin = client.login(discordToken);
    } catch (err) {
      // Construction/wiring failure: terminal for the Discord endpoint
      // (same contract as a rejected initial login — audit C7). Fluxer
      // endpoints (if any) keep running; the gate re-evaluates now that
      // supervisor.discord is null.
      console.error(`[discord] client setup failed: ${err?.message || err}`);
      supervisor.discord = null;
      discordTerminal = true;
      startFeaturesOnce();
    }
    endpointJobs.push(
      discordLogin
        ? discordLogin
            .then(() => true)
            // C7 (issue #190): an INITIAL login rejection is a HANDLED,
            // terminal endpoint failure with specific semantics — never an
            // escaped unhandledRejection, and never a process kill by the
            // crash net. The endpoint is disabled for this process; the
            // surviving endpoint(s) carry the feature layer.
            .catch(async (err) => {
              await markDiscordTerminal(err?.message || err, client);
              return false;
            })
        : Promise.resolve(false),
    );
  }

  // --- Fluxer: every entry logs in concurrently (Promise.allSettled-style;
  //     createFluxerHandle resolves null instead of rejecting) ---
  for (const entry of entries) {
    endpointJobs.push(
      createFluxerHandle(entry, {
        pipelineHooks: { registry: commandRegistry, supervisor },
      })
        .then((handle) => {
          fluxerPending -= 1;
          if (!handle) return false;
          supervisor.fluxer.set(handle.instanceKey, handle);
          // Fire Fluxer-ready subscribers (bridge DM wiring for handles that
          // connect after feature registration — spec §10.10 consumer attach).
          for (const listener of fluxerReadyListeners) {
            try {
              listener(handle);
            } catch (err) {
              console.error(
                `[boot] onFluxerReady listener failed for ${handle.instanceKey}:`,
                err?.message || err,
              );
            }
          }
          // Every boot where Discord is not live (Fluxer-only, or the C7
          // case where Discord login went terminal) reaches "at least one
          // endpoint ready" here.
          startFeaturesOnce();
          return true;
        })
        .catch((err) => {
          fluxerPending -= 1;
          // createFluxerHandle swallows its own failures; this is a last-
          // resort net so one broken handle can never reject the batch.
          console.error(
            `[fluxer] ${entry?.instanceKey || entry?.origin || "unknown"} boot failed: ${err?.message || err}`,
          );
          return false;
        }),
    );
  }

  // C7 watchdog (issue #190): "features never start" must never be silent.
  // One-shot: when the window elapses with the gate still shut, log exactly
  // WHAT it is waiting on (login pending? handles still connecting?). The
  // timer is unref'd — it never holds a healthy process or a finished test
  // worker open — and cleared the moment the gate opens or the
  // all-endpoints-failed fatal (which owns that outcome) logs.
  const watchdogMs = resolveFeatureGateWatchdogMs(featureGateWatchdogMs);
  if (watchdogMs > 0 && endpointJobs.length > 0) {
    try {
      featureGateTimer = setTimeoutFn(() => {
        featureGateTimer = null;
        const waiting = featureGateWaitsOn();
        if (featuresStarted || waiting.length === 0) return;
        console.warn(
          `[boot] watchdog: feature layer has not started after ${watchdogMs}ms — still waiting on: ${waiting.join("; ")}`,
        );
      }, watchdogMs);
      if (
        featureGateTimer &&
        typeof featureGateTimer.unref === "function"
      ) {
        featureGateTimer.unref();
      }
    } catch (err) {
      // A broken timer seam must not take the boot down; the endpoints and
      // the gate itself are already wired — only the safety net is lost.
      console.error(
        `[boot] could not arm feature-gate watchdog: ${err?.message || err}`,
      );
    }
  }

  const results = await Promise.all(endpointJobs);
  const anyReady = results.some(Boolean);

  if (!anyReady) {
    // Spec: "The process exits only when every configured endpoint failed."
    // The ENTRY POINT performs the exit (through the lifecycle drain);
    // boot just reports it (test-safe). The gate provably never opens here
    // (no endpoint ever went ready), so the watchdog defers to THIS fatal.
    clearFeatureGateWatchdog();
    console.error(
      `[boot] every configured endpoint failed (${results.length} endpoint(s)) — ` +
        "nothing is connected; the feature layer was never armed" +
        (discordTerminal
          ? " (discord was disabled by a terminal login failure — check DISCORD_TOKEN)"
          : ""),
    );
  }

  return {
    ok: anyReady,
    exitCode: anyReady ? 0 : 1,
    supervisor,
  };
}

module.exports = {
  boot,
  resolveFeatureGateWatchdogMs,
  DEFAULT_FEATURE_GATE_WATCHDOG_MS,
};
