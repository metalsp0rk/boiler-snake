/**
 * List/info/summarize plus guild ticket config.
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
  Color,
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

/**
 * On-demand AI summary of the current ticket conversation.
 * Works while the ticket is open (or soft-closed, pre-archive).
 */
async function handleSummarize(interaction, ctx) {
  const ctxTicket = await requireLiveTicketChannel(interaction, ctx, {
    status: "any",
  });
  if (!ctxTicket) return;
  const { ticket, channel } = ctxTicket;

  const client = ctx?.client || interaction.client;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let messages = listTicketMessages(ticket.id);
  if (!messages.length) {
    try {
      messages = await fetchAllMessages(channel);
      const ids = collectTicketUserIds(ticket, messages);
      const userMap = await resolveUsers(client, channel.guild, ids);
      messages = enrichMessagesForArchive(messages, userMap);
    } catch (err) {
      console.error("[tickets] summarize fetch failed:", err);
      await editEphemeral(
        interaction,
        "Could not read the ticket conversation to summarize it.",
      );
      return;
    }
  }

  const summary = await summarizeTicket(ticket, messages, {});
  const sourceNote =
    summary.source === "ai"
      ? `AI summary (model: ${summary.model})`
      : "Stats-only summary (AI not configured or unavailable)";

  const embed = baseEmbed({
    color: Number(ticket.is_sensitive) ? Color.danger : Color.brand,
    title: `Ticket ${formatTicketRef(ticket.ticket_number)} — ${ticket.status}`,
    footer: "Staff only",
  })
    .setDescription((summary.summary || "").slice(0, 4000) || "—")
    .addFields(
      {
        name: "Resolution",
        value: (summary.resolution || "—").slice(0, 500),
        inline: false,
      },
      {
        name: "Messages",
        value: String(summary.message_count ?? messages.length),
        inline: true,
      },
      {
        name: "Source",
        value: sourceNote,
        inline: true,
      },
    );

  await editEphemeral(interaction, { embeds: [embed] });
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

module.exports = {
  handleList,
  handleInfo,
  handleSummarize,
  handleSetCategory,
  handleSetArchive,
  handleSetRateLimit,
  handleSettings,
};
