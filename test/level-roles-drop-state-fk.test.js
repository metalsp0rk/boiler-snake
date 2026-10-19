/**
 * #469 (DB-9/DB-10): the level-role pair is a DATABASE invariant now.
 *
 * Migration 057 rebuilt role_drop_state with FK→communities plus a composite
 * FK→level_roles(community_id, role_id) ON DELETE CASCADE, and guild_settings
 * with FK→communities(id). The repository pair-delete got the matching
 * transaction. Together: the orphan class (drop-state row stranded by a
 * deleted level_role, settings on an unregistered community) is impossible,
 * not merely unlikely — and deleteLevelRole can no longer half-commit.
 *
 * RED notes (pre-057 schema): arms 1–4 all pass silently on the FK-free,
 * autocommit world — insert the orphan, strand the state, keep the half
 * delete. That is exactly the class this finding filed.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env"); // CONTRACT: temp DB before src/
const { api, cleanup } = loadDb();

const migration057 = require("../src/db/migrations/057_level_role_fk");
// ensureGuildSettings is the repository-level INSERT (not a facade export);
// the FK under test lives on the same connection.
const { ensureGuildSettings } = require("../src/db/repositories/guildSettings");

after(cleanup);

const CID = communityKey("940000000000004609");
const ROLE = "860000000000000001";
const USER = "870000000000000001";

describe("#469 (DB-9): role_drop_state refuses what no invariant explains", () => {
  it("a drop-state row for a non-CONFIGURED role is rejected by FK", () => {
    assert.throws(
      () => api.setRoleBelowSince(CID, USER, "role-never-configured", Date.now()),
      /FOREIGN KEY/,
      "pre-057 the insert happily created the orphan class by hand",
    );
  });

  it("a drop-state row for an unregistered community is rejected by FK", () => {
    // 424242 passes assertCommunityId (positive integer) but is no row in
    // communities — and cannot even reach the composite leg without the
    // community surviving first. Either FK leg firing is the point.
    assert.throws(
      () => api.setRoleBelowSince(424242, USER, ROLE, Date.now()),
      /FOREIGN KEY/,
    );
  });

  it("deleting the level_roles row CASCADES the drop-state rows away", () => {
    api.upsertLevelRole(CID, ROLE, 5, 7);
    api.setRoleBelowSince(CID, USER, ROLE, 1234);
    assert.equal(api.getRoleDropState(CID, USER, ROLE).below_since, 1234);

    // Raw delete BYPASSES the repository pair on purpose: the DB must hold
    // the invariant even when application code forgets to.
    api.db.prepare("DELETE FROM level_roles WHERE community_id=? AND role_id=?").run(CID, ROLE);

    assert.equal(
      api.getRoleDropState(CID, USER, ROLE),
      undefined,
      "ON DELETE CASCADE: the DB-10 orphan cannot outlive its role",
    );
  });

  it("guild_settings refuses an unregistered community (no silent orphan config)", () => {
    assert.throws(() => ensureGuildSettings(424242), /FOREIGN KEY/);
    ensureGuildSettings(CID); // the registered path works untouched
  });

  it("migration 057 is ledger-less replay-safe (idempotent up())", () => {
    api.upsertLevelRole(CID, ROLE, 5, 7);
    api.setRoleBelowSince(CID, USER, ROLE, 4321);

    migration057.up(api.db); // second run: sweep + gated rebuilds all skip/keep

    assert.equal(api.getRoleDropState(CID, USER, ROLE).below_since, 4321, "data survives replay");
    const sql = api.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='role_drop_state'")
      .get().sql;
    assert.match(sql, /REFERENCES\s+communities/i);
    assert.match(sql, /REFERENCES\s+level_roles\s*\(community_id,\s*role_id\)/i);
  });
});

describe("#469 (DB-10): deleteLevelRole is an all-or-nothing pair", () => {
  it("a failure on the second delete rolls the FIRST delete back", () => {
    api.upsertLevelRole(CID, ROLE, 5, 7);
    api.setRoleBelowSince(CID, USER, ROLE, 9999);

    // Arm a crash on the drop-state delete: pre-transaction the role row was
    // already committed — role gone, drop-state stranded forever (DB-10).
    const realPrepare = api.db.prepare.bind(api.db);
    api.db.prepare = (sql) => {
      if (typeof sql === "string" && sql.includes("DELETE FROM role_drop_state")) {
        throw new Error("SIMULATED MID-PAIR CRASH");
      }
      return realPrepare(sql);
    };
    try {
      assert.throws(() => api.deleteLevelRole(CID, ROLE), /SIMULATED MID-PAIR CRASH/);
    } finally {
      api.db.prepare = realPrepare;
    }

    assert.ok(
      api.db
        .prepare("SELECT 1 FROM level_roles WHERE community_id=? AND role_id=?")
        .get(CID, ROLE),
      "the transaction rolled the role delete back — no half-committed pair",
    );
    assert.equal(api.getRoleDropState(CID, USER, ROLE).below_since, 9999);
  });

  it("the clean path still removes BOTH rows", () => {
    api.deleteLevelRole(CID, ROLE);
    assert.equal(
      api.db.prepare("SELECT 1 FROM level_roles WHERE community_id=? AND role_id=?").get(CID, ROLE),
      undefined,
    );
    assert.equal(api.getRoleDropState(CID, USER, ROLE), undefined);
  });
});
