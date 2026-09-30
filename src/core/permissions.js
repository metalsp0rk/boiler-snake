const { PermissionFlagsBits } = require("discord.js");
const {
  listAllowedCommandChannels,
  memberHasStaffRole,
  memberHasSeniorStaffRole,
  getTicketByChannel,
} = require("../db");
const { discordCommunityId } = require("../platform/community");
const { replyDenied, replyOrFollowUpEphemeral } = require("./interaction");
const { MSG_DENIED } = require("./theme");

/**
 * Guild admin/mod gate used by most config commands (Manage Guild).
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @returns {boolean}
 */
function isAdminOrMod(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

/**
 * Staff / admin gate for staff-facing features (notes, warnings, tickets, …).
 *
 * Manage Guild **or** any role in `staff_roles`.
 * New features should call {@link isStaff} / {@link requireStaff} so call sites
 * do not need a second pass.
 *
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @returns {boolean}
 */
function isStaff(interaction) {
  if (isAdminOrMod(interaction)) return true;
  const communityId = discordCommunityId(interaction.guildId);
  if (communityId == null) return false;
  const memberRoleIds = [...(interaction.member?.roles?.cache?.keys() ?? [])];
  return memberHasStaffRole(communityId, memberRoleIds);
}

/**
 * Senior staff / admin gate (Manage Guild **or** a senior `staff_roles` role).
 * Used for sensitive staff tools such as `/userinfo` Activity.
 *
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @returns {boolean}
 */
function isSeniorStaff(interaction) {
  if (isAdminOrMod(interaction)) return true;
  const communityId = discordCommunityId(interaction.guildId);
  if (communityId == null) return false;
  const memberRoleIds = [...(interaction.member?.roles?.cache?.keys() ?? [])];
  return memberHasSeniorStaffRole(communityId, memberRoleIds);
}

/**
 * Command channel restriction:
 * - If no allowed channels configured => allowed everywhere
 * - If configured => only allowed in those channels
 * - EXCEPTION: /setcommandchannel is allowed anywhere for admins to avoid lockout
 * - EXCEPTION: /ticket inside an open ticket channel (lifecycle commands)
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @returns {boolean}
 */
function commandsAllowed(interaction) {
  if (
    interaction.commandName === "setcommandchannel" &&
    isAdminOrMod(interaction)
  )
    return true;
  if (interaction.commandName === "ticket" && interaction.channelId) {
    const ticketCommunityId = discordCommunityId(interaction.guildId);
    // Open tickets, or soft-closed channels still awaiting /ticket archive
    const ticket = ticketCommunityId == null
      ? null
      : getTicketByChannel(ticketCommunityId, interaction.channelId);
    if (ticket && ticket.channel_id && Number(ticket.archived) !== 1) {
      return true;
    }
  }
  const communityId = discordCommunityId(interaction.guildId);
  if (communityId == null) return true; // DM/no community: same as today's unregistered-guild path
  const rows = listAllowedCommandChannels(communityId);
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
  await replyDenied(interaction);
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
  await replyDenied(interaction);
  return false;
}

/**
 * Reply with a standard permission denial if the invoker is not senior staff.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @returns {Promise<boolean>} true if the caller may proceed
 */
async function requireSeniorStaff(interaction) {
  if (isSeniorStaff(interaction)) return true;
  await replyOrFollowUpEphemeral(
    interaction,
    "Activity requires **senior** staff (or Manage Server). Ask an admin to set your role with `/staff role setlevel`.",
  );
  return false;
}

/**
 * CommandContext variant of {@link isAdminOrMod}: reads the adapter-supplied
 * bigint permission mask instead of `memberPermissions.has(...)`.
 * @param {import("../platform/context").CommandContext} ctx
 * @returns {boolean}
 */
function isAdminOrModFromContext(ctx) {
  const manageGuild = BigInt(PermissionFlagsBits.ManageGuild);
  return (
    (BigInt(ctx.channelPermissions ?? 0) & manageGuild) === manageGuild
  );
}

/**
 * CommandContext variant of {@link isStaff}: Manage Guild **or** any role in
 * `staff_roles` (matched via `communityId` + `memberRoleIds`).
 * @param {import("../platform/context").CommandContext} ctx
 * @returns {boolean}
 */
function isStaffFromContext(ctx) {
  if (isAdminOrModFromContext(ctx)) return true;
  return memberHasStaffRole(ctx.communityId, ctx.memberRoleIds ?? []);
}

/**
 * CommandContext variant of {@link isSeniorStaff}: Manage Guild **or** a
 * senior-level `staff_roles` role.
 * @param {import("../platform/context").CommandContext} ctx
 * @returns {boolean}
 */
function isSeniorStaffFromContext(ctx) {
  if (isAdminOrModFromContext(ctx)) return true;
  return memberHasSeniorStaffRole(ctx.communityId, ctx.memberRoleIds ?? []);
}

/**
 * CommandContext variant of {@link requireAdmin}. Denials reply privately via
 * the context's own reply channel (`sensitive: true` ≙ interaction ephemeral).
 * @param {import("../platform/context").CommandContext} ctx
 * @returns {Promise<boolean>} true if the caller may proceed (is admin)
 */
async function requireAdminFromContext(ctx) {
  if (isAdminOrModFromContext(ctx)) return true;
  await ctx.reply({ content: MSG_DENIED, sensitive: true });
  return false;
}

/**
 * CommandContext variant of {@link requireStaff}.
 * @param {import("../platform/context").CommandContext} ctx
 * @returns {Promise<boolean>} true if the caller may proceed
 */
async function requireStaffFromContext(ctx) {
  if (isStaffFromContext(ctx)) return true;
  await ctx.reply({ content: MSG_DENIED, sensitive: true });
  return false;
}

/**
 * CommandContext variant of {@link requireSeniorStaff}. Same denial copy as
 * the interaction variant (AGENTS.md: users must be able to act on it).
 * @param {import("../platform/context").CommandContext} ctx
 * @returns {Promise<boolean>} true if the caller may proceed
 */
async function requireSeniorStaffFromContext(ctx) {
  if (isSeniorStaffFromContext(ctx)) return true;
  await ctx.reply({
    content:
      "Activity requires **senior** staff (or Manage Server). Ask an admin to set your role with `/staff role setlevel`.",
    sensitive: true,
  });
  return false;
}

module.exports = {
  isAdminOrMod,
  isStaff,
  isSeniorStaff,
  commandsAllowed,
  requireAdmin,
  requireStaff,
  requireSeniorStaff,
  isAdminOrModFromContext,
  isStaffFromContext,
  isSeniorStaffFromContext,
  requireAdminFromContext,
  requireStaffFromContext,
  requireSeniorStaffFromContext,
};
