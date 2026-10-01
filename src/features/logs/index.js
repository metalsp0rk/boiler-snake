const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  Events,
} = require("discord.js");
const { getGuildSettings, updateGuildSettings } = require("../../db");
const {
  requireStaffFromContext,
} = require("../../core/permissions");
const { getDiscordOutbound } = require("../../platform/discord/outbound");
const {
  cacheMessage,
  logMessageDelete,
  logMessageBulkDelete,
  logBan,
  logKickIfApplicable,
  logConfigChange,
  logHoneypotTrigger,
  logLevelRoleChanges,
  diffConfigLines,
  startMessageCacheSweep,
} = require("./auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");

const staffPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName("setlog")
    .setDescription("Configure audit log and message log channels (staff).")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommand((sc) => {
      const sub = sc
        .setName("audit")
        .setDescription(
          "Set the channel for bans, kicks, and role-change logs.",
        );
      sub.addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Channel for audit log embeds")
          .setRequired(false),
      );
      sub.addBooleanOption((opt) =>
        opt
          .setName("clear")
          .setDescription("Clear the audit log channel (disable stream)")
          .setRequired(false),
      );
      return sub;
    })
    .addSubcommand((sc) => {
      const sub = sc
        .setName("message")
        .setDescription("Set the channel for deleted-message logs.");
      sub.addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Channel for message delete embeds")
          .setRequired(false),
      );
      sub.addBooleanOption((opt) =>
        opt
          .setName("clear")
          .setDescription("Clear the message log channel (disable stream)")
          .setRequired(false),
      );
      return sub;
    })
    .addSubcommand((sc) =>
      sc
        .setName("show")
        .setDescription("Show current audit and message log channels."),
    ),
];

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleSetlog(commandCtx, featureCtx) {
  void featureCtx;
  const guildId = commandCtx.externalGuildId;
  // Context seam: commandCtx already carries the internal integer community id
  // (the old ensureCommunity edge runs in the Discord context builder).
  const communityId = commandCtx.communityId;
  const settings = getGuildSettings(communityId);

  if (!(await requireStaffFromContext(commandCtx))) return;

  const sub = commandCtx.subcommand;

  if (sub === "show") {
    const auditLogCh = settings.audit_log_channel_id
      ? `<#${settings.audit_log_channel_id}> (\`${settings.audit_log_channel_id}\`)`
      : "_Not configured_";
    const messageLogCh = settings.message_log_channel_id
      ? `<#${settings.message_log_channel_id}> (\`${settings.message_log_channel_id}\`)`
      : "_Not configured_";
    await commandCtx.reply({
      content:
        `**Log channels**\n` +
        `• **Audit log** (bans, kicks, role changes): ${auditLogCh}\n` +
        `• **Message log** (deleted messages): ${messageLogCh}`,
      sensitive: true,
    });
    return;
  }

  if (sub === "audit" || sub === "message") {
    const clear = commandCtx.options.getBoolean("clear") === true;
    const ch = commandCtx.options.getChannel("channel", false);
    const field =
      sub === "audit" ? "audit_log_channel_id" : "message_log_channel_id";
    const label = sub === "audit" ? "Audit log" : "Message log";
    const beforeId = settings[field];

    if (clear) {
      // Log while the audit channel still exists (if clearing audit itself).
      // logConfigChange keeps the Discord snowflake as 2nd arg (resolved internally).
      await logConfigChange(commandCtx.outbound, guildId, {
        title: `${label} channel cleared`,
        command: `/setlog ${sub}`,
        actor: commandCtx.user,
        changes: [
          beforeId
            ? `${label}: <#${beforeId}> → *none*`
            : `${label}: was already unset`,
        ],
      }).catch(() => {});
      updateGuildSettings(communityId, { [field]: null });
      recordSlashAudit({
        communityId,
        actorUserId: commandCtx.userId,
        action: "logs.channel_clear",
        targetType: "guild",
        targetId: guildId,
        details: { stream: sub, previous_channel_id: beforeId ?? null },
      });
      await commandCtx.reply({
        content: `${label} channel cleared. That log stream is disabled until set again.`,
        sensitive: true,
      });
      return;
    }

    if (!ch) {
      await commandCtx.reply({
        content: `Provide a \`channel\`, or set \`clear:true\` to disable the ${label.toLowerCase()}.`,
        sensitive: true,
      });
      return;
    }

    // Context arm carries a bare { id, type } handle — validate the id names a
    // real channel (on Discord fetchChannel hands back the discord.js channel;
    // a null handle means the bot cannot resolve it).
    const channelHandle = await commandCtx.outbound.fetchChannel(
      communityId,
      ch.id,
    );
    if (!channelHandle) {
      console.error(
        `[logs] /setlog ${sub}: channel ${ch.id} unavailable in community ${communityId}`,
      );
      await commandCtx.reply({
        content: `I can't find channel <#${ch.id}> in this server. It may have been deleted, or the bot lacks access. Pick a visible text channel, or set \`clear:true\` to disable the ${label.toLowerCase()}.`,
        sensitive: true,
      });
      return;
    }

    updateGuildSettings(communityId, { [field]: ch.id });
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "logs.channel_set",
      targetType: "channel",
      targetId: ch.id,
      details: { stream: sub, previous_channel_id: beforeId ?? null },
    });
    await logConfigChange(commandCtx.outbound, guildId, {
      title: `${label} channel set`,
      command: `/setlog ${sub}`,
      actor: commandCtx.user,
      changes: [
        beforeId
          ? `${label}: <#${beforeId}> → <#${ch.id}>`
          : `${label}: *none* → <#${ch.id}>`,
      ],
    }).catch(() => {});
    await commandCtx.reply({
      content: `${label} will be sent to <#${ch.id}>.`,
      sensitive: true,
    });
    return;
  }
}

/**
 * PR 7 (spec § Scheduler line 608): bans/kicks/message-delete gateway events
 * bind to the Discord client only — supervisor.discord, null → no-op binds.
 * @param {import("../../platform/boot").Supervisor} supervisor
 * @param {object} [ctx]
 */
function registerEvents(supervisor, ctx) {
  const client = supervisor?.discord ?? null;
  if (!client) return;
  client.on(Events.MessageDelete, async (message) => {
    try {
      if (!message.guild) return;
      if (message.partial) {
        try {
          await message.fetch();
        } catch {
          /* often fails for deletes */
        }
      }
      // auditLog helpers take an OutboundClient (cached per client) as 1st arg
      await logMessageDelete(getDiscordOutbound(client), message);
    } catch (e) {
      console.error("[MessageDelete] error:", e?.message || e);
    }
  });

  client.on(Events.MessageBulkDelete, async (messages, channel) => {
    try {
      await logMessageBulkDelete(getDiscordOutbound(client), messages, channel);
    } catch (e) {
      console.error("[MessageBulkDelete] error:", e?.message || e);
    }
  });

  client.on(Events.GuildBanAdd, async (ban) => {
    try {
      await logBan(getDiscordOutbound(client), ban);
    } catch (e) {
      console.error("[GuildBanAdd] error:", e?.message || e);
    }
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    try {
      if (!member?.guild) return;
      await logKickIfApplicable(getDiscordOutbound(client), member);
    } catch (e) {
      console.error("[GuildMemberRemove] error:", e?.message || e);
    }
  });
}

function start() {
  startMessageCacheSweep();
}

module.exports = {
  name: "logs",
  commands,
  handlers: {
    setlog: handleSetlog,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): the /setlog
  // slash handler receives a CommandContext.
  handlerApi: {
    setlog: "context",
  },
  registerEvents,
  start,
  cacheMessage,
  logMessageDelete,
  logMessageBulkDelete,
  logBan,
  logKickIfApplicable,
  logConfigChange,
  logHoneypotTrigger,
  logLevelRoleChanges,
  diffConfigLines,
};
