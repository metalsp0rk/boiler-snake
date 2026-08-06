/**
 * User channel activity feature:
 * - Live message counting (recordUserChannelMessage)
 * - /activityconfig ignore + status (ManageGuild)
 * - Ranking helpers used by /userinfo Activity tab
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} = require("discord.js");
const {
  addActivityIgnore,
  removeActivityIgnore,
  listActivityIgnore,
  ensureGuildActivitySettings,
  getGuildActivitySettings,
  guildActivityStats,
  normalizeIgnoreKind,
} = require("../../db");
const { requireAdmin } = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");
const { recordUserChannelMessage } = require("./service");
const { startUserBackfill, startGuildBackfill } = require("./backfill");

const adminPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName("activityconfig")
    .setDescription("Configure user activity tracking (ignore list, status).")
    .setDefaultMemberPermissions(adminPerms)
    .addSubcommandGroup((group) =>
      group
        .setName("ignore")
        .setDescription("Channels and categories excluded from activity counts.")
        .addSubcommand((sc) =>
          sc
            .setName("add")
            .setDescription("Ignore a channel or category in activity stats.")
            .addStringOption((opt) =>
              opt
                .setName("kind")
                .setDescription("What to ignore")
                .setRequired(true)
                .addChoices(
                  { name: "channel", value: "channel" },
                  { name: "category", value: "category" }
                )
            )
            .addChannelOption((opt) =>
              opt
                .setName("target")
                .setDescription("Channel or category to ignore")
                .setRequired(true)
                .addChannelTypes(
                  ChannelType.GuildText,
                  ChannelType.GuildAnnouncement,
                  ChannelType.GuildCategory,
                  ChannelType.GuildForum,
                  ChannelType.GuildVoice
                )
            )
        )
        .addSubcommand((sc) =>
          sc
            .setName("remove")
            .setDescription("Stop ignoring a channel or category.")
            .addChannelOption((opt) =>
              opt
                .setName("target")
                .setDescription("Channel or category to remove from ignore list")
                .setRequired(true)
            )
        )
        .addSubcommand((sc) =>
          sc.setName("list").setDescription("List ignored channels and categories.")
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("status")
        .setDescription("Show activity tracking status for this server.")
    )
    .addSubcommandGroup((group) =>
      group
        .setName("backfill")
        .setDescription("Scan channel history into activity counters.")
        .addSubcommand((sc) =>
          sc
            .setName("all")
            .setDescription(
              "Backfill all users (one history pass per channel). Rate-limited; long-running."
            )
        )
    ),
];

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleActivityConfig(interaction, ctx) {
  if (!(await requireAdmin(interaction))) return;

  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand(true);
  const guildId = interaction.guildId;
  const client = interaction.client;

  if (group === "ignore" && sub === "add") {
    const kind = normalizeIgnoreKind(
      interaction.options.getString("kind", true)
    );
    const target = interaction.options.getChannel("target", true);

    if (kind === "category" && target.type !== ChannelType.GuildCategory) {
      await interaction.reply({
        content: "Pick a **category** channel when kind is `category`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (kind === "channel" && target.type === ChannelType.GuildCategory) {
      await interaction.reply({
        content:
          "That target is a category. Use kind `category`, or pick a text channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const inserted = addActivityIgnore(guildId, target.id, kind);
    if (inserted) {
      await logConfigChange(client, guildId, {
        title: "Activity ignore added",
        command: "/activityconfig ignore add",
        actor: interaction.user,
        changes: [`**${kind}:** <#${target.id}> (\`${target.id}\`)`],
      });
    }
    await interaction.reply({
      content: inserted
        ? `Now ignoring **${kind}** <#${target.id}> in activity stats.`
        : `Already ignoring <#${target.id}>.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (group === "ignore" && sub === "remove") {
    const target = interaction.options.getChannel("target", true);
    const removed = removeActivityIgnore(guildId, target.id);
    if (removed) {
      await logConfigChange(client, guildId, {
        title: "Activity ignore removed",
        command: "/activityconfig ignore remove",
        actor: interaction.user,
        changes: [`**target:** <#${target.id}> (\`${target.id}\`)`],
      });
    }
    await interaction.reply({
      content: removed
        ? `Removed <#${target.id}> from the activity ignore list.`
        : `<#${target.id}> was not on the ignore list.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (group === "ignore" && sub === "list") {
    const rows = listActivityIgnore(guildId);
    if (!rows.length) {
      await interaction.reply({
        content:
          "No ignored channels or categories. Honeypot channels are always skipped.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const lines = rows.map((r) => {
      const mention =
        r.kind === "category" ? `\`${r.target_id}\` (category)` : `<#${r.target_id}>`;
      return `• **${r.kind}** ${mention}`;
    });
    await interaction.reply({
      content: `**Activity ignore list** (${rows.length})\n${lines.join("\n")}`.slice(
        0,
        2000
      ),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "status") {
    ensureGuildActivitySettings(guildId);
    const settings = getGuildActivitySettings(guildId);
    const stats = guildActivityStats(guildId);
    const collectFrom = settings?.collect_from_ms
      ? `<t:${Math.floor(settings.collect_from_ms / 1000)}:f>`
      : "—";
    const gStatus = settings?.guild_backfill_status || "none";
    const gDone = settings?.guild_backfill_channels_done ?? 0;
    const gTotal = settings?.guild_backfill_channels_total ?? 0;
    const gMsgs = settings?.guild_backfill_messages_counted ?? 0;
    let gLine = `• Guild backfill: **${gStatus}**`;
    if (gStatus !== "none") {
      gLine += ` · channels ${gDone}/${gTotal} · msgs counted ${gMsgs}`;
    }
    if (settings?.guild_backfill_error) {
      gLine += `\n• Last error: ${String(settings.guild_backfill_error).slice(0, 200)}`;
    }
    await interaction.reply({
      content:
        `**Activity tracking status**\n` +
        `• Live collect from: ${collectFrom}\n` +
        `• Daily counter rows: **${stats.day_rows}**\n` +
        `• Messages counted (sum): **${stats.message_total}**\n` +
        `• Ignore entries: **${stats.ignore_count}**\n` +
        `• Honeypot channels: always skipped\n` +
        `${gLine}\n` +
        `• Per-user history: senior staff **Backfill** on \`/userinfo\` → Activity\n` +
        `• All users (preferred): \`/activityconfig backfill all\``,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (group === "backfill" && sub === "all") {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command only works in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await startGuildBackfill(interaction.guild);
    if (!result.started) {
      await interaction.editReply({
        content: result.reason || "Could not start guild backfill.",
      });
      return;
    }

    await logConfigChange(client, guildId, {
      title: "Activity guild backfill started",
      command: "/activityconfig backfill all",
      actor: interaction.user,
      changes: [
        `Channels to scan: **${result.channels ?? "?"}**`,
        "Single pass per channel · all human authors · rate-limited (~1.1s/page)",
      ],
    });

    await interaction.editReply({
      content:
        `**Guild backfill started** for **${result.channels ?? "?"}** channels.\n` +
        `Each channel is scanned once; every human author's pre-tracking messages are counted.\n` +
        `This can take a long time (≈1.1s per 100 messages, max 50 pages/channel).\n` +
        `Check progress with \`/activityconfig status\`.`,
    });
    return;
  }

  await interaction.reply({
    content: "Unknown subcommand.",
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = {
  name: "userActivity",
  commands,
  handlers: {
    activityconfig: handleActivityConfig,
  },
  recordUserChannelMessage,
  startUserBackfill,
  startGuildBackfill,
};
