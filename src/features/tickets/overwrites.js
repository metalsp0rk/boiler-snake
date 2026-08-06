/**
 * Discord permission overwrites for open tickets (normal vs sensitive).
 *
 * Important: Discord rejects channel create/edit with 50013 if we grant
 * permissions the bot lacks, or set overwrites for roles above the bot.
 */

const { PermissionFlagsBits } = require("discord.js");
const {
  listSeniorStaffRoles,
  listTicketMembers,
  listTicketStaff,
} = require("../../db");

/** Member participants: chat only, no manage. */
const MEMBER_ALLOW =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.EmbedLinks |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.AddReactions;

const MEMBER_DENY = PermissionFlagsBits.ManageMessages;

/**
 * Staff access on open tickets.
 * Do NOT include ManageChannels — granting it requires the bot to hold it and
 * is unnecessary for support; it also triggers Missing Permissions when the
 * bot was invited without Manage Channels.
 */
const STAFF_ALLOW =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.EmbedLinks |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.AddReactions |
  PermissionFlagsBits.ManageMessages;

/**
 * Bot channel access. ManageChannels only — enough to edit overwrites / delete.
 * Do not include ManageRoles here: Discord rejects overwrites that grant
 * permissions the bot does not hold (50013).
 */
const BOT_ALLOW =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.EmbedLinks |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.AddReactions |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.ManageChannels;

/**
 * Highest role position of the bot member (0 if unknown).
 * @param {import("discord.js").GuildMember|null|undefined} botMember
 * @returns {number}
 */
function botHighestRolePosition(botMember) {
  if (botMember?.roles?.highest != null) {
    const p = Number(botMember.roles.highest.position);
    if (Number.isFinite(p)) return p;
  }
  if (botMember?.roles?.cache) {
    let max = 0;
    for (const role of botMember.roles.cache.values()) {
      const p = Number(role.position) || 0;
      if (p > max) max = p;
    }
    return max;
  }
  return 0;
}

/**
 * Staff role IDs the bot can safely set overwrites for.
 * Skips missing roles and roles ranked above the bot.
 *
 * @param {import("discord.js").Guild} guild
 * @param {import("discord.js").GuildMember|null|undefined} botMember
 * @returns {{ roleIds: string[], skipped: { id: string, reason: string }[] }}
 */
/**
 * Senior staff roles only (ticket channel visibility).
 * Junior staff pass requireStaff but do not get automatic ticket overwrites.
 */
function getManageableStaffRoleIds(guild, botMember) {
  const rows = listSeniorStaffRoles(guild.id);
  const botPos = botHighestRolePosition(botMember);
  const roleIds = [];
  const skipped = [];

  for (const row of rows) {
    const role =
      guild.roles?.cache?.get?.(row.role_id) ||
      null;
    if (!role) {
      // Role deleted from Discord but still in staff_roles — skip (API may 404/50013)
      skipped.push({ id: row.role_id, reason: "role not found in guild" });
      continue;
    }
    if (role.managed) {
      skipped.push({ id: row.role_id, reason: "managed/integration role" });
      continue;
    }
    // Bot can only set overwrites for roles strictly below its highest role
    // (same position is also unsafe). @everyone is always ok via guild.id.
    const rolePos = Number(role.position) || 0;
    if (botMember && rolePos >= botPos) {
      skipped.push({
        id: row.role_id,
        reason: "role is above or equal to the bot's highest role — move the bot role higher",
      });
      continue;
    }
    roleIds.push(row.role_id);
  }

  return { roleIds, skipped };
}

/**
 * Whether the bot can create ticket channels in this guild (and optional parent).
 * @param {import("discord.js").Guild} guild
 * @param {import("discord.js").GuildMember|null|undefined} botMember
 * @param {string|null} [categoryId]
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function assertBotCanCreateTickets(guild, botMember, categoryId) {
  if (!botMember) {
    return {
      ok: false,
      error:
        "Could not resolve the bot member in this server. Try again after the bot has fully started, or re-invite the bot.",
    };
  }

  const perms = botMember.permissions;
  const hasManageChannels =
    typeof perms?.has === "function"
      ? perms.has(PermissionFlagsBits.ManageChannels)
      : false;

  if (!hasManageChannels) {
    return {
      ok: false,
      error:
        "I need the **Manage Channels** permission to open tickets. " +
        "Update the bot’s role (or Server Settings → Roles / channel overrides), then try again.",
    };
  }

  if (categoryId) {
    const parent =
      guild.channels?.cache?.get?.(categoryId) || null;
    if (!parent) {
      return {
        ok: false,
        error:
          "The configured ticket category no longer exists. Run `/ticket setcategory` with a valid category.",
      };
    }
    // Category-level deny of Manage Channels blocks create-under-parent
    const parentPerms =
      typeof parent.permissionsFor === "function"
        ? parent.permissionsFor(botMember)
        : null;
    if (
      parentPerms &&
      typeof parentPerms.has === "function" &&
      !parentPerms.has(PermissionFlagsBits.ManageChannels)
    ) {
      return {
        ok: false,
        error:
          `I can’t create channels under **${parent.name || "that category"}** (missing Manage Channels there). ` +
          "Fix category permissions for the bot, or pick another category with `/ticket setcategory`.",
      };
    }
  }

  return { ok: true };
}

/**
 * Build overwrite array for guild.channels.create / channel.permissionOverwrites.set
 * @param {object} opts
 * @param {string} opts.guildId
 * @param {string} opts.everyoneId  usually guild.id
 * @param {string} opts.botUserId
 * @param {object} opts.ticket  ticket row
 * @param {boolean} [opts.sensitive]
 * @param {boolean} [opts.excludeMembers=false] soft-closed: staff-only, no member access
 * @param {string[]} [opts.staffRoleIds] pre-filtered manageable staff roles
 * @param {import("discord.js").Guild} [opts.guild] used to filter staff roles if staffRoleIds omitted
 * @param {import("discord.js").GuildMember} [opts.botMember]
 * @returns {object[]}
 */
function buildTicketOverwrites(opts) {
  const { guildId, everyoneId, botUserId, ticket } = opts;
  const sensitive =
    opts.sensitive != null
      ? !!opts.sensitive
      : Number(ticket.is_sensitive) === 1;
  const excludeMembers = !!opts.excludeMembers;

  const overwrites = [
    {
      id: everyoneId,
      deny: PermissionFlagsBits.ViewChannel,
    },
    {
      id: botUserId,
      allow: BOT_ALLOW,
    },
  ];

  const members = listTicketMembers(ticket.id);
  const memberIds = new Set(members.map((m) => m.user_id));
  memberIds.add(ticket.creator_user_id);

  // Named staff (owner + addstaff + staff who opened for a member) —
  // always staff-level user overwrites, even if also listed as members.
  // opened_by_staff_id is included so older rows without ticket_staff still work.
  const staffRows = listTicketStaff(ticket.id);
  const namedStaff = new Set(staffRows.map((s) => s.user_id));
  if (ticket.staff_owner_id) namedStaff.add(ticket.staff_owner_id);
  if (ticket.opened_by_staff_id) namedStaff.add(ticket.opened_by_staff_id);

  if (!excludeMembers) {
    for (const userId of memberIds) {
      // If someone is both member and named staff, staff allow wins later
      if (namedStaff.has(userId)) continue;
      overwrites.push({
        id: userId,
        allow: MEMBER_ALLOW,
        deny: MEMBER_DENY,
        type: 1, // Member
      });
    }
  } else {
    // Soft-close: explicit deny so prior allows are wiped by .set()
    for (const userId of memberIds) {
      if (namedStaff.has(userId)) continue;
      overwrites.push({
        id: userId,
        deny: PermissionFlagsBits.ViewChannel,
        type: 1,
      });
    }
  }

  let staffRoleIds = opts.staffRoleIds;
  if (!staffRoleIds) {
    if (opts.guild) {
      staffRoleIds = getManageableStaffRoleIds(opts.guild, opts.botMember)
        .roleIds;
    } else {
      // Senior only — junior staff never get automatic ticket visibility
      staffRoleIds = listSeniorStaffRoles(guildId).map((r) => r.role_id);
    }
  }

  if (sensitive) {
    for (const userId of namedStaff) {
      overwrites.push({
        id: userId,
        allow: STAFF_ALLOW,
        type: 1,
      });
    }

    for (const roleId of staffRoleIds) {
      overwrites.push({
        id: roleId,
        deny: PermissionFlagsBits.ViewChannel,
        type: 0,
      });
    }
  } else {
    for (const roleId of staffRoleIds) {
      overwrites.push({
        id: roleId,
        allow: STAFF_ALLOW,
        type: 0,
      });
    }
    // Named staff still get user overwrites (useful if they lack staff role)
    for (const userId of namedStaff) {
      overwrites.push({
        id: userId,
        allow: STAFF_ALLOW,
        type: 1,
      });
    }
  }

  return overwrites;
}

/**
 * Apply overwrites to an existing channel (replace set).
 * @param {import("discord.js").GuildChannel} channel
 * @param {object} opts same as buildTicketOverwrites
 */
async function applyTicketOverwrites(channel, opts) {
  const guild = opts.guild || channel.guild;
  const merged = {
    ...opts,
    guild,
  };
  if (!merged.staffRoleIds && guild) {
    const { roleIds } = getManageableStaffRoleIds(guild, opts.botMember);
    merged.staffRoleIds = roleIds;
  }
  const overwrites = buildTicketOverwrites(merged);
  if (typeof channel.permissionOverwrites?.set === "function") {
    await channel.permissionOverwrites.set(overwrites);
    return;
  }
  if (typeof channel.permissionOverwrites?.edit === "function") {
    for (const ow of overwrites) {
      await channel.permissionOverwrites.edit(ow.id, {
        allow: ow.allow,
        deny: ow.deny,
      });
    }
  }
}

/**
 * Human-readable hint for DiscordAPIError 50013 on channel create.
 * @param {Error} err
 * @returns {string}
 */
function formatChannelCreateError(err) {
  const code = err?.code ?? err?.rawError?.code;
  if (code === 50013 || /Missing Permissions/i.test(err?.message || "")) {
    return (
      "Discord rejected channel creation (**Missing Permissions**). Check:\n" +
      "1. Bot role has **Manage Channels** (server-wide or on the ticket category)\n" +
      "2. Bot role is **above** every role in `/staff role list`\n" +
      "3. Ticket category (if set) allows the bot to create channels\n" +
      "4. Remove deleted roles from `/staff role list` if any linger"
    );
  }
  return err?.message || String(err);
}

module.exports = {
  MEMBER_ALLOW,
  MEMBER_DENY,
  STAFF_ALLOW,
  BOT_ALLOW,
  botHighestRolePosition,
  getManageableStaffRoleIds,
  assertBotCanCreateTickets,
  buildTicketOverwrites,
  applyTicketOverwrites,
  formatChannelCreateError,
};
