/**
 * Warning system — permanent formal disciplinary records.
 *
 * Slash: /warn add|list|info|void|count|mine|export|settings, /setwarn dm|log|expiry
 * Staff ops: requireStaff. /warn mine: any member (own history).
 * /setwarn: staff gate (requireStaff).
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
  AttachmentBuilder,
} = require("discord.js");
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
  MAX_EVIDENCE_TEXT,
  MAX_EXPIRY_DAYS,
  normalizeEvidenceMessageUrl,
  normalizeEvidenceText,
  normalizeExpiryDays,
  resolveExpiryDays,
} = require("../../db");
const { requireStaff } = require("../../core/permissions");
const { replyEphemeral } = require("../../core/interaction");
const { logConfigChange, logWarnEvent } = require("../logs/auditLog");
const { buildStaffRecordMarkdown, exportFilename } = require("./exportRecord");
const { startWarnExpiryTicker } = require("./ticker");
const {
  Color,
  formatWarnRef,
  formatNoteRef,
  tsRelative,
  tsFull: fullTs,
} = require("../../core/theme");

const staffPerms = PermissionFlagsBits.ManageGuild;

/** Default page size for /warn list */
const LIST_PAGE_SIZE = 10;
/** Snippet length in list embeds */
const SNIPPET_LEN = 80;

const COLOR_ISSUE = Color.danger;
const COLOR_VOID = Color.muted;
const COLOR_INFO = Color.caution;

const commands = [
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription(
      "Issue and manage formal member warnings (staff); view your own with mine.",
    )
    // No defaultMemberPermissions — /warn mine must be visible to all members.
    // Staff subcommands are gated in the handler via requireStaff.
    .addSubcommand((sc) =>
      sc
        .setName("add")
        .setDescription("Issue a formal warning to a member.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member to warn")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("Why this warning is being issued")
            .setRequired(true)
            .setMaxLength(MAX_WARN_REASON),
        )
        .addBooleanOption((opt) =>
          opt
            .setName("silent")
            .setDescription("Skip DM to the member for this warning only")
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("note")
            .setDescription(
              "Optional staff note number to link (e.g. 12 from N-12)",
            )
            .setRequired(false)
            .setMinValue(1),
        )
        .addStringOption((opt) =>
          opt
            .setName("message")
            .setDescription("Optional Discord message link as evidence")
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName("evidence")
            .setDescription("Optional staff-only evidence notes")
            .setRequired(false)
            .setMaxLength(MAX_EVIDENCE_TEXT),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("expires_days")
            .setDescription(
              "Days until auto-void (0=never). Omit to use guild default.",
            )
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(MAX_EXPIRY_DAYS),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("list")
        .setDescription("List warnings for a member.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member to list warnings for")
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("page")
            .setDescription("Page number (default 1)")
            .setRequired(false)
            .setMinValue(1),
        )
        .addBooleanOption((opt) =>
          opt
            .setName("include_voided")
            .setDescription("Include voided warnings (default false)")
            .setRequired(false),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("info")
        .setDescription("Show full detail for a single warning.")
        .addIntegerOption((opt) =>
          opt
            .setName("id")
            .setDescription("Warning number (e.g. 12 from W-12)")
            .setRequired(true)
            .setMinValue(1),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("void")
        .setDescription("Void a warning (row kept forever with paper trail).")
        .addIntegerOption((opt) =>
          opt
            .setName("id")
            .setDescription("Warning number (e.g. 12 from W-12)")
            .setRequired(true)
            .setMinValue(1),
        )
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("Why this warning is being voided")
            .setRequired(true)
            .setMaxLength(MAX_WARN_REASON),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("count")
        .setDescription("Active warning count for a member.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member to count")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("mine")
        .setDescription("View your own warnings in this server.")
        .addBooleanOption((opt) =>
          opt
            .setName("include_voided")
            .setDescription("Include voided warnings (default false)")
            .setRequired(false),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("export")
        .setDescription(
          "Export notes + warnings for a member as a staff handoff file.",
        )
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member to export")
            .setRequired(true),
        )
        .addBooleanOption((opt) =>
          opt
            .setName("include_voided")
            .setDescription("Include voided warnings (default true)")
            .setRequired(false),
        )
        .addBooleanOption((opt) =>
          opt
            .setName("include_deleted_notes")
            .setDescription("Include soft-deleted staff notes (default true)")
            .setRequired(false),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("settings")
        .setDescription("Show warning system settings and access info."),
    ),

  new SlashCommandBuilder()
    .setName("setwarn")
    .setDescription("Configure warning system guild settings.")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommand((sc) =>
      sc
        .setName("dm")
        .setDescription("Toggle DMs to members on warn issue/void.")
        .addBooleanOption((opt) =>
          opt
            .setName("enabled")
            .setDescription("Send DMs when warnings are issued or voided")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) => {
      const sub = sc
        .setName("log")
        .setDescription(
          "Set a dedicated staff channel for warning issue/void logs.",
        );
      sub.addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Channel for warning issue/void embeds")
          .setRequired(false)
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
          ),
      );
      sub.addBooleanOption((opt) =>
        opt
          .setName("clear")
          .setDescription(
            "Clear dedicated warn log (fall back to audit log only)",
          )
          .setRequired(false),
      );
      return sub;
    })
    .addSubcommand((sc) =>
      sc
        .setName("expiry")
        .setDescription(
          "Default auto-void after N days for new warnings (0 = never).",
        )
        .addIntegerOption((opt) =>
          opt
            .setName("days")
            .setDescription("Days until new warnings expire (0 = never)")
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(MAX_EXPIRY_DAYS),
        ),
    ),
];

/**
 * @param {string} content
 * @param {number} [max]
 * @returns {string}
 */
function snippet(content, max = SNIPPET_LEN) {
  const s = String(content || "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * @param {object} warn
 * @returns {string}
 */
function formatListLine(warn) {
  const ref = formatWarnRef(warn.warning_number);
  const voided = warn.voided_at != null ? " · ~~voided~~" : "";
  const exp =
    warn.voided_at == null && warn.expires_at != null
      ? ` · expires ${tsRelative(warn.expires_at)}`
      : "";
  return (
    `**${ref}** · by <@${warn.issuer_id}> · ${tsRelative(warn.created_at)}${voided}${exp}\n` +
    `> ${snippet(warn.reason)}`
  );
}

/**
 * Whether guild settings allow member DMs for warnings.
 * @param {string} guildId
 * @returns {boolean}
 */
function warnDmEnabled(guildId) {
  const s = getGuildSettings(guildId);
  return Number(s.warn_dm_members ?? 1) !== 0;
}

/**
 * @param {string} guildId
 * @returns {number}
 */
function guildWarnExpiryDays(guildId) {
  const s = getGuildSettings(guildId);
  const n = Number(s.warn_expiry_days ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), MAX_EXPIRY_DAYS);
}

/**
 * Best-effort DM to a user. Never throws; never rolls back DB.
 * @param {import("discord.js").User} user
 * @param {object} payload
 * @returns {Promise<boolean>} true if sent
 */
async function tryDmUser(user, payload) {
  if (!user || typeof user.send !== "function") return false;
  try {
    await user.send(payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleWarn(interaction, ctx) {
  const sub = interaction.options.getSubcommand();

  if (sub === "mine") {
    return handleMine(interaction);
  }

  if (!(await requireStaff(interaction))) return;

  if (sub === "add") return handleAdd(interaction, ctx);
  if (sub === "list") return handleList(interaction);
  if (sub === "info") return handleInfo(interaction);
  if (sub === "void") return handleVoid(interaction, ctx);
  if (sub === "count") return handleCount(interaction);
  if (sub === "export") return handleExport(interaction);
  if (sub === "settings") return handleSettings(interaction);

  await replyEphemeral(interaction, {
    content: `Unknown subcommand: \`${sub}\``,
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleSetwarn(interaction, ctx) {
  if (!(await requireStaff(interaction))) return;

  const sub = interaction.options.getSubcommand();
  if (sub === "dm") return handleSetDm(interaction, ctx);
  if (sub === "log") return handleSetLog(interaction, ctx);
  if (sub === "expiry") return handleSetExpiry(interaction, ctx);

  await replyEphemeral(interaction, {
    content: `Unknown subcommand: \`${sub}\``,
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleAdd(interaction, ctx) {
  const target = interaction.options.getUser("user", true);
  const reason = interaction.options.getString("reason", true);
  const silent = !!interaction.options.getBoolean("silent");
  const noteNumber = interaction.options.getInteger("note");
  const messageOpt = interaction.options.getString("message");
  const evidenceOpt = interaction.options.getString("evidence");
  const expiresDaysOpt = interaction.options.getInteger("expires_days");

  if (target.bot) {
    await replyEphemeral(interaction, {
      content: "Warnings are for human members, not bots.",
    });
    return;
  }

  const urlCheck = normalizeEvidenceMessageUrl(messageOpt, interaction.guildId);
  if (!urlCheck.ok) {
    await replyEphemeral(interaction, {
      content: urlCheck.error,
    });
    return;
  }

  const evidenceCheck = normalizeEvidenceText(evidenceOpt);
  if (!evidenceCheck.ok) {
    await replyEphemeral(interaction, {
      content: evidenceCheck.error,
    });
    return;
  }

  let relatedNoteId = null;
  if (noteNumber != null) {
    const note = getStaffNote(interaction.guildId, noteNumber);
    if (!note) {
      await replyEphemeral(interaction, {
        content: `No staff note **N-${noteNumber}** in this server. Omit \`note\` or use a valid note number.`,
      });
      return;
    }
    relatedNoteId = note.id;
  }

  const guildDefaultDays = guildWarnExpiryDays(interaction.guildId);
  const effectiveDays = resolveExpiryDays({
    expiresDays: expiresDaysOpt,
    guildDefaultDays,
  });

  let warn;
  try {
    warn = createWarning({
      guildId: interaction.guildId,
      userId: target.id,
      issuerId: interaction.user.id,
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
      await replyEphemeral(interaction, {
        content: err.message,
      });
      return;
    }
    console.error("[warnings] create failed:", err);
    await replyEphemeral(interaction, {
      content: "Failed to save the warning (database error).",
    });
    return;
  }

  const activeCount = countActiveWarnings(interaction.guildId, target.id);
  const ref = formatWarnRef(warn.warning_number);

  await logWarnEvent(interaction.client, interaction.guildId, {
    title: "Warning issued",
    command: "/warn add",
    actor: interaction.user,
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
  if (!silent && warnDmEnabled(interaction.guildId)) {
    const guildName = interaction.guild?.name || "this server";
    const dmFields = [
      { name: "Warning", value: ref, inline: true },
      {
        name: "Issued by",
        value: interaction.user.username || interaction.user.tag || "staff",
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

    const dmEmbed = new EmbedBuilder()
      .setColor(COLOR_ISSUE)
      .setTitle(`Warning issued in ${guildName}`)
      .addFields(dmFields)
      .setFooter({ text: "View your history anytime with /warn mine" });

    const sent = await tryDmUser(target, { embeds: [dmEmbed] });
    dmNote = sent
      ? "Member notified by DM."
      : "Could not DM the member (DMs closed or blocked).";
  } else if (!silent) {
    dmNote = "Member DMs are disabled for this server (`/setwarn dm`).";
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR_ISSUE)
    .setTitle(`Warning ${ref} issued`)
    .setDescription(warn.reason.slice(0, 4000))
    .addFields(
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
    )
    .setFooter({ text: "Staff only" });

  if (warn.related_note_id != null) {
    embed.addFields({
      name: "Linked note",
      value:
        noteNumber != null
          ? formatNoteRef(noteNumber)
          : `id ${warn.related_note_id}`,
      inline: true,
    });
  }
  if (warn.evidence_message_url) {
    embed.addFields({
      name: "Evidence message",
      value: warn.evidence_message_url,
      inline: false,
    });
  }
  if (warn.evidence_text) {
    embed.addFields({
      name: "Evidence notes",
      value: warn.evidence_text.slice(0, 1024),
      inline: false,
    });
  }

  await replyEphemeral(interaction, {
    embeds: [embed],
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
async function handleList(interaction) {
  const target = interaction.options.getUser("user", true);
  const page = interaction.options.getInteger("page") || 1;
  const includeVoided = !!interaction.options.getBoolean("include_voided");
  const offset = (page - 1) * LIST_PAGE_SIZE;

  const total = countWarnings(interaction.guildId, target.id, {
    includeVoided,
  });
  const warnings = listWarnings(interaction.guildId, target.id, {
    includeVoided,
    limit: LIST_PAGE_SIZE,
    offset,
  });
  const totalPages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  const active = countActiveWarnings(interaction.guildId, target.id);

  if (!warnings.length) {
    await replyEphemeral(interaction, {
      content:
        total === 0
          ? `No${includeVoided ? "" : " active"} warnings for <@${target.id}>.`
          : `No warnings on page **${page}** for <@${target.id}> (pages 1–${totalPages}).`,
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

  await replyEphemeral(interaction, {
    content: `${header}\n\n${lines.join("\n\n")}`.slice(0, 1900),
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
async function handleInfo(interaction) {
  const warningNumber = interaction.options.getInteger("id", true);
  const warn = getWarning(interaction.guildId, warningNumber);

  if (!warn) {
    await replyEphemeral(interaction, {
      content: `No warning **${formatWarnRef(warningNumber)}** in this server.`,
    });
    return;
  }

  const active = countActiveWarnings(interaction.guildId, warn.user_id);
  const embed = new EmbedBuilder()
    .setColor(warn.voided_at != null ? COLOR_VOID : COLOR_INFO)
    .setTitle(`Warning ${formatWarnRef(warn.warning_number)}`)
    .setDescription(warn.reason.slice(0, 4000))
    .addFields(
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
    );

  if (warn.related_note_id != null) {
    const linked = getStaffNoteById(warn.related_note_id);
    embed.addFields({
      name: "Linked note",
      value: linked ? `N-${linked.note_number}` : `id ${warn.related_note_id}`,
      inline: true,
    });
  }

  if (warn.evidence_message_url) {
    embed.addFields({
      name: "Evidence message",
      value: warn.evidence_message_url,
      inline: false,
    });
  }
  if (warn.evidence_text) {
    embed.addFields({
      name: "Evidence notes",
      value: String(warn.evidence_text).slice(0, 1024),
      inline: false,
    });
  }

  if (warn.voided_at != null) {
    embed.addFields(
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

  await replyEphemeral(interaction, {
    embeds: [embed],
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleVoid(interaction, ctx) {
  const warningNumber = interaction.options.getInteger("id", true);
  const voidReason = interaction.options.getString("reason", true);

  let warn;
  try {
    warn = voidWarning(interaction.guildId, warningNumber, {
      voidedBy: interaction.user.id,
      voidReason,
    });
  } catch (err) {
    if (err?.code === "INVALID_REASON") {
      await replyEphemeral(interaction, {
        content: err.message,
      });
      return;
    }
    if (err?.code === "ALREADY_VOIDED") {
      await replyEphemeral(interaction, {
        content: err.message,
      });
      return;
    }
    console.error("[warnings] void failed:", err);
    await replyEphemeral(interaction, {
      content: "Failed to void the warning (database error).",
    });
    return;
  }

  if (!warn) {
    await replyEphemeral(interaction, {
      content: `No warning **${formatWarnRef(warningNumber)}** in this server.`,
    });
    return;
  }

  const activeCount = countActiveWarnings(interaction.guildId, warn.user_id);
  const ref = formatWarnRef(warn.warning_number);

  await logWarnEvent(interaction.client, interaction.guildId, {
    title: "Warning voided",
    command: "/warn void",
    actor: interaction.user,
    changes: [
      `${ref} on <@${warn.user_id}>`,
      `Remaining active: **${activeCount}**`,
      snippet(warn.void_reason, 120),
    ],
  }).catch(() => {});

  let dmNote = "DM not sent (guild DMs off).";
  if (warnDmEnabled(interaction.guildId)) {
    const guildName = interaction.guild?.name || "this server";
    let targetUser = null;
    try {
      targetUser =
        interaction.client?.users?.cache?.get?.(warn.user_id) ||
        (await interaction.client?.users
          ?.fetch?.(warn.user_id)
          .catch(() => null));
    } catch {
      targetUser = null;
    }
    if (!targetUser && interaction.guild?.members) {
      try {
        const mem = await interaction.guild.members
          .fetch(warn.user_id)
          .catch(() => null);
        targetUser = mem?.user || null;
      } catch {
        targetUser = null;
      }
    }

    if (targetUser) {
      const dmEmbed = new EmbedBuilder()
        .setColor(COLOR_VOID)
        .setTitle(`Warning voided in ${guildName}`)
        .addFields(
          { name: "Warning", value: ref, inline: true },
          {
            name: "Voided by",
            value: interaction.user.username || "staff",
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
        )
        .setFooter({ text: "View your history anytime with /warn mine" });

      const sent = await tryDmUser(targetUser, { embeds: [dmEmbed] });
      dmNote = sent
        ? "Member notified by DM."
        : "Could not DM the member (DMs closed or blocked).";
    } else {
      dmNote = "Could not resolve member for DM.";
    }
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR_VOID)
    .setTitle(`Warning ${ref} voided`)
    .addFields(
      { name: "Subject", value: `<@${warn.user_id}>`, inline: true },
      { name: "Voided by", value: `<@${warn.voided_by}>`, inline: true },
      { name: "Active remaining", value: String(activeCount), inline: true },
      { name: "Void reason", value: (warn.void_reason || "—").slice(0, 1024) },
      { name: "Notification", value: dmNote, inline: false },
    )
    .setFooter({ text: "Staff only" });

  await replyEphemeral(interaction, {
    embeds: [embed],
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
async function handleCount(interaction) {
  const target = interaction.options.getUser("user", true);
  const active = countActiveWarnings(interaction.guildId, target.id);
  const total = countWarnings(interaction.guildId, target.id, {
    includeVoided: true,
  });
  const recent = listWarnings(interaction.guildId, target.id, {
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

  await replyEphemeral(interaction, {
    content: body.slice(0, 1900),
  });
}

/**
 * Staff handoff export: notes + warnings as an ephemeral markdown attachment.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
async function handleExport(interaction) {
  const target = interaction.options.getUser("user", true);
  const includeVoided =
    interaction.options.getBoolean("include_voided") !== false;
  const includeDeletedNotes =
    interaction.options.getBoolean("include_deleted_notes") !== false;

  const warnings = listWarnings(interaction.guildId, target.id, {
    includeVoided,
    limit: 5000,
    export: true,
  });
  const notes = listStaffNotes(interaction.guildId, target.id, {
    includeDeleted: includeDeletedNotes,
    limit: 5000,
    export: true,
  });

  const activeWarnings = countActiveWarnings(interaction.guildId, target.id);
  const totalWarnings = countWarnings(interaction.guildId, target.id, {
    includeVoided: true,
  });
  const activeNotes = countStaffNotes(interaction.guildId, target.id, {
    includeDeleted: false,
  });
  const totalNotes = countStaffNotes(interaction.guildId, target.id, {
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
  const body = buildStaffRecordMarkdown({
    guildId: interaction.guildId,
    guildName: interaction.guild?.name,
    userId: target.id,
    userTag: target.tag || target.username,
    exportedById: interaction.user.id,
    exportedByTag: interaction.user.tag || interaction.user.username,
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
  const file = new AttachmentBuilder(Buffer.from(body, "utf8"), {
    name: filename,
  });

  await replyEphemeral(interaction, {
    content:
      `Staff record for <@${target.id}>: **${warnings.length}** warning(s), ` +
      `**${notes.length}** note(s) in file.\n` +
      `_Ephemeral — staff handoff only; do not share with the subject._`,
    files: [file],
  });
}

/**
 * Member self-service: own warnings only.
 * Evidence is staff-only and is not shown here.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
async function handleMine(interaction) {
  const includeVoided = !!interaction.options.getBoolean("include_voided");
  const userId = interaction.user.id;
  const active = countActiveWarnings(interaction.guildId, userId);
  const total = countWarnings(interaction.guildId, userId, { includeVoided });
  const warnings = listWarnings(interaction.guildId, userId, {
    includeVoided,
    limit: LIST_PAGE_SIZE,
    offset: 0,
  });

  if (!warnings.length) {
    await replyEphemeral(interaction, {
      content: includeVoided
        ? "You have no warnings on record in this server."
        : "You have no **active** warnings in this server. Use `include_voided:true` to see full history.",
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

  await replyEphemeral(interaction, {
    content: `${header}\n\n${lines.join("\n\n")}`.slice(0, 1900),
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
async function handleSettings(interaction) {
  const dmOn = warnDmEnabled(interaction.guildId);
  const settings = getGuildSettings(interaction.guildId);
  const expiryDays = guildWarnExpiryDays(interaction.guildId);
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

  await replyEphemeral(interaction, {
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
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleSetDm(interaction, ctx) {
  const enabled = interaction.options.getBoolean("enabled", true);
  const before = warnDmEnabled(interaction.guildId);
  updateGuildSettings(interaction.guildId, {
    warn_dm_members: enabled ? 1 : 0,
  });

  await logConfigChange(interaction.client, interaction.guildId, {
    title: "Warning DM setting changed",
    command: "/setwarn dm",
    actor: interaction.user,
    changes: [
      `Member DMs: **${before ? "on" : "off"}** → **${enabled ? "on" : "off"}**`,
    ],
  }).catch(() => {});

  await replyEphemeral(interaction, {
    content:
      `Warning member DMs are now **${enabled ? "enabled" : "disabled"}**.\n` +
      (enabled
        ? "Members will be DMed when a warning is issued or voided (unless `silent:true` on issue)."
        : "Members will not be DMed. Staff can still use `/warn list` / audit logs."),
  });
}

/**
 * Configure dedicated warning log channel.
 * Issue/void embeds prefer this channel; fall back to audit log when unset.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleSetLog(interaction, ctx) {
  const clear = interaction.options.getBoolean("clear") === true;
  const ch = interaction.options.getChannel("channel", false);
  const settings = getGuildSettings(interaction.guildId);
  const beforeId = settings.warn_log_channel_id;

  if (clear) {
    await logConfigChange(interaction.client, interaction.guildId, {
      title: "Warning log channel cleared",
      command: "/setwarn log",
      actor: interaction.user,
      changes: [
        beforeId
          ? `Warn log: <#${beforeId}> → *none* (fallback to audit log)`
          : "Warn log: was already unset",
      ],
    }).catch(() => {});
    updateGuildSettings(interaction.guildId, { warn_log_channel_id: null });
    const auditFallback = settings.audit_log_channel_id
      ? ` Issue/void will use audit log <#${settings.audit_log_channel_id}>.`
      : " No audit log is set either — issue/void will not post channel embeds until one is configured.";
    await replyEphemeral(interaction, {
      content: `Dedicated warning log channel cleared.${auditFallback}`,
    });
    return;
  }

  if (!ch) {
    await replyEphemeral(interaction, {
      content:
        "Provide a `channel` or set `clear:true`.\n" +
        "Example: `/setwarn log channel:#warn-log`",
    });
    return;
  }

  updateGuildSettings(interaction.guildId, { warn_log_channel_id: ch.id });

  await logConfigChange(interaction.client, interaction.guildId, {
    title: "Warning log channel set",
    command: "/setwarn log",
    actor: interaction.user,
    changes: [
      beforeId
        ? `Warn log: <#${beforeId}> → <#${ch.id}>`
        : `Warn log: *none* → <#${ch.id}>`,
    ],
  }).catch(() => {});

  await replyEphemeral(interaction, {
    content:
      `Warning issue/void embeds will post to ${ch}.\n` +
      `General audit log (\`/setlog audit\`) is unchanged. Clear with \`/setwarn log clear:true\` to fall back to the audit channel.`,
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleSetExpiry(interaction, ctx) {
  const daysRaw = interaction.options.getInteger("days", true);
  const parsed = normalizeExpiryDays(daysRaw);
  if (!parsed.ok) {
    await replyEphemeral(interaction, {
      content: parsed.error,
    });
    return;
  }

  const before = guildWarnExpiryDays(interaction.guildId);
  updateGuildSettings(interaction.guildId, {
    warn_expiry_days: parsed.days,
  });

  await logConfigChange(interaction.client, interaction.guildId, {
    title: "Warning default expiry changed",
    command: "/setwarn expiry",
    actor: interaction.user,
    changes: [
      `Default expiry days: **${before}** → **${parsed.days}**` +
        (parsed.days === 0 ? " (never)" : ""),
    ],
  }).catch(() => {});

  await replyEphemeral(interaction, {
    content:
      parsed.days === 0
        ? "New warnings will **not** expire by default. Staff can still set `expires_days` on `/warn add`."
        : `New warnings will auto-void after **${parsed.days}** day(s) by default.\n` +
          `Override per issue with \`/warn add … expires_days:N\` (use \`0\` for never on that warning only).\n` +
          `Existing warnings are unchanged.`,
  });
}

/**
 * @param {import("discord.js").Client} client
 */
function start(client) {
  startWarnExpiryTicker(client);
}

module.exports = {
  name: "warnings",
  commands,
  handlers: {
    warn: handleWarn,
    setwarn: handleSetwarn,
  },
  start,
  // Exported for unit/integration tests
  formatWarnRef,
  snippet,
  LIST_PAGE_SIZE,
  MAX_WARN_REASON,
  MAX_EVIDENCE_TEXT,
  MAX_EXPIRY_DAYS,
};
