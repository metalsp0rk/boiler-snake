#!/usr/bin/env node
/**
 * One-off: ensure every member of a guild has a given role.
 *
 * Usage:
 *   node scripts/ensure-role.js <guildId> <roleId>
 *   node scripts/ensure-role.js <guildId> <roleId> --dry-run
 *   node scripts/ensure-role.js <guildId> <roleId> --include-bots
 *
 * Requirements:
 *   - DISCORD_TOKEN in .env (same as the bot)
 *   - Bot has "Server Members Intent" enabled in the Discord Developer Portal
 *   - Bot has Manage Roles in the guild
 *   - Bot's highest role is above the target role
 */

require("dotenv").config();

const { Client, GatewayIntentBits, PermissionFlagsBits } = require("discord.js");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));

const GUILD_ID = args[0];
const ROLE_ID = args[1];
const DRY_RUN = flags.has("--dry-run");
const INCLUDE_BOTS = flags.has("--include-bots");

// Small delay between role adds to reduce rate-limit pressure on large servers
const DELAY_MS = 300;

function usage() {
  console.log(`Usage: node scripts/ensure-role.js <guildId> <roleId> [--dry-run] [--include-bots]

  guildId       Discord server (guild) snowflake
  roleId        Role snowflake to grant
  --dry-run     Report who is missing the role; do not change anything
  --include-bots  Also grant the role to bot accounts (default: humans only)`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!GUILD_ID || !ROLE_ID) {
    usage();
    process.exit(1);
  }

  if (!/^\d{17,20}$/.test(GUILD_ID) || !/^\d{17,20}$/.test(ROLE_ID)) {
    console.error("guildId and roleId must be Discord snowflake IDs (numeric).");
    process.exit(1);
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error("Missing DISCORD_TOKEN in .env");
    process.exit(1);
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);
    if (DRY_RUN) console.log("DRY RUN — no roles will be assigned\n");

    try {
      const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
      if (!guild) {
        console.error(
          `Bot is not in guild ${GUILD_ID}, or the ID is wrong. Only this guild is targeted.`
        );
        process.exitCode = 1;
        return;
      }

      // Confirm we only operate on the requested guild
      console.log(`Target guild: ${guild.name} (${guild.id})`);

      const me = await guild.members.fetchMe();
      if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        console.error("Bot lacks Manage Roles permission in this guild.");
        process.exitCode = 1;
        return;
      }

      const role = await guild.roles.fetch(ROLE_ID).catch(() => null);
      if (!role) {
        console.error(`Role ${ROLE_ID} not found in this guild.`);
        process.exitCode = 1;
        return;
      }

      if (role.managed) {
        console.error(
          `Role "${role.name}" is managed by an integration/bot and cannot be assigned manually.`
        );
        process.exitCode = 1;
        return;
      }

      if (role.position >= me.roles.highest.position) {
        console.error(
          `Role "${role.name}" is at or above the bot's highest role ("${me.roles.highest.name}"). ` +
            "Move the bot role higher in Server Settings → Roles."
        );
        process.exitCode = 1;
        return;
      }

      console.log(`Target role:  ${role.name} (${role.id})`);
      console.log("Fetching all members (this may take a moment on large servers)...");

      const members = await guild.members.fetch();
      console.log(`Fetched ${members.size} member(s)\n`);

      let alreadyHad = 0;
      let assigned = 0;
      let skippedBots = 0;
      let failed = 0;
      const failures = [];

      for (const member of members.values()) {
        if (member.user.bot && !INCLUDE_BOTS) {
          skippedBots++;
          continue;
        }

        if (member.roles.cache.has(role.id)) {
          alreadyHad++;
          continue;
        }

        if (DRY_RUN) {
          console.log(`[would add] ${member.user.tag} (${member.id})`);
          assigned++;
          continue;
        }

        try {
          await member.roles.add(role, "ensure-role one-off script");
          assigned++;
          console.log(`[added] ${member.user.tag} (${member.id})`);
          await sleep(DELAY_MS);
        } catch (err) {
          failed++;
          const msg = err?.message || String(err);
          failures.push({ tag: member.user.tag, id: member.id, msg });
          console.error(`[failed] ${member.user.tag} (${member.id}): ${msg}`);
        }
      }

      console.log("\n--- Summary ---");
      console.log(`Guild:            ${guild.name} (${guild.id})`);
      console.log(`Role:             ${role.name} (${role.id})`);
      console.log(`Members scanned:  ${members.size}`);
      console.log(`Already had role: ${alreadyHad}`);
      console.log(
        `${DRY_RUN ? "Would assign:    " : "Assigned:        "} ${assigned}`
      );
      if (!INCLUDE_BOTS) console.log(`Skipped bots:     ${skippedBots}`);
      console.log(`Failed:           ${failed}`);

      if (failures.length) {
        console.log("\nFailures:");
        for (const f of failures) {
          console.log(`  - ${f.tag} (${f.id}): ${f.msg}`);
        }
      }
    } catch (err) {
      console.error("Unexpected error:", err);
      process.exitCode = 1;
    } finally {
      client.destroy();
    }
  });

  client.on("error", (err) => {
    console.error("Client error:", err);
  });

  await client.login(token);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
