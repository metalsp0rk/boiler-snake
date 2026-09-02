/**
 * User channel activity feature:
 * - Live message counting (recordUserChannelMessage)
 * - /activityconfig ignore + status (staff gate)
 * - Ranking helpers used by /userinfo Activity tab
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} = require("discord.js");
const { tsShort } = require("../../core/theme");
const {
  addActivityIgnore,
  removeActivityIgnore,
  listActivityIgnore,
  ensureGuildActivitySettings,
  getGuildActivitySettings,
  guildActivityStats,
  normalizeIgnoreKind,
} = require("../../db");
const { requireStaff } = require("../../core/permissions");
const { replyEphemeral } = require("../../core/interaction");
const { logConfigChange } = require("../logs/auditLog");
const { recordUserChannelMessage } = require("./service");
const {
  startUserBackfill,
  startGuildBackfill,
  cancelBackfill,
  getBackfillJobInfo,
} = require("./backfill");

const staffPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName("activityconfig")
    .setDescription("Configure user activity tracking (ignore list, status).")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommandGroup((group) =>
      group
        .setName("ignore")
        .setDescription(
          "Channels and categories excluded from activity counts.",
        )
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
                  { name: "category", value: "category" },
                ),
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
                  ChannelType.GuildVoice,
                ),
            ),
        )
        .addSubcommand((sc) =>
          sc
            .setName("remove")
            .setDescription("Stop ignoring a channel or category.")
            .addChannelOption((opt) =>
              opt
                .setName("target")
                .setDescription(
                  "Channel or category to remove from ignore list",
                )
                .setRequired(true),
            ),
        )
        .addSubcommand((sc) =>
          sc
            .setName("list")
            .setDescription("List ignored channels and categories."),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("status")
        .setDescription("Show activity tracking status for this server."),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("backfill")
        .setDescription("Scan channel history into activity counters.")
        .addSubcommand((sc) =>
          sc
            .setName("all")
            .setDescription(
              "Backfill all users (one history pass per channel). Rate-limited; long-running.",
            )
            .addIntegerOption((opt) =>
              opt
                .setName("max_pages")
                .setDescription(
                  "Max history pages per channel (100 msgs/page; default 50 ≈ 5k msgs)",
                )
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(500),
            ),
        )
        .addSubcommand((sc) =>
          sc
            .setName("cancel")
            .setDescription(
              "Stop the in-progress backfill for this server (guild or per-user).",
            ),
        ),
    ),
];

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleActivityConfig(interaction, ctx) {
  if (!(await requireStaff(interaction))) return;

  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand(true);
  const guildId = interaction.guildId;
  const client = interaction.client;

  if (group === "ignore" && sub === "add") {
    const kind = normalizeIgnoreKind(
      interaction.options.getString("kind", true),
    );
    const target = interaction.options.getChannel("target", true);

    if (kind === "category" && target.type !== ChannelType.GuildCategory) {
      await replyEphemeral(interaction, {
        content: "Pick a **category** channel when kind is `category`.",
      });
      return;
    }
    if (kind === "channel" && target.type === ChannelType.GuildCategory) {
      await replyEphemeral(interaction, {
        content:
          "That target is a category. Use kind `category`, or pick a text channel.",
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
    await replyEphemeral(interaction, {
      content: inserted
        ? `Now ignoring **${kind}** <#${target.id}> in activity stats.`
        : `Already ignoring <#${target.id}>.`,
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
    await replyEphemeral(interaction, {
      content: removed
        ? `Removed <#${target.id}> from the activity ignore list.`
        : `<#${target.id}> was not on the ignore list.`,
    });
    return;
  }

  if (group === "ignore" && sub === "list") {
    const rows = listActivityIgnore(guildId);
    if (!rows.length) {
      await replyEphemeral(interaction, {
        content:
          "No ignored channels or categories. Honeypot channels are always skipped.",
      });
      return;
    }
    const lines = rows.map((r) => {
      const mention =
        r.kind === "category"
          ? `\`${r.target_id}\` (category)`
          : `<#${r.target_id}>`;
      return `• **${r.kind}** ${mention}`;
    });
    await replyEphemeral(interaction, {
      content:
        `**Activity ignore list** (${rows.length})\n${lines.join("\n")}`.slice(
          0,
          2000,
        ),
    });
    return;
  }

  if (sub === "status") {
    ensureGuildActivitySettings(guildId);
    const settings = getGuildActivitySettings(guildId);
    const stats = guildActivityStats(guildId);
    const collectFrom = settings?.collect_from_ms
      ? tsShort(settings.collect_from_ms)
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
    await replyEphemeral(interaction, {
      content:
        `**Activity tracking status**\n` +
        `• Live collect from: ${collectFrom}\n` +
        `• Daily counter rows: **${stats.day_rows}**\n` +
        `• Messages counted (sum): **${stats.message_total}**\n` +
        `• Ignore entries: **${stats.ignore_count}**\n` +
        `• Honeypot channels: always skipped\n` +
        `${gLine}\n` +
        `• Per-user history: senior staff **Backfill** on \`/userinfo\` → Activity\n` +
        `• All users (preferred): \`/activityconfig backfill all\`\n` +
        `• Cancel: \`/activityconfig backfill cancel\``,
    });
    return;
  }

  if (group === "backfill" && sub === "cancel") {
    const result = cancelBackfill(guildId);
    if (result.cancelled) {
      await logConfigChange(client, guildId, {
        title: "Activity backfill cancel",
        command: "/activityconfig backfill cancel",
        actor: interaction.user,
        changes: [
          result.kind ? `Kind: **${result.kind}**` : "Kind: unknown",
          result.reason || "Cancelled",
        ],
      });
    }
    await replyEphemeral(interaction, {
      content: result.cancelled
        ? `**Backfill cancel**\n${result.reason || "Cancelled."}`
        : result.reason || "No backfill running.",
    });
    return;
  }

  if (group === "backfill" && sub === "all") {
    if (!interaction.guild) {
      await replyEphemeral(interaction, {
        content: "This command only works in a server.",
      });
      return;
    }

    const maxPagesOpt = interaction.options.getInteger("max_pages");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await startGuildBackfill(interaction.guild, {
      maxPagesPerChannel: maxPagesOpt ?? undefined,
    });
    if (!result.started) {
      await interaction.editReply({
        content: result.reason || "Could not start guild backfill.",
      });
      return;
    }

    const pages = result.maxPagesPerChannel ?? 50;
    const approxMsgs = pages * 100;
    await logConfigChange(client, guildId, {
      title: "Activity guild backfill started",
      command: "/activityconfig backfill all",
      actor: interaction.user,
      changes: [
        `Channels to scan: **${result.channels ?? "?"}**`,
        `Max pages/channel: **${pages}** (≈${approxMsgs} messages)`,
        "Single pass per channel · all human authors · rate-limited (~1.1s/page)",
      ],
    });

    await interaction.editReply({
      content:
        `**Guild backfill started** for **${result.channels ?? "?"}** channels.\n` +
        `Each channel is scanned once; every human author's pre-tracking messages are counted.\n` +
        `Cap: **${pages}** pages/channel (≈**${approxMsgs}** messages) · ≈1.1s per page.\n` +
        `Check progress with \`/activityconfig status\`.\n` +
        `_If a run stops as **partial**, re-run with a higher \`max_pages\` to continue from cursors._`,
    });
    return;
  }

  await replyEphemeral(interaction, {
    content: "Unknown subcommand.",
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
  cancelBackfill,
  getBackfillJobInfo,
};
