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

  // E2E spike seam (mirrors src/client.js): DISCORD_API_BASE redirects this
  // CLI at a local mock Discord (fauxcord) instead of discord.com. Unset in
  // production ⇒ options exactly as before.
  const apiBase =
    typeof process.env.DISCORD_API_BASE === "string"
      ? process.env.DISCORD_API_BASE.trim()
      : "";
  const restApi = apiBase ? `${apiBase.replace(/\/+$/, "")}/api` : undefined;

  const rest = new REST(
    restApi ? { version: "10", api: restApi } : { version: "10" },
  ).setToken(token);

  if (devGuildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, devGuildId), {
      body: commands,
    });
    console.log(`Registered commands to DEV guild ${devGuildId}.`);
    return;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...(restApi ? { rest: { api: restApi }, ws: { compress: false } } : {}),
  });
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

module.exports = { main };
