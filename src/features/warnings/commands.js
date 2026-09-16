/**
 * /warn and /setwarn slash command builders.
 */
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");
const {
  MAX_WARN_REASON,
  MAX_EVIDENCE_TEXT,
  MAX_EXPIRY_DAYS,
} = require("../../db");

const staffPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription(
      "Issue and manage formal member warnings (staff); view your own with mine.",
    )
    // No defaultMemberPermissions — /warn mine must be visible to all members.
    // Staff subcommands are gated in the handler via requireStaff.
    .addSubcommand((sc) =>
      sc
        .setName("add")
        .setDescription("Issue a formal warning to a member.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member to warn")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("Why this warning is being issued")
            .setRequired(true)
            .setMaxLength(MAX_WARN_REASON),
        )
        .addBooleanOption((opt) =>
          opt
            .setName("silent")
            .setDescription("Skip DM to the member for this warning only")
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("note")
            .setDescription(
              "Optional staff note number to link (e.g. 12 from N-12)",
            )
            .setRequired(false)
            .setMinValue(1),
        )
        .addStringOption((opt) =>
          opt
            .setName("message")
            .setDescription("Optional Discord message link as evidence")
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName("evidence")
            .setDescription("Optional staff-only evidence notes")
            .setRequired(false)
            .setMaxLength(MAX_EVIDENCE_TEXT),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("expires_days")
            .setDescription(
              "Days until auto-void (0=never). Omit to use guild default.",
            )
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(MAX_EXPIRY_DAYS),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("list")
        .setDescription("List warnings for a member.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member to list warnings for")
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("page")
            .setDescription("Page number (default 1)")
            .setRequired(false)
            .setMinValue(1),
        )
        .addBooleanOption((opt) =>
          opt
            .setName("include_voided")
            .setDescription("Include voided warnings (default false)")
            .setRequired(false),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("info")
        .setDescription("Show full detail for a single warning.")
        .addIntegerOption((opt) =>
          opt
            .setName("id")
            .setDescription("Warning number (e.g. 12 from W-12)")
            .setRequired(true)
            .setMinValue(1),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("void")
        .setDescription("Void a warning (row kept forever with paper trail).")
        .addIntegerOption((opt) =>
          opt
            .setName("id")
            .setDescription("Warning number (e.g. 12 from W-12)")
            .setRequired(true)
            .setMinValue(1),
        )
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("Why this warning is being voided")
            .setRequired(true)
            .setMaxLength(MAX_WARN_REASON),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("count")
        .setDescription("Active warning count for a member.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member to count")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("mine")
        .setDescription("View your own warnings in this server.")
        .addBooleanOption((opt) =>
          opt
            .setName("include_voided")
            .setDescription("Include voided warnings (default false)")
            .setRequired(false),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("export")
        .setDescription(
          "Export notes + warnings for a member as a staff handoff file.",
        )
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member to export")
            .setRequired(true),
        )
        .addBooleanOption((opt) =>
          opt
            .setName("include_voided")
            .setDescription("Include voided warnings (default true)")
            .setRequired(false),
        )
        .addBooleanOption((opt) =>
          opt
            .setName("include_deleted_notes")
            .setDescription("Include soft-deleted staff notes (default true)")
            .setRequired(false),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("settings")
        .setDescription("Show warning system settings and access info."),
    ),

  new SlashCommandBuilder()
    .setName("setwarn")
    .setDescription("Configure warning system guild settings.")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommand((sc) =>
      sc
        .setName("dm")
        .setDescription("Toggle DMs to members on warn issue/void.")
        .addBooleanOption((opt) =>
          opt
            .setName("enabled")
            .setDescription("Send DMs when warnings are issued or voided")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) => {
      const sub = sc
        .setName("log")
        .setDescription(
          "Set a dedicated staff channel for warning issue/void logs.",
        );
      sub.addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Channel for warning issue/void embeds")
          .setRequired(false)
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
          ),
      );
      sub.addBooleanOption((opt) =>
        opt
          .setName("clear")
          .setDescription(
            "Clear dedicated warn log (fall back to audit log only)",
          )
          .setRequired(false),
      );
      return sub;
    })
    .addSubcommand((sc) =>
      sc
        .setName("expiry")
        .setDescription(
          "Default auto-void after N days for new warnings (0 = never).",
        )
        .addIntegerOption((opt) =>
          opt
            .setName("days")
            .setDescription("Days until new warnings expire (0 = never)")
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(MAX_EXPIRY_DAYS),
        ),
    ),
];

module.exports = { commands };
