/**
 * /gork slash command builder.
 */
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");
const {
  KEYWORD_MAX,
  CONTEXT_MIN,
  CONTEXT_MAX,
  COOLDOWN_MIN,
  COOLDOWN_MAX,
  RULES_MAX,
  BUDGET_MIN,
  BUDGET_MAX,
} = require("./constants");

const staffPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName("gork")
    .setDescription("Configure and moderate Gork, the AI keyword Q&A (staff).")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommand((sc) =>
      sc
        .setName("keyword")
        .setDescription(
          "Set the trigger keyword (1-50 chars). Use `clear` to disable gork.",
        )
        .addStringOption((opt) =>
          opt
            .setName("keyword")
            .setDescription(
              "Trigger keyword (1-50 chars), or `clear` to disable gork",
            )
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(KEYWORD_MAX),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("context")
        .setDescription("Set the context window size (1-50 prior messages).")
        .addIntegerOption((opt) =>
          opt
            .setName("context")
            .setDescription("How many prior messages feed the prompt (1-50)")
            .setRequired(true)
            .setMinValue(CONTEXT_MIN)
            .setMaxValue(CONTEXT_MAX),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("cooldown")
        .setDescription(
          "Set the per-user cooldown in seconds (0-3600; 0 = disabled). Staff always bypass.",
        )
        .addIntegerOption((opt) =>
          opt
            .setName("cooldown")
            .setDescription(
              "Seconds between triggers per user (0-3600; 0 = disabled; staff always bypass)",
            )
            .setRequired(true)
            .setMinValue(COOLDOWN_MIN)
            .setMaxValue(COOLDOWN_MAX),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("rules")
        .setDescription(
          "Set additional staff prompt rules (max 500 chars). Use `clear` to remove them.",
        )
        .addStringOption((opt) =>
          opt
            .setName("rules")
            .setDescription(
              "Extra prompt rules appended for this guild (max 500 chars), or `clear` to remove",
            )
            .setRequired(true)
            .setMaxLength(RULES_MAX),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("search")
        .setDescription("Toggle the SearXNG web_search tool for this guild.")
        .addStringOption((opt) =>
          opt
            .setName("search")
            .setDescription("Enable (on) or disable (off) web search")
            .setRequired(true)
            .addChoices(
              { name: "on", value: "on" },
              { name: "off", value: "off" },
            ),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("enable")
        .setDescription(
          "Enable or disable gork entirely for this server (settings are kept).",
        )
        .addStringOption((opt) =>
          opt
            .setName("enable")
            .setDescription("Turn gork on or off for this server")
            .setRequired(true)
            .addChoices(
              { name: "on", value: "on" },
              { name: "off", value: "off" },
            ),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("ban")
        .setDescription(
          "Ban a user from using gork in this server (they get the generic failure reply).",
        )
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("User to ban from gork")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("unban")
        .setDescription("Lift a user's gork ban in this server.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("User to unban from gork")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("bans")
        .setDescription("List the users banned from gork in this server."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("memory")
        .setDescription(
          "Curate gork's per-person community memory (roadmap §7.16).",
        )
        // Discord caps option depth at 2 → action choices carry the verbs.
        .addStringOption((opt) =>
          opt
            .setName("action")
            .setDescription("Which memory action to run")
            .setRequired(true)
            .addChoices(
              { name: "show", value: "show" },
              { name: "forget", value: "forget" },
              { name: "clear", value: "clear" },
              { name: "on", value: "on" },
              { name: "off", value: "off" },
              { name: "budget", value: "budget" },
            ),
        )
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Target user for show/clear (omit = whole guild)"),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("id")
            .setDescription("Memory #id handle to forget (from show)"),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("chars")
            .setDescription("Memory-block budget in chars (0–64000; 0 = unlimited)"),
        )
        .addBooleanOption((opt) =>
          opt
            .setName("confirm")
            .setDescription("Set true to actually erase (clear)"),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("budget")
        .setDescription(
          "Per-user daily gork budgets per channel/category (roadmap §7.17).",
        )
        // Discord caps option depth at 2 → action choices carry the verbs.
        .addStringOption((opt) =>
          opt
            .setName("action")
            .setDescription("Which budget action to run")
            .setRequired(true)
            .addChoices(
              { name: "default", value: "default" },
              { name: "channel", value: "channel" },
              { name: "category", value: "category" },
              { name: "remove_channel", value: "remove_channel" },
              { name: "remove_category", value: "remove_category" },
              { name: "list", value: "list" },
            ),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("limit")
            .setDescription(
              "Successful answers per user per UTC day: -1 blocked, 0 unlimited, 1-1000",
            )
            .setMinValue(BUDGET_MIN)
            .setMaxValue(BUDGET_MAX),
        )
        .addChannelOption((opt) =>
          opt
            .setName("target")
            .setDescription("Channel or category for channel/category actions")
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
              ChannelType.GuildCategory,
              ChannelType.PublicThread,
              ChannelType.PrivateThread,
            ),
        )
        .addStringOption((opt) =>
          opt
            .setName("id")
            .setDescription("Raw scope id for remove_* (when the picker lacks the channel)")
            .setMaxLength(25),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("log")
        .setDescription("Toggle the interaction log (every agent call stored for replay/debug).")
        .addBooleanOption((opt) =>
          opt
            .setName("enabled")
            .setDescription("Record every gork agent call in this server (on/off)")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("status")
        .setDescription("Show the current gork configuration for this guild."),
    ),
];

module.exports = { commands };
