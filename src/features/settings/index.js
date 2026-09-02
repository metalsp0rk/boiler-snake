const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const {
  getGuildSettings,
  listAllowedCommandChannels,
  listLevelRoles,
} = require("../../db");
const { isStaff } = require("../../core/permissions");
const { replyDenied, replyEphemeral } = require("../../core/interaction");
const { Color, baseEmbed } = require("../../core/theme");

const staffPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName("settings")
    .setDescription("Show current guild settings.")
    .setDefaultMemberPermissions(staffPerms),
];

async function handleSettings(interaction) {
  if (!isStaff(interaction)) {
    await replyDenied(interaction);
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
            `<@&${r.role_id}> @ Lvl ${r.level_required} (drop after ${r.drop_grace_days}d)`,
        )
        .join("\n")
    : "_None configured_";

  const auditLogCh = settings.audit_log_channel_id
    ? `<#${settings.audit_log_channel_id}>`
    : "_Not configured_";
  const messageLogCh = settings.message_log_channel_id
    ? `<#${settings.message_log_channel_id}>`
    : "_Not configured_";

  const decayPct = Math.round((Number(settings.decay_percent) || 0) * 100);

  const embed = baseEmbed({
    color: Color.brand,
    title: "Boiler Snake Settings",
    footer: "Staff only",
  }).addFields(
    {
      name: "XP awards",
      value: `Message **${settings.msg_xp}** · Reaction **${settings.reaction_xp}** · Voice/min **${settings.voice_xp_per_min}**`,
      inline: false,
    },
    {
      name: "Cooldowns",
      value: `Message **${settings.msg_cooldown_sec}s** · Reaction **${settings.reaction_cooldown_sec}s**`,
      inline: false,
    },
    {
      name: "Decay",
      value: `Enabled **${!!settings.decay_enabled}** · threshold **${settings.decay_min_messages}** msgs / **${settings.decay_window_days}** days · **${decayPct}%**`,
      inline: false,
    },
    {
      name: "Level curve",
      value: `Factor **${settings.level_xp_factor}** (level L starts at L²×factor)`,
      inline: false,
    },
    {
      name: "Logs",
      value: `Audit ${auditLogCh} · Message ${messageLogCh}`,
      inline: false,
    },
    {
      name: "Commands allowed in",
      value: chanText,
      inline: false,
    },
    {
      name: "Level→Role mappings",
      value: roleText.slice(0, 1024),
      inline: false,
    },
  );

  await replyEphemeral(interaction, { embeds: [embed] });
}

module.exports = {
  name: "settings",
  commands,
  handlers: {
    settings: handleSettings,
  },
};
