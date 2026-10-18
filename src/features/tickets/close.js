/**
 * Soft-close (remove non-staff) and archive (transcript + dispose channel).
 */

const { EmbedBuilder } = require("discord.js");
const { Color, formatTicketRef, tsFull } = require("../../core/theme");
const {
  markTicketClosed,
  closeTicketSensitive,
  closeTicketArchived,
  claimTicketArchive,
  releaseTicketArchiveClaim,
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
 * Hard ceiling on one archived transcript (audit #423/LT-6): fetching walks
 * backwards from the NEWEST message, so on cap the OLDEST context is what
 * falls off. Reaching the cap must be loud (rule 5) — the archive is
 * partial by construction there, and the reply says so.
 */
const TRANSCRIPT_MAX_MESSAGES = 5000;

/**
 * Fetch all messages from a channel (oldest → newest).
 * @param {import("discord.js").TextChannel} channel
 * @returns {Promise<object[]>} normalized message rows
 */
async function fetchAllMessages(channel) {
  const collected = [];
  let before = undefined;

  while (collected.length < TRANSCRIPT_MAX_MESSAGES) {
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
 * Embed for the requester archive DM: ticket ref + close reason, plus a
 * transcript link ONLY when a public URL was provided (spec §1.11 Fix 2 —
 * the URL is null unless TICKET_PUBLIC_BASE_URL is configured, and sensitive
 * archives never pass one, so no link can leak).
 * @param {object} ticket
 * @param {string|null} closeReason
 * @param {string|null} transcriptUrl
 * @returns {EmbedBuilder}
 */
function buildArchiveDmEmbed(ticket, closeReason, transcriptUrl) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_ARCHIVE)
    .setTitle(`Ticket ${formatTicketRef(ticket.ticket_number)} archived`)
    .setDescription(
      closeReason
        ? `Your support ticket was closed and archived.\n\n**Reason:** ${String(closeReason).slice(0, 900)}`
        : "Your support ticket was closed and archived.",
    );
  if (transcriptUrl) {
    embed.addFields({
      name: "Transcript",
      value: `[View transcript](${transcriptUrl})`,
    });
  }
  return embed;
}

/**
 * Best-effort archive DM to the requester (creator_user_id only — never other
 * ticket members). Returns `{ ok, error }` instead of replying or throwing:
 * the archive pipeline surfaces failures as warning lines and never aborts
 * the archive because of a closed/blocked DM channel.
 * @param {import("discord.js").Client} client
 * @param {object} ticket
 * @param {string|null} closeReason
 * @param {string|null} transcriptUrl
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function notifyRequesterArchived(
  client,
  ticket,
  closeReason,
  transcriptUrl,
) {
  try {
    const user =
      client?.users?.cache?.get?.(ticket.creator_user_id) ||
      (await client?.users?.fetch?.(ticket.creator_user_id).catch(() => null));
    if (!user?.send) {
      return {
        ok: false,
        error: "requester not reachable (DMs closed or user unavailable)",
      };
    }
    await user.send({
      embeds: [buildArchiveDmEmbed(ticket, closeReason, transcriptUrl)],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
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
  // Ticket rows are keyed by the integer community id (fluxer PR 2).
  const settings = getTicketSettings(ticket.community_id);
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
  // Ticket rows are keyed by the integer community id (fluxer PR 2).
  const settings = getTicketSettings(ticket.community_id);
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
    const { roleIds } = await getManageableStaffRoleIds(guild, botMember);

    await applyTicketOverwrites(channel, {
      // Discord-side surface: overwrites.js works with the EXTERNAL guild
      // snowflake (resolved from the channel), not the internal community id.
      guildId: guild.id,
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
 *
 * Concurrency (audit-2026-10 #197): the pipeline CAS-CLAIMS the ticket
 * (`claimTicketArchive`, atomic UPDATE) BEFORE doing any work. A loser —
 * concurrent `/ticket archive`, retry, or a stale row — returns immediately
 * with `skipped` set to a specific message naming the ticket (never a
 * generic reply); the winner does the work exactly once. The claim is a
 * LEASE (#419, audit LT-2): a throw after the claim releases it (retry is
 * safe, the lifecycle replies carry the cause), and a holder that DIED
 * mid-archive ages out after ARCHIVE_CLAIM_LEASE_MS so the ticket is
 * never permanently wedged by a stale claim.
 *
 * @param {object} opts
 * @param {import("discord.js").Client} opts.client
 * @param {import("discord.js").GuildTextBasedChannel} opts.channel
 * @param {object} opts.ticket
 * @param {string} opts.archivedBy
 * @param {string} [opts.guildName]
 * @param {object} [opts.summaryOpts] Seam forwarded to summarizeTicket
 *   (chatImpl / fetchImpl / setTimer / clearTimer / timeoutMs; tests).
 * @returns {Promise<{ ticket: object, warnings: string[], skipped?: string, error?: string }>}
 *   `skipped` set (and no work done) when another close holds the archive
 *   claim. `error` set when the pipeline ABORTED before any destructive step
 *   (#418): nothing was finalized, the claim was released (retryable), and
 *   the channel was kept — callers must surface the cause, never a
 *   success-flavored reply.
 */
async function archiveTicketPipeline(opts) {
  const ticket = opts.ticket;
  const { archivedBy } = opts;

  // CAS BEFORE WORK (#197): one atomic claim decides who archives. The old
  // in-memory `archived === 1` check let two concurrent closes both do the
  // work (double transcript embeds / DMs / deletes). `archived` itself is
  // untouched until finalize (sensitive rows keep archived=0; web + gork
  // readers unchanged).
  const claim = claimTicketArchive(ticket.id);
  if (!claim.won) {
    const live = claim.ticket || getTicketById(ticket.id) || ticket;
    const ref = formatTicketRef(live.ticket_number ?? ticket.ticket_number);
    const msg =
      Number(live.archived) === 1
        ? `Ticket ${ref} is already archived.`
        : `Ticket ${ref} is already being archived by another close — nothing was done here.`;
    console.warn(
      `[tickets] archive skipped for ${ref} (by ${archivedBy}): ${msg}`
    );
    return { ticket: live || ticket, warnings: [msg], skipped: msg };
  }

  // #419 (audit LT-2): a THROW after the claim is a released claim, not a
  // permanent wedge. Post-claim throws (finalize write, message-id stamp —
  // e.g. the disk-full/busy class migration 034 hardened against) used to
  // propagate with the claim stuck, so every retry blamed a phantom
  // "another close" forever. Release exactly here and rethrow: the
  // lifecycle boundary already answers with the specific cause (rule 3),
  // and the lease self-heals even if this process dies mid-run. After a
  // successful finalize the release is a no-op — its `archived=0` guard.
  try {
    return await archiveTicketWork(opts);
  } catch (err) {
    try {
      releaseTicketArchiveClaim(ticket.id);
    } catch (releaseErr) {
      console.error(
        `[tickets] could not release the archive claim for ticket #${ticket.ticket_number} after a throw:`,
        releaseErr?.message || releaseErr,
      );
    }
    console.error(
      `[tickets] archive pipeline threw after claiming ticket #${ticket.ticket_number} — claim released, retry is safe:`,
      err?.message || err,
    );
    throw err;
  }
}

/**
 * Post-claim archive work for {@link archiveTicketPipeline} (the claim is
 * already won by the time this runs).
 *
 * @param {object} opts same as the pipeline; plus the optional
 *   `finalize` override (test seam, same family as `summaryOpts`) swapping
 *   the finalize write for failure injection.
 * @returns {Promise<{ticket: object, warnings: string[], skipped?: string, error?: string}>}
 */
async function archiveTicketWork(opts) {
  const { client, channel, archivedBy } = opts;
  let ticket = opts.ticket;
  const warnings = [];
  const sensitive = Number(ticket.is_sensitive) === 1;
  const closeReason = ticket.close_reason || null;


  if (sensitive) {
    // Spec §1.11: sensitive branch unchanged — the requester's only DM is the
    // close-time notice ("closed + reason", never a URL; no transcript exists).
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
    // #423 (audit LT-6): the cap used to be silent — a >5k-message ticket
    // got a transcript PRESENTED AS COMPLETE with the oldest (often most
    // relevant) context quietly missing. Partial archive = surfaced partial
    // result (rule 5).
    if (messages.length >= TRANSCRIPT_MAX_MESSAGES) {
      warnings.push(
        `Transcript capped at ${TRANSCRIPT_MAX_MESSAGES} messages — the older messages were NOT archived (the ${TRANSCRIPT_MAX_MESSAGES} newest were kept).`,
      );
    }
  } catch (err) {
    console.error("[tickets] message fetch failed:", err);
    // Rule 3: the archiver must be able to ACT on the warning — name the
    // cause instead of "Failed to fetch some messages for archive."
    warnings.push(
      `Failed to fetch some messages for archive: ${err?.message || err}`,
    );
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
      // Transcript dirs are keyed by the integer community id (spec § Transcript storage).
      communityId: ticket.community_id,
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
    // #418 (audit LT-1): the transcript FILE is the archive. Finalizing or
    // deleting the channel after this failure strands the content
    // (archived marker without a stored token/path → the web surface 404s
    // forever), the archive embed advertises a token for a file that does
    // not exist, and the channel delete destroys the only source a re-run
    // could render. Nothing destructive has happened yet, so release the
    // claim (#418 retryable abort; crash stickiness from #197 stays) and
    // return the specific cause — the channel and rows are kept.
    const cause = err?.message || String(err);
    console.error(
      `[tickets] transcript write failed for ticket #${ticket.ticket_number} — archive aborted:`,
      err
    );
    try {
      releaseTicketArchiveClaim(ticket.id);
    } catch (releaseErr) {
      console.error(
        `[tickets] could not release the archive claim for ticket #${ticket.ticket_number}: ${releaseErr?.message || releaseErr}`,
      );
    }
    return {
      ticket: getTicketById(ticket.id) || ticket,
      warnings: [],
      error:
        `could not write the transcript file: ${cause} — nothing was ` +
        `finalized and the channel was kept. Fix the cause (disk/permissions) ` +
        `and run /ticket archive again.`,
    };
  }

  const summary = await summarizeTicket(
    { ...ticket, close_reason: closeReason },
    messages,
    {
      closeReason,
      ...(opts.summaryOpts ? opts.summaryOpts : {}),
    },
  );
  // The summary service never throws: an AI failure or deadline abort
  // degrades to the stats fallback and carries a `warning` naming the
  // specific cause (AGENTS.md) — surface it to the archiver instead of
  // silently posting a fallback summary. The archive itself COMPLETES.
  if (summary.warning) warnings.push(summary.warning);

  const publicUrl = relativePath ? transcriptPublicUrl(token) : null;

  // Test seam (same family as summaryOpts): the #419 release-on-throw path
  // is pinned against the REAL finalize call site with a throwing stand-in.
  const finalize = opts.finalize ?? closeTicketArchived;
  const archived = finalize(ticket.id, {
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
    // #418: advertise a token ONLY when the transcript file exists. The old
    // unconditional `token` printed a live-looking UUID for a file that was
    // never written and never stored.
    { closeReason, transcriptToken: relativePath ? token : null },
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

  // Spec §1.11 Fix 2: once the archive embed posted, best-effort DM the
  // requester (creator only) with the ref, close reason, and transcript link.
  // publicUrl is null unless TICKET_PUBLIC_BASE_URL is configured, so the
  // link only appears when it is. A failed DM adds a warning line for the
  // archiver (handleArchive surfaces `warnings`) but never fails the archive.
  if (archiveMsgId) {
    const dm = await notifyRequesterArchived(
      client,
      archived || ticket,
      closeReason,
      publicUrl,
    );
    if (!dm.ok) {
      console.warn(
        `[tickets] archive DM to requester ${ticket.creator_user_id} for ticket ${formatTicketRef(ticket.ticket_number)} failed: ${dm.error}`,
      );
      warnings.push(
        `Could not DM the requester the transcript link: ${dm.error}`,
      );
    }
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
  TRANSCRIPT_MAX_MESSAGES,
  normalizeDiscordMessage,
  softCloseTicket,
  archiveTicketPipeline,
  postSensitiveStub,
  postArchiveEmbed,
  notifyRequesterArchived,
  buildArchiveDmEmbed,
  /** @deprecated use softCloseTicket + archiveTicketPipeline */
  closeTicketPipeline: async (opts) => {
    // Backward-compatible: soft-close only (no destroy)
    return softCloseTicket({
      ...opts,
      closedBy: opts.closedBy || opts.archivedBy,
    });
  },
};
