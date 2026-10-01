const {
  Client,
  GatewayIntentBits,
  Partials,
} = require("discord.js");
const { installGatewayPayloadGuard } = require("./core/gatewayPayloadGuard");

/**
 * Discord.js client with intents/partials required by all features.
 * @returns {import("discord.js").Client}
 */
function createClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildModeration, // bans
      GatewayIntentBits.GuildMembers, // kicks (privileged — enable Server Members Intent)
      GatewayIntentBits.GuildScheduledEvents, // event reminder interest sync
    ],
    partials: [
      Partials.Message,
      Partials.Channel,
      Partials.Reaction,
      Partials.User,
      Partials.GuildMember,
    ],
  });
  // Gateway payloads are untrusted input: keep a malformed MESSAGE_CREATE /
  // MESSAGE_UPDATE (e.g. string-shaped mentions) from killing the process.
  installGatewayPayloadGuard(client);
  return client;
}

module.exports = { createClient };
