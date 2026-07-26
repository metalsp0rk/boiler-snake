const {
  Client,
  GatewayIntentBits,
  Partials,
} = require("discord.js");

/**
 * Discord.js client with intents/partials required by all features.
 * @returns {import("discord.js").Client}
 */
function createClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildModeration, // bans
      GatewayIntentBits.GuildMembers, // kicks (privileged — enable Server Members Intent)
    ],
    partials: [
      Partials.Message,
      Partials.Channel,
      Partials.Reaction,
      Partials.User,
      Partials.GuildMember,
    ],
  });
}

module.exports = { createClient };
