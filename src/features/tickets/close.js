/**
 * Soft-close (remove non-staff) and archive (transcript + dispose channel).
 */

const { EmbedBuilder } = require("discord.js");
const { Color, formatTicketRef, tsFull } = require("../../core/theme");
const {
  markTicketClosed,
  closeTicketSensitive,
  closeTicketArchived,
  saveTicketMessages,
  generateTranscriptToken,
  getTicketSettings,
  setTicketArchiveMessageId,
  getTicketById,
} = require("../../db");
const { writeTranscriptFile } = require("./transcript");
const { summarizeTicket } = require("./summary");
const { transcriptPublicUrl } = require("./httpServer");
const {
  applyTicketOverwrites,
  getManageableStaffRoleIds,
} = require("./overwrites");
const {
  resolveUsers,
  collectTicketUserIds,
  enrichMessagesForArchive,
  ticketUserLabels,
  formatUserLabel,
} = require("./users");
const { mirrorTicketAssets } = require("./assets");

const COLOR_ARCHIVE = Color.brand;
const COLOR_SENSITIVE = Color.danger;
const COLOR_CLOSED = Color.muted;

/**
 * Fetch all messages from a channel (oldest → newest).
 * @param {import("discord.js").TextChannel} channel
 * @returns {Promise<object[]>} normalized message rows
 */
async function fetchAllMessages(channel) {
  const collected = [];
  let before = undefined;
  const MAX = 5000;

  while (collected.length < MAX) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    });
    if (!batch || batch.size === 0) break;

    const arr = [...batch.values()];
    for (const msg of arr) {
      collected.push(normalizeDiscordMessage(msg));
    }

    const oldest = arr.reduce((a, b) => {
      try {
        return BigInt(a.id) < BigInt(b.id) ? a : b;
      } catch {
        return String(a.id) < String(b.id) ? a : b;
      }
    });
    before = oldest.id;
    if (batch.size < 100) break;
  }

  collected.sort((a, b) => {
    if (a.sent_at !== b.sent_at) return a.sent_at - b.sent_at;
    return String(a.message_id).localeCompare(String(b.message_id));
  });
  return collected;
}

/**
 * @param {import("discord.js").Message} msg
 * @returns {object}
 */
function normalizeDiscordMessage(msg) {
  const attachments = [];
  if (msg.attachments) {
    const values =
      typeof msg.attachments.values === "function"
        ? [...msg.attachments.values()]
        : msg.attachments instanceof Map
          ? [...msg.attachments.values()]
          : Array.isArray(msg.attachments)
            ? msg.attachments
            : [];
    for (const a of values) {
      if (typeof a === "string") {
        attachments.push({ url: a, name: null, contentType: null });
      } else if (a?.url || a?.proxyURL) {
        attachments.push({
          url: a.url || a.proxyURL,
          name: a.name || null,
          contentType: a.contentType || null,
        });
      }
    }
  }

  // Stickers (static / lottie URLs when available)
  const sticker_urls = [];
  if (msg.stickers) {
    const stickers =
      typeof msg.stickers.values === "function"
        ? [...msg.stickers.values()]
        : msg.stickers instanceof Map
          ? [...msg.stickers.values()]
          : Array.isArray(msg.stickers)
            ? msg.stickers
            : [];
    for (const s of stickers) {
      if (s?.url) sticker_urls.push(s.url);
    }
  }

  let embedsJson = null;
  if (msg.embeds?.length) {
    try {
      embedsJson = JSON.stringify(
        msg.embeds.map((e) =>
          typeof e.toJSON === "function" ? e.toJSON() : e,
        ),
      );
    } catch {
      embedsJson = null;
    }
  }

  const author = msg.author || {};
  const member = msg.member || null;
  const authorId = String(author.id || "0");
  // Prefer guild nickname / global display name; keep username + id for staff
  const author_tag = formatUserLabel({
    id: authorId,
    displayName: member?.displayName || null,
    globalName: author.globalName || null,
    username: author.username || null,
    tag: author.tag || null,
  });

  const sentAt =
    msg.createdTimestamp != null
      ? Number(msg.createdTimestamp)
      : msg.createdAt
        ? new Date(msg.createdAt).getTime()
        : Date.now();

  return {
    message_id: String(msg.id),
    author_id: authorId,
    author_tag: String(author_tag),
    content: msg.content != null ? String(msg.content) : "",
    attachment_urls: attachments,
    embeds_json: embedsJson,
    sticker_urls: sticker_urls.length ? sticker_urls : undefined,
    sent_at: sentAt,
  };
}

/**
 * Best-effort DM on close (no transcript URL).
 * @param {import("discord.js").Client} client
 * @param {object} ticket
 * @param {string|null} closeReason
 */
async function notifyRequesterClosed(client, ticket, closeReason) {
  try {
    const user =
      client?.users?.cache?.get?.(ticket.creator_user_id) ||
      (await client?.users?.fetch?.(ticket.creator_user_id).catch(() => null));
    if (!user?.send) return;
    const embed = new EmbedBuilder()
      .setColor(COLOR_CLOSED)
      .setTitle(`Ticket ${formatTicketRef(ticket.ticket_number)} closed`)
      .setDescription(
        closeReason
          ? `Your support ticket was closed.\n\n**Reason:** ${String(closeReason).slice(0, 900)}`
          : "Your support ticket was closed.",
      );
    await user.send({ embeds: [embed] });
  } catch {
    // DMs closed — ignore
  }
}

/**
 * Post metadata-only stub for sensitive archive.
 * @param {import("discord.js").Client} client
 * @param {object} ticket
 * @param {object} opts
 * @returns {Promise<string|null>} archive message id
 */
async function postSensitiveStub(client, ticket, opts) {
  const settings = getTicketSettings(ticket.guild_id);
  const channelId = settings.ticket_archive_channel_id;
  if (!channelId) return null;

  let channel =
    client.channels?.cache?.get?.(channelId) ||
    (await client.channels?.fetch?.(channelId).catch(() => null));
  if (!channel?.send) return null;

  const embed = new EmbedBuilder()
    .setColor(COLOR_SENSITIVE)
    .setTitle(
      `Ticket ${formatTicketRef(ticket.ticket_number)} archived (sensitive — not content-archived)`,
    )
    .addFields(
      {
        name: "Requester",
        value: `<@${ticket.creator_user_id}>`,
        inline: true,
      },
      {
        name: "Closed by",
        value: `<@${opts.closedBy}>`,
        inline: true,
      },
      {
        name: "Staff owner",
        value: ticket.staff_owner_id ? `<@${ticket.staff_owner_id}>` : "—",
        inline: true,
      },
      {
        name: "Opened",
        value: tsFull(ticket.created_at),
        inline: true,
      },
      {
        name: "Closed",
        value: tsFull(ticket.closed_at || Date.now()),
        inline: true,
      },
      {
        name: "Close reason",
        value: (opts.closeReason || ticket.close_reason || "—").slice(0, 1024),
      },
    )
    .setFooter({ text: "No transcript · content disposed with channel" });

  const msg = await channel.send({ embeds: [embed] });
  return msg?.id || null;
}

/**
 * Post full archive embed for non-sensitive archive.
 * @param {import("discord.js").Client} client
 * @param {object} ticket
 * @param {object} summary
 * @param {string|null} transcriptUrl
 * @param {object} opts
 * @returns {Promise<string|null>}
 */
async function postArchiveEmbed(client, ticket, summary, transcriptUrl, opts) {
  const settings = getTicketSettings(ticket.guild_id);
  const channelId = settings.ticket_archive_channel_id;
  if (!channelId) return null;

  let channel =
    client.channels?.cache?.get?.(channelId) ||
    (await client.channels?.fetch?.(channelId).catch(() => null));
  if (!channel?.send) return null;

  const closeReason = opts.closeReason || ticket.close_reason || null;

  const fields = [
    {
      name: "Ticket",
      value: formatTicketRef(ticket.ticket_number),
      inline: true,
    },
    {
      name: "Requester",
      value: `<@${ticket.creator_user_id}>`,
      inline: true,
    },
    {
      name: "Staff owner",
      value: ticket.staff_owner_id ? `<@${ticket.staff_owner_id}>` : "—",
      inline: true,
    },
    {
      name: "Subject / reason",
      value: (ticket.reason || "—").slice(0, 1024),
    },
    {
      name: "Opened",
      value: tsFull(ticket.created_at),
      inline: true,
    },
    {
      name: "Closed",
      value: tsFull(ticket.closed_at || Date.now()),
      inline: true,
    },
    {
      name: "Message count",
      value: String(summary.message_count ?? 0),
      inline: true,
    },
    {
      name: "Close reason",
      value: (closeReason || "—").slice(0, 1024),
    },
    {
      name: "Resolution",
      value: String(summary.resolution || "—").slice(0, 1024),
    },
    {
      name: "Summary",
      value: String(summary.summary || "—").slice(0, 1024),
    },
  ];

  if (transcriptUrl) {
    fields.push({
      name: "Transcript",
      value: `[View HTML transcript](${transcriptUrl})`,
    });
  } else if (opts.transcriptToken) {
    fields.push({
      name: "Transcript",
      value: `Token \`${opts.transcriptToken}\` (set TICKET_PUBLIC_BASE_URL for links)`,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR_ARCHIVE)
    .setTitle(`Ticket ${formatTicketRef(ticket.ticket_number)} archived`)
    .addFields(fields)
    .setFooter({
      text:
        summary.source === "ai"
          ? "AI summary · staff only"
          : "Stats summary · staff only",
    });

  const msg = await channel.send({ embeds: [embed] });
  return msg?.id || null;
}

/**
 * Soft-close: mark closed, strip non-staff channel access, keep channel.
 * @param {object} opts
 * @param {import("discord.js").Client} opts.client
 * @param {import("discord.js").GuildTextBasedChannel} opts.channel
 * @param {object} opts.ticket
 * @param {string} opts.closedBy
 * @param {string|null} [opts.closeReason]
 * @param {import("discord.js").GuildMember|null} [opts.botMember]
 * @returns {Promise<{ ticket: object, warnings: string[] }>}
 */
async function softCloseTicket(opts) {
  const { client, channel, closedBy } = opts;
  const closeReason = opts.closeReason || null;
  const warnings = [];

  const closed = markTicketClosed(opts.ticket.id, {
    closedBy,
    closeReason,
  });
  const ticket = closed || getTicketById(opts.ticket.id) || opts.ticket;

  try {
    const guild = channel.guild;
    const botMember = opts.botMember || guild?.members?.me || null;
    const botUserId = client.user?.id;
    const { roleIds } = getManageableStaffRoleIds(guild, botMember);

    await applyTicketOverwrites(channel, {
      guildId: ticket.guild_id,
      everyoneId: guild.id,
      botUserId,
      ticket,
      guild,
      botMember,
      staffRoleIds: roleIds,
      excludeMembers: true,
    });
  } catch (err) {
    console.warn(
      "[tickets] soft-close overwrites failed:",
      err?.message || err,
    );
    warnings.push(
      "Could not fully update channel permissions (members may still see the channel).",
    );
  }

  try {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR_CLOSED)
          .setTitle(`Ticket ${formatTicketRef(ticket.ticket_number)} closed`)
          .setDescription(
            (closeReason
              ? `**Reason:** ${String(closeReason).slice(0, 1500)}\n\n`
              : "") +
              "Non-staff members have been removed from this channel.\n" +
              "Staff: run **`/ticket archive`** when ready to save the transcript and delete the channel." +
              (Number(ticket.is_sensitive)
                ? "\n\n_Sensitive ticket — archive will **not** save message content._"
                : ""),
          ),
      ],
    });
  } catch (err) {
    warnings.push(`Could not post close notice: ${err?.message || err}`);
  }

  await notifyRequesterClosed(client, ticket, closeReason);
  return { ticket, warnings };
}

/**
 * Archive: fetch/transcript (if non-sensitive), post to archive channel, delete channel.
 * Ticket should already be soft-closed; if still open, soft-close is not automatic —
 * caller should ensure status is closed.
 * @param {object} opts
 * @param {import("discord.js").Client} opts.client
 * @param {import("discord.js").GuildTextBasedChannel} opts.channel
 * @param {object} opts.ticket
 * @param {string} opts.archivedBy
 * @param {string} [opts.guildName]
 * @returns {Promise<{ ticket: object, warnings: string[] }>}
 */
async function archiveTicketPipeline(opts) {
  const { client, channel, archivedBy } = opts;
  let ticket = opts.ticket;
  const warnings = [];
  const sensitive = Number(ticket.is_sensitive) === 1;
  const closeReason = ticket.close_reason || null;

  if (Number(ticket.archived) === 1) {
    return {
      ticket,
      warnings: ["Ticket is already archived."],
    };
  }

  if (sensitive) {
    const closed = closeTicketSensitive(ticket.id, {
      closedBy: archivedBy,
      closeReason,
    });
    const archiveMsgId = await postSensitiveStub(client, closed || ticket, {
      closedBy: closed?.closed_by_user_id || archivedBy,
      closeReason,
    }).catch((err) => {
      console.error("[tickets] sensitive stub post failed:", err);
      return null;
    });
    if (!archiveMsgId) {
      warnings.push(
        "Archive channel missing or unwritable — sensitive stub not posted.",
      );
    } else if (closed) {
      setTicketArchiveMessageId(closed.id, archiveMsgId);
    }

    try {
      if (channel?.delete) await channel.delete("Ticket archived (sensitive)");
    } catch (err) {
      warnings.push(`Could not delete channel: ${err?.message || err}`);
    }

    return { ticket: closed || getTicketById(ticket.id) || ticket, warnings };
  }

  // Non-sensitive: freeze sends while archiving
  try {
    if (channel.permissionOverwrites?.edit && channel.guild?.id) {
      await channel.permissionOverwrites.edit(channel.guild.id, {
        SendMessages: false,
      });
    }
  } catch {
    // ignore
  }

  let messages = [];
  try {
    messages = await fetchAllMessages(channel);
  } catch (err) {
    console.error("[tickets] message fetch failed:", err);
    warnings.push("Failed to fetch some messages for archive.");
  }

  // Resolve display names for authors, mentions, requester, staff owner
  let userMap = new Map();
  try {
    const ids = collectTicketUserIds(ticket, messages);
    userMap = await resolveUsers(client, channel.guild, ids);
  } catch (err) {
    console.warn("[tickets] user resolve failed:", err?.message || err);
    warnings.push("Could not resolve some user display names.");
  }

  messages = enrichMessagesForArchive(messages, userMap);
  const labels = ticketUserLabels(ticket, userMap);

  const token = generateTranscriptToken();

  // Download attachments / embed media into transcript assets and rewrite URLs
  try {
    const mirrored = await mirrorTicketAssets(messages, {
      guildId: ticket.guild_id,
      token,
    });
    messages = mirrored.messages;
    if (mirrored.downloaded) {
      console.log(
        `[tickets] Archived ${mirrored.downloaded} media file(s) for ticket #${ticket.ticket_number}`,
      );
    }
    if (mirrored.failed) {
      warnings.push(
        `${mirrored.failed} media file(s) could not be downloaded (CDN links may remain).`,
      );
    }
    if (mirrored.warnings?.length) {
      warnings.push(...mirrored.warnings);
    }
  } catch (err) {
    console.error("[tickets] asset mirror failed:", err);
    warnings.push("Failed to download some media for the transcript.");
  }

  if (messages.length) {
    try {
      saveTicketMessages(ticket.id, messages);
    } catch (err) {
      console.error("[tickets] save messages failed:", err);
      warnings.push("Failed to persist message rows.");
    }
  }

  let relativePath = null;
  try {
    const written = writeTranscriptFile(
      {
        ...ticket,
        close_reason: closeReason,
        closed_at: ticket.closed_at || Date.now(),
      },
      token,
      messages,
      {
        guildName: opts.guildName || channel.guild?.name,
        closeReason,
        closedAt: ticket.closed_at || Date.now(),
        requesterLabel: labels.requesterLabel,
        staffOwnerLabel: labels.staffOwnerLabel,
        closedByLabel:
          labels.closedByLabel !== "—" ? labels.closedByLabel : null,
        token,
      },
    );
    relativePath = written.relativePath;
  } catch (err) {
    console.error("[tickets] HTML write failed:", err);
    warnings.push("Failed to write HTML transcript.");
  }

  const summary = await summarizeTicket(
    { ...ticket, close_reason: closeReason },
    messages,
    { closeReason },
  );

  const publicUrl = relativePath ? transcriptPublicUrl(token) : null;

  const archived = closeTicketArchived(ticket.id, {
    closedBy: archivedBy,
    closeReason,
    transcriptToken: relativePath ? token : null,
    transcriptPath: relativePath,
    aiSummaryJson: JSON.stringify(summary),
    archiveMessageId: null,
  });

  const archiveMsgId = await postArchiveEmbed(
    client,
    archived || ticket,
    summary,
    publicUrl,
    { closeReason, transcriptToken: token },
  ).catch((err) => {
    console.error("[tickets] archive embed failed:", err);
    return null;
  });

  if (!archiveMsgId) {
    warnings.push(
      "Archive channel missing or unwritable — summary embed not posted.",
    );
  } else if (archived) {
    setTicketArchiveMessageId(archived.id, archiveMsgId);
  }

  try {
    if (channel?.delete) await channel.delete("Ticket archived");
  } catch (err) {
    warnings.push(`Could not delete channel: ${err?.message || err}`);
  }

  return {
    ticket: archived || getTicketById(ticket.id) || ticket,
    warnings,
  };
}

module.exports = {
  fetchAllMessages,
  normalizeDiscordMessage,
  softCloseTicket,
  archiveTicketPipeline,
  postSensitiveStub,
  postArchiveEmbed,
  /** @deprecated use softCloseTicket + archiveTicketPipeline */
  closeTicketPipeline: async (opts) => {
    // Backward-compatible: soft-close only (no destroy)
    return softCloseTicket({
      ...opts,
      closedBy: opts.closedBy || opts.archivedBy,
    });
  },
};
