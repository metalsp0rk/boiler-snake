const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const { assertXp } = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

describe("integration: decay", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let runDecayForGuild;

  before(async () => {
    env = await createIntegrationEnv();
    runDecayForGuild = require("../../src/features/decay").runDecayForGuild;
  });

  it("no-ops when decay disabled", async () => {
    env.db.updateGuildSettings(env.guild.id, {
      decay_enabled: 0,
      decay_percent: 0.5,
      decay_min_messages: 10,
      decay_window_days: 7,
    });
    env.db.setXp(env.guild.id, IDS.member, 1000);
    await runDecayForGuild(env.client, env.guild.id);
    assertXp(env.db, env.guild.id, IDS.member, 1000);
  });

  it("reduces XP for inactive users", async () => {
    env.db.updateGuildSettings(env.guild.id, {
      decay_enabled: 1,
      decay_percent: 0.1,
      decay_min_messages: 5,
      decay_window_days: 7,
    });
    env.db.setXp(env.guild.id, IDS.member, 1000);
    // no activity rows → count 0 < 5
    await runDecayForGuild(env.client, env.guild.id);
    assertXp(env.db, env.guild.id, IDS.member, 900);
  });

  it("skips users who meet message threshold", async () => {
    env.db.updateGuildSettings(env.guild.id, {
      decay_enabled: 1,
      decay_percent: 0.5,
      decay_min_messages: 3,
      decay_window_days: 7,
    });
    env.db.setXp(env.guild.id, IDS.member2, 800);
    for (let i = 0; i < 3; i++) {
      env.db.logActivity(env.guild.id, IDS.member2, "message", 1);
    }
    await runDecayForGuild(env.client, env.guild.id);
    assertXp(env.db, env.guild.id, IDS.member2, 800);
  });
});
