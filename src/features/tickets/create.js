/**
 * Self-create, staff-for, panel button, and create modal.
 */
const { MessageFlags } = require("discord.js");
const {
  canUserCreateTicket,
  claimTicketCreateSlot,
  releaseTicketCreateSlot,
} = require("../../db");
const { replyEphemeral, safeErrorReply } = require("../../core/interaction");
const { recordSlashAudit } = require("../../core/auditTrail");
const { requireStaff } = require("../../core/permissions");
const { getDiscordOutbound } = require("../../platform/discord/outbound");
// Discord edge: (platform, instanceKey, snowflake) → integer community id,
// resolved once per entry point (roadmap/fluxer.md § Repository boundary).
const { ensureCommunity } = require("../../platform/community");
const { formatTicketRef } = require("../../core/theme");
const { buildMessageJumpUrl } = require("../../core/jumpUrl");
const { formatChannelCreateError, formatStaffRoleAccessNote } =
  require("./overwrites");
const { formatRateLimitMessage, buildCreateTicketModal, openTicketChannel } =
  require("./helpers");
const { MODAL_FIELD_REASON } = require("./constants");
const { showModalFromContext } = require("../../platform/context");

/**
 * Standard reply for Fluxer dispatches reaching Discord-only surfaces
 * (roadmap/fluxer.md § What stays Discord-only). PR 9 moved `ticket create`
 * onto the OutboundClient (roadmap § Outbound client); the `for` arm (and the
 * panel group) still need discord.js structures.
 */
const NOT_ON_FLUXER = "That command is not available on Fluxer yet.";


/**
 * @param {import("discord.js").ChatInputCommandInteraction|import("discord.js").ModalSubmitInteraction} interaction
 * @param {object} ctx
 * @param {string|null} reason
 * @param {number} communityId integer community id resolved at the entry point
 *   (openTicketChannel/audit take it from here).
 */
async function completeSelfCreate(interaction, ctx, reason, communityId) {
  // #420 (audit LT-3): take the ATOMIC create slot before any REST call.
  // The window pre-checks upstream are reads — two concurrent submits (a
  // double-click, slash + panel modal) both passed them and double-opened.
  // The claim is one SQL statement; the loser gets the rate-limit reply,
  // and a failed create hands the slot straight back.
  const claim = claimTicketCreateSlot(communityId, interaction.user.id);
  if (!claim.ok) {
    await interaction.editReply({ content: formatRateLimitMessage(claim) });
    return;
  }
  try {
    const { ticket, channel, skippedStaffRoles } = await openTicketChannel({
      guild: interaction.guild,
      // PR 7: the raw Discord client from the supervisor (raw interactions
      // always carry .client; the fallback keeps that path identical).
      client: ctx?.supervisor?.discord || interaction.client,
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
    // Failed create → hand the claimed slot back immediately: the user never
    // got a ticket and must not pay a window they did not use (a SUCCESSFUL
    // create keeps the slot; the real row guards the re-entry from then on).
    releaseTicketCreateSlot(communityId, interaction.user.id, claim.stamp);
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

  // Discord contexts carry the raw interaction and run the discord.js pipeline.
  const raw = commandCtx.rawInteraction;
  if (raw) {
    await commandCtx.defer({ sensitive: true });
    // Helpers keep their (interaction, ctx) signatures until PR 7 — pass the
    // raw interaction; completeSelfCreate edits the deferred reply we just made.
    await completeSelfCreate(raw, ctx, reason, communityId);
    return;
  }

  // Fluxer arm (PR 9, roadmap § Outbound client / PR 9): ticket channels are
  // OutboundClient channels now — resolve the live connection through the
  // supervisor. No connection is a specific cause the user can act on
  // (AGENTS.md rule 3), never the generic not-available line.
  let outbound = null;
  try {
    outbound = ctx?.supervisor?.clientForCommunity?.(communityId) ?? null;
  } catch (err) {
    console.error(
      `[tickets] clientForCommunity(${communityId}) failed: ${err?.message || err}`,
    );
  }
  if (!outbound) {
    await commandCtx.reply({
      content:
        "This Fluxer community has no live bot connection — the command cannot run.",
      sensitive: false,
    });
    return;
  }

  // #420 (audit LT-3): the ATOMIC create slot — same gate as the Discord arm's
  // completeSelfCreate. Refusal is the rate-limit sentence; a failed create
  // below hands the slot back.
  const claim = claimTicketCreateSlot(communityId, commandCtx.userId);
  if (!claim.ok) {
    await commandCtx.reply({
      content: formatRateLimitMessage(claim),
      sensitive: true,
    });
    return;
  }

  // Sensitive create → K2 DM (mirrors the Discord ephemeral reply).
  await commandCtx.defer({ sensitive: true });
  try {
    const { ticket, channel, skippedStaffRoles } = await openTicketChannel({
      outbound,
      communityId,
      creatorUserId: commandCtx.userId,
      reason,
      // Public self-create (spec's text path: !ticket create reason "text").
      // Mirrors the Discord completeSelfCreate arm, which passes null — the
      // creator gets MEMBER access, not staff access, and the open notice is
      // "…staff will be with you shortly." (PR 9 review: the bundle's
      // ctx.userId pin was wrong; Agent A flagged it.)
      openedByStaffId: null,
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
        reason: reason ?? null,
      },
    });

    let msg = `Ticket **${formatTicketRef(ticket.ticket_number)}** opened: <#${channel.id}>`;
    if (skippedStaffRoles?.length) {
      msg += formatStaffRoleAccessNote(skippedStaffRoles);
    }
    await commandCtx.reply({ content: msg });
  } catch (err) {
    // The cause IS the reply (elevated_disabled carries the K8 gate's own
    // reason verbatim — AGENTS.md rule 3, no generic strings).
    releaseTicketCreateSlot(communityId, commandCtx.userId, claim.stamp);
    console.error("[tickets] fluxer create failed:", err?.message || err);
    await commandCtx.reply({ content: err?.message || String(err) });
  }
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
/**
 * Shared staff proxy-ticket pipeline (#794): runs AFTER the caller deferred.
 * Both the `/ticket for` chat-input arm (handleFor) and the "Open ticket for
 * user" Apps-menu arm (handleOpenForUserMenu) run this exact core — same
 * ticket row, overwrites, audit shape, target DM, and success/failure copy.
 *
 * Arm-agnostic by construction: everything Discord- or Fluxer-specific
 * arrives through the params (guild/client only matter to openTicketChannel's
 * Discord branch; platform/externalGuildId/outbound drive the DM + jump URL).
 *
 * @param {object} params
 * @param {object} params.guild discord.js Guild (Discord branch of openTicketChannel)
 * @param {object} params.client Discord client (openTicketChannel's own client)
 * @param {number} params.communityId integer community key resolved at the edge
 * @param {string} params.actorUserId staff user id (audits + opened_by_staff_id)
 * @param {{ id: string, bot?: boolean }} params.target member the ticket is opened for
 * @param {string|null} params.reason optional reason (menus carry none)
 * @param {string} params.platform "discord" on both arms today (the Fluxer
 *   chat arm never reaches this core — handleFor answers NOT_ON_FLUXER first)
 * @param {string} params.externalGuildId guild snowflake for the jump URL
 * @param {object} params.outbound OutboundClient (fetchGuild/sendDm/webappBaseUrl)
 * @param {(payload: { content: string, sensitive?: boolean }) => Promise<void>} params.editReply
 *   reply edit on the calling arm — visibility was already pinned by the
 *   caller's ephemeral defer, so `sensitive` here is informational.
 */
async function openForCore(params) {
  const {
    guild,
    client,
    communityId,
    actorUserId,
    target,
    reason,
    platform,
    externalGuildId,
    outbound,
    editReply,
  } = params;

  try {
    const { ticket, channel, skippedStaffRoles } = await openTicketChannel({
      guild,
      client,
      creatorUserId: target.id,
      reason,
      openedByStaffId: actorUserId,
      communityId,
    });

    recordSlashAudit({
      communityId,
      actorUserId,
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

    // Best-effort DM via outbound (log + surface failures — AGENTS.md rule
    // 3/5). Guild display name through outbound.fetchGuild (cache-first),
    // same label as the old guild.name.
    const guildInfo = await outbound.fetchGuild(communityId);
    const guildName = guildInfo?.name || "this server";
    // Ticket link is platform-aware (gap #2): the discord.com URL was a
    // dead link on Fluxer (and auto-embedded a Discord marketing card).
    // No usable base (null) → the DM names the channel without a link.
    const ticketLink = buildMessageJumpUrl({
      platform,
      guildId: externalGuildId,
      channelId: channel.id,
      webappBaseUrl: outbound.webappBaseUrl,
    });
    const dm = await outbound.sendDm(target.id, {
      content:
        `A support ticket was opened for you in **${guildName}**` +
        (ticketLink ? `: ${ticketLink}` : " (see the ticket channel listed in the server)."),
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
    await editReply({ content: msg + dmNote });
  } catch (err) {
    console.error("[tickets] for failed:", err);
    await editReply({
      content:
        err?.code === "BOT_PERMISSIONS" || err?.code === "CHANNEL_CREATE"
          ? err.message
          : `Failed to open ticket: ${formatChannelCreateError(err)}`,
      sensitive: true,
    });
  }
}

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

  // Staff-for stays legacy on the real interaction (roadmap § What stays
  // Discord-only): opening a ticket FOR a member needs discord.js option
  // resolution (getUser) and a Discord transcript link in the DM. The public
  // `create` arm runs on Fluxer via the OutboundClient (PR 9).
  const raw = commandCtx.rawInteraction;
  if (!raw) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }

  await commandCtx.defer({ sensitive: true });

  await openForCore({
    guild: raw.guild,
    // Helper pipeline takes the raw Discord client (PR 7 cutover: from the
    // supervisor; raw interactions always carry .client as fallback).
    client: ctx?.supervisor?.discord || raw.client,
    communityId: commandCtx.communityId,
    actorUserId: commandCtx.userId,
    target,
    reason,
    platform: commandCtx.platform,
    externalGuildId: commandCtx.externalGuildId,
    outbound: commandCtx.outbound,
    editReply: (payload) => commandCtx.editReply(payload),
  });
}

/**
 * "Open ticket for user" USER context menu (#794) — right-click a member →
 * Apps → the context-menu twin of `/ticket for`: staff open a proxy ticket
 * for the member without typing the subcommand. Gate order mirrors the slash
 * arm as it runs through dispatch (index.js): requireStaff FIRST, then the
 * bot-target refusal; a self-target stays allowed exactly like the slash arm
 * (handleFor has no self gate). The menu carries no options, so `reason` is
 * null. Discord-only (roadmap § What stays Discord-only): the #750 Fluxer
 * tree filter skips non-CHAT_INPUT commands — explicit no-parity.
 *
 * @param {import("discord.js").UserContextMenuCommandInteraction} interaction
 * @param {object} [ctx] router context (supervisor resolves the Discord client)
 */
async function handleOpenForUserMenu(interaction, ctx) {
  try {
    if (!(await requireStaff(interaction))) return;

    // Literal registered target-option name "user" (lowercase) — same
    // verification as the #745 report arms (UserContextMenuCommandInteraction
    // → options.getUser('user')).
    const target = interaction.options?.getUser?.("user") ?? null;
    if (!target) {
      await replyEphemeral(
        interaction,
        "Could not resolve the member — they may have left the server. Nothing was opened.",
      );
      return;
    }

    // Mirrors handleFor's bot gate copy verbatim.
    if (target.bot) {
      await replyEphemeral(interaction, "Cannot open a ticket for a bot.");
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const externalGuildId = String(interaction.guildId);
    const communityId = ensureCommunity({
      platform: "discord",
      instanceKey: "discord",
      externalGuildId,
    });
    const client = ctx?.supervisor?.discord || interaction.client;
    await openForCore({
      guild: interaction.guild,
      client,
      communityId,
      actorUserId: interaction.user?.id != null ? String(interaction.user.id) : "",
      target,
      reason: null,
      platform: "discord",
      externalGuildId,
      outbound: getDiscordOutbound(client),
      // Content-only on purpose: the ephemeral defer above already pins
      // visibility, and toDiscordPayload is off-limits to handlers
      // (src/platform/discord/context.js). Dropping the core's
      // informational `sensitive` flag keeps the raw payload Discord-clean.
      editReply: ({ content }) => interaction.editReply({ content }),
    });
  } catch (err) {
    console.error(
      "[tickets] open-for menu failed:",
      `guild=${interaction?.guildId ?? "?"} user=${interaction?.user?.id ?? "?"} cmd=${interaction?.commandName ?? "?"}`,
      err?.message || err,
    );
    await safeErrorReply(interaction);
  }
}

module.exports = {
  completeSelfCreate,
  handleCreate,
  handleOpenTicketButton,
  handleCreateTicketModal,
  handleFor,
  handleOpenForUserMenu,
};
