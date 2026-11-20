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
 * The ONE `.has(flag)` permission probe (#829). FAILS CLOSED.
 *
 * A missing/garbage permission surface is NOT consent: discord.js
 * `permissionsFor` legitimately returns null for uncached/non-instance
 * members (`DataManager.resolve` → null), and ducked/partials/platform
 * drift can hand back anything. Pre-#829 the gork copies DIVERGED on
 * exactly this line — `readDiscord` fail-closed (#475/F1-4),
 * `summarizeRange` fail-OPEN — while gating the SAME ViewChannel parity
 * law at the same call sequence; a null-perms drift waved the `/gork
 * summarize` parity gate (#46) through on channel content the invoking
 * staffer may not be able to see. One law, one home: a perm shape we
 * cannot interrogate REFUSES, exactly like a throwing one already did.
 *
 * @param {{has?: (flag: bigint) => boolean}|null|undefined} perms bitfield-ish surface
 * @param {bigint} flag PermissionFlagsBits member
 * @returns {boolean} true ONLY when the surface answers the flag positively
 */
function permsAllow(perms, flag) {
  if (!perms || typeof perms.has !== "function") return false;
  try {
    return perms.has(flag) === true;
  } catch {
    return false; // a throwing perm surface fails closed
  }
}

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
 * Command-channel gate on raw primitives (the shape the Fluxer dispatcher has:
 * no interaction, no Discord member object). Single source of truth for the
 * {@link commandsAllowed} variant. (#837 B2-5: the promised *FromContext twin
 * shipped dead and exported — dispatch.js wires this primitive by hand. It is
 * deleted, not left as a trap for the next "there must be a ctx variant" caller.)
 *
 * - No rows in `allowed_command_channels` for the community → allow.
 * - Else the channel must be listed.
 * - EXCEPTION: setcommandchannel is allowed in any channel when `isAdmin`
 *   (Manage Guild bit or guild owner) — the lockout escape hatch.
 * - EXCEPTION: ticket inside an open (not archived) ticket channel.
 *
 * @param {string} commandName
 * @param {number|null} communityId null = no community row (DM / unregistered guild)
 * @param {string|null} channelId
 * @param {boolean} isAdmin
 * @returns {boolean}
 */
function commandsAllowedFromIds(commandName, communityId, channelId, isAdmin) {
  if (commandName === "setcommandchannel" && isAdmin) return true;
  if (commandName === "ticket" && channelId && communityId != null) {
    // Open tickets, or soft-closed channels still awaiting /ticket archive
    const ticket = getTicketByChannel(communityId, channelId);
    if (ticket && ticket.channel_id && Number(ticket.archived) !== 1) {
      return true;
    }
  }
  if (communityId == null) return true; // DM/no community: same as the unregistered-guild path
  const rows = listAllowedCommandChannels(communityId);
  if (!rows.length) return true;
  return rows.some((r) => r.channel_id === channelId);
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
  return commandsAllowedFromIds(
    interaction.commandName,
    discordCommunityId(interaction.guildId),
    interaction.channelId,
    Boolean(isAdminOrMod(interaction)),
  );
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

module.exports = {
  permsAllow,
  isAdminOrMod,
  isStaff,
  isSeniorStaff,
  commandsAllowed,
  commandsAllowedFromIds,
  requireAdmin,
  requireStaff,
  requireSeniorStaff,
  isAdminOrModFromContext,
  isStaffFromContext,
  requireAdminFromContext,
  requireStaffFromContext,
};
