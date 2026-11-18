const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  createScheduler,
  msToNextBoundary,
} = require("../src/core/scheduler");

function fakeTimers() {
  const timeouts = [];
  const intervals = [];
  let nextId = 1;
  const setTimeoutFn = (fn, ms) => {
    const id = nextId++;
    timeouts.push({ id, fn, ms });
    return { id, unref() {} };
  };
  const clearTimeoutFn = (handle) => {
    const id = handle?.id ?? handle;
    const i = timeouts.findIndex((t) => t.id === id);
    if (i >= 0) timeouts.splice(i, 1);
  };
  const setIntervalFn = (fn, ms) => {
    const id = nextId++;
    intervals.push({ id, fn, ms });
    return { id, unref() {} };
  };
  const clearIntervalFn = (handle) => {
    const id = handle?.id ?? handle;
    const i = intervals.findIndex((t) => t.id === id);
    if (i >= 0) intervals.splice(i, 1);
  };
  return { timeouts, intervals, setTimeoutFn, clearTimeoutFn, setIntervalFn, clearIntervalFn };
}

function settle() {
  return new Promise((r) => setImmediate(r));
}

describe("msToNextBoundary", () => {
  it("waits a full interval on an exact boundary", () => {
    assert.equal(msToNextBoundary(60_000, 120_000), 60_000);
  });

  it("returns the remainder otherwise", () => {
    assert.equal(msToNextBoundary(60_000, 120_001), 59_999);
  });

  it("returns 0 for non-positive intervals", () => {
    assert.equal(msToNextBoundary(0, 1), 0);
    assert.equal(msToNextBoundary(-5, 1), 0);
  });
});

describe("scheduler", () => {
  const schedulers = [];
  after(() => {
    for (const s of schedulers) s.stop();
  });

  function make(opts = {}) {
    const timers = fakeTimers();
    const cronCalls = [];
    const s = createScheduler({
      now: opts.now || (() => 1_000),
      cronSchedule: (expr, fn) => {
        cronCalls.push({ expr, fn });
        return { stop() { cronCalls.stopped = true; } };
      },
      ...timers,
    });
    schedulers.push(s);
    return { s, timers, cronCalls };
  }

  it("requires name and run", () => {
    const { s } = make();
    assert.throws(() => s.registerJob({ run() {} }), /name is required/);
    assert.throws(() => s.registerJob({ name: "x" }), /run is required/);
  });

  it("runImmediately fires once and records a snapshot", async () => {
    const { s } = make();
    let n = 0;
    s.registerJob({ name: "once", run: () => { n += 1; }, runImmediately: true });
    await settle();
    assert.equal(n, 1);
    const row = s.snapshot().find((j) => j.name === "once");
    assert.equal(row.runCount, 1);
    assert.equal(row.running, false);
    assert.equal(row.lastError, null);
    assert.equal(row.lastTickAt, 1_000);
  });

  it("logs and records lastError when run throws", async () => {
    const { s } = make();
    const errors = [];
    const orig = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      s.registerJob({
        name: "boom",
        run: async () => {
          throw new Error("no port");
        },
        runImmediately: true,
      });
      await settle();
    } finally {
      console.error = orig;
    }
    assert.ok(errors.some((l) => l.includes("[scheduler] boom tick failed:") && l.includes("no port")));
    assert.equal(s.snapshot()[0].lastError, "no port");
  });

  it("skips overlapping ticks and counts them", async () => {
    const { s } = make();
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    let started = 0;
    s.registerJob({
      name: "slow",
      run: async () => {
        started += 1;
        await gate;
      },
      runImmediately: true,
    });
    await settle();
    assert.equal(started, 1);
    s.runNow("slow");
    await settle();
    assert.equal(started, 1);
    assert.equal(s.snapshot()[0].skipCount, 1);
    assert.equal(s.snapshot()[0].running, true);
    release();
    await settle();
    assert.equal(s.snapshot()[0].running, false);
  });

  it("align schedules a timeout for the next boundary then an interval", () => {
    const { s, timers } = make({ now: () => 120_001 });
    s.registerJob({
      name: "voice",
      run: () => {},
      intervalMs: 60_000,
      align: true,
    });
    assert.equal(timers.timeouts.length, 1);
    assert.equal(timers.timeouts[0].ms, 59_999);
    assert.equal(timers.intervals.length, 0);
    timers.timeouts[0].fn();
    assert.equal(timers.intervals.length, 1);
    assert.equal(timers.intervals[0].ms, 60_000);
  });

  it("delayFirstMs arms a one-shot timeout", () => {
    const { s, timers } = make();
    s.registerJob({
      name: "reminders",
      run: () => {},
      delayFirstMs: 5_000,
      cron: "* * * * *",
    });
    assert.equal(timers.timeouts[0].ms, 5_000);
  });

  it("cron expression is handed to the injected scheduler", () => {
    const { s, cronCalls } = make();
    s.registerJob({ name: "decay", run: () => {}, cron: "0 4 * * *" });
    assert.equal(cronCalls[0].expr, "0 4 * * *");
  });

  it("stop clears timers and cron and drops the job", () => {
    const { s, timers, cronCalls } = make();
    s.registerJob({
      name: "x",
      run: () => {},
      intervalMs: 10,
      cron: "* * * * *",
    });
    s.stop("x");
    assert.equal(timers.intervals.length, 0);
    assert.equal(s.getJob("x"), null);
    assert.equal(cronCalls.stopped, true);
  });

  it("re-registering the same name replaces the job", async () => {
    const { s } = make();
    let which = "";
    s.registerJob({ name: "dup", run: () => { which = "a"; }, runImmediately: true });
    await settle();
    s.registerJob({ name: "dup", run: () => { which = "b"; }, runImmediately: true });
    await settle();
    assert.equal(which, "b");
    assert.equal(s.listNames().length, 1);
  });

  // #858 — one non-settling tick must never wedge a job forever.
  describe("tick watchdog (timeoutMs)", () => {
    it("releases the overlap slot on watchdog timeout and the next fire runs", async () => {
      const { s, timers } = make();
      const resolvers = [];
      let started = 0;
      s.registerJob({
        name: "hang",
        timeoutMs: 5000,
        run: () => {
          started += 1;
          return new Promise((resolve) => resolvers.push(resolve));
        },
      });

      s.runNow("hang");
      await settle();
      assert.equal(started, 1);
      assert.equal(s.getJob("hang").inFlight, true);
      // the only timer is the watchdog (no interval registered)
      assert.equal(timers.timeouts.length, 1);
      assert.equal(timers.timeouts[0].ms, 5000);

      timers.timeouts[0].fn(); // watchdog fires
      await settle();
      const job = s.getJob("hang");
      assert.equal(job.inFlight, false, "slot released — the wedge is over");
      assert.match(job.lastError, /tick exceeded 5000ms/);

      s.runNow("hang"); // self-healed: the next fire runs again
      await settle();
      assert.equal(started, 2);
      assert.equal(job.inFlight, true);

      // The abandoned zombie finishing LATE must not touch the new attempt.
      resolvers[0]();
      await settle();
      assert.equal(job.inFlight, true, "zombie must not release the NEW attempt's slot");

      resolvers[1]();
      await settle();
      assert.equal(job.inFlight, false);
      assert.equal(job.lastError, null, "clean second attempt clears the timeout error");
    });

    it("logs a specific timeout error once per abandoned attempt", async () => {
      const { s, timers } = make();
      const errors = [];
      const orig = console.error;
      console.error = (...args) => errors.push(args.join(" "));
      try {
        s.registerJob({
          name: "hanglog",
          timeoutMs: 1000,
          run: () => new Promise(() => {}),
        });
        s.runNow("hanglog");
        await settle();
        timers.timeouts[0].fn();
        await settle();
        assert.equal(errors.length, 1);
        assert.match(errors[0], /hanglog: tick exceeded 1000ms \(abandoned; slot released\)/);

        // A zombie REJECTION after abandonment stays silent (attempt token).
        const { s: s2, timers: t2 } = make();
        let rejectZombie;
        s2.registerJob({
          name: "zombie",
          timeoutMs: 1000,
          run: () => new Promise((_r, rej) => { rejectZombie = rej; }),
        });
        s2.runNow("zombie");
        await settle();
        t2.timeouts[0].fn();
        await settle();
        const before = errors.length;
        rejectZombie(new Error("late failure nobody asked about"));
        await settle();
        assert.equal(errors.length, before, "abandoned zombies never log");
      } finally {
        console.error = orig;
      }
    });

    it("jobs without timeoutMs register no watchdog timer and behave as before", async () => {
      const { s, timers } = make();
      const errors = [];
      const orig = console.error;
      console.error = (...args) => errors.push(args.join(" "));
      try {
        s.registerJob({ name: "plain", run: () => Promise.resolve() });
        s.runNow("plain");
        await settle();
        assert.equal(timers.timeouts.length, 0, "no watchdog timer when unset");
        assert.equal(s.getJob("plain").inFlight, false);
        assert.equal(s.getJob("plain").lastError, null);

        s.registerJob({ name: "plainfail", run: () => Promise.reject(new Error("boom")) });
        s.runNow("plainfail");
        await settle();
        assert.equal(s.getJob("plainfail").inFlight, false);
        assert.equal(s.getJob("plainfail").lastError, "boom");
        assert.match(errors.join(" "), /plainfail tick failed: boom/);
      } finally {
        console.error = orig;
      }
    });
  });
});
