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
  hasCommandPermissionOauth,
  getCommandPermissionOauth,
} = require("../../db");
const { isAdminOrMod, isStaff } = require("../../core/permissions");
const { replyDenied, replyEphemeral } = require("../../core/interaction");
const { logConfigChange } = require("../logs/auditLog");
const {
  getCommandPermissionOAuthConfig,
  createOAuthState,
  buildAuthorizeUrl,
  applyGuildCommandPermissions,
  maybeAutoSyncCommandPermissions,
} = require("../commandPermissions");

const adminPerms = PermissionFlagsBits.ManageGuild;

/**
 * @param {import("discord.js").SlashCommandStringOption} opt
 */
function addLevelOption(opt, required = true) {
  return opt
    .setName("level")
    .setDescription(
      "junior = staff gate only; senior = gate + ticket visibility",
    )
    .setRequired(required)
    .addChoices(
      { name: "senior (tickets + staff gate)", value: "senior" },
      { name: "junior (staff gate only)", value: "junior" },
    );
}

const commands = [
  new SlashCommandBuilder()
    .setName("staff")
    .setDescription(
      "Configure guild staff roles (admin gate + ticket visibility).",
    )
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
                .setRequired(true),
            )
            .addStringOption((opt) => addLevelOption(opt, true)),
        )
        .addSubcommand((sc) =>
          sc
            .setName("remove")
            .setDescription("Remove a role from the staff list.")
            .addRoleOption((opt) =>
              opt
                .setName("role")
                .setDescription("Role to remove from staff list")
                .setRequired(true),
            ),
        )
        .addSubcommand((sc) =>
          sc
            .setName("setlevel")
            .setDescription("Change a staff role between junior and senior.")
            .addRoleOption((opt) =>
              opt
                .setName("role")
                .setDescription("Staff role to update")
                .setRequired(true),
            )
            .addStringOption((opt) => addLevelOption(opt, true)),
        )
        .addSubcommand((sc) =>
          sc
            .setName("list")
            .setDescription("List trusted staff roles by level."),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("settings")
        .setDescription("Show staff role configuration and what it controls."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("syncpermissions")
        .setDescription(
          "Sync slash-command visibility so staff roles see staff tools (OAuth).",
        )
        .addBooleanOption((opt) =>
          opt
            .setName("force_reauth")
            .setDescription("Always open a new authorize link")
            .setRequired(false),
        ),
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
  if (sub === "syncpermissions") return handleSyncPermissions(interaction);

  await replyEphemeral(interaction, {
    content: `Unknown subcommand: \`/staff ${subGroup || ""} ${sub || ""}\``,
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
    await replyEphemeral(interaction, {
      content: "Only server administrators can add staff roles.",
    });
    return;
  }

  const role = interaction.options.getRole("role", true);
  const level = normalizeStaffLevel(
    interaction.options.getString("level", true),
  );

  if (role.id === interaction.guildId) {
    await replyEphemeral(interaction, {
      content: "You cannot use @everyone as a staff role.",
    });
    return;
  }

  const existing = getStaffRole(interaction.guildId, role.id);
  addStaffRole(interaction.guildId, role.id, level);

  await logConfigChange(
    ctx?.client || interaction.client,
    interaction.guildId,
    {
      title: existing ? "Staff role level updated" : "Staff role added",
      command: "/staff role add",
      actor: interaction.user,
      changes: [
        `Role: ${role} (\`${role.id}\`)`,
        existing
          ? `Level: **${levelLabel(existing.level)}** → **${level}**`
          : `Level: **${level}**`,
      ],
    },
  ).catch(() => {});

  const ticketNote =
    level === "senior"
      ? "They will also see open ticket channels (role overwrites)."
      : "They will **not** automatically see ticket channels (senior only). Use `/ticket addstaff` per ticket if needed.";

  await replyEphemeral(interaction, {
    content:
      (existing
        ? `Updated ${role} to **${level}** staff.`
        : `Added ${role} as **${level}** staff.`) +
      `\nMembers with this role pass the staff gate and are honeypot-exempt.\n${ticketNote}` +
      (hasCommandPermissionOauth(interaction.guildId)
        ? "\n_Refreshing slash-command visibility…_"
        : "\n_Tip: run `/staff syncpermissions` so this role can **see** staff slash commands._"),
  });

  void maybeAutoSyncCommandPermissions(interaction.guildId);
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleRoleRemove(interaction, ctx) {
  if (!isAdminOrMod(interaction)) {
    await replyEphemeral(interaction, {
      content: "Only server administrators can remove staff roles.",
    });
    return;
  }

  const role = interaction.options.getRole("role", true);
  const removed = removeStaffRole(interaction.guildId, role.id);

  if (removed) {
    await logConfigChange(
      ctx?.client || interaction.client,
      interaction.guildId,
      {
        title: "Staff role removed",
        command: "/staff role remove",
        actor: interaction.user,
        changes: [`Role: ${role} (\`${role.id}\`)`],
      },
    ).catch(() => {});
  }

  await replyEphemeral(interaction, {
    content: removed
      ? `Removed ${role} from staff roles. Members with this role will no longer pass the admin gate, be honeypot-exempt, or receive ticket overwrites.`
      : `${role} is not a configured staff role.`,
  });

  if (removed) void maybeAutoSyncCommandPermissions(interaction.guildId);
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleRoleSetLevel(interaction, ctx) {
  if (!isAdminOrMod(interaction)) {
    await replyEphemeral(interaction, {
      content: "Only server administrators can change staff role levels.",
    });
    return;
  }

  const role = interaction.options.getRole("role", true);
  const level = normalizeStaffLevel(
    interaction.options.getString("level", true),
  );
  const existing = getStaffRole(interaction.guildId, role.id);

  if (!existing) {
    await replyEphemeral(interaction, {
      content: `${role} is not a staff role. Use \`/staff role add\` first.`,
    });
    return;
  }

  if (normalizeStaffLevel(existing.level) === level) {
    await replyEphemeral(interaction, {
      content: `${role} is already **${level}** staff.`,
    });
    return;
  }

  setStaffRoleLevel(interaction.guildId, role.id, level);

  await logConfigChange(
    ctx?.client || interaction.client,
    interaction.guildId,
    {
      title: "Staff role level changed",
      command: "/staff role setlevel",
      actor: interaction.user,
      changes: [
        `Role: ${role} (\`${role.id}\`)`,
        `Level: **${levelLabel(existing.level)}** → **${level}**`,
      ],
    },
  ).catch(() => {});

  await replyEphemeral(interaction, {
    content:
      `Set ${role} to **${level}** staff.\n` +
      (level === "senior"
        ? "They will receive ticket channel visibility on **new** overwrite applies (open/claim/sensitive/close). Existing open tickets may need a lifecycle command or recreate to refresh overwrites."
        : "They no longer get automatic ticket visibility. Existing open tickets still need an overwrite refresh (e.g. claim/sensitive/close) to drop the old role allow."),
  });

  // Levels don't change Discord command overwrites (all staff roles get allows),
  // but keep auto-sync for consistency if operators expect it.
  void maybeAutoSyncCommandPermissions(interaction.guildId);
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
async function handleRoleList(interaction) {
  if (!isStaff(interaction)) {
    await replyDenied(interaction);
    return;
  }

  const rows = listStaffRoles(interaction.guildId);
  if (!rows.length) {
    await replyEphemeral(interaction, {
      content:
        "No staff roles configured. Only Manage Server permission passes the admin gate.\n" +
        "Use `/staff role add` to trust additional roles (`junior` or `senior`).",
    });
    return;
  }

  const seniors = rows.filter((r) => normalizeStaffLevel(r.level) === "senior");
  const juniors = rows.filter((r) => normalizeStaffLevel(r.level) === "junior");

  const fmt = (list) =>
    list.length ? list.map((r) => `- <@&${r.role_id}>`).join("\n") : "_none_";

  await replyEphemeral(interaction, {
    content:
      `**Staff roles**\n` +
      `**Senior** (staff gate + ticket visibility):\n${fmt(seniors)}\n\n` +
      `**Junior** (staff gate only; no ticket channel overwrite):\n${fmt(juniors)}\n\n` +
      `Both levels: staff commands + honeypot exempt.`,
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
async function handleSyncPermissions(interaction) {
  if (!isAdminOrMod(interaction)) {
    await replyEphemeral(interaction, {
      content:
        "Only server administrators (Manage Server) can sync command visibility.",
    });
    return;
  }

  const cfg = getCommandPermissionOAuthConfig();
  if (!cfg.ready) {
    await replyEphemeral(interaction, {
      content:
        "**Command visibility sync is not configured on this bot.**\n\n" +
        "Operators need:\n" +
        cfg.missing.map((m) => `• \`${m}\``).join("\n") +
        "\n\nAlso add the OAuth2 redirect URI in the Discord Developer Portal:\n" +
        `\`${cfg.redirectUri || "https://your-public-host/oauth/command-permissions/callback"}\`\n\n` +
        "Handlers still enforce staff permissions even without sync.",
    });
    return;
  }

  const forceReauth = !!interaction.options.getBoolean("force_reauth");
  const guildId = interaction.guildId;
  const hasToken = hasCommandPermissionOauth(guildId);

  if (!hasToken || forceReauth) {
    let url;
    try {
      const state = createOAuthState({
        guildId,
        userId: interaction.user.id,
      });
      url = buildAuthorizeUrl(state);
    } catch (err) {
      await replyEphemeral(interaction, {
        content: `Could not build authorize URL: ${err?.message || err}`,
      });
      return;
    }

    await replyEphemeral(interaction, {
      content:
        "**Authorize command visibility sync**\n\n" +
        "1. Click the link below (you need **Manage Server** + **Manage Roles**).\n" +
        "2. Approve the app permission to update command permissions.\n" +
        "3. The bot will allow each configured staff role to see staff slash commands.\n\n" +
        `[Authorize Boiler Snake](${url})\n\n` +
        `_Redirect: \`${cfg.redirectUri}\`_\n` +
        "After authorizing, staff without Manage Server should see tools like `/note` and `/setxp` in the `/` menu.",
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const result = await applyGuildCommandPermissions(guildId);
    const oauth = getCommandPermissionOauth(guildId);
    const parts = [
      `**Synced slash-command visibility** for this server.`,
      `Staff roles applied: **${result.roleCount}**`,
      `Commands updated: **${result.updated.length}**` +
        (result.updated.length
          ? ` (\`${result.updated.slice(0, 8).join("`, `")}\`${
              result.updated.length > 8 ? "…" : ""
            })`
          : ""),
    ];
    if (result.missingCommands.length) {
      parts.push(
        `Not registered yet: \`${result.missingCommands.join("`, `")}\` — run \`npm run register\`.`,
      );
    }
    if (result.failed.length) {
      parts.push(
        `**Failed:** ${result.failed
          .map((f) => `\`${f.name}\` (${f.error})`)
          .join("; ")
          .slice(0, 800)}`,
      );
      parts.push(
        "Try `/staff syncpermissions force_reauth:true` if auth expired.",
      );
    }
    if (oauth?.last_sync_at) {
      parts.push(`Last sync: <t:${Math.floor(oauth.last_sync_at / 1000)}:R>`);
    }
    await interaction.editReply({ content: parts.join("\n") });
  } catch (err) {
    const code = err?.code;
    if (code === "reauth_required" || code === "not_authorized") {
      let url = null;
      try {
        const state = createOAuthState({
          guildId,
          userId: interaction.user.id,
        });
        url = buildAuthorizeUrl(state);
      } catch {
        /* ignore */
      }
      await interaction.editReply({
        content:
          "Authorization missing or expired. " +
          (url
            ? `Re-authorize here: [Authorize Boiler Snake](${url})`
            : "Run `/staff syncpermissions force_reauth:true`."),
      });
      return;
    }
    await interaction.editReply({
      content: `Sync failed: ${err?.message || err}`,
    });
  }
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
async function handleSettings(interaction) {
  if (!isStaff(interaction)) {
    await replyDenied(interaction);
    return;
  }

  const rows = listStaffRoles(interaction.guildId);
  const seniors = rows.filter((r) => normalizeStaffLevel(r.level) === "senior");
  const juniors = rows.filter((r) => normalizeStaffLevel(r.level) === "junior");
  const oauth = getCommandPermissionOauth(interaction.guildId);
  const syncLine = oauth
    ? `Command visibility sync: **authorized**` +
      (oauth.last_sync_at
        ? ` · last sync <t:${Math.floor(oauth.last_sync_at / 1000)}:R>`
        : "") +
      (oauth.last_sync_error ? ` · ⚠ last error recorded` : "")
    : `Command visibility sync: **not authorized** — admin: \`/staff syncpermissions\``;

  await replyEphemeral(interaction, {
    content:
      `**Staff roles settings**\n` +
      `Total roles: **${rows.length}** · senior **${seniors.length}** · junior **${juniors.length}**\n` +
      `Admin gate: Manage Server **or** any staff role (junior or senior)\n` +
      `Honeypot exemption: any staff role (not bare Manage Server)\n` +
      `Ticket channel visibility: **senior** roles only (+ named staff on a ticket)\n` +
      `${syncLine}\n` +
      `Only Manage Server can add/remove/setlevel staff roles.\n` +
      `\n**Used by:** admin gate, honeypot exemption, tickets (senior overwrites), notes, warnings\n` +
      `\n**Commands:** \`/staff role add\` · \`setlevel\` · \`remove\` · \`list\` · \`syncpermissions\``,
  });
}

module.exports = {
  name: "staffRoles",
  commands,
  handlers: {
    staff: handleStaff,
  },
};
