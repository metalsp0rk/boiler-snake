const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const {
  getGuildSettings,
  updateGuildSettings,
  getXp,
  topUsers,
} = require("../../db");
const { levelFromXp, validateXpValue, MAX_XP_AWARD } = require("../../core/xpMath");
const { key, isOnCooldown, sweepCooldownMap } = require("../../core/cooldowns");
const {
  requireAdminFromContext,
  requireStaffFromContext,
} = require("../../core/permissions");
const { replyEphemeral } = require("../../core/interaction");
const { Color } = require("../../core/theme");
const { awardXp } = require("../../services/awardXp");
const { renderLeaderboardPng } = require("../../render/leaderboard");
const { logConfigChange, diffConfigLines } = require("../logs/auditLog");
const { registerJob } = require("../../core/scheduler");
const { recordSlashAudit } = require("../../core/auditTrail");
const { ensureCommunity } = require("../../platform/community");

const staffPerms = PermissionFlagsBits.ManageGuild;
const adminPerms = PermissionFlagsBits.ManageGuild;

const msgCooldown = new Map();
const reactionCooldown = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName("xp")
    .setDescription("Show your XP and level (or another user's).")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("User to check").setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show top XP users.")
    .addIntegerOption((opt) =>
      opt
        .setName("limit")
        .setDescription("Users per page (default 10, max 20)")
        .setMinValue(1)
        .setMaxValue(20)
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("page")
        .setDescription("Page number")
        .setMinValue(1)
        .setMaxValue(20)
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("setxp")
    .setDescription("Set XP values and cooldowns for this guild.")
    .setDefaultMemberPermissions(staffPerms)
    .addIntegerOption((opt) =>
      opt
        .setName("message")
        .setDescription("XP per message")
        .setMinValue(0)
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("reaction")
        .setDescription("Reaction XP per message")
        .setMinValue(0)
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("voice")
        .setDescription("XP per voice minute")
        .setMinValue(0)
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("msgcooldown")
        .setDescription("Message XP cooldown seconds")
        .setMinValue(0)
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("reactioncooldown")
        .setDescription("Reaction XP cooldown seconds")
        .setMinValue(0)
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("factor")
        .setDescription("Level curve factor (XP for level L = L² × factor)")
        .setMinValue(1)
        .setMaxValue(10000)
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("grantxp")
    .setDescription("Grant XP to a user (admin only).")
    .setDefaultMemberPermissions(adminPerms)
    .addUserOption((opt) =>
      opt.setName("user").setDescription("User to grant XP to").setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("amount")
        .setDescription("XP to grant")
        .setMinValue(1)
        .setMaxValue(MAX_XP_AWARD)
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("reason")
        .setDescription("Optional reason (shown in audit log)")
        .setMaxLength(200)
        .setRequired(false)
    ),
];

/**
 * @param {object} commandCtx CommandContext (roadmap/fluxer.md § CommandContext)
 * @param {object} featureCtx
 */
async function handleXp(commandCtx, featureCtx) {
  void featureCtx;
  const settings = getGuildSettings(commandCtx.communityId);
  const target = commandCtx.options.getUser("user") ?? commandCtx.user;
  const xp = getXp(commandCtx.communityId, target.id);
  const level = levelFromXp(xp, settings.level_xp_factor);

  await commandCtx.reply({
    content: `**${target.username}**: **${xp} XP** · Level **${level}**`,
    sensitive: true,
  });
}

/** customId prefix for leaderboard pagination buttons (lb:<userId>:<limit>:<page>) */
const LB_BTN_PREFIX = "lb:";
const LB_PAGE_MIN = 1;
const LB_PAGE_MAX = 20;
const LB_PAGE_DEFAULT = 10;

function clampLeaderboardLimit(value) {
  if (value === null || value === undefined) return LB_PAGE_DEFAULT;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return LB_PAGE_DEFAULT;
  return Math.min(LB_PAGE_MAX, Math.max(LB_PAGE_MIN, n));
}

/**
 * @param {number|null|undefined} value raw "page" option (1-based)
 * @returns {number} page clamped to 1..LB_PAGE_MAX
 */
function clampLeaderboardPage(value) {
  if (value === null || value === undefined) return LB_PAGE_MIN;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return LB_PAGE_MIN;
  return Math.min(LB_PAGE_MAX, Math.max(LB_PAGE_MIN, n));
}

/**
 * @param {string} requesterId
 * @param {number} limit
 * @param {number} page 1-based
 */
function leaderboardButtonCustomId(requesterId, limit, page) {
  return `${LB_BTN_PREFIX}${requesterId}:${limit}:${page}`;
}

/**
 * @param {string} customId
 * @returns {{ requesterId: string, limit: number, page: number } | null}
 */
function parseLeaderboardButtonCustomId(customId) {
  if (!customId || !customId.startsWith(LB_BTN_PREFIX)) return null;
  const parts = customId.slice(LB_BTN_PREFIX.length).split(":");
  if (parts.length !== 3) return null;
  const [requesterId, limitRaw, pageRaw] = parts;
  const limit = Number(limitRaw);
  const page = Number(pageRaw);
  if (!requesterId) return null;
  if (!Number.isInteger(limit) || limit < LB_PAGE_MIN || limit > LB_PAGE_MAX) {
    return null;
  }
  if (!Number.isInteger(page) || page < 1) return null;
  return { requesterId, limit, page };
}

/**
 * Prev/Next control row for a leaderboard page.
 * @param {string} requesterId
 * @param {number} limit
 * @param {number} page 1-based
 * @param {{ hasPrev: boolean, hasMore: boolean }} flags
 */
function buildLeaderboardControls(requesterId, limit, page, { hasPrev, hasMore }) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(leaderboardButtonCustomId(requesterId, limit, page - 1))
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasPrev),
    new ButtonBuilder()
      .setCustomId(leaderboardButtonCustomId(requesterId, limit, page + 1))
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasMore),
  );
}

/**
 * Build the reply/update payload for one leaderboard page.
 * Fetches `limit * page + 1` rows so "has more" is known without a count query.
 * @param {(userIds: string[]) => Promise<Map<string, string>>} resolveNames
 *   maps user ids to display names; missing ids may be absent from the Map
 *   (callers keep the fetch platform-shaped: Discord batch fetch on the
 *   button arm, outbound fetchMember on the context arm).
 * @param {number} communityId  internal communities.id (resolved by the caller)
 * @param {string} requesterId
 * @param {number} limit
 * @param {number} page 1-based
 */
async function buildLeaderboardPagePayload(resolveNames, communityId, requesterId, limit, page) {
  const settings = getGuildSettings(communityId);
  const factor = Math.max(1, Number(settings.level_xp_factor) || 100);

  const fetchCount = limit * page + 1;
  const rows = topUsers(communityId, fetchCount);
  const hasMore = rows.length === fetchCount;
  const pageRows = rows.slice((page - 1) * limit, page * limit);

  if (!pageRows.length) {
    return {
      empty: true,
      content: "No leaderboard data yet.",
      components: [
        buildLeaderboardControls(requesterId, limit, page, {
          hasPrev: page > 1,
          hasMore: false,
        }),
      ],
    };
  }

  let names = new Map();
  try {
    names = (await resolveNames(pageRows.map((r) => r.user_id))) ?? new Map();
  } catch {
    names = new Map();
  }

  const entries = pageRows.map((r, idx) => {
    const name = names.get(r.user_id) || `User ${r.user_id}`;
    const level = levelFromXp(r.xp, factor);
    return { rank: (page - 1) * limit + idx + 1, name, xp: r.xp, level };
  });

  const first = (page - 1) * limit + 1;
  const last = first + pageRows.length - 1;
  const subtitle =
    page === 1
      ? `Top ${pageRows.length} by XP • Quantum-approved`
      : `Ranks ${first}–${last} • Quantum-approved`;

  const png = renderLeaderboardPng(entries, factor, subtitle);
  const file = new AttachmentBuilder(png, {
    name: "boiler-snake-leaderboard.png",
  });

  return {
    content: `**Leaderboard — ranks ${first}–${last}**`,
    files: [file],
    components: [
      buildLeaderboardControls(requesterId, limit, page, {
        hasPrev: page > 1,
        hasMore,
      }),
    ],
  };
}

/**
 * @param {object} commandCtx CommandContext (roadmap/fluxer.md § CommandContext)
 * @param {object} featureCtx
 */
async function handleLeaderboard(commandCtx, featureCtx) {
  void featureCtx;
  const limit = clampLeaderboardLimit(commandCtx.options.getInteger("limit"));
  const page = clampLeaderboardPage(commandCtx.options.getInteger("page"));
  const { communityId, outbound } = commandCtx;
  // Context-arm resolver: one outbound fetchMember per id, best-effort.
  // fetchMember is {ok}-free (resolves null on failure), so a missing
  // member just falls back to `User <id>` in the renderer.
  const resolveNames = async (ids) => {
    const names = new Map();
    for (const id of ids) {
      try {
        const member = await outbound.fetchMember(communityId, id);
        if (member?.username) names.set(id, member.username);
      } catch {
        // Best-effort: name resolution failures fall back to User <id>.
      }
    }
    return names;
  };
  const payload = await buildLeaderboardPagePayload(
    resolveNames,
    communityId,
    commandCtx.userId,
    limit,
    page,
  );
  if (payload.empty) {
    await commandCtx.reply({ content: payload.content, sensitive: true });
    return;
  }
  // files entries are AttachmentBuilder instances (the reply builder passes
  // them through) and components keep the Discord button rows.
  await commandCtx.reply(payload);
}

/**
 * Prev/Next pagination. Only the user who ran /leaderboard may page.
 * @param {import("discord.js").ButtonInteraction} interaction
 * @param {object} [ctx]
 */
async function handleLeaderboardButton(interaction, ctx) {
  void ctx;
  const parsed = parseLeaderboardButtonCustomId(interaction.customId);
  if (!parsed) return;

  if (parsed.requesterId !== interaction.user.id) {
    await replyEphemeral(interaction, {
      content: "Only the person who ran /leaderboard can page it.",
    });
    return;
  }

  let deferred = false;
  if (typeof interaction.deferUpdate === "function") {
    await interaction.deferUpdate();
    deferred = true;
  }

  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: interaction.guildId,
  });
  // Interaction-arm resolver: the current batch member fetch, best-effort
  // (a failed fetch yields an empty Map → `User <id>` fallbacks).
  const resolveNames = async (ids) => {
    const members = await interaction.guild.members
      .fetch({ user: ids })
      .catch(() => null);
    const names = new Map();
    if (!members) return names;
    for (const id of ids) {
      const m = members.get?.(id) ?? null;
      const name = m?.displayName || m?.user?.username;
      if (name) names.set(id, name);
    }
    return names;
  };
  const payload = await buildLeaderboardPagePayload(
    resolveNames,
    communityId,
    parsed.requesterId,
    parsed.limit,
    parsed.page,
  );
  let finalPayload = payload;
  if (payload.empty) {
    const { empty, ...rest } = payload;
    void empty;
    finalPayload = rest;
  }
  // discord.js >= 14.16: update() throws InteractionAlreadyReplied once the
  // interaction is deferred; editReply() finalizes a deferred message update.
  if (deferred) {
    await interaction.editReply(finalPayload);
  } else {
    await interaction.update(finalPayload);
  }
}

/**
 * @param {object} commandCtx CommandContext (roadmap/fluxer.md § CommandContext)
 * @param {object} featureCtx
 */
async function handleSetXp(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireStaffFromContext(commandCtx))) return;

  const guildId = commandCtx.externalGuildId;
  const communityId = commandCtx.communityId;
  const settings = getGuildSettings(communityId);
  const msg = commandCtx.options.getInteger("message");
  const reaction = commandCtx.options.getInteger("reaction");
  const voice = commandCtx.options.getInteger("voice");
  const msgcooldown = commandCtx.options.getInteger("msgcooldown");
  const reactioncooldown = commandCtx.options.getInteger("reactioncooldown");
  const factor = commandCtx.options.getInteger("factor");

  const errors = [
    validateXpValue(msg, "Message"),
    validateXpValue(reaction, "Reaction"),
    validateXpValue(voice, "Voice"),
  ].filter(Boolean);

  if (errors.length) {
    await commandCtx.reply({ content: errors.join("\n"), sensitive: true });
    return;
  }

  const patch = {};
  if (msg !== null) patch.msg_xp = msg;
  if (reaction !== null) patch.reaction_xp = reaction;
  if (voice !== null) patch.voice_xp_per_min = voice;
  if (msgcooldown !== null) patch.msg_cooldown_sec = msgcooldown;
  if (reactioncooldown !== null) patch.reaction_cooldown_sec = reactioncooldown;
  if (factor !== null) patch.level_xp_factor = factor;

  if (!Object.keys(patch).length) {
    await commandCtx.reply({
      content: "No XP settings provided to update.",
      sensitive: true,
    });
    return;
  }

  const before = settings;
  const updated = updateGuildSettings(communityId, patch);
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "xp.settings_update",
    targetType: "guild",
    targetId: guildId,
    details: { patch },
  });
  const lines = diffConfigLines(before, updated, Object.keys(patch));
  if (lines.length) {
    await logConfigChange(commandCtx.outbound, guildId, {
      title: "XP settings updated",
      command: "/setxp",
      actor: commandCtx.user,
      changes: lines,
    }).catch(() => {});
  }

  // Plain-object embed (NormalizedEmbed): the Discord reply builder maps it
  // to an EmbedBuilder at the adapter edge.
  const fields = [
    { name: "Message XP", value: `**${updated.msg_xp}**`, inline: true },
    { name: "Reaction XP", value: `**${updated.reaction_xp}**`, inline: true },
    {
      name: "Voice XP / min",
      value: `**${updated.voice_xp_per_min}**`,
      inline: true,
    },
    {
      name: "Message cooldown",
      value: `**${updated.msg_cooldown_sec}s**`,
      inline: true,
    },
    {
      name: "Reaction cooldown",
      value: `**${updated.reaction_cooldown_sec}s**`,
      inline: true,
    },
  ];

  if (factor !== null) {
    fields.push({
      name: "level_xp_factor",
      value: `**${settings.level_xp_factor}** → **${updated.level_xp_factor}** (Level L starts at L² × factor)`,
      inline: false,
    });
  }

  await commandCtx.reply({
    embeds: [
      {
        title: "Updated XP settings",
        color: Color.config,
        footer: { text: "Staff only" },
        fields,
      },
    ],
    sensitive: true,
  });
}

/**
 * Admin-only: grant XP to a member. Runs the full award pipeline (roles + audit).
 * @param {object} commandCtx CommandContext (roadmap/fluxer.md § CommandContext)
 * @param {object} featureCtx
 */
async function handleGrantXp(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireAdminFromContext(commandCtx))) return;

  const target = commandCtx.options.getUser("user", true);
  const amount = commandCtx.options.getInteger("amount", true);
  const reason = commandCtx.options.getString("reason");

  if (target.bot) {
    await commandCtx.reply({
      content: "You can’t grant XP to bots.",
      sensitive: true,
    });
    return;
  }

  const amountError = validateXpValue(amount, "Grant");
  if (amountError) {
    await commandCtx.reply({ content: amountError, sensitive: true });
    return;
  }
  if (amount < 1) {
    await commandCtx.reply({
      content: "Amount must be at least 1.",
      sensitive: true,
    });
    return;
  }

  const settings = getGuildSettings(commandCtx.communityId);
  const beforeXp = getXp(commandCtx.communityId, target.id);

  const { newXp, level } = await awardXp(commandCtx.outbound, {
    communityId: commandCtx.communityId,
    externalGuildId: commandCtx.externalGuildId,
    userId: target.id,
    delta: amount,
    activityKind: "admin_grant",
    levelXpFactor: settings.level_xp_factor,
    source: "admin_grant",
  });

  const levelText = level != null ? String(level) : levelFromXp(newXp, settings.level_xp_factor);
  const reasonText = reason?.trim() ? reason.trim() : null;

  recordSlashAudit({
    communityId: commandCtx.communityId,
    actorUserId: commandCtx.userId,
    action: "xp.grant",
    targetType: "user",
    targetId: target.id,
    details: {
      amount,
      before_xp: beforeXp,
      after_xp: newXp,
      reason: reasonText,
    },
  });

  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "XP granted",
    command: "/grantxp",
    actor: commandCtx.user,
    changes: [
      `Target: <@${target.id}> (\`${target.id}\`)`,
      `Amount: **+${amount.toLocaleString()}** XP`,
      `XP: **${beforeXp.toLocaleString()}** → **${newXp.toLocaleString()}**`,
      `Level: **${levelText}**`,
      reasonText ? `Reason: ${reasonText}` : null,
    ].filter(Boolean),
  }).catch(() => {});

  await commandCtx.reply({
    content:
      `Granted **${amount.toLocaleString()}** XP to **${target.username}**.\n` +
      `Now **${newXp.toLocaleString()} XP** (Level **${levelText}**)` +
      (reasonText ? `\nReason: ${reasonText}` : ""),
    sensitive: true,
  });
}

/**
 * Award message XP. Returns true if this path consumed the event for XP purposes
 * (callers still run honeypot/cache before this).
 *
 * Reads the NormalizedMessage fields (authorBot, externalGuildId, communityId)
 * plus the preserved Discord duck fields. `options.isPrefixCommand` is the
 * backstop from roadmap/fluxer.md § Normalized gateway events: a real prefix
 * command earns no message XP. The pipeline's prefix branch already skips
 * this call for prefix lines; the flag protects any future caller.
 *
 * @param {object} outbound OutboundClient (awardXp delivery seam)
 * @param {object} message normalized message (normalizeDiscordMessage output)
 * @param {{ isPrefixCommand?: boolean }} [options]
 */
async function tryAwardMessageXp(outbound, message, options = {}) {
  if (options.isPrefixCommand) return;
  if (message.authorBot) return;
  if (!message.guild && !message.externalGuildId) return;
  const communityId = Number.isSafeInteger(message.communityId)
    ? message.communityId
    : ensureCommunity({
        platform: "discord",
        instanceKey: "discord",
        externalGuildId: message.guild.id,
      });
  const settings = getGuildSettings(communityId);
  const gain = Number(settings.msg_xp) || 0;
  if (gain <= 0) return;

  const k = key(communityId, message.author.id);
  if (isOnCooldown(msgCooldown, k, settings.msg_cooldown_sec)) return;

  await awardXp(outbound, {
    communityId,
    externalGuildId: message.externalGuildId ?? message.guild.id,
    userId: message.author.id,
    delta: gain,
    activityKind: "message",
    levelXpFactor: settings.level_xp_factor,
  });
}

/**
 * Award reaction XP when not a reaction-role panel.
 * Caller must resolve partials / honeypot / reaction-role first.
 *
 * @param {object} outbound OutboundClient (awardXp delivery seam)
 * @param {import("discord.js").Guild} guild
 * @param {import("discord.js").User} user
 */
async function tryAwardReactionXp(outbound, guild, user) {
  if (!guild || user?.bot) return;
  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: guild.id,
  });
  const settings = getGuildSettings(communityId);
  const gain = Number(settings.reaction_xp) || 0;
  if (gain <= 0) return;

  const k = key(communityId, user.id);
  if (isOnCooldown(reactionCooldown, k, settings.reaction_cooldown_sec)) return;

  await awardXp(outbound, {
    communityId,
    externalGuildId: guild.id,
    userId: user.id,
    delta: gain,
    activityKind: "reaction",
    levelXpFactor: settings.level_xp_factor,
  });
}

/**
 * Award reaction XP for a Fluxer NormalizedReaction (roadmap/fluxer.md
 * § Normalized gateway events: Fluxer reaction payloads are ONE object; the
 * adapter hands features this normalized shape, never a discord.js reaction).
 *
 * Mirrors {@link tryAwardReactionXp}'s cooldown math exactly (the same
 * community-scoped `reactionCooldown` map keyed `communityId:userId`). Role
 * sync auto-skips inside awardXp: `platform === "fluxer"` with the community's
 * elevated_permissions 0 (spec § Outbound client, lines 423–429).
 *
 * @param {object} outbound OutboundClient (Fluxer adapter)
 * @param {object} normalizedReaction normalizeFluxerReaction output
 * @returns {Promise<void>}
 */
async function tryAwardReactionXpFluxer(outbound, normalizedReaction) {
  if (!normalizedReaction) return;
  if (normalizedReaction.userBot) return;

  const communityId = Number.isSafeInteger(normalizedReaction.communityId)
    ? normalizedReaction.communityId
    : normalizedReaction.externalGuildId == null
      ? null
      : ensureCommunity({
          platform: "fluxer",
          instanceKey: normalizedReaction.instanceKey ?? "fluxer",
          externalGuildId: String(normalizedReaction.externalGuildId),
        });
  if (!Number.isSafeInteger(communityId)) {
    console.error(
      `[fluxer] reaction XP skipped: no community for instance ${normalizedReaction.instanceKey ?? "?"} guild ${normalizedReaction.externalGuildId ?? "null"} (message ${normalizedReaction.messageId ?? "?"})`,
    );
    return;
  }

  const settings = getGuildSettings(communityId);
  const gain = Number(settings.reaction_xp) || 0;
  if (gain <= 0) return;

  const k = key(communityId, normalizedReaction.userId);
  if (isOnCooldown(reactionCooldown, k, settings.reaction_cooldown_sec)) return;

  await awardXp(outbound, {
    communityId,
    externalGuildId: normalizedReaction.externalGuildId ?? null,
    userId: String(normalizedReaction.userId),
    delta: gain,
    activityKind: "reaction",
    member: null,
    levelXpFactor: settings.level_xp_factor,
  });
}

function registerEvents(client, ctx) {
  // Message / reaction XP are composed in index.js (or a later events coordinator)
  // so honeypot + reaction-roles can run first. Export helpers for that composition.
  void client;
  void ctx;
}

function start(_client) {
  registerJob({
    name: "xpCooldownSweep",
    intervalMs: 10 * 60 * 1000,
    run: () => {
      sweepCooldownMap(msgCooldown, 6 * 60 * 60 * 1000);
      sweepCooldownMap(reactionCooldown, 6 * 60 * 60 * 1000);
    },
  });
}

module.exports = {
  name: "xp",
  commands,
  handlers: {
    xp: handleXp,
    leaderboard: handleLeaderboard,
    setxp: handleSetXp,
    grantxp: handleGrantXp,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): these four
  // slash handlers receive a CommandContext instead of a raw interaction.
  handlerApi: {
    xp: "context",
    leaderboard: "context",
    setxp: "context",
    grantxp: "context",
  },
  buttonHandlers: {
    [LB_BTN_PREFIX]: handleLeaderboardButton,
  },
  registerEvents,
  start,
  // used by index event composition until full event ownership moves here
  tryAwardMessageXp,
  tryAwardReactionXp,
  // Fluxer pipeline (PR 6): normalized reaction XP, same cooldown math
  tryAwardReactionXpFluxer,
  // tests
  LB_BTN_PREFIX,
  clampLeaderboardLimit,
  clampLeaderboardPage,
  leaderboardButtonCustomId,
  parseLeaderboardButtonCustomId,
  buildLeaderboardControls,
};
