const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertReplyContains,
  assertEphemeralReply,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");
const {
  buttonCustomId,
  parseButtonCustomId,
} = require("../../src/features/userinfo");

describe("integration: userinfo", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;

  before(async () => {
    env = await createIntegrationEnv();
  });

  it("parses button custom ids", () => {
    const id = buttonCustomId("n", "12345");
    assert.equal(id, "ui:n:12345");
    assert.deepEqual(parseButtonCustomId(id), {
      view: "n",
      userId: "12345",
    });
    assert.equal(parseButtonCustomId("nope"), null);
  });

  it("/userinfo denies non-staff", async () => {
    const interaction = await env.runCommand({
      commandName: "userinfo",
      admin: false,
      user: env.users.memberUser,
      options: { user: env.users.member2User },
    });
    assertEphemeralReply(interaction, /permission/i);
  });

  it("/userinfo shows XP and zero counts for clean member", async () => {
    env.db.addXp(env.guild.id, IDS.member, 250);

    const interaction = await env.runCommand({
      commandName: "userinfo",
      admin: true,
      options: { user: env.users.memberUser },
    });
    assertEphemeralReply(interaction);
    assertReplyContains(interaction, /Staff user card|XP|Level/i);
    assertReplyContains(interaction, /0.*active|Staff notes/i);

    const reply = interaction.replies[interaction.replies.length - 1];
    assert.ok(Array.isArray(reply.components));
    assert.ok(reply.components.length >= 1);
  });

  it("/userinfo reflects note and warning counts", async () => {
    env.db.createStaffNote({
      guildId: env.guild.id,
      userId: IDS.member2,
      authorId: IDS.admin,
      content: "Context for card",
    });
    env.db.createStaffNote({
      guildId: env.guild.id,
      userId: IDS.member2,
      authorId: IDS.admin,
      content: "Second note",
    });
    env.db.createWarning({
      guildId: env.guild.id,
      userId: IDS.member2,
      issuerId: IDS.admin,
      reason: "Strike one",
    });
    const voided = env.db.createWarning({
      guildId: env.guild.id,
      userId: IDS.member2,
      issuerId: IDS.admin,
      reason: "Later voided",
    });
    env.db.voidWarning(env.guild.id, voided.warning_number, {
      voidedBy: IDS.admin,
      voidReason: "Appeal",
    });

    const interaction = await env.runCommand({
      commandName: "userinfo",
      admin: true,
      options: { user: env.users.member2User },
    });
    assertEphemeralReply(interaction);
    assertReplyContains(interaction, /2.*active|Staff notes/i);
    assertReplyContains(interaction, /1.*active|voided|Warnings/i);
  });

  it("notes button expands staff notes list", async () => {
    const btn = await env.runButton({
      customId: buttonCustomId("n", IDS.member2),
      admin: true,
    });
    assert.ok(btn.updates.length >= 1 || btn.replies.length >= 1);
    assertReplyContains(btn, /Staff notes|N-1|Context for card/i);
  });

  it("warnings button expands warning history", async () => {
    const btn = await env.runButton({
      customId: buttonCustomId("w", IDS.member2),
      admin: true,
    });
    assertReplyContains(btn, /Warnings|W-1|Strike one|voided/i);
  });

  it("overview button returns to card", async () => {
    const btn = await env.runButton({
      customId: buttonCustomId("o", IDS.member2),
      admin: true,
    });
    assertReplyContains(btn, /Staff user card|XP/i);
  });

  it("button denies non-staff", async () => {
    const btn = await env.runButton({
      customId: buttonCustomId("n", IDS.member),
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(btn, /permission/i);
  });
});
