const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertReplyContains,
  assertEphemeralReply,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

describe("integration: warnings", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;

  before(async () => {
    env = await createIntegrationEnv();
  });

  it("/warn denies non-staff for staff ops", async () => {
    const interaction = await env.runCommand({
      commandName: "warn",
      subcommand: "list",
      admin: false,
      user: env.users.memberUser,
      options: { user: env.users.member2User },
    });
    assertEphemeralReply(interaction, /permission/i);
  });

  it("/warn mine is available without staff", async () => {
    const interaction = await env.runCommand({
      commandName: "warn",
      subcommand: "mine",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(interaction);
    assertReplyContains(interaction, /no.*active.*warning|your warnings/i);
  });

  it("/warn add + list + info + count + void", async () => {
    const add = await env.runCommand({
      commandName: "warn",
      subcommand: "add",
      admin: true,
      options: {
        user: env.users.memberUser,
        reason: "Repeated spam in #general",
        silent: true,
      },
    });
    assertEphemeralReply(add);
    assertReplyContains(add, /W-1|issued/i);

    const row = env.db.getWarning(env.guild.id, 1);
    assert.ok(row);
    assert.equal(row.user_id, IDS.member);
    assert.equal(row.reason, "Repeated spam in #general");
    assert.equal(row.issuer_id, IDS.admin);
    assert.equal(row.voided_at, null);

    // silent:true — no DM
    assert.equal(env.users.memberUser.sends.length, 0);

    const list = await env.runCommand({
      commandName: "warn",
      subcommand: "list",
      admin: true,
      options: { user: env.users.memberUser },
    });
    assertEphemeralReply(list);
    assertReplyContains(list, /W-1/);
    assertReplyContains(list, /spam/i);

    const info = await env.runCommand({
      commandName: "warn",
      subcommand: "info",
      admin: true,
      options: { id: 1 },
    });
    assertEphemeralReply(info);
    assertReplyContains(info, /Repeated spam/);

    const count = await env.runCommand({
      commandName: "warn",
      subcommand: "count",
      admin: true,
      options: { user: env.users.memberUser },
    });
    assertEphemeralReply(count);
    assertReplyContains(count, /1.*active/i);

    const voided = await env.runCommand({
      commandName: "warn",
      subcommand: "void",
      admin: true,
      options: { id: 1, reason: "Appeal accepted after review" },
    });
    assertEphemeralReply(voided);
    assertReplyContains(voided, /voided|W-1/i);

    const after = env.db.getWarning(env.guild.id, 1);
    assert.ok(after.voided_at != null);
    assert.equal(after.void_reason, "Appeal accepted after review");
    assert.equal(after.reason, "Repeated spam in #general");

    const listActive = await env.runCommand({
      commandName: "warn",
      subcommand: "list",
      admin: true,
      options: { user: env.users.memberUser },
    });
    assertReplyContains(listActive, /No active warnings/i);

    const listVoided = await env.runCommand({
      commandName: "warn",
      subcommand: "list",
      admin: true,
      options: {
        user: env.users.memberUser,
        include_voided: true,
      },
    });
    assertReplyContains(listVoided, /W-1/);
  });

  it("/warn add DMs member when not silent", async () => {
    env.users.member2User.sends.length = 0;
    env.db.updateGuildSettings(env.guild.id, { warn_dm_members: 1 });

    const add = await env.runCommand({
      commandName: "warn",
      subcommand: "add",
      admin: true,
      options: {
        user: env.users.member2User,
        reason: "Toxic language",
      },
    });
    assertEphemeralReply(add);
    assert.ok(env.users.member2User.sends.length >= 1);
    const dm = env.users.member2User.sends[0];
    assert.ok(dm.embeds || dm.content);
  });

  it("/warn add respects guild DM off and silent", async () => {
    env.db.updateGuildSettings(env.guild.id, { warn_dm_members: 0 });
    const before = env.users.memberUser.sends.length;

    const add = await env.runCommand({
      commandName: "warn",
      subcommand: "add",
      admin: true,
      options: {
        user: env.users.memberUser,
        reason: "DM should not send",
      },
    });
    assertEphemeralReply(add);
    assert.equal(env.users.memberUser.sends.length, before);

    env.db.updateGuildSettings(env.guild.id, { warn_dm_members: 1 });
  });

  it("/warn mine shows own warnings after issue", async () => {
    env.db.createWarning({
      guildId: env.guild.id,
      userId: IDS.member,
      issuerId: IDS.admin,
      reason: "Mine-visible warning",
    });

    const mine = await env.runCommand({
      commandName: "warn",
      subcommand: "mine",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(mine);
    assertReplyContains(mine, /Mine-visible|active/i);
  });

  it("/setwarn dm requires ManageGuild", async () => {
    const denied = await env.runCommand({
      commandName: "setwarn",
      subcommand: "dm",
      admin: false,
      user: env.users.memberUser,
      options: { enabled: false },
    });
    assertEphemeralReply(denied, /permission/i);

    const ok = await env.runCommand({
      commandName: "setwarn",
      subcommand: "dm",
      admin: true,
      options: { enabled: false },
    });
    assertEphemeralReply(ok);
    assertReplyContains(ok, /disabled|off/i);
    assert.equal(Number(env.db.getGuildSettings(env.guild.id).warn_dm_members), 0);

    await env.runCommand({
      commandName: "setwarn",
      subcommand: "dm",
      admin: true,
      options: { enabled: true },
    });
  });

  it("/warn settings shows access and dm flag", async () => {
    const interaction = await env.runCommand({
      commandName: "warn",
      subcommand: "settings",
      admin: true,
    });
    assertEphemeralReply(interaction);
    assertReplyContains(interaction, /Access|DM|staff/i);
  });

  it("/warn add rejects bots", async () => {
    const interaction = await env.runCommand({
      commandName: "warn",
      subcommand: "add",
      admin: true,
      options: {
        user: env.users.botUser,
        reason: "should fail",
        silent: true,
      },
    });
    assertEphemeralReply(interaction);
    assertReplyContains(interaction, /bot/i);
  });

  it("/warn void missing id fails gracefully", async () => {
    const interaction = await env.runCommand({
      commandName: "warn",
      subcommand: "void",
      admin: true,
      options: { id: 99999, reason: "nope" },
    });
    assertEphemeralReply(interaction);
    assertReplyContains(interaction, /No warning|W-99999/i);
  });

  it("/warn add can link a staff note", async () => {
    const note = env.db.createStaffNote({
      guildId: env.guild.id,
      userId: IDS.member2,
      authorId: IDS.admin,
      content: "Prior context for formal action",
    });

    const add = await env.runCommand({
      commandName: "warn",
      subcommand: "add",
      admin: true,
      options: {
        user: env.users.member2User,
        reason: "Escalated after notes",
        silent: true,
        note: note.note_number,
      },
    });
    assertEphemeralReply(add);

    // Find the newest warning for member2
    const list = env.db.listWarnings(env.guild.id, IDS.member2, {
      includeVoided: true,
      limit: 5,
    });
    const linked = list.find((w) => w.reason === "Escalated after notes");
    assert.ok(linked);
    assert.equal(linked.related_note_id, note.id);
  });
});
