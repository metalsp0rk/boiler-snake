/**
 * Unit tests for normalizeDiscordMessage (src/platform/discord/normalize.js).
 * Discord fakes come from test/helpers/discord (require-safe). The guild case
 * resolves communityId through the communities table, so — same contract as
 * registry.test.js — loadDb() runs BEFORE every `src/` require below, binding
 * this process to a private temp SQLite file.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { cleanup } = loadDb();

const {
  normalizeDiscordMessage,
} = require("../src/platform/discord/normalize");
const { ensureCommunity } = require("../src/platform/community");
const {
  createGuild,
  createUser,
  createMember,
  createTextChannel,
  createMessage,
} = require("./helpers/discord");
const { IDS } = require("./helpers/fixtures");

after(cleanup);

const TS = Date.UTC(2026, 0, 2, 3, 4, 5);

/**
 * Guild message with the duck fields the normalizer reads (createMessage is a
 * plain object, so Collection-shaped extras are assigned directly).
 */
function buildGuildMessage() {
  const guild = createGuild({ id: IDS.guild });
  const author = createUser({ id: IDS.member, username: "member" });
  const channel = createTextChannel({ id: IDS.channelGeneral, guild });
  const message = createMessage({
    guild,
    channel,
    author,
    content: "!hello world",
    id: "1234567890123456789",
  });
  message.mentions = {
    users: new Map([[IDS.member, author]]),
    roles: new Map([["role-staff", {}]]),
    channels: new Map([[IDS.channelLog, {}]]),
    everyone: true,
  };
  message.attachments = new Map([
    ["att-1", { name: "shot.png", url: "https://cdn.example/shot.png" }],
  ]);
  message.createdTimestamp = TS;
  return { guild, author, message };
}

describe("platform/discord/normalize — normalizeDiscordMessage", () => {
  it("throws a TypeError when the argument is not an object", () => {
    for (const bad of [null, undefined, "msg", 42]) {
      assert.throws(
        () => normalizeDiscordMessage(bad),
        (err) =>
          err instanceof TypeError &&
          /normalizeDiscordMessage: message required/.test(err.message),
        `expected TypeError for ${typeof bad}`,
      );
    }
  });

  it("returns the SAME object with the normalized fields set", () => {
    const { message } = buildGuildMessage();
    const out = normalizeDiscordMessage(message);

    // Identity contract: features and tests assert on the raw object.
    assert.equal(out, message);

    assert.equal(message.platform, "discord");
    assert.equal(message.instanceKey, "discord");
    assert.equal(message.externalGuildId, IDS.guild);
    assert.equal(typeof message.id, "string");
    assert.equal(message.id, "1234567890123456789");
    assert.equal(message.channelId, IDS.channelGeneral);
    assert.equal(message.authorId, IDS.member);
    assert.equal(message.authorBot, false);
    assert.equal(message.content, "!hello world");
    assert.deepEqual(message.mentions, {
      users: [IDS.member],
      roles: ["role-staff"],
      channels: [IDS.channelLog],
      everyone: true,
    });
    assert.deepEqual(message.attachments, [
      { name: "shot.png", url: "https://cdn.example/shot.png" },
    ]);
    assert.ok(message.createdAt instanceof Date);
    assert.equal(message.createdAt.getTime(), TS);
    // Spec line 215: Discord messages NEVER enter the prefix branch.
    assert.equal(message.parsePrefix, null);
  });

  it("resolves communityId through the communities registry", () => {
    const { message } = buildGuildMessage();
    normalizeDiscordMessage(message);
    const expected = ensureCommunity({
      platform: "discord",
      instanceKey: "discord",
      externalGuildId: IDS.guild,
    });
    assert.ok(Number.isSafeInteger(message.communityId));
    assert.equal(message.communityId, expected);
  });

  it("keeps Discord duck fields readable for unmigrated features", () => {
    const guild = createGuild({ id: IDS.guild });
    const author = createUser({ id: IDS.member });
    const member = createMember({ guild, user: author });
    const channel = createTextChannel({ id: IDS.channelGeneral, guild });
    const message = createMessage({ guild, channel, author, member });
    normalizeDiscordMessage(message);
    assert.equal(message.guild.id, IDS.guild);
    assert.equal(message.author.id, IDS.member);
    assert.equal(message.member, member);
    assert.equal(typeof message.delete, "function");
    assert.equal(message.deleted, false);
  });

  it("is idempotent", () => {
    const { message } = buildGuildMessage();
    normalizeDiscordMessage(message);
    const snapshot = { ...message };
    const again = normalizeDiscordMessage(message);
    assert.equal(again, message);
    assert.deepEqual(again, snapshot);
  });

  it("leaves guild-less messages null-identified and never throws", () => {
    const author = createUser({ id: IDS.member2, username: "member2", bot: true });
    const message = createMessage({
      guild: null,
      channel: null,
      author,
      content: "dm ping",
    });
    assert.doesNotThrow(() => normalizeDiscordMessage(message));
    assert.equal(message.externalGuildId, null);
    assert.equal(message.communityId, null);
    assert.equal(message.channelId, null);
    assert.equal(message.authorBot, true);
    assert.deepEqual(message.mentions, {
      users: [],
      roles: [],
      channels: [],
      everyone: false,
    });
    assert.deepEqual(message.attachments, []);
    assert.equal(message.createdAt, null);
    assert.equal(message.parsePrefix, null);
  });
});
