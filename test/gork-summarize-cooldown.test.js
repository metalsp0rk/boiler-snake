/**
 * Per-guild /gork summarize cooldown GATE unit tests
 * (roadmap/gork.md §7.21.5, proposed decision 57).
 *
 * Gate semantics (fake clock via createSummarizeCooldownGate({ now }), same
 * seam as queue.js): fresh guild allowed; armed guild blocked with the exact
 * remaining ms; expiry re-allows; re-arming refreshes without stacking;
 * guilds are independent; invalid ids never throw (fail open). The
 * minutes-remaining reply math (round UP) and the module singleton + the
 * *ForTests reset run on the real clock.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { GORK_SUMMARIZE_GUILD_COOLDOWN_MS } = require("../src/features/gork/constants");
const {
  createSummarizeCooldownGate,
  checkSummarizeGuildCooldown,
  armSummarizeGuildCooldown,
  summarizeCooldownMinutesRemaining,
  resetSummarizeGuildCooldownForTests,
} = require("../src/features/gork/summarizeCooldown");

const WINDOW = GORK_SUMMARIZE_GUILD_COOLDOWN_MS; // 10 minutes (§7.21.5)

describe("createSummarizeCooldownGate (fake clock, §7.21.5)", () => {
  /** Mutable fake clock shared by each test's gate. */
  function withClock(startMs = 1_700_000_000_000) {
    let nowMs = startMs;
    const gate = createSummarizeCooldownGate({ now: () => nowMs });
    return { gate, advance: (ms) => (nowMs += ms), at: () => nowMs };
  }

  it("fresh guild is allowed (remaining 0)", () => {
    const { gate } = withClock();
    assert.equal(gate.checkCooldown("g1"), 0);
  });

  it("arming blocks the guild with exact remaining ms", () => {
    const { gate, advance } = withClock();
    gate.armCooldown("g1");
    assert.equal(gate.checkCooldown("g1"), WINDOW);
    advance(WINDOW / 2);
    assert.equal(gate.checkCooldown("g1"), WINDOW / 2, "half the window burned");
    advance(WINDOW / 2 - 1);
    assert.equal(gate.checkCooldown("g1"), 1, "1ms left is still armed");
  });

  it("window expiry re-allows at exactly 10 minutes", () => {
    const { gate, advance } = withClock();
    gate.armCooldown("g1");
    advance(WINDOW - 1);
    assert.equal(gate.checkCooldown("g1"), 1, "still armed 1ms before expiry");
    advance(1); // full window elapsed
    assert.equal(gate.checkCooldown("g1"), 0, "expiry is inclusive: re-allowed");
    gate.armCooldown("g1"); // immediate retry works after expiry
    assert.equal(gate.checkCooldown("g1"), WINDOW);
  });

  it("arming a second time refreshes the window (no stacking)", () => {
    const { gate, advance } = withClock();
    gate.armCooldown("g1");
    advance(WINDOW / 2); // half burned
    gate.armCooldown("g1"); // success again → full refresh, not window + refresh
    assert.equal(gate.checkCooldown("g1"), WINDOW, "fresh full window from the 2nd arm");
    advance(WINDOW - 1);
    assert.equal(gate.checkCooldown("g1"), 1, "expiry sits exactly at the 2nd arm + window");
    advance(1);
    assert.equal(gate.checkCooldown("g1"), 0, "no stacked leftover blocks the retry");
  });

  it("other guilds are unaffected while one guild is armed", () => {
    const { gate, advance } = withClock();
    gate.armCooldown("g1");
    assert.equal(gate.checkCooldown("g2"), 0, "guild isolation");
    advance(1);
    assert.equal(gate.checkCooldown("g1"), WINDOW - 1, "own window ticks normally");
    gate.armCooldown("g2");
    assert.equal(gate.checkCooldown("g2"), WINDOW, "arming g2 is independent of g1");
    assert.equal(gate.checkCooldown("g1"), WINDOW - 1, "g1 untouched by g2's arm");
  });

  it("invalid guild ids never throw: check reports allowed, arm is a no-op", () => {
    const { gate } = withClock();
    for (const bad of [undefined, null, "", 0, {}, [], Symbol("s"), () => {}]) {
      assert.doesNotThrow(() => gate.checkCooldown(bad));
      assert.doesNotThrow(() => gate.armCooldown(bad));
      assert.equal(gate.checkCooldown(bad), 0, `${String(bad)} fails open`);
    }
    gate.armCooldown("g1"); // no poisoned state left behind
    assert.equal(gate.checkCooldown("g1"), WINDOW);
  });

  it("number/bigint ids normalize onto the string key", () => {
    const { gate } = withClock();
    gate.armCooldown(123);
    assert.equal(gate.checkCooldown("123"), WINDOW, "number arms the string key");
    gate.armCooldown(456n);
    assert.equal(gate.checkCooldown("456"), WINDOW, "bigint arms the string key");
  });

  it("backward clock jump clamps remaining to the full window", () => {
    let nowMs = 1_700_000_000_000;
    const gate = createSummarizeCooldownGate({ now: () => nowMs });
    gate.armCooldown("g1");
    nowMs -= 3_600_000; // system clock rolls back an hour
    assert.equal(gate.checkCooldown("g1"), WINDOW, "minutes reply never exceeds the window");
  });

  it("reset() clears every armed guild", () => {
    const { gate } = withClock();
    gate.armCooldown("g1");
    gate.armCooldown("g2");
    gate.reset();
    assert.equal(gate.checkCooldown("g1"), 0);
    assert.equal(gate.checkCooldown("g2"), 0);
  });
});

describe("summarizeCooldownMinutesRemaining (reply math rounds UP)", () => {
  it("maps remaining ms to whole minutes for the reply", () => {
    assert.equal(summarizeCooldownMinutesRemaining(0), 0, "not armed");
    assert.equal(summarizeCooldownMinutesRemaining(1), 1, "never '0 minutes' while armed");
    assert.equal(summarizeCooldownMinutesRemaining(5_000), 1);
    assert.equal(summarizeCooldownMinutesRemaining(300_000), 5);
    assert.equal(summarizeCooldownMinutesRemaining(354_000), 6, "5.9 min → 6");
    assert.equal(summarizeCooldownMinutesRemaining(599_999), 10);
    assert.equal(summarizeCooldownMinutesRemaining(WINDOW), 10, "fresh 10-min window");
  });

  it("garbage and negative input read as 'not armed'", () => {
    assert.equal(summarizeCooldownMinutesRemaining(-1), 0);
    assert.equal(summarizeCooldownMinutesRemaining(NaN), 0);
    assert.equal(summarizeCooldownMinutesRemaining(Infinity), 0);
    assert.equal(summarizeCooldownMinutesRemaining("soon"), 0);
    assert.equal(summarizeCooldownMinutesRemaining(undefined), 0);
  });
});

describe("module singleton (process-wide gate, real clock)", () => {
  beforeEach(() => resetSummarizeGuildCooldownForTests());

  it("arm then check: armed guild reports its window, others stay free", () => {
    assert.equal(checkSummarizeGuildCooldown("g1"), 0);
    armSummarizeGuildCooldown("g1");
    const remaining = checkSummarizeGuildCooldown("g1");
    assert.ok(remaining > WINDOW - 5_000 && remaining <= WINDOW, `got ${remaining}`);
    assert.equal(summarizeCooldownMinutesRemaining(remaining), 10);
    assert.equal(checkSummarizeGuildCooldown("g2"), 0, "guild isolation");
  });

  it("re-arming refreshs without stacking: remaining never exceeds the window", () => {
    armSummarizeGuildCooldown("g1");
    const first = checkSummarizeGuildCooldown("g1");
    armSummarizeGuildCooldown("g1");
    const second = checkSummarizeGuildCooldown("g1");
    assert.ok(second <= WINDOW, `no stacking: got ${second}`);
    assert.ok(second >= first - 50, `refresh not shrink: ${first} → ${second}`);
  });

  it("invalid ids and the reset seam behave", () => {
    armSummarizeGuildCooldown(null); // silent no-op
    assert.equal(checkSummarizeGuildCooldown(null), 0);
    armSummarizeGuildCooldown("g1");
    resetSummarizeGuildCooldownForTests();
    assert.equal(checkSummarizeGuildCooldown("g1"), 0, "reset clears the singleton");
  });
});
