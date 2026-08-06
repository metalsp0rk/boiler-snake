/**
 * Guild Staff Roles — admin gate configuration with junior | senior levels.
 *
 * Slash: /staff role add|remove|setlevel|list, /staff settings
 * Access: ManageGuild for mutations; staff gate (isStaff) for list/settings.
 *
 * Levels:
 *   - junior: requireStaff + honeypot exempt; no automatic ticket channel view
 *   - senior: junior + ticket channel overwrites
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require("discord.js");
const {
  addStaffRole,
  setStaffRoleLevel,
  removeStaffRole,
  listStaffRoles,
  getStaffRole,
  normalizeStaffLevel,
} = require("../../db");
const { isAdminOrMod, isStaff } = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");

const adminPerms = PermissionFlagsBits.ManageGuild;

/**
 * @param {import("discord.js").SlashCommandStringOption} opt
 */
function addLevelOption(opt, required = true) {
  return opt
    .setName("level")
    .setDescription("junior = staff gate only; senior = gate + ticket visibility")
    .setRequired(required)
    .addChoices(
      { name: "senior (tickets + staff gate)", value: "senior" },
      { name: "junior (staff gate only)", value: "junior" }
    );
}

const commands = [
  new SlashCommandBuilder()
    .setName("staff")
    .setDescription("Configure guild staff roles (admin gate + ticket visibility).")
    .setDefaultMemberPermissions(adminPerms)
    .addSubcommandGroup((group) =>
      group
        .setName("role")
        .setDescription("Manage trusted staff roles.")
        .addSubcommand((sc) =>
          sc
            .setName("add")
            .setDescription("Trust a role as junior or senior staff.")
            .addRoleOption((opt) =>
              opt
                .setName("role")
                .setDescription("Role to trust as staff")
                .setRequired(true)
            )
            .addStringOption((opt) => addLevelOption(opt, true))
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
            .setName("setlevel")
            .setDescription("Change a staff role between junior and senior.")
            .addRoleOption((opt) =>
              opt
                .setName("role")
                .setDescription("Staff role to update")
                .setRequired(true)
            )
            .addStringOption((opt) => addLevelOption(opt, true))
        )
        .addSubcommand((sc) =>
          sc.setName("list").setDescription("List trusted staff roles by level.")
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
    if (sub === "setlevel") return handleRoleSetLevel(interaction, ctx);
    if (sub === "list") return handleRoleList(interaction);
  }

  if (sub === "settings") return handleSettings(interaction);

  await interaction.reply({
    content: `Unknown subcommand: \`/staff ${subGroup || ""} ${sub || ""}\``,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * @param {string} level
 * @returns {string}
 */
function levelLabel(level) {
  return normalizeStaffLevel(level) === "junior" ? "junior" : "senior";
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
  const level = normalizeStaffLevel(
    interaction.options.getString("level", true)
  );

  if (role.id === interaction.guildId) {
    await interaction.reply({
      content: "You cannot use @everyone as a staff role.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const existing = getStaffRole(interaction.guildId, role.id);
  addStaffRole(interaction.guildId, role.id, level);

  await logConfigChange(ctx?.client || interaction.client, interaction.guildId, {
    title: existing ? "Staff role level updated" : "Staff role added",
    command: "/staff role add",
    actor: interaction.user,
    changes: [
      `Role: ${role} (\`${role.id}\`)`,
      existing
        ? `Level: **${levelLabel(existing.level)}** → **${level}**`
        : `Level: **${level}**`,
    ],
  }).catch(() => {});

  const ticketNote =
    level === "senior"
      ? "They will also see open ticket channels (role overwrites)."
      : "They will **not** automatically see ticket channels (senior only). Use `/ticket addstaff` per ticket if needed.";

  await interaction.reply({
    content:
      (existing
        ? `Updated ${role} to **${level}** staff.`
        : `Added ${role} as **${level}** staff.`) +
      `\nMembers with this role pass the staff gate and are honeypot-exempt.\n${ticketNote}`,
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
      ? `Removed ${role} from staff roles. Members with this role will no longer pass the admin gate, be honeypot-exempt, or receive ticket overwrites.`
      : `${role} is not a configured staff role.`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleRoleSetLevel(interaction, ctx) {
  if (!isAdminOrMod(interaction)) {
    await interaction.reply({
      content: "Only server administrators can change staff role levels.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const role = interaction.options.getRole("role", true);
  const level = normalizeStaffLevel(
    interaction.options.getString("level", true)
  );
  const existing = getStaffRole(interaction.guildId, role.id);

  if (!existing) {
    await interaction.reply({
      content: `${role} is not a staff role. Use \`/staff role add\` first.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (normalizeStaffLevel(existing.level) === level) {
    await interaction.reply({
      content: `${role} is already **${level}** staff.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  setStaffRoleLevel(interaction.guildId, role.id, level);

  await logConfigChange(ctx?.client || interaction.client, interaction.guildId, {
    title: "Staff role level changed",
    command: "/staff role setlevel",
    actor: interaction.user,
    changes: [
      `Role: ${role} (\`${role.id}\`)`,
      `Level: **${levelLabel(existing.level)}** → **${level}**`,
    ],
  }).catch(() => {});

  await interaction.reply({
    content:
      `Set ${role} to **${level}** staff.\n` +
      (level === "senior"
        ? "They will receive ticket channel visibility on **new** overwrite applies (open/claim/sensitive/close). Existing open tickets may need a lifecycle command or recreate to refresh overwrites."
        : "They no longer get automatic ticket visibility. Existing open tickets still need an overwrite refresh (e.g. claim/sensitive/close) to drop the old role allow."),
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
        "Use `/staff role add` to trust additional roles (`junior` or `senior`).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const seniors = rows.filter((r) => normalizeStaffLevel(r.level) === "senior");
  const juniors = rows.filter((r) => normalizeStaffLevel(r.level) === "junior");

  const fmt = (list) =>
    list.length
      ? list.map((r) => `- <@&${r.role_id}>`).join("\n")
      : "_none_";

  await interaction.reply({
    content:
      `**Staff roles**\n` +
      `**Senior** (staff gate + ticket visibility):\n${fmt(seniors)}\n\n` +
      `**Junior** (staff gate only; no ticket channel overwrite):\n${fmt(juniors)}\n\n` +
      `Both levels: staff commands + honeypot exempt.`,
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
  const seniors = rows.filter((r) => normalizeStaffLevel(r.level) === "senior");
  const juniors = rows.filter((r) => normalizeStaffLevel(r.level) === "junior");

  await interaction.reply({
    content:
      `**Staff roles settings**\n` +
      `Total roles: **${rows.length}** · senior **${seniors.length}** · junior **${juniors.length}**\n` +
      `Admin gate: Manage Server **or** any staff role (junior or senior)\n` +
      `Honeypot exemption: any staff role (not bare Manage Server)\n` +
      `Ticket channel visibility: **senior** roles only (+ named staff on a ticket)\n` +
      `Only Manage Server can add/remove/setlevel staff roles.\n` +
      `\n**Used by:** admin gate, honeypot exemption, tickets (senior overwrites), notes, warnings\n` +
      `\n**Commands:** \`/staff role add\` · \`setlevel\` · \`remove\` · \`list\``,
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
