const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  levelFromXp,
  clampDelta,
  clampXpTotal,
  validateXpValue,
  MAX_SAFE_XP,
  MAX_XP_AWARD,
} = require("../src/core/xpMath");

describe("levelFromXp", () => {
  it("returns 0 for zero or negative XP", () => {
    assert.equal(levelFromXp(0, 100), 0);
    assert.equal(levelFromXp(-50, 100), 0);
  });

  it("uses factor 100 by default for invalid factors", () => {
    // level 1 starts at 100 XP with factor 100
    assert.equal(levelFromXp(100, null), 1);
    assert.equal(levelFromXp(100, 0), 1);
    assert.equal(levelFromXp(100, NaN), 1);
  });

  it("matches floor(sqrt(xp / factor))", () => {
    assert.equal(levelFromXp(0, 100), 0);
    assert.equal(levelFromXp(99, 100), 0);
    assert.equal(levelFromXp(100, 100), 1);
    assert.equal(levelFromXp(399, 100), 1);
    assert.equal(levelFromXp(400, 100), 2);
    assert.equal(levelFromXp(2500, 100), 5);
  });

  it("respects custom factors", () => {
    // L starts at L² * 50
    assert.equal(levelFromXp(50, 50), 1);
    assert.equal(levelFromXp(200, 50), 2);
  });
});

describe("clampDelta", () => {
  it("returns 0 for non-finite values", () => {
    assert.equal(clampDelta(NaN), 0);
    assert.equal(clampDelta(Infinity), 0);
    assert.equal(clampDelta(-Infinity), 0);
  });

  it("floors toward zero magnitude and preserves sign", () => {
    assert.equal(clampDelta(3.9), 3);
    assert.equal(clampDelta(-3.9), -3);
    assert.equal(clampDelta(0), 0);
  });

  it("caps magnitude at MAX_SAFE_XP", () => {
    assert.equal(clampDelta(MAX_SAFE_XP + 1000), MAX_SAFE_XP);
    assert.equal(clampDelta(-(MAX_SAFE_XP + 1000)), -MAX_SAFE_XP);
  });
});

describe("clampXpTotal", () => {
  it("maps non-finite to MAX_SAFE_XP", () => {
    assert.equal(clampXpTotal(NaN), MAX_SAFE_XP);
    assert.equal(clampXpTotal(Infinity), MAX_SAFE_XP);
  });

  it("clamps negatives and zero to 0", () => {
    assert.equal(clampXpTotal(-1), 0);
    assert.equal(clampXpTotal(0), 0);
  });

  it("floors and caps large values", () => {
    assert.equal(clampXpTotal(12.7), 12);
    assert.equal(clampXpTotal(MAX_SAFE_XP + 1), MAX_SAFE_XP);
  });
});

describe("validateXpValue", () => {
  it("allows null/undefined (unset option)", () => {
    assert.equal(validateXpValue(null, "Message"), null);
    assert.equal(validateXpValue(undefined, "Message"), null);
  });

  it("rejects non-finite or negative", () => {
    assert.match(validateXpValue(-1, "Message"), /non-negative/);
    assert.match(validateXpValue(NaN, "Voice"), /non-negative/);
  });

  it("rejects values above MAX_XP_AWARD", () => {
    assert.match(validateXpValue(MAX_XP_AWARD + 1, "Reaction"), /too large/);
  });

  it("accepts valid values including max", () => {
    assert.equal(validateXpValue(0, "Message"), null);
    assert.equal(validateXpValue(MAX_XP_AWARD, "Message"), null);
  });
});
