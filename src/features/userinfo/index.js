/**
 * Staff user card — XP snapshot + note/warning counts with drill-down buttons.
 *
 * Slash: /userinfo user:<member>
 * Buttons: ui:o|n|w:<userId>  (overview | notes | warnings)
 * Access: requireStaff for command and every button click.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const {
  getXp,
  getGuildSettings,
  countStaffNotes,
  listStaffNotes,
  countWarnings,
  countActiveWarnings,
  listWarnings,
} = require("../../db");
const { levelFromXp } = require("../../core/xpMath");
const { requireStaff } = require("../../core/permissions");

const adminPerms = PermissionFlagsBits.ManageGuild;

/** customId prefix for button routing */
const BTN_PREFIX = "ui:";
/** Max list lines when expanding notes/warnings */
const LIST_LIMIT = 10;
const SNIPPET_LEN = 80;

const COLOR_CARD = 0x5865f2;
const COLOR_NOTES = 0x9b59b6;
const COLOR_WARNS = 0xe74c3c;

const commands = [
  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription(
      "Staff card for a member: XP, staff notes, and warning counts."
    )
    .setDefaultMemberPermissions(adminPerms)
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("Member to inspect")
        .setRequired(true)
    ),
];

/**
 * @param {"o"|"n"|"w"} view
 * @param {string} userId
 * @returns {string}
 */
function buttonCustomId(view, userId) {
  return `${BTN_PREFIX}${view}:${userId}`;
}

/**
 * @param {string} customId
 * @returns {{ view: "o"|"n"|"w", userId: string }|null}
 */
function parseButtonCustomId(customId) {
  if (!customId || !customId.startsWith(BTN_PREFIX)) return null;
  const rest = customId.slice(BTN_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon < 1) return null;
  const view = rest.slice(0, colon);
  const userId = rest.slice(colon + 1);
  if (!userId || (view !== "o" && view !== "n" && view !== "w")) return null;
  return { view, userId };
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
 * @param {string} guildId
 * @param {string} userId
 */
function loadCounts(guildId, userId) {
  const notesActive = countStaffNotes(guildId, userId, {
    includeDeleted: false,
  });
  const notesTotal = countStaffNotes(guildId, userId, {
    includeDeleted: true,
  });
  const warnsActive = countActiveWarnings(guildId, userId);
  const warnsTotal = countWarnings(guildId, userId, { includeVoided: true });
  return { notesActive, notesTotal, warnsActive, warnsTotal };
}

/**
 * @param {object} counts
 * @param {"o"|"n"|"w"} activeView
 * @param {string} userId
 * @returns {ActionRowBuilder}
 */
function buildButtons(counts, activeView, userId) {
  const notesLabel =
    counts.notesActive === counts.notesTotal
      ? `Notes (${counts.notesActive})`
      : `Notes (${counts.notesActive}/${counts.notesTotal})`;
  const warnsLabel =
    counts.warnsActive === counts.warnsTotal
      ? `Warnings (${counts.warnsActive})`
      : `Warnings (${counts.warnsActive} active)`;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buttonCustomId("o", userId))
      .setLabel("Overview")
      .setStyle(
        activeView === "o" ? ButtonStyle.Primary : ButtonStyle.Secondary
      )
      .setDisabled(activeView === "o"),
    new ButtonBuilder()
      .setCustomId(buttonCustomId("n", userId))
      .setLabel(notesLabel.slice(0, 80))
      .setStyle(
        activeView === "n" ? ButtonStyle.Primary : ButtonStyle.Secondary
      )
      .setDisabled(activeView === "n"),
    new ButtonBuilder()
      .setCustomId(buttonCustomId("w", userId))
      .setLabel(warnsLabel.slice(0, 80))
      .setStyle(
        activeView === "w" ? ButtonStyle.Primary : ButtonStyle.Secondary
      )
      .setDisabled(activeView === "w")
  );
}

/**
 * Resolve a displayable user-ish object for embeds.
 * @param {import("discord.js").Interaction} interaction
 * @param {string} userId
 * @returns {Promise<{ id: string, username: string, bot: boolean, tag?: string, displayAvatarURL?: Function }>}
 */
async function resolveUser(interaction, userId) {
  if (interaction.user?.id === userId) return interaction.user;

  // Prefer guild member user
  try {
    const member = await interaction.guild?.members
      ?.fetch?.(userId)
      .catch(() => null);
    if (member?.user) return member.user;
  } catch {
    // ignore
  }

  try {
    const u = await interaction.client?.users?.fetch?.(userId).catch(() => null);
    if (u) return u;
  } catch {
    // ignore
  }

  return {
    id: userId,
    username: `user_${userId}`,
    bot: false,
  };
}

/**
 * @param {import("discord.js").Interaction} interaction
 * @param {object} user
 * @param {object} [member]
 * @returns {EmbedBuilder}
 */
function buildOverviewEmbed(interaction, user, member) {
  const guildId = interaction.guildId;
  const settings = getGuildSettings(guildId);
  const xp = getXp(guildId, user.id);
  const level = levelFromXp(xp, settings.level_xp_factor);
  const counts = loadCounts(guildId, user.id);

  const embed = new EmbedBuilder()
    .setColor(COLOR_CARD)
    .setTitle("Staff user card")
    .setDescription(`<@${user.id}> · \`${user.id}\``)
    .addFields(
      {
        name: "XP / Level",
        value: `**${xp}** XP · Level **${level}**`,
        inline: true,
      },
      {
        name: "Staff notes",
        value:
          counts.notesActive === counts.notesTotal
            ? `**${counts.notesActive}** active`
            : `**${counts.notesActive}** active · **${counts.notesTotal - counts.notesActive}** deleted`,
        inline: true,
      },
      {
        name: "Warnings",
        value:
          counts.warnsActive === counts.warnsTotal
            ? `**${counts.warnsActive}** active`
            : `**${counts.warnsActive}** active · **${counts.warnsTotal - counts.warnsActive}** voided`,
        inline: true,
      }
    )
    .setFooter({
      text: "Staff only · use buttons to open notes or warnings",
    });

  if (typeof user.displayAvatarURL === "function") {
    try {
      embed.setThumbnail(user.displayAvatarURL({ size: 128 }));
    } catch {
      // ignore
    }
  }

  const username = user.username || user.tag || user.id;
  embed.addFields({
    name: "Username",
    value: username,
    inline: true,
  });

  if (user.bot) {
    embed.addFields({ name: "Bot", value: "Yes", inline: true });
  }

  if (member?.joinedTimestamp) {
    embed.addFields({
      name: "Joined server",
      value: relativeTs(member.joinedTimestamp),
      inline: true,
    });
  }

  if (user.createdTimestamp) {
    embed.addFields({
      name: "Account created",
      value: relativeTs(user.createdTimestamp),
      inline: true,
    });
  }

  return embed;
}

/**
 * @param {string} guildId
 * @param {object} user
 * @returns {EmbedBuilder}
 */
function buildNotesEmbed(guildId, user) {
  const counts = loadCounts(guildId, user.id);
  const notes = listStaffNotes(guildId, user.id, {
    includeDeleted: false,
    limit: LIST_LIMIT,
    offset: 0,
  });

  const embed = new EmbedBuilder()
    .setColor(COLOR_NOTES)
    .setTitle(`Staff notes · ${user.username || user.id}`)
    .setDescription(`Subject: <@${user.id}>`);

  if (!notes.length) {
    embed.addFields({
      name: "Active notes",
      value: "None. Use `/note add` to create one.",
    });
  } else {
    const lines = notes.map((n) => {
      return (
        `**N-${n.note_number}** · by <@${n.author_id}> · ${relativeTs(n.created_at)}\n` +
        `> ${snippet(n.content)}`
      );
    });
    embed.addFields({
      name: `Active notes (showing ${notes.length} of ${counts.notesActive})`,
      value: lines.join("\n\n").slice(0, 1024),
    });
    if (counts.notesActive > LIST_LIMIT) {
      embed.setFooter({
        text: `Use /note list user:@… for full pagination · ${counts.notesTotal - counts.notesActive} soft-deleted`,
      });
    } else if (counts.notesTotal > counts.notesActive) {
      embed.setFooter({
        text: `${counts.notesTotal - counts.notesActive} soft-deleted (see /note list include_deleted:true)`,
      });
    }
  }

  return embed;
}

/**
 * @param {string} guildId
 * @param {object} user
 * @returns {EmbedBuilder}
 */
function buildWarningsEmbed(guildId, user) {
  const counts = loadCounts(guildId, user.id);
  const warnings = listWarnings(guildId, user.id, {
    includeVoided: true,
    limit: LIST_LIMIT,
    offset: 0,
  });

  const embed = new EmbedBuilder()
    .setColor(COLOR_WARNS)
    .setTitle(`Warnings · ${user.username || user.id}`)
    .setDescription(
      `Subject: <@${user.id}> · **${counts.warnsActive}** active` +
        (counts.warnsTotal > counts.warnsActive
          ? ` · **${counts.warnsTotal - counts.warnsActive}** voided`
          : "")
    );

  if (!warnings.length) {
    embed.addFields({
      name: "History",
      value: "No warnings on record. Use `/warn add` to issue one.",
    });
  } else {
    const lines = warnings.map((w) => {
      const voided = w.voided_at != null ? " · ~~voided~~" : "";
      return (
        `**W-${w.warning_number}** · by <@${w.issuer_id}> · ${relativeTs(w.created_at)}${voided}\n` +
        `> ${snippet(w.reason)}`
      );
    });
    embed.addFields({
      name: `History (showing ${warnings.length} of ${counts.warnsTotal})`,
      value: lines.join("\n\n").slice(0, 1024),
    });
    if (counts.warnsTotal > LIST_LIMIT) {
      embed.setFooter({
        text: "Use /warn list user:@… for full pagination",
      });
    }
  }

  return embed;
}

/**
 * Build payload for a given view.
 * @param {import("discord.js").Interaction} interaction
 * @param {object} user
 * @param {object|null} member
 * @param {"o"|"n"|"w"} view
 */
function buildViewPayload(interaction, user, member, view) {
  const counts = loadCounts(interaction.guildId, user.id);
  let embed;
  if (view === "n") {
    embed = buildNotesEmbed(interaction.guildId, user);
  } else if (view === "w") {
    embed = buildWarningsEmbed(interaction.guildId, user);
  } else {
    embed = buildOverviewEmbed(interaction, user, member);
  }

  return {
    embeds: [embed],
    components: [buildButtons(counts, view, user.id)],
    flags: MessageFlags.Ephemeral,
  };
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleUserinfo(interaction, ctx) {
  if (!(await requireStaff(interaction))) return;

  const target = interaction.options.getUser("user", true);
  let member = null;
  try {
    member =
      interaction.options.getMember?.("user") ||
      (await interaction.guild?.members?.fetch?.(target.id).catch(() => null));
  } catch {
    member = null;
  }

  const payload = buildViewPayload(interaction, target, member, "o");
  await interaction.reply(payload);
}

/**
 * @param {import("discord.js").ButtonInteraction} interaction
 * @param {object} [ctx]
 */
async function handleUserinfoButton(interaction, ctx) {
  if (!(await requireStaff(interaction))) return;

  const parsed = parseButtonCustomId(interaction.customId);
  if (!parsed) {
    await interaction.reply({
      content: "Unknown userinfo control.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const user = await resolveUser(interaction, parsed.userId);
  let member = null;
  try {
    member = await interaction.guild?.members
      ?.fetch?.(parsed.userId)
      .catch(() => null);
  } catch {
    member = null;
  }

  const payload = buildViewPayload(interaction, user, member, parsed.view);
  // Drop flags on update — message is already ephemeral
  const { flags: _flags, ...updatePayload } = payload;

  if (typeof interaction.update === "function") {
    await interaction.update(updatePayload);
  } else {
    await interaction.reply(payload);
  }
}

module.exports = {
  name: "userinfo",
  commands,
  handlers: {
    userinfo: handleUserinfo,
  },
  buttonHandlers: {
    [BTN_PREFIX]: handleUserinfoButton,
  },
  // tests
  BTN_PREFIX,
  buttonCustomId,
  parseButtonCustomId,
  LIST_LIMIT,
};
