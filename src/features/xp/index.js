const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  AttachmentBuilder,
} = require("discord.js");
const {
  getGuildSettings,
  updateGuildSettings,
  getXp,
  topUsers,
} = require("../../db");
const { levelFromXp, validateXpValue, MAX_XP_AWARD } = require("../../core/xpMath");
const { key, isOnCooldown, sweepCooldownMap } = require("../../core/cooldowns");
const { isStaff, requireAdmin } = require("../../core/permissions");
const { replyDenied, replyEphemeral } = require("../../core/interaction");
const { Color, baseEmbed } = require("../../core/theme");
const { awardXp } = require("../../services/awardXp");
const { renderLeaderboardPng } = require("../../render/leaderboard");
const { logConfigChange, diffConfigLines } = require("../logs/auditLog");

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
        .setDescription("How many to show (max 20)")
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

async function handleXp(interaction) {
  const guildId = interaction.guildId;
  const settings = getGuildSettings(guildId);
  const target = interaction.options.getUser("user") ?? interaction.user;
  const xp = getXp(guildId, target.id);
  const level = levelFromXp(xp, settings.level_xp_factor);

  await replyEphemeral(
    interaction,
    `**${target.username}**: **${xp} XP** · Level **${level}**`,
  );
}

async function handleLeaderboard(interaction) {
  const guildId = interaction.guildId;
  const settings = getGuildSettings(guildId);
  const rows = topUsers(guildId, 10);
  if (!rows.length) {
    await replyEphemeral(interaction, {
      content: "No leaderboard data yet.",
    });
    return;
  }

  let members = null;
  try {
    members = await interaction.guild.members.fetch({
      user: rows.map((r) => r.user_id),
    });
  } catch {
    members = null;
  }

  const factor = Math.max(1, Number(settings.level_xp_factor) || 100);
  const entries = rows.map((r, idx) => {
    const m = members?.get?.(r.user_id);
    const name = m?.displayName || m?.user?.username || `User ${r.user_id}`;
    const level = levelFromXp(r.xp, factor);
    return { rank: idx + 1, name, xp: r.xp, level };
  });

  const png = renderLeaderboardPng(entries, factor);
  const file = new AttachmentBuilder(png, {
    name: "boiler-snake-leaderboard.png",
  });

  await interaction.reply({
    content: "**Leaderboard (Top 10)**",
    files: [file],
  });
}

async function handleSetXp(interaction, ctx) {
  const { client } = ctx;
  if (!isStaff(interaction)) {
    await replyDenied(interaction);
    return;
  }

  const guildId = interaction.guildId;
  const settings = getGuildSettings(guildId);
  const msg = interaction.options.getInteger("message");
  const reaction = interaction.options.getInteger("reaction");
  const voice = interaction.options.getInteger("voice");
  const msgcooldown = interaction.options.getInteger("msgcooldown");
  const reactioncooldown = interaction.options.getInteger("reactioncooldown");
  const factor = interaction.options.getInteger("factor");

  const errors = [
    validateXpValue(msg, "Message"),
    validateXpValue(reaction, "Reaction"),
    validateXpValue(voice, "Voice"),
  ].filter(Boolean);

  if (errors.length) {
    await replyEphemeral(interaction, errors.join("\n"));
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
    await replyEphemeral(interaction, "No XP settings provided to update.");
    return;
  }

  const before = settings;
  const updated = updateGuildSettings(guildId, patch);
  const lines = diffConfigLines(before, updated, Object.keys(patch));
  if (lines.length) {
    await logConfigChange(client, guildId, {
      title: "XP settings updated",
      command: "/setxp",
      actor: interaction.user,
      changes: lines,
    }).catch(() => {});
  }

  const embed = baseEmbed({
    color: Color.config,
    title: "Updated XP settings",
    footer: "Staff only",
  }).addFields(
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
  );

  if (factor !== null) {
    embed.addFields({
      name: "level_xp_factor",
      value: `**${settings.level_xp_factor}** → **${updated.level_xp_factor}** (Level L starts at L² × factor)`,
      inline: false,
    });
  }

  await replyEphemeral(interaction, { embeds: [embed] });
}

/**
 * Admin-only: grant XP to a member. Runs the full award pipeline (roles + audit).
 */
async function handleGrantXp(interaction, ctx) {
  const { client } = ctx;
  if (!(await requireAdmin(interaction))) return;

  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("amount", true);
  const reason = interaction.options.getString("reason");

  if (target.bot) {
    await replyEphemeral(interaction, "You can’t grant XP to bots.");
    return;
  }

  const amountError = validateXpValue(amount, "Grant");
  if (amountError) {
    await replyEphemeral(interaction, amountError);
    return;
  }
  if (amount < 1) {
    await replyEphemeral(interaction, "Amount must be at least 1.");
    return;
  }

  const guildId = interaction.guildId;
  const settings = getGuildSettings(guildId);
  const beforeXp = getXp(guildId, target.id);

  const { newXp, level } = await awardXp(client, {
    guild: interaction.guild,
    userId: target.id,
    delta: amount,
    activityKind: "admin_grant",
    levelXpFactor: settings.level_xp_factor,
    source: "admin_grant",
  });

  const levelText = level != null ? String(level) : levelFromXp(newXp, settings.level_xp_factor);
  const reasonText = reason?.trim() ? reason.trim() : null;

  await logConfigChange(client, guildId, {
    title: "XP granted",
    command: "/grantxp",
    actor: interaction.user,
    changes: [
      `Target: <@${target.id}> (\`${target.id}\`)`,
      `Amount: **+${amount.toLocaleString()}** XP`,
      `XP: **${beforeXp.toLocaleString()}** → **${newXp.toLocaleString()}**`,
      `Level: **${levelText}**`,
      reasonText ? `Reason: ${reasonText}` : null,
    ].filter(Boolean),
  }).catch(() => {});

  await replyEphemeral(interaction, {
    content:
      `Granted **${amount.toLocaleString()}** XP to **${target.username}**.\n` +
      `Now **${newXp.toLocaleString()} XP** (Level **${levelText}**)` +
      (reasonText ? `\nReason: ${reasonText}` : ""),
  });
}

/**
 * Award message XP. Returns true if this path consumed the event for XP purposes
 * (callers still run honeypot/cache before this).
 */
async function tryAwardMessageXp(client, message) {
  if (!message.guild || message.author?.bot) return;
  const settings = getGuildSettings(message.guild.id);
  const gain = Number(settings.msg_xp) || 0;
  if (gain <= 0) return;

  const k = key(message.guild.id, message.author.id);
  if (isOnCooldown(msgCooldown, k, settings.msg_cooldown_sec)) return;

  await awardXp(client, {
    guild: message.guild,
    userId: message.author.id,
    delta: gain,
    activityKind: "message",
    levelXpFactor: settings.level_xp_factor,
  });
}

/**
 * Award reaction XP when not a reaction-role panel.
 * Caller must resolve partials / honeypot / reaction-role first.
 */
async function tryAwardReactionXp(client, guild, user) {
  if (!guild || user?.bot) return;
  const settings = getGuildSettings(guild.id);
  const gain = Number(settings.reaction_xp) || 0;
  if (gain <= 0) return;

  const k = key(guild.id, user.id);
  if (isOnCooldown(reactionCooldown, k, settings.reaction_cooldown_sec)) return;

  await awardXp(client, {
    guild,
    userId: user.id,
    delta: gain,
    activityKind: "reaction",
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
  setInterval(
    () => {
      sweepCooldownMap(msgCooldown, 6 * 60 * 60 * 1000);
      sweepCooldownMap(reactionCooldown, 6 * 60 * 60 * 1000);
    },
    10 * 60 * 1000,
  );
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
  registerEvents,
  start,
  // used by index event composition until full event ownership moves here
  tryAwardMessageXp,
  tryAwardReactionXp,
};
