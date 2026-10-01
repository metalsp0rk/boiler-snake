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
// Discord edge: snowflake → integer community id for repository calls.
// getCommunityById: the Fluxer ticket path reads the community row's
// externalGuildId (the @everyone overwrite id, Phase 0) — PR 9.
const { ensureCommunity, getCommunityById } = require("../../platform/community");
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
      // Ticket rows carry the integer community key (migration 034); the
      // staffNotes repo is community-keyed, so pass it straight through.
      communityId: ticket.community_id,
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
  // Community key is guild-scoped: DM interactions have no guild, so they
  // keep the "not a ticket channel" reply instead of a mapping throw.
  const communityId = interaction.guildId
    ? ensureCommunity({
        platform: "discord",
        instanceKey: "discord",
        externalGuildId: interaction.guildId,
      })
    : null;
  const ticket =
    communityId != null
      ? getTicketByChannel(communityId, interaction.channelId)
      : null;
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
  // Community key is guild-scoped: DM interactions have no guild, so they
  // keep the "not a ticket channel" reply instead of a mapping throw.
  const communityId = interaction.guildId
    ? ensureCommunity({
        platform: "discord",
        instanceKey: "discord",
        externalGuildId: interaction.guildId,
      })
    : null;
  const ticket =
    communityId != null
      ? getTicketByChannel(communityId, interaction.channelId)
      : null;
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
 * Fluxer ticket-role gate (PR 9, roadmap § Outbound client + overwrites.js
 * § getManageableStaffRoleIds mirror). The OutboundClient has no discord.js
 * role hierarchy — manageability is the position rule the Discord function
 * applies, computed from `fetchMember` (bot's role ids) ∩ `fetchRoles`
 * (positions). Skips carry the SAME { id, name, reason } shape as the Discord
 * variant so `formatStaffRoleAccessNote` / `describeSkippedStaffRoles` format
 * them unchanged.
 *
 * Missing bot member → every staff role is skipped with
 * "bot member roles unknown": the bot cannot verify hierarchy, so it must not
 * mint overwrites it may not control (the Discord path's fail-safe posture).
 *
 * @param {object} outbound Fluxer OutboundClient
 * @param {number} communityId
 * @returns {Promise<{ roleIds: string[], skipped: { id: string, name: string|null, reason: string }[] }>}
 */
async function getManageableStaffRoleIdsFluxer(outbound, communityId) {
  // Senior only — junior staff never get automatic ticket visibility
  // (same rule as getManageableStaffRoleIds).
  const rows = listSeniorStaffRoles(communityId);
  const roleIds = [];
  const skipped = [];
  if (!rows.length) return { roleIds, skipped };

  const botUserId = outbound?.botUserId;
  const botMember = botUserId
    ? await outbound.fetchMember(communityId, botUserId)
    : null;
  if (!botMember) {
    for (const row of rows) {
      skipped.push({
        id: row.role_id,
        name: null,
        reason: "bot member roles unknown",
      });
    }
    return { roleIds, skipped };
  }

  const roles = (await outbound.fetchRoles(communityId)) ?? [];
  const roleById = new Map();
  for (const r of roles) {
    if (r && r.id != null) roleById.set(String(r.id), r);
  }
  const botRoleIds = new Set((botMember.roleIds ?? []).map(String));
  let botPos = 0;
  for (const rid of botRoleIds) {
    const p = Number(roleById.get(rid)?.position) || 0;
    if (p > botPos) botPos = p;
  }

  for (const row of rows) {
    const role = roleById.get(String(row.role_id));
    if (!role) {
      // Listed in staff_roles but not on the guild role list — an overwrite
      // for it would 404. Mirrors the Discord "role not found in guild" skip.
      skipped.push({
        id: row.role_id,
        name: null,
        reason: "role not found in guild",
      });
      continue;
    }
    // Bot can only set overwrites for roles strictly below its highest role
    // (same position is unsafe). @everyone is handled by id, never here.
    const rolePos = Number(role.position) || 0;
    if (rolePos >= botPos) {
      if (botRoleIds.has(String(role.id))) {
        // The bot holds this staff role itself: an overwrite would only ever
        // grant the bot, which has its own user overwrite — not a failure.
        continue;
      }
      skipped.push({
        id: row.role_id,
        name: role.name || null,
        reason: "above bot role in hierarchy",
      });
      continue;
    }
    roleIds.push(row.role_id);
  }

  return { roleIds, skipped };
}

/**
 * Turn a failed createChannel result into the user-visible cause (PR 9).
 * The OutboundClient error text is "createChannel: <target> failed: <cause>
 * (status N, code X)"; users get the cause, not the method plumbing. For
 * the K8 gate (code "elevated_disabled") the gate's own reason is returned
 * VERBATIM — it already names the flag and the unlock condition (AGENTS.md
 * rule 3: the user can act on it).
 *
 * @param {{ ok: false, error: string, code?: string }} result createChannel failure
 * @returns {string}
 */
function formatFluxerChannelCreateError(result) {
  const text =
    result?.error != null
      ? String(result.error)
      : "Fluxer createChannel failed without an error string";
  if (result?.code === "elevated_disabled") return text;
  // Strip the outbound method plumbing so the reply reads as a ticket failure.
  const stripped = text.replace(/^createChannel: .*? failed: /, "");
  return `Ticket channel create failed: ${stripped}`;
}

/**
 * Fluxer ticket channel + DB row (PR 9, roadmap § Outbound client). Mirrors
 * openTicketChannel's Discord pipeline through the OutboundClient. K8: the
 * elevated flag is checked by the OUTBOUND itself — flag 0 returns
 * { ok:false, code:"elevated_disabled" } without touching the network, and
 * that specific reason reaches the user as the thrown Error's message.
 *
 * @param {object} opts
 * @param {object} opts.outbound Fluxer OutboundClient (platform === "fluxer")
 * @param {number} opts.communityId integer community id (create.js resolves it)
 * @param {string} opts.creatorUserId
 * @param {string|null} [opts.reason]
 * @param {string|null} [opts.openedByStaffId]
 * @returns {Promise<{ ticket: object, channel: { id: string, name: string }, skippedStaffRoles: object[] }>}
 */
async function openTicketChannelFluxer(opts) {
  const { outbound, creatorUserId, reason, openedByStaffId } = opts;
  const communityId = opts.communityId;
  if (!Number.isInteger(communityId)) {
    // Programmer error (repository contract): name the bad input.
    throw new Error(
      `openTicketChannel: Fluxer ticket create needs an integer communityId, got ${JSON.stringify(communityId)}`,
    );
  }

  const settings = getTicketSettings(communityId);
  const botUserId = outbound.botUserId; // Ready id (spec § Outbound client); "" before Ready
  if (!botUserId) {
    // "Bot user not ready" parity (the Discord branch throws before create).
    throw new Error("Ticket creation needs the bot to be online on this instance");
  }

  const community = getCommunityById(communityId);
  if (!community?.externalGuildId) {
    const err = new Error(
      `Ticket create needs a Fluxer guild: community ${communityId} has no external guild id on its row.`,
    );
    err.code = "CHANNEL_CREATE";
    throw err;
  }

  // No guild capability asserts (assertBotCanCreateTickets is Discord-only):
  // the K8 gate IS the capability gate for now, and a 403 comes back through
  // createChannel as { ok:false } with the API cause.
  const { roleIds: staffRoleIds, skipped } = await getManageableStaffRoleIdsFluxer(
    outbound,
    communityId,
  );
  if (skipped.length) {
    console.warn(
      `[tickets] Skipping ${skipped.length} staff role overwrite(s):`,
      describeSkippedStaffRoles(skipped),
    );
  }

  const { nextTicketNumber } = require("../../db/repositories/tickets");
  const ticketNumber = nextTicketNumber(communityId);
  const channelName = `ticket-${ticketNumber}`.slice(0, 100);

  // SPEC-shaped overwrites (ChannelOverwrite: decimal STRING masks — the
  // boundary never goes through Number). @everyone's id is the external
  // guild id (Phase 0).
  const baseOverwrites = [
    {
      id: String(community.externalGuildId),
      kind: "role",
      allow: "0",
      deny: BigInt(PermissionFlagsBits.ViewChannel).toString(),
    },
    {
      id: botUserId,
      kind: "member",
      allow: BigInt(BOT_ALLOW).toString(),
      deny: "0",
    },
    {
      id: creatorUserId,
      kind: "member",
      allow: BigInt(MEMBER_ALLOW).toString(),
      deny: BigInt(MEMBER_DENY).toString(),
    },
  ];
  // Staff-opened-by mirrors the Discord branch exactly.
  if (openedByStaffId && openedByStaffId !== creatorUserId) {
    baseOverwrites.push({
      id: openedByStaffId,
      kind: "member",
      allow: BigInt(STAFF_ALLOW).toString(),
      deny: "0",
    });
  } else if (openedByStaffId && openedByStaffId === creatorUserId) {
    // Opened by the creator as staff: staff-level access on their own overwrite
    baseOverwrites[baseOverwrites.length - 1] = {
      id: creatorUserId,
      kind: "member",
      allow: BigInt(STAFF_ALLOW).toString(),
      deny: "0",
    };
  }
  for (const roleId of staffRoleIds) {
    baseOverwrites.push({
      id: roleId,
      kind: "role",
      allow: BigInt(STAFF_ALLOW).toString(),
      deny: "0",
    });
  }

  let created;
  try {
    created = await outbound.createChannel({
      communityId,
      name: channelName,
      parentId: settings.ticket_category_id || null,
      type: 0, // Fluxer text channel (spec CreateChannelArgs)
      overwrites: baseOverwrites,
    });
  } catch (err) {
    // createChannel resolves {ok:false} for expected platform failures; a
    // throw is a programmer/transport bug — surface it with context.
    const wrapped = new Error(
      `Ticket channel create failed: ${err?.message || String(err)}`,
    );
    wrapped.code = "CHANNEL_CREATE";
    wrapped.cause = err;
    throw wrapped;
  }
  if (!created.ok) {
    const err = new Error(formatFluxerChannelCreateError(created));
    // elevated_disabled arrives on code too: keep it for callers/tests.
    err.code = created.code || "CHANNEL_CREATE";
    err.cause = created;
    throw err;
  }
  const channelId = created.id;

  let ticket;
  try {
    ticket = createTicket({
      communityId,
      creatorUserId,
      channelId,
      reason: reason || null,
      openedByStaffId: openedByStaffId || null,
    });
  } catch (err) {
    // The Discord path deletes the channel here. The OutboundClient has NO
    // deleteChannel surface (PR 9 scope) — log the orphan loudly and rethrow.
    console.error(
      `[tickets] Ticket row create failed after channel ${channelId} was created in community ${communityId} — channel left in place (no OutboundClient.deleteChannel)`,
    );
    throw err;
  }

  // Open notice: the Discord embed's text, plain JSON (Fluxer send paths never
  // carry EmbedBuilder — spec § Embeds and attachments). A failed post is a
  // logged warning, not a ticket failure (the channel + row already exist).
  const openNotice = await outbound.sendChannel(channelId, {
    content: openedByStaffId
      ? `Opened for <@${creatorUserId}> by <@${openedByStaffId}>.`
      : `<@${creatorUserId}> — staff will be with you shortly.`,
    embeds: [
      {
        title: `Ticket ${formatTicketRef(ticket.ticket_number)}`,
        description: reason
          ? String(reason).slice(0, 4000)
          : "_No reason provided._",
        color: COLOR_OPEN,
        fields: [
          { name: "Requester", value: `<@${creatorUserId}>`, inline: true },
          {
            name: "Opened by",
            value: openedByStaffId
              ? `<@${openedByStaffId}> (staff)`
              : `<@${creatorUserId}>`,
            inline: true,
          },
          { name: "Created", value: tsFull(ticket.created_at), inline: true },
        ],
        footer: {
          text: "Staff: /ticket claim · close · sensitive · adduser",
        },
      },
    ],
  });
  if (!openNotice?.ok) {
    console.warn(
      `[tickets] open-notice send failed in channel ${channelId} (ticket ${ticket.id}): ${openNotice?.error || "unknown send failure"}`,
    );
  }

  return {
    ticket,
    channel: { id: channelId, name: channelName },
    skippedStaffRoles: skipped,
  };
}

/**
 * Create Discord channel + DB row.
 * @param {object} opts
 * @param {number} [opts.communityId] integer community id (resolved at the
 *   caller's Discord edge); derived from opts.guild.id when omitted.
 */
async function openTicketChannel(opts) {
  // PR 9 (roadmap § Outbound client): Fluxer OutboundClient contexts run the
  // platform-neutral pipeline; the discord.js path below stays byte-identical.
  if (opts?.outbound && opts.outbound.platform === "fluxer") {
    return openTicketChannelFluxer(opts);
  }
  const { guild, client, creatorUserId, reason, openedByStaffId } = opts;
  // Integer community key for the DB writes below. Interaction handlers resolve
  // it once at their entry point and pass it in; external callers of this
  // exported helper get the same mapping from the Discord edge here.
  const communityId = Number.isInteger(opts.communityId)
    ? opts.communityId
    : ensureCommunity({
        platform: "discord",
        instanceKey: "discord",
        externalGuildId: guild.id,
      });

  const settings = getTicketSettings(communityId);
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
  const ticketNumber = nextTicketNumber(communityId);
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
      communityId,
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
  openTicketChannelFluxer,
  getManageableStaffRoleIdsFluxer,
  formatFluxerChannelCreateError,
};
