/**
 * Staff user card — XP snapshot + note/warning counts with drill-down buttons,
 * plus senior-only Activity (channel/category message rankings).
 *
 * Slash: /userinfo user:<member>
 * Buttons:
 *   ui:o|n|w:<userId>           overview | notes | warnings
 *   ui:a|c:<userId>:<win>       activity channels | categories (win = a|7|30)
 *   ui:b:<userId>               start backfill
 * Access: requireStaff for command and o/n/w; requireSeniorStaff for a/c/b.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
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
const {
  requireStaff,
  requireSeniorStaff,
} = require("../../core/permissions");
const {
  buildChannelRanking,
  buildCategoryRanking,
  normalizeWindow,
} = require("../userActivity/service");
const {
  parseActivityButtonCustomId,
  buildPrimaryButtons,
  buildActivityControlRows,
  buildActivityEmbed,
  activityButtonCustomId,
} = require("../userActivity/render");
const { startUserBackfill } = require("../userActivity/backfill");

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
      "Staff card for a member: XP, notes, warnings, and activity."
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
  return activityButtonCustomId(view, userId);
}

/**
 * @param {string} customId
 * @returns {{ view: string, userId: string, win?: string }|null}
 */
function parseButtonCustomId(customId) {
  return parseActivityButtonCustomId(customId);
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
 * Resolve a displayable user-ish object for embeds.
 * @param {import("discord.js").Interaction} interaction
 * @param {string} userId
 */
async function resolveUser(interaction, userId) {
  if (interaction.user?.id === userId) return interaction.user;

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
      text: "Staff only · Activity tab requires senior staff",
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
 * @param {string} view o|n|w|a|c
 * @param {string} [win]
 */
function buildViewPayload(interaction, user, member, view, win = "a") {
  const counts = loadCounts(interaction.guildId, user.id);
  const w = normalizeWindow(win);
  const joinedMs = member?.joinedTimestamp ?? null;

  if (view === "a" || view === "c") {
    const page = view === "c" ? "categories" : "channels";
    const rankingOpts = {
      guildId: interaction.guildId,
      userId: user.id,
      guild: interaction.guild,
      window: w,
      joinedMs,
    };
    const ranking =
      page === "categories"
        ? buildCategoryRanking(rankingOpts)
        : buildChannelRanking(rankingOpts);
    const embed = buildActivityEmbed(user, ranking, page, joinedMs);
    return {
      embeds: [embed],
      components: [
        buildPrimaryButtons(counts, view, user.id, w),
        ...buildActivityControlRows(user.id, w, view, ranking.meta),
      ],
      flags: MessageFlags.Ephemeral,
    };
  }

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
    components: [buildPrimaryButtons(counts, view === "n" || view === "w" ? view : "o", user.id, w)],
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
  const parsed = parseButtonCustomId(interaction.customId);
  if (!parsed) {
    if (!(await requireStaff(interaction))) return;
    await interaction.reply({
      content: "Unknown userinfo control.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const activityViews = parsed.view === "a" || parsed.view === "c" || parsed.view === "b";
  if (activityViews) {
    if (!(await requireSeniorStaff(interaction))) return;
  } else {
    if (!(await requireStaff(interaction))) return;
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

  if (parsed.view === "b") {
    const result = await startUserBackfill(interaction.guild, parsed.userId);
    // Refresh activity view after queueing
    const payload = buildViewPayload(
      interaction,
      user,
      member,
      "a",
      "a"
    );
    const { flags: _flags, ...updatePayload } = payload;

    if (typeof interaction.update === "function") {
      await interaction.update(updatePayload);
      if (!result.started) {
        await interaction.followUp({
          content: result.reason || "Could not start backfill.",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.followUp({
          content:
            "Backfill started. History older than live tracking is scanned rate-limited; re-open Activity later for progress.",
          flags: MessageFlags.Ephemeral,
        });
      }
    } else {
      await interaction.reply({
        ...payload,
        content: result.started
          ? "Backfill started."
          : result.reason || "Could not start backfill.",
      });
    }
    return;
  }

  const win = parsed.win || "a";
  const payload = buildViewPayload(
    interaction,
    user,
    member,
    parsed.view,
    win
  );
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
