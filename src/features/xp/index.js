const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  AttachmentBuilder,
} = require("discord.js");
const {
  getGuildSettings,
  updateGuildSettings,
  getXp,
  topUsers,
} = require("../../db");
const { levelFromXp, validateXpValue } = require("../../core/xpMath");
const { key, isOnCooldown, sweepCooldownMap } = require("../../core/cooldowns");
const { isStaff } = require("../../core/permissions");
const { awardXp } = require("../../services/awardXp");
const { renderLeaderboardPng } = require("../../render/leaderboard");
const { logConfigChange, diffConfigLines } = require("../logs/auditLog");

const adminPerms = PermissionFlagsBits.ManageGuild;

const msgCooldown = new Map();
const reactionCooldown = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName("xp")
    .setDescription("Show your XP and level (or another user's).")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("User to check").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show top XP users.")
    .addIntegerOption((opt) =>
      opt
        .setName("limit")
        .setDescription("How many to show (max 20)")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("setxp")
    .setDescription("Set XP values and cooldowns for this guild.")
    .setDefaultMemberPermissions(adminPerms)
    .addIntegerOption((opt) =>
      opt.setName("message").setDescription("XP per message").setMinValue(0).setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("reaction")
        .setDescription("Reaction XP per message")
        .setMinValue(0)
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("voice")
        .setDescription("XP per voice minute")
        .setMinValue(0)
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("msgcooldown")
        .setDescription("Message XP cooldown seconds")
        .setMinValue(0)
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("reactioncooldown")
        .setDescription("Reaction XP cooldown seconds")
        .setMinValue(0)
        .setRequired(false)
    ),
];

async function handleXp(interaction) {
  const guildId = interaction.guildId;
  const settings = getGuildSettings(guildId);
  const target = interaction.options.getUser("user") ?? interaction.user;
  const xp = getXp(guildId, target.id);
  const level = levelFromXp(xp, settings.level_xp_factor);

  await interaction.reply({
    content: `${target.username}: **${xp} XP** (Level **${level}**)`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleLeaderboard(interaction) {
  const guildId = interaction.guildId;
  const settings = getGuildSettings(guildId);
  const rows = topUsers(guildId, 10);
  if (!rows.length) {
    await interaction.reply({
      content: "No leaderboard data yet.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let members = null;
  try {
    members = await interaction.guild.members.fetch({ user: rows.map((r) => r.user_id) });
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
  const file = new AttachmentBuilder(png, { name: "boiler-snake-leaderboard.png" });

  await interaction.reply({
    content: "**Leaderboard (Top 10)**",
    files: [file],
  });
}

async function handleSetXp(interaction, ctx) {
  const { client } = ctx;
  if (!isStaff(interaction)) {
    await interaction.reply({
      content: "You don’t have permission to use this.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildId = interaction.guildId;
  const settings = getGuildSettings(guildId);
  const msg = interaction.options.getInteger("message");
  const reaction = interaction.options.getInteger("reaction");
  const voice = interaction.options.getInteger("voice");
  const msgcooldown = interaction.options.getInteger("msgcooldown");
  const reactioncooldown = interaction.options.getInteger("reactioncooldown");

  const errors = [
    validateXpValue(msg, "Message"),
    validateXpValue(reaction, "Reaction"),
    validateXpValue(voice, "Voice"),
  ].filter(Boolean);

  if (errors.length) {
    await interaction.reply({ content: errors.join("\n"), flags: MessageFlags.Ephemeral });
    return;
  }

  const patch = {};
  if (msg !== null) patch.msg_xp = msg;
  if (reaction !== null) patch.reaction_xp = reaction;
  if (voice !== null) patch.voice_xp_per_min = voice;
  if (msgcooldown !== null) patch.msg_cooldown_sec = msgcooldown;
  if (reactioncooldown !== null) patch.reaction_cooldown_sec = reactioncooldown;

  if (!Object.keys(patch).length) {
    await interaction.reply({
      content: "No XP settings provided to update.",
      flags: MessageFlags.Ephemeral,
    });
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

  await interaction.reply({
    content:
      `Updated XP settings:\n` +
      `- msg_xp: **${updated.msg_xp}**\n` +
      `- reaction_xp: **${updated.reaction_xp}**\n` +
      `- voice_xp_per_min: **${updated.voice_xp_per_min}**\n` +
      `- msg_cooldown_sec: **${updated.msg_cooldown_sec}**\n` +
      `- reaction_cooldown_sec: **${updated.reaction_cooldown_sec}**`,
    flags: MessageFlags.Ephemeral,
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
  setInterval(() => {
    sweepCooldownMap(msgCooldown, 6 * 60 * 60 * 1000);
    sweepCooldownMap(reactionCooldown, 6 * 60 * 60 * 1000);
  }, 10 * 60 * 1000);
}

module.exports = {
  name: "xp",
  commands,
  handlers: {
    xp: handleXp,
    leaderboard: handleLeaderboard,
    setxp: handleSetXp,
  },
  registerEvents,
  start,
  // used by index event composition until full event ownership moves here
  tryAwardMessageXp,
  tryAwardReactionXp,
};
