const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require("discord.js");
const {
  getGuildSettings,
  createReactionRolePanel,
  getReactionRolePanel,
  listReactionRolePanels,
  updateReactionRolePanelText,
  deleteReactionRolePanel,
  listReactionRoleOptions,
  countReactionRoleOptions,
} = require("../../db");
const { isStaff } = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");
const {
  MAX_OPTIONS_PER_PANEL,
  PENDING_EMOJI_TTL_MS,
  NO_PING_MENTIONS,
  buildPanelEmbed,
  refreshPanelMessage,
  deployPanelToChannel,
  handleReactionRoleAdd,
  handleReactionRoleRemove,
  setPendingOptionAdd,
  setPendingOptionRemove,
  clearPendingOptionEmoji,
  handlePendingOptionEmojiMessage,
  syncMemberReactionRoles,
} = require("./service");

const adminPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
      .setName("reactionrole")
      .setDescription("Manage reaction-role panels (admin only).")
      .setDefaultMemberPermissions(adminPerms)
      .addSubcommandGroup((group) =>
        group
          .setName("panel")
          .setDescription("Create, edit, list, deploy, or delete reaction-role panels.")
          .addSubcommand((sc) =>
            sc
              .setName("create")
              .setDescription("Post a new reaction-role panel in a channel.")
              .addChannelOption((opt) =>
                opt
                  .setName("channel")
                  .setDescription("Channel to post the panel in")
                  .setRequired(true)
              )
              .addStringOption((opt) =>
                opt
                  .setName("title")
                  .setDescription("Embed title")
                  .setRequired(false)
                  .setMaxLength(256)
              )
              .addStringOption((opt) =>
                opt
                  .setName("description")
                  .setDescription("Embed description (intro text above the role list)")
                  .setRequired(false)
                  .setMaxLength(1000)
              )
          )
          .addSubcommand((sc) =>
            sc
              .setName("edit")
              .setDescription("Update a panel's title and/or description.")
              .addStringOption((opt) =>
                opt
                  .setName("message_id")
                  .setDescription("Message ID of the panel")
                  .setRequired(true)
              )
              .addStringOption((opt) =>
                opt
                  .setName("title")
                  .setDescription("New embed title")
                  .setRequired(false)
                  .setMaxLength(256)
              )
              .addStringOption((opt) =>
                opt
                  .setName("description")
                  .setDescription("New embed description")
                  .setRequired(false)
                  .setMaxLength(1000)
              )
          )
          .addSubcommand((sc) =>
            sc
              .setName("deploy")
              .setDescription("Copy a panel (config + options) into another channel.")
              .addStringOption((opt) =>
                opt
                  .setName("message_id")
                  .setDescription("Message ID of the source panel to copy")
                  .setRequired(true)
              )
              .addChannelOption((opt) =>
                opt
                  .setName("channel")
                  .setDescription("Destination channel for the new panel")
                  .setRequired(true)
              )
          )
          .addSubcommand((sc) =>
            sc
              .setName("delete")
              .setDescription("Delete a panel (DB + Discord message).")
              .addStringOption((opt) =>
                opt
                  .setName("message_id")
                  .setDescription("Message ID of the panel")
                  .setRequired(true)
              )
          )
          .addSubcommand((sc) =>
            sc.setName("list").setDescription("List reaction-role panels in this server.")
          )
      )
      .addSubcommandGroup((group) =>
        group
          .setName("option")
          .setDescription("Map emojis to roles on a panel.")
          .addSubcommand((sc) =>
            sc
              .setName("add")
              .setDescription("Start adding an option; then send the emoji as your next message.")
              .addStringOption((opt) =>
                opt
                  .setName("message_id")
                  .setDescription("Message ID of the panel")
                  .setRequired(true)
              )
              .addRoleOption((opt) =>
                opt
                  .setName("role")
                  .setDescription("Role to grant")
                  .setRequired(true)
              )
              .addIntegerOption((opt) =>
                opt
                  .setName("level")
                  .setDescription("Minimum level required (default 0)")
                  .setMinValue(0)
                  .setRequired(false)
              )
              .addBooleanOption((opt) =>
                opt
                  .setName("removable")
                  .setDescription("Remove role when reaction is removed (default true)")
                  .setRequired(false)
              )
          )
          .addSubcommand((sc) =>
            sc
              .setName("remove")
              .setDescription("Start removing an option; then send the emoji as your next message.")
              .addStringOption((opt) =>
                opt
                  .setName("message_id")
                  .setDescription("Message ID of the panel")
                  .setRequired(true)
              )
          )
          .addSubcommand((sc) =>
            sc
              .setName("list")
              .setDescription("List emoji→role options on a panel.")
              .addStringOption((opt) =>
                opt
                  .setName("message_id")
                  .setDescription("Message ID of the panel")
                  .setRequired(true)
              )
          )
      )
      .addSubcommand((sc) =>
        sc
          .setName("sync")
          .setDescription("Re-apply embed text and bot reactions for a panel.")
          .addStringOption((opt) =>
            opt
              .setName("message_id")
              .setDescription("Message ID of the panel")
              .setRequired(true)
          )
      ),
];

async function handleReactionrole(interaction, ctx) {
  const { client } = ctx;
  const guildId = interaction.guildId;
  const settings = getGuildSettings(guildId);
  const admin = isStaff(interaction);

  if (!admin) {
    await interaction.reply({
      content: "You don't have permission to use this.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  // /reactionrole panel [create|edit|deploy|delete|list]
  if (group === "panel") {
    if (sub === "create") {
      const ch = interaction.options.getChannel("channel", true);
      const title = interaction.options.getString("title") || "Reaction Roles";
      const description =
        interaction.options.getString("description") ||
        "React to get a role. Remove your reaction to drop it (if allowed).";

      if (typeof ch.isTextBased !== "function" || !ch.isTextBased()) {
        await interaction.reply({
          content: "That channel cannot receive messages.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (typeof ch.send !== "function") {
        await interaction.reply({
          content: "That channel cannot receive messages.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const panelStub = {
        title,
        description,
        guild_id: guildId,
        channel_id: ch.id,
        message_id: "pending",
      };
      const embed = buildPanelEmbed(panelStub, []);

      let msg;
      try {
        // Role names may appear later in the embed as mentions — never ping
        msg = await ch.send({ embeds: [embed], allowedMentions: NO_PING_MENTIONS });
      } catch (e) {
        await interaction.reply({
          content: `Could not post panel: ${e?.message || e}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      createReactionRolePanel(guildId, ch.id, msg.id, title, description);
      await logConfigChange(client, guildId, {
        title: "Reaction-role panel created",
        command: "/reactionrole panel create",
        actor: interaction.user,
        changes: [
          `Channel: <#${ch.id}>`,
          `Message ID: \`${msg.id}\``,
          `Title: ${title}`,
        ],
        details: msg.url,
      }).catch(() => {});
      await interaction.reply({
        content:
          `Created reaction-role panel in <#${ch.id}>.\n` +
          `Message ID: \`${msg.id}\`\n` +
          `Jump: ${msg.url}\n` +
          `Add options with \`/reactionrole option add message_id:${msg.id}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "edit") {
      const messageId = interaction.options.getString("message_id", true).trim();
      const title = interaction.options.getString("title");
      const description = interaction.options.getString("description");

      if (title == null && description == null) {
        await interaction.reply({
          content: "Provide at least one of `title` or `description` to update.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const panel = getReactionRolePanel(guildId, messageId);
      if (!panel) {
        await interaction.reply({
          content: `No reaction-role panel with message ID \`${messageId}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      updateReactionRolePanelText(guildId, messageId, title, description);
      const updated = getReactionRolePanel(guildId, messageId);
      const result = await refreshPanelMessage(interaction.guild, updated);
      const changeLines = [];
      if (title != null) changeLines.push(`Title: ${panel.title} → **${updated.title}**`);
      if (description != null) {
        changeLines.push(
          `Description updated (${String(panel.description || "").length} → ${String(updated.description || "").length} chars)`
        );
      }
      await logConfigChange(client, guildId, {
        title: "Reaction-role panel edited",
        command: "/reactionrole panel edit",
        actor: interaction.user,
        changes: [`Panel: \`${messageId}\``, ...changeLines],
      }).catch(() => {});
      await interaction.reply({
        content: result.ok
          ? `Updated panel \`${messageId}\`.`
          : `Saved text, but refresh failed: ${result.error}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "deploy") {
      const messageId = interaction.options.getString("message_id", true).trim();
      const ch = interaction.options.getChannel("channel", true);

      if (typeof ch.isTextBased === "function" && !ch.isTextBased()) {
        await interaction.reply({
          content: "That channel cannot receive messages.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (typeof ch.send !== "function") {
        await interaction.reply({
          content: "That channel cannot receive messages.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // May post + react several times
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const result = await deployPanelToChannel(interaction.guild, messageId, ch);
      if (!result.ok) {
        await interaction.editReply({ content: result.error });
        return;
      }

      const n = result.optionCount ?? 0;
      let content =
        `Deployed panel from \`${messageId}\` → <#${ch.id}>.\n` +
        `New message ID: \`${result.message.id}\`\n` +
        `Jump: ${result.message.url}\n` +
        `Copied **${n}** option${n === 1 ? "" : "s"} (source panel left in place).`;
      if (result.error) {
        content += `\n⚠️ ${result.error}`;
      }
      await logConfigChange(client, guildId, {
        title: "Reaction-role panel deployed",
        command: "/reactionrole panel deploy",
        actor: interaction.user,
        changes: [
          `Source panel: \`${messageId}\``,
          `New channel: <#${ch.id}>`,
          `New message ID: \`${result.message.id}\``,
          `Options copied: **${n}**`,
        ],
        details: result.message.url,
      }).catch(() => {});
      await interaction.editReply({ content });
      return;
    }

    if (sub === "delete") {
      const messageId = interaction.options.getString("message_id", true).trim();
      const { removed, channel_id } = deleteReactionRolePanel(guildId, messageId);

      let note = "";
      if (removed && channel_id) {
        try {
          const channel = await interaction.guild.channels.fetch(channel_id).catch(() => null);
          if (channel?.messages) {
            const msg = await channel.messages.fetch(messageId).catch(() => null);
            if (msg) {
              await msg.delete().catch(() => null);
              note = " Discord message deleted.";
            } else {
              note = " (Message was already gone.)";
            }
          }
        } catch {
          note = " (Could not delete Discord message — remove it manually if needed.)";
        }
      }

      if (removed) {
        await logConfigChange(client, guildId, {
          title: "Reaction-role panel deleted",
          command: "/reactionrole panel delete",
          actor: interaction.user,
          changes: [
            `Message ID: \`${messageId}\``,
            channel_id ? `Channel: <#${channel_id}>` : null,
          ].filter(Boolean),
          details: note.trim() || undefined,
        }).catch(() => {});
      }

      await interaction.reply({
        content: removed
          ? `Deleted reaction-role panel \`${messageId}\`.${note}`
          : `No reaction-role panel with message ID \`${messageId}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "list") {
      const panels = listReactionRolePanels(guildId);
      if (!panels.length) {
        await interaction.reply({
          content: "No reaction-role panels configured. Use `/reactionrole panel create`.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const lines = panels.map((p) => {
        const jump = `https://discord.com/channels/${guildId}/${p.channel_id}/${p.message_id}`;
        const n = countReactionRoleOptions(guildId, p.message_id);
        return `- **${p.title}** in <#${p.channel_id}> — \`${p.message_id}\` (${n} option${n === 1 ? "" : "s"}) — [jump](${jump})`;
      });
      await interaction.reply({
        content: `**Reaction-role panels:**\n${lines.join("\n")}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  // /reactionrole option [add|remove|list]
  if (group === "option") {
    if (sub === "add") {
      const messageId = interaction.options.getString("message_id", true).trim();
      const role = interaction.options.getRole("role", true);
      const level = interaction.options.getInteger("level") ?? 0;
      const removable = interaction.options.getBoolean("removable");
      const removableFlag = removable === null ? true : removable;

      const panel = getReactionRolePanel(guildId, messageId);
      if (!panel) {
        await interaction.reply({
          content: `No reaction-role panel with message ID \`${messageId}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (role.managed) {
        await interaction.reply({
          content: "That role is managed by an integration and cannot be assigned by the bot.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const optCount = countReactionRoleOptions(guildId, messageId);
      if (optCount >= MAX_OPTIONS_PER_PANEL) {
        await interaction.reply({
          content: `This panel already has ${MAX_OPTIONS_PER_PANEL} options (Discord reaction limit). Remove one first.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Replace any prior wait session for this admin
      clearPendingOptionEmoji(guildId, interaction.user.id);
      setPendingOptionAdd(guildId, interaction.user.id, {
        messageId,
        roleId: role.id,
        level,
        removable: removableFlag,
        channelId: interaction.channelId,
      });

      const mins = Math.round(PENDING_EMOJI_TTL_MS / 60000);
      await interaction.reply({
        content:
          `**Send the emoji** as your next message in this server (message should be only the emoji).\n` +
          `I'll map it to ${role} on panel \`${messageId}\` (Level ${level}+, ${
            removableFlag ? "removable" : "permanent"
          }).\n` +
          `Type **\`stop\`** to cancel. Expires in ${mins} minutes.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_PING_MENTIONS,
      });
      return;
    }

    if (sub === "remove") {
      const messageId = interaction.options.getString("message_id", true).trim();

      const panel = getReactionRolePanel(guildId, messageId);
      if (!panel) {
        await interaction.reply({
          content: `No reaction-role panel with message ID \`${messageId}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const optCount = countReactionRoleOptions(guildId, messageId);
      if (optCount === 0) {
        await interaction.reply({
          content: `Panel \`${messageId}\` has no options to remove.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      clearPendingOptionEmoji(guildId, interaction.user.id);
      setPendingOptionRemove(guildId, interaction.user.id, {
        messageId,
        channelId: interaction.channelId,
      });

      const mins = Math.round(PENDING_EMOJI_TTL_MS / 60000);
      await interaction.reply({
        content:
          `**Send the emoji** to remove as your next message (message should be only the emoji).\n` +
          `I'll remove that option from panel \`${messageId}\`.\n` +
          `Type **\`stop\`** to cancel. Expires in ${mins} minutes.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "list") {
      const messageId = interaction.options.getString("message_id", true).trim();
      const panel = getReactionRolePanel(guildId, messageId);
      if (!panel) {
        await interaction.reply({
          content: `No reaction-role panel with message ID \`${messageId}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const opts = listReactionRoleOptions(guildId, messageId);
      if (!opts.length) {
        await interaction.reply({
          content: `Panel \`${messageId}\` has no options yet.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const lines = opts.map((o) => {
        const rem = Number(o.removable) !== 0 ? "removable" : "permanent";
        return `- ${o.emoji_display} → <@&${o.role_id}> — Level ${o.min_level}+ · ${rem}`;
      });
      await interaction.reply({
        content: `**Options for panel \`${messageId}\`:**\n${lines.join("\n")}`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_PING_MENTIONS,
      });
      return;
    }
  }

  // /reactionrole sync
  if (!group && sub === "sync") {
    const messageId = interaction.options.getString("message_id", true).trim();
    const panel = getReactionRolePanel(guildId, messageId);
    if (!panel) {
      await interaction.reply({
        content: `No reaction-role panel with message ID \`${messageId}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const result = await refreshPanelMessage(interaction.guild, panel);
    if (result.ok) {
      await logConfigChange(client, guildId, {
        title: "Reaction-role panel synced",
        command: "/reactionrole sync",
        actor: interaction.user,
        changes: [`Panel: \`${messageId}\``],
      }).catch(() => {});
    }
    await interaction.reply({
      content: result.ok
        ? `Synced panel \`${messageId}\` (embed + bot reactions).`
        : `Sync failed: ${result.error}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content:
      `Unknown reactionrole subcommand: \`/${interaction.commandName}` +
      `${group ? ` ${group}` : ""} ${sub || ""}\`.\n` +
      `Use \`/reactionrole panel create|edit|deploy|delete|list\`, \`/reactionrole option add|remove|list\`, or \`/reactionrole sync\`.`,
    flags: MessageFlags.Ephemeral,
  });
  return;
}

module.exports = {
  name: "reactionRoles",
  commands,
  handlers: {
    reactionrole: handleReactionrole,
  },
  handleReactionRoleAdd,
  handleReactionRoleRemove,
  handlePendingOptionEmojiMessage,
  syncMemberReactionRoles,
  MAX_OPTIONS_PER_PANEL,
  PENDING_EMOJI_TTL_MS,
  NO_PING_MENTIONS,
  buildPanelEmbed,
  refreshPanelMessage,
  deployPanelToChannel,
  setPendingOptionAdd,
  setPendingOptionRemove,
  clearPendingOptionEmoji,
};
