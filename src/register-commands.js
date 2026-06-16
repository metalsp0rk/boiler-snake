require("dotenv").config();
const {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require("discord.js");

const adminPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName("xp")
    .setDescription("Show your XP and level (or another user's).")
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("User to check")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show top XP users.")
    .addIntegerOption((opt) =>
      opt
        .setName("limit")
        .setDescription("How many to show (max 20)")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("setxp")
    .setDescription("Set XP values and cooldowns for this guild.")
    .setDefaultMemberPermissions(adminPerms)
    .addIntegerOption((opt) =>
      opt
        .setName("message")
        .setDescription("XP per message")
        .setMinValue(0)
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("reaction")
        .setDescription("XP per reaction")
        .setMinValue(0)
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("voice")
        .setDescription("XP per voice minute")
        .setMinValue(0)
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("msgcooldown")
        .setDescription("Message XP cooldown seconds")
        .setMinValue(0)
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("reactioncooldown")
        .setDescription("Reaction XP cooldown seconds")
        .setMinValue(0)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("setdecay")
    .setDescription("Configure decay for this guild.")
    .setDefaultMemberPermissions(adminPerms)
    .addBooleanOption((opt) =>
      opt
        .setName("enabled")
        .setDescription("Enable/disable decay")
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("messages")
        .setDescription("Min messages required")
        .setMinValue(0)
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("days")
        .setDescription("Window in days")
        .setMinValue(1)
        .setRequired(false)
    )
    .addNumberOption((opt) =>
      opt
        .setName("percent")
        .setDescription("Decay percent (e.g. 10 = 10%)")
        .setMinValue(0)
        .setMaxValue(95)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("leveltorole")
    .setDescription("Map a role to a level requirement (and drop grace days).")
    .setDefaultMemberPermissions(adminPerms)
    .addSubcommand((sc) =>
      sc
        .setName("set")
        .setDescription("Set/update a level->role mapping.")
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("Role to manage").setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("level")
            .setDescription("Level required")
            .setMinValue(0)
            .setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("dropdays")
            .setDescription("Days below level before removing")
            .setMinValue(0)
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("remove")
        .setDescription("Remove a mapping for a role.")
        .addRoleOption((opt) =>
          opt
            .setName("role")
            .setDescription("Role to unmanage")
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("List current level->role mappings.")
    ),

  new SlashCommandBuilder()
    .setName("setcommandchannel")
    .setDescription("Restrict bot commands to specific channels for this guild.")
    .setDefaultMemberPermissions(adminPerms)
    .addSubcommand((sc) =>
      sc
        .setName("add")
        .setDescription("Allow commands in a channel.")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel to allow")
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("remove")
        .setDescription("Remove a channel from allowed list.")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel to remove")
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("List allowed command channels.")
    ),

new SlashCommandBuilder()
    .setName("settings")
    .setDescription("Show current guild settings.")
    .setDefaultMemberPermissions(adminPerms),

  new SlashCommandBuilder()
    .setName("youtube")
    .setDescription("Manage YouTube channel subscriptions (admin only).")
    .setDefaultMemberPermissions(adminPerms)
    .addSubcommand((sc) =>
      sc
        .setName("add")
        .setDescription("Subscribe to a YouTube channel.")
        .addStringOption((opt) =>
          opt
            .setName("url")
            .setDescription("YouTube channel URL or @username")
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("remove")
        .setDescription("Unsubscribe from a YouTube channel.")
        .addStringOption((opt) =>
          opt
            .setName("channel")
            .setDescription("YouTube channel to unsubscribe from")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("List all subscribed channels.")
    ),

  new SlashCommandBuilder()
    .setName("setyoutube")
    .setDescription("Configure YouTube notification settings (admin only).")
    .setDefaultMemberPermissions(adminPerms)
    .addSubcommand((sc) =>
      sc
        .setName("channel")
        .setDescription("Set channel for YouTube notifications.")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel to send notifications to")
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("interval")
        .setDescription("Set RSS polling interval.")
        .addIntegerOption((opt) =>
          opt
            .setName("minutes")
            .setDescription("Polling interval in minutes (1-60)")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(60)
        )
    ),
  ].map((c) => c.toJSON());

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const devGuildId = process.env.DEV_GUILD_ID;

  if (!token || !clientId) {
    console.error("Missing DISCORD_TOKEN or CLIENT_ID in .env");
    process.exit(1);
  }

  const rest = new REST({ version: "10" }).setToken(token);

  if (devGuildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, devGuildId), {
      body: commands,
    });
    console.log(`Registered commands to DEV guild ${devGuildId}.`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(
      "Registered global commands. (May take time to propagate to all guilds.)"
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
