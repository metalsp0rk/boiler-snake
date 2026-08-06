/**
 * Help ticket system — private support channels with sensitive mode and archives.
 *
 * Slash: /ticket create|for|close|claim|transfer|adduser|removeuser|
 *        addstaff|removestaff|sensitive|unsensitive|list|info|
 *        setcategory|setarchive|setratelimit|settings|panel
 * Buttons: tk:open → modal for description → same pipeline as /ticket create
 *          tk:sn:<ticketId> → modal to attach a staff note after close
 * Modals:  tk:create · tk:snm:<ticketId>
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  ChannelType,
  Events,
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
  listOpenTickets,
  markTicketClosedByChannelDelete,
  updateGuildSettings,
  listStaffRoles,
  listSeniorStaffRoles,
  normalizeStaffLevel,
  createStaffNote,
  MAX_NOTE_CONTENT,
} = require("../../db");
const {
  requireStaff,
  requireAdmin,
  isStaff,
  isAdminOrMod,
} = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");
const {
  applyTicketOverwrites,
  getManageableStaffRoleIds,
  assertBotCanCreateTickets,
  formatChannelCreateError,
  MEMBER_ALLOW,
  MEMBER_DENY,
  STAFF_ALLOW,
  BOT_ALLOW,
} = require("./overwrites");
const { softCloseTicket, archiveTicketPipeline } = require("./close");
const { startTicketHttpServer } = require("./httpServer");

const COLOR_OPEN = 0x57f287;
const COLOR_INFO = 0x5865f2;
const COLOR_SENSITIVE = 0xe74c3c;

/** Button customId: open ticket from a panel */
const BTN_OPEN = "tk:open";
/** Modal customId: submit ticket description after panel button */
const MODAL_CREATE = "tk:create";
/** Text input customId inside the create modal */
const MODAL_FIELD_REASON = "reason";

/** Button prefix: attach staff note after close — `tk:sn:<ticketId>` */
const BTN_STAFF_NOTE_PREFIX = "tk:sn:";
/** Modal prefix: staff note body after close — `tk:snm:<ticketId>` */
const MODAL_STAFF_NOTE_PREFIX = "tk:snm:";
/** Text input customId inside the post-close staff note modal */
const MODAL_FIELD_STAFF_NOTE = "staff_note";

const DEFAULT_PANEL_TITLE = "Support Tickets";
const DEFAULT_PANEL_DESCRIPTION =
  "Click **Open a ticket** below to start a private conversation with staff. " +
  "You'll be asked to describe what you need help with.";

const commands = [
  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription(
      "Open and manage support tickets; staff lifecycle and guild ticket config."
    )
    // create is public; other ops gated in handlers
    .addSubcommand((sc) =>
      sc
        .setName("create")
        .setDescription("Open a support ticket for yourself.")
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("What do you need help with?")
            .setRequired(false)
            .setMaxLength(MAX_TICKET_REASON)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("for")
        .setDescription("Staff: open a ticket for a member.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member to open a ticket for")
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("Why this ticket is being opened")
            .setRequired(false)
            .setMaxLength(MAX_TICKET_REASON)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("close")
        .setDescription(
          "Close this ticket: remove non-staff members; keep channel for staff."
        )
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("Close reason (shown to requester + on archive)")
            .setRequired(false)
            .setMaxLength(MAX_TICKET_REASON)
        )
        .addStringOption((opt) =>
          opt
            .setName("staff_note")
            .setDescription(
              "Optional private staff note on the requester (never shown to them)"
            )
            .setRequired(false)
            .setMaxLength(MAX_NOTE_CONTENT)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("archive")
        .setDescription(
          "Archive a closed ticket: transcript (if not sensitive), then delete channel."
        )
    )
    .addSubcommand((sc) =>
      sc.setName("claim").setDescription("Claim this ticket as staff owner.")
    )
    .addSubcommand((sc) =>
      sc
        .setName("transfer")
        .setDescription("Transfer staff ownership of this ticket.")
        .addUserOption((opt) =>
          opt
            .setName("staff")
            .setDescription("New staff owner")
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("adduser")
        .setDescription("Add a member participant to this ticket.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member to add")
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("removeuser")
        .setDescription("Remove a member participant from this ticket.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member to remove")
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("addstaff")
        .setDescription("Allow-list a staff user on this ticket (named access).")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Staff user to add")
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("removestaff")
        .setDescription("Remove a named staff allow-list entry.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Staff user to remove")
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("sensitive")
        .setDescription(
          "Lock this ticket to owner + named staff + members only."
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("unsensitive")
        .setDescription("Restore normal staff-role visibility on this ticket.")
    )
    .addSubcommand((sc) =>
      sc
        .setName("list")
        .setDescription("List open tickets (staff).")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Filter by member")
            .setRequired(false)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("info")
        .setDescription("Show details for this ticket channel.")
    )
    .addSubcommand((sc) =>
      sc
        .setName("setcategory")
        .setDescription("Set the category for new ticket channels (admin).")
        .addChannelOption((opt) =>
          opt
            .setName("category")
            .setDescription("Category channel")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("setarchive")
        .setDescription(
          "Set the staff channel for close summaries / transcripts (admin)."
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Text channel for archive posts")
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement
            )
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("setratelimit")
        .setDescription(
          "Min minutes between member self-creates (0 = off; default 60)."
        )
        .addIntegerOption((opt) =>
          opt
            .setName("minutes")
            .setDescription("Cooldown limit minutes (0 disables)")
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(10080)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("panel")
        .setDescription(
          "Post an Open Ticket panel (button → modal) in a channel (admin)."
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel to post the panel in (default: here)")
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement
            )
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("title")
            .setDescription("Panel embed title")
            .setRequired(false)
            .setMaxLength(256)
        )
        .addStringOption((opt) =>
          opt
            .setName("description")
            .setDescription("Panel embed description")
            .setRequired(false)
            .setMaxLength(2000)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("settings")
        .setDescription("Show ticket configuration for this server.")
    ),
];

/**
 * @param {number} n
 * @returns {string}
 */
function formatTicketRef(n) {
  return `#${n}`;
}

/**
 * Rate-limit message for self-create (slash or panel modal).
 * @param {{ retryAfterMs: number, minutes: number }} check
 * @returns {string}
 */
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
      .setEmoji("🎫")
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
    .addComponents(
      new ActionRowBuilder().addComponents(reasonInput)
    );
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
  const parts = [
    `Ticket ${formatTicketRef(ticket.ticket_number)} closed`,
  ];
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
      .setEmoji("📝")
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
      "Context for staff about this requester (never shown to them)"
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
    await interaction.reply({
      content:
        "This command only works inside an **open ticket** channel.",
      flags: MessageFlags.Ephemeral,
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
    await interaction.reply({
      content: "This command only works inside a **ticket** channel.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  if (statusWant === "open" && ticket.status !== "open") {
    await interaction.reply({
      content: "This command only works inside an **open** ticket channel.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  if (statusWant === "closed" && ticket.status !== "closed") {
    await interaction.reply({
      content:
        "This ticket is still **open**. Run `/ticket close` first, then `/ticket archive`.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  if (Number(ticket.archived) === 1) {
    await interaction.reply({
      content: "This ticket is already archived.",
      flags: MessageFlags.Ephemeral,
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
  const {
    guild,
    client,
    creatorUserId,
    reason,
    openedByStaffId,
  } = opts;

  const settings = getTicketSettings(guild.id);
  const botUserId = client.user?.id;
  if (!botUserId) {
    throw new Error("Bot user not ready");
  }

  const botMember = await resolveBotMember(guild, client);
  const canCreate = assertBotCanCreateTickets(
    guild,
    botMember,
    settings.ticket_category_id
  );
  if (!canCreate.ok) {
    const err = new Error(canCreate.error);
    err.code = "BOT_PERMISSIONS";
    throw err;
  }

  const { roleIds: staffRoleIds, skipped } = getManageableStaffRoleIds(
    guild,
    botMember
  );
  if (skipped.length) {
    console.warn(
      `[tickets] Skipping ${skipped.length} staff role overwrite(s):`,
      skipped.map((s) => `${s.id} (${s.reason})`).join("; ")
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
      reason
        ? String(reason).slice(0, 4000)
        : "_No reason provided._"
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
        value: `<t:${Math.floor(ticket.created_at / 1000)}:F>`,
        inline: true,
      }
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

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} ctx
 */
async function handleTicket(interaction, ctx) {
  const sub = interaction.options.getSubcommand();

  // Public
  if (sub === "create") return handleCreate(interaction, ctx);
  if (sub === "settings") return handleSettings(interaction);

  // Admin config
  if (
    sub === "setcategory" ||
    sub === "setarchive" ||
    sub === "setratelimit" ||
    sub === "panel"
  ) {
    if (!(await requireAdmin(interaction))) return;
    if (sub === "setcategory") return handleSetCategory(interaction, ctx);
    if (sub === "setarchive") return handleSetArchive(interaction, ctx);
    if (sub === "setratelimit") return handleSetRateLimit(interaction, ctx);
    if (sub === "panel") return handlePanel(interaction, ctx);
  }

  // Staff
  if (!(await requireStaff(interaction))) return;

  if (sub === "for") return handleFor(interaction, ctx);
  if (sub === "list") return handleList(interaction);
  if (sub === "close") return handleClose(interaction, ctx);
  if (sub === "archive") return handleArchive(interaction, ctx);
  if (sub === "claim") return handleClaim(interaction, ctx);
  if (sub === "transfer") return handleTransfer(interaction, ctx);
  if (sub === "adduser") return handleAddUser(interaction, ctx);
  if (sub === "removeuser") return handleRemoveUser(interaction, ctx);
  if (sub === "addstaff") return handleAddStaff(interaction, ctx);
  if (sub === "removestaff") return handleRemoveStaff(interaction, ctx);
  if (sub === "sensitive") return handleSensitive(interaction, ctx);
  if (sub === "unsensitive") return handleUnsensitive(interaction, ctx);
  if (sub === "info") return handleInfo(interaction, ctx);

  await interaction.reply({
    content: `Unknown subcommand: \`${sub}\``,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Shared self-create path for /ticket create and panel modal.
 * Caller must already have deferred the interaction (ephemeral).
 * @param {import("discord.js").Interaction} interaction
 * @param {object} ctx
 * @param {string|null} reason
 */
async function completeSelfCreate(interaction, ctx, reason) {
  try {
    const { ticket, channel, skippedStaffRoles } = await openTicketChannel({
      guild: interaction.guild,
      client: ctx.client || interaction.client,
      creatorUserId: interaction.user.id,
      reason,
      openedByStaffId: null,
    });

    let msg = `Ticket **${formatTicketRef(ticket.ticket_number)}** opened: ${channel}`;
    if (skippedStaffRoles?.length) {
      msg +=
        `\n\n_Note: ${skippedStaffRoles.length} staff role(s) could not get channel access ` +
        `(bot role must be higher than staff roles, and roles must still exist)._`;
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
    await interaction.reply({
      content: formatRateLimitMessage(check),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await completeSelfCreate(interaction, ctx, reason);
}

/**
 * Admin: post a public panel with an Open ticket button.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} ctx
 */
async function handlePanel(interaction, ctx) {
  const targetChannel =
    interaction.options.getChannel("channel") ||
    (await resolveChannel(interaction, ctx));
  const title =
    interaction.options.getString("title")?.trim() || DEFAULT_PANEL_TITLE;
  const description =
    interaction.options.getString("description")?.trim() ||
    DEFAULT_PANEL_DESCRIPTION;

  if (!targetChannel || typeof targetChannel.send !== "function") {
    await interaction.reply({
      content:
        "Could not resolve a text channel to post the panel. Pass `channel:` or run this in a text channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const type = targetChannel.type;
  const okType =
    type === ChannelType.GuildText ||
    type === ChannelType.GuildAnnouncement ||
    type == null; // mocks may omit type
  if (!okType) {
    await interaction.reply({
      content: "Panel must be posted in a text or announcement channel.",
      flags: MessageFlags.Ephemeral,
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

    await logConfigChange(
      ctx?.client || interaction.client,
      interaction.guildId,
      {
        title: "Ticket panel posted",
        command: "/ticket panel",
        actor: interaction.user,
        changes: [
          `Channel: <#${targetChannel.id}>`,
          `Message: \`${message.id}\``,
          `Title: ${title}`,
        ],
      }
    ).catch(() => {});

    const jump =
      interaction.guildId && targetChannel.id && message.id
        ? `https://discord.com/channels/${interaction.guildId}/${targetChannel.id}/${message.id}`
        : null;

    await interaction.editReply({
      content:
        `Posted ticket panel in <#${targetChannel.id}>.` +
        (jump ? `\n[Jump to panel](${jump})` : ""),
    });
  } catch (err) {
    console.error("[tickets] panel failed:", err);
    await interaction.editReply({
      content: `Failed to post panel: ${err?.message || "unknown error"}`,
    });
  }
}

/**
 * Panel button → show description modal (public).
 * @param {import("discord.js").ButtonInteraction} interaction
 * @param {object} _ctx
 */
async function handleOpenTicketButton(interaction, _ctx) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "Tickets can only be opened in a server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.user?.bot) {
    await interaction.reply({
      content: "Bots cannot open tickets.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Early rate-limit feedback so users don't fill the modal for nothing.
  // Re-checked on modal submit (state can change while modal is open).
  const check = canUserCreateTicket(interaction.guildId, interaction.user.id);
  if (!check.ok) {
    await interaction.reply({
      content: formatRateLimitMessage(check),
      flags: MessageFlags.Ephemeral,
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
    await interaction.reply({
      content: "Tickets can only be opened in a server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.user?.bot) {
    await interaction.reply({
      content: "Bots cannot open tickets.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let reason = null;
  try {
    const raw = interaction.fields.getTextInputValue(MODAL_FIELD_REASON);
    reason = raw != null && String(raw).trim() !== "" ? String(raw).trim() : null;
  } catch {
    reason = null;
  }

  const check = canUserCreateTicket(interaction.guildId, interaction.user.id);
  if (!check.ok) {
    await interaction.reply({
      content: formatRateLimitMessage(check),
      flags: MessageFlags.Ephemeral,
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
    await interaction.reply({
      content: "Cannot open a ticket for a bot.",
      flags: MessageFlags.Ephemeral,
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
      msg +=
        `\n\n_Note: ${skippedStaffRoles.length} staff role(s) could not get channel access ` +
        `(bot role must be higher than staff roles, and roles must still exist)._`;
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
    await interaction.reply({
      content: "Invalid ticket reference on this button.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const ticket = getTicketById(ticketId);
  if (!ticket || ticket.guild_id !== interaction.guildId) {
    await interaction.reply({
      content: "That ticket was not found in this server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.showModal(
    buildTicketStaffNoteModal(ticket.id, ticket.ticket_number)
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
    await interaction.reply({
      content: "Invalid modal state (missing ticket).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const ticket = getTicketById(ticketId);
  if (!ticket || ticket.guild_id !== interaction.guildId) {
    await interaction.reply({
      content: "That ticket was not found in this server.",
      flags: MessageFlags.Ephemeral,
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
    await interaction.reply({
      content: noteResult.error,
      flags: MessageFlags.Ephemeral,
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
    }
  ).catch(() => {});

  await interaction.reply({
    content:
      `Staff note **N-${noteResult.note.note_number}** saved on ` +
      `<@${ticket.creator_user_id}> (private; never shown to the member).\n` +
      `View with \`/note info id:${noteResult.note.note_number}\`.`,
    flags: MessageFlags.Ephemeral,
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

  await interaction.reply({
    content: `You claimed ticket **${formatTicketRef(ticket.ticket_number)}**.`,
    flags: MessageFlags.Ephemeral,
  });
  try {
    await channel?.send?.(
      `<@${interaction.user.id}> claimed this ticket.`
    );
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
    await interaction.reply({
      content: "Cannot transfer to a bot.",
      flags: MessageFlags.Ephemeral,
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

  await interaction.reply({
    content: `Transferred ticket **${formatTicketRef(ticket.ticket_number)}** to <@${staff.id}>.`,
    flags: MessageFlags.Ephemeral,
  });
  try {
    await channel?.send?.(
      `Staff ownership transferred to <@${staff.id}> by <@${interaction.user.id}>.`
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
    await interaction.reply({
      content: "Cannot add a bot as a ticket member.",
      flags: MessageFlags.Ephemeral,
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

  await interaction.reply({
    content: added
      ? `Added <@${user.id}> to ticket **${formatTicketRef(ticket.ticket_number)}**.`
      : `<@${user.id}> is already a member of this ticket.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleRemoveUser(interaction, ctx) {
  const ctxTicket = await requireOpenTicketChannel(interaction, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;
  const user = interaction.options.getUser("user", true);

  const result = removeTicketMember(ticket.id, user.id);
  if (!result.ok) {
    await interaction.reply({
      content: result.error,
      flags: MessageFlags.Ephemeral,
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

  await interaction.reply({
    content: `Removed <@${user.id}> from ticket **${formatTicketRef(ticket.ticket_number)}**.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleAddStaff(interaction, ctx) {
  const ctxTicket = await requireOpenTicketChannel(interaction, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;
  const user = interaction.options.getUser("user", true);

  if (user.bot) {
    await interaction.reply({
      content: "Cannot add a bot as ticket staff.",
      flags: MessageFlags.Ephemeral,
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

  await interaction.reply({
    content: added
      ? `Added <@${user.id}> to the staff allow-list for **${formatTicketRef(ticket.ticket_number)}**.`
      : `<@${user.id}> is already on the staff allow-list.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleRemoveStaff(interaction, ctx) {
  const ctxTicket = await requireOpenTicketChannel(interaction, ctx);
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;
  const user = interaction.options.getUser("user", true);

  const result = removeTicketStaff(ticket.id, user.id);
  if (!result.ok) {
    await interaction.reply({
      content: result.error,
      flags: MessageFlags.Ephemeral,
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

  await interaction.reply({
    content: `Removed <@${user.id}> from the staff allow-list.`,
    flags: MessageFlags.Ephemeral,
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
    await interaction.reply({
      content:
        `Only the staff owner (<@${ticket.staff_owner_id}>) or a server admin can mark this ticket sensitive.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const ownerId =
    ticket.staff_owner_id || interaction.user.id; // auto-claim
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

  await interaction.reply({
    content:
      `Ticket **${formatTicketRef(ticket.ticket_number)}** is now **sensitive**. ` +
      `Only the owner, named staff, and members can see it. Close will **not** archive content.`,
    flags: MessageFlags.Ephemeral,
  });
  try {
    await channel?.send?.({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR_SENSITIVE)
          .setTitle("Ticket marked sensitive")
          .setDescription(
            `Visibility locked. Staff owner: <@${updated.staff_owner_id}>.`
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
    await interaction.reply({
      content: "You don’t have permission to use this.",
      flags: MessageFlags.Ephemeral,
    });
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

  await interaction.reply({
    content: `Ticket **${formatTicketRef(ticket.ticket_number)}** is no longer sensitive. Staff roles can see it again.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleList(interaction) {
  const filterUser = interaction.options.getUser("user");
  const rows = listOpenTickets(interaction.guildId, {
    userId: filterUser?.id,
    limit: 25,
  });

  if (!rows.length) {
    await interaction.reply({
      content: filterUser
        ? `No open tickets for <@${filterUser.id}>.`
        : "No open tickets.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = rows.map((t) => {
    const sens = Number(t.is_sensitive) ? " 🔒" : "";
    const ch = t.channel_id ? `<#${t.channel_id}>` : "_no channel_";
    const owner = t.staff_owner_id
      ? `<@${t.staff_owner_id}>`
      : "_unclaimed_";
    return (
      `**${formatTicketRef(t.ticket_number)}**${sens} · ${ch} · ` +
      `requester <@${t.creator_user_id}> · owner ${owner}`
    );
  });

  await interaction.reply({
    content: `**Open tickets** (${rows.length})\n\n${lines.join("\n")}`.slice(
      0,
      1900
    ),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleInfo(interaction, ctx) {
  // Allow info on soft-closed channels still present
  const ctxTicket = await requireLiveTicketChannel(interaction, ctx, {
    status: "any",
  });
  if (!ctxTicket) return;
  const { ticket } = ctxTicket;

  const members = listTicketMembers(ticket.id);
  const staff = listTicketStaff(ticket.id);

  const embed = new EmbedBuilder()
    .setColor(Number(ticket.is_sensitive) ? COLOR_SENSITIVE : COLOR_INFO)
    .setTitle(`Ticket ${formatTicketRef(ticket.ticket_number)}`)
    .setDescription((ticket.reason || "_No reason_").slice(0, 4000))
    .addFields(
      {
        name: "Status",
        value: ticket.status,
        inline: true,
      },
      {
        name: "Sensitive",
        value: Number(ticket.is_sensitive) ? "yes" : "no",
        inline: true,
      },
      {
        name: "Requester",
        value: `<@${ticket.creator_user_id}>`,
        inline: true,
      },
      {
        name: "Staff owner",
        value: ticket.staff_owner_id
          ? `<@${ticket.staff_owner_id}>`
          : "_unclaimed_",
        inline: true,
      },
      {
        name: "Created",
        value: `<t:${Math.floor(ticket.created_at / 1000)}:F>`,
        inline: true,
      },
      {
        name: "Members",
        value:
          members.map((m) => `<@${m.user_id}>`).join(", ") || "—",
      },
      {
        name: "Named staff",
        value:
          staff
            .map(
              (s) =>
                `<@${s.user_id}>${Number(s.is_owner) ? " (owner)" : ""}`
            )
            .join(", ") || "—",
      }
    );

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSetCategory(interaction, ctx) {
  const category = interaction.options.getChannel("category", true);
  updateGuildSettings(interaction.guildId, {
    ticket_category_id: category.id,
  });
  await logConfigChange(ctx?.client || interaction.client, interaction.guildId, {
    title: "Ticket category set",
    command: "/ticket setcategory",
    actor: interaction.user,
    changes: [`Category: ${category.name || category.id} (${category.id})`],
  }).catch(() => {});

  await interaction.reply({
    content: `New tickets will be created under **${category.name || category.id}**.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSetArchive(interaction, ctx) {
  const channel = interaction.options.getChannel("channel", true);
  updateGuildSettings(interaction.guildId, {
    ticket_archive_channel_id: channel.id,
  });
  await logConfigChange(ctx?.client || interaction.client, interaction.guildId, {
    title: "Ticket archive channel set",
    command: "/ticket setarchive",
    actor: interaction.user,
    changes: [`Channel: <#${channel.id}>`],
  }).catch(() => {});

  await interaction.reply({
    content:
      `Close summaries and transcript links will post to <#${channel.id}>. ` +
      `Restrict that channel to staff in Discord permissions.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSetRateLimit(interaction, ctx) {
  const minutes = interaction.options.getInteger("minutes", true);
  updateGuildSettings(interaction.guildId, {
    ticket_rate_limit_minutes: minutes,
  });
  await logConfigChange(ctx?.client || interaction.client, interaction.guildId, {
    title: "Ticket rate limit set",
    command: "/ticket setratelimit",
    actor: interaction.user,
    changes: [
      minutes === 0
        ? "Rate limit: disabled"
        : `Rate limit: ${minutes} minute(s) between self-creates`,
    ],
  }).catch(() => {});

  await interaction.reply({
    content:
      minutes === 0
        ? "Member self-create rate limit **disabled**."
        : `Members can self-create at most one ticket every **${minutes}** minute(s). Staff \`/ticket for\` is not rate-limited.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSettings(interaction) {
  // Anyone can view settings summary (helps members know rate limits)
  // Config changes still require admin via set* commands
  const s = getTicketSettings(interaction.guildId);
  const allStaff = listStaffRoles(interaction.guildId);
  const senior = listSeniorStaffRoles(interaction.guildId);
  const junior = allStaff.filter(
    (r) => normalizeStaffLevel(r.level) === "junior"
  );
  const seniorList = senior.length
    ? senior.map((r) => `<@&${r.role_id}>`).join(", ")
    : "_none_ — `/staff role add` with **senior** for ticket visibility";
  const juniorList = junior.length
    ? junior.map((r) => `<@&${r.role_id}>`).join(", ")
    : "_none_";

  await interaction.reply({
    content:
      `**Ticket settings**\n` +
      `Category: ${s.ticket_category_id ? `<#${s.ticket_category_id}>` : "_not set_ (`/ticket setcategory`)"} \n` +
      `Archive channel: ${s.ticket_archive_channel_id ? `<#${s.ticket_archive_channel_id}>` : "_not set_ (`/ticket setarchive`)"} \n` +
      `Self-create rate limit: **${s.ticket_rate_limit_minutes === 0 ? "off" : `${s.ticket_rate_limit_minutes} min`}**\n` +
      `**Senior** staff (ticket channel overwrites): ${seniorList}\n` +
      `**Junior** staff (commands only, no auto ticket view): ${juniorList}\n` +
      `\n**Members:** \`/ticket create [reason]\` or the **Open a ticket** panel button\n` +
      `**Staff:** \`for\` · \`claim\` · \`close\` · \`archive\` · \`sensitive\` · \`list\` · …\n` +
      `**Admin:** \`panel\` · \`setcategory\` · \`setarchive\` · \`setratelimit\`\n` +
      `\n**Close** removes non-staff from the channel; **archive** saves the transcript and deletes it.`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * @param {import("discord.js").Client} client
 */
function registerEvents(client) {
  client.on(Events.ChannelDelete, (channel) => {
    try {
      if (!channel?.id) return;
      const closed = markTicketClosedByChannelDelete(channel.id);
      if (closed) {
        console.log(
          `[tickets] Channel deleted externally; closed ticket #${closed.ticket_number} (no archive)`
        );
      }
    } catch (err) {
      console.error("[tickets] ChannelDelete handler:", err);
    }
  });
}

/**
 * @param {import("discord.js").Client} client
 */
function start(client) {
  startTicketHttpServer();
}

module.exports = {
  name: "tickets",
  commands,
  handlers: {
    ticket: handleTicket,
  },
  buttonHandlers: {
    [BTN_OPEN]: handleOpenTicketButton,
    [BTN_STAFF_NOTE_PREFIX]: handleStaffNoteButton,
  },
  modalHandlers: {
    [MODAL_CREATE]: handleCreateTicketModal,
    [MODAL_STAFF_NOTE_PREFIX]: handleStaffNoteModal,
  },
  registerEvents,
  start,
  formatTicketRef,
  openTicketChannel,
  buildCreateTicketModal,
  buildOpenTicketButtonRow,
  buildPanelEmbed,
  buildTicketStaffNoteContent,
  buildAddStaffNoteButtonRow,
  BTN_OPEN,
  BTN_STAFF_NOTE_PREFIX,
  MODAL_CREATE,
  MODAL_STAFF_NOTE_PREFIX,
  MODAL_FIELD_REASON,
  MODAL_FIELD_STAFF_NOTE,
  MAX_TICKET_REASON,
};
