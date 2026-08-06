const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { loadDb } = require("./helpers/env");

describe("staff roles levels", () => {
  /** @type {ReturnType<typeof loadDb>["api"]} */
  let db;

  before(() => {
    db = loadDb().api;
  });

  it("defaults add to senior and supports junior", () => {
    db.addStaffRole("g1", "role-a");
    let row = db.getStaffRole("g1", "role-a");
    assert.equal(row.level, "senior");

    db.addStaffRole("g1", "role-b", "junior");
    row = db.getStaffRole("g1", "role-b");
    assert.equal(row.level, "junior");

    const all = db.listStaffRoles("g1");
    assert.equal(all.length, 2);

    const seniors = db.listSeniorStaffRoles("g1");
    assert.equal(seniors.length, 1);
    assert.equal(seniors[0].role_id, "role-a");

    const juniors = db.listStaffRoles("g1", { level: "junior" });
    assert.equal(juniors.length, 1);
    assert.equal(juniors[0].role_id, "role-b");
  });

  it("memberHasStaffRole is any level; senior check is senior only", () => {
    db.addStaffRole("g2", "sr", "senior");
    db.addStaffRole("g2", "jr", "junior");

    assert.equal(db.memberHasStaffRole("g2", ["jr"]), true);
    assert.equal(db.memberHasStaffRole("g2", ["sr"]), true);
    assert.equal(db.memberHasStaffRole("g2", ["other"]), false);

    assert.equal(db.memberHasSeniorStaffRole("g2", ["jr"]), false);
    assert.equal(db.memberHasSeniorStaffRole("g2", ["sr"]), true);
    assert.equal(db.memberHasSeniorStaffRole("g2", ["jr", "sr"]), true);
  });

  it("setStaffRoleLevel and upsert on add", () => {
    db.addStaffRole("g3", "r1", "junior");
    assert.equal(db.getStaffRole("g3", "r1").level, "junior");

    assert.equal(db.setStaffRoleLevel("g3", "r1", "senior"), true);
    assert.equal(db.getStaffRole("g3", "r1").level, "senior");

    db.addStaffRole("g3", "r1", "junior"); // upsert
    assert.equal(db.getStaffRole("g3", "r1").level, "junior");

    assert.equal(db.setStaffRoleLevel("g3", "missing", "senior"), false);
  });

  it("normalizeStaffLevel", () => {
    assert.equal(db.normalizeStaffLevel("junior"), "junior");
    assert.equal(db.normalizeStaffLevel("JR"), "junior");
    assert.equal(db.normalizeStaffLevel("senior"), "senior");
    assert.equal(db.normalizeStaffLevel("nope"), "senior");
    assert.equal(db.normalizeStaffLevel(null), "senior");
  });
});
