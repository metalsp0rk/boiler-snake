/**
 * Close, archive, claim, transfer, sensitive, and post-close staff notes.
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


async function handleClose(interaction, ctx) {
  const ctxTicket = await requireOpenTicketChannel(interaction, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;
  const closeReason = interaction.options.getString("reason");
  const staffNoteBody = interaction.options.getString("staff_note");

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const client = ctx.client || interaction.client;
    const botMember =
      interaction.guild?.members?.me ||
      (await resolveBotMember(interaction.guild, client));

    const result = await softCloseTicket({
      client,
      channel,
      ticket,
      closedBy: interaction.user.id,
      closeReason,
      botMember,
    });

    let msg =
      `Ticket **${formatTicketRef(ticket.ticket_number)}** closed.\n` +
      `Non-staff members were removed; the channel remains for staff.\n` +
      `Run **\`/ticket archive\`** to save the transcript` +
      (Number(result.ticket.is_sensitive)
        ? " (sensitive: metadata only, no message content)"
        : "") +
      ` and delete the channel.`;
    if (result.warnings?.length) {
      msg += `\n\n_Warnings:_\n- ${result.warnings.join("\n- ")}`;
    }

    // Optional one-shot staff note via slash option
    const closedTicket = result.ticket || ticket;
    if (staffNoteBody != null && String(staffNoteBody).trim() !== "") {
      const noteResult = attachStaffNoteFromTicket({
        ticket: closedTicket,
        authorId: interaction.user.id,
        closeReason,
        body: staffNoteBody,
      });
      if (noteResult.ok) {
        msg +=
          `\n\nStaff note **N-${noteResult.note.note_number}** saved on ` +
          `<@${closedTicket.creator_user_id}> (private).`;
        await logConfigChange(client, interaction.guildId, {
          title: "Staff note created",
          command: "/ticket close staff_note",
          actor: interaction.user,
          changes: [
            `N-${noteResult.note.note_number} on <@${closedTicket.creator_user_id}>`,
            `From ticket ${formatTicketRef(closedTicket.ticket_number)}`,
          ],
        }).catch(() => {});
      } else {
        msg += `\n\n_Could not save staff note: ${noteResult.error}_`;
      }
    } else {
      msg +=
        `\n\nOptional: click **Add staff note** to record private context on ` +
        `<@${closedTicket.creator_user_id}>.`;
    }

    await interaction.editReply({
      content: msg,
      components: [buildAddStaffNoteButtonRow(closedTicket.id)],
    });
  } catch (err) {
    console.error("[tickets] close failed:", err);
    await interaction.editReply({
      content: `Failed to close ticket: ${err?.message || "unknown error"}`,
    });
  }
}

/**
 * Post-close button → modal for private staff note on the requester.
 * @param {import("discord.js").ButtonInteraction} interaction
 * @param {object} [ctx]
 */
async function handleStaffNoteButton(interaction, ctx) {
  if (!(await requireStaff(interaction))) return;

  const customId = interaction.customId || "";
  if (!customId.startsWith(BTN_STAFF_NOTE_PREFIX)) return;
  const ticketId = Number(customId.slice(BTN_STAFF_NOTE_PREFIX.length));
  if (!Number.isFinite(ticketId) || ticketId < 1) {
    await replyEphemeral(interaction, {
      content: "Invalid ticket reference on this button.",
    });
    return;
  }

  const ticket = getTicketById(ticketId);
  if (!ticket || ticket.guild_id !== interaction.guildId) {
    await replyEphemeral(interaction, {
      content: "That ticket was not found in this server.",
    });
    return;
  }

  await interaction.showModal(
    buildTicketStaffNoteModal(ticket.id, ticket.ticket_number),
  );
}

/**
 * Modal submit: save staff note linked to a closed (or open) ticket.
 * @param {import("discord.js").ModalSubmitInteraction} interaction
 * @param {object} [ctx]
 */
async function handleStaffNoteModal(interaction, ctx) {
  if (!(await requireStaff(interaction))) return;

  const customId = interaction.customId || "";
  if (!customId.startsWith(MODAL_STAFF_NOTE_PREFIX)) return;
  const ticketId = Number(customId.slice(MODAL_STAFF_NOTE_PREFIX.length));
  if (!Number.isFinite(ticketId) || ticketId < 1) {
    await replyEphemeral(interaction, {
      content: "Invalid modal state (missing ticket).",
    });
    return;
  }

  const ticket = getTicketById(ticketId);
  if (!ticket || ticket.guild_id !== interaction.guildId) {
    await replyEphemeral(interaction, {
      content: "That ticket was not found in this server.",
    });
    return;
  }

  let body = "";
  try {
    body = interaction.fields.getTextInputValue(MODAL_FIELD_STAFF_NOTE);
  } catch {
    body = "";
  }

  const noteResult = attachStaffNoteFromTicket({
    ticket,
    authorId: interaction.user.id,
    closeReason: ticket.close_reason,
    body,
  });
  if (!noteResult.ok) {
    await replyEphemeral(interaction, {
      content: noteResult.error,
    });
    return;
  }

  await logConfigChange(
    ctx?.client || interaction.client,
    interaction.guildId,
    {
      title: "Staff note created",
      command: "/ticket close → Add staff note",
      actor: interaction.user,
      changes: [
        `N-${noteResult.note.note_number} on <@${ticket.creator_user_id}>`,
        `From ticket ${formatTicketRef(ticket.ticket_number)}`,
      ],
    },
  ).catch(() => {});

  await replyEphemeral(interaction, {
    content:
      `Staff note **N-${noteResult.note.note_number}** saved on ` +
      `<@${ticket.creator_user_id}> (private; never shown to the member).\n` +
      `View with \`/note info id:${noteResult.note.note_number}\`.`,
  });
}

async function handleArchive(interaction, ctx) {
  const ctxTicket = await requireLiveTicketChannel(interaction, ctx, {
    status: "closed",
  });
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const result = await archiveTicketPipeline({
      client: ctx.client || interaction.client,
      channel,
      ticket,
      archivedBy: interaction.user.id,
      guildName: interaction.guild?.name,
    });

    let msg =
      `Ticket **${formatTicketRef(ticket.ticket_number)}** archived` +
      (Number(ticket.is_sensitive)
        ? " (sensitive — no content transcript)."
        : " — transcript saved and channel deleted.");
    if (result.warnings?.length) {
      msg += `\n\n_Warnings:_\n- ${result.warnings.join("\n- ")}`;
    }
    await interaction.editReply({ content: msg });
  } catch (err) {
    console.error("[tickets] archive failed:", err);
    await interaction.editReply({
      content: `Failed to archive ticket: ${err?.message || "unknown error"}`,
    });
  }
}

async function handleClaim(interaction, ctx) {
  const ctxTicket = await requireOpenTicketChannel(interaction, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;

  const updated = claimTicket(ticket.id, interaction.user.id);
  try {
    if (channel) {
      await applyTicketOverwrites(channel, {
        guildId: interaction.guildId,
        everyoneId: interaction.guild.id,
        botUserId: (ctx.client || interaction.client).user.id,
        ticket: updated,
      });
    }
  } catch (err) {
    console.warn("[tickets] claim overwrites:", err?.message || err);
  }

  await replyEphemeral(interaction, {
    content: `You claimed ticket **${formatTicketRef(ticket.ticket_number)}**.`,
  });
  try {
    await channel?.send?.(`<@${interaction.user.id}> claimed this ticket.`);
  } catch {
    // ignore
  }
}

async function handleTransfer(interaction, ctx) {
  const ctxTicket = await requireOpenTicketChannel(interaction, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;
  const staff = interaction.options.getUser("staff", true);

  if (staff.bot) {
    await replyEphemeral(interaction, {
      content: "Cannot transfer to a bot.",
    });
    return;
  }

  const updated = transferTicket(ticket.id, staff.id, interaction.user.id);
  try {
    if (channel) {
      await applyTicketOverwrites(channel, {
        guildId: interaction.guildId,
        everyoneId: interaction.guild.id,
        botUserId: (ctx.client || interaction.client).user.id,
        ticket: updated,
      });
    }
  } catch (err) {
    console.warn("[tickets] transfer overwrites:", err?.message || err);
  }

  await replyEphemeral(interaction, {
    content: `Transferred ticket **${formatTicketRef(ticket.ticket_number)}** to <@${staff.id}>.`,
  });
  try {
    await channel?.send?.(
      `Staff ownership transferred to <@${staff.id}> by <@${interaction.user.id}>.`,
    );
  } catch {
    // ignore
  }
}

async function handleAddUser(interaction, ctx) {
  const ctxTicket = await requireOpenTicketChannel(interaction, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;
  const user = interaction.options.getUser("user", true);

  if (user.bot) {
    await replyEphemeral(interaction, {
      content: "Cannot add a bot as a ticket member.",
    });
    return;
  }

  const added = addTicketMember(ticket.id, user.id, interaction.user.id);
  const updated = getTicketById(ticket.id);
  try {
    if (channel) {
      await applyTicketOverwrites(channel, {
        guildId: interaction.guildId,
        everyoneId: interaction.guild.id,
        botUserId: (ctx.client || interaction.client).user.id,
        ticket: updated,
      });
    }
  } catch (err) {
    console.warn("[tickets] adduser overwrites:", err?.message || err);
  }

  await replyEphemeral(interaction, {
    content: added
      ? `Added <@${user.id}> to ticket **${formatTicketRef(ticket.ticket_number)}**.`
      : `<@${user.id}> is already a member of this ticket.`,
  });
}

async function handleRemoveUser(interaction, ctx) {
  const ctxTicket = await requireOpenTicketChannel(interaction, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;
  const user = interaction.options.getUser("user", true);

  const result = removeTicketMember(ticket.id, user.id);
  if (!result.ok) {
    await replyEphemeral(interaction, {
      content: result.error,
    });
    return;
  }

  const updated = getTicketById(ticket.id);
  try {
    if (channel) {
      await applyTicketOverwrites(channel, {
        guildId: interaction.guildId,
        everyoneId: interaction.guild.id,
        botUserId: (ctx.client || interaction.client).user.id,
        ticket: updated,
      });
    }
  } catch (err) {
    console.warn("[tickets] removeuser overwrites:", err?.message || err);
  }

  await replyEphemeral(interaction, {
    content: `Removed <@${user.id}> from ticket **${formatTicketRef(ticket.ticket_number)}**.`,
  });
}

async function handleAddStaff(interaction, ctx) {
  const ctxTicket = await requireOpenTicketChannel(interaction, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;
  const user = interaction.options.getUser("user", true);

  if (user.bot) {
    await replyEphemeral(interaction, {
      content: "Cannot add a bot as ticket staff.",
    });
    return;
  }

  const added = addTicketStaff(ticket.id, user.id, interaction.user.id);
  const updated = getTicketById(ticket.id);
  try {
    if (channel) {
      await applyTicketOverwrites(channel, {
        guildId: interaction.guildId,
        everyoneId: interaction.guild.id,
        botUserId: (ctx.client || interaction.client).user.id,
        ticket: updated,
      });
    }
  } catch (err) {
    console.warn("[tickets] addstaff overwrites:", err?.message || err);
  }

  await replyEphemeral(interaction, {
    content: added
      ? `Added <@${user.id}> to the staff allow-list for **${formatTicketRef(ticket.ticket_number)}**.`
      : `<@${user.id}> is already on the staff allow-list.`,
  });
}

async function handleRemoveStaff(interaction, ctx) {
  const ctxTicket = await requireOpenTicketChannel(interaction, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;
  const user = interaction.options.getUser("user", true);

  const result = removeTicketStaff(ticket.id, user.id);
  if (!result.ok) {
    await replyEphemeral(interaction, {
      content: result.error,
    });
    return;
  }

  const updated = getTicketById(ticket.id);
  try {
    if (channel) {
      await applyTicketOverwrites(channel, {
        guildId: interaction.guildId,
        everyoneId: interaction.guild.id,
        botUserId: (ctx.client || interaction.client).user.id,
        ticket: updated,
      });
    }
  } catch (err) {
    console.warn("[tickets] removestaff overwrites:", err?.message || err);
  }

  await replyEphemeral(interaction, {
    content: `Removed <@${user.id}> from the staff allow-list.`,
  });
}

async function handleSensitive(interaction, ctx) {
  const ctxTicket = await requireOpenTicketChannel(interaction, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;

  // If owner exists and invoker is not owner, only ManageGuild may flip
  if (
    ticket.staff_owner_id &&
    ticket.staff_owner_id !== interaction.user.id &&
    !isAdminOrMod(interaction)
  ) {
    await replyEphemeral(interaction, {
      content: `Only the staff owner (<@${ticket.staff_owner_id}>) or a server admin can mark this ticket sensitive.`,
    });
    return;
  }

  const ownerId = ticket.staff_owner_id || interaction.user.id; // auto-claim
  const updated = setTicketSensitive(ticket.id, ownerId);

  try {
    if (channel) {
      await applyTicketOverwrites(channel, {
        guildId: interaction.guildId,
        everyoneId: interaction.guild.id,
        botUserId: (ctx.client || interaction.client).user.id,
        ticket: updated,
        sensitive: true,
      });
    }
  } catch (err) {
    console.warn("[tickets] sensitive overwrites:", err?.message || err);
  }

  await replyEphemeral(interaction, {
    content:
      `Ticket **${formatTicketRef(ticket.ticket_number)}** is now **sensitive**. ` +
      `Only the owner, named staff, and members can see it. Close will **not** archive content.`,
  });
  try {
    await channel?.send?.({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR_SENSITIVE)
          .setTitle("Ticket marked sensitive")
          .setDescription(
            `Visibility locked. Staff owner: <@${updated.staff_owner_id}>.`,
          ),
      ],
    });
  } catch {
    // ignore
  }
}

async function handleUnsensitive(interaction, ctx) {
  const ctxTicket = await requireOpenTicketChannel(interaction, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;

  // Staff owner OR staff gate (already required staff)
  const isOwner = ticket.staff_owner_id === interaction.user.id;
  if (!isOwner && !isStaff(interaction)) {
    await replyDenied(interaction);
    return;
  }

  const updated = setTicketUnsensitive(ticket.id);
  try {
    if (channel) {
      await applyTicketOverwrites(channel, {
        guildId: interaction.guildId,
        everyoneId: interaction.guild.id,
        botUserId: (ctx.client || interaction.client).user.id,
        ticket: updated,
        sensitive: false,
      });
    }
  } catch (err) {
    console.warn("[tickets] unsensitive overwrites:", err?.message || err);
  }

  await replyEphemeral(interaction, {
    content: `Ticket **${formatTicketRef(ticket.ticket_number)}** is no longer sensitive. Staff roles can see it again.`,
  });
}

module.exports = {
  handleClose,
  handleStaffNoteButton,
  handleStaffNoteModal,
  handleArchive,
  handleClaim,
  handleTransfer,
  handleAddUser,
  handleRemoveUser,
  handleAddStaff,
  handleRemoveStaff,
  handleSensitive,
  handleUnsensitive,
};
