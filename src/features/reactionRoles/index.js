const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const {
  createReactionRolePanel,
  getReactionRolePanel,
  listReactionRolePanels,
  updateReactionRolePanelText,
  deleteReactionRolePanel,
  listReactionRoleOptions,
  countReactionRoleOptions,
} = require("../../db");
const { requireStaffFromContext } = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");
const { buildMessageJumpUrl } = require("../../core/jumpUrl");
const { Color } = require("../../core/theme");
const {
  MAX_OPTIONS_PER_PANEL,
  PENDING_EMOJI_TTL_MS,
  NO_PING_MENTIONS,
  buildPanelEmbed,
  refreshPanelMessage,
  deployPanelToChannel,
  handleReactionRoleAdd,
  handleReactionRoleRemove,
  deployPanelFluxer,
  refreshPanelMessageFluxer,
  handleReactionRoleAddFluxer,
  handleReactionRoleRemoveFluxer,
  setPendingOptionAdd,
  setPendingOptionRemove,
  clearPendingOptionEmoji,
  handlePendingOptionEmojiMessage,
  syncMemberReactionRoles,
} = require("./service");

const staffPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName("reactionrole")
    .setDescription("Manage reaction-role panels (staff).")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommandGroup((group) =>
      group
        .setName("panel")
        .setDescription(
          "Create, edit, list, deploy, or delete reaction-role panels.",
        )
        .addSubcommand((sc) =>
          sc
            .setName("create")
            .setDescription("Post a new reaction-role panel in a channel.")
            .addChannelOption((opt) =>
              opt
                .setName("channel")
                .setDescription("Channel to post the panel in")
                .setRequired(true),
            )
            .addStringOption((opt) =>
              opt
                .setName("title")
                .setDescription("Embed title")
                .setRequired(false)
                .setMaxLength(256),
            )
            .addStringOption((opt) =>
              opt
                .setName("description")
                .setDescription(
                  "Embed description (intro text above the role list)",
                )
                .setRequired(false)
                .setMaxLength(1000),
            ),
        )
        .addSubcommand((sc) =>
          sc
            .setName("edit")
            .setDescription("Update a panel's title and/or description.")
            .addStringOption((opt) =>
              opt
                .setName("message_id")
                .setDescription("Message ID of the panel")
                .setRequired(true),
            )
            .addStringOption((opt) =>
              opt
                .setName("title")
                .setDescription("New embed title")
                .setRequired(false)
                .setMaxLength(256),
            )
            .addStringOption((opt) =>
              opt
                .setName("description")
                .setDescription("New embed description")
                .setRequired(false)
                .setMaxLength(1000),
            ),
        )
        .addSubcommand((sc) =>
          sc
            .setName("deploy")
            .setDescription(
              "Copy a panel (config + options) into another channel.",
            )
            .addStringOption((opt) =>
              opt
                .setName("message_id")
                .setDescription("Message ID of the source panel to copy")
                .setRequired(true),
            )
            .addChannelOption((opt) =>
              opt
                .setName("channel")
                .setDescription("Destination channel for the new panel")
                .setRequired(true),
            ),
        )
        .addSubcommand((sc) =>
          sc
            .setName("delete")
            .setDescription("Delete a panel (DB + Discord message).")
            .addStringOption((opt) =>
              opt
                .setName("message_id")
                .setDescription("Message ID of the panel")
                .setRequired(true),
            ),
        )
        .addSubcommand((sc) =>
          sc
            .setName("list")
            .setDescription("List reaction-role panels in this server."),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("option")
        .setDescription("Map emojis to roles on a panel.")
        .addSubcommand((sc) =>
          sc
            .setName("add")
            .setDescription(
              "Start adding an option; then send the emoji as your next message.",
            )
            .addStringOption((opt) =>
              opt
                .setName("message_id")
                .setDescription("Message ID of the panel")
                .setRequired(true),
            )
            .addRoleOption((opt) =>
              opt
                .setName("role")
                .setDescription("Role to grant")
                .setRequired(true),
            )
            .addIntegerOption((opt) =>
              opt
                .setName("level")
                .setDescription("Minimum level required (default 0)")
                .setMinValue(0)
                .setRequired(false),
            )
            .addBooleanOption((opt) =>
              opt
                .setName("removable")
                .setDescription(
                  "Remove role when reaction is removed (default true)",
                )
                .setRequired(false),
            ),
        )
        .addSubcommand((sc) =>
          sc
            .setName("remove")
            .setDescription(
              "Start removing an option; then send the emoji as your next message.",
            )
            .addStringOption((opt) =>
              opt
                .setName("message_id")
                .setDescription("Message ID of the panel")
                .setRequired(true),
            ),
        )
        .addSubcommand((sc) =>
          sc
            .setName("list")
            .setDescription("List emoji→role options on a panel.")
            .addStringOption((opt) =>
              opt
                .setName("message_id")
                .setDescription("Message ID of the panel")
                .setRequired(true),
            ),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("sync")
        .setDescription("Re-apply embed text and bot reactions for a panel.")
        .addStringOption((opt) =>
          opt
            .setName("message_id")
            .setDescription("Message ID of the panel")
            .setRequired(true),
        ),
    ),
];

/**
 * Standard reply for Fluxer dispatches reaching Discord-only surfaces
 * (roadmap/fluxer.md § Handler migration rule; panel posts/reactions stay on
 * the raw interaction until the service cutover in PR 7).
 */
const NOT_ON_FLUXER = "That command is not available on Fluxer yet.";

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleReactionrole(commandCtx, featureCtx) {
  void featureCtx;
  const { communityId, outbound } = commandCtx;
  // Display / pending-session key: the external guild id (the frozen in-memory
  // service maps are keyed by the DISCORD SNOWFLAKE — see service.js).
  const guildId = commandCtx.externalGuildId;

  if (!(await requireStaffFromContext(commandCtx))) return;

  // Discord-only escape hatch (roadmap § What stays Discord-only): the panel
  // service posts real Discord messages and emoji reactions; its cutover to
  // the OutboundClient is PR 7. Fluxer contexts never carry rawInteraction.
  const raw = commandCtx.rawInteraction;

  const group = commandCtx.subcommandGroup;
  const sub = commandCtx.subcommand;

  // /reactionrole panel [create|edit|deploy|delete|list]
  if (group === "panel") {
    if (sub === "create") {
      const ch = commandCtx.options.getChannel("channel", true);
      const title = commandCtx.options.getString("title") || "Reaction Roles";
      const description =
        commandCtx.options.getString("description") ||
        "React to get a role. Remove your reaction to drop it (if allowed).";

      // Channel resolution via outbound (roadmap § Outbound client): the
      // Discord adapter returns the discord.js channel; null / non-text
      // channels get the same "cannot receive messages" answer as today.
      const channelHandle = await outbound.fetchChannel(communityId, ch.id);
      if (
        !channelHandle ||
        (typeof channelHandle.isTextBased === "function" &&
          !channelHandle.isTextBased())
      ) {
        await commandCtx.reply({
          content: "That channel cannot receive messages.",
          sensitive: true,
        });
        return;
      }

      // Plain NormalizedEmbed replicating service buildPanelEmbed(panelStub, [])
      // — same visible text (title, intro, no-options note, footer, color).
      const embed = {
        title,
        description: [
          description,
          "",
          "_No roles configured yet. An admin can add options with `/reactionrole option add`._",
        ]
          .join("\n")
          .slice(0, 4096),
        footer: {
          text: "React to claim · remove reaction to drop (where allowed)",
        },
        color: Color.brand,
      };

      let sent;
      try {
        // Features post through outbound.sendChannel — never channel.send
        // (roadmap § Outbound client).
        sent = await outbound.sendChannel(ch.id, {
          embeds: [embed],
          // Role names may appear later in the embed as mentions — never ping
          allowedMentions: NO_PING_MENTIONS,
        });
      } catch (e) {
        sent = { ok: false, error: e?.message || String(e) };
      }
      if (!sent.ok) {
        await commandCtx.reply({
          content: `Could not post panel: ${sent.error}`,
          sensitive: true,
        });
        return;
      }

      createReactionRolePanel(communityId, ch.id, sent.id, title, description);
      recordSlashAudit({
        communityId,
        actorUserId: commandCtx.userId,
        action: "reaction_roles.panel_create",
        targetType: "reaction_role_panel",
        targetId: sent.id,
        details: { channel_id: ch.id, title },
      });
      // Message#url equivalent, platform-aware (gap #2): Fluxer builds the
      // jump from the instance's discovered webapp base — a discord.com
      // link is dead on Fluxer AND gets auto-embedded as a Discord
      // marketing card (verified live 2026-10-02). null = render nothing.
      const jump = buildMessageJumpUrl({
        platform: commandCtx.platform,
        guildId,
        channelId: ch.id,
        messageId: sent.id,
        webappBaseUrl: outbound.webappBaseUrl,
      });
      await logConfigChange(outbound, guildId, {
        title: "Reaction-role panel created",
        command: "/reactionrole panel create",
        actor: commandCtx.user,
        changes: [
          `Channel: <#${ch.id}>`,
          `Message ID: \`${sent.id}\``,
          `Title: ${title}`,
        ],
        details: jump,
      }).catch(() => {});
      await commandCtx.reply({
        content:
          `Created reaction-role panel in <#${ch.id}>.\n` +
          `Message ID: \`${sent.id}\`\n` +
          `Jump: ${jump ?? "(link unavailable — the instance advertises no web address)"}\n` +
          `Add options with \`/reactionrole option add message_id:${sent.id}\`.`,
        sensitive: true,
      });
      return;
    }

    if (sub === "edit") {
      const messageId = commandCtx.options.getString("message_id", true).trim();
      const title = commandCtx.options.getString("title");
      const description = commandCtx.options.getString("description");

      if (title == null && description == null) {
        await commandCtx.reply({
          content:
            "Provide at least one of `title` or `description` to update.",
          sensitive: true,
        });
        return;
      }

      const panel = getReactionRolePanel(communityId, messageId);
      if (!panel) {
        await commandCtx.reply({
          content: `No reaction-role panel with message ID \`${messageId}\`.`,
          sensitive: true,
        });
        return;
      }

      updateReactionRolePanelText(communityId, messageId, title, description);
      recordSlashAudit({
        communityId,
        actorUserId: commandCtx.userId,
        action: "reaction_roles.panel_update",
        targetType: "reaction_role_panel",
        targetId: messageId,
        details: {
          title_updated: title != null,
          description_updated: description != null,
        },
      });
      const updated = getReactionRolePanel(communityId, messageId);
      // Frozen service surface reads `panel.guild_id` and forwards it to the
      // community-keyed repo, so the repo row carries the INTEGER community id.
      // refreshPanelMessage edits the real Discord message — the service-internal
      // cutover is PR 7 (roadmap § Outbound client). Fluxer has no rawInteraction;
      // the service then reports "Panel message is missing" as a refresh failure
      // on the "Saved text" reply (graceful, never throws).
      const result = await refreshPanelMessage(
        raw?.guild,
        updated ? { ...updated, guild_id: communityId } : updated,
      );
      const changeLines = [];
      if (title != null)
        changeLines.push(`Title: ${panel.title} → **${updated.title}**`);
      if (description != null) {
        changeLines.push(
          `Description updated (${String(panel.description || "").length} → ${String(updated.description || "").length} chars)`,
        );
      }
      await logConfigChange(outbound, guildId, {
        title: "Reaction-role panel edited",
        command: "/reactionrole panel edit",
        actor: commandCtx.user,
        changes: [`Panel: \`${messageId}\``, ...changeLines],
      }).catch(() => {});
      await commandCtx.reply({
        content: result.ok
          ? `Updated panel \`${messageId}\`.`
          : `Saved text, but refresh failed: ${result.error}`,
        sensitive: true,
      });
      return;
    }

    if (sub === "deploy") {
      const messageId = commandCtx.options.getString("message_id", true).trim();
      const ch = commandCtx.options.getChannel("channel", true);

      // Channel resolution via outbound (same gates as `panel create`).
      const channelHandle = await outbound.fetchChannel(communityId, ch.id);
      if (
        !channelHandle ||
        (typeof channelHandle.isTextBased === "function" &&
          !channelHandle.isTextBased())
      ) {
        await commandCtx.reply({
          content: "That channel cannot receive messages.",
          sensitive: true,
        });
        return;
      }

      // deployPanelToChannel posts a real Discord message and adds emoji
      // reactions via the service; the OutboundClient reaction surface is not
      // wired into service.js until PR 7. Recipe 11 (roadmap
      // § What stays Discord-only): Discord arm uses the raw interaction's
      // guild, Fluxer gets the standard not-yet-available line.
      if (!raw) {
        await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
        return;
      }

      // May post + react several times (defer({sensitive:true}) ≙ the old
      // deferReply with the ephemeral flag).
      await commandCtx.defer({ sensitive: true });

      const result = await deployPanelToChannel(
        raw.guild,
        messageId,
        channelHandle,
      );
      if (!result.ok) {
        await commandCtx.editReply({ content: result.error });
        return;
      }

      const n = result.optionCount ?? 0;
      recordSlashAudit({
        communityId,
        actorUserId: commandCtx.userId,
        action: "reaction_roles.panel_deploy",
        targetType: "reaction_role_panel",
        targetId: result.message.id,
        details: {
          source_message_id: messageId,
          channel_id: ch.id,
          option_count: n,
        },
      });
      let content =
        `Deployed panel from \`${messageId}\` → <#${ch.id}>.\n` +
        `New message ID: \`${result.message.id}\`\n` +
        `Jump: ${result.message.url}\n` +
        `Copied **${n}** option${n === 1 ? "" : "s"} (source panel left in place).`;
      if (result.error) {
        content += `\n⚠️ ${result.error}`;
      }
      await logConfigChange(outbound, guildId, {
        title: "Reaction-role panel deployed",
        command: "/reactionrole panel deploy",
        actor: commandCtx.user,
        changes: [
          `Source panel: \`${messageId}\``,
          `New channel: <#${ch.id}>`,
          `New message ID: \`${result.message.id}\``,
          `Options copied: **${n}**`,
        ],
        details: result.message.url,
      }).catch(() => {});
      await commandCtx.editReply({ content });
      return;
    }

    if (sub === "delete") {
      const messageId = commandCtx.options.getString("message_id", true).trim();
      const { removed, channel_id } = deleteReactionRolePanel(
        communityId,
        messageId,
      );

      let note = "";
      if (removed && channel_id) {
        // Deleting the panel message is Discord-only: OutboundClient has no
        // message-delete surface yet (service cutover PR 7).
        try {
          const channel = raw?.guild
            ? await raw.guild.channels.fetch(channel_id).catch(() => null)
            : null;
          if (channel?.messages) {
            const msg = await channel.messages
              .fetch(messageId)
              .catch(() => null);
            if (msg) {
              await msg.delete().catch(() => null);
              note = " Discord message deleted.";
            } else {
              note = " (Message was already gone.)";
            }
          }
        } catch {
          note =
            " (Could not delete Discord message — remove it manually if needed.)";
        }
      }

      if (removed) {
        recordSlashAudit({
          communityId,
          actorUserId: commandCtx.userId,
          action: "reaction_roles.panel_delete",
          targetType: "reaction_role_panel",
          targetId: messageId,
          details: { channel_id: channel_id ?? null },
        });
        await logConfigChange(outbound, guildId, {
          title: "Reaction-role panel deleted",
          command: "/reactionrole panel delete",
          actor: commandCtx.user,
          changes: [
            `Message ID: \`${messageId}\``,
            channel_id ? `Channel: <#${channel_id}>` : null,
          ].filter(Boolean),
          details: note.trim() || undefined,
        }).catch(() => {});
      }

      await commandCtx.reply({
        content: removed
          ? `Deleted reaction-role panel \`${messageId}\`.${note}`
          : `No reaction-role panel with message ID \`${messageId}\`.`,
        sensitive: true,
      });
      return;
    }

    if (sub === "list") {
      const panels = listReactionRolePanels(communityId);
      if (!panels.length) {
        await commandCtx.reply({
          content:
            "No reaction-role panels configured. Use `/reactionrole panel create`.",
          sensitive: true,
        });
        return;
      }
      const lines = panels.map((p) => {
        const jump = buildMessageJumpUrl({
          platform: commandCtx.platform,
          guildId,
          channelId: p.channel_id,
          messageId: p.message_id,
          webappBaseUrl: commandCtx.outbound.webappBaseUrl,
        });
        const n = countReactionRoleOptions(communityId, p.message_id);
        const jumpPart = jump ? ` — [jump](${jump})` : "";
        return `- **${p.title}** in <#${p.channel_id}> — \`${p.message_id}\` (${n} option${n === 1 ? "" : "s"})${jumpPart}`;
      });
      await commandCtx.reply({
        content: `**Reaction-role panels:**\n${lines.join("\n")}`,
        sensitive: true,
      });
      return;
    }
  }

  // /reactionrole option [add|remove|list]
  if (group === "option") {
    if (sub === "add") {
      const messageId = commandCtx.options.getString("message_id", true).trim();
      const role = commandCtx.options.getRole("role", true);
      const level = commandCtx.options.getInteger("level") ?? 0;
      const removable = commandCtx.options.getBoolean("removable");
      const removableFlag = removable === null ? true : removable;

      const panel = getReactionRolePanel(communityId, messageId);
      if (!panel) {
        await commandCtx.reply({
          content: `No reaction-role panel with message ID \`${messageId}\`.`,
          sensitive: true,
        });
        return;
      }

      // Spec RoleHandle carries no `managed` flag — graft the Discord-side
      // role from the rawInteraction escape hatch (userinfo precedent). Fluxer
      // contexts carry no raw; PR 9 wires the Fluxer role surface.
      const rawRole = raw?.guild?.roles?.cache?.get?.(role.id) ?? null;
      if (rawRole?.managed) {
        await commandCtx.reply({
          content:
            "That role is managed by an integration and cannot be assigned by the bot.",
          sensitive: true,
        });
        return;
      }

      const optCount = countReactionRoleOptions(communityId, messageId);
      if (optCount >= MAX_OPTIONS_PER_PANEL) {
        await commandCtx.reply({
          content: `This panel already has ${MAX_OPTIONS_PER_PANEL} options (Discord reaction limit). Remove one first.`,
          sensitive: true,
        });
        return;
      }

      // Replace any prior wait session for this admin.
      // NOTE: the pending-emoji maps are frozen in-memory service state keyed by
      // the DISCORD SNOWFLAKE (service.js resolves `message.guild.id` on the
      // reply), so these stay snowflake-keyed (externalGuildId ≡ guild.id on
      // Discord). TODO(fluxer-pr5): convert service.js.
      clearPendingOptionEmoji(guildId, commandCtx.userId);
      setPendingOptionAdd(guildId, commandCtx.userId, {
        messageId,
        roleId: role.id,
        level,
        removable: removableFlag,
        channelId: commandCtx.channelId,
      });

      const mins = Math.round(PENDING_EMOJI_TTL_MS / 60000);
      await commandCtx.reply({
        content:
          `**Send the emoji** as your next message in this server (message should be only the emoji).\n` +
          `I'll map it to <@&${role.id}> on panel \`${messageId}\` (Level ${level}+, ${
            removableFlag ? "removable" : "permanent"
          }).\n` +
          `Type **\`stop\`** to cancel. Expires in ${mins} minutes.`,
        allowedMentions: NO_PING_MENTIONS,
        sensitive: true,
      });
      return;
    }

    if (sub === "remove") {
      const messageId = commandCtx.options.getString("message_id", true).trim();

      const panel = getReactionRolePanel(communityId, messageId);
      if (!panel) {
        await commandCtx.reply({
          content: `No reaction-role panel with message ID \`${messageId}\`.`,
          sensitive: true,
        });
        return;
      }

      const optCount = countReactionRoleOptions(communityId, messageId);
      if (optCount === 0) {
        await commandCtx.reply({
          content: `Panel \`${messageId}\` has no options to remove.`,
          sensitive: true,
        });
        return;
      }

      // Snowflake-keyed frozen in-memory state (see note in "add").
      clearPendingOptionEmoji(guildId, commandCtx.userId);
      setPendingOptionRemove(guildId, commandCtx.userId, {
        messageId,
        channelId: commandCtx.channelId,
      });

      const mins = Math.round(PENDING_EMOJI_TTL_MS / 60000);
      await commandCtx.reply({
        content:
          `**Send the emoji** to remove as your next message (message should be only the emoji).\n` +
          `I'll remove that option from panel \`${messageId}\`.\n` +
          `Type **\`stop\`** to cancel. Expires in ${mins} minutes.`,
        sensitive: true,
      });
      return;
    }

    if (sub === "list") {
      const messageId = commandCtx.options.getString("message_id", true).trim();
      const panel = getReactionRolePanel(communityId, messageId);
      if (!panel) {
        await commandCtx.reply({
          content: `No reaction-role panel with message ID \`${messageId}\`.`,
          sensitive: true,
        });
        return;
      }

      const opts = listReactionRoleOptions(communityId, messageId);
      if (!opts.length) {
        await commandCtx.reply({
          content: `Panel \`${messageId}\` has no options yet.`,
          sensitive: true,
        });
        return;
      }

      const lines = opts.map((o) => {
        const rem = Number(o.removable) !== 0 ? "removable" : "permanent";
        return `- ${o.emoji_display} → <@&${o.role_id}> — Level ${o.min_level}+ · ${rem}`;
      });
      await commandCtx.reply({
        content: `**Options for panel \`${messageId}\`:**\n${lines.join("\n")}`,
        allowedMentions: NO_PING_MENTIONS,
        sensitive: true,
      });
      return;
    }
  }

  // /reactionrole sync
  if (!group && sub === "sync") {
    const messageId = commandCtx.options.getString("message_id", true).trim();
    const panel = getReactionRolePanel(communityId, messageId);
    if (!panel) {
      await commandCtx.reply({
        content: `No reaction-role panel with message ID \`${messageId}\`.`,
        sensitive: true,
      });
      return;
    }

    // Frozen service surface reads `panel.guild_id` and forwards it to the
    // community-keyed repo, so the repo row carries the INTEGER community id.
    // The refresh edits real Discord messages (service cutover PR 7); Fluxer
    // has no rawInteraction, so the service reports the missing message as a
    // sync failure (graceful, never throws).
    const result = await refreshPanelMessage(raw?.guild, {
      ...panel,
      guild_id: communityId,
    });
    if (result.ok) {
      await logConfigChange(outbound, guildId, {
        title: "Reaction-role panel synced",
        command: "/reactionrole sync",
        actor: commandCtx.user,
        changes: [`Panel: \`${messageId}\``],
      }).catch(() => {});
    }
    await commandCtx.reply({
      content: result.ok
        ? `Synced panel \`${messageId}\` (embed + bot reactions).`
        : `Sync failed: ${result.error}`,
      sensitive: true,
    });
    return;
  }

  await commandCtx.reply({
    content:
      `Unknown reactionrole subcommand: \`/${commandCtx.commandName}` +
      `${group ? ` ${group}` : ""} ${sub || ""}\`.\n` +
      `Use \`/reactionrole panel create|edit|deploy|delete|list\`, \`/reactionrole option add|remove|list\`, or \`/reactionrole sync\`.`,
    sensitive: true,
  });
  return;
}

/**
 * Fluxer MESSAGE_REACTION_ADD entry point (PR 9, roadmap § Outbound client):
 * mirrors the Discord reaction-add flow (guard bots, resolve the community,
 * call the service handler) over a NormalizedReaction. The pipeline has
 * already resolved communityId; the service resolves it defensively when called
 * directly. The Discord handlers below stay on the raw gateway event.
 *
 * @param {object} outbound OutboundClient (Fluxer)
 * @param {object} normalizedReaction normalizeFluxerReaction output
 * @returns {Promise<{ handled: boolean, ok?: boolean, code?: string, error?: string }>}
 */
async function onFluxerReactionAdd(outbound, normalizedReaction) {
  if (!normalizedReaction) return { handled: false };
  if (normalizedReaction.userBot) return { handled: false };
  return handleReactionRoleAddFluxer(outbound, normalizedReaction);
}

/**
 * Fluxer MESSAGE_REACTION_REMOVE entry point (PR 9). Mirrors the Discord
 * reaction-remove flow: bots skip, then the service strips the role for
 * removable options.
 *
 * @param {object} outbound OutboundClient (Fluxer)
 * @param {object} normalizedReaction normalizeFluxerReaction output
 * @returns {Promise<{ handled: boolean, ok?: boolean, code?: string, error?: string }>}
 */
async function onFluxerReactionRemove(outbound, normalizedReaction) {
  if (!normalizedReaction) return { handled: false };
  if (normalizedReaction.userBot) return { handled: false };
  return handleReactionRoleRemoveFluxer(outbound, normalizedReaction);
}

module.exports = {
  name: "reactionRoles",
  commands,
  handlers: {
    reactionrole: handleReactionrole,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): the slash
  // handler receives a CommandContext. Modal-submit / reaction / message arms
  // stay on the raw interaction (roadmap § What stays Discord-only).
  handlerApi: {
    reactionrole: "context",
  },
  handleReactionRoleAdd,
  handleReactionRoleRemove,
  handlePendingOptionEmojiMessage,
  syncMemberReactionRoles,
  // Fluxer (PR 9): OutboundClient-shaped reaction entry points + service twins.
  onFluxerReactionAdd,
  onFluxerReactionRemove,
  handleReactionRoleAddFluxer,
  handleReactionRoleRemoveFluxer,
  deployPanelFluxer,
  refreshPanelMessageFluxer,
  MAX_OPTIONS_PER_PANEL,
  PENDING_EMOJI_TTL_MS,
  NO_PING_MENTIONS,
  buildPanelEmbed,
  refreshPanelMessage,
  deployPanelToChannel,
  setPendingOptionAdd,
  setPendingOptionRemove,
  clearPendingOptionEmoji,
};
