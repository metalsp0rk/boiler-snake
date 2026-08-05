const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  AttachmentBuilder,
  Events,
} = require("discord.js");
const {
  getGuildSettings,
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
const { isAdminOrMod } = require("../../core/permissions");
const { logConfigChange, logHoneypotTrigger } = require("../logs/auditLog");
const { renderHoneypotWarningPng } = require("./renderWarning");

const adminPerms = PermissionFlagsBits.ManageGuild;

// In-flight honeypot bans to avoid double-processing rapid messages
const honeypotBanning = new Set(); // key: guildId:userId

const commands = [
  new SlashCommandBuilder()
      .setName("honeypot")
      .setDescription("Configure honeypot channels and ban roles (admin only).")
      .setDefaultMemberPermissions(adminPerms)
      .addSubcommandGroup((group) =>
        group
          .setName("channel")
          .setDescription("Manage honeypot channels.")
          .addSubcommand((sc) =>
            sc
              .setName("add")
              .setDescription("Mark a channel as a honeypot (anyone who posts is banned).")
              .addChannelOption((opt) =>
                opt
                  .setName("channel")
                  .setDescription("Channel to mark as a honeypot")
                  .setRequired(true)
              )
          )
          .addSubcommand((sc) =>
            sc
              .setName("list")
              .setDescription("List configured honeypot channels.")
          )
          .addSubcommand((sc) =>
            sc
              .setName("del")
              .setDescription("Remove a channel from the honeypot list.")
              .addChannelOption((opt) =>
                opt
                  .setName("channel")
                  .setDescription("Channel to remove from honeypot list")
                  .setRequired(true)
              )
          )
      )
      .addSubcommandGroup((group) =>
        group
          .setName("banrole")
          .setDescription("Manage roles that ban a user when assigned.")
          .addSubcommand((sc) =>
            sc
              .setName("add")
              .setDescription("Mark a role as a honeypot ban role (assigning it bans the member).")
              .addRoleOption((opt) =>
                opt
                  .setName("role")
                  .setDescription("Role that triggers an automatic ban when granted")
                  .setRequired(true)
              )
          )
          .addSubcommand((sc) =>
            sc
              .setName("list")
              .setDescription("List honeypot ban roles.")
          )
          .addSubcommand((sc) =>
            sc
              .setName("del")
              .setDescription("Remove a role from the honeypot ban-role list.")
              .addRoleOption((opt) =>
                opt
                  .setName("role")
                  .setDescription("Role to remove from the ban-role list")
                  .setRequired(true)
              )
          )
      )
      .addSubcommandGroup((group) =>
        group
          .setName("exempt")
          .setDescription("Manage roles exempt from honeypot bans.")
          .addSubcommand((sc) =>
            sc
              .setName("add")
              .setDescription("Add a role that is exempt from honeypot bans (same as /staff role add).")
              .addRoleOption((opt) =>
                opt
                  .setName("role")
                  .setDescription("Role to exempt (e.g. staff)")
                  .setRequired(true)
              )
          )
          .addSubcommand((sc) =>
            sc
              .setName("list")
              .setDescription("List roles exempt from honeypot bans.")
          )
          .addSubcommand((sc) =>
            sc
              .setName("del")
              .setDescription("Remove a role from the honeypot exempt list.")
              .addRoleOption((opt) =>
                opt
                  .setName("role")
                  .setDescription("Role to remove from exempt list")
                  .setRequired(true)
              )
          )
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
 */
async function ensureHoneypotWarning(guild, channelId) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || typeof channel.isTextBased !== "function" || !channel.isTextBased()) {
    return "Channel cannot receive messages — warning not posted.";
  }
  if (typeof channel.send !== "function") {
    return "Channel cannot receive messages — warning not posted.";
  }

  const existing = getHoneypotChannel(guild.id, channelId);
  if (existing?.warning_message_id) {
    const old = await channel.messages.fetch(existing.warning_message_id).catch(() => null);
    if (old) {
      return "Warning notice already present (left in place).";
    }
  }

  try {
    const msg = await postHoneypotWarning(channel);
    setHoneypotWarningMessage(guild.id, channelId, msg.id);
    return "Warning notice posted and pinned (image only — no plain text).";
  } catch (e) {
    console.error(`[honeypot] Failed to post warning in ${guild.id}/${channelId}:`, e?.message || e);
    return `Could not post warning notice: ${e?.message || e}`;
  }
}

/**
 * Shared honeypot ban: DM (optional copy) then guild ban.
 * Uses honeypotBanning to avoid double-processing.
 * Posts a staff audit-log embed via logHoneypotTrigger (richer than the generic ban log).
 * @returns {Promise<boolean>} true if a ban was attempted (or already in flight)
 */
async function executeHoneypotBan(guild, user, {
  reason,
  dmText,
  deleteMessage = null,
  trigger = "channel",
  channelId = null,
  roleIds = null,
} = {}) {
  if (!guild || !user?.id) return false;
  if (user.bot) return false;

  const banKey = key(guild.id, user.id);
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
            `If you believe this was a mistake, contact the server staff through another channel.`
      );
      dmSent = true;
    } catch (e) {
      dmSent = false;
      console.warn(
        `[honeypot] Could not DM ${user.id} in ${guild.id}:`,
        e?.message || e
      );
    }

    if (deleteMessage) {
      try {
        if (deleteMessage.deletable) await deleteMessage.delete();
      } catch (e) {
        console.warn(
          `[honeypot] Could not delete message in ${guild.id}:`,
          e?.message || e
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
        `[honeypot] Banned ${user.tag || user.username} (${user.id}) in ${guildName} (${guild.id}): ${shortReason}`
      );
    } catch (e) {
      banError = e?.message || String(e);
      console.error(
        `[honeypot] Failed to ban ${user.id} in ${guild.id}:`,
        banError
      );
    }

    // Staff audit channel (if configured) — dedicated honeypot embed
    try {
      const client = guild.client;
      if (client) {
        await logHoneypotTrigger(client, guild, {
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
        e?.message || e
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
      err?.message || err
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

  const guildId = message.guildId || message.guild?.id;
  const messageId = message.id;
  if (!isHoneypotWarningMessage(guildId, messageId)) return false;

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
      const guild =
        client.guilds.cache.get(row.guild_id) ||
        (await client.guilds.fetch(row.guild_id).catch(() => null));
      if (!guild) continue;

      const channel = await guild.channels.fetch(row.channel_id).catch(() => null);
      if (!channel || typeof channel.isTextBased !== "function" || !channel.isTextBased()) {
        continue;
      }

      const msg = await channel.messages.fetch(row.warning_message_id).catch(() => null);
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
        `[honeypot] Warning reaction sweep failed for ${row.guild_id}/${row.channel_id}:`,
        e?.message || e
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
  if (!isHoneypotChannel(message.guild.id, message.channel.id)) return false;

  let member = message.member;
  if (!member) {
    member = await message.guild.members.fetch(message.author.id).catch(() => null);
  }

  // Exempt roles (staff, etc.) — no ban, but still delete the message so the channel stays empty
  if (member) {
    const roleIds = [...member.roles.cache.keys()];
    if (memberHasStaffRole(message.guild.id, roleIds)) {
      try {
        if (message.deletable) await message.delete();
      } catch (e) {
        console.warn(
          `[honeypot] Could not delete exempt message in ${message.guild.id}:`,
          e?.message || e
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

  const matched = findHoneypotBanRolesAmong(guildId, addedRoleIds);
  if (!matched.length) return;

  const allRoleIds = [...newRoles.keys()];
  if (memberHasStaffRole(guildId, allRoleIds)) {
    console.log(
      `[honeypot] Skip ban-role for exempt member ${newMember.id} in ${guildId} ` +
        `(roles: ${matched.join(", ")})`
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
    `[honeypot] Ban-role trigger for ${newMember.id} in ${guildId}: ${roleMentions}`
  );
}


async function handleHoneypot(interaction, ctx) {
  const { client, ensureHoneypotWarning } = ctx;
  const guildId = interaction.guildId;
  const settings = getGuildSettings(guildId);
  const admin = isAdminOrMod(interaction);

  if (!admin) {
    await interaction.reply({
      content: "You don't have permission to use this.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  // /honeypot channel [add|list|del]
  if (group === "channel") {
    if (sub === "add") {
      const ch = interaction.options.getChannel("channel", true);

      if (isHoneypotChannel(guildId, ch.id)) {
        await interaction.reply({
          content: `<#${ch.id}> is already set up as a honeypot channel.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      addHoneypotChannel(guildId, ch.id);
      const warningStatus = await ensureHoneypotWarning(interaction.guild, ch.id);
      await logConfigChange(client, guildId, {
        title: "Honeypot channel added",
        command: "/honeypot channel add",
        actor: interaction.user,
        changes: [`Channel: <#${ch.id}> (\`${ch.id}\`)`],
        details: warningStatus,
      }).catch(() => {});
      await interaction.reply({
        content:
          `Marked <#${ch.id}> as a **honeypot** channel.\n` +
          `Anyone who posts there will be banned immediately (except members with exempt roles).\n` +
          `${warningStatus}\n` +
          `Tip: use \`/staff role add\` (or \`/honeypot exempt add\`) to configure staff roles so they are not banned by mistake.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "del") {
      const ch = interaction.options.getChannel("channel", true);
      const { removed, warning_message_id } = removeHoneypotChannel(guildId, ch.id);

      let warningNote = "";
      if (removed && warning_message_id) {
        try {
          const channel = await interaction.guild.channels.fetch(ch.id).catch(() => null);
          if (channel?.messages) {
            const msg = await channel.messages.fetch(warning_message_id).catch(() => null);
            if (msg) {
              await msg.delete().catch(() => null);
              warningNote = " Warning notice removed.";
            }
          }
        } catch {
          warningNote = " (Could not delete warning notice — remove it manually if needed.)";
        }
      }

      if (removed) {
        await logConfigChange(client, guildId, {
          title: "Honeypot channel removed",
          command: "/honeypot channel del",
          actor: interaction.user,
          changes: [`Channel: <#${ch.id}> (\`${ch.id}\`)`],
          details: warningNote.trim() || undefined,
        }).catch(() => {});
      }

      await interaction.reply({
        content: removed
          ? `Removed <#${ch.id}> from the honeypot list.${warningNote}`
          : `<#${ch.id}> was not a honeypot channel.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "list") {
      const rows = listHoneypotChannels(guildId);
      if (!rows.length) {
        await interaction.reply({
          content: "No honeypot channels configured.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const lines = rows.map((r) => `- <#${r.channel_id}>`);
      await interaction.reply({
        content: `**Honeypot channels:**\n${lines.join("\n")}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  // /honeypot banrole [add|list|del]
  if (group === "banrole") {
    if (sub === "add") {
      const role = interaction.options.getRole("role", true);

      if (role.id === guildId) {
        await interaction.reply({
          content: "You cannot use @everyone as a honeypot ban role.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (role.managed) {
        await interaction.reply({
          content:
            "That role is managed by an integration. Prefer a normal server role for ban-role honeypots.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (isHoneypotBanRole(guildId, role.id)) {
        await interaction.reply({
          content: `${role} is already a honeypot ban role.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      addHoneypotBanRole(guildId, role.id);
      await logConfigChange(client, guildId, {
        title: "Honeypot ban role added",
        command: "/honeypot banrole add",
        actor: interaction.user,
        changes: [`Role: ${role} (\`${role.id}\`)`],
      }).catch(() => {});
      await interaction.reply({
        content:
          `Marked ${role} as a **honeypot ban role**.\n` +
          `Anyone who is **granted** this role will be banned immediately ` +
          `(except members with honeypot exempt roles).\n` +
          `Tip: configure \`/staff role add\` (or \`/honeypot exempt add\`) for staff first. ` +
          `Members who already have the role are not retroactively banned.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "del") {
      const role = interaction.options.getRole("role", true);
      const removed = removeHoneypotBanRole(guildId, role.id);
      if (removed) {
        await logConfigChange(client, guildId, {
          title: "Honeypot ban role removed",
          command: "/honeypot banrole del",
          actor: interaction.user,
          changes: [`Role: ${role} (\`${role.id}\`)`],
        }).catch(() => {});
      }
      await interaction.reply({
        content: removed
          ? `Removed ${role} from the honeypot ban-role list.`
          : `${role} was not a honeypot ban role.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "list") {
      const rows = listHoneypotBanRoles(guildId);
      if (!rows.length) {
        await interaction.reply({
          content: "No honeypot ban roles configured.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const lines = rows.map((r) => `- <@&${r.role_id}>`);
      await interaction.reply({
        content:
          `**Honeypot ban roles** (granting these bans the member):\n${lines.join("\n")}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  // /honeypot exempt [add|list|del]
  if (group === "exempt") {
    if (sub === "add") {
      const role = interaction.options.getRole("role", true);
      addStaffRole(guildId, role.id);
      await logConfigChange(client, guildId, {
        title: "Honeypot exempt role added",
        command: "/honeypot exempt add",
        actor: interaction.user,
        changes: [`Role: ${role} (\`${role.id}\`)`],
      }).catch(() => {});
      await interaction.reply({
        content:
          `Added ${role} as a staff role (also used for honeypot exemption). ` +
          `Members with this role will not be banned for posting in honeypot channels or receiving honeypot ban roles.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "del") {
      const role = interaction.options.getRole("role", true);
      const removed = removeStaffRole(guildId, role.id);
      if (removed) {
        await logConfigChange(client, guildId, {
          title: "Honeypot exempt role removed",
          command: "/honeypot exempt del",
          actor: interaction.user,
          changes: [`Role: ${role} (\`${role.id}\`)`],
        }).catch(() => {});
      }
      await interaction.reply({
        content: removed
          ? `Removed ${role} from staff roles (also removes honeypot exemption).`
          : `${role} is not a configured staff role.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "list") {
      const rows = listStaffRoles(guildId);
      if (!rows.length) {
        await interaction.reply({
          content:
            "No staff roles configured. Staff who hit honeypots will be banned.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const lines = rows.map((r) => `- <@&${r.role_id}>`);
      await interaction.reply({
        content: `**Staff roles (also used for honeypot exemption):**\n${lines.join("\n")}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  // Always answer /honeypot so we never fall through as "handler missing"
  await interaction.reply({
    content:
      `Unknown honeypot subcommand: \`/${interaction.commandName}` +
      `${group ? ` ${group}` : ""} ${sub || ""}\`.\n` +
      `Use \`/honeypot channel add|list|del\`, \`/honeypot banrole add|list|del\`, or \`/honeypot exempt add|list|del\`.`,
    flags: MessageFlags.Ephemeral,
  });
  return;
}

function registerEvents(client) {
  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    try {
      await handleHoneypotBanRole(oldMember, newMember);
    } catch (e) {
      console.error("[GuildMemberUpdate] honeypot banrole error:", e?.message || e);
    }
  });
}

function start(client) {
  sweepHoneypotWarningReactions(client).catch((e) =>
    console.warn("[honeypot] Initial warning reaction sweep failed:", e?.message || e)
  );
  setInterval(() => {
    sweepHoneypotWarningReactions(client).catch((e) =>
      console.warn("[honeypot] Warning reaction sweep failed:", e?.message || e)
    );
  }, 10 * 60 * 1000);
}

module.exports = {
  name: "honeypot",
  commands,
  handlers: {
    honeypot: handleHoneypot,
  },
  registerEvents,
  start,
  ensureHoneypotWarning,
  handleHoneypotMessage,
  handleHoneypotWarningReaction,
  handleHoneypotBanRole,
  postHoneypotWarning,
  executeHoneypotBan,
  sweepHoneypotWarningReactions,
};
