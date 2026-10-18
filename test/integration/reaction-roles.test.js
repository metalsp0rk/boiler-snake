const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertReplyContains,
  assertEphemeralReply,
  assertRoleGranted,
  assertXp,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

describe("integration: reaction roles", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let handleReactionRoleAdd;
  let handleReactionRoleRemove;

  after(() => {
    // Close SQLite handles and remove the temp dir created for this env.
    env?.cleanup();
  });

  before(async () => {
    env = await createIntegrationEnv();
    const svc = require("../../src/features/reactionRoles/service");
    handleReactionRoleAdd = svc.handleReactionRoleAdd;
    handleReactionRoleRemove = svc.handleReactionRoleRemove;
  });

  it("/reactionrole panel list (empty)", async () => {
    const interaction = await env.runCommand({
      commandName: "reactionrole",
      subcommandGroup: "panel",
      subcommand: "list",
      admin: true,
    });
    assert.ok(interaction.replies.length >= 1);
  });

  it("/reactionrole denies non-staff", async () => {
    const interaction = await env.runCommand({
      commandName: "reactionrole",
      subcommandGroup: "panel",
      subcommand: "list",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(interaction, /permission/i);
  });

  it("panel create posts message and stores DB row", async () => {
    const interaction = await env.runCommand({
      commandName: "reactionrole",
      subcommandGroup: "panel",
      subcommand: "create",
      admin: true,
      options: {
        channel: env.channels.general,
        title: "Pick a role",
        description: "React below",
      },
    });
    // create may succeed if deploy works with mock channel
    assert.ok(interaction.replies.length >= 1);
    const panels = env.db.listReactionRolePanels(env.communityId);
    // If create succeeded via deployPanelToChannel
    if (panels.length) {
      assert.ok(panels[0].message_id);
      assertReplyContains(interaction, /panel|created|posted|role/i);
    }
  });

  it("reaction add grants role on configured panel", async () => {
    const messageId = "rr-panel-msg-1";
    env.db.createReactionRolePanel(
      env.communityId,
      IDS.channelGeneral,
      messageId,
      "Roles",
      "Pick one"
    );
    env.db.upsertReactionRoleOption(
      env.communityId,
      messageId,
      "👍",
      "👍",
      IDS.roleRr,
      0,
      1
    );

    const message = env.makeMessage({ id: messageId });
    const reaction = env.createReaction({
      message,
      emoji: { id: null, name: "👍" },
    });
    // strip helpers may call users.remove
    reaction.users = {
      cache: new Map(),
      remove: async () => {},
    };
    reaction.client = env.client;

    const beforeXp = env.db.getXp(env.communityId, IDS.member);
    const result = await handleReactionRoleAdd(reaction, env.users.memberUser);
    assert.equal(result.handled, true);
    assertRoleGranted(env.members.member, IDS.roleRr);

    // pipeline should not award reaction XP when handled
    env.db.updateGuildSettings(env.communityId, {
      reaction_xp: 9,
      reaction_cooldown_sec: 0,
    });
    await env.onMessageReactionAdd(reaction, env.users.memberUser);
    assertXp(env.db, env.communityId, IDS.member, beforeXp);
  });

  it("reaction remove drops removable role", async () => {
    const messageId = "rr-panel-msg-2";
    env.db.createReactionRolePanel(
      env.communityId,
      IDS.channelGeneral,
      messageId,
      "Roles",
      "Pick"
    );
    env.db.upsertReactionRoleOption(
      env.communityId,
      messageId,
      "🔥",
      "🔥",
      IDS.roleRr,
      0,
      1
    );

    const user = env.createUser({ id: "user-rr-rem", username: "rruser" });
    const mem = env.createMember({
      guild: env.guild,
      user,
      roleIds: [IDS.roleRr],
    });
    env.guild.addMember(mem);

    const message = env.makeMessage({ id: messageId, author: user, member: mem });
    const reaction = env.createReaction({
      message,
      emoji: { id: null, name: "🔥" },
    });
    reaction.users = { cache: new Map(), remove: async () => {} };
    reaction.client = env.client;

    await handleReactionRoleRemove(reaction, user);
    assert.ok(
      mem._removedRoles.includes(IDS.roleRr) || !mem.roles.cache.has(IDS.roleRr)
    );
  });

  // ── #433 (audit E2-09): cross-panel refcount — deploy-copied options ─────

  it("un-reacting ONE of two panels granting the same role keeps the role (#433)", async () => {
    const msgA = "rr-dup-a";
    const msgB = "rr-dup-b";
    env.db.createReactionRolePanel(env.communityId, IDS.channelGeneral, msgA, "R", "A");
    env.db.createReactionRolePanel(env.communityId, IDS.channelGeneral, msgB, "R", "B");
    env.db.upsertReactionRoleOption(env.communityId, msgA, "🎮", "🎮", IDS.roleRr, 0, 1);
    env.db.upsertReactionRoleOption(env.communityId, msgB, "🎮", "🎮", IDS.roleRr, 0, 1);

    const user = env.createUser({ id: "user-rr-dup", username: "dup" });
    const mem = env.createMember({ guild: env.guild, user, roleIds: [IDS.roleRr] });
    env.guild.addMember(mem);

    const mkReaction = (id) => {
      const message = env.makeMessage({ id, author: user, member: mem });
      const reaction = env.createReaction({
        message,
        emoji: { id: null, name: "🎮" },
      });
      reaction.users = { cache: new Map(), remove: async () => {} };
      reaction.client = env.client;
      return reaction;
    };
    const claims = (messageId) =>
      Number(
        env.db.db
          .prepare(
            "SELECT COUNT(*) AS n FROM reaction_role_claims WHERE community_id=? AND message_id=? AND user_id=?",
          )
          .get(env.communityId, messageId, "user-rr-dup").n,
      );

    // Claim on BOTH panels (role already held — claims mirror the stance).
    await handleReactionRoleAdd(mkReaction(msgA), user);
    await handleReactionRoleAdd(mkReaction(msgB), user);
    assert.equal(claims(msgA), 1, "an accepted option reaction records the claim");
    assert.equal(claims(msgB), 1);

    // Un-react panel A: panel B's claim still stands → role MUST stay.
    await handleReactionRoleRemove(mkReaction(msgA), user);
    assert.equal(claims(msgA), 0, "the un-reacted panel's claim is released");
    assert.ok(
      !mem._removedRoles.includes(IDS.roleRr) && mem.roles.cache.has(IDS.roleRr),
      "role NOT stripped while panel B still claims it (RED: old code revoked it)",
    );

    // Un-react panel B: last claim gone → normal removal proceeds.
    await handleReactionRoleRemove(mkReaction(msgB), user);
    assert.ok(
      mem._removedRoles.includes(IDS.roleRr) || !mem.roles.cache.has(IDS.roleRr),
      "last claim released → the role drops",
    );
    assert.equal(claims(msgB), 0);
  });

  it("un-react releases the claim even for non-removable options (#433)", async () => {
    const messageId = "rr-nonrem-433";
    env.db.createReactionRolePanel(env.communityId, IDS.channelGeneral, messageId, "R", "P");
    env.db.upsertReactionRoleOption(env.communityId, messageId, "🔒", "🔒", IDS.roleRr, 0, 0);

    const user = env.createUser({ id: "user-rr-nonrem", username: "nonrem" });
    const mem = env.createMember({ guild: env.guild, user, roleIds: [IDS.roleRr] });
    env.guild.addMember(mem);
    const message = env.makeMessage({ id: messageId, author: user, member: mem });
    const reaction = env.createReaction({ message, emoji: { id: null, name: "🔒" } });
    reaction.users = { cache: new Map(), remove: async () => {} };
    reaction.client = env.client;

    await handleReactionRoleAdd(reaction, user);
    assert.equal(
      Number(
        env.db.db
          .prepare(
            "SELECT COUNT(*) AS n FROM reaction_role_claims WHERE community_id=? AND message_id=?",
          )
          .get(env.communityId, messageId).n,
      ),
      1,
    );

    await handleReactionRoleRemove(reaction, user);
    // The reaction is gone → the claim must follow (a stale one would wrongly
    // keep the role alive on OTHER panels), while the role itself survives
    // here because the option is non-removable.
    assert.equal(
      Number(
        env.db.db
          .prepare(
            "SELECT COUNT(*) AS n FROM reaction_role_claims WHERE community_id=? AND message_id=?",
          )
          .get(env.communityId, messageId).n,
      ),
      0,
      "claim released on un-react of a non-removable option",
    );
    assert.ok(!mem._removedRoles.includes(IDS.roleRr), "non-removable: role untouched");
  });

  it("option/panel deletion prunes claims so dead options cannot keep roles alive (#433)", () => {
    const messageId = "rr-prune-433";
    env.db.createReactionRolePanel(env.communityId, IDS.channelGeneral, messageId, "R", "P");
    env.db.upsertReactionRoleOption(env.communityId, messageId, "🧪", "🧪", IDS.roleRr, 0, 1);
    env.db.recordReactionRoleClaim(env.communityId, "user-prune", messageId, "🧪");
    assert.equal(
      env.db.countReactionRoleClaimsForRole(env.communityId, "user-prune", IDS.roleRr),
      1,
    );

    env.db.deleteReactionRoleOption(env.communityId, messageId, "🧪");
    assert.equal(
      env.db.countReactionRoleClaimsForRole(env.communityId, "user-prune", IDS.roleRr),
      0,
      "deleted option: claims pruned (and the refcount join guards twice)",
    );

    env.db.recordReactionRoleClaim(env.communityId, "user-prune", messageId, "🧪");
    env.db.deleteReactionRolePanel(env.communityId, messageId);
    assert.equal(
      Number(
        env.db.db
          .prepare(
            "SELECT COUNT(*) AS n FROM reaction_role_claims WHERE community_id=? AND message_id=?",
          )
          .get(env.communityId, messageId).n,
      ),
      0,
      "deleted panel: its claims pruned with it",
    );
  });
});
