const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const {
  getGuildSettings,
  updateGuildSettings,
  getTwitchChannels,
  getTwitchChannel,
  addTwitchChannel,
  removeTwitchChannel,
  normalizeTwitchLogin,
  setTwitchChannelMediaFlags,
  getTwitchEventsubSubs,
} = require("../../db");
const { requireStaffFromContext } = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");
const { discordCommunityId } = require("../../platform/community");
const { resolveTwitchUser } = require("./helix");
const { startTwitchTicker } = require("./ticker");
const {
  startEventsub,
  getEventsubConfig,
} = require("./eventsub");
const {
  syncBroadcaster,
  pruneBroadcasterIfUntracked,
} = require("./eventsub/subscriptions");

const staffPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName("twitch")
    .setDescription("Manage Twitch channel subscriptions (staff).")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommand((sc) =>
      sc
        .setName("add")
        .setDescription("Subscribe to a Twitch channel.")
        .addStringOption((opt) =>
          opt
            .setName("login")
            .setDescription("Twitch login, URL, or user id")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) => {
      const sub = sc
        .setName("remove")
        .setDescription("Unsubscribe from a Twitch channel.");
      sub.addStringOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Twitch channel to unsubscribe from")
          .setRequired(true)
          .setAutocomplete(true),
      );
      return sub;
    })
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("List all subscribed channels."),
    )
    .addSubcommand((sc) => {
      const sub = sc
        .setName("clips")
        .setDescription(
          "Toggle new-clip notifications for a subscribed channel (staff).",
        );
      sub.addStringOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Twitch channel")
          .setRequired(true)
          .setAutocomplete(true),
      );
      sub.addBooleanOption((opt) =>
        opt
          .setName("enabled")
          .setDescription("Notify when new clips are posted")
          .setRequired(true),
      );
      return sub;
    })
    .addSubcommand((sc) => {
      const sub = sc
        .setName("vod")
        .setDescription(
          "Toggle new-VOD (past-broadcast) notifications for a channel (staff).",
        );
      sub.addStringOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Twitch channel")
          .setRequired(true)
          .setAutocomplete(true),
      );
      sub.addBooleanOption((opt) =>
        opt
          .setName("enabled")
          .setDescription("Notify when new VODs are published")
          .setRequired(true),
      );
      return sub;
    }),

  new SlashCommandBuilder()
    .setName("settwitch")
    .setDescription("Configure Twitch notification settings (staff).")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommand((sc) => {
      const sub = sc
        .setName("channel")
        .setDescription("Set channel for Twitch go-live notifications.");
      sub.addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Channel to send notifications to")
          .setRequired(true),
      );
      return sub;
    })
    .addSubcommand((sc) => {
      const sub = sc
        .setName("role")
        .setDescription("Set role to mention on go-live.");
      sub.addRoleOption((opt) =>
        opt
          .setName("role")
          .setDescription("Role to mention (leave empty to disable pings)")
          .setRequired(false),
      );
      return sub;
    })
    .addSubcommand((sc) => {
      const sub = sc
        .setName("interval")
        .setDescription("Set polling interval.");
      sub.addIntegerOption((opt) =>
        opt
          .setName("minutes")
          .setDescription("Polling interval in minutes (1-60)")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(60),
      );
      return sub;
    })
    .addSubcommand((sc) =>
      sc
        .setName("settings")
        .setDescription("Show current Twitch notification settings."),
    ),
];

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleTwitch(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireStaffFromContext(commandCtx))) return;

  // Repository key: integer community id (resolved by the context builder).
  const communityId = commandCtx.communityId;
  // Display/audit key: the external (Discord) snowflake.
  const guildId = commandCtx.externalGuildId;

  const sub = commandCtx.subcommand;

  if (sub === "add") {
    const raw = commandCtx.options.getString("login", true);

    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
      await commandCtx.reply({
        content:
          "Twitch is not configured on this bot. Set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` first.",
        sensitive: true,
      });
      return;
    }

    await commandCtx.defer({ sensitive: true });
    const login = normalizeTwitchLogin(raw);
    const user = await resolveTwitchUser(login);
    if (!user) {
      await commandCtx.editReply(
        `Could not find a Twitch channel for \`${login}\`. Check the login and try again.`,
      );
      return;
    }

    const existing = getTwitchChannel(communityId, user.login);
    if (existing) {
      await commandCtx.editReply(
        `**${user.display_name}** is already subscribed in this server.`,
      );
      return;
    }

    addTwitchChannel(
      communityId,
      user.id,
      user.login,
      user.display_name,
      user.profile_image_url,
    );

    // EventSub fast path (fire-and-forget; the hourly reconcile sweep is
    // the backstop, polling keeps working if this fails).
    syncBroadcaster(user.id).catch(() => {});

    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "twitch.channel_add",
      targetType: "twitch_channel",
      targetId: user.id,
      details: { login: user.login, display_name: user.display_name },
    });

    await logConfigChange(commandCtx.outbound, guildId, {
      title: "Twitch subscription added",
      command: "/twitch add",
      actor: commandCtx.user,
      changes: [
        `Channel: **${user.display_name}**`,
        `Login: \`${user.login}\``,
        `ID: \`${user.id}\``,
      ],
    }).catch(() => {});

    const settings = getGuildSettings(communityId);
    let replyMsg = `Subscribed to **${user.display_name}**. I'll notify when they go live.`;
    if (!settings.twitch_notification_channel_id) {
      replyMsg +=
        "\n\nNote: no notification channel set yet — run `/settwitch channel` to pick where go-live posts go.";
    }
    await commandCtx.editReply(replyMsg);
    return;
  }

  if (sub === "remove") {
    const raw = commandCtx.options.getString("channel", true);
    const found = getTwitchChannel(communityId, raw);
    if (!found) {
      await commandCtx.reply({
        content: "No matching subscription found.",
        sensitive: true,
      });
      return;
    }

    removeTwitchChannel(communityId, found.login);
    // Drop the broadcaster's EventSub subscriptions if no guild still
    // tracks it (quota hygiene). Fire-and-forget; the sweep also prunes.
    pruneBroadcasterIfUntracked(found.broadcaster_id).catch(() => {});
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "twitch.channel_remove",
      targetType: "twitch_channel",
      targetId: found.broadcaster_id,
      details: { login: found.login, display_name: found.display_name },
    });
    await logConfigChange(commandCtx.outbound, guildId, {
      title: "Twitch subscription removed",
      command: "/twitch remove",
      actor: commandCtx.user,
      changes: [
        `Channel: **${found.display_name}**`,
        `Login: \`${found.login}\``,
      ],
    }).catch(() => {});

    await commandCtx.reply({
      content: `Unsubscribed from **${found.display_name}**.`,
      sensitive: true,
    });
    return;
  }

  if (sub === "list") {
    const channels = getTwitchChannels(communityId);
    const settings = getGuildSettings(communityId);
    const notifyChannel = settings.twitch_notification_channel_id
      ? `<#${settings.twitch_notification_channel_id}>`
      : "_Not configured_";
    const notifyRole = settings.twitch_notify_role_id
      ? `<@&${settings.twitch_notify_role_id}>`
      : "_None_";

    if (!channels.length) {
      await commandCtx.reply({
        content: "No Twitch channels subscribed.",
        sensitive: true,
      });
      return;
    }

    const lines = channels.map((c) => {
      const live = c.is_live ? " — **LIVE**" : "";
      const flags = [
        c.notify_clips ? "clips" : null,
        c.notify_vods ? "vods" : null,
      ].filter(Boolean);
      const flagText = flags.length ? ` _(${flags.join(" + ")})_` : "";
      return `• **${c.display_name}** (\`${c.login}\`)${live}${flagText}`;
    });

    await commandCtx.reply({
      content:
        `**Twitch subscriptions** (${channels.length})\n` +
        `Notification channel: ${notifyChannel}\n` +
        `Ping role: ${notifyRole}\n\n` +
        lines.join("\n") +
        `\n\n_Toggle clip/VOD alerts with \`/twitch clips\` / \`/twitch vod\`._`,
      sensitive: true,
    });
    return;
  }

  if (sub === "clips" || sub === "vod") {
    const raw = commandCtx.options.getString("channel", true);
    const enabled = commandCtx.options.getBoolean("enabled", true);
    const found = getTwitchChannel(communityId, raw);
    if (!found) {
      await commandCtx.reply({
        content: "No matching subscription found.",
        sensitive: true,
      });
      return;
    }

    const isClips = sub === "clips";
    const updated = setTwitchChannelMediaFlags(
      communityId,
      found.broadcaster_id,
      {
        notifyClips: isClips ? enabled : !!found.notify_clips,
        notifyVods: isClips ? !!found.notify_vods : enabled,
      },
    );
    if (!updated) {
      await commandCtx.reply({
        content: "No matching subscription found.",
        sensitive: true,
      });
      return;
    }

    const label = isClips ? "clips" : "VODs";
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: isClips ? "twitch.clips_toggle" : "twitch.vod_toggle",
      targetType: "twitch_channel",
      targetId: found.broadcaster_id,
      details: { login: found.login, enabled },
    });
    await logConfigChange(commandCtx.outbound, guildId, {
      title: `Twitch ${label} notifications ${enabled ? "enabled" : "disabled"}`,
      command: `/twitch ${sub}`,
      actor: commandCtx.user,
      changes: [
        `Channel: **${found.display_name}**`,
        `${isClips ? "Clips" : "VODs"}: → **${enabled ? "on" : "off"}**`,
      ],
    }).catch(() => {});

    const settings = getGuildSettings(communityId);
    let msg;
    if (enabled) {
      msg = `I'll announce new **${label}** from **${found.display_name}**`;
      msg += settings.twitch_notification_channel_id
        ? ` to <#${settings.twitch_notification_channel_id}>. Only ${label} published AFTER now are announced.`
        : " — but no notification channel is set yet; run `/settwitch channel`.";
    } else {
      msg = `Stopped announcing new **${label}** from **${found.display_name}**.`;
    }
    await commandCtx.reply({ content: msg, sensitive: true });
    return;
  }
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleSetTwitch(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireStaffFromContext(commandCtx))) return;

  const communityId = commandCtx.communityId;
  const guildId = commandCtx.externalGuildId;
  const settings = getGuildSettings(communityId);

  const sub = commandCtx.subcommand;

  if (sub === "channel") {
    const ch = commandCtx.options.getChannel("channel", true);
    const before = settings.twitch_notification_channel_id;
    updateGuildSettings(communityId, { twitch_notification_channel_id: ch.id });
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "twitch.notify_channel_set",
      targetType: "channel",
      targetId: ch.id,
      details: { previous_channel_id: before ?? null },
    });
    await logConfigChange(commandCtx.outbound, guildId, {
      title: "Twitch notification channel set",
      command: "/settwitch channel",
      actor: commandCtx.user,
      changes: [
        before
          ? `Channel: <#${before}> → <#${ch.id}>`
          : `Channel: *none* → <#${ch.id}>`,
      ],
    }).catch(() => {});

    await commandCtx.reply({
      content: `Twitch go-live notifications will be sent to <#${ch.id}>.`,
      sensitive: true,
    });
    return;
  }

  if (sub === "role") {
    const role = commandCtx.options.getRole("role", false);
    const before = settings.twitch_notify_role_id;
    updateGuildSettings(communityId, {
      twitch_notify_role_id: role ? role.id : null,
    });
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "twitch.notify_role_set",
      targetType: "role",
      targetId: role ? role.id : guildId,
      details: { role_id: role ? role.id : null, previous_role_id: before ?? null },
    });
    const beforeLabel = before ? `<@&${before}>` : "*none*";
    const afterLabel = role ? `<@&${role.id}>` : "*none*";
    await logConfigChange(commandCtx.outbound, guildId, {
      title: "Twitch mention role set",
      command: "/settwitch role",
      actor: commandCtx.user,
      changes: [`Role: ${beforeLabel} → ${afterLabel}`],
    }).catch(() => {});

    await commandCtx.reply({
      content: role
        ? `Go-live notifications will mention <@&${role.id}>.`
        : `Go-live notifications will no longer mention a role.`,
      sensitive: true,
    });
    return;
  }

  if (sub === "interval") {
    const minutes = commandCtx.options.getInteger("minutes", true);
    const before = settings.twitch_polling_interval_minutes;
    updateGuildSettings(communityId, { twitch_polling_interval_minutes: minutes });
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "twitch.polling_interval_set",
      targetType: "guild",
      targetId: guildId,
      details: { previous_minutes: before ?? null, minutes },
    });
    await logConfigChange(commandCtx.outbound, guildId, {
      title: "Twitch polling interval set",
      command: "/settwitch interval",
      actor: commandCtx.user,
      changes: [`Interval: ${before} → **${minutes}** minute(s)`],
    }).catch(() => {});

    await commandCtx.reply({
      content: `Twitch polling interval set to **${minutes}** minute(s).`,
      sensitive: true,
    });
    return;
  }

  if (sub === "settings") {
    const notifyChannel = settings.twitch_notification_channel_id
      ? `<#${settings.twitch_notification_channel_id}>`
      : "_Not configured_";
    const notifyRole = settings.twitch_notify_role_id
      ? `<@&${settings.twitch_notify_role_id}>`
      : "_None_";
    const configured =
      !!process.env.TWITCH_CLIENT_ID && !!process.env.TWITCH_CLIENT_SECRET;

    let eventsubLine = "";
    try {
      const esCfg = getEventsubConfig();
      const tracked = getTwitchEventsubSubs().length;
      eventsubLine = esCfg.enabled
        ? `EventSub fast path: **enabled** (${tracked} tracked subscription(s))\n`
        : `EventSub fast path: disabled (missing ${esCfg.missing.join(", ")})\n`;
    } catch {
      // settings stays renderable even if the config resolver misbehaves
    }

    await commandCtx.reply({
      content:
        `**Twitch notification settings**\n` +
        `Bot credentials: ${configured ? "configured" : "not configured"}\n` +
        eventsubLine +
        `Notification channel: ${notifyChannel}\n` +
        `Ping role: ${notifyRole}\n` +
        `Polling interval: **${settings.twitch_polling_interval_minutes}** minute(s)\n` +
        `Subscriptions: **${getTwitchChannels(communityId).length}**`,
      sensitive: true,
    });
    return;
  }
}

async function handleTwitchAutocomplete(interaction) {
  if (!interaction.guild) {
    await interaction.respond([]);
    return;
  }
  const communityId = discordCommunityId(interaction.guild.id);
  if (communityId == null) {
    await interaction.respond([]);
    return;
  }
  const channels = getTwitchChannels(communityId);
  const focused = (interaction.options.getFocused() || "").toLowerCase();

  const filtered = channels
    .filter(
      (c) =>
        c.login.toLowerCase().includes(focused) ||
        c.display_name.toLowerCase().includes(focused),
    )
    .slice(0, 25);

  await interaction.respond(
    filtered.map((c) => ({
      name: c.display_name,
      value: c.login,
    })),
  );
}

/**
 * @param {object|null} supervisor PR 7 supervisor ({discord, fluxer, clientForCommunity})
 * @param {object} [featureCtx]
 */
function start(supervisor, featureCtx) {
  void featureCtx;
  // The EventSub fast path resolves its Discord client through its own
  // getClient accessor (web wiring); the poller routes per community via
  // supervisor.clientForCommunity (roadmap/fluxer.md § Scheduler jobs).
  startTwitchTicker(supervisor);
  startEventsub();
}

module.exports = {
  name: "twitch",
  commands,
  handlers: {
    twitch: handleTwitch,
    settwitch: handleSetTwitch,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): these slash
  // handlers receive a CommandContext. Autocomplete stays on the interaction arm.
  handlerApi: {
    twitch: "context",
    settwitch: "context",
  },
  autocomplete: {
    twitch: handleTwitchAutocomplete,
  },
  start,
};
