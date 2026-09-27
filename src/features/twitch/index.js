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
const { isStaff } = require("../../core/permissions");
const { replyDenied, replyEphemeral } = require("../../core/interaction");
const { logConfigChange } = require("../logs/auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");
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

async function handleTwitch(interaction, ctx) {
  const { client } = ctx;
  const guildId = interaction.guildId;

  if (!isStaff(interaction)) {
    await replyDenied(interaction);
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === "add") {
    const raw = interaction.options.getString("login", true);

    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
      await replyEphemeral(interaction, {
        content:
          "Twitch is not configured on this bot. Set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` first.",
      });
      return;
    }

    await interaction.deferReply({ flags: 64 });
    const login = normalizeTwitchLogin(raw);
    const user = await resolveTwitchUser(login);
    if (!user) {
      await interaction.editReply(
        `Could not find a Twitch channel for \`${login}\`. Check the login and try again.`,
      );
      return;
    }

    const existing = getTwitchChannel(guildId, user.login);
    if (existing) {
      await interaction.editReply(
        `**${user.display_name}** is already subscribed in this server.`,
      );
      return;
    }

    addTwitchChannel(
      guildId,
      user.id,
      user.login,
      user.display_name,
      user.profile_image_url,
    );

    // EventSub fast path (fire-and-forget; the hourly reconcile sweep is
    // the backstop, polling keeps working if this fails).
    syncBroadcaster(user.id).catch(() => {});

    recordSlashAudit({
      interaction,
      action: "twitch.channel_add",
      targetType: "twitch_channel",
      targetId: user.id,
      details: { login: user.login, display_name: user.display_name },
    });

    await logConfigChange(client, guildId, {
      title: "Twitch subscription added",
      command: "/twitch add",
      actor: interaction.user,
      changes: [
        `Channel: **${user.display_name}**`,
        `Login: \`${user.login}\``,
        `ID: \`${user.id}\``,
      ],
    }).catch(() => {});

    const settings = getGuildSettings(guildId);
    let replyMsg = `Subscribed to **${user.display_name}**. I'll notify when they go live.`;
    if (!settings.twitch_notification_channel_id) {
      replyMsg +=
        "\n\nNote: no notification channel set yet — run `/settwitch channel` to pick where go-live posts go.";
    }
    await interaction.editReply(replyMsg);
    return;
  }

  if (sub === "remove") {
    const raw = interaction.options.getString("channel", true);
    const found = getTwitchChannel(guildId, raw);
    if (!found) {
      await replyEphemeral(interaction, {
        content: "No matching subscription found.",
      });
      return;
    }

    removeTwitchChannel(guildId, found.login);
    // Drop the broadcaster's EventSub subscriptions if no guild still
    // tracks it (quota hygiene). Fire-and-forget; the sweep also prunes.
    pruneBroadcasterIfUntracked(found.broadcaster_id).catch(() => {});
    recordSlashAudit({
      interaction,
      action: "twitch.channel_remove",
      targetType: "twitch_channel",
      targetId: found.broadcaster_id,
      details: { login: found.login, display_name: found.display_name },
    });
    await logConfigChange(client, guildId, {
      title: "Twitch subscription removed",
      command: "/twitch remove",
      actor: interaction.user,
      changes: [
        `Channel: **${found.display_name}**`,
        `Login: \`${found.login}\``,
      ],
    }).catch(() => {});

    await replyEphemeral(interaction, {
      content: `Unsubscribed from **${found.display_name}**.`,
    });
    return;
  }

  if (sub === "list") {
    const channels = getTwitchChannels(guildId);
    const settings = getGuildSettings(guildId);
    const notifyChannel = settings.twitch_notification_channel_id
      ? `<#${settings.twitch_notification_channel_id}>`
      : "_Not configured_";
    const notifyRole = settings.twitch_notify_role_id
      ? `<@&${settings.twitch_notify_role_id}>`
      : "_None_";

    if (!channels.length) {
      await replyEphemeral(interaction, {
        content: "No Twitch channels subscribed.",
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

    await replyEphemeral(interaction, {
      content:
        `**Twitch subscriptions** (${channels.length})\n` +
        `Notification channel: ${notifyChannel}\n` +
        `Ping role: ${notifyRole}\n\n` +
        lines.join("\n") +
        `\n\n_Toggle clip/VOD alerts with \`/twitch clips\` / \`/twitch vod\`._`,
    });
    return;
  }

  if (sub === "clips" || sub === "vod") {
    const raw = interaction.options.getString("channel", true);
    const enabled = interaction.options.getBoolean("enabled", true);
    const found = getTwitchChannel(guildId, raw);
    if (!found) {
      await replyEphemeral(interaction, {
        content: "No matching subscription found.",
      });
      return;
    }

    const isClips = sub === "clips";
    const updated = setTwitchChannelMediaFlags(
      guildId,
      found.broadcaster_id,
      {
        notifyClips: isClips ? enabled : !!found.notify_clips,
        notifyVods: isClips ? !!found.notify_vods : enabled,
      },
    );
    if (!updated) {
      await replyEphemeral(interaction, {
        content: "No matching subscription found.",
      });
      return;
    }

    const label = isClips ? "clips" : "VODs";
    recordSlashAudit({
      interaction,
      action: isClips ? "twitch.clips_toggle" : "twitch.vod_toggle",
      targetType: "twitch_channel",
      targetId: found.broadcaster_id,
      details: { login: found.login, enabled },
    });
    await logConfigChange(client, guildId, {
      title: `Twitch ${label} notifications ${enabled ? "enabled" : "disabled"}`,
      command: `/twitch ${sub}`,
      actor: interaction.user,
      changes: [
        `Channel: **${found.display_name}**`,
        `${isClips ? "Clips" : "VODs"}: → **${enabled ? "on" : "off"}**`,
      ],
    }).catch(() => {});

    const settings = getGuildSettings(guildId);
    let msg;
    if (enabled) {
      msg = `I'll announce new **${label}** from **${found.display_name}**`;
      msg += settings.twitch_notification_channel_id
        ? ` to <#${settings.twitch_notification_channel_id}>. Only ${label} published AFTER now are announced.`
        : " — but no notification channel is set yet; run `/settwitch channel`.";
    } else {
      msg = `Stopped announcing new **${label}** from **${found.display_name}**.`;
    }
    await replyEphemeral(interaction, { content: msg });
    return;
  }
}

async function handleSetTwitch(interaction, ctx) {
  const { client } = ctx;
  const guildId = interaction.guildId;
  const settings = getGuildSettings(guildId);

  if (!isStaff(interaction)) {
    await replyDenied(interaction);
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === "channel") {
    const ch = interaction.options.getChannel("channel", true);
    const before = settings.twitch_notification_channel_id;
    updateGuildSettings(guildId, { twitch_notification_channel_id: ch.id });
    recordSlashAudit({
      interaction,
      action: "twitch.notify_channel_set",
      targetType: "channel",
      targetId: ch.id,
      details: { previous_channel_id: before ?? null },
    });
    await logConfigChange(client, guildId, {
      title: "Twitch notification channel set",
      command: "/settwitch channel",
      actor: interaction.user,
      changes: [
        before
          ? `Channel: <#${before}> → <#${ch.id}>`
          : `Channel: *none* → <#${ch.id}>`,
      ],
    }).catch(() => {});

    await replyEphemeral(interaction, {
      content: `Twitch go-live notifications will be sent to <#${ch.id}>.`,
    });
    return;
  }

  if (sub === "role") {
    const role = interaction.options.getRole("role", false);
    const before = settings.twitch_notify_role_id;
    updateGuildSettings(guildId, {
      twitch_notify_role_id: role ? role.id : null,
    });
    recordSlashAudit({
      interaction,
      action: "twitch.notify_role_set",
      targetType: "role",
      targetId: role ? role.id : guildId,
      details: { role_id: role ? role.id : null, previous_role_id: before ?? null },
    });
    const beforeLabel = before ? `<@&${before}>` : "*none*";
    const afterLabel = role ? `<@&${role.id}>` : "*none*";
    await logConfigChange(client, guildId, {
      title: "Twitch mention role set",
      command: "/settwitch role",
      actor: interaction.user,
      changes: [`Role: ${beforeLabel} → ${afterLabel}`],
    }).catch(() => {});

    await replyEphemeral(interaction, {
      content: role
        ? `Go-live notifications will mention <@&${role.id}>.`
        : `Go-live notifications will no longer mention a role.`,
    });
    return;
  }

  if (sub === "interval") {
    const minutes = interaction.options.getInteger("minutes", true);
    const before = settings.twitch_polling_interval_minutes;
    updateGuildSettings(guildId, { twitch_polling_interval_minutes: minutes });
    recordSlashAudit({
      interaction,
      action: "twitch.polling_interval_set",
      targetType: "guild",
      targetId: guildId,
      details: { previous_minutes: before ?? null, minutes },
    });
    await logConfigChange(client, guildId, {
      title: "Twitch polling interval set",
      command: "/settwitch interval",
      actor: interaction.user,
      changes: [`Interval: ${before} → **${minutes}** minute(s)`],
    }).catch(() => {});

    await replyEphemeral(interaction, {
      content: `Twitch polling interval set to **${minutes}** minute(s).`,
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

    await replyEphemeral(interaction, {
      content:
        `**Twitch notification settings**\n` +
        `Bot credentials: ${configured ? "configured" : "not configured"}\n` +
        eventsubLine +
        `Notification channel: ${notifyChannel}\n` +
        `Ping role: ${notifyRole}\n` +
        `Polling interval: **${settings.twitch_polling_interval_minutes}** minute(s)\n` +
        `Subscriptions: **${getTwitchChannels(guildId).length}**`,
    });
    return;
  }
}

async function handleTwitchAutocomplete(interaction) {
  if (!interaction.guild) {
    await interaction.respond([]);
    return;
  }
  const guildId = interaction.guild.id;
  const channels = getTwitchChannels(guildId);
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

function start(client) {
  startTwitchTicker(client);
  startEventsub();
}

module.exports = {
  name: "twitch",
  commands,
  handlers: {
    twitch: handleTwitch,
    settwitch: handleSetTwitch,
  },
  autocomplete: {
    twitch: handleTwitchAutocomplete,
  },
  start,
};
