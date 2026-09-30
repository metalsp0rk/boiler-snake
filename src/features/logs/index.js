const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  Events,
} = require("discord.js");
const { getGuildSettings, updateGuildSettings } = require("../../db");
const { isStaff } = require("../../core/permissions");
const { replyDenied, replyEphemeral } = require("../../core/interaction");
const { getDiscordOutbound } = require("../../platform/discord/outbound");
const { ensureCommunity } = require("../../platform/community");
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

async function handleSetlog(interaction, ctx) {
  const { client } = ctx;
  const guildId = interaction.guildId;
  // Edge pattern: slash commands resolve the internal community id here so
  // converted repos receive the integer key (INSERT-OR-IGNORE, cheap).
  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: guildId,
  });
  const settings = getGuildSettings(communityId);
  const admin = isStaff(interaction);

  if (!admin) {
    await replyDenied(interaction);
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === "show") {
    const auditLogCh = settings.audit_log_channel_id
      ? `<#${settings.audit_log_channel_id}> (\`${settings.audit_log_channel_id}\`)`
      : "_Not configured_";
    const messageLogCh = settings.message_log_channel_id
      ? `<#${settings.message_log_channel_id}> (\`${settings.message_log_channel_id}\`)`
      : "_Not configured_";
    await replyEphemeral(
      interaction,
      `**Log channels**\n` +
        `• **Audit log** (bans, kicks, role changes): ${auditLogCh}\n` +
        `• **Message log** (deleted messages): ${messageLogCh}`,
    );
    return;
  }

  if (sub === "audit" || sub === "message") {
    const clear = interaction.options.getBoolean("clear") === true;
    const ch = interaction.options.getChannel("channel", false);
    const field =
      sub === "audit" ? "audit_log_channel_id" : "message_log_channel_id";
    const label = sub === "audit" ? "Audit log" : "Message log";
    const beforeId = settings[field];

    if (clear) {
      // Log while the audit channel still exists (if clearing audit itself).
      // logConfigChange keeps the Discord snowflake as 2nd arg (resolved internally).
      await logConfigChange(getDiscordOutbound(client), guildId, {
        title: `${label} channel cleared`,
        command: `/setlog ${sub}`,
        actor: interaction.user,
        changes: [
          beforeId
            ? `${label}: <#${beforeId}> → *none*`
            : `${label}: was already unset`,
        ],
      }).catch(() => {});
      updateGuildSettings(communityId, { [field]: null });
      recordSlashAudit({
        interaction,
        communityId,
        action: "logs.channel_clear",
        targetType: "guild",
        targetId: guildId,
        details: { stream: sub, previous_channel_id: beforeId ?? null },
      });
      await replyEphemeral(
        interaction,
        `${label} channel cleared. That log stream is disabled until set again.`,
      );
      return;
    }

    if (!ch) {
      await replyEphemeral(
        interaction,
        `Provide a \`channel\`, or set \`clear:true\` to disable the ${label.toLowerCase()}.`,
      );
      return;
    }

    updateGuildSettings(communityId, { [field]: ch.id });
    recordSlashAudit({
      interaction,
      communityId,
      action: "logs.channel_set",
      targetType: "channel",
      targetId: ch.id,
      details: { stream: sub, previous_channel_id: beforeId ?? null },
    });
    await logConfigChange(getDiscordOutbound(client), guildId, {
      title: `${label} channel set`,
      command: `/setlog ${sub}`,
      actor: interaction.user,
      changes: [
        beforeId
          ? `${label}: <#${beforeId}> → <#${ch.id}>`
          : `${label}: *none* → <#${ch.id}>`,
      ],
    }).catch(() => {});
    await replyEphemeral(interaction, `${label} will be sent to <#${ch.id}>.`);
    return;
  }
}

function registerEvents(client) {
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
