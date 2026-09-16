/**
 * Stored ticket panel registry: create/list/edit/delete.
 */
const {
  MessageFlags,
  EmbedBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const {
  MAX_TICKET_REASON,
  getTicketSettings,
  canUserCreateTicket,
  createTicket,
  getTicketByChannel,
  getTicketById,
  claimTicket,
  transferTicket,
  addTicketStaff,
  removeTicketStaff,
  setTicketSensitive,
  setTicketUnsensitive,
  addTicketMember,
  removeTicketMember,
  listTicketMembers,
  listTicketStaff,
  listTicketMessages,
  listOpenTickets,
  updateGuildSettings,
  listStaffRoles,
  listSeniorStaffRoles,
  normalizeStaffLevel,
  createStaffNote,
  MAX_NOTE_CONTENT,
  createTicketPanel,
  getTicketPanel,
  listTicketPanels,
  updateTicketPanelText,
  deleteTicketPanel,
} = require("../../db");
const {
  requireStaff,
  isStaff,
  isAdminOrMod,
} = require("../../core/permissions");
const {
  replyDenied,
  replyEphemeral,
  editEphemeral,
} = require("../../core/interaction");
const { logConfigChange } = require("../logs/auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");
const {
  applyTicketOverwrites,
  getManageableStaffRoleIds,
  formatStaffRoleAccessNote,
  describeSkippedStaffRoles,
  assertBotCanCreateTickets,
  formatChannelCreateError,
  MEMBER_ALLOW,
  MEMBER_DENY,
  STAFF_ALLOW,
  BOT_ALLOW,
} = require("./overwrites");
const {
  softCloseTicket,
  archiveTicketPipeline,
  fetchAllMessages,
} = require("./close");
const {
  collectTicketUserIds,
  resolveUsers,
  enrichMessagesForArchive,
} = require("./users");
const { summarizeTicket } = require("./summary");
const {
  formatTicketRef,
  tsFull,
  baseEmbed,
} = require("../../core/theme");
const {
  COLOR_OPEN,
  COLOR_INFO,
  COLOR_SENSITIVE,
  BTN_OPEN,
  MODAL_CREATE,
  MODAL_FIELD_REASON,
  BTN_STAFF_NOTE_PREFIX,
  MODAL_STAFF_NOTE_PREFIX,
  MODAL_FIELD_STAFF_NOTE,
  DEFAULT_PANEL_TITLE,
  DEFAULT_PANEL_DESCRIPTION,
} = require("./constants");
const helpers = require("./helpers");
const {
  formatRateLimitMessage,
  buildOpenTicketButtonRow,
  buildCreateTicketModal,
  buildPanelEmbed,
  buildTicketStaffNoteContent,
  attachStaffNoteFromTicket,
  buildAddStaffNoteButtonRow,
  buildTicketStaffNoteModal,
  resolveChannel,
  requireOpenTicketChannel,
  requireLiveTicketChannel,
  resolveBotMember,
  openTicketChannel,
} = helpers;


async function handlePanelCreate(interaction, ctx) {
  const targetChannel =
    interaction.options.getChannel("channel") ||
    (await resolveChannel(interaction, ctx));
  const title =
    interaction.options.getString("title")?.trim() || DEFAULT_PANEL_TITLE;
  const description =
    interaction.options.getString("description")?.trim() ||
    DEFAULT_PANEL_DESCRIPTION;

  if (!targetChannel || typeof targetChannel.send !== "function") {
    await replyEphemeral(interaction, {
      content:
        "Could not resolve a text channel to post the panel. Pass `channel:` or run this in a text channel.",
    });
    return;
  }

  const type = targetChannel.type;
  const okType =
    type === ChannelType.GuildText ||
    type === ChannelType.GuildAnnouncement ||
    type == null; // mocks may omit type
  if (!okType) {
    await replyEphemeral(interaction, {
      content: "Panel must be posted in a text or announcement channel.",
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const embed = buildPanelEmbed(title, description);
    const message = await targetChannel.send({
      embeds: [embed],
      components: [buildOpenTicketButtonRow()],
    });

    // Store panel in registry
    createTicketPanel(
      interaction.guildId,
      targetChannel.id,
      message.id,
      title,
      description,
    );

    recordSlashAudit({
      interaction,
      action: "tickets.panel_create",
      targetType: "ticket_panel",
      targetId: message.id,
      details: { channel_id: targetChannel.id, title },
    });

    await logConfigChange(
      ctx?.client || interaction.client,
      interaction.guildId,
      {
        title: "Ticket panel created",
        command: "/ticket panel create",
        actor: interaction.user,
        changes: [
          `Channel: <#${targetChannel.id}>`,
          `Message: \`${message.id}\``,
          `Title: ${title}`,
        ],
      },
    ).catch(() => {});

    const jump =
      interaction.guildId && targetChannel.id && message.id
        ? `https://discord.com/channels/${interaction.guildId}/${targetChannel.id}/${message.id}`
        : null;

    await interaction.editReply({
      content:
        `Created ticket panel in <#${targetChannel.id}>.\n` +
        `Message ID: \`${message.id}\`\n` +
        (jump ? `[Jump to panel](${jump})` : "") +
        "\n\nList panels with `/ticket panel list`.",
    });
  } catch (err) {
    console.error("[tickets] panel create failed:", err);
    await interaction.editReply({
      content: `Failed to post panel: ${err?.message || "unknown error"}`,
    });
  }
}

/**
 * Staff: list all registered ticket panels.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
async function handlePanelList(interaction) {
  const panels = listTicketPanels(interaction.guildId);
  if (!panels.length) {
    await interaction.reply({
      content:
        "No ticket panels configured. Use `/ticket panel create` to post one.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = panels.map((p) => {
    const jump = `https://discord.com/channels/${interaction.guildId}/${p.channel_id}/${p.message_id}`;
    return `- **${p.title || DEFAULT_PANEL_TITLE}** in <#${p.channel_id}> — \`${p.message_id}\` — [jump](${jump})`;
  });

  await interaction.reply({
    content: `**Ticket panels:**\n${lines.join("\n")}`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Staff: edit a registered panel's title and/or description.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} ctx
 */
async function handlePanelEdit(interaction, ctx) {
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

  const updated = updateTicketPanelText(
    interaction.guildId,
    messageId,
    title != null ? title.trim() : null,
    description != null ? description.trim() : null,
  );

  if (!updated) {
    await interaction.reply({
      content: `No ticket panel with message ID \`${messageId}\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  recordSlashAudit({
    interaction,
    action: "tickets.panel_update",
    targetType: "ticket_panel",
    targetId: messageId,
    details: {
      title_updated: title != null,
      description_updated: description != null,
    },
  });

  const panel = getTicketPanel(interaction.guildId, messageId);
  const finalTitle =
    (title != null ? title.trim() : panel?.title) || DEFAULT_PANEL_TITLE;
  const finalDesc =
    (description != null ? description.trim() : panel?.description) ||
    DEFAULT_PANEL_DESCRIPTION;

  // Try to update the live Discord message embed
  let note = "";
  if (panel?.channel_id) {
    try {
      const channel = await interaction.guild.channels
        .fetch(panel.channel_id)
        .catch(() => null);
      if (channel?.messages) {
        const msg = await channel.messages.fetch(messageId).catch(() => null);
        if (msg) {
          const embed = buildPanelEmbed(finalTitle, finalDesc);
          await msg.edit({
            embeds: [embed],
            components: [buildOpenTicketButtonRow()],
          });
          note = " Discord message updated.";
        } else {
          note = " (Message was already gone.)";
        }
      }
    } catch {
      note = " (Could not update Discord message — it may have been deleted.)";
    }
  }

  await logConfigChange(
    ctx?.client || interaction.client,
    interaction.guildId,
    {
      title: "Ticket panel edited",
      command: "/ticket panel edit",
      actor: interaction.user,
      changes: [
        `Message ID: \`${messageId}\``,
        panel ? `Channel: <#${panel.channel_id}>` : null,
        title != null ? `New title: ${finalTitle}` : null,
        description != null ? "Description updated" : null,
      ].filter(Boolean),
    },
  ).catch(() => {});

  await interaction.reply({
    content: `Updated ticket panel \`${messageId}\`.${note}`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Staff: delete a registered panel and its Discord message.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} ctx
 */
async function handlePanelDelete(interaction, ctx) {
  const messageId = interaction.options.getString("message_id", true).trim();
  const { removed, channel_id } = deleteTicketPanel(
    interaction.guildId,
    messageId,
  );

  let note = "";
  if (removed && channel_id) {
    try {
      const channel = await interaction.guild.channels
        .fetch(channel_id)
        .catch(() => null);
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
      note =
        " (Could not delete Discord message — remove it manually if needed.)";
    }
  }

  if (removed) {
    recordSlashAudit({
      interaction,
      action: "tickets.panel_delete",
      targetType: "ticket_panel",
      targetId: messageId,
      details: { channel_id: channel_id ?? null },
    });

    await logConfigChange(
      ctx?.client || interaction.client,
      interaction.guildId,
      {
        title: "Ticket panel deleted",
        command: "/ticket panel delete",
        actor: interaction.user,
        changes: [
          `Message ID: \`${messageId}\``,
          channel_id ? `Channel: <#${channel_id}>` : null,
        ].filter(Boolean),
      },
    ).catch(() => {});
  }

  await interaction.reply({
    content: removed
      ? `Deleted ticket panel \`${messageId}\`.${note}`
      : `No ticket panel with message ID \`${messageId}\`.`,
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = {
  handlePanelCreate,
  handlePanelList,
  handlePanelEdit,
  handlePanelDelete,
};
