/**
 * /bridge slash command builder (roadmap/bridge.md § API / Interface Changes).
 *
 * Staff-tier: `setDefaultMemberPermissions(ManageGuild)` puts the picker behind
 * Manage Server, and `bridge: TIERS.staff` in src/core/commandVisibility.js
 * adds staff_roles allow-overwrites after OAuth sync. The handler is the
 * security source of truth (the service re-checks staff on every call).
 *
 * The `direction` choices are create-side, platform-relative tokens (KD 19).
 * The Fluxer prefix parser types its options against this same JSON, so
 * `!bridge create #general direction to-discord` parses with no overlay.
 */
const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

const staffPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName("bridge")
    .setDescription("Pair a channel here with one channel on Fluxer.")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommand((sc) =>
      sc
        .setName("create")
        .setDescription("Create a pending bridge for a channel (default: this one).")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel to bridge (default: this channel)")
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName("direction")
            .setDescription("Which way messages flow (default: both).")
            .setRequired(false)
            .addChoices(
              { name: "both", value: "both" },
              { name: "to-fluxer", value: "to-fluxer" },
              { name: "from-fluxer", value: "from-fluxer" },
            ),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("connect")
        .setDescription("Consume a BRG- connect credential for a channel.")
        .addStringOption((opt) =>
          opt
            .setName("code")
            .setDescription("The BRG- connect credential from bridge create")
            .setRequired(true)
            .setMaxLength(100),
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel to pair (default: this channel)")
            .setRequired(false),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("disconnect")
        .setDescription("Destroy a bridge by handle or by a local channel.")
        .addStringOption((opt) =>
          opt
            .setName("bridge")
            .setDescription("Bridge handle (b_…). Wins over channel.")
            .setRequired(false)
            .setMaxLength(64),
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("A channel in the bridge (default: this channel)")
            .setRequired(false),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("status")
        .setDescription("Bridge status: state, direction, queue depth (staff).")
        .addStringOption((opt) =>
          opt
            .setName("bridge")
            .setDescription("Bridge handle (b_…). Wins over channel.")
            .setRequired(false)
            .setMaxLength(64),
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("A channel in the bridge")
            .setRequired(false),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("list")
        .setDescription("List every bridge touching this community."),
    ),
];

module.exports = { commands };
