const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const {
  addAllowedCommandChannel,
  removeAllowedCommandChannel,
  listAllowedCommandChannels,
} = require("../../db");
const { isAdminOrModFromContext } = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");

const adminPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName("setcommandchannel")
    .setDescription(
      "Restrict bot commands to specific channels for this guild.",
    )
    .setDefaultMemberPermissions(adminPerms)
    .addSubcommand((sc) =>
      sc
        .setName("add")
        .setDescription("Allow commands in a channel.")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel to allow")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("remove")
        .setDescription("Remove a channel from allowed list.")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel to remove")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("List allowed command channels."),
    ),
];

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} featureCtx
 */
async function handleSetCommandChannel(commandCtx, featureCtx) {
  void featureCtx;
  // ManageGuild only — prevents staff from locking out admins / each other.
  // Custom denial copy preserved verbatim from the pre-CommandContext handler
  // (requireAdminFromContext would change the user-visible text).
  if (!isAdminOrModFromContext(commandCtx)) {
    await commandCtx.reply({
      content: "Only server administrators can configure command channels.",
      sensitive: true,
    });
    return;
  }

  // CommandContext carries the resolved internal id (roadmap/fluxer.md
  // § Repository boundary); externalGuildId is the snowflake for display
  // and audit text only — never a repository key.
  const communityId = commandCtx.communityId;
  const guildId = commandCtx.externalGuildId;
  const sub = commandCtx.subcommand;

  if (sub === "add") {
    const ch = commandCtx.options.getChannel("channel", true);
    // Validate the invoker-supplied id against the guild (PR 4 bundle
    // recipe 8): a null channel handle means the bot cannot see / resolve
    // the channel, and storing it would silently lock commands out.
    const channelHandle = await commandCtx.outbound.fetchChannel(
      communityId,
      ch.id,
    );
    if (!channelHandle) {
      await commandCtx.reply({
        content:
          `I couldn't find <#${ch.id}> (\`${ch.id}\`) in this server — ` +
          "pick a channel from the picker and make sure the bot can view it.",
        sensitive: true,
      });
      return;
    }
    addAllowedCommandChannel(communityId, ch.id);
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "command_channels.add",
      targetType: "channel",
      targetId: ch.id,
    });
    await logConfigChange(commandCtx.outbound, guildId, {
      title: "Command channel allowed",
      command: "/setcommandchannel add",
      actor: commandCtx.user,
      changes: [`Channel: <#${ch.id}> (\`${ch.id}\`)`],
    }).catch(() => {});
    await commandCtx.reply({
      content: `Commands are now allowed in <#${ch.id}>.`,
      sensitive: true,
    });
    return;
  }

  if (sub === "remove") {
    const ch = commandCtx.options.getChannel("channel", true);
    // No fetchChannel validation here on purpose: remove is the cleanup
    // path — stale ids must stay removable even when the bot can no longer
    // see the channel.
    removeAllowedCommandChannel(communityId, ch.id);
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "command_channels.remove",
      targetType: "channel",
      targetId: ch.id,
    });
    await logConfigChange(commandCtx.outbound, guildId, {
      title: "Command channel restriction removed",
      command: "/setcommandchannel remove",
      actor: commandCtx.user,
      changes: [`Channel: <#${ch.id}> (\`${ch.id}\`)`],
    }).catch(() => {});
    await commandCtx.reply({
      content: `Removed <#${ch.id}> from allowed command channels.`,
      sensitive: true,
    });
    return;
  }

  if (sub === "list") {
    const rows = listAllowedCommandChannels(communityId);
    if (!rows.length) {
      await commandCtx.reply({
        content:
          "No allowed channels configured — commands are allowed in all channels.",
        sensitive: true,
      });
      return;
    }
    const lines = rows.map((r) => `• <#${r.channel_id}>`);
    await commandCtx.reply({
      content: `**Allowed command channels**\n${lines.join("\n")}`,
      sensitive: true,
    });
  }
}

module.exports = {
  name: "commandChannels",
  commands,
  handlers: {
    setcommandchannel: handleSetCommandChannel,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): the slash
  // handler receives a CommandContext instead of a raw interaction.
  handlerApi: {
    setcommandchannel: "context",
  },
};
