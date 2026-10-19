/**
 * #469 (E2-10): react → un-react back-to-back can no longer strand a role.
 *
 * Old code ran both arms concurrently: the REMOVE arm read
 * `member.roles.cache` while the ADD arm's `roles.add()` was still in
 * flight, saw "no role", and SKIPPED the removal — the member kept a role
 * they had un-claimed and nothing ever reconciled it. Every claim mutation
 * is now serialized per (community, user, role): the second event reads
 * exactly what the first COMMITTED.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const { IDS } = require("../helpers/fixtures");

describe("integration: reaction-role claim race (#469 E2-10)", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let svc;

  after(() => env?.cleanup());

  const messageId = "rr-race-panel";

  before(async () => {
    env = await createIntegrationEnv();
    svc = require("../../src/features/reactionRoles/service");
    env.db.createReactionRolePanel(
      env.communityId,
      IDS.channelGeneral,
      messageId,
      "Roles",
      "Pick one",
    );
    env.db.upsertReactionRoleOption(env.communityId, messageId, "⚡", "⚡", IDS.roleRr, 0, 1);
  });

  /**
   * A member whose roles.add() mirrors the real in-flight shape: the cache
   * only shows the role AFTER the REST call resolves — exactly the window
   * the remove arm used to read through.
   */
  function racingMember(user, { instantAdd = false } = {}) {
    const held = new Set([env.guild.id]);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const state = { added: [], removed: [] };
    const member = {
      id: user.id,
      user,
      guild: env.guild,
      _state: state,
      roles: {
        cache: {
          has: (id) => held.has(id),
          keys: () => held.keys(),
        },
        add: async (id) => {
          if (!instantAdd) await sleep(30); // in flight: cache shows NOTHING
          held.add(id);
          state.added.push(id);
        },
        remove: async (id) => {
          await sleep(5);
          held.delete(id);
          state.removed.push(id);
        },
      },
    };
    return member;
  }

  function mkReaction() {
    const message = env.makeMessage({ id: messageId });
    const reaction = env.createReaction({
      message,
      emoji: { id: null, name: "⚡" },
    });
    reaction.users = { cache: new Map(), remove: async () => {} };
    reaction.client = env.client;
    return reaction;
  }

  it("add-in-flight then un-react: the revoke sees what the add committed", async () => {
    const user = env.createUser({ id: "user-race-1", username: "flipflop" });
    const member = racingMember(user);
    env.guild.members.fetch = async () => member; // the handler's fetch seam

    const reaction = mkReaction();

    // The race itself: fire BOTH without awaiting the first.
    const addP = svc.handleReactionRoleAdd(reaction, user);
    const removeP = svc.handleReactionRoleRemove(reaction, user);
    await Promise.all([addP, removeP]);

    assert.deepEqual(member._state.added, [IDS.roleRr], "the react claimed the role");
    assert.ok(
      member._state.removed.includes(IDS.roleRr),
      "the un-react must revoke — pre-fix it read the pre-add cache and skipped",
    );
    assert.equal(
      member.roles.cache.has(IDS.roleRr),
      false,
      "final state after react+un-react is NO role (pre-fix: stranded role, claim row gone)",
    );
  });

  it("the lock map drains (no unbounded chains)", async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    assert.equal(svc._roleClaimLockCount(), 0, "idle ⇒ zero retained keys");
  });

  it("sequential claim still grants and records the claim (parity)", async () => {
    const user = env.createUser({ id: "user-race-2", username: "normal" });
    const member = racingMember(user, { instantAdd: true });
    env.guild.members.fetch = async () => member;

    await svc.handleReactionRoleAdd(mkReaction(), user);

    assert.deepEqual(member._state.added, [IDS.roleRr]);
    assert.equal(
      env.db.countReactionRoleClaimsForRole(env.communityId, user.id, IDS.roleRr),
      1,
      "the claim row rides inside the lock and still lands",
    );
  });
});
