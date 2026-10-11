/**
 * Unit tests for src/core/lifecycle.js — the process crash net + graceful
 * shutdown module (audit 2026-10 C8/C9, issue #185).
 *
 * Everything is exercised through the injected seams (logger/exit/triggerSignal),
 * so no test here installs listeners that survive its own file, sends real
 * signals, or exits the test process. Real-process behavior (escaped
 * rejection survival, SIGTERM drain → exit 0) is covered by
 * test/integration/process-lifecycle.test.js spawning a child fixture.
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

const SIGNALS = ["SIGTERM", "SIGINT", "unhandledRejection", "uncaughtException"];
const counts = () => Object.fromEntries(SIGNALS.map((s) => [s, process.listenerCount(s)]));

describe("installProcessGuards", () => {
  beforeEach(() => lifecycle.resetForTests());
  afterEach(() => lifecycle.resetForTests());

  it("registers the crash net + signal handlers and is idempotent", () => {
    const before = counts();
    const { alreadyInstalled } = lifecycle.installProcessGuards({
      logger: makeLogger(),
      exit: makeExit(),
    });
    assert.equal(alreadyInstalled, false);
    assert.equal(lifecycle.isInstalled(), true);
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

  it("getHandlers exposes the crash-net handlers for direct invocation", () => {
    lifecycle.installProcessGuards({ logger: makeLogger(), exit: makeExit() });
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
  beforeEach(() => lifecycle.resetForTests());
  afterEach(() => lifecycle.resetForTests());

  it("logs the specific cause with context and never exits", () => {
    const logger = makeLogger();
    const exit = makeExit();
    lifecycle.installProcessGuards({ logger, exit });

    lifecycle.getHandlers().unhandledRejection(new Error("escaped boom"));

    assert.equal(exit.calls.length, 0, "rejections are logged, never fatal");
    assert.ok(
      logger.lines.error.some(
        (l) => l.includes("[process] unhandledRejection") && l.includes("escaped boom"),
      ),
      `expected a specific unhandledRejection log, got: ${JSON.stringify(logger.lines.error)}`,
    );
    lifecycle.disposeProcessGuards();
  });

  it("survives a non-Error rejection reason (never dies inside the net)", () => {
    const logger = makeLogger();
    const exit = makeExit();
    lifecycle.installProcessGuards({ logger, exit });

    lifecycle.getHandlers().unhandledRejection("string reason");
    lifecycle.getHandlers().unhandledRejection(undefined);

    assert.equal(exit.calls.length, 0);
    assert.ok(logger.lines.error.some((l) => l.includes("string reason")));
    lifecycle.disposeProcessGuards();
  });
});

describe("uncaughtException net (C8, documented: drain then exit 1)", () => {
  beforeEach(() => lifecycle.resetForTests());
  afterEach(() => lifecycle.resetForTests());

  it("logs, drains stop handles, then exits 1 for the supervisor", async () => {
    const logger = makeLogger();
    const exit = makeExit();
    const order = [];
    lifecycle.registerShutdownHandle("a", () => order.push("a"));
    lifecycle.registerShutdownHandle("b", () => order.push("b"));
    lifecycle.installProcessGuards({ logger, exit });

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
    lifecycle.disposeProcessGuards();
  });

  it("exits immediately when a fatal lands while a drain is already running", async () => {
    const logger = makeLogger();
    const exit = makeExit();
    let release;
    lifecycle.registerShutdownHandle(
      "wedged",
      () => new Promise((resolve) => { release = resolve; }),
    );
    lifecycle.installProcessGuards({ logger, exit, deadlineMs: 60_000 });

    lifecycle.triggerSignal("SIGTERM");
    lifecycle.getHandlers().uncaughtException(new Error("mid-drain fatal"));
    assert.deepEqual(exit.calls, [1], "second fatal forces exit without waiting");

    release();
    await lifecycle.getActiveShutdown();
    lifecycle.disposeProcessGuards();
  });
});

describe("graceful shutdown drain (C9)", () => {
  beforeEach(() => lifecycle.resetForTests());
  afterEach(() => lifecycle.resetForTests());

  it("SIGTERM drains sequentially LIFO and exits 0", async () => {
    const logger = makeLogger();
    const exit = makeExit();
    const order = [];
    lifecycle.registerShutdownHandle("first", () => order.push("first"));
    lifecycle.registerShutdownHandle("second", async () => {
      await null;
      order.push("second");
    });
    lifecycle.installProcessGuards({ logger, exit });

    assert.equal(lifecycle.triggerSignal("SIGTERM"), true);
    const result = await lifecycle.getActiveShutdown();

    assert.deepEqual(order, ["second", "first"]);
    assert.deepEqual(exit.calls, [0], "clean drain exits 0");
    assert.ok(logger.lines.log.some((l) => l.includes("[shutdown] signal SIGTERM: draining 2")));
    assert.ok(logger.lines.log.some((l) => l.includes("drain complete")));
    assert.equal(result.timedOut, false);
    lifecycle.disposeProcessGuards();
  });

  it("SIGINT works too", async () => {
    const exit = makeExit();
    lifecycle.installProcessGuards({ logger: makeLogger(), exit });
    assert.equal(lifecycle.triggerSignal("SIGINT"), true);
    await lifecycle.getActiveShutdown();
    assert.deepEqual(exit.calls, [0]);
    lifecycle.disposeProcessGuards();
  });

  it("a failing handle is logged with its cause, the drain continues, partials are reported", async () => {
    const logger = makeLogger();
    const exit = makeExit();
    const ran = [];
    lifecycle.registerShutdownHandle("good", () => ran.push("good"));
    lifecycle.registerShutdownHandle("bad", () => {
      throw new Error("SQLITE_FULL: disk full");
    });
    lifecycle.installProcessGuards({ logger, exit });

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
    const logger = makeLogger();
    const exit = makeExit();
    let release;
    lifecycle.registerShutdownHandle("wedged", () => new Promise((r) => { release = r; }));
    lifecycle.registerShutdownHandle("quick", () => {});
    lifecycle.installProcessGuards({ logger, exit, deadlineMs: 40 });

    lifecycle.triggerSignal("SIGTERM");
    const result = await lifecycle.getActiveShutdown();

    assert.equal(result.timedOut, true);
    assert.ok(
      logger.lines.error.some(
        (l) => l.includes("drain deadline exceeded") && l.includes("wedged"),
      ),
    );
    assert.deepEqual(exit.calls, [1]);

    release();
    lifecycle.disposeProcessGuards();
  });

  it("second signal while draining forces an immediate exit", async () => {
    const logger = makeLogger();
    const exit = makeExit();
    let release;
    lifecycle.registerShutdownHandle(
      "wedged",
      () => new Promise((resolve) => { release = resolve; }),
    );
    lifecycle.installProcessGuards({ logger, exit, deadlineMs: 60_000 });

    lifecycle.triggerSignal("SIGTERM");
    lifecycle.triggerSignal("SIGINT"); // operator presses again — force

    assert.deepEqual(exit.calls, [1], "forced exit happens without waiting for the drain");
    assert.ok(
      logger.lines.error.some((l) => l.includes("second SIGINT") && l.includes("forcing immediate exit")),
    );

    release();
    await lifecycle.getActiveShutdown();
    lifecycle.disposeProcessGuards();
  });

  it("runShutdown is idempotent — concurrent callers join the same drain", async () => {
    lifecycle.installProcessGuards({ logger: makeLogger(), exit: makeExit() });
    const first = lifecycle.runShutdown({ reason: "a" });
    const second = lifecycle.runShutdown({ reason: "b" });
    assert.equal(first, second);
    assert.equal((await first).reason, "a");
    lifecycle.disposeProcessGuards();
  });
});

describe("registerShutdownHandle", () => {
  beforeEach(() => lifecycle.resetForTests());
  afterEach(() => lifecycle.resetForTests());

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
    lifecycle.installProcessGuards({ logger: makeLogger(), exit: makeExit() });
    await lifecycle.runShutdown({ reason: "test" });
    assert.deepEqual(ran, ["new"]);
    assert.deepEqual(lifecycle.shutdownHandleNames(), ["job"]);

    assert.equal(lifecycle.unregisterShutdownHandle("job"), true);
    assert.equal(lifecycle.unregisterShutdownHandle("job"), false);
    lifecycle.disposeProcessGuards();
  });
});
