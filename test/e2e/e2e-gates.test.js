const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { createE2eEnv } = require("./helpers/e2eEnv");

const MSG_DENIED = "You don't have permission to use this.";

/**
 * Tier-4 E2E permission/command-channel gates through the real router.
 * Namespace 3.
 *
 * Covers the AGENTS.md tier split end-to-end:
 *  - empty command-channel allow-list ⇒ commands work everywhere
 *  - non-empty allow-list ⇒ denial outside, success inside
 *  - staff_roles membership does NOT satisfy ManageGuild-only commands
 *    (the mock member object carries role ids but no permissions string,
 *    so admin-bit paths must deny — the tier separation made visible)
 */
describe("e2e: command-channel + permission gates", { concurrency: 1 }, () => {
  /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
  let env;

  before(async () => {
    const { namespaceIds } = require("./helpers/mockenv");
    const ids = namespaceIds(3);
    env = await createE2eEnv({
      ns: 3,
      channels: [
        { id: ids.general, name: "general" },
        { id: ids.channel2, name: "allowed-commands" },
      ],
    });
    // junior staff operator (staff_roles row only — no ManageGuild bit)
    const role = await env.mock.createRole("E2E Staff");
    await env.mock.grantRole(env.ids.human, role.id);
    env.dbmod.addStaffRole(env.communityId, String(role.id), "junior");
  });

  after(async () => {
    await env?.cleanup();
  });

  it("empty allow-list: /xp works in the default channel", async () => {
    const inter = await env.mock.slash({ command: "xp" });
    const reply = await env.mock.awaitReply(inter);
    assert.match(String(reply.content), /E2EOperator/);
  });

  it("allow-list set: /xp denied outside, allowed inside", async () => {
    env.dbmod.addAllowedCommandChannel(env.communityId, env.ids.channel2);

    const outside = await env.mock.slash({ command: "xp" });
    const outsideReply = await env.mock.awaitReply(outside);
    assert.match(String(outsideReply.content), /aren't enabled in this channel/i);

    const inside = await env.mock.slash({
      command: "xp",
      channelId: env.ids.channel2,
    });
    const insideReply = await env.mock.awaitReply(inside);
    assert.match(String(insideReply.content), /E2EOperator/);
    assert.ok(
      !/aren't enabled/i.test(String(insideReply.content)),
      "allow-listed channel is not gated",
    );
  });

  it("ManageGuild-only command (/grantxp) denies a junior staff member", async () => {
    // Run in the allow-listed channel from the previous test — the router
    // checks the channel gate BEFORE permissions, so an allow-listed
    // channel isolates the permission denial under test.
    const inter = await env.mock.slash({
      command: "grantxp",
      channelId: env.ids.channel2,
      options: [
        { name: "user", type: 6, value: env.ids.target },
        { name: "amount", type: 4, value: 100 },
      ],
    });
    const reply = await env.mock.awaitReply(inter);
    assert.equal(String(reply.content), MSG_DENIED);
  });
});
