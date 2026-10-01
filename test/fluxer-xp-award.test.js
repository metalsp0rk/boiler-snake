/**
 * Pipeline-level regression: a plain (non-prefix) Fluxer message must earn
 * message XP (roadmap/fluxer.md: XP accrual is platform-agnostic).
 *
 * Prod 2026-10-01: tryAwardMessageXp read the Discord duck fields
 * (message.author.id / message.guild.id); Fluxer normalized messages carry
 * authorId / externalGuildId, so EVERY Fluxer message threw
 * "Cannot read properties of undefined (reading 'id')" inside the pipeline
 * catch and no Fluxer message ever awarded XP. No test exercised this path.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");
const { api: dbApi, cleanup } = loadDb();

const pipelines = require("../src/bot/pipelines");
const { buildDefaultRegistry } = require("../src/commands/registry");
const { normalizeFluxerMessage } = require("../src/platform/fluxer/normalize");
const { ensureCommunity } = require("../src/platform/community");
const users = require("../src/db/repositories/users");
const { getGuildSettings } = require("../src/db/repositories/guildSettings");
const { makeFakeRest, makeFakeHandle, gatewayMessage } = require("./helpers/fluxer");

after(cleanup);

const INSTANCE = "https://fluxer.test";
const GUILD = "1554590611015729152";
const CHANNEL = "555000111";
const registry = buildDefaultRegistry();

function fluxerPlainMessage() {
  const normalized = normalizeFluxerMessage(
    {
      t: "MESSAGE_CREATE",
      d: gatewayMessage({ content: "off-topic human chatter", channel_id: CHANNEL, guild_id: GUILD }),
    },
    { instanceKey: INSTANCE },
  );
  return normalized;
}

describe("fluxer pipeline — message XP awarding", () => {
  it("a plain Fluxer message awards msg_xp without pipeline errors", async () => {
    const communityId = ensureCommunity({
      platform: "fluxer",
      instanceKey: INSTANCE,
      externalGuildId: GUILD,
    });
    const settings = getGuildSettings(communityId);
    const gain = Number(settings.msg_xp) || 0;
    assert.ok(gain > 0, "default settings must grant positive message XP");

    const rest = makeFakeRest({ routes: {} });
    const { outbound } = makeFakeHandle({ rest });
    const message = fluxerPlainMessage();

    // Before the fix this threw inside pipelines.onMessageCreate's catch
    // (logged "[MessageCreate] error: ... reading 'id'") and awarded nothing.
    await pipelines.onMessageCreate(outbound, message, { registry, supervisor: null });

    const xp = users.getXp(communityId, message.authorId);
    assert.equal(
      xp,
      gain,
      `expected exactly one msg_xp award (${gain}) for the Fluxer author`,
    );
  });
});
