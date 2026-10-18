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
const { ensureCommunity, getCommunityByExternal } = require("../src/platform/community");
const users = require("../src/db/repositories/users");
const { getGuildSettings } = require("../src/db/repositories/guildSettings");
const xpFeature = require("../src/features/xp");
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

  // ── #431 (audit XE-4): the communityId fallback must honor the PLATFORM ──
  it("an unresolved Fluxer communityId mints a FLUXER row, never a phantom discord one (#431)", async () => {
    const GUILD2 = "1554590611015729153";
    const message = normalizeFluxerMessage(
      {
        t: "MESSAGE_CREATE",
        d: gatewayMessage({
          content: "fallback chatter for 431",
          channel_id: CHANNEL,
          guild_id: GUILD2,
        }),
      },
      { instanceKey: INSTANCE },
    );
    // Simulate the pipeline's community-resolve catch firing: it logs and
    // DELIBERATELY continues (pipelines.js), so the shared XP step receives
    // a fluxer-platform message with NO communityId.
    assert.ok(message.communityId == null, "normalized shape starts without communityId");
    assert.equal(message.platform, "fluxer");

    const { outbound } = makeFakeHandle({ rest: makeFakeRest({ routes: {} }) });
    await xpFeature.tryAwardMessageXp(outbound, message, {});

    const fluxerId = getCommunityByExternal("fluxer", INSTANCE, GUILD2);
    assert.ok(fluxerId, "the fallback resolves the FLUXER community for the message's platform");
    assert.equal(
      getCommunityByExternal("discord", "discord", GUILD2),
      null,
      "NO phantom discord row keyed by a Fluxer guild id (RED: the old hardcoded fallback minted exactly that)",
    );
    const gain = Number(getGuildSettings(fluxerId).msg_xp) || 0;
    assert.ok(gain > 0);
    assert.equal(
      users.getXp(fluxerId, message.authorId),
      gain,
      "the award lands under the FLUXER community, not the phantom discord one",
    );
  });
});
