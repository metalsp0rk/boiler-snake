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
const { requireStaffFromContext } = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");
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
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleActivityConfig(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireStaffFromContext(commandCtx))) return;

  const group = commandCtx.subcommandGroup;
  const sub = commandCtx.subcommand;
  // Display/audit key: the external (Discord) snowflake; backfill jobs key by it.
  const guildId = commandCtx.externalGuildId;
  // Repos key by the integer community id (resolved by the context builder);
  // auditLog keys by the context's outbound.
  const communityId = commandCtx.communityId;
  const outbound = commandCtx.outbound;

  if (group === "ignore" && sub === "add") {
    const kind = normalizeIgnoreKind(
      commandCtx.options.getString("kind", true),
    );
    const target = commandCtx.options.getChannel("target", true);

    if (kind === "category" && target.type !== ChannelType.GuildCategory) {
      await commandCtx.reply({
        content: "Pick a **category** channel when kind is `category`.",
        sensitive: true,
      });
      return;
    }
    if (kind === "channel" && target.type === ChannelType.GuildCategory) {
      await commandCtx.reply({
        content:
          "That target is a category. Use kind `category`, or pick a text channel.",
        sensitive: true,
      });
      return;
    }

    const inserted = addActivityIgnore(communityId, target.id, kind);
    if (inserted) {
      recordSlashAudit({
        communityId,
        actorUserId: commandCtx.userId,
        action: "activity.ignore_add",
        targetType: "channel",
        targetId: target.id,
        details: { kind },
      });
      await logConfigChange(outbound, guildId, {
        title: "Activity ignore added",
        command: "/activityconfig ignore add",
        actor: commandCtx.user,
        changes: [`**${kind}:** <#${target.id}> (\`${target.id}\`)`],
      });
    }
    await commandCtx.reply({
      content: inserted
        ? `Now ignoring **${kind}** <#${target.id}> in activity stats.`
        : `Already ignoring <#${target.id}>.`,
      sensitive: true,
    });
    return;
  }

  if (group === "ignore" && sub === "remove") {
    const target = commandCtx.options.getChannel("target", true);
    const removed = removeActivityIgnore(communityId, target.id);
    if (removed) {
      recordSlashAudit({
        communityId,
        actorUserId: commandCtx.userId,
        action: "activity.ignore_remove",
        targetType: "channel",
        targetId: target.id,
      });
      await logConfigChange(outbound, guildId, {
        title: "Activity ignore removed",
        command: "/activityconfig ignore remove",
        actor: commandCtx.user,
        changes: [`**target:** <#${target.id}> (\`${target.id}\`)`],
      });
    }
    await commandCtx.reply({
      content: removed
        ? `Removed <#${target.id}> from the activity ignore list.`
        : `<#${target.id}> was not on the ignore list.`,
      sensitive: true,
    });
    return;
  }

  if (group === "ignore" && sub === "list") {
    const rows = listActivityIgnore(communityId);
    if (!rows.length) {
      await commandCtx.reply({
        content:
          "No ignored channels or categories. Honeypot channels are always skipped.",
        sensitive: true,
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
    await commandCtx.reply({
      content:
        `**Activity ignore list** (${rows.length})\n${lines.join("\n")}`.slice(
          0,
          2000,
        ),
      sensitive: true,
    });
    return;
  }

  if (sub === "status") {
    ensureGuildActivitySettings(communityId);
    const settings = getGuildActivitySettings(communityId);
    const stats = guildActivityStats(communityId);
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
    await commandCtx.reply({
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
      sensitive: true,
    });
    return;
  }

  if (group === "backfill" && sub === "cancel") {
    const result = cancelBackfill(guildId);
    if (result.cancelled) {
      recordSlashAudit({
        communityId,
        actorUserId: commandCtx.userId,
        action: "activity.backfill_cancel",
        targetType: "guild",
        targetId: guildId,
        details: { kind: result.kind ?? null },
      });
      await logConfigChange(outbound, guildId, {
        title: "Activity backfill cancel",
        command: "/activityconfig backfill cancel",
        actor: commandCtx.user,
        changes: [
          result.kind ? `Kind: **${result.kind}**` : "Kind: unknown",
          result.reason || "Cancelled",
        ],
      });
    }
    await commandCtx.reply({
      content: result.cancelled
        ? `**Backfill cancel**\n${result.reason || "Cancelled."}`
        : result.reason || "No backfill running.",
      sensitive: true,
    });
    return;
  }

  if (group === "backfill" && sub === "all") {
    // Guild backfill runs through the untouched Discord service
    // (src/features/userActivity/backfill.js needs a discord.js Guild;
    // roadmap § What stays Discord-only — the service cutover lands in a
    // later PR). The Guild comes from the documented rawInteraction escape
    // hatch; Fluxer contexts never carry one, so the Fluxer arm gets the
    // standard line.
    const raw = commandCtx.rawInteraction;
    const guild = raw?.guild ?? null;
    if (!guild) {
      await commandCtx.reply({
        content: raw
          ? "This command only works in a server."
          : "That command is not available on Fluxer yet.",
        sensitive: true,
      });
      return;
    }

    const maxPagesOpt = commandCtx.options.getInteger("max_pages");
    await commandCtx.defer({ sensitive: true });
    const result = await startGuildBackfill(guild, {
      maxPagesPerChannel: maxPagesOpt ?? undefined,
    });
    if (!result.started) {
      await commandCtx.editReply({
        content: result.reason || "Could not start guild backfill.",
      });
      return;
    }

    const pages = result.maxPagesPerChannel ?? 50;
    const approxMsgs = pages * 100;
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "activity.backfill_start",
      targetType: "guild",
      targetId: guildId,
      details: {
        channels: result.channels ?? null,
        max_pages: pages,
      },
    });
    await logConfigChange(outbound, guildId, {
      title: "Activity guild backfill started",
      command: "/activityconfig backfill all",
      actor: commandCtx.user,
      changes: [
        `Channels to scan: **${result.channels ?? "?"}**`,
        `Max pages/channel: **${pages}** (≈${approxMsgs} messages)`,
        "Single pass per channel · all human authors · rate-limited (~1.1s/page)",
      ],
    });

    await commandCtx.editReply({
      content:
        `**Guild backfill started** for **${result.channels ?? "?"}** channels.\n` +
        `Each channel is scanned once; every human author's pre-tracking messages are counted.\n` +
        `Cap: **${pages}** pages/channel (≈**${approxMsgs}** messages) · ≈1.1s per page.\n` +
        `Check progress with \`/activityconfig status\`.\n` +
        `_If a run stops as **partial**, re-run with a higher \`max_pages\` to continue from cursors._`,
    });
    return;
  }

  await commandCtx.reply({
    content: "Unknown subcommand.",
    sensitive: true,
  });
}

module.exports = {
  name: "userActivity",
  commands,
  handlers: {
    activityconfig: handleActivityConfig,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): the slash
  // handler receives a CommandContext.
  handlerApi: {
    activityconfig: "context",
  },
  recordUserChannelMessage,
  startUserBackfill,
  startGuildBackfill,
  cancelBackfill,
  getBackfillJobInfo,
};
