/**
 * Process lifecycle: crash net + graceful shutdown (audit 2026-10 C8/C9,
 * roadmap/audit-2026-10.md §6 P0.4).
 *
 * C8 — crash net. Before this module the process had ZERO
 * `unhandledRejection` / `uncaughtException` handlers, so one escaped async
 * rejection terminated the bot on Node ≥15 (and the 2026-10-01 gateway
 * incident — see core/gatewayPayloadGuard.js — showed how much a single
 * crash costs: every connection and feature dies with it). Policy here:
 *
 *  - `unhandledRejection`: LOG ONLY, never exit. A rejection nobody awaited
 *    means ONE dropped async operation; the synchronous invariants of the
 *    process are intact, and the specific cause is logged with context per
 *    AGENTS.md (never silent). The named dispatch sites (boot.js,
 *    bot/pipelines.js) each own their own `.catch()` — this net is the
 *    last-resort backstop for async work that predates this module or slips
 *    through review.
 *  - `uncaughtException`: LOG, DRAIN, EXIT 1. A synchronous throw means
 *    invariants may be broken mid-statement (Node's own guidance: continuing
 *    is unsupported), so the process exits for the supervisor — the Docker
 *    service runs `restart: unless-stopped` — but it exits through the SAME
 *    drain as SIGTERM so the HTTP listener, tickers and gateway sockets
 *    close cleanly and the WAL checkpoints instead of being hard-cut.
 *    Documented decision (issue #185): continuing after a sync throw is
 *    unsupported by Node; the supervisor restarts the process. `runShutdown`
 *    is shared either way.
 *
 * C9 — graceful shutdown. Features/endpoints register named stop handles
 * (`registerShutdownHandle`); SIGTERM/SIGINT drain them in REVERSE
 * registration order (newest subsystem first — LIFO), sequentially, each
 * awaited, each failure logged and the drain continued (partial failures
 * are REPORTED, never swallowed). An overall deadline keeps a wedged stop
 * handle from hanging the container past Docker's 10s grace; a second
 * signal forces an immediate exit. The drain is idempotent: one signal
 * drains, one drain exits.
 */

/** Signals that trigger the drain (docker stop sends SIGTERM). */
const DEFAULT_SHUTDOWN_SIGNALS = Object.freeze(["SIGTERM", "SIGINT"]);

/**
 * Overall drain deadline. `docker stop` kills the container after 10s, so
 * the drain must finish (and exit) inside that window with headroom.
 */
const DEFAULT_DRAIN_DEADLINE_MS = 8000;

const state = {
  installed: false,
  signals: [...DEFAULT_SHUTDOWN_SIGNALS],
  deadlineMs: DEFAULT_DRAIN_DEADLINE_MS,
  logger: console,
  /** @type {(code: number) => void} */
  exit: (code) => process.exit(code),
  /** Timer seams for the drain deadline: tests inject controllable fakes so
   *  no drain ever depends on wall-clock (CI determinism, see resetForTests). */
  setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn: (id) => clearTimeout(id),
  /** @type {Array<[string, () => void]>} installed signal listeners */
  listeners: [],
  /** @type {{unhandledRejection: Function, uncaughtException: Function}|null} */
  crashHandlers: null,
  /** @type {Map<string, () => (void|Promise<void>)} name → stop fn */
  handles: new Map(),
  /** @type {Promise<object>|null} in-flight/completed drain (idempotency) */
  draining: null,
};

/**
 * Specific, always-stringifiable error rendering for the crash net: the
 * process must never die a second time inside its own error handler.
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  try {
    if (err instanceof Error) return err.stack || err.message;
    if (err == null || typeof err !== "object") return String(err);
    return err?.stack || err?.message || JSON.stringify(err);
  } catch {
    return "[unstringifiable error]";
  }
}

/**
 * Register a named stop handle for the shutdown drain. Handles run in
 * REVERSE registration order, so register long-lived infrastructure first
 * and dependent/short-lived subsystems later (they get stopped first).
 * Re-registering a name replaces its handle.
 *
 * @param {string} name stable descriptor used in `[shutdown] <name> ...` logs
 * @param {() => (void|Promise<void>)} stop sync or async; awaited
 * @returns {() => void} unregister (no-op if the name was replaced)
 */
function registerShutdownHandle(name, stop) {
  if (!name || typeof name !== "string") {
    throw new Error("registerShutdownHandle: name is required");
  }
  if (typeof stop !== "function") {
    throw new Error(`registerShutdownHandle: stop function is required for ${name}`);
  }
  // delete-then-set: the replacement re-takes the newest slot in LIFO order.
  state.handles.delete(name);
  state.handles.set(name, stop);
  return function unregister() {
    if (state.handles.get(name) === stop) state.handles.delete(name);
  };
}

/**
 * Remove a stop handle by name.
 * @param {string} name
 * @returns {boolean} true when a handle was removed
 */
function unregisterShutdownHandle(name) {
  return state.handles.delete(name);
}

/** @returns {string[]} registered handle names, registration order */
function shutdownHandleNames() {
  return [...state.handles.keys()];
}

/**
 * Drain every registered stop handle (LIFO), sequentially, guarded:
 *  - a throwing/rejecting handle is logged `[shutdown] <name> stop failed:`
 *    with the cause and the drain CONTINUES; failures are reported in the
 *    result (AGENTS.md rule 5: partial failures report partials);
 *  - the whole drain races a deadline; on timeout the still-running handle
 *    names are logged and the result asks the caller to force exit (code 1).
 *
 * Idempotent: concurrent/late calls join the first drain. This function
 * NEVER exits by itself — the signal path and the fatal path decide.
 *
 * @param {{ reason?: string }} [options]
 * @returns {Promise<{reason: string, failed: string[], timedOut: boolean, exitCode: number, elapsedMs: number}>}
 */
function runShutdown({ reason = "manual" } = {}) {
  if (state.draining) return state.draining;

  const startedAt = Date.now();
  const names = [...state.handles.keys()].reverse();
  const failed = [];
  const finished = new Set();
  state.logger.log(
    `[shutdown] ${reason}: draining ${names.length} shutdown handle(s): ${names.join(", ")}`,
  );

  const drain = (async () => {
    for (const name of names) {
      const stop = state.handles.get(name);
      if (!stop) {
        finished.add(name);
        continue;
      }
      try {
        await stop();
      } catch (err) {
        failed.push(name);
        state.logger.error(
          `[shutdown] ${name} stop failed:`,
          err?.message || err,
        );
      }
      finished.add(name);
    }
  })();

  /** @type {unknown} */
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = state.setTimeoutFn(() => resolve("timeout"), state.deadlineMs);
    // The race never needs the timer to hold the loop open on its own.
    if (timer && typeof timer.unref === "function") timer.unref();
  });

  state.draining = Promise.race([drain.then(() => "done"), deadline]).then(
    (outcome) => {
      if (timer != null) state.clearTimeoutFn(timer);
      timer = null;
      const elapsedMs = Date.now() - startedAt;
      if (outcome === "timeout") {
        const stuck = names.filter((n) => !finished.has(n));
        state.logger.error(
          `[shutdown] drain deadline exceeded after ${elapsedMs}ms ` +
            `(still running: ${stuck.join(", ") || "unknown"}) — forcing exit`,
        );
        return { reason, failed, timedOut: true, exitCode: 1, elapsedMs };
      }
      if (failed.length) {
        state.logger.error(
          `[shutdown] drain complete in ${elapsedMs}ms with ${failed.length} failed handle(s): ${failed.join(", ")}`,
        );
      } else {
        state.logger.log(`[shutdown] drain complete in ${elapsedMs}ms`);
      }
      return { reason, failed, timedOut: false, exitCode: 0, elapsedMs };
    },
    // Only reachable if the logger itself throws — never let the drain's own
    // bookkeeping escape as an unhandled rejection (AGENTS.md rule 1).
    (err) => {
      if (timer != null) state.clearTimeoutFn(timer);
      timer = null;
      state.logger.error("[shutdown] drain bookkeeping failed:", err?.message || err);
      return { reason, failed, timedOut: false, exitCode: 0, elapsedMs: Date.now() - startedAt };
    },
  );
  return state.draining;
}

/** @returns {Promise<object>|null} the active/completed drain result promise */
function getActiveShutdown() {
  return state.draining;
}

/**
 * SIGTERM/SIGINT entry point. First signal drains then exits with the drain's
 * exit code (clean drain = 0, deadline exceeded = 1). A second signal while
 * draining forces an immediate exit(1) — an operator double-press means
 * "stop now", not "wait for the deadline".
 *
 * @param {string} signal
 */
function handleSignal(signal) {
  if (state.draining) {
    state.logger.error(
      `[shutdown] second ${signal} received while draining — forcing immediate exit`,
    );
    state.exit(1);
    return;
  }
  runShutdown({ reason: `signal ${signal}` })
    .then((result) => state.exit(result.exitCode))
    .catch((err) => {
      state.logger.error("[shutdown] drain failed:", err?.message || err);
      state.exit(1);
    });
}

// --- crash net handlers (stable identities so install/dispose pair cleanly) ---

function onUnhandledRejection(reason) {
  try {
    state.logger.error(
      "[process] unhandledRejection (logged, process kept alive):",
      describeError(reason),
    );
  } catch {
    // The logger itself failed — there is nowhere left to report; the
    // process stays alive, which is the point of this handler.
  }
}

function onUncaughtException(err) {
  try {
    state.logger.error(
      "[process] uncaughtException (draining, then exiting for supervisor restart):",
      describeError(err),
    );
  } catch {
    /* best effort — never die inside the net */
  }
  if (state.draining) {
    // Already going down (signal drain or an earlier fatal): get out now.
    state.exit(1);
    return;
  }
  runShutdown({ reason: "uncaughtException" })
    .then(() => state.exit(1))
    .catch(() => state.exit(1));
}

/**
 * Install the crash net + shutdown signals (idempotent — the FIRST install
 * configures; later calls no-op so repeated boot()s never stack listeners).
 *
 * @param {{
 *   signals?: string[],
 *   deadlineMs?: number,
 *   logger?: { log: Function, error: Function },
 *   exit?: (code: number) => void,
 *   setTimeoutFn?: (fn: Function, ms: number) => unknown,
 *   clearTimeoutFn?: (id: unknown) => void,
 * }} [options] seams for tests (logger/exit/timers injected in unit tests)
 * @returns {{ alreadyInstalled: boolean }}
 */
function installProcessGuards(options = {}) {
  if (state.installed) return { alreadyInstalled: true };

  if (Array.isArray(options.signals) && options.signals.length > 0) {
    state.signals = [...options.signals];
  }
  if (Number.isFinite(options.deadlineMs) && options.deadlineMs > 0) {
    state.deadlineMs = options.deadlineMs;
  }
  if (options.logger) state.logger = options.logger;
  // Fail loudly on a bad seam: silently keeping the real process.exit here
  // would turn a test typo into an unexplained mid-suite process kill.
  if (options.exit !== undefined && typeof options.exit !== "function") {
    throw new TypeError("installProcessGuards: options.exit must be a function");
  }
  if (typeof options.exit === "function") state.exit = options.exit;
  for (const seam of ["setTimeoutFn", "clearTimeoutFn"]) {
    if (options[seam] !== undefined && typeof options[seam] !== "function") {
      throw new TypeError(`installProcessGuards: options.${seam} must be a function`);
    }
    if (typeof options[seam] === "function") state[seam] = options[seam];
  }

  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);
  state.crashHandlers = {
    unhandledRejection: onUnhandledRejection,
    uncaughtException: onUncaughtException,
  };

  state.listeners = state.signals.map((signal) => {
    const handler = () => handleSignal(signal);
    process.on(signal, handler);
    return [signal, handler];
  });

  state.installed = true;
  state.draining = null;
  return { alreadyInstalled: false };
}

/** Remove the crash-net + signal listeners (handles and drain state kept). */
function disposeProcessGuards() {
  if (state.crashHandlers) {
    process.off("unhandledRejection", state.crashHandlers.unhandledRejection);
    process.off("uncaughtException", state.crashHandlers.uncaughtException);
    state.crashHandlers = null;
  }
  for (const [signal, handler] of state.listeners) {
    process.off(signal, handler);
  }
  state.listeners = [];
  state.installed = false;
  state.draining = null;
}

/** Full reset (tests only): dispose listeners AND drop all stop handles. */
function resetForTests() {
  disposeProcessGuards();
  state.handles.clear();
  state.signals = [...DEFAULT_SHUTDOWN_SIGNALS];
  state.deadlineMs = DEFAULT_DRAIN_DEADLINE_MS;
  state.logger = console;
  // Test-safe default exit — deliberately NOT process.exit. A late drain
  // continuation (handleSignal's `.then(state.exit)` on a promise an earlier
  // test left pending) can fire AFTER the next beforeEach/reset swapped the
  // module state; with the real process.exit that race killed the whole
  // test-file worker mid-suite on CI. Production keeps the module-init
  // process.exit default — boot() installs with no options and never resets.
  state.exit = () => {};
  state.setTimeoutFn = (fn, ms) => setTimeout(fn, ms);
  state.clearTimeoutFn = (id) => clearTimeout(id);
}

/** @returns {boolean} true while the guards are installed */
function isInstalled() {
  return state.installed;
}

/**
 * Invoke the installed signal handler directly (tests — no real signals).
 * @param {string} signal must be one of the installed signals
 * @returns {boolean} false when no handler is installed for that signal
 */
function triggerSignal(signal) {
  const entry = state.listeners.find(([sig]) => sig === signal);
  if (!entry) return false;
  entry[1]();
  return true;
}

module.exports = {
  DEFAULT_SHUTDOWN_SIGNALS,
  DEFAULT_DRAIN_DEADLINE_MS,
  installProcessGuards,
  disposeProcessGuards,
  isInstalled,
  getHandlers: () => state.crashHandlers,
  triggerSignal,
  registerShutdownHandle,
  unregisterShutdownHandle,
  shutdownHandleNames,
  runShutdown,
  getActiveShutdown,
  resetForTests,
};
