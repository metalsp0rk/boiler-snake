/**
 * Warning system — permanent formal disciplinary records.
 *
 * Slash: /warn add|list|info|void|count|mine|settings, /setwarn dm
 * Staff ops: requireStaff. /warn mine: any member (own history).
 * /setwarn: ManageGuild only.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
} = require("discord.js");
const {
  createWarning,
  listWarnings,
  countWarnings,
  countActiveWarnings,
  getWarning,
  voidWarning,
  getStaffNote,
  getGuildSettings,
  updateGuildSettings,
  MAX_WARN_REASON,
} = require("../../db");
const { requireStaff, requireAdmin } = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");

const adminPerms = PermissionFlagsBits.ManageGuild;

/** Default page size for /warn list */
const LIST_PAGE_SIZE = 10;
/** Snippet length in list embeds */
const SNIPPET_LEN = 80;

const COLOR_ISSUE = 0xe74c3c;
const COLOR_VOID = 0x95a5a6;
const COLOR_INFO = 0xfaa61a;

const commands = [
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription(
      "Issue and manage formal member warnings (staff); view your own with mine."
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
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("Why this warning is being issued")
            .setRequired(true)
            .setMaxLength(MAX_WARN_REASON)
        )
        .addBooleanOption((opt) =>
          opt
            .setName("silent")
            .setDescription("Skip DM to the member for this warning only")
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("note")
            .setDescription("Optional staff note number to link (e.g. 12 from N-12)")
            .setRequired(false)
            .setMinValue(1)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("list")
        .setDescription("List warnings for a member.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member to list warnings for")
            .setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("page")
            .setDescription("Page number (default 1)")
            .setRequired(false)
            .setMinValue(1)
        )
        .addBooleanOption((opt) =>
          opt
            .setName("include_voided")
            .setDescription("Include voided warnings (default false)")
            .setRequired(false)
        )
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
            .setMinValue(1)
        )
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
            .setMinValue(1)
        )
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("Why this warning is being voided")
            .setRequired(true)
            .setMaxLength(MAX_WARN_REASON)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("count")
        .setDescription("Active warning count for a member.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member to count")
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("mine")
        .setDescription("View your own warnings in this server.")
        .addBooleanOption((opt) =>
          opt
            .setName("include_voided")
            .setDescription("Include voided warnings (default false)")
            .setRequired(false)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("settings")
        .setDescription("Show warning system settings and access info.")
    ),

  new SlashCommandBuilder()
    .setName("setwarn")
    .setDescription("Configure warning system guild settings.")
    .setDefaultMemberPermissions(adminPerms)
    .addSubcommand((sc) =>
      sc
        .setName("dm")
        .setDescription("Toggle DMs to members on warn issue/void.")
        .addBooleanOption((opt) =>
          opt
            .setName("enabled")
            .setDescription("Send DMs when warnings are issued or voided")
            .setRequired(true)
        )
    ),
];

/**
 * @param {number} warningNumber
 * @returns {string}
 */
function formatWarnRef(warningNumber) {
  return `W-${warningNumber}`;
}

/**
 * @param {string} content
 * @param {number} [max]
 * @returns {string}
 */
function snippet(content, max = SNIPPET_LEN) {
  const s = String(content || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * @param {number|null|undefined} ms
 * @returns {string}
 */
function relativeTs(ms) {
  if (ms == null) return "—";
  const sec = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(sec)) return "—";
  return `<t:${sec}:R>`;
}

/**
 * @param {number|null|undefined} ms
 * @returns {string}
 */
function fullTs(ms) {
  if (ms == null) return "—";
  const sec = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(sec)) return "—";
  return `<t:${sec}:F>`;
}

/**
 * @param {object} warn
 * @returns {string}
 */
function formatListLine(warn) {
  const ref = formatWarnRef(warn.warning_number);
  const voided = warn.voided_at != null ? " · ~~voided~~" : "";
  return (
    `**${ref}** · by <@${warn.issuer_id}> · ${relativeTs(warn.created_at)}${voided}\n` +
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
  if (sub === "settings") return handleSettings(interaction);

  await interaction.reply({
    content: `Unknown subcommand: \`${sub}\``,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleSetwarn(interaction, ctx) {
  if (!(await requireAdmin(interaction))) return;

  const sub = interaction.options.getSubcommand();
  if (sub === "dm") return handleSetDm(interaction, ctx);

  await interaction.reply({
    content: `Unknown subcommand: \`${sub}\``,
    flags: MessageFlags.Ephemeral,
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

  if (target.bot) {
    await interaction.reply({
      content: "Warnings are for human members, not bots.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let relatedNoteId = null;
  if (noteNumber != null) {
    const note = getStaffNote(interaction.guildId, noteNumber);
    if (!note) {
      await interaction.reply({
        content: `No staff note **N-${noteNumber}** in this server. Omit \`note\` or use a valid note number.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    relatedNoteId = note.id;
  }

  let warn;
  try {
    warn = createWarning({
      guildId: interaction.guildId,
      userId: target.id,
      issuerId: interaction.user.id,
      reason,
      relatedNoteId,
    });
  } catch (err) {
    if (err?.code === "INVALID_REASON" || err?.code === "INVALID_NOTE") {
      await interaction.reply({
        content: err.message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    console.error("[warnings] create failed:", err);
    await interaction.reply({
      content: "Failed to save the warning (database error).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const activeCount = countActiveWarnings(interaction.guildId, target.id);
  const ref = formatWarnRef(warn.warning_number);

  await logConfigChange(interaction.client, interaction.guildId, {
    title: "Warning issued",
    command: "/warn add",
    actor: interaction.user,
    changes: [
      `${ref} on <@${target.id}>`,
      `Active count: **${activeCount}**`,
      snippet(warn.reason, 120),
    ],
  }).catch(() => {});

  let dmNote = "DM skipped (silent).";
  if (!silent && warnDmEnabled(interaction.guildId)) {
    const guildName = interaction.guild?.name || "this server";
    const dmEmbed = new EmbedBuilder()
      .setColor(COLOR_ISSUE)
      .setTitle(`Warning issued in ${guildName}`)
      .addFields(
        { name: "Warning", value: ref, inline: true },
        {
          name: "Issued by",
          value: interaction.user.username || interaction.user.tag || "staff",
          inline: true,
        },
        { name: "Active warnings", value: String(activeCount), inline: true },
        { name: "Reason", value: warn.reason.slice(0, 1024) },
        { name: "When", value: fullTs(warn.created_at), inline: true }
      )
      .setFooter({ text: "View your history anytime with /warn mine" });

    const sent = await tryDmUser(target, { embeds: [dmEmbed] });
    dmNote = sent ? "Member notified by DM." : "Could not DM the member (DMs closed or blocked).";
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
      { name: "Created", value: fullTs(warn.created_at), inline: true }
    )
    .setFooter({ text: dmNote });

  if (warn.related_note_id != null) {
    embed.addFields({
      name: "Linked note",
      value: noteNumber != null ? `N-${noteNumber}` : `id ${warn.related_note_id}`,
      inline: true,
    });
  }

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
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
    await interaction.reply({
      content:
        total === 0
          ? `No${includeVoided ? "" : " active"} warnings for <@${target.id}>.`
          : `No warnings on page **${page}** for <@${target.id}> (pages 1–${totalPages}).`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = warnings.map((w) => formatListLine(w));
  const header =
    `**Warnings for <@${target.id}>**` +
    ` · page ${page}/${totalPages}` +
    ` · **${active}** active` +
    (includeVoided ? ` · ${total} total (incl. voided)` : ` · ${total} listed`) +
    (includeVoided ? " · including voided" : "");

  await interaction.reply({
    content: `${header}\n\n${lines.join("\n\n")}`.slice(0, 1900),
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
async function handleInfo(interaction) {
  const warningNumber = interaction.options.getInteger("id", true);
  const warn = getWarning(interaction.guildId, warningNumber);

  if (!warn) {
    await interaction.reply({
      content: `No warning **${formatWarnRef(warningNumber)}** in this server.`,
      flags: MessageFlags.Ephemeral,
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
      { name: "Status", value: warn.voided_at != null ? "Voided" : "Active", inline: true },
      { name: "Created", value: fullTs(warn.created_at), inline: true },
      {
        name: "Subject active count",
        value: String(active),
        inline: true,
      }
    );

  if (warn.related_note_id != null) {
    embed.addFields({
      name: "Linked note id",
      value: String(warn.related_note_id),
      inline: true,
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
      }
    );
  }

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
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
      await interaction.reply({
        content: err.message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (err?.code === "ALREADY_VOIDED") {
      await interaction.reply({
        content: err.message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    console.error("[warnings] void failed:", err);
    await interaction.reply({
      content: "Failed to void the warning (database error).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!warn) {
    await interaction.reply({
      content: `No warning **${formatWarnRef(warningNumber)}** in this server.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const activeCount = countActiveWarnings(interaction.guildId, warn.user_id);
  const ref = formatWarnRef(warn.warning_number);

  await logConfigChange(interaction.client, interaction.guildId, {
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
        (await interaction.client?.users?.fetch?.(warn.user_id).catch(() => null));
    } catch {
      targetUser = null;
    }
    // Fallback: options user not available; try guild member cache via interaction
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
          }
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
      { name: "Void reason", value: (warn.void_reason || "—").slice(0, 1024) }
    )
    .setFooter({ text: dmNote });

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
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

  await interaction.reply({
    content: body.slice(0, 1900),
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Member self-service: own warnings only.
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
    await interaction.reply({
      content: includeVoided
        ? "You have no warnings on record in this server."
        : "You have no **active** warnings in this server. Use `include_voided:true` to see full history.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = warnings.map((w) => {
    const ref = formatWarnRef(w.warning_number);
    const voided = w.voided_at != null ? " · ~~voided~~" : "";
    return (
      `**${ref}** · ${relativeTs(w.created_at)}${voided}\n` +
      `> ${snippet(w.reason)}`
    );
  });

  const header =
    `**Your warnings** · **${active}** active` +
    (includeVoided ? ` · showing ${warnings.length} of ${total} (incl. voided)` : "") +
    (warnings.length >= LIST_PAGE_SIZE
      ? `\n_Showing latest ${LIST_PAGE_SIZE}. Ask staff for full history if needed._`
      : "");

  await interaction.reply({
    content: `${header}\n\n${lines.join("\n\n")}`.slice(0, 1900),
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
async function handleSettings(interaction) {
  const dmOn = warnDmEnabled(interaction.guildId);
  const settings = getGuildSettings(interaction.guildId);
  const audit = settings.audit_log_channel_id
    ? `<#${settings.audit_log_channel_id}>`
    : "_not set_ (`/setlog audit`)";

  await interaction.reply({
    content:
      `**Warning system settings**\n` +
      `Member DMs on issue/void: **${dmOn ? "on" : "off"}** (toggle: \`/setwarn dm\`)\n` +
      `Staff audit log: ${audit}\n` +
      `Max reason length: **${MAX_WARN_REASON}** characters\n` +
      `\n**Access:** staff gate — Manage Server or any role in \`/staff role list\`.\n` +
      `**Members:** \`/warn mine\` to view their own warnings.\n` +
      `\n**Commands:** \`/warn add\` · \`list\` · \`info\` · \`void\` · \`count\` · \`mine\` · \`settings\`\n` +
      `Warnings are **permanent** — void only (never hard-deleted). Pair with \`/note\` for informal context.`,
    flags: MessageFlags.Ephemeral,
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

  await interaction.reply({
    content:
      `Warning member DMs are now **${enabled ? "enabled" : "disabled"}**.\n` +
      (enabled
        ? "Members will be DMed when a warning is issued or voided (unless `silent:true` on issue)."
        : "Members will not be DMed. Staff can still use `/warn list` / audit logs."),
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = {
  name: "warnings",
  commands,
  handlers: {
    warn: handleWarn,
    setwarn: handleSetwarn,
  },
  // Exported for unit/integration tests
  formatWarnRef,
  snippet,
  LIST_PAGE_SIZE,
  MAX_WARN_REASON,
};
