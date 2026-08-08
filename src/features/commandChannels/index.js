const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require("discord.js");
const {
  addAllowedCommandChannel,
  removeAllowedCommandChannel,
  listAllowedCommandChannels,
} = require("../../db");
const { isAdminOrMod } = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");

const adminPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName("setcommandchannel")
    .setDescription("Restrict bot commands to specific channels for this guild.")
    .setDefaultMemberPermissions(adminPerms)
    .addSubcommand((sc) =>
      sc
        .setName("add")
        .setDescription("Allow commands in a channel.")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("Channel to allow").setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("remove")
        .setDescription("Remove a channel from allowed list.")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("Channel to remove").setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("List allowed command channels.")
    ),
];

async function handleSetCommandChannel(interaction, ctx) {
  const { client } = ctx;

  // ManageGuild only — prevents staff from locking out admins / each other.
  if (!isAdminOrMod(interaction)) {
    await interaction.reply({
      content: "Only server administrators can configure command channels.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();

  if (sub === "add") {
    const ch = interaction.options.getChannel("channel", true);
    addAllowedCommandChannel(guildId, ch.id);
    await logConfigChange(client, guildId, {
      title: "Command channel allowed",
      command: "/setcommandchannel add",
      actor: interaction.user,
      changes: [`Channel: <#${ch.id}> (\`${ch.id}\`)`],
    }).catch(() => {});
    await interaction.reply({
      content: `Commands are now allowed in <#${ch.id}>.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "remove") {
    const ch = interaction.options.getChannel("channel", true);
    removeAllowedCommandChannel(guildId, ch.id);
    await logConfigChange(client, guildId, {
      title: "Command channel restriction removed",
      command: "/setcommandchannel remove",
      actor: interaction.user,
      changes: [`Channel: <#${ch.id}> (\`${ch.id}\`)`],
    }).catch(() => {});
    await interaction.reply({
      content: `Removed <#${ch.id}> from allowed command channels.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "list") {
    const rows = listAllowedCommandChannels(guildId);
    if (!rows.length) {
      await interaction.reply({
        content: "No allowed channels configured — commands are allowed in all channels.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const lines = rows.map((r) => `- <#${r.channel_id}>`);
    await interaction.reply({
      content: `**Allowed command channels:**\n${lines.join("\n")}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

module.exports = {
  name: "commandChannels",
  commands,
  handlers: {
    setcommandchannel: handleSetCommandChannel,
  },
};
