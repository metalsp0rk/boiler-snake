const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertReplyContains,
  assertEphemeralReply,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

// #609: this file LOADS src/db-bound modules at require time (the first
// such require is `../../src/features/userinfo` below) — connection.js opens AND migrates
// DB_PATH at LOAD time, so two concurrent node --test files sharing an
// ambient DB_PATH race mid-migration (the #470 G2-6 class). Bind a
// private temp DB HERE; later env flows (createIntegrationEnv /
// per-test loadDb) rebind to their own env exactly as before.
const { cleanup: cleanupTempDb } = require("../helpers/env").loadDb();
after(cleanupTempDb);
const {
  buttonCustomId,
  parseButtonCustomId,
} = require("../../src/features/userinfo");

describe("integration: userinfo", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;

  after(() => {
    // Close SQLite handles and remove the temp dir created for this env.
    env?.cleanup();
  });

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
    env.db.addXp(env.communityId, IDS.member, 250);

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
      communityId: env.communityId,
      userId: IDS.member2,
      authorId: IDS.admin,
      content: "Context for card",
    });
    env.db.createStaffNote({
      communityId: env.communityId,
      userId: IDS.member2,
      authorId: IDS.admin,
      content: "Second note",
    });
    env.db.createWarning({
      communityId: env.communityId,
      userId: IDS.member2,
      issuerId: IDS.admin,
      reason: "Strike one",
    });
    const voided = env.db.createWarning({
      communityId: env.communityId,
      userId: IDS.member2,
      issuerId: IDS.admin,
      reason: "Later voided",
    });
    env.db.voidWarning(env.communityId, voided.warning_number, {
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

  // ── #451: the Fluxer ctx path must ship NO inert drill buttons ──────────
  // Fluxer has no component ingestion, so the notes/warnings/Activity
  // buttons are silently dropped there — and the senior Activity gate lives
  // only on the Discord button handler. The ctx reply is now Discord-gated.

  function fakeCtx(platform) {
    const replies = [];
    return {
      replies,
      ctx: {
        platform,
        communityId: env.communityId,
        // ManageGuild bit (1<<5) → isAdminOrModFromContext passes the gate.
        channelPermissions: "32",
        memberRoleIds: [],
        options: { getUser: () => ({ id: IDS.member, username: "member" }) },
        outbound: { fetchMember: async () => null },
        rawInteraction: undefined,
        async reply(payload) {
          replies.push(payload);
        },
      },
    };
  }

  it("Fluxer ctx reply is button-free — Activity drill is Discord-only (#451)", async () => {
    const ui = require("../../src/features/userinfo");
    const { ctx, replies } = fakeCtx("fluxer");
    await ui.handlers.userinfo(ctx);
    assert.equal(replies.length, 1);
    assert.equal(
      replies[0].components,
      undefined,
      "no inert components shipped on a platform that cannot dispatch them",
    );
    assert.ok(replies[0].embeds?.length >= 1, "the overview card still ships");
  });

  it("Discord ctx reply keeps the drill-down buttons (#451 regression guard)", async () => {
    const ui = require("../../src/features/userinfo");
    const { ctx, replies } = fakeCtx("discord");
    await ui.handlers.userinfo(ctx);
    assert.equal(replies.length, 1);
    assert.ok(
      Array.isArray(replies[0].components) && replies[0].components.length >= 1,
      "Discord still gets the notes/warnings/Activity buttons",
    );
  });
});
