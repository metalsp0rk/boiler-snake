/**
 * Guild Staff Roles — admin gate configuration.
 *
 * Slash: /staff role add|remove|list, /staff settings
 * Access: ManageGuild for add/remove; staff gate (isStaff) for list/settings.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require("discord.js");
const {
  addStaffRole,
  removeStaffRole,
  listStaffRoles,
} = require("../../db");
const { isAdminOrMod, isStaff } = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");

const adminPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName("staff")
    .setDescription("Configure guild staff roles (admin gate).")
    .setDefaultMemberPermissions(adminPerms)
    .addSubcommandGroup((group) =>
      group
        .setName("role")
        .setDescription("Manage trusted staff roles.")
        .addSubcommand((sc) =>
          sc
            .setName("add")
            .setDescription("Trust a role as staff (grants admin gate access).")
            .addRoleOption((opt) =>
              opt
                .setName("role")
                .setDescription("Role to trust as staff")
                .setRequired(true)
            )
        )
        .addSubcommand((sc) =>
          sc
            .setName("remove")
            .setDescription("Remove a role from the staff list.")
            .addRoleOption((opt) =>
              opt
                .setName("role")
                .setDescription("Role to remove from staff list")
                .setRequired(true)
            )
        )
        .addSubcommand((sc) =>
          sc
            .setName("list")
            .setDescription("List trusted staff roles.")
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("settings")
        .setDescription("Show staff role configuration and what it controls.")
    ),
];

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleStaff(interaction, ctx) {
  const subGroup = interaction.options.getSubcommandGroup();
  const sub = interaction.options.getSubcommand();

  if (subGroup === "role") {
    if (sub === "add") return handleRoleAdd(interaction, ctx);
    if (sub === "remove") return handleRoleRemove(interaction, ctx);
    if (sub === "list") return handleRoleList(interaction);
  }

  if (sub === "settings") return handleSettings(interaction);

  await interaction.reply({
    content: `Unknown subcommand: \`/staff ${subGroup || ""} ${sub || ""}\``,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleRoleAdd(interaction, ctx) {
  if (!isAdminOrMod(interaction)) {
    await interaction.reply({
      content: "Only server administrators can add staff roles.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const role = interaction.options.getRole("role", true);

  if (role.id === interaction.guildId) {
    await interaction.reply({
      content: "You cannot use @everyone as a staff role.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const existing = listStaffRoles(interaction.guildId);
  if (existing.some((r) => r.role_id === role.id)) {
    await interaction.reply({
      content: `${role} is already a staff role.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  addStaffRole(interaction.guildId, role.id);

  await logConfigChange(ctx?.client || interaction.client, interaction.guildId, {
    title: "Staff role added",
    command: "/staff role add",
    actor: interaction.user,
    changes: [`Role: ${role} (\`${role.id}\`)`],
  }).catch(() => {});

  await interaction.reply({
    content:
      `Added ${role} as a **staff role**. Members with this role can now use staff-gated commands.\n` +
      `This also exempts them from honeypot bans (same list).`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleRoleRemove(interaction, ctx) {
  if (!isAdminOrMod(interaction)) {
    await interaction.reply({
      content: "Only server administrators can remove staff roles.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const role = interaction.options.getRole("role", true);
  const removed = removeStaffRole(interaction.guildId, role.id);

  if (removed) {
    await logConfigChange(ctx?.client || interaction.client, interaction.guildId, {
      title: "Staff role removed",
      command: "/staff role remove",
      actor: interaction.user,
      changes: [`Role: ${role} (\`${role.id}\`)`],
    }).catch(() => {});
  }

  await interaction.reply({
    content: removed
      ? `Removed ${role} from staff roles. Members with this role will no longer pass the admin gate or be exempt from honeypot bans.`
      : `${role} is not a configured staff role.`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
async function handleRoleList(interaction) {
  if (!isStaff(interaction)) {
    await interaction.reply({
      content: "You don't have permission to use this.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const rows = listStaffRoles(interaction.guildId);
  if (!rows.length) {
    await interaction.reply({
      content:
        "No staff roles configured. Only Manage Server permission passes the admin gate.\n" +
        "Use `/staff role add` to trust additional roles.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = rows.map((r) => `- <@&${r.role_id}>`);
  await interaction.reply({
    content: `**Staff roles:**\n${lines.join("\n")}\n\nMembers with these roles pass the admin gate and are exempt from honeypot bans.`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
async function handleSettings(interaction) {
  if (!isStaff(interaction)) {
    await interaction.reply({
      content: "You don't have permission to use this.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const rows = listStaffRoles(interaction.guildId);

  await interaction.reply({
    content:
      `**Staff roles settings**\n` +
      `Configured staff roles: **${rows.length}**\n` +
      `Admin gate: Manage Server **or** any staff role\n` +
      `Honeypot exemption: staff role only (not bare Manage Server)\n` +
      `Only Manage Server can add/remove staff roles.\n` +
      `\n**Used by:** admin gate, honeypot exemption, tickets, notes, warnings\n` +
      `\n**Commands:** \`/staff role add\` · \`remove\` · \`list\``,
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = {
  name: "staffRoles",
  commands,
  handlers: {
    staff: handleStaff,
  },
};
