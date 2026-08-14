/**
 * Help ticket system — private support channels with sensitive mode and archives.
 *
 * Slash: /ticket create|for|close|claim|transfer|adduser|removeuser|
 *        addstaff|removestaff|sensitive|unsensitive|list|info|
 *        setcategory|setarchive|setratelimit|settings
 *        panel create|list|edit|delete  (stored panel registry)
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
  // panel registry
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
const { replyDenied, replyEphemeral } = require("../../core/interaction");
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
const { Color, formatTicketRef, tsFull } = require("../../core/theme");

const COLOR_OPEN = Color.success;
const COLOR_INFO = Color.brand;
const COLOR_SENSITIVE = Color.danger;

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
      "Open and manage support tickets; staff lifecycle and guild ticket config.",
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
            .setMaxLength(MAX_TICKET_REASON),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("for")
        .setDescription("Staff: open a ticket for a member.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member to open a ticket for")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("Why this ticket is being opened")
            .setRequired(false)
            .setMaxLength(MAX_TICKET_REASON),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("close")
        .setDescription(
          "Close this ticket: remove non-staff members; keep channel for staff.",
        )
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("Close reason (shown to requester + on archive)")
            .setRequired(false)
            .setMaxLength(MAX_TICKET_REASON),
        )
        .addStringOption((opt) =>
          opt
            .setName("staff_note")
            .setDescription(
              "Optional private staff note on the requester (never shown to them)",
            )
            .setRequired(false)
            .setMaxLength(MAX_NOTE_CONTENT),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("archive")
        .setDescription(
          "Archive a closed ticket: transcript (if not sensitive), then delete channel.",
        ),
    )
    .addSubcommand((sc) =>
      sc.setName("claim").setDescription("Claim this ticket as staff owner."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("transfer")
        .setDescription("Transfer staff ownership of this ticket.")
        .addUserOption((opt) =>
          opt
            .setName("staff")
            .setDescription("New staff owner")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("adduser")
        .setDescription("Add a member participant to this ticket.")
        .addUserOption((opt) =>
          opt.setName("user").setDescription("Member to add").setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("removeuser")
        .setDescription("Remove a member participant from this ticket.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member to remove")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("addstaff")
        .setDescription(
          "Allow-list a staff user on this ticket (named access).",
        )
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Staff user to add")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("removestaff")
        .setDescription("Remove a named staff allow-list entry.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Staff user to remove")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("sensitive")
        .setDescription(
          "Lock this ticket to owner + named staff + members only.",
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("unsensitive")
        .setDescription("Restore normal staff-role visibility on this ticket."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("list")
        .setDescription("List open tickets (staff).")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Filter by member")
            .setRequired(false),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("info")
        .setDescription("Show details for this ticket channel."),
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
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("setarchive")
        .setDescription(
          "Set the staff channel for close summaries / transcripts (admin).",
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Text channel for archive posts")
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            )
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("setratelimit")
        .setDescription(
          "Min minutes between member self-creates (0 = off; default 60).",
        )
        .addIntegerOption((opt) =>
          opt
            .setName("minutes")
            .setDescription("Cooldown limit minutes (0 disables)")
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(10080),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("panel")
        .setDescription("Create, list, edit, or delete ticket panels (staff).")
        // panel create — post a new panel
        .addSubcommand((sc) =>
          sc
            .setName("create")
            .setDescription(
              "Post an Open Ticket panel (button → modal) in a channel."
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
        // panel list — show registered panels
        .addSubcommand((sc) =>
          sc
            .setName("list")
            .setDescription("List all ticket panels in this server.")
        )
        // panel edit — update title/description of a registered panel
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
                .setMaxLength(2000)
            )
        )
        // panel delete — remove a registered panel
        .addSubcommand((sc) =>
          sc
            .setName("delete")
            .setDescription("Remove a ticket panel and its Discord message.")
            .addStringOption((opt) =>
              opt
                .setName("message_id")
                .setDescription("Message ID of the panel to remove")
                .setRequired(true)
            )
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("settings")
        .setDescription("Show ticket configuration for this server."),
    ),
];

/**
 * @param {number} n
 * @returns {string}
 */
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

  const { roleIds: staffRoleIds, skipped } = getManageableStaffRoleIds(
    guild,
    botMember,
  );
  if (skipped.length) {
    console.warn(
      `[tickets] Skipping ${skipped.length} staff role overwrite(s):`,
      skipped.map((s) => `${s.id} (${s.reason})`).join("; "),
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

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} ctx
 */
async function handleTicket(interaction, ctx) {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  // Panel subcommand group: /ticket panel [create|list|edit|delete]
  if (group === "panel") {
    if (!(await requireStaff(interaction))) return;
    if (sub === "create") return handlePanelCreate(interaction, ctx);
    if (sub === "list") return handlePanelList(interaction);
    if (sub === "edit") return handlePanelEdit(interaction, ctx);
    if (sub === "delete") return handlePanelDelete(interaction, ctx);
  }

  // Public
  if (sub === "create") return handleCreate(interaction, ctx);
  if (sub === "settings") return handleSettings(interaction);

  // Staff config (no subcommand group)
  if (
    sub === "setcategory" ||
    sub === "setarchive" ||
    sub === "setratelimit"
  ) {
    if (!(await requireStaff(interaction))) return;
    if (sub === "setcategory") return handleSetCategory(interaction, ctx);
    if (sub === "setarchive") return handleSetArchive(interaction, ctx);
    if (sub === "setratelimit") return handleSetRateLimit(interaction, ctx);
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

  await replyEphemeral(interaction, {
    content: `Unknown subcommand: \`${sub}\``,
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
    await replyEphemeral(interaction, {
      content: formatRateLimitMessage(check),
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await completeSelfCreate(interaction, ctx, reason);
}

/**
 * Staff: post a public panel with an Open ticket button (stored in DB).
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} ctx
 */
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
      content: "No ticket panels configured. Use `/ticket panel create` to post one.",
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

  const panel = getTicketPanel(interaction.guildId, messageId);
  const finalTitle = (title != null ? title.trim() : panel?.title) || DEFAULT_PANEL_TITLE;
  const finalDesc = (description != null ? description.trim() : panel?.description) || DEFAULT_PANEL_DESCRIPTION;

  // Try to update the live Discord message embed
  let note = "";
  if (panel?.channel_id) {
    try {
      const channel = await interaction.guild.channels.fetch(panel.channel_id).catch(() => null);
      if (channel?.messages) {
        const msg = await channel.messages.fetch(messageId).catch(() => null);
        if (msg) {
          const embed = buildPanelEmbed(finalTitle, finalDesc);
          await msg.edit({ embeds: [embed], components: [buildOpenTicketButtonRow()] });
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
    }
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
  const { removed, channel_id } = deleteTicketPanel(interaction.guildId, messageId);

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
      }
    ).catch(() => {});
  }

  await interaction.reply({
    content: removed
      ? `Deleted ticket panel \`${messageId}\`.${note}`
      : `No ticket panel with message ID \`${messageId}\`.`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Panel button → show description modal (public).
 * @param {import("discord.js").ButtonInteraction} interaction
 * @param {object} _ctx
 */
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

async function handleList(interaction) {
  const filterUser = interaction.options.getUser("user");
  const rows = listOpenTickets(interaction.guildId, {
    userId: filterUser?.id,
    limit: 25,
  });

  if (!rows.length) {
    await replyEphemeral(interaction, {
      content: filterUser
        ? `No open tickets for <@${filterUser.id}>.`
        : "No open tickets.",
    });
    return;
  }

  const lines = rows.map((t) => {
    const sens = Number(t.is_sensitive) ? " 🔒" : "";
    const ch = t.channel_id ? `<#${t.channel_id}>` : "_no channel_";
    const owner = t.staff_owner_id ? `<@${t.staff_owner_id}>` : "_unclaimed_";
    return (
      `**${formatTicketRef(t.ticket_number)}**${sens} · ${ch} · ` +
      `requester <@${t.creator_user_id}> · owner ${owner}`
    );
  });

  await replyEphemeral(interaction, {
    content: `**Open tickets** (${rows.length})\n\n${lines.join("\n")}`.slice(
      0,
      1900,
    ),
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
        value: tsFull(ticket.created_at),
        inline: true,
      },
      {
        name: "Members",
        value: members.map((m) => `<@${m.user_id}>`).join(", ") || "—",
      },
      {
        name: "Named staff",
        value:
          staff
            .map(
              (s) => `<@${s.user_id}>${Number(s.is_owner) ? " (owner)" : ""}`,
            )
            .join(", ") || "—",
      },
    );

  await replyEphemeral(interaction, {
    embeds: [embed],
  });
}

async function handleSetCategory(interaction, ctx) {
  const category = interaction.options.getChannel("category", true);
  updateGuildSettings(interaction.guildId, {
    ticket_category_id: category.id,
  });
  await logConfigChange(
    ctx?.client || interaction.client,
    interaction.guildId,
    {
      title: "Ticket category set",
      command: "/ticket setcategory",
      actor: interaction.user,
      changes: [`Category: ${category.name || category.id} (${category.id})`],
    },
  ).catch(() => {});

  await replyEphemeral(interaction, {
    content: `New tickets will be created under **${category.name || category.id}**.`,
  });
}

async function handleSetArchive(interaction, ctx) {
  const channel = interaction.options.getChannel("channel", true);
  updateGuildSettings(interaction.guildId, {
    ticket_archive_channel_id: channel.id,
  });
  await logConfigChange(
    ctx?.client || interaction.client,
    interaction.guildId,
    {
      title: "Ticket archive channel set",
      command: "/ticket setarchive",
      actor: interaction.user,
      changes: [`Channel: <#${channel.id}>`],
    },
  ).catch(() => {});

  await replyEphemeral(interaction, {
    content:
      `Close summaries and transcript links will post to <#${channel.id}>. ` +
      `Restrict that channel to staff in Discord permissions.`,
  });
}

async function handleSetRateLimit(interaction, ctx) {
  const minutes = interaction.options.getInteger("minutes", true);
  updateGuildSettings(interaction.guildId, {
    ticket_rate_limit_minutes: minutes,
  });
  await logConfigChange(
    ctx?.client || interaction.client,
    interaction.guildId,
    {
      title: "Ticket rate limit set",
      command: "/ticket setratelimit",
      actor: interaction.user,
      changes: [
        minutes === 0
          ? "Rate limit: disabled"
          : `Rate limit: ${minutes} minute(s) between self-creates`,
      ],
    },
  ).catch(() => {});

  await replyEphemeral(interaction, {
    content:
      minutes === 0
        ? "Member self-create rate limit **disabled**."
        : `Members can self-create at most one ticket every **${minutes}** minute(s). Staff \`/ticket for\` is not rate-limited.`,
  });
}

async function handleSettings(interaction) {
  // Anyone can view settings summary (helps members know rate limits)
  // Config changes still require admin via set* commands
  const s = getTicketSettings(interaction.guildId);
  const allStaff = listStaffRoles(interaction.guildId);
  const senior = listSeniorStaffRoles(interaction.guildId);
  const junior = allStaff.filter(
    (r) => normalizeStaffLevel(r.level) === "junior",
  );
  const seniorList = senior.length
    ? senior.map((r) => `<@&${r.role_id}>`).join(", ")
    : "_none_ — `/staff role add` with **senior** for ticket visibility";
  const juniorList = junior.length
    ? junior.map((r) => `<@&${r.role_id}>`).join(", ")
    : "_none_";

  await replyEphemeral(interaction, {
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
          `[tickets] Channel deleted externally; closed ticket #${closed.ticket_number} (no archive)`,
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
