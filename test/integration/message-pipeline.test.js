const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const { assertXp, assertBanned, assertNotBanned } = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

describe("integration: message pipeline", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;

  before(async () => {
    env = await createIntegrationEnv();
    // predictable XP + no cooldown for isolation
    env.db.updateGuildSettings(env.guild.id, {
      msg_xp: 5,
      msg_cooldown_sec: 0,
    });
  });

  it("ignores bot authors", async () => {
    const before = env.db.getXp(env.guild.id, IDS.bot);
    await env.emitMessage({ author: env.users.botUser });
    assertXp(env.db, env.guild.id, IDS.bot, before);
  });

  it("awards message XP", async () => {
    const uid = IDS.member;
    const before = env.db.getXp(env.guild.id, uid);
    await env.emitMessage({ author: env.users.memberUser });
    assertXp(env.db, env.guild.id, uid, before + 5);
  });

  it("respects message cooldown", async () => {
    env.db.updateGuildSettings(env.guild.id, {
      msg_xp: 5,
      msg_cooldown_sec: 60,
    });
    // unique user to avoid prior cooldown map noise — use member2
    const uid = IDS.member2;
    const before = env.db.getXp(env.guild.id, uid);
    await env.emitMessage({ author: env.users.member2User });
    assertXp(env.db, env.guild.id, uid, before + 5);
    await env.emitMessage({ author: env.users.member2User });
    assertXp(env.db, env.guild.id, uid, before + 5);
    // restore
    env.db.updateGuildSettings(env.guild.id, { msg_cooldown_sec: 0 });
  });

  it("honeypot channel bans and blocks XP", async () => {
    env.db.addHoneypotChannel(env.guild.id, IDS.channelHoneypot);
    const uid = IDS.member;
    const before = env.db.getXp(env.guild.id, uid);
    const message = await env.emitMessage({
      author: env.users.memberUser,
      channel: env.channels.honeypot,
      member: env.members.member,
    });
    assert.equal(message.deleted, true);
    assertBanned(env.guild, uid);
    assertXp(env.db, env.guild.id, uid, before);
  });

  it("honeypot exempt deletes message but does not ban", async () => {
    // fresh user for exempt path
    const user = env.createUser({ id: "user-exempt-1", username: "staff" });
    const mem = env.createMember({
      guild: env.guild,
      user,
      roleIds: [IDS.roleExempt],
      admin: false,
    });
    env.guild.addMember(mem);
    env.db.addHoneypotChannel(env.guild.id, IDS.channelHoneypot);
    env.db.addHoneypotExemptRole(env.guild.id, IDS.roleExempt);

    env.guild._bans.length = 0;
    const before = env.db.getXp(env.guild.id, user.id);
    const message = await env.emitMessage({
      author: user,
      member: mem,
      channel: env.channels.honeypot,
    });
    assert.equal(message.deleted, true);
    assertNotBanned(env.guild, user.id);
    assertXp(env.db, env.guild.id, user.id, before);
  });
});
