/**
 * #851 pins — the client requests every intent a shipped feature reads.
 *
 * The ban-appeals ferry inbound lane (banned user's DM → appeal ticket
 * relay, src/features/banAppeals/events.js) rides guild-less
 * MESSAGE_CREATE. Real Discord only dispatches DM messages to connections
 * that subscribed to DirectMessages — the mock never enforced that, so the
 * lane was silently dead in production while every suite stayed green.
 * These pins make the intent list itself a test surface: dropping
 * DirectMessages (or MessageContent the relay classification needs) turns
 * the suite red WITHOUT touching a single listener.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { GatewayIntentBits } = require("discord.js");

const { createClient } = require("../src/client");

describe("client intents (#851)", () => {
  it("subscribes to DirectMessages — the ferry inbound DM lane needs it", async () => {
    const client = createClient();
    assert.ok(
      client.options.intents.has(GatewayIntentBits.DirectMessages),
      "DirectMessages missing: DM MESSAGE_CREATE is never delivered and the " +
        "ban-appeals ferry inbound lane is silently dead (the exact #851 prod failure)",
    );
    await client.destroy();
  });

  it("keeps the guild-side intents every pipeline reads", async () => {
    const client = createClient();
    for (const needed of [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // ferry classification + XP tracking
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildScheduledEvents,
    ]) {
      assert.ok(
        client.options.intents.has(needed),
        `intent ${needed} dropped from clientOptions`,
      );
    }
    await client.destroy();
  });
});
