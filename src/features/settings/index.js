const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const {
  getGuildSettings,
  listAllowedCommandChannels,
  listLevelRoles,
} = require("../../db");
const { requireStaffFromContext } = require("../../core/permissions");
const { Color } = require("../../core/theme");

const staffPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName("settings")
    .setDescription("Show current guild settings.")
    .setDefaultMemberPermissions(staffPerms),
];

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} featureCtx
 */
async function handleSettings(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireStaffFromContext(commandCtx))) return;

  // CommandContext carries the resolved internal id — the Discord adapter
  // ran the same ensureCommunity edge resolution (roadmap/fluxer.md
  // § Repository boundary) at the seam, so repositories get only the integer.
  const communityId = commandCtx.communityId;
  const settings = getGuildSettings(communityId);

  const chans = listAllowedCommandChannels(communityId);
  const chanText = chans.length
    ? chans.map((r) => `<#${r.channel_id}>`).join(", ")
    : "All channels (no restriction set)";

  const roles = listLevelRoles(communityId);
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

  // Plain-object embed (NormalizedEmbed) — migrated handlers build plain
  // embeds; the Discord reply builder re-wraps it into EmbedBuilder at the
  // adapter edge (replaces baseEmbed — roadmap/fluxer.md § CommandContext).
  const embed = {
    title: "Boiler Snake Settings",
    color: Color.brand,
    footer: { text: "Staff only" },
    fields: [
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
        name: "Gork",
        value:
          Number(settings.gork_enabled ?? 1) === 1
            ? `Keyword **${settings.gork_keyword || "disabled"}** · Window **${settings.gork_context_window}** · Search **${settings.gork_search_enabled ? "on" : "off"}** · STE **${Number(settings.gork_ste_enabled ?? 0) === 1 ? "on" : "off"}** · Memory **${Number(settings.gork_memory_enabled ?? 0) === 1 ? "on" : "off"}** · Summarize **${Number(settings.gork_summarize_input_tokens ?? 80000)} input tokens**`
            : "**disabled** for this server (`/gork enable on` to re-enable)",
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
    ],
  };

  await commandCtx.reply({ embeds: [embed], sensitive: true });
}

module.exports = {
  name: "settings",
  commands,
  handlers: {
    settings: handleSettings,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): the slash
  // handler receives a CommandContext instead of a raw interaction.
  handlerApi: {
    settings: "context",
  },
};
