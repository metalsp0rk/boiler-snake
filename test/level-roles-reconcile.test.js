/**
 * #828 — config-change level-role reconcile (core pass).
 *
 * The frozen class (XP never changes again: decayed-to-0 or decay-exempt
 * with msg_xp=0) never re-enters syncMemberRoles. When an ADMIN moves a
 * threshold — `/leveltorole set` or a `level_xp_factor` change (curve is
 * L² × factor, so every threshold moves at once) — those members sit on
 * the WRONG side of the mapping forever: stale holders keep the role with
 * no grace timer (below_since stays NULL → the daily sweeper never sees
 * them), and newly-qualifying members are never granted.
 *
 * reconcileLevelRoles runs one pass per community over `users`, invoking
 * the EXISTING syncMemberRoles semantics per member. These pins cover the
 * arm/grant/clear/removal outcomes, the edge-degradation posture (never
 * throw), the in-flight guard, and the unbound-scheduler contract.
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { loadDb } = require("./helpers/env");

const GUILD = "828000000000000001";
const ROLE_ID = "828100000000000001";

describe("level-role config reconcile (#828)", () => {
  /** @type {object} */
  let api;
  /** @type {() => void} */
  let cleanup;
  /** @type {object} */
  let reconcile;
  let CID = null;

  before(() => {
    const loaded = loadDb();
    api = loaded.api;
    cleanup = loaded.cleanup;
    // Bind AFTER loadDb (require-cache reset) so this module's db and the
    // repositories agree.
    reconcile = require("../src/features/levelRoles/reconcile");
    const { ensureCommunity } = require("../src/platform/community");
    CID = ensureCommunity({
      platform: "discord",
      instanceKey: "discord",
      externalGuildId: GUILD,
    });
  });

  after(() => {
    reconcile.bindSupervisor(null);
    cleanup?.();
  });

  beforeEach(() => {
    reconcile.bindSupervisor(null);
    // Clean per-test mapping + timers (direct SQL is fine here; the
    // repositories are pinned elsewhere).
    api.db
      .prepare("DELETE FROM role_drop_state WHERE community_id=?")
      .run(CID);
    api.db.prepare("DELETE FROM level_roles WHERE community_id=?").run(CID);
    api.db.prepare("DELETE FROM users WHERE community_id=?").run(CID);
  });

  /** Minimal discord.js-shaped member (sync only touches roles). */
  function fakeMember(userId, roleIds = []) {
    const cache = new Map([[GUILD, { id: GUILD }]]);
    for (const r of roleIds) cache.set(r, { id: r });
    const added = [];
    const removed = [];
    const member = {
      id: userId,
      added,
      removed,
      roles: {
        cache,
        add: async (roleId) => {
          cache.set(roleId, { id: roleId });
          added.push(roleId);
          return member;
        },
        remove: async (roleId) => {
          cache.delete(roleId);
          removed.push(roleId);
          return member;
        },
      },
    };
    return member;
  }

  /**
   * Supervisor over a fake guild whose member roster is `roster`
   * (Map<userId, member|Promise>). Unrostered users REJECT like real
   * discord.js 10026 — the pass must treat them as unfetchable.
   */
  function makeSupervisor(roster = new Map(), opts = {}) {
    const guild = {
      id: GUILD,
      members: {
        fetch: async (id) => {
          const entry = roster.get(id);
          if (entry === undefined) throw new Error(`Member ${id} not found`);
          return await entry;
        },
      },
    };
    const client = { guilds: { fetch: async () => guild } };
    const outbound = {
      addRole: async () => ({ ok: true }),
      removeRole: async () => ({ ok: true }),
      fetchMember: async () => null,
    };
    return {
      discord: opts.noDiscord ? null : client,
      clientForCommunity: () => (opts.noClient ? null : outbound),
    };
  }

  function seedUser(userId, xp) {
    api.addXp(CID, userId, 1); // create the row through the repository
    api.db
      .prepare("UPDATE users SET xp=? WHERE community_id=? AND user_id=?")
      .run(xp, CID, userId);
  }

  const timers = () => api.listPendingRoleDrops(CID);
  const timerFor = (userId) =>
    timers().find((t) => t.user_id === userId) || null;

  it("arms frozen HOLDERS below the threshold (the core gap)", async () => {
    // factor 100 → level = floor(sqrt(xp/100)). Lvl-3 role, holder at
    // level 2 (xp 400): frozen, no timer → must arm now.
    api.upsertLevelRole(CID, ROLE_ID, 3, 7);
    seedUser("u-holder", 400);
    const member = fakeMember("u-holder", [ROLE_ID]);
    const sup = makeSupervisor(new Map([["u-holder", member]]));

    const out = await reconcile.reconcileLevelRoles(sup, CID, "test-arm");
    assert.equal(out.skipped, null);
    assert.equal(out.checked, 1);
    const t = timerFor("u-holder");
    assert.ok(t, "#828: below-threshold holder never armed unless an XP event arrives");
    assert.equal(t.role_id, ROLE_ID);
    assert.equal(t.drop_grace_days, 7);
    // Arming is NOT removal — the role stays while grace runs.
    assert.deepEqual(member.removed, []);
  });

  it("does NOT arm non-holders (XE-10: no stranded timers)", async () => {
    api.upsertLevelRole(CID, ROLE_ID, 3, 7);
    seedUser("u-plain", 400); // below threshold but never held the role
    const member = fakeMember("u-plain", []);
    const sup = makeSupervisor(new Map([["u-plain", member]]));

    await reconcile.reconcileLevelRoles(sup, CID, "test-noarm");
    assert.equal(timerFor("u-plain"), null, "blind SQL arming was the wrong fix; sync law wins");
    assert.deepEqual(member.added, [], "below-threshold members must not be granted");
  });

  it("GRANTS frozen members who now meet a lowered threshold (mirror gap)", async () => {
    // Admin lowers the mapping to L1; frozen member sits at level 2
    // without the role. Pre-fix they never got it — no XP event ever.
    api.upsertLevelRole(CID, ROLE_ID, 1, 7);
    seedUser("u-qualify", 400);
    const member = fakeMember("u-qualify", []);
    const sup = makeSupervisor(new Map([["u-qualify", member]]));

    const out = await reconcile.reconcileLevelRoles(sup, CID, "test-grant");
    assert.deepEqual(member.added, [ROLE_ID], "the grant-side gap of #828");
    assert.equal(out.granted, 1);
  });

  it("preserves an existing below_since (arm is once, not refreshed)", async () => {
    api.upsertLevelRole(CID, ROLE_ID, 3, 7);
    seedUser("u-timer", 400);
    const seeded = Date.now() - 5 * 24 * 60 * 60 * 1000; // 5 days into grace
    api.setRoleBelowSince(CID, "u-timer", ROLE_ID, seeded);
    const member = fakeMember("u-timer", [ROLE_ID]);
    const sup = makeSupervisor(new Map([["u-timer", member]]));

    await reconcile.reconcileLevelRoles(sup, CID, "test-preserve");
    const t = timerFor("u-timer");
    assert.equal(t.below_since, seeded, "grace elapsed time must not reset on reconcile");
    // 5d < 7d grace → still holding.
    assert.deepEqual(member.removed, []);
  });

  it("removes after the grace already elapsed (same law, sooner)", async () => {
    api.upsertLevelRole(CID, ROLE_ID, 3, 7);
    seedUser("u-expired", 400);
    api.setRoleBelowSince(
      CID,
      "u-expired",
      ROLE_ID,
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    );
    const member = fakeMember("u-expired", [ROLE_ID]);
    const sup = makeSupervisor(new Map([["u-expired", member]]));

    const out = await reconcile.reconcileLevelRoles(sup, CID, "test-remove");
    assert.deepEqual(member.removed, [ROLE_ID]);
    assert.equal(out.removed, 1);
    assert.equal(timerFor("u-expired"), null, "timer clears with the removal");
  });

  it("degrades on every missing edge — never throws, never arms", async () => {
    const r1 = await reconcile.reconcileLevelRoles(null, CID, "test-nosup");
    assert.equal(r1.skipped, "no-client");

    const r2 = await reconcile.reconcileLevelRoles(
      makeSupervisor(new Map(), { noClient: true }),
      CID,
      "test-noclient",
    );
    assert.equal(r2.skipped, "no-client");

    const r3 = await reconcile.reconcileLevelRoles(
      makeSupervisor(new Map(), { noDiscord: true }),
      CID,
      "test-nodiscord",
    );
    assert.equal(r3.skipped, "no-discord-client");

    const r4 = await reconcile.reconcileLevelRoles(
      makeSupervisor(new Map()),
      999999,
      "test-nocommunity",
    );
    assert.equal(r4.skipped, "no-community-row");
  });

  it("skips unfetchable members and keeps sweeping the rest (rule 5)", async () => {
    api.upsertLevelRole(CID, ROLE_ID, 3, 7);
    seedUser("u-gone", 400);
    seedUser("u-here", 400);
    const here = fakeMember("u-here", [ROLE_ID]);
    // u-gone is NOT in the roster → fetch rejects (10026-shaped).
    const sup = makeSupervisor(new Map([["u-here", here]]));

    const out = await reconcile.reconcileLevelRoles(sup, CID, "test-partial");
    assert.equal(out.checked, 1, "only the fetchable member was reconciled");
    assert.ok(timerFor("u-here"), "the loop continued past the failed fetch");
  });

  it("fluxer rows need elevation; without it the pass skips quietly", async () => {
    const { ensureCommunity, getCommunityById } = require("../src/platform/community");
    const fxId = ensureCommunity({
      platform: "fluxer",
      instanceKey: "fluxer-test",
      externalGuildId: "828000000000000FXX",
    });
    const roster = new Map([["u-fx", fakeMember("u-fx", [ROLE_ID])]]);
    const sup = {
      discord: null,
      clientForCommunity: () => ({
        addRole: async () => ({ ok: true }),
        removeRole: async () => ({ ok: true }),
        fetchMember: async (_cid, userId) => roster.get(userId) ?? null,
      }),
    };

    // Flag 0 (schema default): K8 gate → skip, zero harm.
    assert.equal(Number(getCommunityById(fxId).elevatedPermissions), 0);
    const r0 = await reconcile.reconcileLevelRoles(sup, fxId, "test-fluxer");
    assert.equal(r0.skipped, "fluxer-not-elevated");

    api.db
      .prepare("UPDATE communities SET elevated_permissions=1 WHERE id=?")
      .run(fxId);
    api.upsertLevelRole(fxId, ROLE_ID, 3, 7);
    api.addXp(fxId, "u-fx", 400);
    const r1 = await reconcile.reconcileLevelRoles(sup, fxId, "test-fluxer");
    assert.equal(r1.skipped, null);
    assert.equal(r1.checked, 1, "elevated fluxer pass runs through fetchMember");
    assert.ok(
      api.listPendingRoleDrops(fxId).some((t) => t.user_id === "u-fx"),
      "fluxer holders arm through the same sync law",
    );
  });

  it("in-flight guard: a second schedule for the same community is refused", async () => {
    api.upsertLevelRole(CID, ROLE_ID, 3, 7);
    seedUser("u-slow", 400);

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const member = fakeMember("u-slow", [ROLE_ID]);
    const guild = {
      id: GUILD,
      members: {
        fetch: async () => {
          await gate;
          return member;
        },
      },
    };
    const sup = {
      discord: { guilds: { fetch: async () => guild } },
      clientForCommunity: () => ({
        addRole: async () => ({ ok: true }),
        removeRole: async () => ({ ok: true }),
        fetchMember: async () => null,
      }),
    };

    const first = reconcile.reconcileLevelRoles(sup, CID, "test-first");
    // Let the pass reach the gated fetch.
    for (let i = 0; i < 10 && !reconcile.isReconcileInFlight(CID); i++) {
      await new Promise((r) => setImmediate(r));
    }
    assert.ok(reconcile.isReconcileInFlight(CID), "pass is mid-flight");
    const second = await reconcile.reconcileLevelRoles(sup, CID, "test-second");
    assert.equal(second.skipped, "in-flight");
    release();
    const out = await first;
    assert.equal(out.skipped, null);
    assert.equal(reconcile.isReconcileInFlight(CID), false);
  });

  it("scheduler: unbound is a loud false; bound fires the pass", async () => {
    assert.equal(
      reconcile.scheduleLevelRoleReconcile(CID, "test-unbound"),
      false,
      "pre-boot/web-only surfaces must not crash the accepted write",
    );

    api.upsertLevelRole(CID, ROLE_ID, 3, 7);
    seedUser("u-sched", 400);
    const member = fakeMember("u-sched", [ROLE_ID]);
    reconcile.bindSupervisor(makeSupervisor(new Map([["u-sched", member]])));
    assert.equal(reconcile.scheduleLevelRoleReconcile(CID, "test-bound"), true);

    // queueMicrotask + awaited steps: poll for the terminal effect.
    let armed = null;
    for (let i = 0; i < 50 && !(armed = timerFor("u-sched")); i++) {
      await new Promise((r) => setImmediate(r));
    }
    assert.ok(armed, "scheduled pass armed the frozen holder");
  });
});
