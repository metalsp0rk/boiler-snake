/**
 * Self-create, staff-for, panel button, and create modal.
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


async function completeSelfCreate(interaction, ctx, reason) {
  try {
    const { ticket, channel, skippedStaffRoles } = await openTicketChannel({
      guild: interaction.guild,
      client: ctx.client || interaction.client,
      creatorUserId: interaction.user.id,
      reason,
      openedByStaffId: null,
    });

    recordSlashAudit({
      interaction,
      action: "tickets.create",
      targetType: "ticket",
      targetId: String(ticket.id),
      details: {
        ticket_number: ticket.ticket_number,
        channel_id: channel?.id ?? null,
        reason: reason ?? null,
      },
    });

    let msg = `Ticket **${formatTicketRef(ticket.ticket_number)}** opened: ${channel}`;
    if (skippedStaffRoles?.length) {
      msg += formatStaffRoleAccessNote(skippedStaffRoles);
    }
    await interaction.editReply({ content: msg });
  } catch (err) {
    console.error("[tickets] create failed:", err);
    await interaction.editReply({
      content:
        err?.code === "INVALID_REASON" ||
        err?.code === "BOT_PERMISSIONS" ||
        err?.code === "CHANNEL_CREATE"
          ? err.message
          : `Failed to open ticket: ${formatChannelCreateError(err)}`,
    });
  }
}

async function handleCreate(interaction, ctx) {
  const reason = interaction.options.getString("reason");
  const check = canUserCreateTicket(interaction.guildId, interaction.user.id);
  if (!check.ok) {
    await replyEphemeral(interaction, {
      content: formatRateLimitMessage(check),
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await completeSelfCreate(interaction, ctx, reason);
}

async function handleOpenTicketButton(interaction, _ctx) {
  if (!interaction.guild) {
    await replyEphemeral(interaction, {
      content: "Tickets can only be opened in a server.",
    });
    return;
  }

  if (interaction.user?.bot) {
    await replyEphemeral(interaction, {
      content: "Bots cannot open tickets.",
    });
    return;
  }

  // Early rate-limit feedback so users don't fill the modal for nothing.
  // Re-checked on modal submit (state can change while modal is open).
  const check = canUserCreateTicket(interaction.guildId, interaction.user.id);
  if (!check.ok) {
    await replyEphemeral(interaction, {
      content: formatRateLimitMessage(check),
    });
    return;
  }

  await interaction.showModal(buildCreateTicketModal());
}

/**
 * Modal submit from panel button → create ticket (public, rate-limited).
 * @param {import("discord.js").ModalSubmitInteraction} interaction
 * @param {object} ctx
 */
async function handleCreateTicketModal(interaction, ctx) {
  if (!interaction.guild) {
    await replyEphemeral(interaction, {
      content: "Tickets can only be opened in a server.",
    });
    return;
  }

  if (interaction.user?.bot) {
    await replyEphemeral(interaction, {
      content: "Bots cannot open tickets.",
    });
    return;
  }

  let reason = null;
  try {
    const raw = interaction.fields.getTextInputValue(MODAL_FIELD_REASON);
    reason =
      raw != null && String(raw).trim() !== "" ? String(raw).trim() : null;
  } catch {
    reason = null;
  }

  const check = canUserCreateTicket(interaction.guildId, interaction.user.id);
  if (!check.ok) {
    await replyEphemeral(interaction, {
      content: formatRateLimitMessage(check),
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await completeSelfCreate(interaction, ctx, reason);
}

async function handleFor(interaction, ctx) {
  const target = interaction.options.getUser("user", true);
  const reason = interaction.options.getString("reason");

  if (target.bot) {
    await replyEphemeral(interaction, {
      content: "Cannot open a ticket for a bot.",
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const { ticket, channel, skippedStaffRoles } = await openTicketChannel({
      guild: interaction.guild,
      client: ctx.client || interaction.client,
      creatorUserId: target.id,
      reason,
      openedByStaffId: interaction.user.id,
    });

    recordSlashAudit({
      interaction,
      action: "tickets.create",
      targetType: "ticket",
      targetId: String(ticket.id),
      details: {
        ticket_number: ticket.ticket_number,
        channel_id: channel?.id ?? null,
        subject_user_id: target.id,
        reason: reason ?? null,
      },
    });

    // Best-effort DM
    try {
      await target.send({
        content:
          `A support ticket was opened for you in **${interaction.guild.name}**: ` +
          `https://discord.com/channels/${interaction.guildId}/${channel.id}`,
      });
    } catch {
      // DMs closed
    }

    let msg = `Ticket **${formatTicketRef(ticket.ticket_number)}** opened for <@${target.id}>: ${channel}`;
    if (skippedStaffRoles?.length) {
      msg += formatStaffRoleAccessNote(skippedStaffRoles);
    }
    await interaction.editReply({ content: msg });
  } catch (err) {
    console.error("[tickets] for failed:", err);
    await interaction.editReply({
      content:
        err?.code === "BOT_PERMISSIONS" || err?.code === "CHANNEL_CREATE"
          ? err.message
          : `Failed to open ticket: ${formatChannelCreateError(err)}`,
    });
  }
}

module.exports = {
  completeSelfCreate,
  handleCreate,
  handleOpenTicketButton,
  handleCreateTicketModal,
  handleFor,
};
