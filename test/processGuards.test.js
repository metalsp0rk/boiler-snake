/**
 * Unit tests for src/core/lifecycle.js — the process crash net + graceful
 * shutdown module (audit 2026-10 C8/C9, issue #185).
 *
 * DETERMINISM CONTRACT (CI incident, PR #238): this file's process must never
 * reach a real `process.exit` and no drain may depend on wall-clock time.
 * Every install injects logger/exit/timer seams — the drain deadline is a
 * controllable fake timer, so the deadline test fires it by hand instead of
 * racing a real 40ms timer against the afterEach state swap. resetForTests()
 * additionally parks a no-op exit seam so a late continuation from a previous
 * test cannot terminate the test worker. Real termination (SIGTERM → exit 0,
 * fatal → exit 1, force-exit) is covered by
 * test/integration/process-lifecycle.test.js on a spawned child process.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const lifecycle = require("../src/core/lifecycle");

function makeLogger() {
  const lines = { log: [], error: [] };
  return {
    lines,
    log: (...args) => lines.log.push(args.join(" ")),
    error: (...args) => lines.error.push(args.join(" ")),
  };
}

/** Test exit seam: a callable recorder (must be THE function passed to install). */
function makeExit() {
  const calls = [];
  const fn = (code) => calls.push(code);
  fn.calls = calls;
  return fn;
}

/**
 * Controllable timer seam: runShutdown schedules exactly one deadline timer
 * per drain; nothing here touches the wall clock. `fireAll` delivers due
 * callbacks immediately (the deadline is the only timer the module arms).
 */
function makeTimers() {
  const scheduled = [];
  return {
    setTimeoutFn: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      scheduled.push(t);
      return t;
    },
    clearTimeoutFn: (id) => {
      if (!id) return;
      id.cleared = true;
      const i = scheduled.indexOf(id);
      if (i >= 0) scheduled.splice(i, 1);
    },
    fireAll() {
      const due = scheduled.splice(0, scheduled.length);
      let fired = 0;
      for (const t of due) {
        if (!t.cleared) {
          t.fn();
          fired += 1;
        }
      }
      return fired;
    },
    /** scheduled (uncleared) timers — 0 after every completed drain */
    count: () => scheduled.filter((t) => !t.cleared).length,
  };
}

/** Install guards with fully inert seams; returns { logger, exit, timers }. */
function installSeams(options = {}) {
  const logger = makeLogger();
  const exit = makeExit();
  const timers = makeTimers();
  lifecycle.installProcessGuards({
    logger,
    exit,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    ...options,
  });
  return { logger, exit, timers };
}

const SIGNALS = ["SIGTERM", "SIGINT", "unhandledRejection", "uncaughtException"];
const counts = () => Object.fromEntries(SIGNALS.map((s) => [s, process.listenerCount(s)]));

/** Wedged stop handle + its resolver. */
function wedgedHandle(name = "wedged") {
  const box = {};
  const fn = () => new Promise((resolve) => { box.release = resolve; });
  return { name, fn, box };
}

beforeEach(() => lifecycle.resetForTests());
afterEach(async () => {
  // Join any drain still in flight BEFORE swapping module state: a pending
  // handleSignal/fatal continuation must never survive into the next test
  // (this race is exactly what cancelled the file on CI).
  const active = lifecycle.getActiveShutdown();
  if (active) await active;
  lifecycle.resetForTests();
});

describe("installProcessGuards", () => {
  it("registers the crash net + signal handlers and is idempotent", () => {
    const before = counts();
    const { logger, exit, timers } = installSeams();
    assert.equal(lifecycle.isInstalled(), true);
    assert.ok(logger && exit && timers);
    assert.equal(process.listenerCount("unhandledRejection"), before.unhandledRejection + 1);
    assert.equal(process.listenerCount("uncaughtException"), before.uncaughtException + 1);
    assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM + 1);
    assert.equal(process.listenerCount("SIGINT"), before.SIGINT + 1);

    // Second boot() in the same process must not stack listeners.
    const second = lifecycle.installProcessGuards({});
    assert.equal(second.alreadyInstalled, true);
    assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM + 1);

    lifecycle.disposeProcessGuards();
    assert.equal(lifecycle.isInstalled(), false);
    assert.deepEqual(counts(), before, "dispose removes exactly what install added");
  });

  it("rejects non-function seams loudly (a typo must not silently arm the real process.exit)", () => {
    assert.throws(
      () => lifecycle.installProcessGuards({ exit: { calls: [] } }),
      /options\.exit must be a function/,
    );
    assert.throws(
      () => lifecycle.installProcessGuards({ setTimeoutFn: "nope" }),
      /options\.setTimeoutFn must be a function/,
    );
    assert.equal(lifecycle.isInstalled(), false, "a rejected install stays uninstalled");
  });

  it("getHandlers exposes the crash-net handlers for direct invocation", () => {
    installSeams();
    const handlers = lifecycle.getHandlers();
    assert.equal(typeof handlers.unhandledRejection, "function");
    assert.equal(typeof handlers.uncaughtException, "function");
    lifecycle.disposeProcessGuards();
  });

  it("triggerSignal only fires installed signals", () => {
    assert.equal(lifecycle.triggerSignal("SIGTERM"), false, "not installed → false");
    lifecycle.installProcessGuards({
      signals: ["SIGTERM"],
      logger: makeLogger(),
      exit: makeExit(),
    });
    assert.equal(lifecycle.triggerSignal("SIGHUP"), false, "not in the signal list → false");
    lifecycle.disposeProcessGuards();
  });
});

describe("unhandledRejection net (C8)", () => {
  it("logs the specific cause with context and never exits", () => {
    const { logger, exit } = installSeams();

    lifecycle.getHandlers().unhandledRejection(new Error("escaped boom"));

    assert.deepEqual(exit.calls, [], "rejections are logged, never fatal");
    assert.ok(
      logger.lines.error.some(
        (l) => l.includes("[process] unhandledRejection") && l.includes("escaped boom"),
      ),
      `expected a specific unhandledRejection log, got: ${JSON.stringify(logger.lines.error)}`,
    );
    lifecycle.disposeProcessGuards();
  });

  it("survives a non-Error rejection reason (never dies inside the net)", () => {
    const { logger, exit } = installSeams();

    lifecycle.getHandlers().unhandledRejection("string reason");
    lifecycle.getHandlers().unhandledRejection(undefined);

    assert.deepEqual(exit.calls, []);
    assert.ok(logger.lines.error.some((l) => l.includes("string reason")));
    lifecycle.disposeProcessGuards();
  });
});

describe("uncaughtException net (C8, documented: drain then exit 1)", () => {
  it("logs, drains stop handles, then exits 1 for the supervisor", async () => {
    const order = [];
    lifecycle.registerShutdownHandle("a", () => order.push("a"));
    lifecycle.registerShutdownHandle("b", () => order.push("b"));
    const { logger, exit, timers } = installSeams();

    lifecycle.getHandlers().uncaughtException(new Error("sync invariant broken"));
    const result = await lifecycle.getActiveShutdown();

    assert.ok(
      logger.lines.error.some(
        (l) => l.includes("[process] uncaughtException") && l.includes("sync invariant broken"),
      ),
    );
    assert.deepEqual(order, ["b", "a"], "handles drain LIFO");
    assert.deepEqual(exit.calls, [1], "fatal path always exits 1");
    assert.equal(result.reason, "uncaughtException");
    assert.equal(timers.count(), 0, "the deadline timer is cleared by the completed drain");
    lifecycle.disposeProcessGuards();
  });

  it("exits immediately when a fatal lands while a drain is already running", async () => {
    const { exit, timers } = installSeams({ deadlineMs: 60_000 });
    const { name, fn, box } = wedgedHandle();
    lifecycle.registerShutdownHandle(name, fn);

    lifecycle.triggerSignal("SIGTERM");
    lifecycle.getHandlers().uncaughtException(new Error("mid-drain fatal"));
    assert.deepEqual(exit.calls, [1], "second fatal forces exit without waiting");

    box.release();
    await lifecycle.getActiveShutdown();
    // The original signal drain completes afterwards and also records (in a
    // real process the forced exit above would already be terminal).
    assert.deepEqual(exit.calls, [1, 0]);
    assert.equal(timers.count(), 0);
    lifecycle.disposeProcessGuards();
  });

  it("a mid-drain state swap must never reach the REAL process.exit (CI regression)", async () => {
    // Reproduces the PR #238 cancellation shape: signal starts a wedged
    // drain, the NEXT test's beforeEach resets the module state mid-drain,
    // then the wedged handle resolves and the stale continuation calls
    // state.exit. resetForTests parks a no-op exit exactly for this. If the
    // module ever swaps process.exit back in, THIS worker dies mid-file.
    const { exit } = installSeams({ deadlineMs: 60_000 });
    const { name, fn, box } = wedgedHandle();
    lifecycle.registerShutdownHandle(name, fn);

    lifecycle.triggerSignal("SIGTERM");
    lifecycle.resetForTests(); // the beforeEach of the next test lands mid-drain
    // The stale continuation now runs against post-reset state — it may log
    // through the console logger; keep this quiet so nothing leaks into TAP.
    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      box.release(); // stale drain resolves AFTER the reset
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    assert.deepEqual(exit.calls, [], "the stale continuation hit the no-op seam");
    assert.equal(lifecycle.isInstalled(), false);
    // (No timers.count() check here: post-reset the stale drain clears
    // through the NEW timer seam — the captured fake timer object is inert
    // either way. The value of this test is that the worker kept running.)
    // If we are still executing: the worker survived. That is the assertion.
  });
});

describe("graceful shutdown drain (C9)", () => {
  it("SIGTERM drains sequentially LIFO and exits 0", async () => {
    const order = [];
    lifecycle.registerShutdownHandle("first", () => order.push("first"));
    lifecycle.registerShutdownHandle("second", async () => {
      await null;
      order.push("second");
    });
    const { logger, exit, timers } = installSeams();

    assert.equal(lifecycle.triggerSignal("SIGTERM"), true);
    const result = await lifecycle.getActiveShutdown();

    assert.deepEqual(order, ["second", "first"]);
    assert.deepEqual(exit.calls, [0], "clean drain exits 0");
    assert.ok(logger.lines.log.some((l) => l.includes("[shutdown] signal SIGTERM: draining 2")));
    assert.ok(logger.lines.log.some((l) => l.includes("drain complete")));
    assert.equal(result.timedOut, false);
    assert.equal(timers.count(), 0, "completed drain clears its deadline timer");
    lifecycle.disposeProcessGuards();
  });

  it("SIGINT works too", async () => {
    const { exit } = installSeams();
    assert.equal(lifecycle.triggerSignal("SIGINT"), true);
    await lifecycle.getActiveShutdown();
    assert.deepEqual(exit.calls, [0]);
    lifecycle.disposeProcessGuards();
  });

  it("a failing handle is logged with its cause, the drain continues, partials are reported", async () => {
    const ran = [];
    lifecycle.registerShutdownHandle("good", () => ran.push("good"));
    lifecycle.registerShutdownHandle("bad", () => {
      throw new Error("SQLITE_FULL: disk full");
    });
    const { logger, exit } = installSeams();

    lifecycle.triggerSignal("SIGTERM");
    const result = await lifecycle.getActiveShutdown();

    assert.deepEqual(ran, ["good"], "later handles still run");
    assert.ok(
      logger.lines.error.some(
        (l) => l.includes("[shutdown] bad stop failed:") && l.includes("SQLITE_FULL"),
      ),
    );
    assert.deepEqual(result.failed, ["bad"]);
    assert.deepEqual(exit.calls, [0], "drained process exits cleanly, failures are logged");
    lifecycle.disposeProcessGuards();
  });

  it("deadline: a wedged handle logs the stuck names and forces exit code 1", async () => {
    const { logger, exit, timers } = installSeams({ deadlineMs: 40 });
    const { name, fn, box } = wedgedHandle();
    lifecycle.registerShutdownHandle(name, fn);
    lifecycle.registerShutdownHandle("quick", () => {});

    lifecycle.triggerSignal("SIGTERM");
    // NO wall clock: fire the scheduled deadline by hand — fully
    // deterministic on any runner load.
    assert.equal(timers.count(), 1, "runShutdown armed exactly one deadline timer");
    assert.equal(timers.fireAll(), 1, "the deadline callback fires once");

    const result = await lifecycle.getActiveShutdown();
    assert.equal(result.timedOut, true);
    assert.ok(
      logger.lines.error.some(
        (l) => l.includes("drain deadline exceeded") && l.includes("wedged"),
      ),
    );
    assert.deepEqual(exit.calls, [1]);

    box.release(); // let the wedged stop fn settle (no continuations left)
    lifecycle.disposeProcessGuards();
  });

  it("second signal while draining forces an immediate exit", async () => {
    const { logger, exit, timers } = installSeams({ deadlineMs: 60_000 });
    const { name, fn, box } = wedgedHandle();
    lifecycle.registerShutdownHandle(name, fn);

    lifecycle.triggerSignal("SIGTERM");
    lifecycle.triggerSignal("SIGINT"); // operator presses again — force

    assert.equal(exit.calls[0], 1, "forced exit happens without waiting for the drain");
    assert.ok(
      logger.lines.error.some((l) => l.includes("second SIGINT") && l.includes("forcing immediate exit")),
    );

    box.release();
    await lifecycle.getActiveShutdown();
    assert.deepEqual(exit.calls, [1, 0], "forced exit first; the late drain records after");
    assert.equal(timers.count(), 0);
    lifecycle.disposeProcessGuards();
  });

  it("runShutdown is idempotent — concurrent callers join the same drain", async () => {
    const { timers } = installSeams();
    const first = lifecycle.runShutdown({ reason: "a" });
    const second = lifecycle.runShutdown({ reason: "b" });
    assert.equal(first, second);
    const result = await first;
    assert.equal(result.reason, "a");
    assert.equal(timers.count(), 0);
    lifecycle.disposeProcessGuards();
  });
});

describe("registerShutdownHandle", () => {
  it("validates arguments", () => {
    assert.throws(() => lifecycle.registerShutdownHandle(null, () => {}), /name is required/);
    assert.throws(() => lifecycle.registerShutdownHandle("x", 42), /stop function is required for x/);
  });

  it("re-registering a name replaces the handle (single entry)", () => {
    lifecycle.registerShutdownHandle("dup", () => {});
    lifecycle.registerShutdownHandle("other", () => {});
    lifecycle.registerShutdownHandle("dup", () => {});
    assert.deepEqual(lifecycle.shutdownHandleNames(), ["other", "dup"]);
  });

  it("the returned unregister is name-identity safe", async () => {
    const ran = [];
    const unregister = lifecycle.registerShutdownHandle("job", () => ran.push("old"));
    lifecycle.registerShutdownHandle("job", () => ran.push("new"));
    unregister(); // must NOT drop the replacement
    installSeams();
    await lifecycle.runShutdown({ reason: "test" });
    assert.deepEqual(ran, ["new"]);
    assert.deepEqual(lifecycle.shutdownHandleNames(), ["job"]);

    assert.equal(lifecycle.unregisterShutdownHandle("job"), true);
    assert.equal(lifecycle.unregisterShutdownHandle("job"), false);
    lifecycle.disposeProcessGuards();
  });
});

describe("drainAndExit (terminal boot outcomes — issue #190 / audit C9)", () => {
  it("drains handles (LIFO) first, then exits via the seam with the explicit code", async () => {
    const { logger, exit, timers } = installSeams();
    const order = [];
    lifecycle.registerShutdownHandle("endpoints", () => order.push("endpoints"));
    lifecycle.registerShutdownHandle("scheduler", () => order.push("scheduler"));

    const result = await lifecycle.drainAndExit({
      reason: "boot: every configured endpoint failed",
      exitCode: 1,
    });

    assert.deepEqual(order, ["scheduler", "endpoints"], "drain runs BEFORE the exit, LIFO");
    assert.deepEqual(exit.calls, [1], "exit goes through the injectable seam (never process.exit in-suite)");
    assert.equal(result.timedOut, false);
    assert.ok(
      logger.lines.log.some(
        (l) =>
          l.includes("[shutdown] boot: every configured endpoint failed: draining 2 shutdown handle(s)"),
      ),
    );
    assert.equal(timers.count(), 0, "the drain deadline is released");
    lifecycle.disposeProcessGuards();
  });

  it("defaults to exit code 1 even after a clean drain (boot-fatal stays non-zero)", async () => {
    const { exit } = installSeams();
    const result = await lifecycle.drainAndExit({ reason: "boot: all failed" });
    assert.equal(result.exitCode, 0, "the DRAIN ran clean (signal-style code)…");
    assert.deepEqual(exit.calls, [1], "…but the caller's terminal code wins");
    lifecycle.disposeProcessGuards();
  });

  it("joins an in-flight drain (idempotent) and still exits", async () => {
    const { exit } = installSeams({ deadlineMs: 60_000 });
    const { name, fn, box } = wedgedHandle();
    lifecycle.registerShutdownHandle(name, fn);

    const first = lifecycle.runShutdown({ reason: "signal SIGTERM" });
    const second = lifecycle.drainAndExit({ reason: "boot: all failed", exitCode: 1 });
    assert.equal(lifecycle.getActiveShutdown(), first, "the existing drain is joined, not restarted");

    box.release();
    const result = await second;
    assert.equal(result.reason, "signal SIGTERM", "joined the first drain's reason");
    assert.deepEqual(exit.calls, [1], "exit fires once the joined drain settles");
    lifecycle.disposeProcessGuards();
  });
});
