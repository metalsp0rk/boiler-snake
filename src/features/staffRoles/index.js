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

const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
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
const {
  isAdminOrModFromContext,
  requireStaffFromContext,
} = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");
const {
  getCommandPermissionOAuthConfig,
  createOAuthState,
  buildAuthorizeUrl,
  maybeAutoSyncCommandPermissions,
  runCommandVisibilitySync,
  SYNC_AUDIT_ACTION,
  buildSyncAuditDetails,
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
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} featureCtx
 */
async function handleStaff(commandCtx, featureCtx) {
  // Subcommand routing uses the seam's precomputed values (the router arm
  // only routes chat-input; roadmap/fluxer.md § CommandContext).
  const subGroup = commandCtx.subcommandGroup;
  const sub = commandCtx.subcommand;

  if (subGroup === "role") {
    if (sub === "add") return handleRoleAdd(commandCtx, featureCtx);
    if (sub === "remove") return handleRoleRemove(commandCtx, featureCtx);
    if (sub === "setlevel") return handleRoleSetLevel(commandCtx, featureCtx);
    if (sub === "list") return handleRoleList(commandCtx, featureCtx);
  }

  if (sub === "settings") return handleSettings(commandCtx, featureCtx);
  if (sub === "syncpermissions")
    return handleSyncPermissions(commandCtx, featureCtx);

  await commandCtx.reply({
    content: `Unknown subcommand: \`/staff ${subGroup || ""} ${sub || ""}\``,
    sensitive: true,
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
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} featureCtx
 */
async function handleRoleAdd(commandCtx, featureCtx) {
  void featureCtx;
  if (!isAdminOrModFromContext(commandCtx)) {
    await commandCtx.reply({
      content: "Only server administrators can add staff roles.",
      sensitive: true,
    });
    return;
  }

  // Context-arm role options resolve to { id } — mention text is built
  // explicitly (the Discord Role object's toString() is no longer there).
  const role = commandCtx.options.getRole("role", true);
  const level = normalizeStaffLevel(
    commandCtx.options.getString("level", true),
  );
  // staff_roles + command-permission repos key by the integer community id;
  // the seam resolved it from the Discord snowflake at the edge.
  const communityId = commandCtx.communityId;

  if (role.id === commandCtx.externalGuildId) {
    await commandCtx.reply({
      content: "You cannot use @everyone as a staff role.",
      sensitive: true,
    });
    return;
  }

  const existing = getStaffRole(communityId, role.id);
  addStaffRole(communityId, role.id, level, commandCtx.userId);
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "staff.role_add",
    targetType: "role",
    targetId: role.id,
    details: { level, previous_level: existing ? existing.level : null },
  });

  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: existing ? "Staff role level updated" : "Staff role added",
    command: "/staff role add",
    actor: commandCtx.user,
    changes: [
      `Role: <@&${role.id}> (\`${role.id}\`)`,
      existing
        ? `Level: **${levelLabel(existing.level)}** → **${level}**`
        : `Level: **${level}**`,
    ],
  }).catch(() => {});

  const ticketNote =
    level === "senior"
      ? "They will also see open ticket channels (role overwrites)."
      : "They will **not** automatically see ticket channels (senior only). Use `/ticket addstaff` per ticket if needed.";

  await commandCtx.reply({
    content:
      (existing
        ? `Updated <@&${role.id}> to **${level}** staff.`
        : `Added <@&${role.id}> as **${level}** staff.`) +
      `\nMembers with this role pass the staff gate and are honeypot-exempt.\n${ticketNote}` +
      (hasCommandPermissionOauth(communityId)
        ? "\n_Refreshing slash-command visibility…_"
        : "\n_Tip: run `/staff syncpermissions` so this role can **see** staff slash commands._"),
    sensitive: true,
  });

  void maybeAutoSyncCommandPermissions(communityId);
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} featureCtx
 */
async function handleRoleRemove(commandCtx, featureCtx) {
  void featureCtx;
  if (!isAdminOrModFromContext(commandCtx)) {
    await commandCtx.reply({
      content: "Only server administrators can remove staff roles.",
      sensitive: true,
    });
    return;
  }

  const role = commandCtx.options.getRole("role", true);
  const communityId = commandCtx.communityId;
  const existing = getStaffRole(communityId, role.id);
  const removed = removeStaffRole(communityId, role.id);

  if (removed) {
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "staff.role_remove",
      targetType: "role",
      targetId: role.id,
      details: { previous_level: existing ? existing.level : null },
    });
    await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
      title: "Staff role removed",
      command: "/staff role remove",
      actor: commandCtx.user,
      changes: [`Role: <@&${role.id}> (\`${role.id}\`)`],
    }).catch(() => {});
  }

  await commandCtx.reply({
    content: removed
      ? `Removed <@&${role.id}> from staff roles. Members with this role will no longer pass the admin gate, be honeypot-exempt, or receive ticket overwrites.`
      : `<@&${role.id}> is not a configured staff role.`,
    sensitive: true,
  });

  if (removed) void maybeAutoSyncCommandPermissions(communityId);
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} featureCtx
 */
async function handleRoleSetLevel(commandCtx, featureCtx) {
  void featureCtx;
  if (!isAdminOrModFromContext(commandCtx)) {
    await commandCtx.reply({
      content: "Only server administrators can change staff role levels.",
      sensitive: true,
    });
    return;
  }

  const role = commandCtx.options.getRole("role", true);
  const level = normalizeStaffLevel(
    commandCtx.options.getString("level", true),
  );
  // staff_roles + command-permission repos key by the integer community id.
  const communityId = commandCtx.communityId;
  const existing = getStaffRole(communityId, role.id);

  if (!existing) {
    await commandCtx.reply({
      content: `<@&${role.id}> is not a staff role. Use \`/staff role add\` first.`,
      sensitive: true,
    });
    return;
  }

  if (normalizeStaffLevel(existing.level) === level) {
    await commandCtx.reply({
      content: `<@&${role.id}> is already **${level}** staff.`,
      sensitive: true,
    });
    return;
  }

  setStaffRoleLevel(communityId, role.id, level);
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "staff.role_setlevel",
    targetType: "role",
    targetId: role.id,
    details: { previous_level: existing.level, level },
  });

  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Staff role level changed",
    command: "/staff role setlevel",
    actor: commandCtx.user,
    changes: [
      `Role: <@&${role.id}> (\`${role.id}\`)`,
      `Level: **${levelLabel(existing.level)}** → **${level}**`,
    ],
  }).catch(() => {});

  await commandCtx.reply({
    content:
      `Set <@&${role.id}> to **${level}** staff.\n` +
      (level === "senior"
        ? "They will receive ticket channel visibility on **new** overwrite applies (open/claim/sensitive/close). Existing open tickets may need a lifecycle command or recreate to refresh overwrites."
        : "They no longer get automatic ticket visibility. Existing open tickets still need an overwrite refresh (e.g. claim/sensitive/close) to drop the old role allow."),
    sensitive: true,
  });

  // Levels don't change Discord command overwrites (all staff roles get allows),
  // but keep auto-sync for consistency if operators expect it.
  void maybeAutoSyncCommandPermissions(communityId);
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} featureCtx
 */
async function handleRoleList(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireStaffFromContext(commandCtx))) return;

  const communityId = commandCtx.communityId;
  const rows = listStaffRoles(communityId);
  if (!rows.length) {
    await commandCtx.reply({
      content:
        "No staff roles configured. Only Manage Server permission passes the admin gate.\n" +
        "Use `/staff role add` to trust additional roles (`junior` or `senior`).",
      sensitive: true,
    });
    return;
  }

  const seniors = rows.filter((r) => normalizeStaffLevel(r.level) === "senior");
  const juniors = rows.filter((r) => normalizeStaffLevel(r.level) === "junior");

  const fmt = (list) =>
    list.length
      ? list
          .map(
            (r) =>
              `- <@&${r.role_id}>` +
              // added_by is NULL for rows trusted before migration 024 —
              // omit rather than claim "unknown".
              (r.added_by ? ` (added by <@${r.added_by}>)` : ""),
          )
          .join("\n")
      : "_none_";

  await commandCtx.reply({
    content:
      `**Staff roles**\n` +
      `**Senior** (staff gate + ticket visibility):\n${fmt(seniors)}\n\n` +
      `**Junior** (staff gate only; no ticket channel overwrite):\n${fmt(juniors)}\n\n` +
      `Both levels: staff commands + honeypot exempt.`,
    sensitive: true,
  });
}

/**
 * Env-not-configured reply body (shared between the leading precondition
 * check and the core's env_not_configured outcome — ONE template, byte-
 * identical replies whatever branch produced it).
 * @param {{ missing: string[], redirectUri: string|null }} cfg
 */
function envNotConfiguredContent(cfg) {
  return (
    "**Command visibility sync is not configured on this bot.**\n\n" +
    "Operators need:\n" +
    cfg.missing.map((m) => `• \`${m}\``).join("\n") +
    "\n\nAlso add the OAuth2 redirect URI in the Discord Developer Portal:\n" +
    `\`${cfg.redirectUri || "https://your-public-host/oauth/command-permissions/callback"}\`\n\n` +
    "Handlers still enforce staff permissions even without sync."
  );
}

/**
 * Authorize-link reply body (no-token / force_reauth / reauth branches).
 * @param {string} url
 * @param {string|null} redirectUri
 */
function authorizeLinkContent(url, redirectUri) {
  return (
    "**Authorize command visibility sync**\n\n" +
    "1. Click the link below (you need **Manage Server** + **Manage Roles**).\n" +
    "2. Approve the app permission to update command permissions.\n" +
    "3. The bot will allow each configured staff role to see staff slash commands.\n\n" +
    `[Authorize Boiler Snake](${url})\n\n` +
    `_Redirect: \`${redirectUri}\`_\n` +
    "After authorizing, staff without Manage Server should see tools like `/note` and `/setxp` in the `/` menu."
  );
}

/**
 * Mint a purpose-tagged (cmd_perms) authorize URL for THIS user+guild.
 * Throws when OAuth state cannot be signed — callers keep their own error
 * reply semantics (visible message vs. silent reauth-link fallback).
 * @param {string} userId
 * @param {string} guildId
 * @returns {string}
 */
function buildAuthorizeLink(userId, guildId) {
  const state = createOAuthState({
    guildId,
    userId,
  });
  return buildAuthorizeUrl(state);
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} featureCtx
 */
async function handleSyncPermissions(commandCtx, featureCtx) {
  void featureCtx;
  // Fluxer (PR 8, roadmap/fluxer.md § Permissions line 566 + § Component-only
  // table): the OAuth slash-visibility sync is Discord-transport plumbing —
  // it mints a Discord OAuth consent round and edits Discord application
  // command permissions. On Fluxer there is no slash picker to sync: the bot
  // role granted at install time IS the permission grant. Answer with that
  // fact as the FIRST thing the subcommand does, before any OAuth/ManageGuild
  // work (locked reply copy — the spec records it verbatim).
  if (commandCtx.platform === "fluxer") {
    await commandCtx.reply({
      content:
        "Slash-command visibility sync is Discord-only. On Fluxer the bot role from the install is the permission grant.",
      sensitive: true,
    });
    return;
  }

  if (!isAdminOrModFromContext(commandCtx)) {
    await commandCtx.reply({
      content:
        "Only server administrators (Manage Server) can sync command visibility.",
      sensitive: true,
    });
    return;
  }

  // Subtask 31 PARITY REFACTOR: the trigger flow (env preconditions →
  // stored-authorization check → sync → audit-details) moved VERBATIM into
  // the shared core src/features/commandPermissions/syncTrigger.js, which
  // the web admin trigger (src/web/routes/syncAction.js) calls too. This
  // handler keeps its Discord-transport UX (reply choreography, the
  // authorize-link flow, force_reauth) around the shared call. Replies are
  // byte-identical to the pre-refactor flow. The OAuth internals (state
  // signing, token storage, public HTTP callback) are NOT part of this
  // migration (roadmap/fluxer.md: the OAuth sync path stays Discord-only).
  const cfg = getCommandPermissionOAuthConfig();
  if (!cfg.ready) {
    await commandCtx.reply({
      content: envNotConfiguredContent(cfg),
      sensitive: true,
    });
    return;
  }

  const forceReauth = !!commandCtx.options.getBoolean("force_reauth");
  // External snowflake for the Discord-facing surfaces: OAuth state signing
  // and the audit target_id DISPLAY field.
  const guildId = commandCtx.externalGuildId;
  // oauth + sync repos key by the integer community id (seam-resolved).
  const communityId = commandCtx.communityId;

  if (forceReauth && hasCommandPermissionOauth(communityId)) {
    // Operator wants a FRESH consent round even though a token is stored —
    // link reply, no sync (identical to the not-authorized branch below).
    let url;
    try {
      url = buildAuthorizeLink(commandCtx.userId, guildId);
    } catch (err) {
      await commandCtx.reply({
        content: `Could not build authorize URL: ${err?.message || err}`,
        sensitive: true,
      });
      return;
    }

    await commandCtx.reply({
      content: authorizeLinkContent(url, cfg.redirectUri),
      sensitive: true,
    });
    return;
  }

  await runSyncPermissionsViaCore(commandCtx, communityId, cfg);
}

/**
 * Deferred sync branch: shared core does the work, this handler owns the
 * reply + the fail-safe slash audit (recordSlashAudit NEVER throws — the
 * web twin writes FAIL-CLOSED via req.audit; see core header).
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {number} communityId internal communities.id (integer, seam-resolved)
 * @param {{ redirectUri: string|null }} cfg
 */
async function runSyncPermissionsViaCore(commandCtx, communityId, cfg) {
  // External snowflake for the Discord-facing surfaces: OAuth state signing
  // and the audit target_id DISPLAY field.
  const guildId = String(commandCtx.externalGuildId ?? "");
  try {
    const out = await runCommandVisibilitySync(communityId, {
      // defer exactly when the sync is about to run (post-preconditions,
      // pre-Discord-call) — the pre-refactor choreography. sensitive:true
      // mirrors today's ephemeral deferReply.
      onBeforeSync: () => commandCtx.defer({ sensitive: true }),
    });

    if (out.status === "env_not_configured") {
      // Only reachable when env changed between the leading check and the
      // core read — same reply as the leading branch (one template).
      await commandCtx.reply({
        content: envNotConfiguredContent({
          missing: out.missing,
          redirectUri: out.redirectUri,
        }),
        sensitive: true,
      });
      return;
    }

    if (out.status === "not_authorized") {
      let url;
      try {
        url = buildAuthorizeLink(commandCtx.userId, guildId);
      } catch (err) {
        await commandCtx.reply({
          content: `Could not build authorize URL: ${err?.message || err}`,
          sensitive: true,
        });
        return;
      }

      await commandCtx.reply({
        content: authorizeLinkContent(url, cfg.redirectUri),
        sensitive: true,
      });
      return;
    }

    const result = out.result;
    const oauth = getCommandPermissionOauth(communityId);
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: SYNC_AUDIT_ACTION,
      targetType: "guild",
      targetId: guildId,
      details: buildSyncAuditDetails(result),
    });
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
    await commandCtx.editReply({ content: parts.join("\n") });
  } catch (err) {
    const code = err?.code;
    if (code === "reauth_required" || code === "not_authorized") {
      let url = null;
      try {
        const state = createOAuthState({
          guildId,
          userId: commandCtx.userId,
        });
        url = buildAuthorizeUrl(state);
      } catch {
        /* ignore */
      }
      await commandCtx.editReply({
        content:
          "Authorization missing or expired. " +
          (url
            ? `Re-authorize here: [Authorize Boiler Snake](${url})`
            : "Run `/staff syncpermissions force_reauth:true`."),
      });
      return;
    }
    await commandCtx.editReply({
      content: `Sync failed: ${err?.message || err}`,
    });
  }
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} featureCtx
 */
async function handleSettings(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireStaffFromContext(commandCtx))) return;

  const communityId = commandCtx.communityId;
  const rows = listStaffRoles(communityId);
  const seniors = rows.filter((r) => normalizeStaffLevel(r.level) === "senior");
  const juniors = rows.filter((r) => normalizeStaffLevel(r.level) === "junior");
  const oauth = getCommandPermissionOauth(communityId);
  const syncLine = oauth
    ? `Command visibility sync: **authorized**` +
      (oauth.last_sync_at
        ? ` · last sync <t:${Math.floor(oauth.last_sync_at / 1000)}:R>`
        : "") +
      (oauth.last_sync_error ? ` · ⚠ last error recorded` : "")
    : `Command visibility sync: **not authorized** — admin: \`/staff syncpermissions\``;

  await commandCtx.reply({
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
    sensitive: true,
  });
}

module.exports = {
  name: "staffRoles",
  commands,
  handlers: {
    staff: handleStaff,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): the slash
  // handler (and its sub-handlers) receive a CommandContext instead of a raw
  // interaction. The OAuth sync internals stay Discord-only (PR 4 scope).
  handlerApi: {
    staff: "context",
  },
};
