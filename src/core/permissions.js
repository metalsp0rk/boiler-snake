const { PermissionFlagsBits, MessageFlags } = require("discord.js");
const { listAllowedCommandChannels } = require("../db");

/**
 * Guild admin/mod gate used by most config commands (Manage Guild).
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @returns {boolean}
 */
function isAdminOrMod(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

/**
 * Staff / admin gate for staff-facing features (notes, future warnings, …).
 *
 * Today: Manage Guild only (same as {@link isAdminOrMod}).
 * When guild staff roles ship (ROADMAP §4), this becomes ManageGuild **or**
 * any role in `staff_roles`. New features should call {@link isStaff} /
 * {@link requireStaff} so call sites do not need a second pass.
 *
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @returns {boolean}
 */
function isStaff(interaction) {
  // ManageGuild always passes. Staff-role membership will be OR'd here when §4 lands.
  return isAdminOrMod(interaction);
}

/**
 * Command channel restriction:
 * - If no allowed channels configured => allowed everywhere
 * - If configured => only allowed in those channels
 * - EXCEPTION: /setcommandchannel is allowed anywhere for admins to avoid lockout
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @returns {boolean}
 */
function commandsAllowed(interaction) {
  if (interaction.commandName === "setcommandchannel" && isAdminOrMod(interaction)) return true;
  const rows = listAllowedCommandChannels(interaction.guildId);
  if (!rows.length) return true;
  return rows.some((r) => r.channel_id === interaction.channelId);
}

/**
 * Reply with a standard permission denial if the invoker is not admin/mod.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @returns {Promise<boolean>} true if the caller may proceed (is admin)
 */
async function requireAdmin(interaction) {
  if (isAdminOrMod(interaction)) return true;
  await interaction.reply({
    content: "You don’t have permission to use this.",
    flags: MessageFlags.Ephemeral,
  });
  return false;
}

/**
 * Reply with a standard permission denial if the invoker is not staff.
 * Successor to {@link requireAdmin} for staff-gated product features.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @returns {Promise<boolean>} true if the caller may proceed
 */
async function requireStaff(interaction) {
  if (isStaff(interaction)) return true;
  await interaction.reply({
    content: "You don’t have permission to use this.",
    flags: MessageFlags.Ephemeral,
  });
  return false;
}

module.exports = {
  isAdminOrMod,
  isStaff,
  commandsAllowed,
  requireAdmin,
  requireStaff,
};
