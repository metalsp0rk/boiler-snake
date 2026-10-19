/**
 * #472 (XE-8): the absolute XP write left the production surface.
 *
 * `users.setXp` sat on the db facade with ZERO runtime callers — the
 * write style H10/#191 deliberately replaced (column-relative addXp/
 * applyDecay compute from the live row, "never from a value the caller
 * snapshotted earlier"). A reviveable absolute-write on the hardened XP
 * module is a standing invitation to reintroduce the lost-update class
 * and bypass the award funnel. The facade + repository bindings are now
 * pinned GONE here; deterministic seeding lives in test/helpers/xpSeed.js.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");
const { api: dbApi, cleanup } = loadDb();
const { seedXp } = require("./helpers/xpSeed");
const usersRepo = require("../src/db/repositories/users");
const { ensureCommunity } = require("../src/platform/community");

after(cleanup);

describe("absolute XP writes are test-only — #472 (XE-8)", () => {
  it("the db facade and the users repository expose no setXp", () => {
    assert.equal(dbApi.setXp, undefined, "facade binding is gone");
    assert.equal(usersRepo.setXp, undefined, "repository function is gone");
    // The RELATIVE write survives — it is the sanctioned production path.
    assert.equal(typeof dbApi.addXp, "function");
  });

  it("seedXp lands the absolute value (upsert, overwrite, same clamp)", () => {
    const cid = ensureCommunity({
      platform: "discord",
      instanceKey: "https://xp-seed.test",
      externalGuildId: "777",
    });
    seedXp(dbApi, cid, "u-seed", 500);
    assert.equal(dbApi.getXp(cid, "u-seed"), 500, "creates the row absolutely");
    seedXp(dbApi, cid, "u-seed", 120);
    assert.equal(dbApi.getXp(cid, "u-seed"), 120, "overwrites absolutely");
    seedXp(dbApi, cid, "u-seed", -5);
    assert.equal(dbApi.getXp(cid, "u-seed"), 0, "same clamp the old write used");
  });
});
