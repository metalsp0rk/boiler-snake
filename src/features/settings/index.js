const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require("discord.js");
const {
  getGuildSettings,
  listAllowedCommandChannels,
  listLevelRoles,
} = require("../../db");
const { isAdminOrMod } = require("../../core/permissions");

const adminPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName("settings")
    .setDescription("Show current guild settings.")
    .setDefaultMemberPermissions(adminPerms),
];

async function handleSettings(interaction) {
  if (!isAdminOrMod(interaction)) {
    await interaction.reply({
      content: "You don’t have permission to use this.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildId = interaction.guildId;
  const settings = getGuildSettings(guildId);

  const chans = listAllowedCommandChannels(guildId);
  const chanText = chans.length
    ? chans.map((r) => `<#${r.channel_id}>`).join(", ")
    : "All channels (no restriction set)";

  const roles = listLevelRoles(guildId);
  const roleText = roles.length
    ? roles
        .map(
          (r) =>
            `<@&${r.role_id}> @ Lvl ${r.level_required} (drop after ${r.drop_grace_days}d)`
        )
        .join("\n")
    : "(none configured)";

  const auditLogCh = settings.audit_log_channel_id
    ? `<#${settings.audit_log_channel_id}>`
    : "Not configured";
  const messageLogCh = settings.message_log_channel_id
    ? `<#${settings.message_log_channel_id}>`
    : "Not configured";

  await interaction.reply({
    content:
      `**Boiler Snake Settings**\n` +
      `**XP:** msg=${settings.msg_xp}, reaction=${settings.reaction_xp}, voice/min=${settings.voice_xp_per_min}\n` +
      `**Cooldowns:** msg=${settings.msg_cooldown_sec}s, reaction=${settings.reaction_cooldown_sec}s\n` +
      `**Decay:** enabled=${!!settings.decay_enabled}, threshold=${settings.decay_min_messages} msgs / ${settings.decay_window_days} days, percent=${Math.round((Number(settings.decay_percent) || 0) * 100)}%\n` +
      `**Level curve factor:** ${settings.level_xp_factor} (Level L starts at L²×factor)\n` +
      `**Logs:** audit=${auditLogCh}, message=${messageLogCh}\n` +
      `**Commands allowed in:** ${chanText}\n` +
      `**Level→Role mappings:**\n${roleText}`,
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = {
  name: "settings",
  commands,
  handlers: {
    settings: handleSettings,
  },
};
