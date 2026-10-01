const { test } = require("node:test");
const assert = require("node:assert/strict");

const { sanitizeMessagePayload, installGatewayPayloadGuard } = require("../src/core/gatewayPayloadGuard");

/**
 * 2026-10-01 prod incident: Discord gateway MESSAGE_UPDATE payloads
 * carrying `mentions: ["<snowflake>", ...]` (raw ID strings) crashed the
 * process inside User._patch (`'username' in data` on a string),
 * crash-looping the bot. These tests build the exact payload shape
 * against real discord.js structures — no login required.
 */

test("sanitizeMessagePayload converts string mentions to {id} user objects", () => {
  const data = {
    id: "30",
    channel_id: "20",
    guild_id: "10",
    mentions: ["1223661663560142963", { id: "99", username: "ok" }],
  };
  const out = sanitizeMessagePayload(data);
  assert.notEqual(out, data, "payloads needing repair are copied, input never mutated");
  assert.deepEqual(out.mentions[0], { id: "1223661663560142963" });
  assert.equal(out.mentions[1], data.mentions[1], "object entries pass through by reference");
  assert.equal(data.mentions[0], "1223661663560142963", "input array is not mutated");
});

test("sanitizeMessagePayload is identity for well-formed and non-array payloads", () => {
  const users = [{ id: "1", username: "a" }];
  const ok = { id: "30", mentions: users };
  assert.equal(sanitizeMessagePayload(ok), ok);
  const noMentions = { id: "30" };
  assert.equal(sanitizeMessagePayload(noMentions), noMentions);
  assert.equal(sanitizeMessagePayload(null), null);
  assert.equal(sanitizeMessagePayload(undefined), undefined);
});

function makeClient() {
  const { Client, Partials, ChannelType } = require("discord.js");
  const client = new Client({
    intents: [],
    partials: [Partials.Message, Partials.Channel, Partials.User],
  });
  client.guilds._add({ id: "10", name: "g", unavailable: false });
  client.channels._add({ id: "20", guild_id: "10", name: "c", type: ChannelType.GuildText });
  return client;
}

/** Seed a cached message so MESSAGE_UPDATE reaches Message._patch (prod path). */
function seedCachedMessage(client) {
  const channel = client.channels.cache.get("20");
  channel.messages._add({
    id: "30",
    channel_id: "20",
    guild_id: "10",
    content: "original",
    author: { id: "5", username: "a", discriminator: "0001" },
    timestamp: "2026-10-01T19:44:00.000Z",
  });
}

test("regression: MESSAGE_UPDATE with string-shaped mentions no longer throws", () => {
  const client = makeClient();
  seedCachedMessage(client);
  installGatewayPayloadGuard(client);

  // The prod payload shape, verbatim: raw snowflake strings in mentions.
  const payload = {
    id: "30",
    channel_id: "20",
    guild_id: "10",
    content: "edited",
    mentions: ["1223661663560142963"],
    edited_timestamp: "2026-10-01T19:45:00.000Z",
  };

  const { updated } = client.actions.MessageUpdate.handle(payload);
  assert.ok(updated, "the update produced a message (partial, cached)");
  assert.equal(updated.mentions.users.first().id, "1223661663560142963");

  client.destroy();
});

test("regression: MESSAGE_CREATE with string-shaped mentions no longer throws", () => {
  const client = makeClient();
  installGatewayPayloadGuard(client);

  const payload = {
    id: "31",
    channel_id: "20",
    guild_id: "10",
    content: "hi",
    author: { id: "5", username: "a", discriminator: "0001" },
    mentions: ["1223661663560142963", "999999999999999999"],
    timestamp: "2026-10-01T19:45:00.000Z",
  };

  const { message } = client.actions.MessageCreate.handle(payload);
  assert.deepEqual(
    [...message.mentions.users.keys()],
    ["1223661663560142963", "999999999999999999"],
  );

  client.destroy();
});

test("regression: without the guard the payload shape crashes (documents the incident)", () => {
  const client = makeClient();
  seedCachedMessage(client);
  const payload = {
    id: "30",
    channel_id: "20",
    guild_id: "10",
    mentions: ["1223661663560142963"],
  };
  // Pins the bug: the installed discord.js throws on this shape. If a future
  // discord.js tolerates string mentions, this test is the signal to revisit
  // (and eventually drop) the guard.
  assert.throws(
    () => client.actions.MessageUpdate.handle(payload),
    /Cannot use 'in' operator to search for 'username'/,
  );
  client.destroy();
});
