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

// ---------------------------------------------------------------------------
// #175 crash class: malformed reply/snapshot fields throw SYNCHRONOUSLY
// inside the discord.js Message constructor — before any handler, pipeline
// try/catch, or the emit itself — reaching only the process net. The guard
// repairs the shape BEFORE construction; the message then hydrates as
// unreferenced with every other field intact.
// ---------------------------------------------------------------------------

test("sanitizeMessagePayload drops non-object message_reference values", () => {
  const nullRef = { id: "30", message_reference: null };
  assert.equal("message_reference" in sanitizeMessagePayload(nullRef), false);
  const undefRef = { id: "30", message_reference: undefined };
  assert.equal("message_reference" in sanitizeMessagePayload(undefRef), false);
  const strRef = { id: "30", message_reference: "40" };
  assert.equal("message_reference" in sanitizeMessagePayload(strRef), false);
});

test("sanitizeMessagePayload keeps snapshots only when an array rides with a usable reference", () => {
  const snapshots = [{ message: { content: "forwarded" } }];
  const orphan = { id: "30", message_snapshots: snapshots };
  assert.equal("message_snapshots" in sanitizeMessagePayload(orphan), false);

  const notArray = {
    id: "30",
    message_reference: { channel_id: "20", guild_id: "10", message_id: "40", type: 1 },
    message_snapshots: "yes",
  };
  assert.equal("message_snapshots" in sanitizeMessagePayload(notArray), false);

  const usable = {
    id: "30",
    message_reference: { channel_id: "20", guild_id: "10", message_id: "40", type: 1 },
    message_snapshots: snapshots,
  };
  assert.equal(
    sanitizeMessagePayload(usable),
    usable,
    "well-formed snapshot payloads pass through by identity",
  );
});

test("sanitizeMessagePayload repairs mentions beyond the string-array incident", () => {
  const bare = { id: "30", mentions: "1223661663560142963" };
  assert.equal("mentions" in sanitizeMessagePayload(bare), false, "non-array mentions dropped");

  const mixed = sanitizeMessagePayload({
    id: "30",
    mentions: ["1223661663560142963", 123, null, [1], { id: "99", username: "ok" }],
  });
  assert.deepEqual(mixed.mentions, [
    { id: "1223661663560142963" },
    { id: "123" },
    { id: "99", username: "ok" },
  ]);
});

function createPayload(extra) {
  return {
    id: "31",
    channel_id: "20",
    guild_id: "10",
    content: "hi",
    author: { id: "5", username: "a", discriminator: "0001" },
    timestamp: "2026-10-26T12:00:00.000Z",
    ...extra,
  };
}

test("regression #175: a NULL message_reference no longer throws (crash class pinned first)", () => {
  const bare = makeClient();
  // Pins the installed discord.js behavior: the constructor enters the
  // reference block on the KEY and reads `.channel_id` off null.
  assert.throws(
    () => bare.actions.MessageCreate.handle(createPayload({ message_reference: null })),
    (err) => err instanceof TypeError && /channel_id/.test(err.message),
  );
  bare.destroy();

  const client = makeClient();
  installGatewayPayloadGuard(client);
  const { message } = client.actions.MessageCreate.handle(createPayload({ message_reference: null }));
  assert.equal(message.reference, null, "hydrates as unreferenced");
  assert.equal(message.content, "hi", "every other field survives");
  client.destroy();
});

test("regression #175: message_snapshots WITHOUT a reference no longer throws", () => {
  const bare = makeClient();
  assert.throws(
    () =>
      bare.actions.MessageCreate.handle(
        createPayload({ message_snapshots: [{ message: { content: "forwarded" } }] }),
      ),
    (err) => err instanceof TypeError && /channelId/.test(err.message),
  );
  bare.destroy();

  const client = makeClient();
  installGatewayPayloadGuard(client);
  const { message } = client.actions.MessageCreate.handle(
    createPayload({ message_snapshots: [{ message: { content: "forwarded" } }] }),
  );
  assert.equal(message.messageSnapshots.size, 0, "orphan snapshots are dropped, not fatal");
  assert.equal(message.content, "hi");
  client.destroy();
});

test("regression #175: snapshots WITH a usable reference ride the real constructor (fidelity)", () => {
  const client = makeClient();
  installGatewayPayloadGuard(client);
  const { message } = client.actions.MessageCreate.handle(
    createPayload({
      message_reference: { channel_id: "20", guild_id: "10", message_id: "40", type: 1 },
      message_snapshots: [
        {
          message: {
            content: "the forwarded text",
            author: { id: "7", username: "orig", discriminator: "0001" },
            timestamp: "2026-10-25T12:00:00.000Z",
          },
        },
      ],
    }),
  );
  assert.equal(message.messageSnapshots.size, 1);
  assert.equal(message.messageSnapshots.first().content, "the forwarded text");
  assert.equal(message.reference.messageId, "40");
  assert.equal(message.reference.type, 1);
  client.destroy();
});

test("regression #175: non-array mentions (bare string payload) no longer throws", () => {
  const bare = makeClient();
  assert.throws(
    () => bare.actions.MessageCreate.handle(createPayload({ mentions: "1223661663560142963" })),
    TypeError,
  );
  bare.destroy();

  const client = makeClient();
  installGatewayPayloadGuard(client);
  const { message } = client.actions.MessageCreate.handle(
    createPayload({ mentions: "1223661663560142963" }),
  );
  assert.equal(message.mentions.users.size, 0);
  client.destroy();
});

test("regression #175: MESSAGE_UPDATE carries the same repairs", () => {
  const client = makeClient();
  seedCachedMessage(client);
  installGatewayPayloadGuard(client);
  const { updated } = client.actions.MessageUpdate.handle({
    id: "30",
    channel_id: "20",
    guild_id: "10",
    content: "edited",
    message_reference: null,
    message_snapshots: [{ message: { content: "orphan" } }],
    mentions: ["1223661663560142963"],
    edited_timestamp: "2026-10-26T12:05:00.000Z",
  });
  assert.equal(updated.content, "edited");
  assert.equal(updated.mentions.users.first().id, "1223661663560142963");
  client.destroy();
});
