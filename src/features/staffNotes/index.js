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
  EmbedBuilder,
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
const { requireStaff } = require("../../core/permissions");
const { replyEphemeral } = require("../../core/interaction");
const { logConfigChange } = require("../logs/auditLog");
const {
  Color,
  formatNoteRef,
  tsRelative,
  tsFull: fullTs,
} = require("../../core/theme");

const staffPerms = PermissionFlagsBits.ManageGuild;

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
 * @param {object} note
 * @param {string} subjectUserId
 * @returns {EmbedBuilder}
 */
function buildCreatedEmbed(note, subjectUserId) {
  return new EmbedBuilder()
    .setColor(Color.brand)
    .setTitle(`Note ${formatNoteRef(note.note_number)} created`)
    .setDescription(note.content.slice(0, 4000))
    .addFields(
      { name: "Subject", value: `<@${subjectUserId}>`, inline: true },
      { name: "Author", value: `<@${note.author_id}>`, inline: true },
      { name: "Created", value: fullTs(note.created_at), inline: true },
    )
    .setFooter({ text: "Staff only — never shown to the member" });
}

/**
 * Build success embed for an updated note.
 * @param {object} note
 * @returns {EmbedBuilder}
 */
function buildUpdatedEmbed(note) {
  return new EmbedBuilder()
    .setColor(Color.brand)
    .setTitle(`Note ${formatNoteRef(note.note_number)} updated`)
    .setDescription(note.content.slice(0, 4000))
    .addFields(
      { name: "Subject", value: `<@${note.user_id}>`, inline: true },
      { name: "Edited by", value: `<@${note.edited_by}>`, inline: true },
      { name: "Edited", value: fullTs(note.edited_at), inline: true },
    )
    .setFooter({ text: "Staff only — never shown to the member" });
}

/**
 * Persist a new note and log audit (shared by slash + modal).
 * @param {object} opts
 * @returns {{ ok: true, note: object } | { ok: false, error: string }}
 */
function persistNewNote(opts) {
  try {
    const note = createStaffNote({
      guildId: opts.guildId,
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
    return { ok: false, error: "Failed to save the note (database error)." };
  }
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleNote(interaction, ctx) {
  if (!(await requireStaff(interaction))) return;

  const sub = interaction.options.getSubcommand();
  if (sub === "add") return handleAdd(interaction, ctx);
  if (sub === "list") return handleList(interaction);
  if (sub === "edit") return handleEdit(interaction, ctx);
  if (sub === "delete") return handleDelete(interaction, ctx);
  if (sub === "info") return handleInfo(interaction);
  if (sub === "settings") return handleSettings(interaction);

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
  const content = interaction.options.getString("content");

  if (target.bot) {
    await replyEphemeral(interaction, {
      content: "Staff notes are for human members, not bots.",
    });
    return;
  }

  // Omit content → modal for longer text (Discord slash strings are awkward for multi-paragraph).
  if (content == null) {
    await interaction.showModal(buildAddNoteModal(target.id));
    return;
  }

  const result = persistNewNote({
    guildId: interaction.guildId,
    userId: target.id,
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
  await logConfigChange(interaction.client, interaction.guildId, {
    title: "Staff note created",
    command: "/note add",
    actor: interaction.user,
    changes: [
      `${formatNoteRef(note.note_number)} on <@${target.id}>`,
      snippet(note.content, 120),
    ],
  }).catch(() => {});

  await replyEphemeral(interaction, {
    embeds: [buildCreatedEmbed(note, target.id)],
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

  const result = persistNewNote({
    guildId: interaction.guildId,
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
  await logConfigChange(
    ctx?.client || interaction.client,
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
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
async function handleList(interaction) {
  const target = interaction.options.getUser("user");
  const page = interaction.options.getInteger("page") || 1;
  const includeDeleted = !!interaction.options.getBoolean("include_deleted");
  const offset = (page - 1) * LIST_PAGE_SIZE;

  if (target) {
    const total = countStaffNotes(interaction.guildId, target.id, {
      includeDeleted,
    });
    const notes = listStaffNotes(interaction.guildId, target.id, {
      includeDeleted,
      limit: LIST_PAGE_SIZE,
      offset,
    });
    const totalPages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));

    if (!notes.length) {
      await replyEphemeral(interaction, {
        content:
          total === 0
            ? `No${includeDeleted ? "" : " active"} staff notes for <@${target.id}>.`
            : `No notes on page **${page}** for <@${target.id}> (pages 1–${totalPages}).`,
      });
      return;
    }

    const lines = notes.map((n) => formatListLine(n));
    const header =
      `**Staff notes for <@${target.id}>**` +
      ` · page ${page}/${totalPages}` +
      ` · ${total} total` +
      (includeDeleted ? " · including deleted" : "");

    await replyEphemeral(interaction, {
      content: `${header}\n\n${lines.join("\n\n")}`.slice(0, 1900),
    });
    return;
  }

  // Guild-wide recent feed (capped)
  const total = countStaffNotes(interaction.guildId, null, { includeDeleted });
  const notes = listRecentStaffNotes(interaction.guildId, {
    includeDeleted,
    limit: RECENT_GUILD_LIMIT,
    offset: 0,
  });

  if (!notes.length) {
    await replyEphemeral(interaction, {
      content:
        "No staff notes in this server yet. Use `/note add user:…` (optionally open the content modal).",
    });
    return;
  }

  const lines = notes.map((n) => formatListLine(n, { showUser: true }));
  const header =
    `**Recent staff notes** (last ${notes.length} of ${total})` +
    (includeDeleted ? " · including deleted" : "") +
    `\n_Pass \`user:\` to list notes for one member (paginated)._`;

  await replyEphemeral(interaction, {
    content: `${header}\n\n${lines.join("\n\n")}`.slice(0, 1900),
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleEdit(interaction, ctx) {
  const noteNumber = interaction.options.getInteger("id", true);
  const content = interaction.options.getString("content");

  const existing = getStaffNote(interaction.guildId, noteNumber);
  if (!existing) {
    await replyEphemeral(interaction, {
      content: `No note **${formatNoteRef(noteNumber)}** in this server.`,
    });
    return;
  }
  if (existing.deleted_at != null) {
    await replyEphemeral(interaction, {
      content: `Note **${formatNoteRef(noteNumber)}** is soft-deleted and cannot be edited. Add a new note instead.`,
    });
    return;
  }

  // Omit content → modal prefilled with current body
  if (content == null) {
    await interaction.showModal(
      buildEditNoteModal(noteNumber, existing.content),
    );
    return;
  }

  await applyNoteEdit(interaction, ctx, noteNumber, content, "/note edit");
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
 * Shared edit path for slash + modal.
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
  let note;
  try {
    note = updateStaffNote(interaction.guildId, noteNumber, {
      content,
      editedBy: interaction.user.id,
    });
  } catch (err) {
    if (err?.code === "INVALID_CONTENT") {
      await replyEphemeral(interaction, {
        content: err.message,
      });
      return;
    }
    console.error("[staffNotes] edit failed:", err);
    await replyEphemeral(interaction, {
      content: "Failed to update the note (database error).",
    });
    return;
  }

  if (!note) {
    const existing = getStaffNote(interaction.guildId, noteNumber);
    if (existing?.deleted_at != null) {
      await replyEphemeral(interaction, {
        content: `Note **${formatNoteRef(noteNumber)}** is soft-deleted and cannot be edited. Add a new note instead.`,
      });
      return;
    }
    await replyEphemeral(interaction, {
      content: `No note **${formatNoteRef(noteNumber)}** in this server.`,
    });
    return;
  }

  await logConfigChange(
    ctx?.client || interaction.client,
    interaction.guildId,
    {
      title: "Staff note edited",
      command: auditCommand,
      actor: interaction.user,
      changes: [
        `${formatNoteRef(note.note_number)} on <@${note.user_id}>`,
        snippet(note.content, 120),
      ],
    },
  ).catch(() => {});

  await replyEphemeral(interaction, {
    embeds: [buildUpdatedEmbed(note)],
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleDelete(interaction, ctx) {
  const noteNumber = interaction.options.getInteger("id", true);
  const existing = getStaffNote(interaction.guildId, noteNumber);

  if (!existing) {
    await replyEphemeral(interaction, {
      content: `No note **${formatNoteRef(noteNumber)}** in this server.`,
    });
    return;
  }

  if (existing.deleted_at != null) {
    await replyEphemeral(interaction, {
      content:
        `Note **${formatNoteRef(noteNumber)}** is already soft-deleted` +
        (existing.deleted_by ? ` (by <@${existing.deleted_by}>)` : "") +
        `.`,
    });
    return;
  }

  const note = softDeleteStaffNote(
    interaction.guildId,
    noteNumber,
    interaction.user.id,
  );

  await logConfigChange(interaction.client, interaction.guildId, {
    title: "Staff note soft-deleted",
    command: "/note delete",
    actor: interaction.user,
    changes: [
      `${formatNoteRef(note.note_number)} on <@${note.user_id}>`,
      snippet(note.content, 120),
    ],
  }).catch(() => {});

  await replyEphemeral(interaction, {
    content:
      `Soft-deleted **${formatNoteRef(note.note_number)}** about <@${note.user_id}>.` +
      ` The row is kept for audit; use \`/note list include_deleted:true\` to see it.`,
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
async function handleInfo(interaction) {
  const noteNumber = interaction.options.getInteger("id", true);
  const note = getStaffNote(interaction.guildId, noteNumber);

  if (!note) {
    await replyEphemeral(interaction, {
      content: `No note **${formatNoteRef(noteNumber)}** in this server.`,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(note.deleted_at != null ? Color.muted : Color.brand)
    .setTitle(`Note ${formatNoteRef(note.note_number)}`)
    .setDescription(note.content.slice(0, 4000))
    .addFields(
      { name: "Subject", value: `<@${note.user_id}>`, inline: true },
      { name: "Author", value: `<@${note.author_id}>`, inline: true },
      { name: "Created", value: fullTs(note.created_at), inline: true },
    )
    .setFooter({ text: "Staff only — never shown to the member" });

  if (note.edited_at != null) {
    embed.addFields({
      name: "Last edited",
      value: `${fullTs(note.edited_at)} by <@${note.edited_by}>`,
      inline: false,
    });
  }
  if (note.deleted_at != null) {
    embed.addFields({
      name: "Soft-deleted",
      value: `${fullTs(note.deleted_at)} by <@${note.deleted_by}>`,
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
async function handleSettings(interaction) {
  const active = countStaffNotes(interaction.guildId, null, {
    includeDeleted: false,
  });
  const all = countStaffNotes(interaction.guildId, null, {
    includeDeleted: true,
  });
  const deleted = all - active;

  await replyEphemeral(interaction, {
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
