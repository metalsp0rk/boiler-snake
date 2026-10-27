/**
 * "Refer to automod" — MESSAGE context-menu builder (#726, epic #723).
 *
 * Locked decision 1's second intake surface: right-click (long-press) →
 * Apps → Refer to automod on a message files the same staff referral case as
 * `/automod refer`, with the target message as the subject and no note
 * option. Members have no command for this; nothing else opens a case.
 *
 * Builder posture (identical to the #745 "Report Post" report menu): the
 * installed @discordjs/builders (1.14.1 via discord.js 14.x) exports no
 * dedicated Message subclass — generic ContextMenuCommandBuilder +
 * setType(ApplicationCommandType.Message) is the supported form (identical
 * REST payload: type 3). ManageGuild default_member_permissions is the
 * staff-tier PICKER posture (TIERS.staff in src/core/commandVisibility.js:
 * `/staff syncpermissions` adds the staff_roles allow overwrites); the
 * handler's requireStaff gate stays the security source of truth.
 *
 * The display name is byte-identical across this builder, the visibility
 * map, the feature handlers key, the router dispatch (interaction.commandName),
 * and the tests — change it here and every one of those pins fails loudly.
 *
 * Fluxer: the chat-input-only tree filter from #750 (buildFluxerCommandTree
 * skips any explicit non-CHAT_INPUT command type) keeps this menu off the
 * prefix surface — Discord-native by design (epic decision 8, explicit
 * no-parity). No Fluxer work needed or wanted.
 */

const {
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  PermissionFlagsBits,
} = require("discord.js");

/** Exact registered display name — registry/dispatch/visibility key. */
const CONTEXT_REFER_MESSAGE = "Refer to automod";

const referContextMenu = new ContextMenuCommandBuilder()
  .setName(CONTEXT_REFER_MESSAGE)
  .setType(ApplicationCommandType.Message)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

module.exports = { CONTEXT_REFER_MESSAGE, referContextMenu };
