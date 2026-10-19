/**
 * #469 (F2-7): every honeypot role decision reads cache ∪ raw `_roles`.
 *
 * discord.js `member.roles.cache` is FILTERED through the guild role store:
 * an id the gateway never sent a role object for is invisible there. The
 * honeypot flows trusted that view, so the gaps failed in the dangerous
 * direction — an unseen ban-role grant was a BAN-MISS (raid continues)
 * and, worse, an unseen staff role was an EXEMPTION-MISS: the bot banned
 * a moderator. The gateway's raw `_roles` array carries the ids anyway;
 * the union is the honest set.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const { assertBanned, assertNotBanned } = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

describe("integration: honeypot role-id oracle (#469 F2-7)", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let handleHoneypotMessage;
  let handleHoneypotBanRole;

  after(() => env?.cleanup());

  before(async () => {
    env = await createIntegrationEnv();
    const hp = require("../../src/features/honeypot");
    handleHoneypotMessage = hp.handleHoneypotMessage;
    handleHoneypotBanRole = hp.handleHoneypotBanRole;
  });

  /**
   * A member whose ROLE CACHE hides `hiddenIds` — exactly the resume/partial
   * payload shape: the gateway sent the ids in the member payload
   * (`_roles`) but no role objects, so the filtered cache never lists them.
   */
  function memberWithHiddenRoles(user, visibleIds, hiddenIds) {
    const member = env.createMember({ guild: env.guild, user, roleIds: visibleIds });
    member._roles = [env.guild.id, ...visibleIds, ...hiddenIds].filter(
      (id, i, all) => all.indexOf(id) === i,
    );
    return member;
  }

  it("an exemption-invisible staff role no longer costs a moderator the ban", async () => {
    env.db.addHoneypotChannel(env.communityId, IDS.channelHoneypot);
    // The staff role EXISTS in the staff config but the member's cache does
    // not see it (hidden behind the missing role object).
    env.db.addStaffRole(env.communityId, IDS.roleExempt, "junior");
    const user = env.createUser({ id: "user-f27-staff", username: "mod_partial" });
    const member = memberWithHiddenRoles(user, [], [IDS.roleExempt]);
    const message = env.createMessage({
      guild: env.guild,
      channel: env.channels.honeypot,
      author: user,
      member,
      content: "moderator cleanup post",
    });
    env.guild._bans.length = 0;

    const hit = await handleHoneypotMessage(message);

    assert.equal(hit, true, "honeypot traffic consumed");
    assertNotBanned(env.guild, user.id);
    assert.ok(message._wasDeleted(), "exempt path still cleans the channel");
  });

  it("a store-invisible ban-role grant still lands the ban", async () => {
    env.db.addHoneypotBanRole(env.communityId, IDS.roleBan);
    const user = env.createUser({ id: "user-f27-raider", username: "raider_hidden" });
    const oldMember = env.createMember({ guild: env.guild, user, roleIds: [] });
    const newMember = memberWithHiddenRoles(user, [], [IDS.roleBan]);
    env.guild.addMember(newMember);
    env.guild._bans.length = 0;

    await handleHoneypotBanRole(oldMember, newMember);

    assertBanned(env.guild, user.id);
  });

  it("members without a raw array keep the pure-cache behaviour (parity)", async () => {
    env.db.addHoneypotBanRole(env.communityId, IDS.roleBan);
    const user = env.createUser({ id: "user-f27-visible", username: "raider_visible" });
    const oldMember = env.createMember({ guild: env.guild, user, roleIds: [] });
    const newMember = env.createMember({
      guild: env.guild,
      user,
      roleIds: [IDS.roleBan],
    });
    delete newMember._roles; // mock without the raw leg: cache-only world
    env.guild.addMember(newMember);
    env.guild._bans.length = 0;

    await handleHoneypotBanRole(oldMember, newMember);

    assertBanned(env.guild, user.id, "cache-visible grants behave exactly as before");
  });

  it("unknown extra raw ids match nothing and ban nothing (no hair-trigger)", async () => {
    const user = env.createUser({ id: "user-f27-noise", username: "member_ok" });
    const oldMember = env.createMember({ guild: env.guild, user, roleIds: [] });
    const newMember = memberWithHiddenRoles(user, [], ["role-not-configured-at-all"]);
    env.guild.addMember(newMember);
    env.guild._bans.length = 0;

    await handleHoneypotBanRole(oldMember, newMember);

    assertNotBanned(env.guild, user.id, "unknown ids stay unknown — they simply do not match config");
  });
});
