const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require("discord.js");
const {
  upsertLevelRole,
  deleteLevelRole,
  listLevelRoles,
} = require("../../db");
const { isStaff } = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");
const { syncMemberRoles } = require("./sync");

const staffPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName("leveltorole")
    .setDescription("Map a role to a level requirement (and drop grace days).")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommand((sc) =>
      sc
        .setName("set")
        .setDescription("Set/update a level->role mapping.")
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("Role to manage").setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt.setName("level").setDescription("Level required").setMinValue(0).setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("dropdays")
            .setDescription("Days below level before removing")
            .setMinValue(0)
            .setRequired(true)
        )
    )
    .addSubcommand((sc) => {
      const sub = sc.setName("remove").setDescription("Remove a mapping for a role.");
      sub.addRoleOption((opt) =>
        opt.setName("role").setDescription("Role to unmanage").setRequired(true)
      );
      return sub;
    })
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("List current level->role mappings.")
    ),
];

async function handleLevelToRole(interaction, ctx) {
  const { client } = ctx;
  if (!isStaff(interaction)) {
    await interaction.reply({
      content: "You don’t have permission to use this.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();

  if (sub === "set") {
    const role = interaction.options.getRole("role", true);
    const level = interaction.options.getInteger("level", true);
    const dropdays = interaction.options.getInteger("dropdays", true);

    upsertLevelRole(guildId, role.id, Math.max(0, level), Math.max(0, dropdays));
    await logConfigChange(client, guildId, {
      title: "Level→role mapping set",
      command: "/leveltorole set",
      actor: interaction.user,
      changes: [
        `Role: ${role} (\`${role.id}\`)`,
        `Level required: **${level}**`,
        `Drop grace: **${dropdays}** day(s)`,
      ],
    }).catch(() => {});

    await interaction.reply({
      content: `Mapped ${role} to **Lvl ${level}** (remove after **${dropdays}** day(s) below).`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "remove") {
    const role = interaction.options.getRole("role", true);
    deleteLevelRole(guildId, role.id);
    await logConfigChange(client, guildId, {
      title: "Level→role mapping removed",
      command: "/leveltorole remove",
      actor: interaction.user,
      changes: [`Role: ${role} (\`${role.id}\`)`],
    }).catch(() => {});

    await interaction.reply({
      content: `Removed mapping for ${role}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "list") {
    const rows = listLevelRoles(guildId);
    if (!rows.length) {
      await interaction.reply({
        content: "No level→role mappings configured.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const lines = rows.map(
      (r) =>
        `- <@&${r.role_id}> @ **Lvl ${r.level_required}** (drop after **${r.drop_grace_days}d**)`
    );
    await interaction.reply({
      content: `**Level→Role mappings:**\n${lines.join("\n")}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

module.exports = {
  name: "levelRoles",
  commands,
  handlers: {
    leveltorole: handleLevelToRole,
  },
  // re-export for services that still import roles.js
  syncMemberRoles,
};
