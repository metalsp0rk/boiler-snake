/**
 * Pins for the PR 5 (gap #1) session-key conversion on the DISCORD consumer:
 * `handlePendingOptionEmojiMessage` must resolve the same INTEGER community id
 * the command producers (index.js option add/remove) write. The key change
 * lives at service.js's `Number.isSafeInteger(message.communityId) ? … :
 * communityIdFor(guild.id)` line — exactly the code no existing test touched.
 *
 * Duck-shaped discord.js messages (no gateway): the consumer only needs
 * guild.id / author.id+bot / content / channel.send / reply; the refresh leg
 * is driven to a named failure ("Panel message is missing") so the option
 * row + reply are assertable without a full discord.js mock (same as the
 * shipped Discord arm's degraded behavior: "Saved option, but panel refresh
 * failed").
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { api: dbApi, cleanup } = loadDb();

const service = require("../src/features/reactionRoles/service");
const { ensureCommunity } = require("../src/platform/community");

after(cleanup);

const GUILD = "700000000000000001";
const CH = "8001";
const USER = "user-1";
const ROLE = "role-9";

const DISCORD_CID = ensureCommunity({
  platform: "discord",
  instanceKey: "discord",
  externalGuildId: GUILD,
});

function fakeDiscordMessage(overrides = {}) {
  const sent = [];
  const message = {
    // channels.fetch rejects → fetchPanelMessage resolves null → the refresh
    // names "Panel message is missing" (the consumer saves the option first,
    // so the row + reply are assertable without a full discord.js mock).
    guild: { id: GUILD, channels: { fetch: async () => { throw new Error("no access"); } } },
    author: { id: USER, bot: false, username: "admin" },
    channel: {
      id: CH,
      send: async (p) => {
        sent.push(p);
        return { id: "9002" };
      },
    },
    content: "👍",
    client: {},
    reply: async (p) => {
      sent.push({ ...p, referenced: true });
      return {};
    },
    ...overrides,
  };
  return { message, sent };
}

describe("discord reaction roles — pending-emoji consumer keying (PR 5 pin)", () => {
  it("resolves the producer's community id from the guild snowflake (create-on-sight edge)", async () => {
    // The producer (index.js) keys the session by commandCtx.communityId,
    // which the Discord context derives from the same (platform, instanceKey,
    // externalGuildId) triple — the consumer must land on the same row.
    dbApi.createReactionRolePanel(DISCORD_CID, CH, "9001", "Roles", "React to get a role.");
    service.setPendingOptionAdd(DISCORD_CID, USER, {
      messageId: "9001",
      roleId: ROLE,
      level: 2,
      removable: true,
      channelId: CH,
    });

    const { message, sent } = fakeDiscordMessage();
    const res = await service.handlePendingOptionEmojiMessage(message);

    assert.equal(res.handled, true, "the guild message feeds the admin's open session");
    // No channels.fetch on the fake → refresh names its missing message; the
    // option row itself must be persisted under the INTEGER community id.
    const opt = dbApi.getReactionRoleOption(DISCORD_CID, "9001", "👍");
    assert.ok(opt, "option row persisted under the integer community id");
    assert.equal(String(opt.role_id), ROLE);
    assert.equal(Number(opt.min_level), 2);
    // Refresh failure is the touch path (Discord twin parity): the session
    // stays open so the admin can retry; the reply says so.
    assert.equal(service.hasPendingOptionEmoji(DISCORD_CID, USER), true, "refresh failure keeps the session open");
    const reply = sent.find((p) => p.referenced);
    assert.ok(reply, "admin got the reply");
    assert.match(reply.content, /Saved option, but panel refresh failed/);
    assert.match(reply.content, /Still waiting — try another emoji/);
    service.clearPendingOptionEmoji(DISCORD_CID, USER);
  });

  it("a normalized message carrying an INTEGER communityId is consumed under that key", async () => {
    dbApi.createReactionRolePanel(DISCORD_CID, CH, "9002", "Roles", "React to get a role.");
    service.setPendingOptionAdd(DISCORD_CID, USER, {
      messageId: "9002",
      roleId: ROLE,
      level: 0,
      removable: true,
      channelId: CH,
    });

    // transport-provided communityId (bridge/audit shape) wins over the guild
    // snowflake mapping — the consumer must not create a second community.
    const { message, sent } = fakeDiscordMessage({ communityId: DISCORD_CID });
    const res = await service.handlePendingOptionEmojiMessage(message);

    assert.equal(res.handled, true);
    assert.ok(dbApi.getReactionRoleOption(DISCORD_CID, "9002", "👍"), "row under the provided id");
    // Refresh-failure touch (see test 1): the session stays open for a retry.
    assert.equal(service.hasPendingOptionEmoji(DISCORD_CID, USER), true);
    assert.equal(sent.length, 1, "exactly one reply send");
    assert.match(sent[0].content, /Saved option, but panel refresh failed/);
    service.clearPendingOptionEmoji(DISCORD_CID, USER);
  });

  it("a guild-snowflake message cannot consume a session keyed under a different community", async () => {
    // Key-collision mirror of the Fluxer pin: an external guild id that maps
    // to a DIFFERENT community row must not open the DISCORD_CID session.
    const otherCid = ensureCommunity({
      platform: "discord",
      instanceKey: "discord",
      externalGuildId: "700000000000000002",
    });
    service.setPendingOptionAdd(DISCORD_CID, USER, {
      messageId: "9003",
      roleId: ROLE,
      level: 0,
      removable: true,
      channelId: CH,
    });

    const { message, sent } = fakeDiscordMessage({ guild: { id: "700000000000000002" } });
    assert.notEqual(otherCid, DISCORD_CID);
    const res = await service.handlePendingOptionEmojiMessage(message);

    assert.equal(res.handled, false, "cross-guild messages never feed a guild-scoped session");
    assert.equal(sent.length, 0, "no sends");
    assert.equal(service.hasPendingOptionEmoji(DISCORD_CID, USER), true, "session intact");
    service.clearPendingOptionEmoji(DISCORD_CID, USER);
  });
});
