/**
 * Unit tests for src/web/data/dashboardData.js + src/web/data/tickerHealth.js
 * (subtask 14, §8.6 query budget). NO HTTP, NO real DB: the db facade is a
 * counting fake and the clock is fake — the cache contract is pinned
 * exactly:
 *  - first getDashboard = one bounded facade read set with CAPPED args;
 *  - every read inside the TTL window = ZERO facade calls;
 *  - past the TTL = a fresh read set; per-guild entries are independent;
 *  - any facade section throwing degrades THAT panel (never the call);
 *  - provider (now-playing / ticker) contracts incl. throw ⇒ "unknown";
 *  - TTL env knob may raise, never lower, the §8.6 30 s floor;
 *  - snapshotMusicPlayer degrades honestly through every lavalink failure.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  createDashboardData,
  getDashboardCacheTtlMs,
  snapshotMusicPlayer,
  DEFAULT_CACHE_TTL_MS,
  MIN_CACHE_TTL_MS,
  DASHBOARD_LIMITS,
} = require("../src/web/data/dashboardData");

const {
  registerTickerHealthSource,
  snapshotTickerHealth,
  classifyTickerResult,
  listTickerHealthNames,
  _clearTickerHealthForTests,
} = require("../src/web/data/tickerHealth");

const { createScheduler } = require("../src/core/scheduler");

const {
  registerSchedulerJobHealthSources,
  schedulerJobToTickerResult,
  DETAIL_LAST_TICK_FAILED,
  DETAIL_NO_TICK_YET,
  DETAIL_CRON_NO_DERIVED,
} = require("../src/web/data/schedulerJobHealth");

const GUILD = "700000000000000001";

/**
 * Counting fake db facade: records {name,args} for every read the dashboard
 * performs and returns fixed-shaped rows.
 */
function makeFakeDb(overrides = {}) {
  const calls = [];
  const track = (name, fn) => (...args) => {
    calls.push({ name, args });
    return fn(...args);
  };
  return {
    calls,
    db: {
      guildActivityStats: track(
        "guildActivityStats",
        overrides.guildActivityStats ||
          ((/* g */) => ({ day_rows: 3, message_total: 42, ignore_count: 1 }))
      ),
      getGuildActivitySettings: track(
        "getGuildActivitySettings",
        overrides.getGuildActivitySettings ||
          ((/* g */) => ({ guild_id: GUILD, collect_from_ms: 1, guild_backfill_status: "none" }))
      ),
      guildHasActiveBackfill: track(
        "guildHasActiveBackfill",
        overrides.guildHasActiveBackfill || ((/* g */) => false)
      ),
      topUsers: track(
        "topUsers",
        overrides.topUsers ||
          ((/* g, limit */) => [
            { user_id: "u1", xp: 90 },
            { user_id: "u2", xp: 80 },
          ])
      ),
      listOpenTickets: track(
        "listOpenTickets",
        overrides.listOpenTickets ||
          ((/* g, opts */) =>
            Array.from({ length: 7 }, (_, i) => ({
              id: i + 1,
              ticket_number: 100 - i,
              reason: `r${i}`,
              creator_user_id: "creator",
              created_at: 1000 + i,
            })))
      ),
    },
  };
}

const T0 = 1_757_000_000_000; // frozen epoch ms for the fake clock

/** Drain the microtask + macrotask queue so scheduler .finally stamps land. */
function settle() {
  return new Promise((r) => setImmediate(r));
}

/**
 * Fake timer set for createScheduler({ ... }) — same harness pattern as
 * test/scheduler.test.js: NO real timers, cron fires are captured callbacks.
 */
function fakeTimers() {
  const timeouts = [];
  const intervals = [];
  let nextId = 1;
  return {
    timeouts,
    intervals,
    setTimeoutFn: (fn, ms) => {
      const id = nextId++;
      timeouts.push({ id, fn, ms });
      return { id, unref() {} };
    },
    clearTimeoutFn: (handle) => {
      const id = handle?.id ?? handle;
      const i = timeouts.findIndex((t) => t.id === id);
      if (i >= 0) timeouts.splice(i, 1);
    },
    setIntervalFn: (fn, ms) => {
      const id = nextId++;
      intervals.push({ id, fn, ms });
      return { id, unref() {} };
    },
    clearIntervalFn: (handle) => {
      const id = handle?.id ?? handle;
      const i = intervals.findIndex((t) => t.id === id);
      if (i >= 0) intervals.splice(i, 1);
    },
  };
}

describe("dashboardData: cache + query budget", () => {
  afterEach(() => {
    _clearTickerHealthForTests();
  });

  it("first read runs a bounded facade set with capped args", async () => {
    const { db, calls } = makeFakeDb();
    let nowMs = T0;
    const dash = createDashboardData({ db, now: () => nowMs, ttlMs: 30_000 });

    const snap = await dash.getDashboard(GUILD);
    assert.equal(calls.length, 5);
    const byName = Object.fromEntries(calls.map((c) => [c.name, c]));
    assert.equal(byName.topUsers.args[1], DASHBOARD_LIMITS.XP_LEADERS); // 10
    assert.equal(byName.listOpenTickets.args[1].limit, DASHBOARD_LIMITS.OPEN_TICKET_ROWS); // 50
    assert.equal(snap.freshness.fromCache, false);
    assert.equal(snap.tickets.openCount, 7);
    assert.equal(snap.tickets.newest.length, DASHBOARD_LIMITS.NEWEST_TICKETS); // 5
    // Saturation display flag at the repo's hard cap of 50 rows:
    assert.equal(snap.tickets.openCountSaturated, false);
  });

  it("reads inside the TTL window run ZERO facade calls; past it re-reads", async () => {
    const { db, calls } = makeFakeDb();
    let nowMs = T0;
    const dash = createDashboardData({ db, now: () => nowMs, ttlMs: 30_000 });

    await dash.getDashboard(GUILD);
    const afterFirst = calls.length;

    for (const [offsetMs, expectFresh] of [
      [0, false],
      [1, false],
      [29_999, false],
      [30_000, true], // nowMs = T0 + 30_000 → expired (expiresAt > at fails)
    ]) {
      nowMs = T0 + offsetMs; // absolute clock position inside/past the window
      const before = calls.length;
      const snap = await dash.getDashboard(GUILD);
      if (expectFresh) {
        assert.ok(calls.length > before, `+${offsetMs}ms past TTL must re-read`);
        assert.equal(snap.freshness.fromCache, false);
      } else {
        assert.equal(calls.length, before, `+${offsetMs}ms in window: zero reads`);
        assert.equal(snap.freshness.fromCache, true);
      }
    }
    assert.ok(afterFirst > 0);
  });

  it("per-guild entries are independent and lazily expired", async () => {
    const { db, calls } = makeFakeDb();
    let nowMs = T0;
    const dash = createDashboardData({ db, now: () => nowMs, ttlMs: 10_000 });

    await dash.getDashboard(GUILD);
    const firstGuildCalls = calls.length;
    await dash.getDashboard("700000000000000002");
    assert.equal(calls.length, firstGuildCalls * 2, "second guild reads fresh");
    await dash.getDashboard(GUILD);
    assert.equal(calls.length, firstGuildCalls * 2, "first guild still cached");
    assert.equal(dash._cacheSizeForTests(), 2);

    dash.invalidate(GUILD);
    await dash.getDashboard(GUILD);
    assert.equal(calls.length, firstGuildCalls * 3);
  });

  it("cache entry count is bounded (insertion-ordered eviction)", async () => {
    const { db } = makeFakeDb();
    const dash = createDashboardData({ db, now: () => T0, ttlMs: 60_000, maxEntries: 3 });
    for (let i = 0; i < 10; i += 1) {
      await dash.getDashboard(`${GUILD}${i}`);
    }
    assert.ok(dash._cacheSizeForTests() <= 3);
  });

  it("one failing section degrades that panel only; all-fail still resolves", async () => {
    const boom = () => {
      throw new Error("SQLITE_BUSY");
    };
    const { db } = makeFakeDb({ listOpenTickets: boom });
    const dash = createDashboardData({ db, now: () => T0, ttlMs: 30_000 });
    const snap = await dash.getDashboard(GUILD);
    assert.equal(snap.tickets.available, false);
    assert.equal(snap.tickets.openCount, 0);
    assert.equal(snap.activity.status, "ok"); // other sections survived

    const all = createDashboardData({
      db: {
        guildActivityStats: boom,
        getGuildActivitySettings: boom,
        guildHasActiveBackfill: boom,
        topUsers: boom,
        listOpenTickets: boom,
      },
      now: () => T0,
      ttlMs: 30_000,
    });
    const degraded = await all.getDashboard(GUILD);
    assert.equal(degraded.activity.status, "unavailable");
    assert.equal(degraded.activity.messageTracking, null);
    assert.equal(degraded.activity.xpLeaders, null);
    assert.equal(degraded.tickets.available, false);
    assert.equal(degraded.nowPlaying.status, "unknown");
    assert.deepEqual(degraded.tickers, []);
  });

  it("getDashboard validates its input", async () => {
    const { db } = makeFakeDb();
    const dash = createDashboardData({ db, now: () => T0 });
    await assert.rejects(() => dash.getDashboard(""), TypeError);
    await assert.rejects(() => dash.getDashboard(42), TypeError);
  });

  it("providers: throwing/absent degrades; playing payload is normalized + clamped", async () => {
    const { db } = makeFakeDb();

    const noProvider = createDashboardData({ db, now: () => T0, ttlMs: 60_000 });
    assert.deepEqual((await noProvider.getDashboard(GUILD)).nowPlaying, {
      status: "unknown",
      detail: "not wired",
    });

    const throwing = createDashboardData({
      db,
      now: () => T0,
      ttlMs: 60_000,
      getNowPlaying: () => {
        throw new Error("node down");
      },
    });
    const t = (await throwing.getDashboard(GUILD)).nowPlaying;
    assert.equal(t.status, "unknown");
    assert.equal(t.detail, "source failed");

    const junk = createDashboardData({
      db,
      now: () => T0,
      ttlMs: 60_000,
      getNowPlaying: () => "not an object",
    });
    assert.equal((await junk.getDashboard(GUILD)).nowPlaying.status, "unknown");

    const playing = createDashboardData({
      db,
      now: () => T0,
      ttlMs: 60_000,
      getNowPlaying: () => ({
        status: "playing",
        title: "x".repeat(500),
        author: "Band",
        paused: true,
        positionMs: 65_000,
        upcoming: 3,
      }),
    });
    const np = (await playing.getDashboard(GUILD)).nowPlaying;
    assert.equal(np.status, "playing");
    assert.equal(np.paused, true);
    assert.equal(np.title.length, 200, "title clamped to 200 chars");
    assert.equal(np.upcoming, 3);
  });

  it("default ticker provider reads the tickerHealth registry", async () => {
    registerTickerHealthSource("voice", () => ({
      lastTickAt: T0 - 5_000,
      intervalMs: 60_000,
    }));
    registerTickerHealthSource("youtube", () => {
      throw new Error("boom");
    });
    const { db } = makeFakeDb();
    const dash = createDashboardData({
      db,
      now: () => T0,
      ttlMs: 30_000,
      getTickerHealth: undefined, // force the registry default path
    });
    const tickers = (await dash.getDashboard(GUILD)).tickers;
    const byName = Object.fromEntries(tickers.map((t) => [t.name, t]));
    assert.equal(byName.voice.status, "ok");
    assert.equal(byName.youtube.status, "unknown");
    assert.equal(byName.youtube.detail, "source failed");
  });

  it("injected ticker provider entries are normalized to the view shape", async () => {
    const { db } = makeFakeDb();
    const dash = createDashboardData({
      db,
      now: () => T0,
      ttlMs: 30_000,
      getTickerHealth: () => [
        { name: "voice", status: "stale", lastTickAt: 123, ageMs: 999 },
        { status: "bogus-status" }, // unnamed + bad status → coerced
        "junk",
      ],
    });
    const [a, b, c] = (await dash.getDashboard(GUILD)).tickers;
    assert.deepEqual(a, { name: "voice", status: "stale", lastTickAt: 123, ageMs: 999 });
    assert.equal(b.name, "ticker-2");
    assert.equal(b.status, "unknown");
    assert.equal(c.name, "ticker-3");
  });

  it("TTL env knob may RAISE the §8.6 floor but never lower it", () => {
    const saved = process.env.WEB_DASHBOARD_CACHE_TTL_MS;
    try {
      delete process.env.WEB_DASHBOARD_CACHE_TTL_MS;
      assert.equal(getDashboardCacheTtlMs(), DEFAULT_CACHE_TTL_MS);

      process.env.WEB_DASHBOARD_CACHE_TTL_MS = "120000";
      assert.equal(getDashboardCacheTtlMs(), 120_000);

      process.env.WEB_DASHBOARD_CACHE_TTL_MS = "1000"; // below the 30s floor
      assert.equal(getDashboardCacheTtlMs(), MIN_CACHE_TTL_MS);

      process.env.WEB_DASHBOARD_CACHE_TTL_MS = "garbage";
      assert.equal(getDashboardCacheTtlMs(), DEFAULT_CACHE_TTL_MS);
    } finally {
      if (saved === undefined) delete process.env.WEB_DASHBOARD_CACHE_TTL_MS;
      else process.env.WEB_DASHBOARD_CACHE_TTL_MS = saved;
    }
  });
});

describe("tickerHealth registry", () => {
  afterEach(() => _clearTickerHealthForTests());

  it("classifyTickerResult covers the full contract (pure)", () => {
    const now = T0;
    const base = classifyTickerResult(null, now, "x");
    assert.equal(base.status, "unknown");
    assert.equal(base.detail, "not wired");

    assert.equal(classifyTickerResult(now - 1000, now, "x").status, "ok");
    assert.equal(
      classifyTickerResult({ lastTickAt: now - 151_000, intervalMs: 60_000 }, now, "x").status,
      "stale",
      "age strictly above 2.5× interval ⇒ stale"
    );
    assert.equal(
      classifyTickerResult({ lastTickAt: now - 60_000, intervalMs: 60_000 }, now, "x").status,
      "ok"
    );
    assert.equal(classifyTickerResult({ running: false }, now, "x").status, "down");
    assert.equal(classifyTickerResult({ status: "down", detail: "parked" }, now, "x").status, "down");
    assert.equal(classifyTickerResult({}, now, "x").status, "unknown");
    assert.equal(classifyTickerResult("junk-string", now, "x").status, "unknown");
  });

  it("register/unregister/list + throwing getters degrade to fixed text", async () => {
    const off = registerTickerHealthSource("twitch", () => 1);
    assert.deepEqual(listTickerHealthNames(), ["twitch"]);
    off();
    assert.deepEqual(listTickerHealthNames(), []);

    registerTickerHealthSource("broken", () => {
      throw new Error("secret internals here");
    });
    const [entry] = await snapshotTickerHealth(T0);
    assert.equal(entry.name, "broken");
    assert.equal(entry.status, "unknown");
    assert.equal(
      entry.detail,
      "source failed",
      "getter error text never lands in the snapshot"
    );
  });

  it("registry is empty by default ⇒ empty snapshot", async () => {
    assert.deepEqual(await snapshotTickerHealth(T0), []);
  });
});

describe("snapshotMusicPlayer (read-only lavalink snapshot)", () => {
  const playerWith = (over = {}) => ({
    paused: false,
    position: 1234,
    voiceChannelId: "vc1",
    queue: {
      current: { info: { title: "Song", author: "Band", duration: 100 } },
      tracks: [{}, {}, {}],
    },
    ...over,
  });
  const apiOf = (manager, ready = true) => ({
    getManager: () => manager,
    isNodeReady: () => ready,
  });

  it("maps every failure mode to an honest status", () => {
    assert.equal(snapshotMusicPlayer(null, GUILD, apiOf(null)).status, "unknown");

    const noCfg = snapshotMusicPlayer({}, GUILD, apiOf(null));
    assert.equal(noCfg.status, "unavailable");
    assert.equal(noCfg.detail, "lavalink not configured");

    const down = snapshotMusicPlayer({}, GUILD, apiOf({ getPlayer: () => null }, false));
    assert.equal(down.status, "unavailable");
    assert.equal(down.detail, "no lavalink node connected");

    const idle = snapshotMusicPlayer(
      {},
      GUILD,
      apiOf({ getPlayer: () => null })
    );
    assert.equal(idle.status, "idle");

    const emptyQ = snapshotMusicPlayer(
      {},
      GUILD,
      apiOf({ getPlayer: () => ({ queue: { current: null, tracks: [] } }) })
    );
    assert.equal(emptyQ.status, "idle");
    assert.equal(emptyQ.detail, "queue empty");

    const explodes = snapshotMusicPlayer({}, GUILD, {
      getManager: () => {
        throw new Error("manager exploded");
      },
      isNodeReady: () => true,
    });
    assert.equal(explodes.status, "unknown");
  });

  it("playing state extracts title/author/paused/position/upcoming", () => {
    const snap = snapshotMusicPlayer(
      {},
      GUILD,
      apiOf({ getPlayer: () => playerWith() })
    );
    assert.equal(snap.status, "playing");
    assert.equal(snap.title, "Song");
    assert.equal(snap.author, "Band");
    assert.equal(snap.paused, false);
    assert.equal(snap.positionMs, 1234);
    assert.equal(snap.upcoming, 3);

    const paused = snapshotMusicPlayer(
      {},
      GUILD,
      apiOf({ getPlayer: () => playerWith({ paused: true }) })
    );
    assert.equal(paused.paused, true);
  });
});

// ===========================================================================
// Task 15.6 — scheduler → tickerHealth bridge (real job state on the panel)
// ===========================================================================

/**
 * Real createScheduler + fake timers + a movable injected clock. The bridge
 * runs against a REAL scheduler instance (wiring fidelity), while every
 * timestamp flows from `setStamp` — staleness is derived by the registry
 * at snapshot time, never fabricated by the bridge.
 */
function makeBridgeHarness() {
  const timers = fakeTimers();
  let stampAt = T0;
  const cronCalls = [];
  const s = createScheduler({
    now: () => stampAt,
    ...timers,
    cronSchedule: (expr, fn) => {
      cronCalls.push({ expr, fn });
      return { stop() {} };
    },
  });
  return {
    s,
    timers,
    cronCalls,
    setStamp(ms) {
      stampAt = ms;
    },
    /** fire + drain, so lastFinishedAt stamps at the CURRENT stampAt. */
    async fire(name, at) {
      stampAt = at;
      s.runNow(name);
      await settle();
    },
    async fireCron(index, at) {
      stampAt = at;
      cronCalls[index].fn();
      await settle();
    },
  };
}

describe("scheduler→tickerHealth bridge (Task 15.6: honest job state)", () => {
  let bridgeOff = null;
  let harness = null;

  afterEach(() => {
    if (bridgeOff) {
      bridgeOff();
      bridgeOff = null;
    }
    if (harness) {
      harness.s.stop();
      harness = null;
    }
    _clearTickerHealthForTests();
  });

  /** The real recurring-job set, registered exactly like the features do. */
  const INTERVAL_JOBS = ["voice", "youtube", "twitch", "githubReleases", "xpCooldownSweep"];
  const CRON_JOBS = ["decay", "eventReminders"];

  function registerRealJobSet(h) {
    h.s.registerJob({ name: "voice", intervalMs: 60_000, align: true, run: () => {} });
    h.s.registerJob({ name: "youtube", intervalMs: 5 * 60_000, align: true, run: () => {} });
    h.s.registerJob({ name: "twitch", intervalMs: 60_000, align: true, run: () => {} });
    h.s.registerJob({ name: "githubReleases", intervalMs: 3_600_000, align: true, run: () => {} });
    h.s.registerJob({ name: "xpCooldownSweep", intervalMs: 10 * 60_000, run: () => {} });
    h.s.registerJob({ name: "decay", cron: "0 4 * * *", run: () => {} });
    h.s.registerJob({ name: "eventReminders", cron: "* * * * *", run: () => {} });
  }

  it("real scheduler wiring: every named job appears in the panel data with honest statuses", async () => {
    const h = makeBridgeHarness();
    harness = h;
    registerRealJobSet(h);
    // cron jobs last fired 20 h ago; interval jobs fired just now.
    await h.fireCron(0, T0 - 20 * 3_600_000); // decay
    await h.fireCron(1, T0 - 20 * 3_600_000); // eventReminders (cron idle like decay)
    for (const name of INTERVAL_JOBS) await h.fire(name, T0);

    bridgeOff = registerSchedulerJobHealthSources(h.s);
    assert.deepEqual(
      listTickerHealthNames().slice().sort(),
      [...INTERVAL_JOBS, ...CRON_JOBS].sort(),
      "one registry source per scheduler job"
    );

    const rows = await snapshotTickerHealth(T0);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    for (const name of INTERVAL_JOBS) {
      assert.equal(by[name].status, "ok", `${name} fresh stamp ⇒ ok`);
    }
    for (const name of CRON_JOBS) {
      assert.equal(by[name].status, "unknown", `${name} idle cron ⇒ honest unknown`);
      assert.notEqual(by[name].status, "down", `${name} idle cron must NEVER read down`);
      assert.equal(by[name].detail, DETAIL_CRON_NO_DERIVED);
      assert.equal(by[name].lastTickAt, T0 - 20 * 3_600_000, "last tick still shown");
    }

    // Panel data through the REAL default provider path (registry → dashboardData):
    const { db } = makeFakeDb();
    const dash = createDashboardData({ db, now: () => T0, ttlMs: 30_000 });
    const tickers = (await dash.getDashboard(GUILD)).tickers;
    assert.ok(tickers.length >= 4, `≥4 named jobs, got ${tickers.length}`);
    const pByName = Object.fromEntries(tickers.map((t) => [t.name, t]));
    for (const name of ["voice", "youtube", "twitch", "decay", "githubReleases"]) {
      assert.ok(pByName[name], `${name} present in panel data`);
    }
    assert.equal(pByName.voice.status, "ok");
    assert.equal(pByName.decay.status, "unknown");
  });

  it("stale derivation: age > 2.5× interval ⇒ stale; fresh stamps ⇒ ok", async () => {
    const h = makeBridgeHarness();
    harness = h;
    h.s.registerJob({ name: "voice", intervalMs: 60_000, run: () => {} });
    h.s.registerJob({ name: "twitch", intervalMs: 60_000, run: () => {} });
    h.s.registerJob({ name: "youtube", intervalMs: 5 * 60_000, run: () => {} });

    // Fake AGED ticker: youtube's last completed tick is 13 min old vs a
    // 5-min cadence (2.5× = 12.5 min) — a stalled-but-alive interval job.
    await h.fire("youtube", T0 - 13 * 60_000);
    await h.fire("voice", T0 - 5_000);
    await h.fire("twitch", T0 - 8_000);

    bridgeOff = registerSchedulerJobHealthSources(h.s);
    const by = Object.fromEntries((await snapshotTickerHealth(T0)).map((r) => [r.name, r]));
    assert.equal(by.youtube.status, "stale", "aged fake ticker renders stale");
    assert.ok(by.youtube.ageMs > 2.5 * 5 * 60_000, "age really exceeds 2.5× cadence");
    assert.equal(by.voice.status, "ok", "freshly stamped job renders ok");
    assert.equal(by.twitch.status, "ok");
  });

  it("cron-only rows never fabricate ok/down: idle ⇒ unknown, in-flight ⇒ ok", async () => {
    const h = makeBridgeHarness();
    harness = h;
    let release;
    h.s.registerJob({
      name: "decay",
      cron: "0 4 * * *",
      run: () => new Promise((r) => { release = r; }),
    });
    bridgeOff = registerSchedulerJobHealthSources(h.s);

    // IN FLIGHT: a tick is executing right now ⇒ ok (no lastFinishedAt yet).
    h.setStamp(T0 - 20 * 3_600_000);
    h.cronCalls[0].fn();
    const flying = (await snapshotTickerHealth(T0))[0];
    assert.equal(flying.status, "ok", "in-flight tick ⇒ ok");
    assert.equal(flying.lastTickAt, T0 - 20 * 3_600_000, "started-at shown while running");

    // IDLE (the gotcha: running=false + intervalMs=null between fires):
    // must be unknown with last-tick info — NEVER down.
    release();
    await settle();
    const idle = (await snapshotTickerHealth(T0))[0];
    assert.equal(idle.status, "unknown");
    assert.notEqual(idle.status, "down", "idle cron must never read down");
    assert.equal(idle.detail, DETAIL_CRON_NO_DERIVED);
    assert.equal(idle.lastTickAt, T0 - 20 * 3_600_000);
  });

  it("never-ticked and stopped jobs stay unknown — no fabricated tick", async () => {
    const h = makeBridgeHarness();
    harness = h;
    h.s.registerJob({ name: "voice", intervalMs: 60_000, run: () => {} });
    h.s.registerJob({ name: "decay", cron: "0 4 * * *", run: () => {} });
    bridgeOff = registerSchedulerJobHealthSources(h.s);

    const by = Object.fromEntries((await snapshotTickerHealth(T0)).map((r) => [r.name, r]));
    for (const name of ["voice", "decay"]) {
      assert.equal(by[name].status, "unknown", `${name} never ticked ⇒ unknown`);
      assert.equal(by[name].detail, DETAIL_NO_TICK_YET);
      assert.equal(by[name].lastTickAt, undefined, "no fabricated last tick");
    }

    // Stopped job ⇒ the live getter reads null ⇒ registry "not wired".
    h.s.stop("voice");
    const after = Object.fromEntries((await snapshotTickerHealth(T0)).map((r) => [r.name, r]));
    assert.equal(after.voice.status, "unknown");
    assert.equal(after.voice.detail, "not wired");
  });

  it("scheduler lastError text NEVER reaches the panel — fixed detail only (§8.7)", async () => {
    const SENTINEL = "SQLITE_BUSY-internal-path-detail-MUST-NOT-LEAK";
    const h = makeBridgeHarness();
    harness = h;
    h.s.registerJob({
      name: "voice",
      intervalMs: 60_000,
      run: () => {
        throw new Error(SENTINEL);
      },
    });
    const origErr = console.error;
    console.error = () => {}; // the scheduler logs the failure itself
    try {
      await h.fire("voice", T0 - 1_000);
    } finally {
      console.error = origErr;
    }
    bridgeOff = registerSchedulerJobHealthSources(h.s);

    const rows = await snapshotTickerHealth(T0);
    assert.equal(rows[0].status, "ok", "a fresh-but-failed tick still ticks on schedule");
    assert.equal(rows[0].detail, DETAIL_LAST_TICK_FAILED, "fixed detail string");
    assert.ok(
      !JSON.stringify(rows).includes(SENTINEL),
      "raw lastError text never lands in the snapshot"
    );
  });

  it("registration is idempotent and getters track LIVE job state", async () => {
    const h = makeBridgeHarness();
    harness = h;
    h.s.registerJob({ name: "voice", intervalMs: 60_000, run: () => {} });
    await h.fire("voice", T0 - 5_000);

    const off1 = registerSchedulerJobHealthSources(h.s);
    const off2 = registerSchedulerJobHealthSources(h.s); // double-boot safe
    bridgeOff = () => {
      off1();
      off2();
    };
    assert.equal(listTickerHealthNames().filter((n) => n === "voice").length, 1);
    assert.equal((await snapshotTickerHealth(T0))[0].status, "ok");

    // Feature re-registers the SAME job with a slower cadence and an aged
    // tick: the getter must reflect the NEW live job (stale vs 10-min
    // cadence: 26 min > 2.5×10 min).
    h.s.registerJob({ name: "voice", intervalMs: 10 * 60_000, run: () => {} });
    await h.fire("voice", T0 - 26 * 60_000);
    assert.equal((await snapshotTickerHealth(T0))[0].status, "stale");
  });

  it("schedulerJobToTickerResult: pure adapter never sets a status", () => {
    assert.equal(schedulerJobToTickerResult(null), null);
    assert.equal(schedulerJobToTickerResult(undefined), null);
    assert.equal(schedulerJobToTickerResult("junk"), null);

    const interval = schedulerJobToTickerResult({
      name: "voice",
      intervalMs: 60_000,
      lastFinishedAt: 1000,
      inFlight: false,
      lastError: null,
    });
    assert.deepEqual(interval, { lastTickAt: 1000, intervalMs: 60_000 });
    assert.equal(interval.status, undefined, "status is the registry's to derive");
    assert.equal(interval.running, undefined, "running:false is never forwarded");

    const cronInFlight = schedulerJobToTickerResult({
      name: "decay",
      cron: "0 4 * * *",
      intervalMs: null,
      lastStartedAt: 2000,
      lastFinishedAt: null,
      inFlight: true,
    });
    assert.deepEqual(cronInFlight, { lastTickAt: 2000, running: true });
  });
});
