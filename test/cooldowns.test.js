const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  key,
  sweepCooldownMap,
  isOnCooldown,
  markCooldown,
  reserveCooldown,
  releaseCooldownReservation,
} = require("../src/core/cooldowns");

describe("key", () => {
  it("joins guild and user ids", () => {
    assert.equal(key("g1", "u1"), "g1:u1");
  });
});

describe("sweepCooldownMap", () => {
  it("removes only stale entries", () => {
    const map = new Map();
    const now = Date.now();
    map.set("fresh", now);
    map.set("stale", now - 10_000);
    sweepCooldownMap(map, 5_000);
    assert.equal(map.has("fresh"), true);
    assert.equal(map.has("stale"), false);
  });
});

describe("isOnCooldown (check) + markCooldown (stamp) — #472 XE-7 split", () => {
  it("with zero cooldown always allows and never stamps on its own", () => {
    const map = new Map();
    const now = 1_000_000;
    assert.equal(isOnCooldown(map, "a", 0, now), false);
    assert.equal(map.has("a"), false, "the CHECK is pure — stamping is the caller's");
    markCooldown(map, "a", now);
    assert.equal(map.get("a"), now);
    assert.equal(isOnCooldown(map, "a", 0, now + 1), false, "cd=0 never blocks");
  });

  it("blocks within the window and allows after", () => {
    const map = new Map();
    const t0 = 1_000_000;
    assert.equal(isOnCooldown(map, "u", 20, t0), false);
    // The old combined isOnCooldown stamped HERE (on the check). The split
    // contract: a call that ends in failed work must leave the window FREE.
    assert.equal(map.has("u"), false, "a passed check alone stamps nothing (XE-7)");
    markCooldown(map, "u", t0);
    assert.equal(isOnCooldown(map, "u", 20, t0 + 5_000), true);
    assert.equal(isOnCooldown(map, "u", 20, t0 + 20_000), false);
    markCooldown(map, "u", t0 + 20_000);
    assert.equal(map.get("u"), t0 + 20_000);
  });

  it("a failed unit of work leaves the next attempt outside cooldown (XE-7 story)", () => {
    const map = new Map();
    const t0 = 1_000_000;
    // attempt 1: check passes, work THROWS → no mark
    assert.equal(isOnCooldown(map, "u", 20, t0), false);
    // ... doTheThing() threw; the caller never reaches markCooldown ...
    // attempt 2 (2 seconds later): still allowed — the window was never taken
    assert.equal(isOnCooldown(map, "u", 20, t0 + 2_000), false, "failed award must not consume the window");
    markCooldown(map, "u", t0 + 2_000);
    assert.equal(isOnCooldown(map, "u", 20, t0 + 3_000), true, "success starts the window");
  });
});

// #429 (audit XE-2): a sweeper horizon SMALLER than a configurable cooldown
// silently truncates that cooldown (entry evicted mid-window → last=0 →
// award). The shared constants keep the two in lockstep.
describe("sweep horizon vs max configurable cooldown (#429)", () => {
  const { MAX_CONFIG_COOLDOWN_SEC, COOLDOWN_SWEEP_MAX_AGE_MS } = require("../src/core/cooldowns");

  it("sweep horizon exceeds every configurable window", () => {
    assert.equal(MAX_CONFIG_COOLDOWN_SEC, 86_400, "one day is the config max");
    assert.ok(
      COOLDOWN_SWEEP_MAX_AGE_MS > MAX_CONFIG_COOLDOWN_SEC * 1000,
      "sweep must evict only past the max (+ slack)",
    );
  });

  it("a 7h-old entry survives the NEW sweep but died under the old 6h one", () => {
    const map = new Map([["k", Date.now() - 7 * 3_600_000]]);
    sweepCooldownMap(map, COOLDOWN_SWEEP_MAX_AGE_MS);
    assert.ok(map.has("k"), "msgcooldown 24h keeps its window across the sweep");
    // Sanity: prove the old horizon was the bug — same entry dies there.
    sweepCooldownMap(map, 6 * 3_600_000);
    assert.ok(!map.has("k"), "the retired 6h maxAge evicted mid-window (the bug)");
  });
});

// #894 (audit r4 F2): reserve-before-the-await closes the burst race the
// XE-7 stamp-after-award opened; the release half keeps the XE-7 fairness.
describe("reserveCooldown + releaseCooldownReservation — #894 reserve/settle", () => {
  it("reserve stamps immediately: a concurrent runner sees the window", () => {
    const map = new Map();
    const t0 = Date.now();
    assert.equal(isOnCooldown(map, "u", 60, t0), false, "gate opens");
    reserveCooldown(map, "u", t0);
    assert.equal(
      isOnCooldown(map, "u", 60, t0 + 5),
      true,
      "the SECOND concurrent pipeline is gated while the first awaits",
    );
  });

  it("a SUCCESSFUL release keeps the reservation as the window", () => {
    const map = new Map();
    const held = reserveCooldown(map, "u", 1_000);
    releaseCooldownReservation(map, "u", held, true);
    assert.equal(map.get("u"), 1_000);
  });

  it("a FAILED release restores the previous stamp (XE-7: no pay, no window)", () => {
    const map = new Map([["u", 500]]);
    const held = reserveCooldown(map, "u", 1_000);
    releaseCooldownReservation(map, "u", held, false);
    assert.equal(map.get("u"), 500, "the earlier live window is restored, not deleted");
  });

  it("a FAILED release with no previous stamp frees the key entirely", () => {
    const map = new Map();
    const held = reserveCooldown(map, "u", 1_000);
    releaseCooldownReservation(map, "u", held, false);
    assert.equal(map.has("u"), false, "a fresh user whose award failed keeps the gate open");
  });

  it("a losing rollback never wipes a newer reservation", () => {
    const map = new Map();
    const loser = reserveCooldown(map, "u", 1_000);
    reserveCooldown(map, "u", 2_000); // a newer reservation owns the slot now
    releaseCooldownReservation(map, "u", loser, false);
    assert.equal(map.get("u"), 2_000, "the winner's window survives the loser's rollback");
  });
});
