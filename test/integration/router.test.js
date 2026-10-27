const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertEphemeralReply,
  assertReplyContains,
  assertNoReply,
} = require("../helpers/assert");
const { createChatInputInteraction, createUser } = require("../helpers/discord");
const { IDS } = require("../helpers/fixtures");

describe("integration: router", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;

  after(() => {
    // Close SQLite handles and remove the temp dir created for this env.
    env?.cleanup();
  });

  before(async () => {
    env = await createIntegrationEnv();
  });

  it("ignores non-command interactions", async () => {
    const interaction = createChatInputInteraction({
      commandName: "xp",
      guild: env.guild,
      user: env.users.memberUser,
      member: env.members.member,
      admin: false,
    });
    interaction.isChatInputCommand = () => false;
    interaction.isAutocomplete = () => false;
    await env.handleInteraction(interaction, env.ctx);
    assertNoReply(interaction);
  });

  it("ignores DMs (no guild)", async () => {
    const interaction = await env.runCommand({
      commandName: "xp",
      guild: null,
      user: env.users.memberUser,
      admin: false,
    });
    // runCommand still builds guild unless null — use handleInteraction directly
    const i = createChatInputInteraction({
      commandName: "xp",
      guild: null,
      user: env.users.memberUser,
      member: null,
      admin: false,
    });
    await env.handleInteraction(i, env.ctx);
    assertNoReply(i);
  });

  it("replies for unknown command", async () => {
    const interaction = await env.runCommand({
      commandName: "notarealcommand",
      admin: true,
    });
    assertEphemeralReply(interaction, /Unhandled command/);
  });

  it("allows commands when no channel allow-list", async () => {
    const interaction = await env.runCommand({
      commandName: "xp",
      admin: false,
      user: env.users.memberUser,
    });
    assertReplyContains(interaction, "XP");
  });

  it("blocks commands outside allow-list", async () => {
    env.db.addAllowedCommandChannel(env.communityId, IDS.channelCmds);
    const blocked = await env.runCommand({
      commandName: "xp",
      channelId: IDS.channelGeneral,
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(blocked, /aren't enabled/);

    const allowed = await env.runCommand({
      commandName: "xp",
      channelId: IDS.channelCmds,
      admin: false,
      user: env.users.memberUser,
    });
    assertReplyContains(allowed, "XP");

    // cleanup for other tests in file
    env.db.removeAllowedCommandChannel(env.communityId, IDS.channelCmds);
  });

  it("allows /setcommandchannel for admins even when restricted", async () => {
    env.db.addAllowedCommandChannel(env.communityId, IDS.channelCmds);
    const interaction = await env.runCommand({
      commandName: "setcommandchannel",
      subcommand: "list",
      channelId: IDS.channelGeneral,
      admin: true,
    });
    assertReplyContains(interaction, /Allowed command channels|allowed in all/i);
    env.db.removeAllowedCommandChannel(env.communityId, IDS.channelCmds);
  });

  it("autocomplete without handler responds empty", async () => {
    const interaction = createChatInputInteraction({
      commandName: "settings",
      guild: env.guild,
      user: env.users.adminUser,
      member: env.members.adminMember,
      autocomplete: true,
    });
    await env.handleInteraction(interaction, env.ctx);
    assert.equal(interaction.responds.length, 1);
    assert.deepEqual(interaction.responds[0], []);
  });

  it("safeErrorReply when handler throws", async () => {
    const original = env.registry.getHandler("xp");
    // xp is a context-api handler (PR 3): preserve the api flag on replace and
    // restore so the router keeps routing it through the CommandContext arm.
    env.registry.registerHandler(
      "xp",
      async () => {
        throw new Error("boom");
      },
      { api: "context" },
    );
    const interaction = await env.runCommand({
      commandName: "xp",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(interaction, /Something went wrong/);
    env.registry.registerHandler("xp", original, { api: "context" });
  });

  // ── #745 (decision 9): context-menu dispatch ─────────────────────────────
  //
  // Mock pattern: extend createChatInputInteraction and flip the kind
  // predicates — the same technique as this file's first test ("ignores
  // non-command interactions"). Context-menu interactions carry their target
  // on options.getMessage()/getUser(); the handler must receive the RAW
  // interaction (registry api 'interaction' only — no CommandContext).

  function createContextMenuInteraction({
    kind,
    commandName,
    target = {},
    ...chatOpts
  }) {
    const interaction = createChatInputInteraction({ commandName, ...chatOpts });
    interaction.isChatInputCommand = () => false;
    interaction.isMessageContextMenuCommand = () => kind === "message";
    interaction.isUserContextMenuCommand = () => kind === "user";
    interaction.options.getMessage = () => target.message ?? null;
    interaction.options.getUser = () => target.user ?? null;
    return interaction;
  }

  it("dispatches message-context menu commands to the registered handler (raw interaction)", async () => {
    const seen = [];
    env.registry.registerHandler(
      "Report Post",
      async (interaction, handlerCtx) => {
        seen.push({ interaction, handlerCtx });
      },
    );
    try {
      const reported = { id: "msg-reported", content: "not acceptable" };
      const interaction = createContextMenuInteraction({
        kind: "message",
        commandName: "Report Post",
        guild: env.guild,
        user: env.users.adminUser,
        member: env.members.adminMember,
        admin: true,
        target: { message: reported },
      });
      await env.handleInteraction(interaction, env.ctx);
      assert.equal(seen.length, 1, "registered context-menu handler dispatched");
      assert.equal(
        seen[0].interaction,
        interaction,
        "handler receives the RAW interaction",
      );
      assert.equal(seen[0].handlerCtx, env.ctx);
      assert.equal(
        seen[0].interaction.options.getMessage("Message"),
        reported,
        "target message rides the raw interaction",
      );
      assertNoReply(interaction); // handler answers for itself — router adds nothing
    } finally {
      env.registry.handlers.delete("Report Post");
    }
  });

  it("dispatches user-context menu commands to the registered handler (raw interaction)", async () => {
    const seen = [];
    env.registry.registerHandler("Report User", async (interaction) => {
      seen.push(interaction);
    });
    try {
      const interaction = createContextMenuInteraction({
        kind: "user",
        commandName: "Report User",
        guild: env.guild,
        user: env.users.adminUser,
        member: env.members.adminMember,
        admin: true,
        target: { user: env.users.memberUser },
      });
      await env.handleInteraction(interaction, env.ctx);
      assert.equal(seen.length, 1, "registered context-menu handler dispatched");
      assert.equal(seen[0], interaction, "handler receives the RAW interaction");
      assert.equal(
        seen[0].options.getUser("User"),
        env.users.memberUser,
        "target user rides the raw interaction",
      );
      assertNoReply(interaction);
    } finally {
      env.registry.handlers.delete("Report User");
    }
  });

  it("drops context-menu interactions without a guild (no handler, no reply)", async () => {
    let called = 0;
    env.registry.registerHandler("Report Post", async () => {
      called += 1;
    });
    try {
      const interaction = createContextMenuInteraction({
        kind: "message",
        commandName: "Report Post",
        guild: null,
        user: env.users.memberUser,
        member: null,
        admin: false,
      });
      await env.handleInteraction(interaction, env.ctx);
      assert.equal(called, 0, "guild guard runs before dispatch");
      assertNoReply(interaction);
    } finally {
      env.registry.handlers.delete("Report Post");
    }
  });

  it("blocks context-menu commands outside the channel allow-list", async () => {
    env.db.addAllowedCommandChannel(env.communityId, IDS.channelCmds);
    try {
      const interaction = createContextMenuInteraction({
        kind: "message",
        commandName: "Report Post",
        guild: env.guild,
        user: env.users.memberUser,
        member: env.members.member,
        channelId: IDS.channelGeneral,
        admin: false,
      });
      await env.handleInteraction(interaction, env.ctx);
      assertEphemeralReply(interaction, /aren't enabled/);
    } finally {
      env.db.removeAllowedCommandChannel(env.communityId, IDS.channelCmds);
    }
  });

  it("replies unhandled-command for an unknown context-menu commandName", async () => {
    const interaction = createContextMenuInteraction({
      kind: "user",
      commandName: "Report Galaxy",
      guild: env.guild,
      user: env.users.adminUser,
      member: env.members.adminMember,
      admin: true,
    });
    await env.handleInteraction(interaction, env.ctx);
    assertEphemeralReply(interaction, /Unhandled command/);
  });

  for (const kind of ["message", "user"]) {
    it(`logs kind=${kind}-context and safeErrorReplys when a context-menu handler throws`, async () => {
      const throwing = async () => {
        throw new Error("boom");
      };
      env.registry.registerHandler("Report Post", throwing);
      env.registry.registerHandler("Report User", throwing);
      const originalError = console.error;
      const logs = [];
      console.error = (...args) => logs.push(args.map(String).join(" "));
      try {
        const interaction = createContextMenuInteraction({
          kind,
          commandName: kind === "message" ? "Report Post" : "Report User",
          guild: env.guild,
          user: env.users.adminUser,
          member: env.members.adminMember,
          admin: true,
        });
        await env.handleInteraction(interaction, env.ctx);
        // safeErrorReply answered the user — never a silent drop (rule 1).
        assertEphemeralReply(interaction, /Something went wrong/);
        const line = logs.find((l) =>
          l.includes("[router] command handler failed:"),
        );
        assert.ok(
          line,
          `expected a [router] failure log, got ${JSON.stringify(logs)}`,
        );
        assert.match(
          line,
          new RegExp(`kind=${kind}-context`),
          "the kind ladder names the new context-menu kinds",
        );
        assert.match(line, /guild=/, "log has the ids to reproduce (rule 2)");
        assert.match(line, /command=\/Report/);
        assert.match(line, /boom/, "the specific error is in the log line");
      } finally {
        console.error = originalError;
        env.registry.handlers.delete("Report Post");
        env.registry.handlers.delete("Report User");
      }
    });
  }
});
