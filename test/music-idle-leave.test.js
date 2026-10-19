/**
 * #588: queue-drain idle-leave. The last track ending arms a bounded window
 * (IDLE_LEAVE_MS); the bot leaves when it elapses with nothing enqueued.
 * Cancel points are enqueue (playQuery) and every destroy. The fire-time
 * re-check owns the single "should we still be here" decision, and a failed
 * leave is logged with guild + channel ids (error doctrine).
 *
 * Timers are CAPTURED, not waited: setTimeout/clearTimeout are stubbed so
 * the 5-minute window is driven by direct invocation — deterministic, no
 * fake-clock coupling to lavalink-client internals. EVERY test uses a UNIQUE
 * guild id: the module-level timer map is the shared state, a fresh guild
 * per test is the isolation contract (repo convention).
 */
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const player = require("../src/features/music/player");
const {
  IDLE_LEAVE_MS,
  onQueueEnd,
  cancelIdleLeave,
  destroyPlayer,
} = player;

// ---------------------------------------------------------------- timer stub

const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;

function captureTimers() {
  const armed = []; // [{ fn, ms, handle }]
  let nextHandle = 1;
  const cleared = [];
  global.setTimeout = (fn, ms, ...args) => {
    const entry = { fn, ms, handle: nextHandle++, args };
    armed.push(entry);
    return entry.handle;
  };
  global.clearTimeout = (handle) => {
    cleared.push(handle);
  };
  return {
    armed,
    cleared,
    restore() {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    },
    fire(entry) {
      entry.fn();
    },
  };
}

// ------------------------------------------------------------------- fakes

/** Unique guild per mkPlayer() call — the timer-map isolation contract. */
let guildSeq = 0;

function mkPlayer({ current = null, tracks = [] } = {}) {
  const guildId = `g-idle-${++guildSeq}`;
  return {
    guildId,
    voiceChannelId: "vc-1",
    connected: true,
    playing: !!current,
    paused: false,
    queue: {
      current,
      tracks,
      add: async (t) => {
        tracks.push(...(Array.isArray(t) ? t : [t]));
      },
    },
    connect: async () => {},
    play: async () => {},
    search: async () => mkPlayer.nextSearch,
    destroy: async (reason) => {
      mkPlayer.destroyCalls.push({ guildId, reason });
      if (mkPlayer.destroyFails) throw new Error(mkPlayer.destroyFails);
    },
  };
}

mkPlayer.destroyCalls = [];
mkPlayer.destroyFails = null;
mkPlayer.nextSearch = null;

function mkManager(p) {
  const deleted = [];
  return {
    useable: true,
    deleted,
    getPlayer: (id) => (p && p.guildId === id && !p._gone ? p : null),
    createPlayer: () => p,
    deletePlayer: (id) => deleted.push(id),
  };
}

function captureConsoleError() {
  const lines = [];
  const real = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  return {
    lines,
    restore: () => {
      console.error = real;
    },
  };
}

const mkTrack = (n) => ({ info: { title: `t${n}`, author: "a", length: 1000 } });

// playQuery-shaped interaction (same fixture shape as music-queue-cap.test.js)
function mkInteraction(guildId) {
  return {
    guildId,
    user: { id: "870000000000000001" },
    channel: null,
    member: { voice: null },
    guild: {
      voiceStates: { cache: { get: () => ({ channelId: "vc-1", channel: null }) } },
      channels: { cache: { get: () => null } },
      afkChannelId: null,
      members: { me: null },
    },
  };
}

// -------------------------------------------------------------------- tests

describe("#588 queue-drain idle-leave", () => {
  let timers = null;
  let cerr = null;
  afterEach(() => {
    timers?.restore();
    timers = null;
    cerr?.restore();
    cerr = null;
    mkPlayer.destroyCalls = [];
    mkPlayer.destroyFails = null;
    mkPlayer.nextSearch = null;
  });

  it("drained queueEnd arms exactly one IDLE_LEAVE_MS window", () => {
    timers = captureTimers();
    const p = mkPlayer();
    onQueueEnd(mkManager(p), p);
    assert.equal(timers.armed.length, 1, "one window armed");
    assert.equal(timers.armed[0].ms, IDLE_LEAVE_MS, "the window is the idle window");
    // re-arm while running does NOT stack a second timer (same guild)
    onQueueEnd(mkManager(p), p);
    assert.equal(timers.armed.length, 1, "re-entrant queueEnd keeps ONE window");
  });

  it("queueEnd with a non-empty queue is activity: no arm, pending window cancelled", () => {
    timers = captureTimers();
    const busy = mkPlayer({ current: mkTrack(1), tracks: [mkTrack(2)] });
    onQueueEnd(mkManager(busy), busy);
    assert.equal(timers.armed.length, 0, "not drained — nothing to time");

    // arm on a drained guild, then a non-empty end for the SAME player cancels
    const p = mkPlayer();
    const mgr = mkManager(p);
    onQueueEnd(mgr, p);
    assert.equal(timers.armed.length, 1);
    p.queue.current = mkTrack(9);
    onQueueEnd(mgr, p);
    assert.equal(timers.armed.length, 1, "still one arm (no re-arm)");
    assert.deepEqual(timers.cleared, [timers.armed[0].handle], "pending window cleared");
  });

  it("window elapses with nothing enqueued → leave with queue_empty_idle reason", async () => {
    timers = captureTimers();
    const p = mkPlayer();
    const mgr = mkManager(p);
    onQueueEnd(mgr, p);
    timers.fire(timers.armed[0]);
    await new Promise((r) => realSetTimeout(r, 0)); // real macrotask flush // let the destroy promise settle
    assert.equal(mkPlayer.destroyCalls.length, 1);
    assert.equal(mkPlayer.destroyCalls[0].reason, "queue_empty_idle");
    assert.deepEqual(mgr.deleted, [p.guildId], "player bookkeeping removed");
  });

  it("fire-time re-check: refilled queue keeps the player (arm time is not trusted)", async () => {
    timers = captureTimers();
    const p = mkPlayer();
    const mgr = mkManager(p);
    onQueueEnd(mgr, p);
    p.queue.current = mkTrack(42); // raced an enqueue between arm and fire
    timers.fire(timers.armed[0]);
    await new Promise((r) => realSetTimeout(r, 0)); // real macrotask flush
    assert.equal(mkPlayer.destroyCalls.length, 0, "audio is back — we should still be here");
  });

  it("fire when the player is already gone is a no-op", async () => {
    timers = captureTimers();
    const p = mkPlayer();
    const mgr = mkManager(p);
    onQueueEnd(mgr, p);
    p._gone = true;
    timers.fire(timers.armed[0]);
    await new Promise((r) => realSetTimeout(r, 0)); // real macrotask flush
    assert.equal(mkPlayer.destroyCalls.length, 0);
  });

  it("failed leave is LOGGED with guild + channel ids (never silent)", async () => {
    timers = captureTimers();
    cerr = captureConsoleError();
    mkPlayer.destroyFails = "voice gateway hiccup";
    const p = mkPlayer();
    onQueueEnd(mkManager(p), p);
    timers.fire(timers.armed[0]);
    await new Promise((r) => realSetTimeout(r, 0)); // real macrotask flush
    const line = cerr.lines.find((l) => l.includes("queue-idle leave failed"));
    assert.ok(line, `specific failure logged, got: ${JSON.stringify(cerr.lines)}`);
    assert.ok(
      line.includes(p.guildId) && line.includes("vc-1"),
      `ids in log: ${line}`,
    );
    assert.ok(line.includes("voice gateway hiccup"), `cause in log: ${line}`);
  });

  it("cancelIdleLeave clears the pending window", () => {
    timers = captureTimers();
    const p = mkPlayer();
    onQueueEnd(mkManager(p), p);
    cancelIdleLeave(p.guildId);
    assert.deepEqual(timers.cleared, [timers.armed[0].handle]);
  });

  it("destroyPlayer cancels the window (no stale timer on a re-created player)", async () => {
    timers = captureTimers();
    const p = mkPlayer();
    onQueueEnd(mkManager(p), p);
    await destroyPlayer(mkManager(p), p.guildId, "button_stop");
    assert.deepEqual(timers.cleared, [timers.armed[0].handle]);
  });

  it("lavalink.js does NOT re-add the library destroyAfterMs (ONE decision point)", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../src/features/music/lavalink.js"),
      "utf8",
    );
    assert.ok(
      !/destroyAfterMs\s*:/.test(src),
      "the library-side queue-empty destroy must stay OFF — player.js owns #588",
    );
  });

  it("playQuery enqueue cancels the pending window (cancel point #588)", async () => {
    timers = captureTimers();
    const p = mkPlayer();
    const mgr = mkManager(p);
    onQueueEnd(mgr, p); // window running for this guild
    assert.equal(timers.armed.length, 1);

    mkPlayer.nextSearch = { loadType: "track", tracks: [mkTrack("rescue")] };
    const client = { _lavalinkManager: mgr };
    const res = await player.playQuery(client, mkInteraction(p.guildId), "anything");
    assert.equal(res.ok, true, "the play itself lands");
    assert.deepEqual(timers.cleared, [timers.armed[0].handle], "enqueue cancelled the window");
  });
});
