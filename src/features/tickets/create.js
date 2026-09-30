/**
 * Self-create, staff-for, panel button, and create modal.
 */
const { MessageFlags } = require("discord.js");
const { canUserCreateTicket } = require("../../db");
const { replyEphemeral } = require("../../core/interaction");
const { recordSlashAudit } = require("../../core/auditTrail");
// Discord edge: (platform, instanceKey, snowflake) → integer community id,
// resolved once per entry point (roadmap/fluxer.md § Repository boundary).
const { ensureCommunity } = require("../../platform/community");
const { formatTicketRef } = require("../../core/theme");
const { formatChannelCreateError, formatStaffRoleAccessNote } =
  require("./overwrites");
const { formatRateLimitMessage, buildCreateTicketModal, openTicketChannel } =
  require("./helpers");
const { MODAL_FIELD_REASON } = require("./constants");
const { showModalFromContext } = require("../../platform/context");

/**
 * Standard reply for Fluxer dispatches reaching Discord-only surfaces
 * (roadmap/fluxer.md § What stays Discord-only): ticket channels are
 * discord.js guild channels until the OutboundClient cutover in PR 7.
 */
const NOT_ON_FLUXER = "That command is not available on Fluxer yet.";


/**
 * @param {import("discord.js").ChatInputCommandInteraction|import("discord.js").ModalSubmitInteraction} interaction
 * @param {object} ctx
 * @param {string|null} reason
 * @param {number} [communityId] integer community id resolved at the entry point;
 *   openTicketChannel/audit fall back to the Discord-identity lookup when omitted.
 */
async function completeSelfCreate(interaction, ctx, reason, communityId) {
  try {
    const { ticket, channel, skippedStaffRoles } = await openTicketChannel({
      guild: interaction.guild,
      client: ctx.client || interaction.client,
      creatorUserId: interaction.user.id,
      reason,
      openedByStaffId: null,
      communityId,
    });

    recordSlashAudit({
      interaction,
      communityId,
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

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [ctx]
 */
async function handleCreate(commandCtx, ctx) {
  const reason = commandCtx.options.getString("reason");
  // Repository key: integer community id, resolved by the context builder.
  const communityId = commandCtx.communityId;
  const check = canUserCreateTicket(communityId, commandCtx.userId);
  if (!check.ok) {
    await commandCtx.reply({
      content: formatRateLimitMessage(check),
      sensitive: true,
    });
    return;
  }

  // No reason provided → open the tk:create modal for the description
  // (roadmap § Prefix grammar: chat-input flows that show modals keep the
  // modal on Discord). showModalFromContext is the sanctioned modal path
  // (CommandContext deliberately has no showModal); it resolves false on
  // Fluxer, where PR 8's parser overlay makes `reason` required — reply the
  // inline-usage line there instead.
  if (reason == null) {
    const shown = await showModalFromContext(
      commandCtx,
      buildCreateTicketModal(),
    );
    if (!shown) {
      await commandCtx.reply({
        content:
          "Pass what you need help with with the `reason` option — this platform can't open the ticket modal.",
        sensitive: true,
      });
    }
    return;
  }

  // Ticket channels are discord.js guild channels: the openTicketChannel
  // pipeline (guild.channels.create + permission overwrites) cuts over to the
  // OutboundClient in PR 7 (roadmap § Outbound client). Fluxer contexts carry
  // no rawInteraction → the standard not-yet-available line.
  const raw = commandCtx.rawInteraction;
  if (!raw) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }

  await commandCtx.defer({ sensitive: true });
  // Helpers keep their (interaction, ctx) signatures until PR 7 — pass the
  // raw interaction; completeSelfCreate edits the deferred reply we just made.
  await completeSelfCreate(raw, ctx, reason, communityId);
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
  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: interaction.guildId,
  });
  const check = canUserCreateTicket(communityId, interaction.user.id);
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

  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: interaction.guildId,
  });
  const check = canUserCreateTicket(communityId, interaction.user.id);
  if (!check.ok) {
    await replyEphemeral(interaction, {
      content: formatRateLimitMessage(check),
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await completeSelfCreate(interaction, ctx, reason, communityId);
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [ctx]
 */
async function handleFor(commandCtx, ctx) {
  const target = commandCtx.options.getUser("user", true);
  const reason = commandCtx.options.getString("reason");

  if (target.bot) {
    await commandCtx.reply({
      content: "Cannot open a ticket for a bot.",
      sensitive: true,
    });
    return;
  }

  // Same Discord-only rationale as handleCreate (roadmap
  // § What stays Discord-only): opening the ticket needs a discord.js Guild;
  // the OutboundClient createChannel cutover is PR 7.
  const raw = commandCtx.rawInteraction;
  if (!raw) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }

  await commandCtx.defer({ sensitive: true });

  try {
    const communityId = commandCtx.communityId;
    const { ticket, channel, skippedStaffRoles } = await openTicketChannel({
      guild: raw.guild,
      // Helper pipeline takes the raw Discord client (PR 7 cutover).
      client: ctx?.client || raw.client,
      creatorUserId: target.id,
      reason,
      openedByStaffId: commandCtx.userId,
      communityId,
    });

    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
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

    // Best-effort DM via outbound (check ok; log + surface failures —
    // AGENTS.md § Error Handling 3/5). Guild display name through
    // outbound.fetchGuild (cache-first), same label as the old guild.name.
    const guild = await commandCtx.outbound.fetchGuild(communityId);
    const guildName = guild?.name || "this server";
    const dm = await commandCtx.outbound.sendDm(target.id, {
      content:
        `A support ticket was opened for you in **${guildName}**: ` +
        `https://discord.com/channels/${commandCtx.externalGuildId}/${channel.id}`,
    });
    let dmNote = "";
    if (!dm.ok) {
      console.warn(
        `[tickets] DM to ${target.id} for ticket ${formatTicketRef(ticket.ticket_number)} failed: ${dm.error}`,
      );
      dmNote = `\n_Could not DM the member: ${dm.error}_`;
    }

    let msg = `Ticket **${formatTicketRef(ticket.ticket_number)}** opened for <@${target.id}>: ${channel}`;
    if (skippedStaffRoles?.length) {
      msg += formatStaffRoleAccessNote(skippedStaffRoles);
    }
    await commandCtx.editReply({ content: msg + dmNote });
  } catch (err) {
    console.error("[tickets] for failed:", err);
    await commandCtx.editReply({
      content:
        err?.code === "BOT_PERMISSIONS" || err?.code === "CHANNEL_CREATE"
          ? err.message
          : `Failed to open ticket: ${formatChannelCreateError(err)}`,
      sensitive: true,
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
