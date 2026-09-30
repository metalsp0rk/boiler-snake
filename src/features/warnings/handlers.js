/**
 * /warn and /setwarn subcommand implementations. Dispatchers live in index.js.
 *
 * Migrated to the CommandContext seam (roadmap/fluxer.md § CommandContext):
 * every handler here receives (commandCtx, featureCtx) and uses only the
 * platform-neutral vocabulary — communityId (integer) for repositories,
 * externalGuildId for display/audit, outbound for platform I/O.
 */
const {
  createWarning,
  listWarnings,
  countWarnings,
  countActiveWarnings,
  getWarning,
  voidWarning,
  getStaffNote,
  getStaffNoteById,
  listStaffNotes,
  countStaffNotes,
  getGuildSettings,
  updateGuildSettings,
  MAX_WARN_REASON,
  MAX_EXPIRY_DAYS,
  normalizeEvidenceMessageUrl,
  normalizeEvidenceText,
  normalizeExpiryDays,
  resolveExpiryDays,
} = require("../../db");
const { logConfigChange, logWarnEvent } = require("../logs/auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");
const { buildStaffRecordMarkdown, exportFilename } = require("./exportRecord");
const {
  formatWarnRef,
  formatNoteRef,
  tsRelative,
  tsFull: fullTs,
} = require("../../core/theme");
const {
  LIST_PAGE_SIZE,
  COLOR_ISSUE,
  COLOR_VOID,
  COLOR_INFO,
} = require("./constants");
const {
  snippet,
  formatListLine,
  warnDmEnabled,
  guildWarnExpiryDays,
} = require("./helpers");

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleAdd(commandCtx, featureCtx) {
  void featureCtx;
  const target = commandCtx.options.getUser("user", true);
  const reason = commandCtx.options.getString("reason", true);
  const silent = !!commandCtx.options.getBoolean("silent");
  const noteNumber = commandCtx.options.getInteger("note");
  const messageOpt = commandCtx.options.getString("message");
  const evidenceOpt = commandCtx.options.getString("evidence");
  const expiresDaysOpt = commandCtx.options.getInteger("expires_days");
  // Repository key: integer community id (resolved by the context builder).
  const communityId = commandCtx.communityId;

  if (target.bot) {
    await commandCtx.reply({
      content: "Warnings are for human members, not bots.",
      sensitive: true,
    });
    return;
  }

  const urlCheck = normalizeEvidenceMessageUrl(
    messageOpt,
    commandCtx.externalGuildId,
  );
  if (!urlCheck.ok) {
    await commandCtx.reply({
      content: urlCheck.error,
      sensitive: true,
    });
    return;
  }

  const evidenceCheck = normalizeEvidenceText(evidenceOpt);
  if (!evidenceCheck.ok) {
    await commandCtx.reply({
      content: evidenceCheck.error,
      sensitive: true,
    });
    return;
  }

  let relatedNoteId = null;
  if (noteNumber != null) {
    const note = getStaffNote(communityId, noteNumber);
    if (!note) {
      await commandCtx.reply({
        content: `No staff note **N-${noteNumber}** in this server. Omit \`note\` or use a valid note number.`,
        sensitive: true,
      });
      return;
    }
    relatedNoteId = note.id;
  }

  const guildDefaultDays = guildWarnExpiryDays(communityId);
  const effectiveDays = resolveExpiryDays({
    expiresDays: expiresDaysOpt,
    guildDefaultDays,
  });

  let warn;
  try {
    warn = createWarning({
      communityId,
      // Evidence URLs embed the external (Discord) snowflake — keep the
      // external id here; the repository stores it verbatim.
      externalGuildId: commandCtx.externalGuildId,
      userId: target.id,
      issuerId: commandCtx.userId,
      reason,
      relatedNoteId,
      expiresDays: expiresDaysOpt,
      guildDefaultDays,
      evidenceMessageUrl: urlCheck.url,
      evidenceText: evidenceCheck.text,
    });
  } catch (err) {
    if (
      err?.code === "INVALID_REASON" ||
      err?.code === "INVALID_NOTE" ||
      err?.code === "INVALID_EVIDENCE_URL" ||
      err?.code === "INVALID_EVIDENCE_TEXT" ||
      err?.code === "INVALID_EXPIRY"
    ) {
      await commandCtx.reply({
        content: err.message,
        sensitive: true,
      });
      return;
    }
    console.error("[warnings] create failed:", err);
    await commandCtx.reply({
      content: `Failed to save the warning: ${err?.message || "database error"}`,
      sensitive: true,
    });
    return;
  }

  const activeCount = countActiveWarnings(communityId, target.id);
  const ref = formatWarnRef(warn.warning_number);

  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "warnings.add",
    targetType: "user",
    targetId: target.id,
    details: {
      warning_id: warn.id,
      warning_number: warn.warning_number,
      reason: warn.reason,
      expires_at: warn.expires_at ?? null,
      silent,
    },
  });

  await logWarnEvent(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Warning issued",
    command: "/warn add",
    actor: commandCtx.user,
    changes: [
      `${ref} on <@${target.id}>`,
      `Active count: **${activeCount}**`,
      snippet(warn.reason, 120),
      warn.expires_at != null
        ? `Expires: ${fullTs(warn.expires_at)}`
        : "Expires: never",
    ],
  }).catch(() => {});

  let dmNote = "DM skipped (silent).";
  if (!silent && warnDmEnabled(communityId)) {
    // Guild display name via outbound (fetchGuild reads the cache first).
    const guild = await commandCtx.outbound.fetchGuild(communityId);
    const guildName = guild?.name || "this server";
    const dmFields = [
      { name: "Warning", value: ref, inline: true },
      {
        name: "Issued by",
        value: commandCtx.user.username || "staff",
        inline: true,
      },
      { name: "Active warnings", value: String(activeCount), inline: true },
      { name: "Reason", value: warn.reason.slice(0, 1024) },
      { name: "When", value: fullTs(warn.created_at), inline: true },
    ];
    if (warn.expires_at != null) {
      dmFields.push({
        name: "Expires",
        value: fullTs(warn.expires_at),
        inline: true,
      });
    }
    // Evidence stays staff-only — not included in member DM.

    // Plain NormalizedEmbed — sendDm payloads accept raw embed data.
    const dmEmbed = {
      title: `Warning issued in ${guildName}`,
      color: COLOR_ISSUE,
      fields: dmFields,
      footer: { text: "View your history anytime with /warn mine" },
    };

    const sent = await commandCtx.outbound.sendDm(target.id, {
      embeds: [dmEmbed],
    });
    if (sent?.ok) {
      dmNote = "Member notified by DM.";
    } else {
      console.error(
        `[warnings] DM to ${target.id} failed: ${sent?.error || "unknown"}`,
      );
      dmNote = "Could not DM the member (DMs closed or blocked).";
    }
  } else if (!silent) {
    dmNote = "Member DMs are disabled for this server (`/setwarn dm`).";
  }

  // Plain NormalizedEmbed — same visible text as the previous EmbedBuilder.
  const fields = [
    { name: "Subject", value: `<@${target.id}>`, inline: true },
    { name: "Issuer", value: `<@${warn.issuer_id}>`, inline: true },
    { name: "Active count", value: String(activeCount), inline: true },
    { name: "Created", value: fullTs(warn.created_at), inline: true },
    {
      name: "Expires",
      value:
        warn.expires_at != null
          ? `${fullTs(warn.expires_at)} (${effectiveDays}d)`
          : "Never",
      inline: true,
    },
    { name: "Notification", value: dmNote, inline: false },
  ];
  if (warn.related_note_id != null) {
    fields.push({
      name: "Linked note",
      value:
        noteNumber != null
          ? formatNoteRef(noteNumber)
          : `id ${warn.related_note_id}`,
      inline: true,
    });
  }
  if (warn.evidence_message_url) {
    fields.push({
      name: "Evidence message",
      value: warn.evidence_message_url,
      inline: false,
    });
  }
  if (warn.evidence_text) {
    fields.push({
      name: "Evidence notes",
      value: warn.evidence_text.slice(0, 1024),
      inline: false,
    });
  }

  await commandCtx.reply({
    embeds: [
      {
        title: `Warning ${ref} issued`,
        description: warn.reason.slice(0, 4000),
        color: COLOR_ISSUE,
        fields,
        footer: { text: "Staff only" },
      },
    ],
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleList(commandCtx, featureCtx) {
  void featureCtx;
  const target = commandCtx.options.getUser("user", true);
  const page = commandCtx.options.getInteger("page") || 1;
  const includeVoided = !!commandCtx.options.getBoolean("include_voided");
  const offset = (page - 1) * LIST_PAGE_SIZE;
  const communityId = commandCtx.communityId;

  const total = countWarnings(communityId, target.id, {
    includeVoided,
  });
  const warnings = listWarnings(communityId, target.id, {
    includeVoided,
    limit: LIST_PAGE_SIZE,
    offset,
  });
  const totalPages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  const active = countActiveWarnings(communityId, target.id);

  if (!warnings.length) {
    await commandCtx.reply({
      content:
        total === 0
          ? `No${includeVoided ? "" : " active"} warnings for <@${target.id}>.`
          : `No warnings on page **${page}** for <@${target.id}> (pages 1–${totalPages}).`,
      sensitive: true,
    });
    return;
  }

  const lines = warnings.map((w) => formatListLine(w));
  const header =
    `**Warnings for <@${target.id}>**` +
    ` · page ${page}/${totalPages}` +
    ` · **${active}** active` +
    (includeVoided
      ? ` · ${total} total (incl. voided)`
      : ` · ${total} listed`) +
    (includeVoided ? " · including voided" : "");

  await commandCtx.reply({
    content: `${header}\n\n${lines.join("\n\n")}`.slice(0, 1900),
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleInfo(commandCtx, featureCtx) {
  void featureCtx;
  const warningNumber = commandCtx.options.getInteger("id", true);
  const communityId = commandCtx.communityId;
  const warn = getWarning(communityId, warningNumber);

  if (!warn) {
    await commandCtx.reply({
      content: `No warning **${formatWarnRef(warningNumber)}** in this server.`,
      sensitive: true,
    });
    return;
  }

  const active = countActiveWarnings(communityId, warn.user_id);
  // Plain NormalizedEmbed — same visible text as the previous EmbedBuilder.
  const fields = [
    { name: "Subject", value: `<@${warn.user_id}>`, inline: true },
    { name: "Issuer", value: `<@${warn.issuer_id}>`, inline: true },
    {
      name: "Status",
      value: warn.voided_at != null ? "Voided" : "Active",
      inline: true,
    },
    { name: "Created", value: fullTs(warn.created_at), inline: true },
    {
      name: "Expires",
      value: warn.expires_at != null ? fullTs(warn.expires_at) : "Never",
      inline: true,
    },
    {
      name: "Subject active count",
      value: String(active),
      inline: true,
    },
  ];

  if (warn.related_note_id != null) {
    const linked = getStaffNoteById(warn.related_note_id);
    fields.push({
      name: "Linked note",
      value: linked ? `N-${linked.note_number}` : `id ${warn.related_note_id}`,
      inline: true,
    });
  }

  if (warn.evidence_message_url) {
    fields.push({
      name: "Evidence message",
      value: warn.evidence_message_url,
      inline: false,
    });
  }
  if (warn.evidence_text) {
    fields.push({
      name: "Evidence notes",
      value: String(warn.evidence_text).slice(0, 1024),
      inline: false,
    });
  }

  if (warn.voided_at != null) {
    fields.push(
      {
        name: "Voided",
        value: `${fullTs(warn.voided_at)} by <@${warn.voided_by}>`,
        inline: false,
      },
      {
        name: "Void reason",
        value: (warn.void_reason || "—").slice(0, 1024),
        inline: false,
      },
    );
  }

  await commandCtx.reply({
    embeds: [
      {
        title: `Warning ${formatWarnRef(warn.warning_number)}`,
        description: warn.reason.slice(0, 4000),
        color: warn.voided_at != null ? COLOR_VOID : COLOR_INFO,
        fields,
      },
    ],
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleVoid(commandCtx, featureCtx) {
  void featureCtx;
  const warningNumber = commandCtx.options.getInteger("id", true);
  const voidReason = commandCtx.options.getString("reason", true);
  const communityId = commandCtx.communityId;

  let warn;
  try {
    warn = voidWarning(communityId, warningNumber, {
      voidedBy: commandCtx.userId,
      voidReason,
    });
  } catch (err) {
    if (err?.code === "INVALID_REASON") {
      await commandCtx.reply({
        content: err.message,
        sensitive: true,
      });
      return;
    }
    if (err?.code === "ALREADY_VOIDED") {
      await commandCtx.reply({
        content: err.message,
        sensitive: true,
      });
      return;
    }
    console.error("[warnings] void failed:", err);
    await commandCtx.reply({
      content: `Failed to void the warning: ${err?.message || "database error"}`,
      sensitive: true,
    });
    return;
  }

  if (!warn) {
    await commandCtx.reply({
      content: `No warning **${formatWarnRef(warningNumber)}** in this server.`,
      sensitive: true,
    });
    return;
  }

  const activeCount = countActiveWarnings(communityId, warn.user_id);
  const ref = formatWarnRef(warn.warning_number);

  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "warnings.void",
    targetType: "warning",
    targetId: String(warn.id),
    details: {
      warning_number: warn.warning_number,
      subject_user_id: warn.user_id,
      void_reason: warn.void_reason,
    },
  });

  await logWarnEvent(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Warning voided",
    command: "/warn void",
    actor: commandCtx.user,
    changes: [
      `${ref} on <@${warn.user_id}>`,
      `Remaining active: **${activeCount}**`,
      snippet(warn.void_reason, 120),
    ],
  }).catch(() => {});

  let dmNote = "DM not sent (guild DMs off).";
  if (warnDmEnabled(communityId)) {
    // Guild display name + subject resolution via outbound (null = not found).
    const guild = await commandCtx.outbound.fetchGuild(communityId);
    const guildName = guild?.name || "this server";
    const targetUser = await commandCtx.outbound.fetchUser(
      communityId,
      warn.user_id,
    );

    if (targetUser) {
      // Plain NormalizedEmbed — sendDm payloads accept raw embed data.
      const dmEmbed = {
        title: `Warning voided in ${guildName}`,
        color: COLOR_VOID,
        fields: [
          { name: "Warning", value: ref, inline: true },
          {
            name: "Voided by",
            value: commandCtx.user.username || "staff",
            inline: true,
          },
          {
            name: "Active warnings remaining",
            value: String(activeCount),
            inline: true,
          },
          {
            name: "Void reason",
            value: (warn.void_reason || "—").slice(0, 1024),
          },
        ],
        footer: { text: "View your history anytime with /warn mine" },
      };

      const sent = await commandCtx.outbound.sendDm(warn.user_id, {
        embeds: [dmEmbed],
      });
      if (sent?.ok) {
        dmNote = "Member notified by DM.";
      } else {
        console.error(
          `[warnings] DM to ${warn.user_id} failed: ${sent?.error || "unknown"}`,
        );
        dmNote = "Could not DM the member (DMs closed or blocked).";
      }
    } else {
      dmNote = "Could not resolve member for DM.";
    }
  }

  await commandCtx.reply({
    embeds: [
      {
        title: `Warning ${ref} voided`,
        color: COLOR_VOID,
        fields: [
          { name: "Subject", value: `<@${warn.user_id}>`, inline: true },
          { name: "Voided by", value: `<@${warn.voided_by}>`, inline: true },
          {
            name: "Active remaining",
            value: String(activeCount),
            inline: true,
          },
          {
            name: "Void reason",
            value: (warn.void_reason || "—").slice(0, 1024),
          },
          { name: "Notification", value: dmNote, inline: false },
        ],
        footer: { text: "Staff only" },
      },
    ],
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleCount(commandCtx, featureCtx) {
  void featureCtx;
  const target = commandCtx.options.getUser("user", true);
  const communityId = commandCtx.communityId;
  const active = countActiveWarnings(communityId, target.id);
  const total = countWarnings(communityId, target.id, {
    includeVoided: true,
  });
  const recent = listWarnings(communityId, target.id, {
    includeVoided: false,
    limit: 3,
  });

  let body =
    `<@${target.id}> has **${active}** active warning${active === 1 ? "" : "s"}` +
    (total > active ? ` (${total} total including voided)` : "") +
    ".";

  if (recent.length) {
    body +=
      "\n\n**Recent active:**\n" +
      recent.map((w) => formatListLine(w)).join("\n\n");
  }

  await commandCtx.reply({
    content: body.slice(0, 1900),
    sensitive: true,
  });
}

/**
 * Staff handoff export: notes + warnings as an ephemeral markdown attachment.
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleExport(commandCtx, featureCtx) {
  void featureCtx;
  const target = commandCtx.options.getUser("user", true);
  const includeVoided =
    commandCtx.options.getBoolean("include_voided") !== false;
  const includeDeletedNotes =
    commandCtx.options.getBoolean("include_deleted_notes") !== false;
  const communityId = commandCtx.communityId;

  const warnings = listWarnings(communityId, target.id, {
    includeVoided,
    limit: 5000,
    export: true,
  });
  const notes = listStaffNotes(communityId, target.id, {
    includeDeleted: includeDeletedNotes,
    limit: 5000,
    export: true,
  });

  const activeWarnings = countActiveWarnings(communityId, target.id);
  const totalWarnings = countWarnings(communityId, target.id, {
    includeVoided: true,
  });
  const activeNotes = countStaffNotes(communityId, target.id, {
    includeDeleted: false,
  });
  const totalNotes = countStaffNotes(communityId, target.id, {
    includeDeleted: true,
  });

  const notesById = new Map();
  for (const n of notes) {
    notesById.set(Number(n.id), n);
  }
  // Also resolve linked notes not in the notes list (e.g. deleted excluded)
  for (const w of warnings) {
    if (
      w.related_note_id != null &&
      !notesById.has(Number(w.related_note_id))
    ) {
      const linked = getStaffNoteById(w.related_note_id);
      if (linked) notesById.set(Number(linked.id), linked);
    }
  }

  const exportedAt = Date.now();
  const guild = await commandCtx.outbound.fetchGuild(communityId);
  const body = buildStaffRecordMarkdown({
    guildId: commandCtx.externalGuildId,
    guildName: guild?.name,
    userId: target.id,
    // ResolvedUser carries no discriminator tag; username is the label.
    userTag: target.username,
    exportedById: commandCtx.userId,
    exportedByTag: commandCtx.user.username,
    warnings,
    notes,
    activeWarnings,
    totalWarnings,
    activeNotes,
    totalNotes,
    notesById,
    exportedAt,
  });

  const filename = exportFilename(target.id, exportedAt);

  await commandCtx.reply({
    content:
      `Staff record for <@${target.id}>: **${warnings.length}** warning(s), ` +
      `**${notes.length}** note(s) in file.\n` +
      `_Ephemeral — staff handoff only; do not share with the subject._`,
    // Plain { name, data } file entry — the adapter wraps it in AttachmentBuilder.
    files: [{ name: filename, data: Buffer.from(body, "utf8") }],
    sensitive: true,
  });
}

/**
 * Member self-service: own warnings only.
 * Evidence is staff-only and is not shown here.
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleMine(commandCtx, featureCtx) {
  void featureCtx;
  const includeVoided = !!commandCtx.options.getBoolean("include_voided");
  const userId = commandCtx.userId;
  const communityId = commandCtx.communityId;
  const active = countActiveWarnings(communityId, userId);
  const total = countWarnings(communityId, userId, { includeVoided });
  const warnings = listWarnings(communityId, userId, {
    includeVoided,
    limit: LIST_PAGE_SIZE,
    offset: 0,
  });

  if (!warnings.length) {
    await commandCtx.reply({
      content: includeVoided
        ? "You have no warnings on record in this server."
        : "You have no **active** warnings in this server. Use `include_voided:true` to see full history.",
      sensitive: true,
    });
    return;
  }

  const lines = warnings.map((w) => {
    const ref = formatWarnRef(w.warning_number);
    const voided = w.voided_at != null ? " · ~~voided~~" : "";
    const exp =
      w.voided_at == null && w.expires_at != null
        ? ` · expires ${tsRelative(w.expires_at)}`
        : "";
    return (
      `**${ref}** · ${tsRelative(w.created_at)}${voided}${exp}\n` +
      `> ${snippet(w.reason)}`
    );
  });

  const header =
    `**Your warnings** · **${active}** active` +
    (includeVoided
      ? ` · showing ${warnings.length} of ${total} (incl. voided)`
      : "") +
    (warnings.length >= LIST_PAGE_SIZE
      ? `\n_Showing latest ${LIST_PAGE_SIZE}. Ask staff for full history if needed._`
      : "");

  await commandCtx.reply({
    content: `${header}\n\n${lines.join("\n\n")}`.slice(0, 1900),
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleSettings(commandCtx, featureCtx) {
  void featureCtx;
  const communityId = commandCtx.communityId;
  const dmOn = warnDmEnabled(communityId);
  const settings = getGuildSettings(communityId);
  const expiryDays = guildWarnExpiryDays(communityId);
  const dedicated = settings.warn_log_channel_id
    ? `<#${settings.warn_log_channel_id}>`
    : null;
  const audit = settings.audit_log_channel_id
    ? `<#${settings.audit_log_channel_id}>`
    : null;

  let logLine;
  if (dedicated) {
    logLine = `Warning log: ${dedicated} (dedicated; \`/setwarn log\`)`;
  } else if (audit) {
    logLine = `Warning log: ${audit} (fallback to audit log; set dedicated with \`/setwarn log\`)`;
  } else {
    logLine = "Warning log: _not set_ (`/setwarn log` or `/setlog audit`)";
  }

  const expiryLine =
    expiryDays > 0
      ? `Default expiry: **${expiryDays}** day(s) for new warnings (\`/setwarn expiry\`; per-warn override: \`expires_days\` on \`/warn add\`)`
      : "Default expiry: **never** (`/setwarn expiry days:N` to opt in; per-warn `expires_days` still works)";

  await commandCtx.reply({
    content:
      `**Warning system settings**\n` +
      `Member DMs on issue/void: **${dmOn ? "on" : "off"}** (toggle: \`/setwarn dm\`)\n` +
      `${logLine}\n` +
      `${expiryLine}\n` +
      `Max reason length: **${MAX_WARN_REASON}** characters\n` +
      `\n**Access:** staff gate — Manage Server or any role in \`/staff role list\`.\n` +
      `**Members:** \`/warn mine\` to view their own warnings.\n` +
      `\n**Commands:** \`/warn add\` · \`list\` · \`info\` · \`void\` · \`count\` · \`export\` · \`mine\` · \`settings\`\n` +
      `Warnings are **permanent** — void only (never hard-deleted). Pair with \`/note\` for informal context.`,
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleSetDm(commandCtx, featureCtx) {
  void featureCtx;
  const enabled = commandCtx.options.getBoolean("enabled", true);
  const communityId = commandCtx.communityId;
  const before = warnDmEnabled(communityId);
  updateGuildSettings(communityId, {
    warn_dm_members: enabled ? 1 : 0,
  });
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "warnings.dm_set",
    targetType: "guild",
    targetId: commandCtx.externalGuildId,
    details: { before: before ? 1 : 0, after: enabled ? 1 : 0 },
  });

  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Warning DM setting changed",
    command: "/setwarn dm",
    actor: commandCtx.user,
    changes: [
      `Member DMs: **${before ? "on" : "off"}** → **${enabled ? "on" : "off"}**`,
    ],
  }).catch(() => {});

  await commandCtx.reply({
    content:
      `Warning member DMs are now **${enabled ? "enabled" : "disabled"}**.\n` +
      (enabled
        ? "Members will be DMed when a warning is issued or voided (unless `silent:true` on issue)."
        : "Members will not be DMed. Staff can still use `/warn list` / audit logs."),
    sensitive: true,
  });
}

/**
 * Configure dedicated warning log channel.
 * Issue/void embeds prefer this channel; fall back to audit log when unset.
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleSetLog(commandCtx, featureCtx) {
  void featureCtx;
  const clear = commandCtx.options.getBoolean("clear") === true;
  const ch = commandCtx.options.getChannel("channel", false);
  const communityId = commandCtx.communityId;
  const settings = getGuildSettings(communityId);
  const beforeId = settings.warn_log_channel_id;

  if (clear) {
    await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
      title: "Warning log channel cleared",
      command: "/setwarn log",
      actor: commandCtx.user,
      changes: [
        beforeId
          ? `Warn log: <#${beforeId}> → *none* (fallback to audit log)`
          : "Warn log: was already unset",
      ],
    }).catch(() => {});
    updateGuildSettings(communityId, { warn_log_channel_id: null });
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "warnings.log_channel_clear",
      targetType: "guild",
      targetId: commandCtx.externalGuildId,
      details: { previous_channel_id: beforeId ?? null },
    });
    const auditFallback = settings.audit_log_channel_id
      ? ` Issue/void will use audit log <#${settings.audit_log_channel_id}>.`
      : " No audit log is set either — issue/void will not post channel embeds until one is configured.";
    await commandCtx.reply({
      content: `Dedicated warning log channel cleared.${auditFallback}`,
      sensitive: true,
    });
    return;
  }

  if (!ch) {
    await commandCtx.reply({
      content:
        "Provide a `channel` or set `clear:true`.\n" +
        "Example: `/setwarn log channel:#warn-log`",
      sensitive: true,
    });
    return;
  }

  updateGuildSettings(communityId, { warn_log_channel_id: ch.id });
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "warnings.log_channel_set",
    targetType: "channel",
    targetId: ch.id,
    details: { previous_channel_id: beforeId ?? null, channel_id: ch.id },
  });

  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Warning log channel set",
    command: "/setwarn log",
    actor: commandCtx.user,
    changes: [
      beforeId
        ? `Warn log: <#${beforeId}> → <#${ch.id}>`
        : `Warn log: *none* → <#${ch.id}>`,
    ],
  }).catch(() => {});

  await commandCtx.reply({
    content:
      `Warning issue/void embeds will post to <#${ch.id}>.\n` +
      `General audit log (\`/setlog audit\`) is unchanged. Clear with \`/setwarn log clear:true\` to fall back to the audit channel.`,
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleSetExpiry(commandCtx, featureCtx) {
  void featureCtx;
  const daysRaw = commandCtx.options.getInteger("days", true);
  const parsed = normalizeExpiryDays(daysRaw);
  if (!parsed.ok) {
    await commandCtx.reply({
      content: parsed.error,
      sensitive: true,
    });
    return;
  }

  const communityId = commandCtx.communityId;
  const before = guildWarnExpiryDays(communityId);
  updateGuildSettings(communityId, {
    warn_expiry_days: parsed.days,
  });
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "warnings.expiry_set",
    targetType: "guild",
    targetId: commandCtx.externalGuildId,
    details: { previous_days: before, days: parsed.days },
  });

  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Warning default expiry changed",
    command: "/setwarn expiry",
    actor: commandCtx.user,
    changes: [
      `Default expiry days: **${before}** → **${parsed.days}**` +
        (parsed.days === 0 ? " (never)" : ""),
    ],
  }).catch(() => {});

  await commandCtx.reply({
    content:
      parsed.days === 0
        ? "New warnings will **not** expire by default. Staff can still set `expires_days` on `/warn add`."
        : `New warnings will auto-void after **${parsed.days}** day(s) by default.\n` +
          `Override per issue with \`/warn add … expires_days:N\` (use \`0\` for never on that warning only).\n` +
          `Existing warnings are unchanged.`,
    sensitive: true,
  });
}

module.exports = {
  handleAdd,
  handleList,
  handleInfo,
  handleVoid,
  handleCount,
  handleExport,
  handleMine,
  handleSettings,
  handleSetDm,
  handleSetLog,
  handleSetExpiry,
};
