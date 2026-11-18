/**
 * #828 (wiring) — the mutation sites actually SCHEDULE the reconcile.
 *
 * Core reconcile law is pinned in level-roles-reconcile.test.js; this file
 * pins the TRIGGERS: /leveltorole set schedules a real pass that arms a
 * frozen holder (end-to-end through the router), /leveltorole remove does
 * NOT (the pair is deleted outright — nothing to reconcile), and /setxp
 * schedules only on an ACTUAL level_xp_factor change (a same-value save
 * must not fire an O(users) REST pass).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("./helpers/harness");

const ROLE_ID = "828200000000000001";

/** Drain microtasks/awaited steps until `fn` says so (or time out). */
async function until(fn, { tries = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return true;
    await new Promise((r) => setImmediate(r));
  }
  return false;
}

describe("level-role reconcile scheduling wiring (#828)", () => {
  /** @type {any} */
  let env;
  /** @type {any} */
  let reconcile;

  before(async () => {
    env = await createIntegrationEnv();
    reconcile = require("../src/features/levelRoles/reconcile");
  });

  after(async () => {
    reconcile.bindSupervisor(null);
    await env?.cleanup?.();
  });

  /** Spy supervisor: counts pass starts, refuses a client (pass skips). */
  function bindSpy() {
    const state = { calls: 0 };
    reconcile.bindSupervisor({
      discord: env.client,
      clientForCommunity: () => {
        state.calls += 1;
        return null; // pass logs no-client-skip and returns — zero side effects
      },
    });
    return state;
  }

  it("/leveltorole set arms a frozen holder end-to-end", async () => {
    // Frozen member: XP row exists, holds the role, sits at level 2; the
    // mapping about to be written requires 3. Pre-#828 nothing would ever
    // arm them — no XP event is coming.
    env.db.addXp(env.communityId, "u-frozen", 400);
    const user = env.createUser({ id: "u-frozen", username: "frozen" });
    const member = env.createMember({
      guild: env.guild,
      user,
      roleIds: [ROLE_ID],
    });
    env.guild.addMember(member);

    // The REAL supervisor: schedule → pass → syncMemberRoles arms.
    reconcile.bindSupervisor(env.supervisor);

    const inter = await env.runCommand({
      commandName: "leveltorole",
      subcommand: "set",
      admin: true,
      options: { role: { id: ROLE_ID }, level: 3, dropdays: 7 },
    });

    const armed = await until(() =>
      env.db
        .listPendingRoleDrops(env.communityId)
        .some((t) => t.user_id === "u-frozen" && t.role_id === ROLE_ID),
    );
    assert.ok(armed, "/leveltorole set must reconcile the frozen class NOW");
    // The reply keeps its promise (docs quote this copy).
    assert.match(env.lastReplyContent(inter), /rechecking level roles/i);
  });

  it("/leveltorole remove schedules NOTHING (pair deleted — nothing to reconcile)", async () => {
    const spy = bindSpy();
    await env.runCommand({
      commandName: "leveltorole",
      subcommand: "remove",
      admin: true,
      options: { role: { id: ROLE_ID } },
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(spy.calls, 0, "remove deletes mapping + drop state outright");
    assert.deepEqual(env.db.listPendingRoleDrops(env.communityId), []);
  });

  it("/setxp schedules ONLY on an actual level_xp_factor change", async () => {
    const spy = bindSpy();

    const changed = await env.runCommand({
      commandName: "setxp",
      admin: true,
      options: { factor: 400 }, // default is 100 → a real move
    });
    const scheduled = await until(() => spy.calls >= 1);
    assert.ok(scheduled, "a factor change moves EVERY threshold (L² × factor) — reconcile must run");
    assert.match(
      env.lastReplyContent(changed),
      /rechecking every member in the background/,
      "the embed must tell the admin the reconcile is running",
    );

    // Same-value save: the curve did not move — no pass, no notice.
    const noop = await env.runCommand({
      commandName: "setxp",
      admin: true,
      options: { factor: 400 },
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(spy.calls, 1, "a no-op factor save must NOT fire an O(users) pass");
    assert.doesNotMatch(
      env.lastReplyContent(noop),
      /rechecking every member/,
      "no-op save promises nothing",
    );
  });

  it("/setxp without a factor option never schedules (other XP knobs don't move levels)", async () => {
    const spy = bindSpy();
    await env.runCommand({
      commandName: "setxp",
      admin: true,
      options: { message: "7" },
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(spy.calls, 0);
  });
});
