/**
 * Staff notes — private institutional memory about guild members.
 *
 * Slash: /note add|list|edit|delete|info|settings
 * Modals: note:add:<userId> · note:edit:<noteNumber>
 * Access: requireStaff (ManageGuild or staff role).
 * Never shown to the subject member.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const {
  createStaffNote,
  listStaffNotes,
  listRecentStaffNotes,
  countStaffNotes,
  getStaffNote,
  updateStaffNote,
  softDeleteStaffNote,
  MAX_NOTE_CONTENT,
} = require("../../db");
const {
  requireStaff,
  requireStaffFromContext,
} = require("../../core/permissions");
const { replyEphemeral } = require("../../core/interaction");
const { logConfigChange } = require("../logs/auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");
const { getDiscordOutbound } = require("../../platform/discord/outbound");
const { ensureCommunity } = require("../../platform/community");
const { showModalFromContext } = require("../../platform/context");
const {
  Color,
  formatNoteRef,
  tsRelative,
  tsFull: fullTs,
} = require("../../core/theme");

const staffPerms = PermissionFlagsBits.ManageGuild;

/**
 * Edge resolution: translate the interaction's Discord guild snowflake into the
 * internal integer community id (spec § Repository boundary). Every repository
 * call receives the integer; the snowflake stays only for Discord I/O.
 * @param {import("discord.js").GuildInteraction} interaction
 * @returns {number}
 */
function resolveCommunityId(interaction) {
  return ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: interaction.guildId,
  });
}

/** Default page size for /note list */
const LIST_PAGE_SIZE = 10;
/** Guild-wide recent feed cap when no user is given */
const RECENT_GUILD_LIMIT = 15;
/** Snippet length in list embeds */
const SNIPPET_LEN = 80;

/** Modal customId prefixes (registry matches longest prefix) */
const MODAL_PREFIX_ADD = "note:add:";
const MODAL_PREFIX_EDIT = "note:edit:";
/** Text input customId inside note modals */
const MODAL_FIELD_CONTENT = "content";

const commands = [
  new SlashCommandBuilder()
    .setName("note")
    .setDescription("Private staff notes about members (staff only).")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommand((sc) =>
      sc
        .setName("add")
        .setDescription("Create a staff note on a member.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member the note is about")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("content")
            .setDescription("Note body (omit to open a modal for longer text)")
            .setRequired(false)
            .setMaxLength(MAX_NOTE_CONTENT),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("list")
        .setDescription(
          "List staff notes for a member (or recent guild notes).",
        )
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription(
              "Member to list notes for (omit for recent guild-wide)",
            )
            .setRequired(false),
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
            .setName("include_deleted")
            .setDescription("Include soft-deleted notes (default false)")
            .setRequired(false),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("edit")
        .setDescription("Replace the body of a staff note.")
        .addIntegerOption((opt) =>
          opt
            .setName("id")
            .setDescription("Note number (e.g. 12 from N-12)")
            .setRequired(true)
            .setMinValue(1),
        )
        .addStringOption((opt) =>
          opt
            .setName("content")
            .setDescription(
              "New note body (omit to open a modal with the current text)",
            )
            .setRequired(false)
            .setMaxLength(MAX_NOTE_CONTENT),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("delete")
        .setDescription("Soft-delete a staff note (kept for audit).")
        .addIntegerOption((opt) =>
          opt
            .setName("id")
            .setDescription("Note number (e.g. 12 from N-12)")
            .setRequired(true)
            .setMinValue(1),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("info")
        .setDescription("Show full detail for a single staff note.")
        .addIntegerOption((opt) =>
          opt
            .setName("id")
            .setDescription("Note number (e.g. 12 from N-12)")
            .setRequired(true)
            .setMinValue(1),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("settings")
        .setDescription("Show staff notes status and access info."),
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
 * One list line for a note row.
 * @param {object} note
 * @param {object} [opts]
 * @param {boolean} [opts.showUser]
 * @returns {string}
 */
function formatListLine(note, opts = {}) {
  const ref = formatNoteRef(note.note_number);
  const deleted = note.deleted_at != null ? " · ~~deleted~~" : "";
  const userPart = opts.showUser ? ` · subject <@${note.user_id}>` : "";
  const body = snippet(note.content);
  return (
    `**${ref}** · by <@${note.author_id}> · ${tsRelative(note.created_at)}${userPart}${deleted}\n` +
    `> ${body}`
  );
}

/**
 * Modal to write a new note body for a subject user.
 * @param {string} userId
 * @returns {ModalBuilder}
 */
function buildAddNoteModal(userId) {
  const input = new TextInputBuilder()
    .setCustomId(MODAL_FIELD_CONTENT)
    .setLabel("Note body (staff only)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(MAX_NOTE_CONTENT)
    .setPlaceholder("Context for staff — never shown to the member");

  return new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX_ADD}${userId}`)
    .setTitle("Add staff note")
    .addComponents(new ActionRowBuilder().addComponents(input));
}

/**
 * Modal to replace an existing note body (prefilled).
 * @param {number} noteNumber
 * @param {string} [existingContent]
 * @returns {ModalBuilder}
 */
function buildEditNoteModal(noteNumber, existingContent) {
  const input = new TextInputBuilder()
    .setCustomId(MODAL_FIELD_CONTENT)
    .setLabel("Note body (staff only)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(MAX_NOTE_CONTENT);
  if (existingContent) {
    input.setValue(String(existingContent).slice(0, MAX_NOTE_CONTENT));
  }

  const title = `Edit ${formatNoteRef(noteNumber)}`.slice(0, 45);
  return new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX_EDIT}${noteNumber}`)
    .setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(input));
}

/**
 * Build success embed for a created note.
 * Plain NormalizedEmbed object (roadmap/fluxer.md § CommandContext): the
 * Discord adapter wraps it in an EmbedBuilder at the reply boundary; the
 * modal arm passes it to discord.js, which accepts raw embed data too.
 * @param {object} note
 * @param {string} subjectUserId
 * @returns {object}
 */
function buildCreatedEmbed(note, subjectUserId) {
  return {
    title: `Note ${formatNoteRef(note.note_number)} created`,
    description: note.content.slice(0, 4000),
    color: Color.brand,
    fields: [
      { name: "Subject", value: `<@${subjectUserId}>`, inline: true },
      { name: "Author", value: `<@${note.author_id}>`, inline: true },
      { name: "Created", value: fullTs(note.created_at), inline: true },
    ],
    footer: { text: "Staff only — never shown to the member" },
  };
}

/**
 * Build success embed for an updated note (plain NormalizedEmbed).
 * @param {object} note
 * @returns {object}
 */
function buildUpdatedEmbed(note) {
  return {
    title: `Note ${formatNoteRef(note.note_number)} updated`,
    description: note.content.slice(0, 4000),
    color: Color.brand,
    fields: [
      { name: "Subject", value: `<@${note.user_id}>`, inline: true },
      { name: "Edited by", value: `<@${note.edited_by}>`, inline: true },
      { name: "Edited", value: fullTs(note.edited_at), inline: true },
    ],
    footer: { text: "Staff only — never shown to the member" },
  };
}

/**
 * Persist a new note and log audit (shared by slash + modal).
 * @param {object} opts
 * @returns {{ ok: true, note: object } | { ok: false, error: string }}
 */
function persistNewNote(opts) {
  try {
    const note = createStaffNote({
      communityId: opts.communityId,
      userId: opts.userId,
      authorId: opts.authorId,
      content: opts.content,
    });
    return { ok: true, note };
  } catch (err) {
    if (err?.code === "INVALID_CONTENT") {
      return { ok: false, error: err.message };
    }
    console.error("[staffNotes] create failed:", err);
    return {
      ok: false,
      error: `Failed to save the note: ${err?.message || "database error"}`,
    };
  }
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleNote(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireStaffFromContext(commandCtx))) return;

  const sub = commandCtx.subcommand;
  if (sub === "add") return handleAdd(commandCtx, featureCtx);
  if (sub === "list") return handleList(commandCtx, featureCtx);
  if (sub === "edit") return handleEdit(commandCtx, featureCtx);
  if (sub === "delete") return handleDelete(commandCtx, featureCtx);
  if (sub === "info") return handleInfo(commandCtx, featureCtx);
  if (sub === "settings") return handleSettings(commandCtx, featureCtx);

  await commandCtx.reply({
    content: `Unknown subcommand: \`${sub}\``,
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleAdd(commandCtx, featureCtx) {
  void featureCtx;
  const target = commandCtx.options.getUser("user", true);
  const content = commandCtx.options.getString("content");

  if (target.bot) {
    await commandCtx.reply({
      content: "Staff notes are for human members, not bots.",
      sensitive: true,
    });
    return;
  }

  // Omit content → modal for longer text (Discord slash strings are awkward for multi-paragraph).
  // showModalFromContext is the sanctioned modal path (spec: CommandContext has
  // no showModal); it returns false on Fluxer, where the overlay makes content
  // required — so reply with the inline usage line instead.
  if (content == null) {
    const shown = await showModalFromContext(
      commandCtx,
      buildAddNoteModal(target.id),
    );
    if (!shown) {
      await commandCtx.reply({
        content:
          "Pass the note body with the `content` option — this platform can't open the note modal.",
        sensitive: true,
      });
    }
    return;
  }

  const communityId = commandCtx.communityId;
  const result = persistNewNote({
    communityId,
    userId: target.id,
    authorId: commandCtx.userId,
    content,
  });
  if (!result.ok) {
    await commandCtx.reply({
      content: result.error,
      sensitive: true,
    });
    return;
  }

  const note = result.note;
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "notes.add",
    targetType: "note",
    targetId: String(note.id),
    details: {
      note_number: note.note_number,
      subject_user_id: target.id,
      content: snippet(note.content, 500),
    },
  });
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Staff note created",
    command: "/note add",
    actor: commandCtx.user,
    changes: [
      `${formatNoteRef(note.note_number)} on <@${target.id}>`,
      snippet(note.content, 120),
    ],
  }).catch(() => {});

  await commandCtx.reply({
    embeds: [buildCreatedEmbed(note, target.id)],
    sensitive: true,
  });
}

/**
 * Modal submit: create note for userId in customId.
 * @param {import("discord.js").ModalSubmitInteraction} interaction
 * @param {object} [ctx]
 */
async function handleAddNoteModal(interaction, ctx) {
  if (!(await requireStaff(interaction))) return;

  const customId = interaction.customId || "";
  if (!customId.startsWith(MODAL_PREFIX_ADD)) return;
  const userId = customId.slice(MODAL_PREFIX_ADD.length);
  if (!userId) {
    await replyEphemeral(interaction, {
      content: "Invalid modal state (missing user).",
    });
    return;
  }

  let content = "";
  try {
    content = interaction.fields.getTextInputValue(MODAL_FIELD_CONTENT);
  } catch {
    content = "";
  }

  const communityId = resolveCommunityId(interaction);
  const result = persistNewNote({
    communityId,
    userId,
    authorId: interaction.user.id,
    content,
  });
  if (!result.ok) {
    await replyEphemeral(interaction, {
      content: result.error,
    });
    return;
  }

  const note = result.note;
  recordSlashAudit({
    interaction,
    communityId,
    action: "notes.add",
    targetType: "note",
    targetId: String(note.id),
    details: {
      note_number: note.note_number,
      subject_user_id: userId,
      content: snippet(note.content, 500),
    },
  });
  await logConfigChange(
    getDiscordOutbound(ctx?.client || interaction.client),
    interaction.guildId,
    {
      title: "Staff note created",
      command: "/note add (modal)",
      actor: interaction.user,
      changes: [
        `${formatNoteRef(note.note_number)} on <@${userId}>`,
        snippet(note.content, 120),
      ],
    },
  ).catch(() => {});

  await replyEphemeral(interaction, {
    embeds: [buildCreatedEmbed(note, userId)],
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleList(commandCtx, featureCtx) {
  void featureCtx;
  const target = commandCtx.options.getUser("user");
  const page = commandCtx.options.getInteger("page") || 1;
  const includeDeleted = !!commandCtx.options.getBoolean("include_deleted");
  const offset = (page - 1) * LIST_PAGE_SIZE;
  const communityId = commandCtx.communityId;

  if (target) {
    const total = countStaffNotes(communityId, target.id, {
      includeDeleted,
    });
    const notes = listStaffNotes(communityId, target.id, {
      includeDeleted,
      limit: LIST_PAGE_SIZE,
      offset,
    });
    const totalPages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));

    if (!notes.length) {
      await commandCtx.reply({
        content:
          total === 0
            ? `No${includeDeleted ? "" : " active"} staff notes for <@${target.id}>.`
            : `No notes on page **${page}** for <@${target.id}> (pages 1–${totalPages}).`,
        sensitive: true,
      });
      return;
    }

    const lines = notes.map((n) => formatListLine(n));
    const header =
      `**Staff notes for <@${target.id}>**` +
      ` · page ${page}/${totalPages}` +
      ` · ${total} total` +
      (includeDeleted ? " · including deleted" : "");

    await commandCtx.reply({
      content: `${header}\n\n${lines.join("\n\n")}`.slice(0, 1900),
      sensitive: true,
    });
    return;
  }

  // Guild-wide recent feed (capped)
  const total = countStaffNotes(communityId, null, { includeDeleted });
  const notes = listRecentStaffNotes(communityId, {
    includeDeleted,
    limit: RECENT_GUILD_LIMIT,
    offset: 0,
  });

  if (!notes.length) {
    await commandCtx.reply({
      content:
        "No staff notes in this server yet. Use `/note add user:…` (optionally open the content modal).",
      sensitive: true,
    });
    return;
  }

  const lines = notes.map((n) => formatListLine(n, { showUser: true }));
  const header =
    `**Recent staff notes** (last ${notes.length} of ${total})` +
    (includeDeleted ? " · including deleted" : "") +
    `\n_Pass \`user:\` to list notes for one member (paginated)._`;

  await commandCtx.reply({
    content: `${header}\n\n${lines.join("\n\n")}`.slice(0, 1900),
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleEdit(commandCtx, featureCtx) {
  void featureCtx;
  const noteNumber = commandCtx.options.getInteger("id", true);
  const content = commandCtx.options.getString("content");

  const communityId = commandCtx.communityId;
  const existing = getStaffNote(communityId, noteNumber);
  if (!existing) {
    await commandCtx.reply({
      content: `No note **${formatNoteRef(noteNumber)}** in this server.`,
      sensitive: true,
    });
    return;
  }
  if (existing.deleted_at != null) {
    await commandCtx.reply({
      content: `Note **${formatNoteRef(noteNumber)}** is soft-deleted and cannot be edited. Add a new note instead.`,
      sensitive: true,
    });
    return;
  }

  // Omit content → modal prefilled with current body (sanctioned
  // showModalFromContext path; Fluxer replies the inline-usage line instead).
  if (content == null) {
    const shown = await showModalFromContext(
      commandCtx,
      buildEditNoteModal(noteNumber, existing.content),
    );
    if (!shown) {
      await commandCtx.reply({
        content:
          "Pass the new note body with the `content` option — this platform can't open the note modal.",
        sensitive: true,
      });
    }
    return;
  }

  await applyNoteEditContext(commandCtx, noteNumber, content, "/note edit");
}

/**
 * Modal submit: edit note by note_number in customId.
 * @param {import("discord.js").ModalSubmitInteraction} interaction
 * @param {object} [ctx]
 */
async function handleEditNoteModal(interaction, ctx) {
  if (!(await requireStaff(interaction))) return;

  const customId = interaction.customId || "";
  if (!customId.startsWith(MODAL_PREFIX_EDIT)) return;
  const noteNumber = Number(customId.slice(MODAL_PREFIX_EDIT.length));
  if (!Number.isFinite(noteNumber) || noteNumber < 1) {
    await replyEphemeral(interaction, {
      content: "Invalid modal state (missing note id).",
    });
    return;
  }

  let content = "";
  try {
    content = interaction.fields.getTextInputValue(MODAL_FIELD_CONTENT);
  } catch {
    content = "";
  }

  await applyNoteEdit(
    interaction,
    ctx,
    noteNumber,
    content,
    "/note edit (modal)",
  );
}

/**
 * Shared edit core for slash (context arm) + modal (interaction arm).
 * @param {object} target Resolved call-site bundle
 * @param {number} target.communityId internal communities.id
 * @param {string} target.externalGuildId external guild id (audit-log channel lookup)
 * @param {string} target.actorUserId invoker user id (db + audit actor)
 * @param {object} target.actor ResolvedUser / User for the audit embed label
 * @param {object} target.outbound OutboundClient for the audit log
 * @param {(payload: object) => Promise<void>} target.reply ephemeral-style reply
 * @param {number} noteNumber
 * @param {string} content
 * @param {string} auditCommand
 */
async function applyNoteEditCore(target, noteNumber, content, auditCommand) {
  const { communityId, externalGuildId, actorUserId, actor, outbound, reply } =
    target;
  let note;
  try {
    note = updateStaffNote(communityId, noteNumber, {
      content,
      editedBy: actorUserId,
    });
  } catch (err) {
    if (err?.code === "INVALID_CONTENT") {
      await reply({ content: err.message });
      return;
    }
    console.error("[staffNotes] edit failed:", err);
    await reply({
      content: `Failed to update the note: ${err?.message || "database error"}`,
    });
    return;
  }

  if (!note) {
    const existing = getStaffNote(communityId, noteNumber);
    if (existing?.deleted_at != null) {
      await reply({
        content: `Note **${formatNoteRef(noteNumber)}** is soft-deleted and cannot be edited. Add a new note instead.`,
      });
      return;
    }
    await reply({
      content: `No note **${formatNoteRef(noteNumber)}** in this server.`,
    });
    return;
  }

  recordSlashAudit({
    communityId,
    actorUserId,
    action: "notes.update",
    targetType: "note",
    targetId: String(note.id),
    details: {
      note_number: note.note_number,
      subject_user_id: note.user_id,
      content: snippet(note.content, 500),
    },
  });
  await logConfigChange(outbound, externalGuildId, {
    title: "Staff note edited",
    command: auditCommand,
    actor,
    changes: [
      `${formatNoteRef(note.note_number)} on <@${note.user_id}>`,
      snippet(note.content, 120),
    ],
  }).catch(() => {});

  await reply({ embeds: [buildUpdatedEmbed(note)] });
}

/**
 * Interaction-arm (modal submit) wrapper for the shared edit core.
 * @param {import("discord.js").Interaction} interaction
 * @param {object} [ctx]
 * @param {number} noteNumber
 * @param {string} content
 * @param {string} auditCommand
 */
async function applyNoteEdit(
  interaction,
  ctx,
  noteNumber,
  content,
  auditCommand,
) {
  await applyNoteEditCore(
    {
      communityId: resolveCommunityId(interaction),
      externalGuildId: interaction.guildId,
      actorUserId: interaction.user.id,
      actor: interaction.user,
      outbound: getDiscordOutbound(ctx?.client || interaction.client),
      reply: (payload) => replyEphemeral(interaction, payload),
    },
    noteNumber,
    content,
    auditCommand,
  );
}

/**
 * Context-arm (slash) wrapper for the shared edit core.
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {number} noteNumber
 * @param {string} content
 * @param {string} auditCommand
 */
async function applyNoteEditContext(commandCtx, noteNumber, content, auditCommand) {
  await applyNoteEditCore(
    {
      communityId: commandCtx.communityId,
      externalGuildId: commandCtx.externalGuildId,
      actorUserId: commandCtx.userId,
      actor: commandCtx.user,
      outbound: commandCtx.outbound,
      reply: (payload) => commandCtx.reply({ ...payload, sensitive: true }),
    },
    noteNumber,
    content,
    auditCommand,
  );
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleDelete(commandCtx, featureCtx) {
  void featureCtx;
  const noteNumber = commandCtx.options.getInteger("id", true);
  const communityId = commandCtx.communityId;
  const existing = getStaffNote(communityId, noteNumber);

  if (!existing) {
    await commandCtx.reply({
      content: `No note **${formatNoteRef(noteNumber)}** in this server.`,
      sensitive: true,
    });
    return;
  }

  if (existing.deleted_at != null) {
    await commandCtx.reply({
      content:
        `Note **${formatNoteRef(noteNumber)}** is already soft-deleted` +
        (existing.deleted_by ? ` (by <@${existing.deleted_by}>)` : "") +
        `.`,
      sensitive: true,
    });
    return;
  }

  const note = softDeleteStaffNote(communityId, noteNumber, commandCtx.userId);

  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "notes.delete",
    targetType: "note",
    targetId: String(note.id),
    details: {
      note_number: note.note_number,
      subject_user_id: note.user_id,
    },
  });
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Staff note soft-deleted",
    command: "/note delete",
    actor: commandCtx.user,
    changes: [
      `${formatNoteRef(note.note_number)} on <@${note.user_id}>`,
      snippet(note.content, 120),
    ],
  }).catch(() => {});

  await commandCtx.reply({
    content:
      `Soft-deleted **${formatNoteRef(note.note_number)}** about <@${note.user_id}>.` +
      ` The row is kept for audit; use \`/note list include_deleted:true\` to see it.`,
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleInfo(commandCtx, featureCtx) {
  void featureCtx;
  const noteNumber = commandCtx.options.getInteger("id", true);
  const note = getStaffNote(commandCtx.communityId, noteNumber);

  if (!note) {
    await commandCtx.reply({
      content: `No note **${formatNoteRef(noteNumber)}** in this server.`,
      sensitive: true,
    });
    return;
  }

  // Plain NormalizedEmbed — same visible text as the previous EmbedBuilder.
  const fields = [
    { name: "Subject", value: `<@${note.user_id}>`, inline: true },
    { name: "Author", value: `<@${note.author_id}>`, inline: true },
    { name: "Created", value: fullTs(note.created_at), inline: true },
  ];
  if (note.edited_at != null) {
    fields.push({
      name: "Last edited",
      value: `${fullTs(note.edited_at)} by <@${note.edited_by}>`,
      inline: false,
    });
  }
  if (note.deleted_at != null) {
    fields.push({
      name: "Soft-deleted",
      value: `${fullTs(note.deleted_at)} by <@${note.deleted_by}>`,
      inline: false,
    });
  }

  await commandCtx.reply({
    embeds: [
      {
        title: `Note ${formatNoteRef(note.note_number)}`,
        description: note.content.slice(0, 4000),
        color: note.deleted_at != null ? Color.muted : Color.brand,
        fields,
        footer: { text: "Staff only — never shown to the member" },
      },
    ],
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
  const active = countStaffNotes(communityId, null, {
    includeDeleted: false,
  });
  const all = countStaffNotes(communityId, null, {
    includeDeleted: true,
  });
  const deleted = all - active;

  await commandCtx.reply({
    content:
      `**Staff notes settings**\n` +
      `Active notes: **${active}**` +
      (deleted > 0 ? ` · soft-deleted: **${deleted}**` : "") +
      `\nMax content length: **${MAX_NOTE_CONTENT}** characters\n` +
      `\n**Access:** staff gate — Manage Server or any role in \`/staff role list\`.\n` +
      `\n**Commands:** \`/note add\` · \`list\` · \`edit\` · \`delete\` · \`info\`\n` +
      `Omit \`content\` on add/edit to open a **modal** for longer text.\n` +
      `After \`/ticket close\`, use **Add staff note** or the \`staff_note\` option.\n` +
      `Notes are **never** DMed or shown to the subject member. Soft-delete only; no hard delete.`,
    sensitive: true,
  });
}

/**
 * Route modal submits for add + edit prefixes.
 * @param {import("discord.js").ModalSubmitInteraction} interaction
 * @param {object} [ctx]
 */
async function handleNoteModal(interaction, ctx) {
  const id = interaction.customId || "";
  if (id.startsWith(MODAL_PREFIX_ADD)) {
    return handleAddNoteModal(interaction, ctx);
  }
  if (id.startsWith(MODAL_PREFIX_EDIT)) {
    return handleEditNoteModal(interaction, ctx);
  }
}

module.exports = {
  name: "staffNotes",
  commands,
  handlers: {
    note: handleNote,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): the /note
  // slash handler receives a CommandContext; modal submits stay on the
  // interaction arm.
  handlerApi: {
    note: "context",
  },
  modalHandlers: {
    // Longest-prefix match; both prefixes start with "note:" so register both.
    [MODAL_PREFIX_ADD]: handleAddNoteModal,
    [MODAL_PREFIX_EDIT]: handleEditNoteModal,
  },
  // Exported for unit/integration tests
  formatNoteRef,
  snippet,
  buildAddNoteModal,
  buildEditNoteModal,
  MODAL_PREFIX_ADD,
  MODAL_PREFIX_EDIT,
  MODAL_FIELD_CONTENT,
  LIST_PAGE_SIZE,
  RECENT_GUILD_LIMIT,
  handleNoteModal,
};
