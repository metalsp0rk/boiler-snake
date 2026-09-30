/**
 * Close, archive, claim, transfer, sensitive, and post-close staff notes.
 */
const {
  getTicketById,
  claimTicket,
  transferTicket,
  addTicketStaff,
  removeTicketStaff,
  setTicketSensitive,
  setTicketUnsensitive,
  addTicketMember,
  removeTicketMember,
} = require("../../db");
const {
  requireStaff,
  isAdminOrModFromContext,
  isStaffFromContext,
} = require("../../core/permissions");
const { replyEphemeral } = require("../../core/interaction");
const { logConfigChange } = require("../logs/auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");
const { getDiscordOutbound } = require("../../platform/discord/outbound");
const { ensureCommunity } = require("../../platform/community");
const { applyTicketOverwrites } = require("./overwrites");
const { softCloseTicket, archiveTicketPipeline } = require("./close");
const { formatTicketRef, MSG_DENIED } = require("../../core/theme");
const {
  COLOR_SENSITIVE,
  BTN_STAFF_NOTE_PREFIX,
  MODAL_STAFF_NOTE_PREFIX,
  MODAL_FIELD_STAFF_NOTE,
} = require("./constants");
const {
  attachStaffNoteFromTicket,
  buildAddStaffNoteButtonRow,
  buildTicketStaffNoteModal,
  requireOpenTicketChannel,
  requireLiveTicketChannel,
  resolveBotMember,
} = require("./helpers");

/**
 * Standard reply for Fluxer dispatches reaching Discord-only surfaces
 * (roadmap/fluxer.md § What stays Discord-only): ticket channel lifecycle
 * (close/archive/claim overwrites, staff-note buttons and modals) uses
 * discord.js channel objects and component builders until the OutboundClient
 * cutover in PR 7.
 */
const NOT_ON_FLUXER = "That command is not available on Fluxer yet.";


/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [ctx]
 */
async function handleClose(commandCtx, ctx) {
  // Ticket channel lifecycle needs discord.js channel objects (close.js
  // pipeline: overwrites, member removal, pins). PR 7 cuts this over to the
  // OutboundClient; Fluxer contexts carry no rawInteraction.
  const raw = commandCtx.rawInteraction;
  if (!raw) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }
  const ctxTicket = await requireOpenTicketChannel(raw, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;
  const closeReason = commandCtx.options.getString("reason");
  const staffNoteBody = commandCtx.options.getString("staff_note");

  await commandCtx.defer({ sensitive: true });

  try {
    const client = ctx?.client || raw.client;
    const botMember =
      raw.guild?.members?.me || (await resolveBotMember(raw.guild, client));

    const result = await softCloseTicket({
      client,
      channel,
      ticket,
      closedBy: commandCtx.userId,
      closeReason,
      botMember,
    });

    recordSlashAudit({
      communityId: commandCtx.communityId,
      actorUserId: commandCtx.userId,
      action: "tickets.close",
      targetType: "ticket",
      targetId: String(ticket.id),
      details: {
        ticket_number: ticket.ticket_number,
        close_reason: closeReason ?? null,
        status: result.ticket?.status ?? ticket.status,
      },
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
        authorId: commandCtx.userId,
        closeReason,
        body: staffNoteBody,
      });
      if (noteResult.ok) {
        msg +=
          `\n\nStaff note **N-${noteResult.note.note_number}** saved on ` +
          `<@${closedTicket.creator_user_id}> (private).`;
        recordSlashAudit({
          communityId: commandCtx.communityId,
          actorUserId: commandCtx.userId,
          action: "notes.add",
          targetType: "note",
          targetId: String(noteResult.note.id),
          details: {
            note_number: noteResult.note.note_number,
            subject_user_id: closedTicket.creator_user_id,
            from_ticket: closedTicket.ticket_number,
          },
        });
        await logConfigChange(
          commandCtx.outbound,
          commandCtx.externalGuildId,
          {
            title: "Staff note created",
            command: "/ticket close staff_note",
            actor: commandCtx.user,
            changes: [
              `N-${noteResult.note.note_number} on <@${closedTicket.creator_user_id}>`,
              `From ticket ${formatTicketRef(closedTicket.ticket_number)}`,
            ],
          },
        ).catch(() => {});
      } else {
        msg += `\n\n_Could not save staff note: ${noteResult.error}_`;
      }
    } else {
      msg +=
        `\n\nOptional: click **Add staff note** to record private context on ` +
        `<@${closedTicket.creator_user_id}>.`;
    }

    // The Add-staff-note button is a discord.js ActionRow: Discord-only arm
    // (components are out of scope until the PR 7 component builder).
    await commandCtx.editReply({
      content: msg,
      components: [buildAddStaffNoteButtonRow(closedTicket.id)],
    });
  } catch (err) {
    console.error("[tickets] close failed:", err);
    await commandCtx.editReply({
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
  // Discord edge: resolve the external guild snowflake to the integer
  // community id (spec § Repository boundary); rows carry .community_id.
  const communityId = interaction.guildId
    ? ensureCommunity({
        platform: "discord",
        instanceKey: "discord",
        externalGuildId: interaction.guildId,
      })
    : null;
  if (!ticket || !communityId || ticket.community_id !== communityId) {
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
  // Discord edge: resolve the external guild snowflake to the integer
  // community id (spec § Repository boundary); rows carry .community_id.
  const communityId = interaction.guildId
    ? ensureCommunity({
        platform: "discord",
        instanceKey: "discord",
        externalGuildId: interaction.guildId,
      })
    : null;
  if (!ticket || !communityId || ticket.community_id !== communityId) {
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

  recordSlashAudit({
    interaction,
    action: "notes.add",
    targetType: "note",
    targetId: String(noteResult.note.id),
    details: {
      note_number: noteResult.note.note_number,
      subject_user_id: ticket.creator_user_id,
      from_ticket: ticket.ticket_number,
    },
  });
  await logConfigChange(
    getDiscordOutbound(ctx?.client || interaction.client),
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

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [ctx]
 */
async function handleArchive(commandCtx, ctx) {
  // Archive needs the live discord.js channel for transcript fetch + delete
  // (PR 7 cutover); Fluxer contexts carry no rawInteraction.
  const raw = commandCtx.rawInteraction;
  if (!raw) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }
  const ctxTicket = await requireLiveTicketChannel(raw, ctx, {
    status: "closed",
  });
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;

  await commandCtx.defer({ sensitive: true });

  try {
    const result = await archiveTicketPipeline({
      client: ctx?.client || raw.client,
      channel,
      ticket,
      archivedBy: commandCtx.userId,
      guildName: raw.guild?.name,
    });

    recordSlashAudit({
      communityId: commandCtx.communityId,
      actorUserId: commandCtx.userId,
      action: "tickets.archive",
      targetType: "ticket",
      targetId: String(ticket.id),
      details: {
        ticket_number: ticket.ticket_number,
        status: result.ticket?.status ?? ticket.status,
        sensitive: Number(ticket.is_sensitive) ? 1 : 0,
      },
    });

    let msg =
      `Ticket **${formatTicketRef(ticket.ticket_number)}** archived` +
      (Number(ticket.is_sensitive)
        ? " (sensitive — no content transcript)."
        : " — transcript saved and channel deleted.");
    if (result.warnings?.length) {
      msg += `\n\n_Warnings:_\n- ${result.warnings.join("\n- ")}`;
    }
    await commandCtx.editReply({ content: msg, sensitive: true });
  } catch (err) {
    console.error("[tickets] archive failed:", err);
    await commandCtx.editReply({
      content: `Failed to archive ticket: ${err?.message || "unknown error"}`,
      sensitive: true,
    });
  }
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [ctx]
 */
async function handleClaim(commandCtx, ctx) {
  // Claim rewrites channel permissions: needs the discord.js channel object
  // (PR 7 cutover).
  const raw = commandCtx.rawInteraction;
  if (!raw) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }
  const ctxTicket = await requireOpenTicketChannel(raw, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;

  const updated = claimTicket(ticket.id, commandCtx.userId);
  recordSlashAudit({
    communityId: commandCtx.communityId,
    actorUserId: commandCtx.userId,
    action: "tickets.claim",
    targetType: "ticket",
    targetId: String(ticket.id),
    details: {
      ticket_number: ticket.ticket_number,
      previous_owner: ticket.staff_owner_id ?? null,
      staff_owner_id: updated?.staff_owner_id ?? commandCtx.userId,
    },
  });
  try {
    if (channel) {
      await applyTicketOverwrites(channel, {
        guildId: commandCtx.externalGuildId,
        everyoneId: raw.guild.id,
        botUserId: commandCtx.outbound.botUserId,
        ticket: updated,
      });
    }
  } catch (err) {
    console.warn("[tickets] claim overwrites:", err?.message || err);
  }

  await commandCtx.reply({
    content: `You claimed ticket **${formatTicketRef(ticket.ticket_number)}**.`,
    sensitive: true,
  });
  // In-channel notice via outbound (spec § Outbound client): failures are
  // logged, never silent. PLAIN STRING payload — byte-identical to the
  // pre-seam channel.send and to the web transport's notice (parity pinned
  // by test/web-phase3-gate.test.js §8.11).
  const notice = await commandCtx.outbound.sendChannel(
    commandCtx.channelId,
    `<@${commandCtx.userId}> claimed this ticket.`,
  );
  if (!notice.ok) {
    console.warn("[tickets] claim notice:", notice.error);
  }
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [ctx]
 */
async function handleTransfer(commandCtx, ctx) {
  const raw = commandCtx.rawInteraction;
  if (!raw) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }
  const ctxTicket = await requireOpenTicketChannel(raw, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;
  const staff = commandCtx.options.getUser("staff", true);

  if (staff.bot) {
    await commandCtx.reply({
      content: "Cannot transfer to a bot.",
      sensitive: true,
    });
    return;
  }

  const updated = transferTicket(ticket.id, staff.id, commandCtx.userId);
  recordSlashAudit({
    communityId: commandCtx.communityId,
    actorUserId: commandCtx.userId,
    action: "tickets.transfer",
    targetType: "ticket",
    targetId: String(ticket.id),
    details: {
      ticket_number: ticket.ticket_number,
      previous_owner: ticket.staff_owner_id ?? null,
      staff_owner_id: updated?.staff_owner_id ?? staff.id,
    },
  });
  try {
    if (channel) {
      await applyTicketOverwrites(channel, {
        guildId: commandCtx.externalGuildId,
        everyoneId: raw.guild.id,
        botUserId: commandCtx.outbound.botUserId,
        ticket: updated,
      });
    }
  } catch (err) {
    console.warn("[tickets] transfer overwrites:", err?.message || err);
  }

  await commandCtx.reply({
    content: `Transferred ticket **${formatTicketRef(ticket.ticket_number)}** to <@${staff.id}>.`,
    sensitive: true,
  });
  // Plain-string notice — byte-identical to the pre-seam channel.send and
  // to the web transport (test/web-phase3-gate.test.js §8.11 parity).
  const notice = await commandCtx.outbound.sendChannel(
    commandCtx.channelId,
    `Staff ownership transferred to <@${staff.id}> by <@${commandCtx.userId}>.`,
  );
  if (!notice.ok) {
    console.warn("[tickets] transfer notice:", notice.error);
  }
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [ctx]
 */
async function handleAddUser(commandCtx, ctx) {
  const raw = commandCtx.rawInteraction;
  if (!raw) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }
  const ctxTicket = await requireOpenTicketChannel(raw, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;
  const user = commandCtx.options.getUser("user", true);

  if (user.bot) {
    await commandCtx.reply({
      content: "Cannot add a bot as a ticket member.",
      sensitive: true,
    });
    return;
  }

  const added = addTicketMember(ticket.id, user.id, commandCtx.userId);
  if (added) {
    recordSlashAudit({
      communityId: commandCtx.communityId,
      actorUserId: commandCtx.userId,
      action: "tickets.member_add",
      targetType: "ticket",
      targetId: String(ticket.id),
      details: { ticket_number: ticket.ticket_number, user_id: user.id },
    });
  }
  const updated = getTicketById(ticket.id);
  try {
    if (channel) {
      await applyTicketOverwrites(channel, {
        guildId: commandCtx.externalGuildId,
        everyoneId: raw.guild.id,
        botUserId: commandCtx.outbound.botUserId,
        ticket: updated,
      });
    }
  } catch (err) {
    console.warn("[tickets] adduser overwrites:", err?.message || err);
  }

  await commandCtx.reply({
    content: added
      ? `Added <@${user.id}> to ticket **${formatTicketRef(ticket.ticket_number)}**.`
      : `<@${user.id}> is already a member of this ticket.`,
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [ctx]
 */
async function handleRemoveUser(commandCtx, ctx) {
  const raw = commandCtx.rawInteraction;
  if (!raw) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }
  const ctxTicket = await requireOpenTicketChannel(raw, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;
  const user = commandCtx.options.getUser("user", true);

  const result = removeTicketMember(ticket.id, user.id);
  if (result.ok) {
    recordSlashAudit({
      communityId: commandCtx.communityId,
      actorUserId: commandCtx.userId,
      action: "tickets.member_remove",
      targetType: "ticket",
      targetId: String(ticket.id),
      details: { ticket_number: ticket.ticket_number, user_id: user.id },
    });
  }
  if (!result.ok) {
    await commandCtx.reply({
      content: result.error,
      sensitive: true,
    });
    return;
  }

  const updated = getTicketById(ticket.id);
  try {
    if (channel) {
      await applyTicketOverwrites(channel, {
        guildId: commandCtx.externalGuildId,
        everyoneId: raw.guild.id,
        botUserId: commandCtx.outbound.botUserId,
        ticket: updated,
      });
    }
  } catch (err) {
    console.warn("[tickets] removeuser overwrites:", err?.message || err);
  }

  await commandCtx.reply({
    content: `Removed <@${user.id}> from ticket **${formatTicketRef(ticket.ticket_number)}**.`,
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [ctx]
 */
async function handleAddStaff(commandCtx, ctx) {
  const raw = commandCtx.rawInteraction;
  if (!raw) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }
  const ctxTicket = await requireOpenTicketChannel(raw, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;
  const user = commandCtx.options.getUser("user", true);

  if (user.bot) {
    await commandCtx.reply({
      content: "Cannot add a bot as ticket staff.",
      sensitive: true,
    });
    return;
  }

  const added = addTicketStaff(ticket.id, user.id, commandCtx.userId);
  if (added) {
    recordSlashAudit({
      communityId: commandCtx.communityId,
      actorUserId: commandCtx.userId,
      action: "tickets.staff_add",
      targetType: "ticket",
      targetId: String(ticket.id),
      details: { ticket_number: ticket.ticket_number, user_id: user.id },
    });
  }
  const updated = getTicketById(ticket.id);
  try {
    if (channel) {
      await applyTicketOverwrites(channel, {
        guildId: commandCtx.externalGuildId,
        everyoneId: raw.guild.id,
        botUserId: commandCtx.outbound.botUserId,
        ticket: updated,
      });
    }
  } catch (err) {
    console.warn("[tickets] addstaff overwrites:", err?.message || err);
  }

  await commandCtx.reply({
    content: added
      ? `Added <@${user.id}> to the staff allow-list for **${formatTicketRef(ticket.ticket_number)}**.`
      : `<@${user.id}> is already on the staff allow-list.`,
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [ctx]
 */
async function handleRemoveStaff(commandCtx, ctx) {
  const raw = commandCtx.rawInteraction;
  if (!raw) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }
  const ctxTicket = await requireOpenTicketChannel(raw, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;
  const user = commandCtx.options.getUser("user", true);

  const result = removeTicketStaff(ticket.id, user.id);
  if (result.ok) {
    recordSlashAudit({
      communityId: commandCtx.communityId,
      actorUserId: commandCtx.userId,
      action: "tickets.staff_remove",
      targetType: "ticket",
      targetId: String(ticket.id),
      details: { ticket_number: ticket.ticket_number, user_id: user.id },
    });
  }
  if (!result.ok) {
    await commandCtx.reply({
      content: result.error,
      sensitive: true,
    });
    return;
  }

  const updated = getTicketById(ticket.id);
  try {
    if (channel) {
      await applyTicketOverwrites(channel, {
        guildId: commandCtx.externalGuildId,
        everyoneId: raw.guild.id,
        botUserId: commandCtx.outbound.botUserId,
        ticket: updated,
      });
    }
  } catch (err) {
    console.warn("[tickets] removestaff overwrites:", err?.message || err);
  }

  await commandCtx.reply({
    content: `Removed <@${user.id}> from the staff allow-list.`,
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [ctx]
 */
async function handleSensitive(commandCtx, ctx) {
  const raw = commandCtx.rawInteraction;
  if (!raw) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }
  const ctxTicket = await requireOpenTicketChannel(raw, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;

  // If owner exists and invoker is not owner, only ManageGuild may flip
  if (
    ticket.staff_owner_id &&
    ticket.staff_owner_id !== commandCtx.userId &&
    !isAdminOrModFromContext(commandCtx)
  ) {
    await commandCtx.reply({
      content: `Only the staff owner (<@${ticket.staff_owner_id}>) or a server admin can mark this ticket sensitive.`,
      sensitive: true,
    });
    return;
  }

  const ownerId = ticket.staff_owner_id || commandCtx.userId; // auto-claim
  const updated = setTicketSensitive(ticket.id, ownerId);
  recordSlashAudit({
    communityId: commandCtx.communityId,
    actorUserId: commandCtx.userId,
    action: "tickets.sensitive_set",
    targetType: "ticket",
    targetId: String(ticket.id),
    details: {
      ticket_number: ticket.ticket_number,
      was_sensitive: Number(ticket.is_sensitive) ? 1 : 0,
      staff_owner_id: ownerId,
    },
  });

  try {
    if (channel) {
      await applyTicketOverwrites(channel, {
        guildId: commandCtx.externalGuildId,
        everyoneId: raw.guild.id,
        botUserId: commandCtx.outbound.botUserId,
        ticket: updated,
        sensitive: true,
      });
    }
  } catch (err) {
    console.warn("[tickets] sensitive overwrites:", err?.message || err);
  }

  await commandCtx.reply({
    content:
      `Ticket **${formatTicketRef(ticket.ticket_number)}** is now **sensitive**. ` +
      `Only the owner, named staff, and members can see it. Close will **not** archive content.`,
    sensitive: true,
  });
  // In-channel notice via outbound with a plain NormalizedEmbed (same visible
  // text/color as the previous EmbedBuilder chain).
  const notice = await commandCtx.outbound.sendChannel(commandCtx.channelId, {
    embeds: [
      {
        color: COLOR_SENSITIVE,
        title: "Ticket marked sensitive",
        description: `Visibility locked. Staff owner: <@${updated.staff_owner_id}>.`,
      },
    ],
  });
  if (!notice.ok) {
    console.warn("[tickets] sensitive notice:", notice.error);
  }
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [ctx]
 */
async function handleUnsensitive(commandCtx, ctx) {
  const raw = commandCtx.rawInteraction;
  if (!raw) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }
  const ctxTicket = await requireOpenTicketChannel(raw, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;

  // Staff owner OR staff gate (already required staff at the dispatcher)
  const isOwner = ticket.staff_owner_id === commandCtx.userId;
  if (!isOwner && !isStaffFromContext(commandCtx)) {
    await commandCtx.reply({ content: MSG_DENIED, sensitive: true });
    return;
  }

  const updated = setTicketUnsensitive(ticket.id);
  recordSlashAudit({
    communityId: commandCtx.communityId,
    actorUserId: commandCtx.userId,
    action: "tickets.sensitive_clear",
    targetType: "ticket",
    targetId: String(ticket.id),
    details: {
      ticket_number: ticket.ticket_number,
      was_sensitive: Number(ticket.is_sensitive) ? 1 : 0,
    },
  });
  try {
    if (channel) {
      await applyTicketOverwrites(channel, {
        guildId: commandCtx.externalGuildId,
        everyoneId: raw.guild.id,
        botUserId: commandCtx.outbound.botUserId,
        ticket: updated,
        sensitive: false,
      });
    }
  } catch (err) {
    console.warn("[tickets] unsensitive overwrites:", err?.message || err);
  }

  await commandCtx.reply({
    content: `Ticket **${formatTicketRef(ticket.ticket_number)}** is no longer sensitive. Staff roles can see it again.`,
    sensitive: true,
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
