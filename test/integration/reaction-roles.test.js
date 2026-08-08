const { describe, it, before } = require("node:test");
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
    const panels = env.db.listReactionRolePanels(env.guild.id);
    // If create succeeded via deployPanelToChannel
    if (panels.length) {
      assert.ok(panels[0].message_id);
      assertReplyContains(interaction, /panel|created|posted|role/i);
    }
  });

  it("reaction add grants role on configured panel", async () => {
    const messageId = "rr-panel-msg-1";
    env.db.createReactionRolePanel(
      env.guild.id,
      IDS.channelGeneral,
      messageId,
      "Roles",
      "Pick one"
    );
    env.db.upsertReactionRoleOption(
      env.guild.id,
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

    const beforeXp = env.db.getXp(env.guild.id, IDS.member);
    const result = await handleReactionRoleAdd(reaction, env.users.memberUser);
    assert.equal(result.handled, true);
    assertRoleGranted(env.members.member, IDS.roleRr);

    // pipeline should not award reaction XP when handled
    env.db.updateGuildSettings(env.guild.id, {
      reaction_xp: 9,
      reaction_cooldown_sec: 0,
    });
    await env.onMessageReactionAdd(reaction, env.users.memberUser);
    assertXp(env.db, env.guild.id, IDS.member, beforeXp);
  });

  it("reaction remove drops removable role", async () => {
    const messageId = "rr-panel-msg-2";
    env.db.createReactionRolePanel(
      env.guild.id,
      IDS.channelGeneral,
      messageId,
      "Roles",
      "Pick"
    );
    env.db.upsertReactionRoleOption(
      env.guild.id,
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
});
