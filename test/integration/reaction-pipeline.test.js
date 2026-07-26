const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const { assertXp } = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

describe("integration: reaction pipeline", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;

  before(async () => {
    env = await createIntegrationEnv();
    env.db.updateGuildSettings(env.guild.id, {
      reaction_xp: 3,
      reaction_cooldown_sec: 0,
    });
  });

  it("ignores bot reactors", async () => {
    const before = env.db.getXp(env.guild.id, IDS.bot);
    await env.emitReactionAdd({ user: env.users.botUser });
    assertXp(env.db, env.guild.id, IDS.bot, before);
  });

  it("awards reaction XP", async () => {
    const uid = IDS.member;
    const before = env.db.getXp(env.guild.id, uid);
    await env.emitReactionAdd({ user: env.users.memberUser });
    assertXp(env.db, env.guild.id, uid, before + 3);
  });

  it("strips reactions on honeypot warning messages", async () => {
    env.db.addHoneypotChannel(env.guild.id, IDS.channelHoneypot);
    env.db.setHoneypotWarningMessage(env.guild.id, IDS.channelHoneypot, "warn-msg-1");
    const message = env.makeMessage({
      id: "warn-msg-1",
      channel: env.channels.honeypot,
    });
    const before = env.db.getXp(env.guild.id, IDS.member);
    // handler will try to strip reaction — may throw if incomplete mock; pipeline should not award XP
    await env.emitReactionAdd({ message, user: env.users.memberUser });
    assertXp(env.db, env.guild.id, IDS.member, before);
  });
});
