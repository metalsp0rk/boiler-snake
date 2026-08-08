const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, Events } = require("discord.js");
const { getGuildSettings, updateGuildSettings } = require("../../db");
const { isStaff } = require("../../core/permissions");
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
} = require("./auditLog");

const staffPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
      .setName("setlog")
      .setDescription("Configure audit log and message log channels (staff).")
      .setDefaultMemberPermissions(staffPerms)
      .addSubcommand((sc) => {
        const sub = sc
          .setName("audit")
          .setDescription("Set the channel for bans, kicks, and role-change logs.");
        sub.addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel for audit log embeds")
            .setRequired(false)
        );
        sub.addBooleanOption((opt) =>
          opt
            .setName("clear")
            .setDescription("Clear the audit log channel (disable stream)")
            .setRequired(false)
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
            .setRequired(false)
        );
        sub.addBooleanOption((opt) =>
          opt
            .setName("clear")
            .setDescription("Clear the message log channel (disable stream)")
            .setRequired(false)
        );
        return sub;
      })
      .addSubcommand((sc) =>
        sc.setName("show").setDescription("Show current audit and message log channels.")
      ),
];

async function handleSetlog(interaction, ctx) {
  const { client } = ctx;
  const guildId = interaction.guildId;
  const settings = getGuildSettings(guildId);
  const admin = isStaff(interaction);

  if (!admin) {
    await interaction.reply({ content: "You don’t have permission to use this.", flags: MessageFlags.Ephemeral });
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === "show") {
    const auditLogCh = settings.audit_log_channel_id
      ? `<#${settings.audit_log_channel_id}> (\`${settings.audit_log_channel_id}\`)`
      : "Not configured";
    const messageLogCh = settings.message_log_channel_id
      ? `<#${settings.message_log_channel_id}> (\`${settings.message_log_channel_id}\`)`
      : "Not configured";
    await interaction.reply({
      content:
        `**Log channels**\n` +
        `• **Audit log** (bans, kicks, role changes): ${auditLogCh}\n` +
        `• **Message log** (deleted messages): ${messageLogCh}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "audit" || sub === "message") {
    const clear = interaction.options.getBoolean("clear") === true;
    const ch = interaction.options.getChannel("channel", false);
    const field = sub === "audit" ? "audit_log_channel_id" : "message_log_channel_id";
    const label = sub === "audit" ? "Audit log" : "Message log";
    const beforeId = settings[field];

    if (clear) {
      // Log while the audit channel still exists (if clearing audit itself)
      await logConfigChange(client, guildId, {
        title: `${label} channel cleared`,
        command: `/setlog ${sub}`,
        actor: interaction.user,
        changes: [
          beforeId
            ? `${label}: <#${beforeId}> → *none*`
            : `${label}: was already unset`,
        ],
      }).catch(() => {});
      updateGuildSettings(guildId, { [field]: null });
      await interaction.reply({
        content: `${label} channel cleared. That log stream is disabled until set again.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!ch) {
      await interaction.reply({
        content: `Provide a \`channel\`, or set \`clear:true\` to disable the ${label.toLowerCase()}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    updateGuildSettings(guildId, { [field]: ch.id });
    await logConfigChange(client, guildId, {
      title: `${label} channel set`,
      command: `/setlog ${sub}`,
      actor: interaction.user,
      changes: [
        beforeId
          ? `${label}: <#${beforeId}> → <#${ch.id}>`
          : `${label}: *none* → <#${ch.id}>`,
      ],
    }).catch(() => {});
    await interaction.reply({
      content: `${label} will be sent to <#${ch.id}>.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
}

function registerEvents(client) {
  client.on(Events.MessageDelete, async (message) => {
    try {
      if (!message.guild) return;
      if (message.partial) {
        try { await message.fetch(); } catch { /* often fails for deletes */ }
      }
      await logMessageDelete(client, message);
    } catch (e) {
      console.error("[MessageDelete] error:", e?.message || e);
    }
  });

  client.on(Events.MessageBulkDelete, async (messages, channel) => {
    try {
      await logMessageBulkDelete(client, messages, channel);
    } catch (e) {
      console.error("[MessageBulkDelete] error:", e?.message || e);
    }
  });

  client.on(Events.GuildBanAdd, async (ban) => {
    try {
      await logBan(client, ban);
    } catch (e) {
      console.error("[GuildBanAdd] error:", e?.message || e);
    }
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    try {
      if (!member?.guild) return;
      await logKickIfApplicable(client, member);
    } catch (e) {
      console.error("[GuildMemberRemove] error:", e?.message || e);
    }
  });
}

module.exports = {
  name: "logs",
  commands,
  handlers: {
    setlog: handleSetlog,
  },
  registerEvents,
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

