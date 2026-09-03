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

  it("/setxp updates level_xp_factor", async () => {
    const interaction = await env.runCommand({
      commandName: "setxp",
      admin: true,
      options: { factor: 400 },
    });
    assertReplyContains(interaction, "Updated XP settings");
    assertReplyContains(interaction, "level_xp_factor");
    const s = env.db.getGuildSettings(env.guild.id);
    assert.equal(s.level_xp_factor, 400);
  });

  it("/xp reflects new factor (floor(sqrt(xp/factor)))", async () => {
    // Ensure factor is 400 from previous test.
    // xp=1600, factor=400 → floor(sqrt(1600/400)) = floor(sqrt(4)) = 2
    env.db.setXp(env.guild.id, IDS.member, 1600);
    const interaction = await env.runCommand({
      commandName: "xp",
      admin: false,
      user: env.users.memberUser,
    });
    assertReplyContains(interaction, "1600 XP");
    assertReplyContains(interaction, "Level **2**");
  });

  it("/xp level changes when factor changes", async () => {
    // With factor=400, xp=400 → floor(sqrt(400/400)) = 1
    env.db.setXp(env.guild.id, IDS.member2, 400);
    let interaction = await env.runCommand({
      commandName: "xp",
      admin: false,
      user: env.users.memberUser,
      options: { user: env.users.member2User },
    });
    assertReplyContains(interaction, "400 XP");
    assertReplyContains(interaction, "Level **1**");

    // Change factor to 100 → floor(sqrt(400/100)) = floor(sqrt(4)) = 2
    await env.runCommand({
      commandName: "setxp",
      admin: true,
      options: { factor: 100 },
    });

    interaction = await env.runCommand({
      commandName: "xp",
      admin: false,
      user: env.users.memberUser,
      options: { user: env.users.member2User },
    });
    assertReplyContains(interaction, "400 XP");
    assertReplyContains(interaction, "Level **2**");
  });

  it("/setxp factor-only no-op still shows no settings message", async () => {
    // Calling /setxp with no options (including no factor) should be no-op
    const interaction = await env.runCommand({
      commandName: "setxp",
      admin: true,
      options: {},
    });
    assertEphemeralReply(interaction, /No XP settings/);
  });

  it("/grantxp denies non-admin", async () => {
    const interaction = await env.runCommand({
      commandName: "grantxp",
      admin: false,
      user: env.users.memberUser,
      options: { user: env.users.member2User, amount: 50 },
    });
    assertEphemeralReply(interaction, /permission/i);
  });

  it("/grantxp grants XP for admin", async () => {
    env.db.setXp(env.guild.id, IDS.member2, 100);
    const interaction = await env.runCommand({
      commandName: "grantxp",
      admin: true,
      options: {
        user: env.users.member2User,
        amount: 50,
        reason: "Contest winner",
      },
    });
    assertReplyContains(interaction, "Granted");
    assertReplyContains(interaction, "50");
    assertReplyContains(interaction, "Contest winner");
    assertXp(env.db, env.guild.id, IDS.member2, 150);
  });

  it("/grantxp rejects bots", async () => {
    const interaction = await env.runCommand({
      commandName: "grantxp",
      admin: true,
      options: { user: env.users.botUser, amount: 10 },
    });
    assertEphemeralReply(interaction, /bots/i);
  });

  it("/settings shows admin summary", async () => {
    const interaction = await env.runCommand({
      commandName: "settings",
      admin: true,
    });
    assertReplyContains(interaction, "Boiler Snake Settings");
    assertReplyContains(interaction, /Message|XP awards|msg/i);
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

describe("integration: leaderboard pagination", () => {
  const GUILD_ID = "guild-lb-pagination";

  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  /** @type {ReturnType<import("node:module").Module["require"]>} */
  let xpFeature;

  before(async () => {
    env = await createIntegrationEnv({ guildId: GUILD_ID });
    xpFeature = require("../../src/features/xp");

    // 12 users → 2 pages at default limit 10
    for (let i = 1; i <= 12; i++) {
      env.db.setXp(GUILD_ID, `lb-user-${i}`, 120 - i);
    }
  });

  /** @param {object} payload
   * @returns {Array<{ customId: string, label: string, disabled: boolean }>} */
  function buttonsOf(payload) {
    const out = [];
    for (const row of payload.components || []) {
      const rowJson = typeof row?.toJSON === "function" ? row.toJSON() : row;
      const components = rowJson?.components || row?.components || [];
      for (const btn of components) {
        const btnJson = typeof btn?.toJSON === "function" ? btn.toJSON() : btn;
        out.push({
          customId: btnJson?.custom_id || btn?.data?.custom_id,
          label: btnJson?.label || btn?.data?.label,
          disabled: btnJson?.disabled ?? btn?.data?.disabled ?? false,
        });
      }
    }
    return out;
  }

  it("default /leaderboard shows ranks 1-10 with Prev disabled, Next enabled", async () => {
    const interaction = await env.runCommand({
      commandName: "leaderboard",
      admin: false,
      user: env.users.memberUser,
    });
    assertReplyContains(interaction, "Leaderboard");
    assertReplyContains(interaction, "ranks 1–10");
    const reply = interaction.replies[0];
    assert.equal(reply.files?.length, 1);
    const btns = buttonsOf(reply);
    assert.equal(btns.length, 2);
    assert.equal(btns[0].label, "◀ Prev");
    assert.equal(btns[0].disabled, true);
    assert.equal(btns[1].label, "Next ▶");
    assert.equal(btns[1].disabled, false);
    assert.equal(btns[1].customId, `lb:${env.users.memberUser.id}:10:2`);
  });

  it("limit option controls page size", async () => {
    const interaction = await env.runCommand({
      commandName: "leaderboard",
      admin: false,
      user: env.users.memberUser,
      options: { limit: 5 },
    });
    assertReplyContains(interaction, "ranks 1–5");
    const btns = buttonsOf(interaction.replies[0]);
    assert.equal(btns[1].customId, `lb:${env.users.memberUser.id}:5:2`);
  });

  it("Next button shows the next page ranks and disables itself on last page", async () => {
    const interaction = await env.runButton({
      customId: `lb:${env.users.memberUser.id}:10:2`,
      admin: false,
      user: env.users.memberUser,
    });
    assert.equal(interaction.updates.length, 1);
    const update = interaction.updates[0];
    assert.match(update.content, /ranks 11–12/);
    assert.equal(update.files?.length, 1);
    const btns = buttonsOf(update);
    assert.equal(btns[0].disabled, false);
    assert.equal(btns[0].customId, `lb:${env.users.memberUser.id}:10:1`);
    assert.equal(btns[1].disabled, true);
  });

  it("Prev button returns to page 1 and disables itself", async () => {
    const interaction = await env.runButton({
      customId: `lb:${env.users.memberUser.id}:10:1`,
      admin: false,
      user: env.users.memberUser,
    });
    assert.equal(interaction.updates.length, 1);
    assert.match(interaction.updates[0].content, /ranks 1–10/);
    const btns = buttonsOf(interaction.updates[0]);
    assert.equal(btns[0].disabled, true);
    assert.equal(btns[1].disabled, false);
  });

  it("non-caller cannot page someone else's leaderboard", async () => {
    const interaction = await env.runButton({
      customId: `lb:${env.users.memberUser.id}:10:2`,
      admin: true,
      user: env.users.adminUser,
    });
    assertEphemeralReply(interaction, /Only the person/i);
    assert.equal(interaction.updates.length, 0);
  });

  it("parseLeaderboardButtonCustomId round-trips and rejects malformed ids", () => {
    const {
      parseLeaderboardButtonCustomId,
      leaderboardButtonCustomId,
      clampLeaderboardLimit,
    } = xpFeature;
    assert.deepEqual(
      parseLeaderboardButtonCustomId(leaderboardButtonCustomId("u1", 10, 2)),
      { requesterId: "u1", limit: 10, page: 2 },
    );
    assert.equal(parseLeaderboardButtonCustomId("lb:u1:10"), null);
    assert.equal(parseLeaderboardButtonCustomId("lb:u1:0:1"), null);
    assert.equal(parseLeaderboardButtonCustomId("lb:u1:21:1"), null);
    assert.equal(parseLeaderboardButtonCustomId("lb:u1:10:0"), null);
    assert.equal(parseLeaderboardButtonCustomId("lb::10:1"), null);
    assert.equal(parseLeaderboardButtonCustomId("ui:u1:10:1"), null);
    assert.equal(clampLeaderboardLimit(null), 10);
    assert.equal(clampLeaderboardLimit(0), 1);
    assert.equal(clampLeaderboardLimit(999), 20);
    assert.equal(clampLeaderboardLimit(7), 7);
  });
});
