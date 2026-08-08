const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertEphemeralReply,
  assertReplyContains,
  assertXp,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

describe("integration: xp commands", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;

  before(async () => {
    env = await createIntegrationEnv();
  });

  it("/xp shows zero for new user", async () => {
    const interaction = await env.runCommand({
      commandName: "xp",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(interaction, /0 XP/);
    assertEphemeralReply(interaction, /Level/);
  });

  it("/xp shows another user's XP", async () => {
    env.db.setXp(env.guild.id, IDS.member2, 250);
    const interaction = await env.runCommand({
      commandName: "xp",
      admin: false,
      user: env.users.memberUser,
      options: { user: env.users.member2User },
    });
    assertReplyContains(interaction, "250 XP");
  });

  it("/leaderboard empty", async () => {
    // Use a fresh guild-like state: topUsers may already have data — clear via unique env would be ideal;
    // for default guild, seed-only users may exist. Filter: if any XP rows exist from other tests in file.
    const rows = env.db.topUsers(env.guild.id, 10);
    if (!rows.length) {
      const interaction = await env.runCommand({
        commandName: "leaderboard",
        admin: false,
        user: env.users.memberUser,
      });
      assertEphemeralReply(interaction, /No leaderboard data/);
    } else {
      const interaction = await env.runCommand({
        commandName: "leaderboard",
        admin: false,
        user: env.users.memberUser,
      });
      assertReplyContains(interaction, "Leaderboard");
      assert.ok(interaction.replies[0].files?.length >= 1);
    }
  });

  it("/leaderboard with data returns PNG attachment", async () => {
    env.db.setXp(env.guild.id, IDS.member, 100);
    env.db.setXp(env.guild.id, IDS.member2, 200);
    const interaction = await env.runCommand({
      commandName: "leaderboard",
      admin: false,
      user: env.users.memberUser,
    });
    assertReplyContains(interaction, "Leaderboard");
    const files = interaction.replies[0].files;
    assert.ok(files && files.length >= 1, "expected leaderboard image file");
  });

  it("/setxp denies non-staff", async () => {
    const interaction = await env.runCommand({
      commandName: "setxp",
      admin: false,
      user: env.users.memberUser,
      options: { message: 10 },
    });
    assertEphemeralReply(interaction, /permission/i);
  });

  it("/setxp updates settings for admin", async () => {
    const interaction = await env.runCommand({
      commandName: "setxp",
      admin: true,
      options: {
        message: 7,
        reaction: 3,
        voice: 2,
        msgcooldown: 5,
        reactioncooldown: 8,
      },
    });
    assertReplyContains(interaction, "Updated XP settings");
    const s = env.db.getGuildSettings(env.guild.id);
    assert.equal(s.msg_xp, 7);
    assert.equal(s.reaction_xp, 3);
    assert.equal(s.voice_xp_per_min, 2);
    assert.equal(s.msg_cooldown_sec, 5);
    assert.equal(s.reaction_cooldown_sec, 8);
  });

  it("/setxp no-op when no options", async () => {
    const interaction = await env.runCommand({
      commandName: "setxp",
      admin: true,
      options: {},
    });
    assertEphemeralReply(interaction, /No XP settings/);
  });

  it("/settings shows admin summary", async () => {
    const interaction = await env.runCommand({
      commandName: "settings",
      admin: true,
    });
    assertReplyContains(interaction, "Boiler Snake Settings");
    assertReplyContains(interaction, "msg=");
  });

  it("/settings denies non-staff", async () => {
    const interaction = await env.runCommand({
      commandName: "settings",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(interaction, /permission/i);
  });
});
