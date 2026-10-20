/**
 * #599 integration: `/staffsettings` through the REAL router (mocked Discord
 * I/O, real SQLite). Covers what the unit file cannot: router-level wiring
 * (command-channel gate, context-arm dispatch via registry), staff-role
 * holders answering in the harness guild, and output parity with the
 * `/staff` read subcommands on the same community data.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertEphemeralReply,
  assertReplyContains,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");
const { visibilityTier, TIERS } = require("../../src/core/commandVisibility");

describe("integration: /staffsettings", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;

  after(() => {
    // Close SQLite handles and remove the temp dir created for this env.
    env?.cleanup();
  });

  before(async () => {
    env = await createIntegrationEnv();
  });

  it("registered on the registry at the staff tier with a context handler", () => {
    assert.ok(
      env.registry.commands.some((c) => c.name === "staffsettings"),
      "in the registry the router dispatches through",
    );
    assert.equal(visibilityTier("staffsettings"), TIERS.staff);
    assert.equal(env.registry.getHandlerApi("staffsettings"), "context");
  });

  it("denies a member who is neither staff nor ManageGuild", async () => {
    for (const sub of ["roles", "overview"]) {
      const interaction = await env.runCommand({
        commandName: "staffsettings",
        subcommand: sub,
        admin: false,
      });
      assertEphemeralReply(interaction, /don't have permission/i);
    }
  });

  it("junior staff role holder WITHOUT ManageGuild reads the role list", async () => {
    env.db.addStaffRole(
      env.communityId,
      IDS.roleExempt,
      "junior",
      env.users.adminUser.id,
    );
    // Grant the harness member2 the junior staff role (no ManageGuild).
    env.members.member2.roles.cache.set(IDS.roleExempt, { id: IDS.roleExempt });

    const interaction = await env.runCommand({
      commandName: "staffsettings",
      subcommand: "roles",
      user: env.users.member2User,
      admin: false,
    });
    assertEphemeralReply(interaction);
    assertReplyContains(interaction, "**Staff roles**");
    assertReplyContains(
      interaction,
      `- <@&${IDS.roleExempt}> (added by <@${env.users.adminUser.id}>)`,
    );
    assert.ok(
      !/don't have permission/.test(env.lastReplyContent(interaction)),
      "junior staff passes the handler gate",
    );
  });

  it("roles answers with EXACTLY the /staff role list content (shared renderer)", async () => {
    const viaStaff = await env.runCommand({
      commandName: "staff",
      subcommandGroup: "role",
      subcommand: "list",
      admin: true,
    });
    const viaSplit = await env.runCommand({
      commandName: "staffsettings",
      subcommand: "roles",
      admin: true,
    });
    assert.equal(
      env.lastReplyContent(viaSplit),
      env.lastReplyContent(viaStaff),
    );
    assertReplyContains(viaSplit, "**Junior**");
  });

  it("overview answers with EXACTLY the /staff settings content (shared renderer)", async () => {
    const viaStaff = await env.runCommand({
      commandName: "staff",
      subcommand: "settings",
      admin: true,
    });
    const viaSplit = await env.runCommand({
      commandName: "staffsettings",
      subcommand: "overview",
      admin: true,
    });
    assert.equal(
      env.lastReplyContent(viaSplit),
      env.lastReplyContent(viaStaff),
    );
    assertReplyContains(viaSplit, "**Staff roles settings**");
    assertReplyContains(viaSplit, "Command visibility sync:");
  });

  it("unknown subcommand answers honestly through the router", async () => {
    const interaction = await env.runCommand({
      commandName: "staffsettings",
      subcommand: "delete",
      admin: true,
    });
    assertReplyContains(interaction, "Unknown subcommand: `/staffsettings delete`");
  });
});
