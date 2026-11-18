const {
  Client,
  GatewayIntentBits,
  Partials,
} = require("discord.js");
const { installGatewayPayloadGuard } = require("./core/gatewayPayloadGuard");
const { restTransportAgent } = require("./core/restTransportAgent");

/**
 * Resolve discord.js client options. With DISCORD_API_BASE UNSET (production
 * default) the options are exactly what they have always been (plus the
 * pinned REST transport agent, #855). When set to an http(s) origin (E2E
 * spike only — e.g. a local fauxcord mock server), REST is pointed at
 * `<base>/api` (→ `/api/v10/...`) and transport compression is disabled
 * because the mock speaks plain JSON frames only. The gateway URL needs no
 * separate override: discord.js discovers it through this same REST via
 * GET /gateway/bot, so the mock transparently owns both planes.
 *
 * @returns {import("discord.js").ClientOptions}
 */
function clientOptions() {
  const options = {
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildModeration, // bans
      GatewayIntentBits.GuildMembers, // kicks (privileged — enable Server Members Intent)
      GatewayIntentBits.GuildScheduledEvents, // event reminder interest sync
      // #851: real Discord delivers DM MESSAGE_CREATE only to subscribers of
      // DirectMessages (NOT privileged — no portal toggle). Without it the
      // ban-appeals ferry inbound lane (guild-less MessageCreate → ticket
      // relay) was silently dead in production while every mock/test passed.
      GatewayIntentBits.DirectMessages,
    ],
    partials: [
      Partials.Message,
      Partials.Channel,
      Partials.Reaction,
      Partials.User,
      Partials.GuildMember,
    ],
  };
  // #855: give REST an explicit transport agent so it never inherits the
  // process-global undici dispatcher — jsdom's vendored undici@8 hijacks
  // that global the first time gork `readPage` loads it, and multipart
  // replies (/leaderboard's PNG) then die on its foreign-FormData gate.
  const rest = {};
  const agent = restTransportAgent();
  if (agent) rest.agent = agent;
  const base =
    typeof process.env.DISCORD_API_BASE === "string"
      ? process.env.DISCORD_API_BASE.trim()
      : "";
  if (base) {
    console.warn(
      `[client] DISCORD_API_BASE is set (${base}) — Discord REST/Gateway traffic targets a MOCK server (E2E only, never production)`,
    );
    rest.api = `${base.replace(/\/+$/, "")}/api`;
    options.ws = { compress: false };
  }
  if (Object.keys(rest).length > 0) options.rest = rest;
  return options;
}

/**
 * Discord.js client with intents/partials required by all features.
 * @returns {import("discord.js").Client}
 */
function createClient() {
  const client = new Client(clientOptions());
  // Gateway payloads are untrusted input: keep a malformed MESSAGE_CREATE /
  // MESSAGE_UPDATE (e.g. string-shaped mentions) from killing the process.
  installGatewayPayloadGuard(client);
  return client;
}

// #470 (H1-2): clientOptions is internal-only (the dead export was dropped).
module.exports = { createClient };
