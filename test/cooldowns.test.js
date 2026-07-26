const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { key, sweepCooldownMap, isOnCooldown } = require("../src/core/cooldowns");

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

describe("isOnCooldown", () => {
  it("with zero cooldown always allows and stamps the map", () => {
    const map = new Map();
    const now = 1_000_000;
    assert.equal(isOnCooldown(map, "a", 0, now), false);
    assert.equal(map.get("a"), now);
    assert.equal(isOnCooldown(map, "a", 0, now + 1), false);
    assert.equal(map.get("a"), now + 1);
  });

  it("blocks within the window and allows after", () => {
    const map = new Map();
    const t0 = 1_000_000;
    assert.equal(isOnCooldown(map, "u", 20, t0), false);
    assert.equal(isOnCooldown(map, "u", 20, t0 + 5_000), true);
    assert.equal(isOnCooldown(map, "u", 20, t0 + 20_000), false);
    assert.equal(map.get("u"), t0 + 20_000);
  });
});
