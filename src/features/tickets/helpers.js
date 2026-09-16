/**
 * Ticket builders, channel gates, and channel+DB create.
 */
const {
  PermissionFlagsBits,
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


function formatRateLimitMessage(check) {
  const mins = Math.ceil(check.retryAfterMs / 60000);
  return (
    `You're creating tickets too quickly. Try again in about **${mins}** minute(s) ` +
    `(rate limit: ${check.minutes} min between self-creates).`
  );
}

/**
 * Build the persistent panel button row.
 * @returns {ActionRowBuilder}
 */
function buildOpenTicketButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BTN_OPEN)
      .setLabel("Open a ticket")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("🎫"),
  );
}

/**
 * Build the create-ticket modal (reason / description).
 * @returns {ModalBuilder}
 */
function buildCreateTicketModal() {
  const reasonInput = new TextInputBuilder()
    .setCustomId(MODAL_FIELD_REASON)
    .setLabel("How can we help?")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(MAX_TICKET_REASON)
    .setPlaceholder("Describe your issue (optional but recommended)");

  return new ModalBuilder()
    .setCustomId(MODAL_CREATE)
    .setTitle("Open a support ticket")
    .addComponents(new ActionRowBuilder().addComponents(reasonInput));
}

/**
 * Build panel embed for public ticket entry.
 * @param {string} title
 * @param {string} description
 * @returns {EmbedBuilder}
 */
function buildPanelEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(COLOR_INFO)
    .setTitle(title)
    .setDescription(description)
    .setFooter({
      text: "Same rate limit as /ticket create · Staff will join the private channel",
    });
}

/**
 * Compose staff-note body from a closed ticket + optional free text.
 * @param {object} ticket
 * @param {string|null|undefined} closeReason
 * @param {string|null|undefined} body
 * @returns {string}
 */
function buildTicketStaffNoteContent(ticket, closeReason, body) {
  const parts = [`Ticket ${formatTicketRef(ticket.ticket_number)} closed`];
  if (closeReason && String(closeReason).trim()) {
    parts.push(`Close reason: ${String(closeReason).trim()}`);
  }
  if (Number(ticket.is_sensitive) === 1) {
    parts.push("Sensitive ticket (no content archive).");
  }
  const free = body != null ? String(body).trim() : "";
  if (free) {
    parts.push("");
    parts.push(free);
  }
  let text = parts.join("\n");
  if (text.length > MAX_NOTE_CONTENT) {
    text = text.slice(0, MAX_NOTE_CONTENT);
  }
  return text;
}

/**
 * Create a staff note on the ticket requester (if human subject).
 * @param {object} opts
 * @returns {{ ok: true, note: object } | { ok: false, error: string }}
 */
function attachStaffNoteFromTicket(opts) {
  const { ticket, authorId, closeReason, body } = opts;
  if (!ticket?.creator_user_id) {
    return { ok: false, error: "Ticket has no requester to note." };
  }
  const content = buildTicketStaffNoteContent(ticket, closeReason, body);
  if (!content.trim()) {
    return { ok: false, error: "Staff note content cannot be empty." };
  }
  try {
    const note = createStaffNote({
      guildId: ticket.guild_id,
      userId: ticket.creator_user_id,
      authorId,
      content,
    });
    return { ok: true, note };
  } catch (err) {
    if (err?.code === "INVALID_CONTENT") {
      return { ok: false, error: err.message };
    }
    console.error("[tickets] staff note from close failed:", err);
    return { ok: false, error: "Failed to save staff note (database error)." };
  }
}

/**
 * Button on post-close ephemeral reply.
 * @param {number|string} ticketId
 * @returns {ActionRowBuilder}
 */
function buildAddStaffNoteButtonRow(ticketId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BTN_STAFF_NOTE_PREFIX}${ticketId}`)
      .setLabel("Add staff note")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("📝"),
  );
}

/**
 * Modal for free-text staff note after close.
 * @param {number|string} ticketId
 * @param {number} [ticketNumber]
 * @returns {ModalBuilder}
 */
function buildTicketStaffNoteModal(ticketId, ticketNumber) {
  const input = new TextInputBuilder()
    .setCustomId(MODAL_FIELD_STAFF_NOTE)
    .setLabel("Private staff note")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(MAX_NOTE_CONTENT)
    .setPlaceholder(
      "Context for staff about this requester (never shown to them)",
    );

  const title =
    ticketNumber != null
      ? `Note · ticket #${ticketNumber}`.slice(0, 45)
      : "Staff note from ticket";

  return new ModalBuilder()
    .setCustomId(`${MODAL_STAFF_NOTE_PREFIX}${ticketId}`)
    .setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(input));
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} ctx
 * @returns {Promise<import("discord.js").GuildBasedChannel|null>}
 */
async function resolveChannel(interaction, ctx) {
  if (interaction.channel) return interaction.channel;
  const id = interaction.channelId;
  const client = ctx?.client || interaction.client;
  const fromGuild = interaction.guild?.channels?.cache?.get?.(id);
  if (fromGuild) return fromGuild;
  try {
    return (await client?.channels?.fetch?.(id)) || null;
  } catch {
    return null;
  }
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} ctx
 * @returns {Promise<{ ticket: object, channel: object }|null>}
 */
async function requireOpenTicketChannel(interaction, ctx) {
  const channel = await resolveChannel(interaction, ctx);
  const ticket = getTicketByChannel(interaction.channelId);
  if (!ticket || ticket.status !== "open") {
    await replyEphemeral(interaction, {
      content: "This command only works inside an **open ticket** channel.",
    });
    return null;
  }
  return { ticket, channel };
}

/**
 * Live ticket channel still present (open or soft-closed awaiting archive).
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} ctx
 * @param {object} [opts]
 * @param {"any"|"open"|"closed"} [opts.status="any"]
 * @returns {Promise<{ ticket: object, channel: object }|null>}
 */
async function requireLiveTicketChannel(interaction, ctx, opts = {}) {
  const statusWant = opts.status || "any";
  const channel = await resolveChannel(interaction, ctx);
  const ticket = getTicketByChannel(interaction.channelId);
  if (!ticket || !ticket.channel_id) {
    await replyEphemeral(interaction, {
      content: "This command only works inside a **ticket** channel.",
    });
    return null;
  }
  if (statusWant === "open" && ticket.status !== "open") {
    await replyEphemeral(interaction, {
      content: "This command only works inside an **open** ticket channel.",
    });
    return null;
  }
  if (statusWant === "closed" && ticket.status !== "closed") {
    await replyEphemeral(interaction, {
      content:
        "This ticket is still **open**. Run `/ticket close` first, then `/ticket archive`.",
    });
    return null;
  }
  if (Number(ticket.archived) === 1) {
    await replyEphemeral(interaction, {
      content: "This ticket is already archived.",
    });
    return null;
  }
  return { ticket, channel };
}

/**
 * Resolve the bot's GuildMember (for permission / hierarchy checks).
 * @param {import("discord.js").Guild} guild
 * @param {import("discord.js").Client} client
 * @returns {Promise<import("discord.js").GuildMember|null>}
 */
async function resolveBotMember(guild, client) {
  const botId = client.user?.id;
  if (!botId) return null;
  try {
    if (guild.members?.me) return guild.members.me;
    const cached = guild.members?.cache?.get?.(botId);
    if (cached) return cached;
    return (await guild.members.fetch(botId)) || null;
  } catch {
    return null;
  }
}

/**
 * Create Discord channel + DB row.
 * @param {object} opts
 */
async function openTicketChannel(opts) {
  const { guild, client, creatorUserId, reason, openedByStaffId } = opts;

  const settings = getTicketSettings(guild.id);
  const botUserId = client.user?.id;
  if (!botUserId) {
    throw new Error("Bot user not ready");
  }

  const botMember = await resolveBotMember(guild, client);
  const canCreate = assertBotCanCreateTickets(
    guild,
    botMember,
    settings.ticket_category_id,
  );
  if (!canCreate.ok) {
    const err = new Error(canCreate.error);
    err.code = "BOT_PERMISSIONS";
    throw err;
  }

  const { roleIds: staffRoleIds, skipped } = await getManageableStaffRoleIds(
    guild,
    botMember,
  );
  if (skipped.length) {
    console.warn(
      `[tickets] Skipping ${skipped.length} staff role overwrite(s):`,
      describeSkippedStaffRoles(skipped),
    );
  }

  const { nextTicketNumber } = require("../../db/repositories/tickets");
  const ticketNumber = nextTicketNumber(guild.id);
  const channelName = `ticket-${ticketNumber}`.slice(0, 100);

  // Minimal safe overwrites at create time (no ManageChannels on staff).
  const baseOverwrites = [
    {
      id: guild.id,
      deny: PermissionFlagsBits.ViewChannel,
    },
    {
      id: botUserId,
      allow: BOT_ALLOW,
    },
    {
      id: creatorUserId,
      allow: MEMBER_ALLOW,
      deny: MEMBER_DENY,
    },
  ];
  // Staff who open on behalf of a member get named (user) access immediately —
  // required for junior staff / admins without a senior role overwrite.
  if (openedByStaffId && openedByStaffId !== creatorUserId) {
    baseOverwrites.push({
      id: openedByStaffId,
      allow: STAFF_ALLOW,
    });
  } else if (openedByStaffId && openedByStaffId === creatorUserId) {
    // Staff opened for themselves: still grant staff-level access on their user overwrite
    baseOverwrites[baseOverwrites.length - 1] = {
      id: creatorUserId,
      allow: STAFF_ALLOW,
    };
  }
  for (const roleId of staffRoleIds) {
    baseOverwrites.push({
      id: roleId,
      allow: STAFF_ALLOW,
    });
  }

  const createOpts = {
    name: channelName,
    type: ChannelType.GuildText,
    reason: `Ticket ${ticketNumber} for ${creatorUserId}`,
    permissionOverwrites: baseOverwrites,
  };
  if (settings.ticket_category_id) {
    createOpts.parent = settings.ticket_category_id;
  }

  let channel;
  try {
    channel = await guild.channels.create(createOpts);
  } catch (err) {
    const wrapped = new Error(formatChannelCreateError(err));
    wrapped.code = "CHANNEL_CREATE";
    wrapped.cause = err;
    throw wrapped;
  }

  let ticket;
  try {
    ticket = createTicket({
      guildId: guild.id,
      creatorUserId,
      channelId: channel.id,
      reason: reason || null,
      openedByStaffId: openedByStaffId || null,
    });
  } catch (err) {
    try {
      await channel.delete("Ticket DB insert failed");
    } catch {
      // ignore
    }
    throw err;
  }

  const expectedName = `ticket-${ticket.ticket_number}`.slice(0, 100);
  if (channel.name !== expectedName && typeof channel.setName === "function") {
    try {
      await channel.setName(expectedName);
    } catch {
      // ignore rename failure
    }
  }

  try {
    await applyTicketOverwrites(channel, {
      guildId: guild.id,
      everyoneId: guild.id,
      botUserId,
      ticket,
      sensitive: false,
      guild,
      botMember,
      staffRoleIds,
    });
  } catch (err) {
    console.warn("[tickets] re-apply overwrites failed:", err?.message || err);
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR_OPEN)
    .setTitle(`Ticket ${formatTicketRef(ticket.ticket_number)}`)
    .setDescription(
      reason ? String(reason).slice(0, 4000) : "_No reason provided._",
    )
    .addFields(
      { name: "Requester", value: `<@${creatorUserId}>`, inline: true },
      {
        name: "Opened by",
        value: openedByStaffId
          ? `<@${openedByStaffId}> (staff)`
          : `<@${creatorUserId}>`,
        inline: true,
      },
      {
        name: "Created",
        value: tsFull(ticket.created_at),
        inline: true,
      },
    )
    .setFooter({
      text: "Staff: /ticket claim · close · sensitive · adduser",
    });

  await channel.send({
    content: openedByStaffId
      ? `Opened for <@${creatorUserId}> by <@${openedByStaffId}>.`
      : `<@${creatorUserId}> — staff will be with you shortly.`,
    embeds: [embed],
  });

  return { ticket, channel, skippedStaffRoles: skipped };
}

module.exports = {
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
};
