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

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const devGuildId = process.env.DEV_GUILD_ID;

  if (!token || !clientId) {
    console.error("Missing DISCORD_TOKEN or CLIENT_ID in .env");
    process.exit(1);
  }

  const { commands } = buildDefaultRegistry();

  const rest = new REST({ version: "10" }).setToken(token);

  if (devGuildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, devGuildId), {
      body: commands,
    });
    console.log(`Registered commands to DEV guild ${devGuildId}.`);
    return;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(token);

  const guilds = await client.guilds.fetch();
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

  await client.destroy();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main };
