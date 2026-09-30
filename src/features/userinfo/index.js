/**
 * Staff user card — XP snapshot + note/warning counts with drill-down buttons,
 * plus senior-only Activity (channel/category message rankings).
 *
 * Slash: /userinfo user:<member>          (CommandContext arm)
 * Buttons:
 *   ui:o|n|w:<userId>           overview | notes | warnings
 *   ui:a|c:<userId>:<win>       activity channels | categories (win = a|7|30|90)
 *   ui:b:<userId>               start backfill
 * Access: requireStaff for command and o/n/w; requireSeniorStaff for a/c/b.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
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
const { ensureCommunity } = require("../../platform/community");
// Pre-existing latent bug (present at PR-4 base): the button arm references
// replyEphemeral without importing it, so the "unknown control" and
// backfill-failure paths threw ReferenceError. Restored with the seam.
const { replyEphemeral } = require("../../core/interaction");

/**
 * Fluxer PR 2 Discord edge: external snowflake → internal INTEGER community id
 * (create-on-sight). The data layer is community-keyed.
 * @param {string} guildId external Discord guild id
 * @returns {number} communities.id
 */
function resolveCommunityId(guildId) {
  return ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: String(guildId),
  });
}
const {
  requireStaff,
  requireStaffFromContext,
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
const {
  Color,
  tsRelative,
  formatNoteRef,
  formatWarnRef,
} = require("../../core/theme");

const staffPerms = PermissionFlagsBits.ManageGuild;

/** customId prefix for button routing */
const BTN_PREFIX = "ui:";
/** Max list lines when expanding notes/warnings */
const LIST_LIMIT = 10;
const SNIPPET_LEN = 80;

const COLOR_CARD = Color.brand;
const COLOR_NOTES = Color.config;
const COLOR_WARNS = Color.danger;

const commands = [
  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription(
      "Staff card for a member: XP, notes, warnings, and activity.",
    )
    .setDefaultMemberPermissions(staffPerms)
    .addUserOption((opt) =>
      opt.setName("user").setDescription("Member to inspect").setRequired(true),
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
  const s = String(content || "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * @param {number} communityId internal communities.id (integer key; the
 *   Discord edge resolves snowflakes via resolveCommunityId / commandCtx)
 * @param {string} userId
 */
function loadCounts(communityId, userId) {
  const notesActive = countStaffNotes(communityId, userId, {
    includeDeleted: false,
  });
  const notesTotal = countStaffNotes(communityId, userId, {
    includeDeleted: true,
  });
  const warnsActive = countActiveWarnings(communityId, userId);
  const warnsTotal = countWarnings(communityId, userId, { includeVoided: true });
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
    const u = await interaction.client?.users
      ?.fetch?.(userId)
      .catch(() => null);
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
 * Overview card as a plain NormalizedEmbed (roadmap/fluxer.md § CommandContext):
 * the Discord adapter wraps it in an EmbedBuilder at the reply boundary.
 * @param {number} communityId internal communities.id
 * @param {object} user
 * @param {object} [member]
 * @returns {object}
 */
function buildOverviewEmbed(communityId, user, member) {
  const settings = getGuildSettings(communityId);
  const xp = getXp(communityId, user.id);
  const level = levelFromXp(xp, settings.level_xp_factor);
  const counts = loadCounts(communityId, user.id);

  const embed = {
    title: "Staff user card",
    description: `<@${user.id}> · \`${user.id}\``,
    color: COLOR_CARD,
    fields: [
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
      },
    ],
    footer: {
      text: "Staff only · Activity tab requires senior staff",
    },
  };

  if (typeof user.displayAvatarURL === "function") {
    try {
      embed.thumbnail = { url: user.displayAvatarURL({ size: 128 }) };
    } catch {
      // ignore
    }
  }

  const username = user.username || user.tag || user.id;
  embed.fields.push({
    name: "Username",
    value: username,
    inline: true,
  });

  if (user.bot) {
    embed.fields.push({ name: "Bot", value: "Yes", inline: true });
  }

  if (member?.joinedTimestamp) {
    embed.fields.push({
      name: "Joined server",
      value: tsRelative(member.joinedTimestamp),
      inline: true,
    });
  }

  if (user.createdTimestamp) {
    embed.fields.push({
      name: "Account created",
      value: tsRelative(user.createdTimestamp),
      inline: true,
    });
  }

  return embed;
}

/**
 * @param {number} communityId internal communities.id
 * @param {object} user
 * @returns {object} plain NormalizedEmbed
 */
function buildNotesEmbed(communityId, user) {
  const counts = loadCounts(communityId, user.id);
  const notes = listStaffNotes(communityId, user.id, {
    includeDeleted: false,
    limit: LIST_LIMIT,
    offset: 0,
  });

  const embed = {
    title: `Staff notes · ${user.username || user.id}`,
    description: `Subject: <@${user.id}>`,
    color: COLOR_NOTES,
    fields: [],
    footer: null,
  };

  if (!notes.length) {
    embed.fields.push({
      name: "Active notes",
      value: "None. Use `/note add` to create one.",
      inline: false,
    });
  } else {
    const lines = notes.map((n) => {
      return (
        `**${formatNoteRef(n.note_number)}** · by <@${n.author_id}> · ${tsRelative(n.created_at)}\n` +
        `> ${snippet(n.content)}`
      );
    });
    embed.fields.push({
      name: `Active notes (showing ${notes.length} of ${counts.notesActive})`,
      value: lines.join("\n\n").slice(0, 1024),
      inline: false,
    });
    if (counts.notesActive > LIST_LIMIT) {
      embed.footer = {
        text: `Use /note list user:@… for full pagination · ${counts.notesTotal - counts.notesActive} soft-deleted`,
      };
    } else if (counts.notesTotal > counts.notesActive) {
      embed.footer = {
        text: `${counts.notesTotal - counts.notesActive} soft-deleted (see /note list include_deleted:true)`,
      };
    }
  }

  return embed;
}

/**
 * @param {number} communityId internal communities.id
 * @param {object} user
 * @returns {object} plain NormalizedEmbed
 */
function buildWarningsEmbed(communityId, user) {
  const counts = loadCounts(communityId, user.id);
  const warnings = listWarnings(communityId, user.id, {
    includeVoided: true,
    limit: LIST_LIMIT,
    offset: 0,
  });

  const embed = {
    title: `Warnings · ${user.username || user.id}`,
    description:
      `Subject: <@${user.id}> · **${counts.warnsActive}** active` +
      (counts.warnsTotal > counts.warnsActive
        ? ` · **${counts.warnsTotal - counts.warnsActive}** voided`
        : ""),
    color: COLOR_WARNS,
    fields: [],
    footer: null,
  };

  if (!warnings.length) {
    embed.fields.push({
      name: "History",
      value: "No warnings on record. Use `/warn add` to issue one.",
      inline: false,
    });
  } else {
    const lines = warnings.map((w) => {
      const voided = w.voided_at != null ? " · ~~voided~~" : "";
      return (
        `**${formatWarnRef(w.warning_number)}** · by <@${w.issuer_id}> · ${tsRelative(w.created_at)}${voided}\n` +
        `> ${snippet(w.reason)}`
      );
    });
    embed.fields.push({
      name: `History (showing ${warnings.length} of ${counts.warnsTotal})`,
      value: lines.join("\n\n").slice(0, 1024),
      inline: false,
    });
    if (counts.warnsTotal > LIST_LIMIT) {
      embed.footer = {
        text: "Use /warn list user:@… for full pagination",
      };
    }
  }

  return embed;
}

/**
 * Build payload for a given view (button arm — keeps the raw interaction).
 * @param {import("discord.js").Interaction} interaction
 * @param {object} user
 * @param {object|null} member
 * @param {string} view o|n|w|a|c
 * @param {string} [win]
 */
function buildViewPayload(interaction, user, member, view, win = "a") {
  const communityId = resolveCommunityId(interaction.guildId);
  const counts = loadCounts(communityId, user.id);
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
    embed = buildNotesEmbed(communityId, user);
  } else if (view === "w") {
    embed = buildWarningsEmbed(communityId, user);
  } else {
    embed = buildOverviewEmbed(communityId, user, member);
  }

  return {
    embeds: [embed],
    components: [
      buildPrimaryButtons(
        counts,
        view === "n" || view === "w" ? view : "o",
        user.id,
        w,
      ),
    ],
    flags: MessageFlags.Ephemeral,
  };
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleUserinfo(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireStaffFromContext(commandCtx))) return;

  const target = commandCtx.options.getUser("user", true);
  // MemberHandle carries no joinedTimestamp (spec type) — resolve the member
  // through the outbound, then graft the Discord-only display fields from the
  // builder's documented rawInteraction escape hatch (avatar, join date,
  // account creation). Fluxer contexts never carry rawInteraction; the embed
  // builders render those fields only when present, so Fluxer shows the card
  // without them (roadmap: userinfo is Fluxer v1 without Discord decorations).
  let member = null;
  try {
    member = await commandCtx.outbound.fetchMember(
      commandCtx.communityId,
      target.id,
    );
  } catch {
    member = null;
  }

  const raw = commandCtx.rawInteraction;
  let user = target;
  if (raw?.options && typeof raw.options.getUser === "function") {
    try {
      const rawUser = raw.options.getUser("user", true);
      if (rawUser) {
        user = {
          ...target,
          username: rawUser.username ?? target.username,
          tag: rawUser.tag ?? undefined,
          displayAvatarURL:
            typeof rawUser.displayAvatarURL === "function"
              ? (opts) => rawUser.displayAvatarURL(opts)
              : undefined,
          createdTimestamp: rawUser.createdTimestamp ?? null,
        };
      }
    } catch {
      // decorative fields only — the ResolvedUser fallback stands
    }
  }
  if (member) {
    const rawMember = raw?.guild?.members?.cache?.get?.(target.id) ?? null;
    member = { ...member, joinedTimestamp: rawMember?.joinedTimestamp ?? null };
  }

  const counts = loadCounts(commandCtx.communityId, target.id);
  const embed = buildOverviewEmbed(commandCtx.communityId, user, member);
  await commandCtx.reply({
    embeds: [embed],
    components: [
      buildPrimaryButtons(counts, "o", target.id, normalizeWindow("a")),
    ],
    sensitive: true,
  });
}

/**
 * @param {import("discord.js").ButtonInteraction} interaction
 * @param {object} [ctx]
 */
async function handleUserinfoButton(interaction, ctx) {
  const parsed = parseButtonCustomId(interaction.customId);
  if (!parsed) {
    if (!(await requireStaff(interaction))) return;
    await replyEphemeral(interaction, {
      content: "Unknown userinfo control.",
    });
    return;
  }

  const activityViews =
    parsed.view === "a" || parsed.view === "c" || parsed.view === "b";
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
    const payload = buildViewPayload(interaction, user, member, "a", "a");
    const { flags: _flags, ...updatePayload } = payload;

    if (typeof interaction.update === "function") {
      await interaction.update(updatePayload);
      if (!result.started) {
        await replyEphemeral(interaction, {
          content: result.reason || "Could not start backfill.",
        });
      } else {
        await replyEphemeral(interaction, {
          content:
            "Backfill started. History older than live tracking is scanned rate-limited; re-open Activity later for progress.",
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
  const payload = buildViewPayload(interaction, user, member, parsed.view, win);
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
  // Router API flag (roadmap/fluxer.md § Handler migration rule): the slash
  // handler receives a CommandContext; the ui: button arm stays on the
  // interaction.
  handlerApi: {
    userinfo: "context",
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
