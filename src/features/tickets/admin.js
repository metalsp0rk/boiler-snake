/**
 * List/info/summarize plus guild ticket config.
 */
const {
  getTicketSettings,
  listTicketMessages,
  listTicketMembers,
  listTicketStaff,
  listOpenTickets,
  updateGuildSettings,
  listStaffRoles,
  listSeniorStaffRoles,
  normalizeStaffLevel,
} = require("../../db");
const { logConfigChange } = require("../logs/auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");
const {
  collectTicketUserIds,
  resolveUsers,
  enrichMessagesForArchive,
} = require("./users");
const { summarizeTicket } = require("./summary");
const { Color, formatTicketRef, tsFull } = require("../../core/theme");
const { COLOR_INFO, COLOR_SENSITIVE } = require("./constants");
const { requireLiveTicketChannel } = require("./helpers");


/**
 * Standard reply for Fluxer dispatches reaching Discord-only surfaces
 * (roadmap/fluxer.md § What stays Discord-only): ticket channel lifecycle
 * (open / close / archive / claim overwrites) uses discord.js channel objects
 * until the OutboundClient cutover in PR 7.
 */
const NOT_ON_FLUXER = "That command is not available on Fluxer yet.";

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function handleList(commandCtx) {
  const filterUser = commandCtx.options.getUser("user");
  // Repository key: integer community id, resolved by the context builder.
  const communityId = commandCtx.communityId;
  const rows = listOpenTickets(communityId, {
    userId: filterUser?.id,
    limit: 25,
  });

  if (!rows.length) {
    await commandCtx.reply({
      content: filterUser
        ? `No open tickets for <@${filterUser.id}>.`
        : "No open tickets.",
      sensitive: true,
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

  await commandCtx.reply({
    content: `**Open tickets** (${rows.length})\n\n${lines.join("\n")}`.slice(
      0,
      1900,
    ),
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [ctx]
 */
async function handleInfo(commandCtx, ctx) {
  // Ticket-channel lifecycle helpers keep (interaction, ctx) signatures until
  // the OutboundClient cutover (PR 7) — pass the raw Discord interaction.
  // Roadmap § What stays Discord-only: Fluxer contexts carry no rawInteraction.
  const raw = commandCtx.rawInteraction;
  if (!raw) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }

  // Allow info on soft-closed channels still present
  const ctxTicket = await requireLiveTicketChannel(raw, ctx, {
    status: "any",
  });
  if (!ctxTicket) return;
  const { ticket } = ctxTicket;

  const members = listTicketMembers(ticket.id);
  const staff = listTicketStaff(ticket.id);

  // Plain NormalizedEmbed (roadmap § CommandContext): same visible text as the
  // previous EmbedBuilder chain.
  const embed = {
    title: `Ticket ${formatTicketRef(ticket.ticket_number)}`,
    description: (ticket.reason || "_No reason_").slice(0, 4000),
    color: Number(ticket.is_sensitive) ? COLOR_SENSITIVE : COLOR_INFO,
    fields: [
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
    ],
  };

  await commandCtx.reply({
    embeds: [embed],
    sensitive: true,
  });
}

/**
 * Page channel history through the OutboundClient (spec: history reads go
 * through outbound.fetchMessages, never an unnamed messages.fetch) and map
 * NormalizedMessage rows onto the archive row shape summarizeTicket consumes
 * — same shape close.js's normalizeDiscordMessage produces, so summaries read
 * identically. Pages walk backwards (100/page, 5000 max) like fetchAllMessages.
 * @param {object} outbound OutboundClient
 * @param {string} channelId
 * @returns {Promise<object[]>} archive-shaped rows, oldest → newest
 */
async function fetchHistoryRows(outbound, channelId) {
  const rows = [];
  let before;
  const MAX = 5000;
  const PAGE = 100;

  while (rows.length < MAX) {
    const res = await outbound.fetchMessages(channelId, {
      limit: PAGE,
      ...(before ? { before } : {}),
    });
    if (!res.ok) {
      const err = new Error(res.error);
      err.code = "HISTORY_FETCH";
      throw err;
    }
    const page = res.messages || [];
    for (const m of page) {
      rows.push({
        message_id: String(m.id),
        author_id: String(m.authorId ?? "0"),
        // Labels are resolved via resolveUsers/enrich below; the raw id is the
        // fallback summarizeTicket renders when resolution is unavailable.
        author_tag: null,
        content: m.content ?? "",
        sent_at: m.createdAt
          ? new Date(m.createdAt).getTime()
          : Date.now(),
      });
    }
    if (page.length < PAGE) break;
    // Oldest id of the page (discord.js returns newest-first; snowflake compare)
    const oldest = page.reduce((a, b) => {
      try {
        return BigInt(a.id) < BigInt(b.id) ? a : b;
      } catch {
        return String(a.id) < String(b.id) ? a : b;
      }
    });
    before = oldest.id;
  }

  rows.sort((a, b) => {
    if (a.sent_at !== b.sent_at) return a.sent_at - b.sent_at;
    return String(a.message_id).localeCompare(String(b.message_id));
  });
  return rows;
}

/**
 * On-demand AI summary of the current ticket conversation.
 * Works while the ticket is open (or soft-closed, pre-archive).
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [ctx]
 */
async function handleSummarize(commandCtx, ctx) {
  // Ticket-channel lifecycle helpers keep (interaction, ctx) signatures until
  // the OutboundClient cutover (PR 7) — pass the raw Discord interaction.
  // Roadmap § What stays Discord-only: Fluxer contexts carry no rawInteraction.
  const raw = commandCtx.rawInteraction;
  if (!raw) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }

  const ctxTicket = await requireLiveTicketChannel(raw, ctx, {
    status: "any",
  });
  if (!ctxTicket) return;
  const { ticket } = ctxTicket;

  // Helper pipeline takes the raw Discord client (PR 7 cutover).
  const client = ctx?.client || raw.client;
  await commandCtx.defer({ sensitive: true });

  let messages = listTicketMessages(ticket.id);
  if (!messages.length) {
    try {
      // History via outbound.fetchMessages (roadmap § Outbound client).
      messages = await fetchHistoryRows(commandCtx.outbound, commandCtx.channelId);
      const ids = collectTicketUserIds(ticket, messages);
      const userMap = await resolveUsers(client, raw.guild, ids);
      messages = enrichMessagesForArchive(messages, userMap);
    } catch (err) {
      console.error("[tickets] summarize fetch failed:", err);
      await commandCtx.editReply({
        content: `Could not read the ticket conversation to summarize it: ${err?.message || err}`,
        sensitive: true,
      });
      return;
    }
  }

  const summary = await summarizeTicket(ticket, messages, {});

  recordSlashAudit({
    communityId: commandCtx.communityId,
    actorUserId: commandCtx.userId,
    action: "tickets.summarize",
    targetType: "ticket",
    targetId: String(ticket.id),
    details: {
      ticket_number: ticket.ticket_number,
      source: summary.source ?? null,
      message_count: summary.message_count ?? messages.length,
    },
  });
  const sourceNote =
    summary.source === "ai"
      ? `AI summary (model: ${summary.model})`
      : "Stats-only summary (AI not configured or unavailable)";

  // Plain NormalizedEmbed — same visible text as the previous baseEmbed chain.
  const embed = {
    color: Number(ticket.is_sensitive) ? Color.danger : Color.brand,
    title: `Ticket ${formatTicketRef(ticket.ticket_number)} — ${ticket.status}`,
    footer: { text: "Staff only" },
    description: (summary.summary || "").slice(0, 4000) || "—",
    fields: [
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
    ],
  };

  await commandCtx.editReply({ embeds: [embed], sensitive: true });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function handleSetCategory(commandCtx) {
  const category = commandCtx.options.getChannel("category", true);
  // Repository key: integer community id, resolved by the context builder.
  const communityId = commandCtx.communityId;
  updateGuildSettings(communityId, {
    ticket_category_id: category.id,
  });
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "tickets.category_set",
    targetType: "channel",
    targetId: category.id,
  });
  // Display name via outbound (roadmap § Outbound client): the Discord
  // adapter's ChannelHandle is the discord.js channel and carries .name;
  // null → specific "unavailable" note in the audit line.
  const categoryHandle = await commandCtx.outbound.fetchChannel(
    communityId,
    category.id,
  );
  const categoryLabel =
    categoryHandle?.name ||
    (categoryHandle ? category.id : `channel \`${category.id}\` (unavailable)`);
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Ticket category set",
    command: "/ticket setcategory",
    actor: commandCtx.user,
    changes: [`Category: ${categoryLabel} (${category.id})`],
  }).catch(() => {});

  await commandCtx.reply({
    content: `New tickets will be created under **${categoryLabel}**.`,
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function handleSetArchive(commandCtx) {
  const channel = commandCtx.options.getChannel("channel", true);
  // Repository key: integer community id, resolved by the context builder.
  const communityId = commandCtx.communityId;
  updateGuildSettings(communityId, {
    ticket_archive_channel_id: channel.id,
  });
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "tickets.archive_channel_set",
    targetType: "channel",
    targetId: channel.id,
  });
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Ticket archive channel set",
    command: "/ticket setarchive",
    actor: commandCtx.user,
    changes: [`Channel: <#${channel.id}>`],
  }).catch(() => {});

  await commandCtx.reply({
    content:
      `Close summaries and transcript links will post to <#${channel.id}>. ` +
      `Restrict that channel to staff in Discord permissions.`,
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function handleSetRateLimit(commandCtx) {
  const minutes = commandCtx.options.getInteger("minutes", true);
  // Repository key: integer community id, resolved by the context builder.
  const communityId = commandCtx.communityId;
  updateGuildSettings(communityId, {
    ticket_rate_limit_minutes: minutes,
  });
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "tickets.rate_limit_set",
    targetType: "guild",
    targetId: commandCtx.externalGuildId,
    details: { minutes },
  });
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Ticket rate limit set",
    command: "/ticket setratelimit",
    actor: commandCtx.user,
    changes: [
      minutes === 0
        ? "Rate limit: disabled"
        : `Rate limit: ${minutes} minute(s) between self-creates`,
    ],
  }).catch(() => {});

  await commandCtx.reply({
    content:
      minutes === 0
        ? "Member self-create rate limit **disabled**."
        : `Members can self-create at most one ticket every **${minutes}** minute(s). Staff \`/ticket for\` is not rate-limited.`,
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function handleSettings(commandCtx) {
  // Anyone can view settings summary (helps members know rate limits)
  // Config changes still require admin via set* commands
  // Repository key: integer community id, resolved by the context builder.
  const communityId = commandCtx.communityId;
  const s = getTicketSettings(communityId);
  const allStaff = listStaffRoles(communityId);
  const senior = listSeniorStaffRoles(communityId);
  const junior = allStaff.filter(
    (r) => normalizeStaffLevel(r.level) === "junior",
  );
  const seniorList = senior.length
    ? senior.map((r) => `<@&${r.role_id}>`).join(", ")
    : "_none_ — `/staff role add` with **senior** for ticket visibility";
  const juniorList = junior.length
    ? junior.map((r) => `<@&${r.role_id}>`).join(", ")
    : "_none_";

  await commandCtx.reply({
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
    sensitive: true,
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
