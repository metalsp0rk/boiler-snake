/**
 * /ticket slash command builder.
 */
const {
  SlashCommandBuilder,
  ChannelType,
} = require("discord.js");
const { MAX_TICKET_REASON, MAX_NOTE_CONTENT } = require("../../db");

const commands = [
  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription(
      "Open and manage support tickets; staff lifecycle and guild ticket config.",
    )
    // create is public; other ops gated in handlers
    .addSubcommand((sc) =>
      sc
        .setName("create")
        .setDescription("Open a support ticket for yourself.")
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("What do you need help with?")
            .setRequired(false)
            .setMaxLength(MAX_TICKET_REASON),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("for")
        .setDescription("Staff: open a ticket for a member.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member to open a ticket for")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("Why this ticket is being opened")
            .setRequired(false)
            .setMaxLength(MAX_TICKET_REASON),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("close")
        .setDescription(
          "Close this ticket: remove non-staff members; keep channel for staff.",
        )
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("Close reason (shown to requester + on archive)")
            .setRequired(false)
            .setMaxLength(MAX_TICKET_REASON),
        )
        .addStringOption((opt) =>
          opt
            .setName("staff_note")
            .setDescription(
              "Optional private staff note on the requester (never shown to them)",
            )
            .setRequired(false)
            .setMaxLength(MAX_NOTE_CONTENT),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("archive")
        .setDescription(
          "Archive a closed ticket: transcript (if not sensitive), then delete channel.",
        ),
    )
    .addSubcommand((sc) =>
      sc.setName("claim").setDescription("Claim this ticket as staff owner."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("transfer")
        .setDescription("Transfer staff ownership of this ticket.")
        .addUserOption((opt) =>
          opt
            .setName("staff")
            .setDescription("New staff owner")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("adduser")
        .setDescription("Add a member participant to this ticket.")
        .addUserOption((opt) =>
          opt.setName("user").setDescription("Member to add").setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("removeuser")
        .setDescription("Remove a member participant from this ticket.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member to remove")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("addstaff")
        .setDescription(
          "Allow-list a staff user on this ticket (named access).",
        )
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Staff user to add")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("removestaff")
        .setDescription("Remove a named staff allow-list entry.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Staff user to remove")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("sensitive")
        .setDescription(
          "Lock this ticket to owner + named staff + members only.",
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("unsensitive")
        .setDescription("Restore normal staff-role visibility on this ticket."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("list")
        .setDescription("List open tickets (staff).")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Filter by member")
            .setRequired(false),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("info")
        .setDescription("Show details for this ticket channel."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("summarize")
        .setDescription(
          "Generate an AI summary of this ticket's conversation (staff).",
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("setcategory")
        .setDescription("Set the category for new ticket channels (admin).")
        .addChannelOption((opt) =>
          opt
            .setName("category")
            .setDescription("Category channel")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("setarchive")
        .setDescription(
          "Set the staff channel for close summaries / transcripts (admin).",
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Text channel for archive posts")
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            )
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("setratelimit")
        .setDescription(
          "Min minutes between member self-creates (0 = off; default 60).",
        )
        .addIntegerOption((opt) =>
          opt
            .setName("minutes")
            .setDescription("Cooldown limit minutes (0 disables)")
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(10080),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("panel")
        .setDescription("Create, list, edit, or delete ticket panels (staff).")
        // panel create — post a new panel
        .addSubcommand((sc) =>
          sc
            .setName("create")
            .setDescription(
              "Post an Open Ticket panel (button → modal) in a channel.",
            )
            .addChannelOption((opt) =>
              opt
                .setName("channel")
                .setDescription("Channel to post the panel in (default: here)")
                .addChannelTypes(
                  ChannelType.GuildText,
                  ChannelType.GuildAnnouncement,
                )
                .setRequired(false),
            )
            .addStringOption((opt) =>
              opt
                .setName("title")
                .setDescription("Panel embed title")
                .setRequired(false)
                .setMaxLength(256),
            )
            .addStringOption((opt) =>
              opt
                .setName("description")
                .setDescription("Panel embed description")
                .setRequired(false)
                .setMaxLength(2000),
            ),
        )
        // panel list — show registered panels
        .addSubcommand((sc) =>
          sc
            .setName("list")
            .setDescription("List all ticket panels in this server."),
        )
        // panel edit — update title/description of a registered panel
        .addSubcommand((sc) =>
          sc
            .setName("edit")
            .setDescription("Update a panel's title and/or description.")
            .addStringOption((opt) =>
              opt
                .setName("message_id")
                .setDescription("Message ID of the panel")
                .setRequired(true),
            )
            .addStringOption((opt) =>
              opt
                .setName("title")
                .setDescription("New embed title")
                .setRequired(false)
                .setMaxLength(256),
            )
            .addStringOption((opt) =>
              opt
                .setName("description")
                .setDescription("New embed description")
                .setRequired(false)
                .setMaxLength(2000),
            ),
        )
        // panel delete — remove a registered panel
        .addSubcommand((sc) =>
          sc
            .setName("delete")
            .setDescription("Remove a ticket panel and its Discord message.")
            .addStringOption((opt) =>
              opt
                .setName("message_id")
                .setDescription("Message ID of the panel to remove")
                .setRequired(true),
            ),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("settings")
        .setDescription("Show ticket configuration for this server."),
    ),
];

module.exports = { commands };
