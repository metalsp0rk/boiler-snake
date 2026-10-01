const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  AttachmentBuilder,
  Events,
} = require("discord.js");
const {
  isHoneypotChannel,
  isHoneypotWarningMessage,
  listAllHoneypotWarnings,
  memberHasStaffRole,
  findHoneypotBanRolesAmong,
  getHoneypotChannel,
  setHoneypotWarningMessage,
  addHoneypotChannel,
  removeHoneypotChannel,
  listHoneypotChannels,
  addStaffRole,
  removeStaffRole,
  listStaffRoles,
  addHoneypotBanRole,
  removeHoneypotBanRole,
  listHoneypotBanRoles,
  isHoneypotBanRole,
} = require("../../db");
const { key } = require("../../core/cooldowns");
const {
  isAdminOrModFromContext,
  requireStaffFromContext,
} = require("../../core/permissions");
const { logConfigChange, logHoneypotTrigger } = require("../logs/auditLog");
const { getDiscordOutbound } = require("../../platform/discord/outbound");
const { ensureCommunity, getCommunityById } = require("../../platform/community");

/**
 * Fluxer PR 2 Discord edge: external snowflake → internal INTEGER community id
 * (create-on-sight). The honeypot repos are community-keyed.
 * @param {string} externalGuildId Discord guild id
 * @returns {number} communities.id
 */
function communityIdFor(externalGuildId) {
  return ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: String(externalGuildId),
  });
}
const { registerJob } = require("../../core/scheduler");
const {
  recordSlashAudit,
  recordSystemAudit,
} = require("../../core/auditTrail");
const { renderHoneypotWarningPng } = require("./renderWarning");

const staffPerms = PermissionFlagsBits.ManageGuild;

// In-flight honeypot bans to avoid double-processing rapid messages
const honeypotBanning = new Set(); // key: guildId:userId

const commands = [
  new SlashCommandBuilder()
    .setName("honeypot")
    .setDescription("Configure honeypot channels and ban roles (staff).")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommandGroup((group) =>
      group
        .setName("channel")
        .setDescription("Manage honeypot channels.")
        .addSubcommand((sc) =>
          sc
            .setName("add")
            .setDescription(
              "Mark a channel as a honeypot (anyone who posts is banned).",
            )
            .addChannelOption((opt) =>
              opt
                .setName("channel")
                .setDescription("Channel to mark as a honeypot")
                .setRequired(true),
            ),
        )
        .addSubcommand((sc) =>
          sc
            .setName("list")
            .setDescription("List configured honeypot channels."),
        )
        .addSubcommand((sc) =>
          sc
            .setName("del")
            .setDescription("Remove a channel from the honeypot list.")
            .addChannelOption((opt) =>
              opt
                .setName("channel")
                .setDescription("Channel to remove from honeypot list")
                .setRequired(true),
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("banrole")
        .setDescription("Manage roles that ban a user when assigned.")
        .addSubcommand((sc) =>
          sc
            .setName("add")
            .setDescription(
              "Mark a role as a honeypot ban role (assigning it bans the member).",
            )
            .addRoleOption((opt) =>
              opt
                .setName("role")
                .setDescription(
                  "Role that triggers an automatic ban when granted",
                )
                .setRequired(true),
            ),
        )
        .addSubcommand((sc) =>
          sc.setName("list").setDescription("List honeypot ban roles."),
        )
        .addSubcommand((sc) =>
          sc
            .setName("del")
            .setDescription("Remove a role from the honeypot ban-role list.")
            .addRoleOption((opt) =>
              opt
                .setName("role")
                .setDescription("Role to remove from the ban-role list")
                .setRequired(true),
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("exempt")
        .setDescription("Manage roles exempt from honeypot bans.")
        .addSubcommand((sc) =>
          sc
            .setName("add")
            .setDescription(
              "Add a role that is exempt from honeypot bans (same as /staff role add).",
            )
            .addRoleOption((opt) =>
              opt
                .setName("role")
                .setDescription("Role to exempt (e.g. staff)")
                .setRequired(true),
            ),
        )
        .addSubcommand((sc) =>
          sc
            .setName("list")
            .setDescription("List roles exempt from honeypot bans."),
        )
        .addSubcommand((sc) =>
          sc
            .setName("del")
            .setDescription("Remove a role from the honeypot exempt list.")
            .addRoleOption((opt) =>
              opt
                .setName("role")
                .setDescription("Role to remove from exempt list")
                .setRequired(true),
            ),
        ),
    ),
];

/**
 * Post a human-facing honeypot warning (embed + modal-style image).
 * No plain-text content — simplistic bots that only scrape `content` see nothing useful.
 * Pins the message when possible and returns the sent Message.
 */
async function postHoneypotWarning(channel) {
  const png = renderHoneypotWarningPng();
  const file = new AttachmentBuilder(png, { name: "honeypot-warning.png" });

  // Image only — no content/embed text for scrapers to parse.
  // All human-facing copy is baked into the PNG.
  const msg = await channel.send({
    files: [file],
  });

  try {
    await msg.pin().catch(() => null);
  } catch {
    // Pin is best-effort (needs Manage Messages)
  }

  return msg;
}

/**
 * Ensure a honeypot channel has a bot warning message. Reuses existing one if still present.
 * Returns a short status string for the admin reply.
 *
 * `guild` is the discord.js Guild used for channel access; `communityId` is
 * the INTEGER repository key (roadmap § Repository boundary). Legacy callers
 * that only pass the guild get the id resolved at the edge — a snowflake
 * string must never reach the community-keyed repos (assertCommunityId
 * throws on it, which silently broke `/honeypot channel add` before this fix).
 */
async function ensureHoneypotWarning(guild, channelId, communityId) {
  const communityKey =
    communityId ??
    (guild?.id != null ? communityIdFor(String(guild.id)) : undefined);
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (
    !channel ||
    typeof channel.isTextBased !== "function" ||
    !channel.isTextBased()
  ) {
    return "Channel cannot receive messages — warning not posted.";
  }
  if (typeof channel.send !== "function") {
    return "Channel cannot receive messages — warning not posted.";
  }

  const existing = getHoneypotChannel(communityKey, channelId);
  if (existing?.warning_message_id) {
    const old = await channel.messages
      .fetch(existing.warning_message_id)
      .catch(() => null);
    if (old) {
      return "Warning notice already present (left in place).";
    }
  }

  try {
    const msg = await postHoneypotWarning(channel);
    setHoneypotWarningMessage(communityKey, channelId, msg.id);
    return "Warning notice posted and pinned (image only — no plain text).";
  } catch (e) {
    console.error(
      `[honeypot] Failed to post warning in ${guild.id}/${channelId}:`,
      e?.message || e,
    );
    return `Could not post warning notice: ${e?.message || e}`;
  }
}

/**
 * Shared honeypot ban: DM (optional copy) then guild ban.
 * Uses honeypotBanning to avoid double-processing.
 * Posts a staff audit-log embed via logHoneypotTrigger (richer than the generic ban log).
 * @returns {Promise<boolean>} true if a ban was attempted (or already in flight)
 */
async function executeHoneypotBan(
  guild,
  user,
  {
    reason,
    dmText,
    deleteMessage = null,
    trigger = "channel",
    channelId = null,
    roleIds = null,
  } = {},
) {
  if (!guild || !user?.id) return false;
  if (user.bot) return false;

  // Enforcement edges resolve the integer community id (spec § In-memory maps:
  // the banning set is keyed `${communityId}:${userId}`, not by snowflake).
  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: guild.id,
  });

  const banKey = key(communityId, user.id);
  if (honeypotBanning.has(banKey)) return true;
  honeypotBanning.add(banKey);

  let dmSent = null;
  let banned = false;
  let banError = null;
  const shortReason = reason || "Honeypot trigger";

  try {
    const guildName = guild.name;

    // DM first — ban can prevent later contact via the guild
    try {
      await user.send(
        dmText ||
          `You have been **banned** from **${guildName}**.\n\n` +
            `**Reason:** ${shortReason}. ` +
            `If you believe this was a mistake, contact the server staff through another channel.`,
      );
      dmSent = true;
    } catch (e) {
      dmSent = false;
      console.warn(
        `[honeypot] Could not DM ${user.id} in ${guild.id}:`,
        e?.message || e,
      );
    }

    if (deleteMessage) {
      try {
        if (deleteMessage.deletable) await deleteMessage.delete();
      } catch (e) {
        console.warn(
          `[honeypot] Could not delete message in ${guild.id}:`,
          e?.message || e,
        );
      }
    }

    try {
      await guild.members.ban(user.id, {
        reason: `Honeypot: ${shortReason}`,
        deleteMessageSeconds: 0,
      });
      banned = true;
      console.log(
        `[honeypot] Banned ${user.tag || user.username} (${user.id}) in ${guildName} (${guild.id}): ${shortReason}`,
      );
    } catch (e) {
      banError = e?.message || String(e);
      console.error(
        `[honeypot] Failed to ban ${user.id} in ${guild.id}:`,
        banError,
      );
    }

    recordSystemAudit({
      communityId,
      action: "honeypot.enforce",
      targetType: "user",
      targetId: user.id,
      details: {
        trigger,
        channel_id:
          channelId ||
          deleteMessage?.channel?.id ||
          deleteMessage?.channelId ||
          null,
        role_ids: roleIds || null,
        banned: banned ? 1 : 0,
        error: banError,
      },
    });

    // Staff audit channel (if configured) — dedicated honeypot embed
    try {
      const client = guild.client;
      if (client) {
        await logHoneypotTrigger(getDiscordOutbound(client), guild, {
          user,
          trigger,
          channelId:
            channelId ||
            deleteMessage?.channel?.id ||
            deleteMessage?.channelId ||
            null,
          roleIds: roleIds || null,
          reason: shortReason,
          banned,
          dmSent,
          error: banError,
        });
      }
    } catch (e) {
      console.warn(
        `[honeypot] Audit log failed for ${user.id} in ${guild.id}:`,
        e?.message || e,
      );
    }
  } finally {
    setTimeout(() => honeypotBanning.delete(banKey), 10_000);
  }

  return true;
}

/**
 * Strip one reaction emoji from a honeypot warning notice (full wipe when possible).
 */
async function stripHoneypotWarningReaction(reaction) {
  if (!reaction) return false;
  try {
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        /* continue with best effort */
      }
    }
    await reaction.remove();
    return true;
  } catch (err) {
    // Fall back to removing individual reactors (still needs Manage Messages for others)
    try {
      if (reaction.users?.cache?.size) {
        for (const userId of reaction.users.cache.keys()) {
          await reaction.users.remove(userId).catch(() => null);
        }
        return true;
      }
    } catch {
      /* ignore */
    }
    console.warn(
      `[honeypot] Could not strip reaction on warning notice:`,
      err?.message || err,
    );
    return false;
  }
}

/**
 * If the reaction is on a honeypot warning notice, remove it and return true.
 * Runs for any user (including bots) so the notice stays reaction-free.
 */
async function handleHoneypotWarningReaction(reaction) {
  const message = reaction?.message;
  if (!message) return false;

  const messageId = message.id;
  // Fluxer PR 2: repo is community-keyed — resolve the integer at this edge.
  const communityId = communityIdFor(message.guildId || message.guild?.id);
  if (!isHoneypotWarningMessage(communityId, messageId)) return false;

  await stripHoneypotWarningReaction(reaction);
  return true;
}

/**
 * Sweep all honeypot warning notices and clear any leftover reactions
 * (e.g. added while the bot was offline, or missed by the live handler).
 */
async function sweepHoneypotWarningReactions(client) {
  const rows = listAllHoneypotWarnings();
  if (!rows.length) return;

  for (const row of rows) {
    try {
      // Rows key by community id; the Discord cache needs the external id.
      const externalGuildId = getCommunityById(row.community_id)?.externalGuildId;
      if (!externalGuildId) continue;
      const guild =
        client.guilds.cache.get(externalGuildId) ||
        (await client.guilds.fetch(externalGuildId).catch(() => null));
      if (!guild) continue;

      const channel = await guild.channels
        .fetch(row.channel_id)
        .catch(() => null);
      if (
        !channel ||
        typeof channel.isTextBased !== "function" ||
        !channel.isTextBased()
      ) {
        continue;
      }

      const msg = await channel.messages
        .fetch(row.warning_message_id)
        .catch(() => null);
      if (!msg) continue;

      const count = msg.reactions?.cache?.size || 0;
      if (count === 0) continue;

      try {
        await msg.reactions.removeAll();
      } catch {
        for (const reaction of msg.reactions.cache.values()) {
          await reaction.remove().catch(() => null);
        }
      }
    } catch (e) {
      console.warn(
        `[honeypot] Warning reaction sweep failed for ${row.community_id}/${row.channel_id}:`,
        e?.message || e,
      );
    }
  }
}

/**
 * If the message is in a honeypot channel, delete it and ban the author (unless exempt).
 * Exempt users still have their message deleted, but are not banned.
 * Returns true when the message was handled as honeypot traffic (caller should not award XP).
 */
async function handleHoneypotMessage(message) {
  // Fluxer PR 2: the honeypot repository is community-keyed — resolve the
  // integer community id at this Discord edge.
  const communityId = communityIdFor(message.guild.id);
  if (!isHoneypotChannel(communityId, message.channel.id)) return false;

  let member = message.member;
  if (!member) {
    member = await message.guild.members
      .fetch(message.author.id)
      .catch(() => null);
  }

  // Exempt roles (staff, etc.) — no ban, but still delete the message so the channel stays empty
  if (member) {
    const roleIds = [...member.roles.cache.keys()];
    // staffRoles repo is community-keyed (PR 2): reuse the resolved id.
    if (memberHasStaffRole(communityId, roleIds)) {
      try {
        if (message.deletable) await message.delete();
      } catch (e) {
        console.warn(
          `[honeypot] Could not delete exempt message in ${message.guild.id}:`,
          e?.message || e,
        );
      }
      return true;
    }
  }

  await executeHoneypotBan(message.guild, message.author, {
    reason: "Posted in a honeypot channel",
    dmText:
      `You have been **banned** from **${message.guild.name}**.\n\n` +
      `**Reason:** You posted in a restricted channel that is used to catch spam accounts and raids. ` +
      `If you believe this was a mistake, contact the server staff through another channel.`,
    deleteMessage: message,
    trigger: "channel",
    channelId: message.channel?.id || message.channelId,
  });

  return true;
}

/**
 * Fluxer honeypot check for a NormalizedMessage (PR 6 scope, spec
 * § Normalized gateway events: "a prefix line in a honeypot channel is a
 * honeypot hit"). Resolves the configured channel by the message's INTEGER
 * community id (the pipeline resolves it before calling this).
 *
 * PR 6 limits: OutboundClient has NO message-delete method and the ban path is
 * elevated (community flag 0 → banMember refuses with code elevated_disabled),
 * so a hit CONSUMES the message (no XP, no gork, no dispatch) and logs both
 * suppressions instead of inventing methods. Staff-exempt authors keep their
 * message (no delete surface) and are never banned.
 *
 * @param {object} outbound OutboundClient (Fluxer adapter)
 * @param {object} message NormalizedMessage (communityId resolved)
 * @returns {Promise<boolean>} true when the message is honeypot traffic
 */
async function handleHoneypotFluxerMessage(outbound, message) {
  const communityId = message.communityId;
  if (!Number.isSafeInteger(communityId)) return false;
  if (!isHoneypotChannel(communityId, message.channelId)) return false;

  // Honeypot hit: the line is consumed as a hit, never as a command/XP.
  let roleIds = Array.isArray(message.memberRoleIds) ? message.memberRoleIds : [];
  try {
    const member = await outbound.fetchMember(communityId, message.authorId);
    if (member && Array.isArray(member.roleIds)) roleIds = member.roleIds;
  } catch (e) {
    console.warn(
      `[fluxer] honeypot member fetch failed for ${message.authorId} in community ${communityId}:`,
      e?.message || e,
    );
  }

  if (memberHasStaffRole(communityId, roleIds)) {
    console.log(
      `[fluxer] honeypot hit by exempt member ${message.authorId} in community ${communityId} channel ${message.channelId}: message stands (no delete surface in PR 6), no ban`,
    );
    return true;
  }

  console.log(
    `[fluxer] honeypot ban suppressed: elevated_permissions=0 (community ${communityId}, user ${message.authorId})`,
  );
  console.log(
    `[fluxer] honeypot message delete suppressed: no OutboundClient.deleteMessage before PR 9 (message ${message.id})`,
  );
  return true;
}

/**
 * If the member was granted a honeypot ban role, ban them (unless exempt).
 */
async function handleHoneypotBanRole(oldMember, newMember) {
  if (!newMember?.guild) return;
  if (newMember.user?.bot) return;

  const guildId = newMember.guild.id;
  const oldRoles = oldMember?.roles?.cache ?? new Map();
  const newRoles = newMember.roles?.cache ?? new Map();

  const addedRoleIds = [];
  for (const roleId of newRoles.keys()) {
    if (roleId === guildId) continue; // @everyone
    if (!oldRoles.has(roleId)) addedRoleIds.push(roleId);
  }
  if (!addedRoleIds.length) return;

  const matched = findHoneypotBanRolesAmong(
    communityIdFor(guildId),
    addedRoleIds,
  );
  if (!matched.length) return;

  // staffRoles repo is community-keyed; resolve the integer at this edge.
  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: guildId,
  });

  const allRoleIds = [...newRoles.keys()];
  if (memberHasStaffRole(communityId, allRoleIds)) {
    console.log(
      `[honeypot] Skip ban-role for exempt member ${newMember.id} in ${guildId} ` +
        `(roles: ${matched.join(", ")})`,
    );
    return;
  }

  const roleMentions = matched.map((id) => `<@&${id}>`).join(", ");
  await executeHoneypotBan(newMember.guild, newMember.user, {
    reason: `Received honeypot ban role (${matched.join(", ")})`,
    dmText:
      `You have been **banned** from **${newMember.guild.name}**.\n\n` +
      `**Reason:** You were assigned a restricted role that is used to catch spam accounts and raids. ` +
      `If you believe this was a mistake, contact the server staff through another channel.`,
    trigger: "ban_role",
    roleIds: matched,
  });

  console.log(
    `[honeypot] Ban-role trigger for ${newMember.id} in ${guildId}: ${roleMentions}`,
  );
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleHoneypot(commandCtx, featureCtx) {
  void featureCtx;
  // The context builder resolves the integer community id at the Discord edge
  // (roadmap/fluxer.md § CommandContext); repositories use it directly.
  const { communityId, outbound } = commandCtx;
  // Display/audit key keeps the external (Discord) snowflake.
  const guildId = commandCtx.externalGuildId;

  // Discord-only escape hatch (roadmap § What stays Discord-only): the warning
  // notice poster and the warning-message cleanup need real discord.js
  // Guild/Message objects — the service-side cutover to the OutboundClient is
  // PR 7. Fluxer contexts never carry rawInteraction.
  const raw = commandCtx.rawInteraction;

  const group = commandCtx.subcommandGroup;
  const sub = commandCtx.subcommand;

  // exempt mutates staff_roles — ManageGuild only (same as /staff role)
  if (group === "exempt") {
    if (!isAdminOrModFromContext(commandCtx)) {
      await commandCtx.reply({
        content: "Only server administrators can manage honeypot exempt roles.",
        sensitive: true,
      });
      return;
    }
  } else if (!(await requireStaffFromContext(commandCtx))) {
    return;
  }

  // /honeypot channel [add|list|del]
  if (group === "channel") {
    if (sub === "add") {
      const ch = commandCtx.options.getChannel("channel", true);

      // Channel existence via outbound (roadmap § Outbound client): the
      // Discord adapter returns the discord.js channel, null when the bot
      // cannot see it.
      const channelHandle = await outbound.fetchChannel(communityId, ch.id);
      if (!channelHandle) {
        await commandCtx.reply({
          content: `Could not find <#${ch.id}> in this server — the bot must be able to view a channel to mark it as a honeypot.`,
          sensitive: true,
        });
        return;
      }

      if (isHoneypotChannel(communityId, ch.id)) {
        await commandCtx.reply({
          content: `<#${ch.id}> is already set up as a honeypot channel.`,
          sensitive: true,
        });
        return;
      }

      addHoneypotChannel(communityId, ch.id);
      recordSlashAudit({
        communityId,
        actorUserId: commandCtx.userId,
        action: "honeypot.channel_add",
        targetType: "channel",
        targetId: ch.id,
      });
      // Warning-notice poster needs a discord.js Guild (service cutover PR 7);
      // the repo key is the INTEGER community id (never the guild snowflake).
      const warningStatus = await ensureHoneypotWarning(raw?.guild, ch.id, communityId);
      await logConfigChange(outbound, guildId, {
        title: "Honeypot channel added",
        command: "/honeypot channel add",
        actor: commandCtx.user,
        changes: [`Channel: <#${ch.id}> (\`${ch.id}\`)`],
        details: warningStatus,
      }).catch(() => {});
      await commandCtx.reply({
        content:
          `Marked <#${ch.id}> as a **honeypot** channel.\n` +
          `Anyone who posts there will be banned immediately (except members with exempt roles).\n` +
          `${warningStatus}\n` +
          `Tip: use \`/staff role add\` (or \`/honeypot exempt add\`) to configure staff roles so they are not banned by mistake.`,
        sensitive: true,
      });
      return;
    }

    if (sub === "del") {
      const ch = commandCtx.options.getChannel("channel", true);
      const { removed, warning_message_id } = removeHoneypotChannel(
        communityId,
        ch.id,
      );

      let warningNote = "";
      if (removed && warning_message_id) {
        // Deleting the warning notice is Discord-only: OutboundClient has no
        // message-delete surface yet (service cutover PR 7). The Discord arm
        // uses the raw interaction's guild.
        try {
          const channel = raw?.guild
            ? await raw.guild.channels.fetch(ch.id).catch(() => null)
            : null;
          if (channel?.messages) {
            const msg = await channel.messages
              .fetch(warning_message_id)
              .catch(() => null);
            if (msg) {
              await msg.delete().catch(() => null);
              warningNote = " Warning notice removed.";
            }
          }
        } catch {
          warningNote =
            " (Could not delete warning notice — remove it manually if needed.)";
        }
      }

      if (removed) {
        recordSlashAudit({
          communityId,
          actorUserId: commandCtx.userId,
          action: "honeypot.channel_del",
          targetType: "channel",
          targetId: ch.id,
        });
        await logConfigChange(outbound, guildId, {
          title: "Honeypot channel removed",
          command: "/honeypot channel del",
          actor: commandCtx.user,
          changes: [`Channel: <#${ch.id}> (\`${ch.id}\`)`],
          details: warningNote.trim() || undefined,
        }).catch(() => {});
      }

      await commandCtx.reply({
        content: removed
          ? `Removed <#${ch.id}> from the honeypot list.${warningNote}`
          : `<#${ch.id}> was not a honeypot channel.`,
        sensitive: true,
      });
      return;
    }

    if (sub === "list") {
      const rows = listHoneypotChannels(communityId);
      if (!rows.length) {
        await commandCtx.reply({
          content: "No honeypot channels configured.",
          sensitive: true,
        });
        return;
      }
      const lines = rows.map((r) => `- <#${r.channel_id}>`);
      await commandCtx.reply({
        content: `**Honeypot channels:**\n${lines.join("\n")}`,
        sensitive: true,
      });
      return;
    }
  }

  // /honeypot banrole [add|list|del]
  if (group === "banrole") {
    if (sub === "add") {
      const role = commandCtx.options.getRole("role", true);

      if (role.id === guildId) {
        await commandCtx.reply({
          content: "You cannot use @everyone as a honeypot ban role.",
          sensitive: true,
        });
        return;
      }
      // Spec RoleHandle carries no `managed` flag — graft the Discord-side
      // role object from the documented rawInteraction escape hatch (userinfo
      // precedent). Fluxer contexts carry no raw, so integration-managed roles
      // are not detectable there until the Fluxer role surface lands (PR 9).
      const rawRole = raw?.guild?.roles?.cache?.get?.(role.id) ?? null;
      if (rawRole?.managed) {
        await commandCtx.reply({
          content:
            "That role is managed by an integration. Prefer a normal server role for ban-role honeypots.",
          sensitive: true,
        });
        return;
      }
      if (isHoneypotBanRole(communityId, role.id)) {
        await commandCtx.reply({
          content: `<@&${role.id}> is already a honeypot ban role.`,
          sensitive: true,
        });
        return;
      }

      addHoneypotBanRole(communityId, role.id);
      recordSlashAudit({
        communityId,
        actorUserId: commandCtx.userId,
        action: "honeypot.ban_role_add",
        targetType: "role",
        targetId: role.id,
      });
      await logConfigChange(outbound, guildId, {
        title: "Honeypot ban role added",
        command: "/honeypot banrole add",
        actor: commandCtx.user,
        changes: [`Role: <@&${role.id}> (\`${role.id}\`)`],
      }).catch(() => {});
      await commandCtx.reply({
        content:
          `Marked <@&${role.id}> as a **honeypot ban role**.\n` +
          `Anyone who is **granted** this role will be banned immediately ` +
          `(except members with honeypot exempt roles).\n` +
          `Tip: configure \`/staff role add\` (or \`/honeypot exempt add\`) for staff first. ` +
          `Members who already have the role are not retroactively banned.`,
        sensitive: true,
      });
      return;
    }

    if (sub === "del") {
      const role = commandCtx.options.getRole("role", true);
      const removed = removeHoneypotBanRole(communityId, role.id);
      if (removed) {
        recordSlashAudit({
          communityId,
          actorUserId: commandCtx.userId,
          action: "honeypot.ban_role_del",
          targetType: "role",
          targetId: role.id,
        });
        await logConfigChange(outbound, guildId, {
          title: "Honeypot ban role removed",
          command: "/honeypot banrole del",
          actor: commandCtx.user,
          changes: [`Role: <@&${role.id}> (\`${role.id}\`)`],
        }).catch(() => {});
      }
      await commandCtx.reply({
        content: removed
          ? `Removed <@&${role.id}> from the honeypot ban-role list.`
          : `<@&${role.id}> was not a honeypot ban role.`,
        sensitive: true,
      });
      return;
    }

    if (sub === "list") {
      const rows = listHoneypotBanRoles(communityId);
      if (!rows.length) {
        await commandCtx.reply({
          content: "No honeypot ban roles configured.",
          sensitive: true,
        });
        return;
      }
      const lines = rows.map((r) => `- <@&${r.role_id}>`);
      await commandCtx.reply({
        content: `**Honeypot ban roles** (granting these bans the member):\n${lines.join("\n")}`,
        sensitive: true,
      });
      return;
    }
  }

  // /honeypot exempt [add|list|del]
  if (group === "exempt") {
    if (sub === "add") {
      const role = commandCtx.options.getRole("role", true);
      addStaffRole(communityId, role.id);
      // Same underlying table as /staff role add — keep the action vocabulary.
      recordSlashAudit({
        communityId,
        actorUserId: commandCtx.userId,
        action: "staff.role_add",
        targetType: "role",
        targetId: role.id,
        details: { via: "honeypot.exempt" },
      });
      await logConfigChange(outbound, guildId, {
        title: "Honeypot exempt role added",
        command: "/honeypot exempt add",
        actor: commandCtx.user,
        changes: [`Role: <@&${role.id}> (\`${role.id}\`)`],
      }).catch(() => {});
      await commandCtx.reply({
        content:
          `Added <@&${role.id}> as a staff role (also used for honeypot exemption). ` +
          `Members with this role will not be banned for posting in honeypot channels or receiving honeypot ban roles.`,
        sensitive: true,
      });
      return;
    }

    if (sub === "del") {
      const role = commandCtx.options.getRole("role", true);
      const removed = removeStaffRole(communityId, role.id);
      if (removed) {
        recordSlashAudit({
          communityId,
          actorUserId: commandCtx.userId,
          action: "staff.role_remove",
          targetType: "role",
          targetId: role.id,
          details: { via: "honeypot.exempt" },
        });
        await logConfigChange(outbound, guildId, {
          title: "Honeypot exempt role removed",
          command: "/honeypot exempt del",
          actor: commandCtx.user,
          changes: [`Role: <@&${role.id}> (\`${role.id}\`)`],
        }).catch(() => {});
      }
      await commandCtx.reply({
        content: removed
          ? `Removed <@&${role.id}> from staff roles (also removes honeypot exemption).`
          : `<@&${role.id}> is not a configured staff role.`,
        sensitive: true,
      });
      return;
    }

    if (sub === "list") {
      const rows = listStaffRoles(communityId);
      if (!rows.length) {
        await commandCtx.reply({
          content:
            "No staff roles configured. Staff who hit honeypots will be banned.",
          sensitive: true,
        });
        return;
      }
      const lines = rows.map((r) => `- <@&${r.role_id}>`);
      await commandCtx.reply({
        content: `**Staff roles (also used for honeypot exemption):**\n${lines.join("\n")}`,
        sensitive: true,
      });
      return;
    }
  }

  // Always answer /honeypot so we never fall through as "handler missing"
  await commandCtx.reply({
    content:
      `Unknown honeypot subcommand: \`/${commandCtx.commandName}` +
      `${group ? ` ${group}` : ""} ${sub || ""}\`.\n` +
      `Use \`/honeypot channel add|list|del\`, \`/honeypot banrole add|list|del\`, or \`/honeypot exempt add|list|del\`.`,
    sensitive: true,
  });
  return;
}

/**
 * PR 7: the first argument is the supervisor. Gateway binds attach to
 * supervisor.discord only (Fluxer gateway events are wired in the
 * elevated-permissions PR; spec § Scheduler jobs).
 * @param {object|null} supervisor
 * @param {object} [featureCtx]
 */
function registerEvents(supervisor, featureCtx) {
  void featureCtx;
  const client =
    supervisor && typeof supervisor.clientForCommunity === "function"
      ? supervisor.discord ?? null
      : supervisor && supervisor.on
        ? supervisor // legacy raw discord.js client
        : null;
  if (!client) return; // Discord unconfigured → no-op binds

  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    try {
      await handleHoneypotBanRole(oldMember, newMember);
    } catch (e) {
      console.error(
        "[GuildMemberUpdate] honeypot banrole error:",
        e?.message || e,
      );
    }
  });
}

/**
 * @param {object|null} supervisor PR 7 supervisor ({discord, fluxer, clientForCommunity})
 * @param {object} [featureCtx]
 */
function start(supervisor, featureCtx) {
  void featureCtx;
  // The sweep walks Discord guilds from the client cache (spec 581: per client
  // that has the guild in cache). Fluxer rows in the warnings table resolve to
  // no Discord guild and are skipped inside the sweep loop.
  const client =
    supervisor && typeof supervisor.clientForCommunity === "function"
      ? supervisor.discord ?? null
      : supervisor && supervisor.guilds
        ? supervisor // legacy raw discord.js client
        : null;

  registerJob({
    name: "honeypotSweep",
    intervalMs: 10 * 60 * 1000,
    runImmediately: true,
    run: () => {
      if (!client) {
        // Discord unconfigured → the sweep has no guild cache to walk.
        console.log(
          "[honeypot] Discord client not configured — warning-reaction sweep skipped",
        );
        return;
      }
      return sweepHoneypotWarningReactions(client);
    },
  });
}

module.exports = {
  name: "honeypot",
  commands,
  handlers: {
    honeypot: handleHoneypot,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): the slash
  // handler receives a CommandContext. Pipeline/registration hooks stay on the
  // raw gateway event (untouched until PR 7).
  handlerApi: {
    honeypot: "context",
  },
  registerEvents,
  start,
  ensureHoneypotWarning,
  handleHoneypotMessage,
  handleHoneypotFluxerMessage,
  handleHoneypotWarningReaction,
  handleHoneypotBanRole,
  postHoneypotWarning,
  executeHoneypotBan,
  sweepHoneypotWarningReactions,
};
