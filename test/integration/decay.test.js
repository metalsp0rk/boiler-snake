const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const { assertXp } = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");

/**
 * PR 7 fake supervisor: ticker entry points take a supervisor and resolve the
 * OutboundClient per community via clientForCommunity (roadmap/fluxer.md §
 * Scheduler jobs). Discord-only in tests — fluxer rows resolve to null.
 */
function fakeSupervisor(client) {
  const { getDiscordOutbound } = require("../../src/platform/discord/outbound");
  return {
    discord: client,
    fluxer: new Map(),
    clientForCommunity: () => getDiscordOutbound(client),
  };
}

describe("integration: decay", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let runDecayForGuild;

  after(() => {
    // Close SQLite handles and remove the temp dir created for this env.
    env?.cleanup();
  });

  before(async () => {
    env = await createIntegrationEnv();
    runDecayForGuild = require("../../src/features/decay").runDecayForGuild;
  });

  it("no-ops when decay disabled", async () => {
    env.db.updateGuildSettings(env.communityId, {
      decay_enabled: 0,
      decay_percent: 0.5,
      decay_min_messages: 10,
      decay_window_days: 7,
    });
    env.db.setXp(env.communityId, IDS.member, 1000);
    await runDecayForGuild(fakeSupervisor(env.client), env.communityId);
    assertXp(env.db, env.communityId, IDS.member, 1000);
  });

  it("reduces XP for inactive users", async () => {
    env.db.updateGuildSettings(env.communityId, {
      decay_enabled: 1,
      decay_percent: 0.1,
      decay_min_messages: 5,
      decay_window_days: 7,
    });
    env.db.setXp(env.communityId, IDS.member, 1000);
    // no activity rows → count 0 < 5
    await runDecayForGuild(fakeSupervisor(env.client), env.communityId);
    assertXp(env.db, env.communityId, IDS.member, 900);
  });

  it("skips users who meet message threshold", async () => {
    env.db.updateGuildSettings(env.communityId, {
      decay_enabled: 1,
      decay_percent: 0.5,
      decay_min_messages: 3,
      decay_window_days: 7,
    });
    env.db.setXp(env.communityId, IDS.member2, 800);
    for (let i = 0; i < 3; i++) {
      env.db.logActivity(env.communityId, IDS.member2, "message", 1);
    }
    await runDecayForGuild(fakeSupervisor(env.client), env.communityId);
    assertXp(env.db, env.communityId, IDS.member2, 800);
  });
});
