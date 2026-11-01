/**
 * Unit tests for normalizeDiscordMessage (src/platform/discord/normalize.js).
 * Discord fakes come from test/helpers/discord (require-safe) — EXCEPT the
 * #795 block below, which drives the REAL discord.js classes on purpose: the
 * bug lives in discord.js' own patch path, so mocks cannot pin it. The guild
 * case resolves communityId through the communities table, so — same contract
 * as registry.test.js — loadDb() runs BEFORE every `src/` require below,
 * binding this process to a private temp SQLite file.
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
      {
        name: "shot.png",
        url: "https://cdn.example/shot.png",
        id: null,
        size: null,
        contentType: null,
        flags: null,
      },
    ]);
    assert.ok(message.createdAt instanceof Date);
    assert.equal(message.createdAt.getTime(), TS);
    // Relay-required fields (§10.3 item 4) at their "absent" values here.
    assert.equal(message.webhookId, null);
    assert.equal(message.type, null);
    assert.deepEqual(message.messageSnapshots, []);
    assert.deepEqual(message.stickers, []);
    assert.equal(message.parsePrefix, null);
  });

  it("fills the relay-required fields from the payload (webhookId, displayName, type, attachment detail, snapshots, stickers)", () => {
    const { guild } = buildGuildMessage();
    const author = createUser({ id: IDS.member, username: "member" });
    author.globalName = "Spark 🐍";
    const member = createMember({ guild, user: author, displayName: "Spark (nick)" });
    const channel = createTextChannel({ id: IDS.channelGeneral, guild });
    const message = createMessage({ guild, channel, author, member, id: "900" });
    message.webhookId = "1554600000000000099";
    message.type = 0;
    message.attachments = new Map([
      [
        "att-9",
        {
          id: "att-9",
          name: "clip.mp4",
          url: "https://cdn.test/clip.mp4",
          size: 4321,
          contentType: "video/mp4",
          flags: 1n, // bigint-backed BitField → number at the boundary
        },
      ],
    ]);
    message.stickers = new Map([["st-1", { id: "st-1", name: "gork" }]]);
    message.messageSnapshots = [{ message: { content: "forwarded" } }];

    normalizeDiscordMessage(message);

    // Both raw truths: authorId stays the author, webhookId is the payload's.
    assert.equal(message.authorId, IDS.member);
    assert.equal(message.webhookId, "1554600000000000099");
    // Guild member display name wins over the author's global name.
    assert.equal(message.authorDisplayName, "Spark (nick)");
    assert.equal(message.type, 0);
    assert.deepEqual(message.attachments, [
      {
        name: "clip.mp4",
        url: "https://cdn.test/clip.mp4",
        id: "att-9",
        size: 4321,
        contentType: "video/mp4",
        flags: 1,
      },
    ]);
    assert.deepEqual(message.stickers, [{ id: "st-1", name: "gork" }]);
    assert.deepEqual(message.messageSnapshots, [{ message: { content: "forwarded" } }]);
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
    // Relay fields on a bare DM-shaped message: all at their absent defaults,
    // display name falling back to the username (never undefined).
    assert.equal(message.webhookId, null);
    assert.equal(message.type, null);
    assert.deepEqual(message.messageSnapshots, []);
    assert.deepEqual(message.stickers, []);
    assert.equal(message.authorDisplayName, "member2");
    assert.equal(message.parsePrefix, null);
  });
});

/**
 * #795 (prod 1.39.1): normalizeDiscordMessage rewrote `mentions.users` (and
 * friends) on the LIVE discord.js cache entry. The next MESSAGE_UPDATE
 * patched that instance in place and re-fed the id-array into
 * MessageMentions → `new User(client, "<snowflake>")` → escaped
 * unhandledRejection (`Cannot use 'in' operator to search for 'username'`),
 * repeating for every later edit of the message. These tests replay the real
 * gateway frames (no login) and pin the duck-clone contract.
 */
describe("platform/discord/normalize — #795 discord.js cache safety", () => {
  const REAL_MENTION = { id: "854378445940981811", username: "m", discriminator: "0002" };

  /** Real client/guild/channel + a cached Message with a real mentioned User. */
  function makeRealMessage() {
    const { Client, Partials, ChannelType } = require("discord.js");
    const client = new Client({
      intents: [],
      partials: [Partials.Message, Partials.Channel, Partials.User],
    });
    client.guilds._add({ id: "10", name: "g", unavailable: false });
    client.channels._add({ id: "20", guild_id: "10", name: "c", type: ChannelType.GuildText });
    const cached = client.channels.cache
      .get("20")
      .messages._add({
        id: "30",
        channel_id: "20",
        guild_id: "10",
        content: "ping <@854378445940981811>",
        author: { id: "5", username: "a", discriminator: "0001" },
        mentions: [REAL_MENTION],
        timestamp: "2026-11-01T07:20:00.000Z",
      });
    return { client, cached };
  }

  it("normalizes a real discord.js Message onto a duck-clone, not the cache entry", () => {
    const { client, cached } = makeRealMessage();
    const { Collection, Message } = require("discord.js");
    try {
      const out = normalizeDiscordMessage(cached);

      // Clone contract: the pipeline view is normalized…
      assert.notEqual(out, cached, "real Messages normalize on a clone (#795)");
      assert.ok(out instanceof Message, "the clone keeps the discord.js prototype chain");
      assert.deepEqual(out.mentions, {
        users: ["854378445940981811"],
        roles: [],
        channels: [],
        everyone: false,
      });
      assert.deepEqual(out.attachments, []);
      assert.equal(out.platform, "discord");
      assert.equal(out.id, "30");
      assert.equal(out.externalGuildId, "10");
      // …with the full duck profile intact.
      assert.equal(out.author.id, "5");
      assert.equal(typeof out.delete, "function");

      // …while the live cache entry keeps discord.js-owned shapes.
      assert.ok(cached.mentions.users instanceof Collection);
      assert.equal(cached.mentions.users.get("854378445940981811").username, "m");
      assert.ok(cached.attachments instanceof Collection);
    } finally {
      client.destroy();
    }
  });

  it("the cached entry survives the MESSAGE_UPDATE patch that crashed prod", () => {
    const { client, cached } = makeRealMessage();
    const { Collection } = require("discord.js");
    try {
      normalizeDiscordMessage(cached);

      // Verbatim prod trigger: a bare edit payload through the real action
      // (getPayload → _add → existing._patch — the frame that used to throw).
      const { updated } = client.actions.MessageUpdate.handle({
        id: "30",
        channel_id: "20",
        guild_id: "10",
        content: "ping <@854378445940981811> (edited)",
        edited_timestamp: "2026-11-01T07:21:00.000Z",
      });

      assert.ok(updated, "the edit patch reached handlers (no User._patch throw)");
      assert.equal(updated.content, "ping <@854378445940981811> (edited)");
      assert.ok(cached.mentions.users instanceof Collection, "mentions stay djs-shaped");
      assert.equal(cached.mentions.users.get("854378445940981811").username, "m");
    } finally {
      client.destroy();
    }
  });

  it("normalizes a minimal partial instance (Partials.Message getPayload shape)", () => {
    const { client } = makeRealMessage();
    try {
      // With Partials.Message enabled, Action.getPayload constructs exactly
      // this: a Message built from the bare {id, channel_id, guild_id} patch
      // data. Normalizing one must stay contract-shaped and never throw.
      const partial = client.channels.cache
        .get("20")
        .messages._add({ id: "31", channel_id: "20", guild_id: "10" });
      const out = normalizeDiscordMessage(partial);
      assert.equal(out.platform, "discord");
      assert.equal(out.externalGuildId, "10");
      assert.ok(Number.isSafeInteger(out.communityId));
      assert.equal(out.authorId, null);
      assert.equal(out.content, "");
      assert.deepEqual(out.mentions, { users: [], roles: [], channels: [], everyone: false });
    } finally {
      client.destroy();
    }
  });

  it("re-normalizing the clone is idempotent (MessageUpdate pipeline pass)", () => {
    const { client, cached } = makeRealMessage();
    try {
      const once = normalizeDiscordMessage(cached);
      const twice = normalizeDiscordMessage(once);
      assert.deepEqual(twice.mentions.users, ["854378445940981811"]);
      assert.deepEqual(twice.attachments, []);
      assert.equal(twice.content, once.content);
    } finally {
      client.destroy();
    }
  });
});
