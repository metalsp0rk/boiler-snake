const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const {
  upsertLevelRole,
  deleteLevelRole,
  listLevelRoles,
} = require("../../db");
const { requireStaffFromContext } = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");
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
          opt
            .setName("role")
            .setDescription("Role to manage")
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("level")
            .setDescription("Level required")
            .setMinValue(0)
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("dropdays")
            .setDescription("Days below level before removing")
            .setMinValue(0)
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) => {
      const sub = sc
        .setName("remove")
        .setDescription("Remove a mapping for a role.");
      sub.addRoleOption((opt) =>
        opt
          .setName("role")
          .setDescription("Role to unmanage")
          .setRequired(true),
      );
      return sub;
    })
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("List current level->role mappings."),
    ),
];

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} featureCtx
 */
async function handleLevelToRole(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireStaffFromContext(commandCtx))) return;

  // CommandContext carries the resolved internal id (roadmap/fluxer.md
  // § Repository boundary); externalGuildId is the snowflake for audit text
  // and the audit-log mirror lookup — never a repository key.
  const communityId = commandCtx.communityId;
  const guildId = commandCtx.externalGuildId;
  const sub = commandCtx.subcommand;

  if (sub === "set") {
    // Context-arm role options resolve to { id } — mention text is built
    // explicitly (the Discord Role object's toString() is no longer there).
    const role = commandCtx.options.getRole("role", true);
    const level = commandCtx.options.getInteger("level", true);
    const dropdays = commandCtx.options.getInteger("dropdays", true);

    upsertLevelRole(
      communityId,
      role.id,
      Math.max(0, level),
      Math.max(0, dropdays),
    );
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "level_roles.set",
      targetType: "role",
      targetId: role.id,
      details: {
        level_required: Math.max(0, level),
        drop_grace_days: Math.max(0, dropdays),
      },
    });
    await logConfigChange(commandCtx.outbound, guildId, {
      title: "Level→role mapping set",
      command: "/leveltorole set",
      actor: commandCtx.user,
      changes: [
        `Role: <@&${role.id}> (\`${role.id}\`)`,
        `Level required: **${level}**`,
        `Drop grace: **${dropdays}** day(s)`,
      ],
    }).catch(() => {});

    await commandCtx.reply({
      content: `Mapped <@&${role.id}> to **Lvl ${level}** (remove after **${dropdays}** day(s) below).`,
      sensitive: true,
    });
    return;
  }

  if (sub === "remove") {
    const role = commandCtx.options.getRole("role", true);
    deleteLevelRole(communityId, role.id);
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "level_roles.remove",
      targetType: "role",
      targetId: role.id,
    });
    await logConfigChange(commandCtx.outbound, guildId, {
      title: "Level→role mapping removed",
      command: "/leveltorole remove",
      actor: commandCtx.user,
      changes: [`Role: <@&${role.id}> (\`${role.id}\`)`],
    }).catch(() => {});

    await commandCtx.reply({
      content: `Removed mapping for <@&${role.id}>.`,
      sensitive: true,
    });
    return;
  }

  if (sub === "list") {
    const rows = listLevelRoles(communityId);
    if (!rows.length) {
      await commandCtx.reply({
        content: "No level→role mappings configured.",
        sensitive: true,
      });
      return;
    }

    const lines = rows.map(
      (r) =>
        `• <@&${r.role_id}> @ **Lvl ${r.level_required}** (drop after **${r.drop_grace_days}d**)`,
    );
    await commandCtx.reply({
      content: `**Level→Role mappings**\n${lines.join("\n")}`,
      sensitive: true,
    });
  }
}

module.exports = {
  name: "levelRoles",
  commands,
  handlers: {
    leveltorole: handleLevelToRole,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): the slash
  // handler receives a CommandContext instead of a raw interaction.
  handlerApi: {
    leveltorole: "context",
  },
  // re-export for services that still import roles.js
  syncMemberRoles,
};
