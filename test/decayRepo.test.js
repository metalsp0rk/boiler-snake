const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");

/**
 * Unit tests for the H10 (#191) remediation at the REPOSITORY level:
 * users.applyDecay must write a value RELATIVE to the CURRENT stored XP
 * (floor(xp * (1 - rate))), never a caller-computed absolute snapshot.
 */
describe("users.applyDecay (relative XP decay, #191)", () => {
  let api;
  let communityId;
  let cleanup;

  before(() => {
    // Contract: loadDb() first — fresh temp SQLite, migrations applied,
    // nothing touches the project-root xpbot.sqlite.
    ({ api, cleanup } = loadDb());
    communityId = communityKey("g-decay-repo");
  });

  after(() => cleanup?.());

  const seedXp = (userId, xp) => {
    api.setXp(communityId, userId, xp);
    return api.getXp(communityId, userId);
  };

  it("decays relative to the CURRENT stored value, not a stale read", () => {
    // Simulates the H10 race: enumerate (reads 1000) → award 500 → decay.
    seedXp("u-race", 1000);
    const enumerated = api.getXp(communityId, "u-race");
    api.addXp(communityId, "u-race", 500); // XP earned "mid-loop"
    const res = api.applyDecay(communityId, "u-race", 0.1);
    assert.equal(enumerated, 1000); // stale snapshot would have written 900
    assert.deepEqual(res, { before_xp: 1500, after_xp: 1350 });
    assert.equal(api.getXp(communityId, "u-race"), 1350);
  });

  it("floors to integers, matching the historical JS semantics", () => {
    seedXp("u-floor", 41);
    // floor(41 * (1 - 0.25)) = floor(30.75) = 30 — same as Math.floor in JS
    assert.deepEqual(api.applyDecay(communityId, "u-floor", 0.25), {
      before_xp: 41,
      after_xp: 30,
    });
    assert.equal(api.getXp(communityId, "u-floor"), 30);
  });

  it("xp 0 stays 0 (no-op: no write, nothing to audit)", () => {
    seedXp("u-zero", 0);
    assert.equal(api.applyDecay(communityId, "u-zero", 0.5), null);
    assert.equal(api.getXp(communityId, "u-zero"), 0);
  });

  it("pct 100 wipes to 0", () => {
    seedXp("u-wipe", 1234);
    assert.deepEqual(api.applyDecay(communityId, "u-wipe", 1), {
      before_xp: 1234,
      after_xp: 0,
    });
    assert.equal(api.getXp(communityId, "u-wipe"), 0);
  });

  it("small xp with large pct floors to 0, never negative", () => {
    seedXp("u-small", 19);
    // floor(19 * 0.05) = 0 — pins the audit's "never reaches zero" doc fix
    assert.deepEqual(api.applyDecay(communityId, "u-small", 0.95), {
      before_xp: 19,
      after_xp: 0,
    });
    assert.equal(api.getXp(communityId, "u-small"), 0);
  });

  it("pct 0 and invalid rates are no-ops that leave the row untouched", () => {
    seedXp("u-noop", 777);
    for (const bad of [0, -0.5, NaN, undefined, null, "", "abc"]) {
      assert.equal(api.applyDecay(communityId, "u-noop", bad), null);
      assert.equal(api.getXp(communityId, "u-noop"), 777);
    }
    // A rate below float resolution (1 - rate rounds to 1) is also a no-op.
    assert.equal(api.applyDecay(communityId, "u-noop", 1e-17), null);
    assert.equal(api.getXp(communityId, "u-noop"), 777);
  });

  it("rate > 1 clamps to a full wipe", () => {
    seedXp("u-over", 500);
    assert.deepEqual(api.applyDecay(communityId, "u-over", 2.5), {
      before_xp: 500,
      after_xp: 0,
    });
  });

  it("untracked user: null result and NO users row created", () => {
    assert.equal(api.applyDecay(communityId, "u-ghost", 0.5), null);
    assert.equal(api.getUser(communityId, "u-ghost"), null);
  });

  it("MAX_SAFE totals decay exactly and stay within the clamp", () => {
    seedXp("u-max", Number.MAX_SAFE_INTEGER);
    const res = api.applyDecay(communityId, "u-max", 0.5);
    assert.equal(res.before_xp, Number.MAX_SAFE_INTEGER);
    assert.equal(res.after_xp, 4503599627370495); // floor(MAX_SAFE * 0.5)
    assert.ok(res.after_xp <= api.MAX_SAFE_XP);
    assert.equal(api.getXp(communityId, "u-max"), 4503599627370495);
  });
});
