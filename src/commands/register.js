/**
 * CLI: register slash commands with Discord.
 *
 * - DEV_GUILD_ID set: register only to that guild (instant)
 * - else: register to every guild the bot is in
 *
 * Usage: node src/commands/register.js
 * (also: npm run register)
 */
require("dotenv").config();

const {
  REST,
  Routes,
  Client,
  GatewayIntentBits,
} = require("discord.js");

const { buildDefaultRegistry } = require("./registry");
const { restTransportAgent } = require("../core/restTransportAgent");

/**
 * #917 item 1 (audit r4 F10a): `client.guilds.fetch()` with no options is a
 * SINGLE `GET /users/@me/guilds` page — the API caps a page at 200 and the
 * vendored GuildManager does no cursor loop. A bot in >200 guilds silently
 * registered commands to page 1 only, then printed "0 failed" and exited 0.
 * Page forward with the documented `after` cursor until the API stops
 * returning NEW ids (the non-advancing-cursor break also ends a mock/API
 * that ignores the parameter — never an infinite loop).
 *
 * @param {object} client discord.js client (Guilds intent)
 * @returns {Promise<Map<string, {id: string, name: string}>>}
 */
async function fetchAllGuilds(client) {
  const all = new Map();
  let after;
  for (;;) {
    const page = await client.guilds.fetch(
      after ? { after, limit: 200 } : { limit: 200 },
    );
    if (!page?.size) break;
    let lastId = null;
    for (const [id, guild] of page) {
      all.set(id, guild);
      lastId = id;
    }
    if (page.size < 200) break; // short page = last page
    if (!lastId || lastId === after) break; // cursor never advanced — stop honest, loop never
    after = lastId;
  }
  return all;
}

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const devGuildId = process.env.DEV_GUILD_ID;

  if (!token || !clientId) {
    console.error("Missing DISCORD_TOKEN or CLIENT_ID in .env");
    process.exit(1);
  }

  const { commands } = buildDefaultRegistry();

  // E2E spike seam (mirrors src/client.js): DISCORD_API_BASE redirects this
  // CLI at a local mock Discord (fauxcord) instead of discord.com. Unset in
  // production ⇒ options exactly as before.
  const apiBase =
    typeof process.env.DISCORD_API_BASE === "string"
      ? process.env.DISCORD_API_BASE.trim()
      : "";
  const restApi = apiBase ? `${apiBase.replace(/\/+$/, "")}/api` : undefined;

  // #855 parity with src/client.js: pin the REST transport agent so the
  // dispatcher never comes from the (hijackable) process-global undici slot.
  const agent = restTransportAgent();
  const restOptions = {
    version: "10",
    ...(restApi ? { api: restApi } : {}),
    ...(agent ? { agent } : {}),
  };

  const rest = new REST(restOptions).setToken(token);

  if (devGuildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, devGuildId), {
      body: commands,
    });
    console.log(`Registered commands to DEV guild ${devGuildId}.`);
    return;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...(restApi || agent
      ? {
          rest: {
            ...(restApi ? { api: restApi } : {}),
            ...(agent ? { agent } : {}),
          },
          ...(restApi ? { ws: { compress: false } } : {}),
        }
      : {}),
  });
  await client.login(token);

  const guilds = await fetchAllGuilds(client);
  console.log(`Found ${guilds.size} guild(s)`);

  let successCount = 0;
  let failCount = 0;

  for (const [, guild] of guilds) {
    try {
      await rest.put(Routes.applicationGuildCommands(clientId, guild.id), {
        body: commands,
      });
      console.log(`Registered commands to guild: ${guild.name} (${guild.id})`);
      successCount++;
    } catch (err) {
      console.error(`Failed to register to ${guild.name} (${guild.id}):`, err?.message || err);
      failCount++;
    }
  }

  console.log(`\nRegistration complete: ${successCount} succeeded, ${failCount} failed`);

  // issue #291: each guild PUT is atomic — a failure there means the guild's
  // commands stay dark, so never signal success to the caller (CI/deploy).
  if (failCount > 0) process.exitCode = 1;

  await client.destroy();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, fetchAllGuilds };
