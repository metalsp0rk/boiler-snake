/**
 * #469 (F2-6): join-time grants reach the honeypot.
 *
 * A role applied to a member the shard never cached (raid account joining
 * with roles already applied) arrives as GuildMemberAvailable - NO old
 * state. The Update path rightly refuses to guess on an unknown diff, but
 * nothing subscribed to Available, so the ban-role grant vanished
 * silently. The Available payload is the member's POSITIVE full state —
 * evaluated directly, banned through the same flow (dedupe + breaker +
 * exempt gate shared).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const { assertBanned, assertNotBanned } = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

describe("integration: honeypot GuildMemberAvailable (#469 F2-6)", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let handleHoneypotAvailableMember;

  after(() => env?.cleanup());

  before(async () => {
    env = await createIntegrationEnv();
    const hp = require("../../src/features/honeypot");
    handleHoneypotAvailableMember = hp.handleHoneypotAvailableMember;
    env.db.addHoneypotBanRole(env.communityId, IDS.roleBan);
  });

  it("a member arriving WITH the ban role is banned (no diff needed)", async () => {
    const user = env.createUser({ id: "user-avail-1", username: "join_raider" });
    const member = env.createMember({
      guild: env.guild,
      user,
      roleIds: [IDS.roleBan], // positive state — exactly the join-time grant
    });
    env.guild.addMember(member);
    env.guild._bans.length = 0;

    await handleHoneypotAvailableMember(member);

    assertBanned(env.guild, user.id);
  });

  it("staff exemption holds on the Available path too", async () => {
    env.db.addStaffRole(env.communityId, IDS.roleExempt, "junior");
    const user = env.createUser({ id: "user-avail-2", username: "joining_mod" });
    const member = env.createMember({
      guild: env.guild,
      user,
      roleIds: [IDS.roleBan, IDS.roleExempt],
    });
    env.guild.addMember(member);
    env.guild._bans.length = 0;

    await handleHoneypotAvailableMember(member);

    assertNotBanned(env.guild, user.id);
  });

  it("bot members stay out of it", async () => {
    const user = env.createUser({ id: "user-avail-3", username: "integrator", bot: true });
    const member = env.createMember({ guild: env.guild, user, roleIds: [IDS.roleBan] });
    env.guild._bans.length = 0;

    await handleHoneypotAvailableMember(member);

    assertNotBanned(env.guild, user.id);
  });

  it("registerEvents subscribes the Available twin and the event lands", async () => {
    const hp = require("../../src/features/honeypot");
    hp.registerEvents(env.supervisor);
    assert.ok(
      env.client.listenerCount("guildMemberAvailable") >= 1,
      "the subscription exists (pre-fix: nothing listened)",
    );

    const user = env.createUser({ id: "user-avail-4", username: "emitted_raider" });
    const member = env.createMember({
      guild: env.guild,
      user,
      roleIds: [IDS.roleBan],
    });
    env.guild.addMember(member);
    env.guild._bans.length = 0;

    env.client.emit("guildMemberAvailable", member);

    // Fire-and-forget emit: wait for the async handler to commit.
    const deadline = Date.now() + 1000;
    while (env.guild._bans.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    assertBanned(env.guild, user.id, "the wired event path bans too");
  });
});
