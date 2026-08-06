const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertReplyContains,
  assertEphemeralReply,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

describe("integration: staff notes", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;

  before(async () => {
    env = await createIntegrationEnv();
  });

  it("/note denies non-staff", async () => {
    const interaction = await env.runCommand({
      commandName: "note",
      subcommand: "list",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(interaction, /permission/i);
  });

  it("/note add + list + info + edit + delete", async () => {
    const add = await env.runCommand({
      commandName: "note",
      subcommand: "add",
      admin: true,
      options: {
        user: env.users.memberUser,
        content: "Watch for spam in #general",
      },
    });
    assertEphemeralReply(add);
    assertReplyContains(add, /N-1|created/i);

    const row = env.db.getStaffNote(env.guild.id, 1);
    assert.ok(row);
    assert.equal(row.user_id, IDS.member);
    assert.equal(row.content, "Watch for spam in #general");
    assert.equal(row.author_id, IDS.admin);

    const list = await env.runCommand({
      commandName: "note",
      subcommand: "list",
      admin: true,
      options: { user: env.users.memberUser },
    });
    assertEphemeralReply(list);
    assertReplyContains(list, /N-1/);
    assertReplyContains(list, /spam/i);

    const info = await env.runCommand({
      commandName: "note",
      subcommand: "info",
      admin: true,
      options: { id: 1 },
    });
    assertEphemeralReply(info);
    assertReplyContains(info, /Watch for spam/);

    const edit = await env.runCommand({
      commandName: "note",
      subcommand: "edit",
      admin: true,
      options: { id: 1, content: "Updated context after review" },
    });
    assertEphemeralReply(edit);
    assertReplyContains(edit, /updated|N-1/i);
    assert.equal(
      env.db.getStaffNote(env.guild.id, 1).content,
      "Updated context after review"
    );

    const del = await env.runCommand({
      commandName: "note",
      subcommand: "delete",
      admin: true,
      options: { id: 1 },
    });
    assertEphemeralReply(del);
    assertReplyContains(del, /soft-deleted|N-1/i);

    const after = env.db.getStaffNote(env.guild.id, 1);
    assert.ok(after.deleted_at != null);

    const listActive = await env.runCommand({
      commandName: "note",
      subcommand: "list",
      admin: true,
      options: { user: env.users.memberUser },
    });
    assertReplyContains(listActive, /No active staff notes/i);

    const listDeleted = await env.runCommand({
      commandName: "note",
      subcommand: "list",
      admin: true,
      options: {
        user: env.users.memberUser,
        include_deleted: true,
      },
    });
    assertReplyContains(listDeleted, /N-1/);
  });

  it("/note list without user shows recent guild notes", async () => {
    env.db.createStaffNote({
      guildId: env.guild.id,
      userId: IDS.member2,
      authorId: IDS.admin,
      content: "Guild-wide feed item",
    });

    const list = await env.runCommand({
      commandName: "note",
      subcommand: "list",
      admin: true,
    });
    assertEphemeralReply(list);
    assertReplyContains(list, /Recent staff notes|Guild-wide feed/i);
  });

  it("/note settings shows counts and access", async () => {
    const interaction = await env.runCommand({
      commandName: "note",
      subcommand: "settings",
      admin: true,
    });
    assertEphemeralReply(interaction);
    assertReplyContains(interaction, /Access|Manage Server|staff/i);
  });

  it("/note edit missing id fails gracefully", async () => {
    const interaction = await env.runCommand({
      commandName: "note",
      subcommand: "edit",
      admin: true,
      options: { id: 99999, content: "nope" },
    });
    assertEphemeralReply(interaction);
    assertReplyContains(interaction, /No note|N-99999/i);
  });

  it("/note add without content opens modal", async () => {
    const interaction = await env.runCommand({
      commandName: "note",
      subcommand: "add",
      admin: true,
      options: { user: env.users.memberUser },
    });
    assert.equal(interaction.modals.length, 1);
    const modal = interaction.modals[0];
    const json = typeof modal.toJSON === "function" ? modal.toJSON() : modal;
    const staffNotes = require("../../src/features/staffNotes");
    assert.equal(
      json.custom_id || json.customId,
      `${staffNotes.MODAL_PREFIX_ADD}${IDS.member}`
    );
  });

  it("note add modal creates staff note", async () => {
    const staffNotes = require("../../src/features/staffNotes");
    const { createModalSubmitInteraction } = require("../helpers/discord");
    const content = `Modal note body ${Date.now()}`;
    const modalIx = createModalSubmitInteraction({
      customId: `${staffNotes.MODAL_PREFIX_ADD}${IDS.member2}`,
      guild: env.guild,
      user: env.users.adminUser,
      member: env.members.adminMember,
      admin: true,
      client: env.client,
      fields: { content },
    });
    await env.handleInteraction(modalIx, env.ctx);
    assertReplyContains(modalIx, /created|N-/i);

    const notes = env.db.listStaffNotes(env.guild.id, IDS.member2, {
      limit: 5,
    });
    assert.ok(notes.some((n) => n.content === content));
  });

  it("/note edit without content opens prefilled modal", async () => {
    const created = env.db.createStaffNote({
      guildId: env.guild.id,
      userId: IDS.member,
      authorId: IDS.admin,
      content: "Prefill me please",
    });
    const interaction = await env.runCommand({
      commandName: "note",
      subcommand: "edit",
      admin: true,
      options: { id: created.note_number },
    });
    assert.equal(interaction.modals.length, 1);
    const staffNotes = require("../../src/features/staffNotes");
    const modal = interaction.modals[0];
    const json = typeof modal.toJSON === "function" ? modal.toJSON() : modal;
    assert.equal(
      json.custom_id || json.customId,
      `${staffNotes.MODAL_PREFIX_EDIT}${created.note_number}`
    );
  });

  it("/note add rejects bots", async () => {
    const interaction = await env.runCommand({
      commandName: "note",
      subcommand: "add",
      admin: true,
      options: {
        user: env.users.botUser,
        content: "should fail",
      },
    });
    assertEphemeralReply(interaction);
    assertReplyContains(interaction, /bot/i);
  });
});
