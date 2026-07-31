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
