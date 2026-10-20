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
  setTwitchChannelNotifyTargets,
  getTwitchEventsubSubs,
} = require("../../db");
const { requireStaffFromContext } = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");
const { joinCapped } = require("../../core/text");
const { discordCommunityId } = require("../../platform/community");
const { resolveTwitchUser } = require("./helix");
const { resolveTwitchNotifyTargets, startTwitchTicker } = require("./ticker");
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
    })
    .addSubcommand((sc) => {
      // Issue #177: per-subscription notification-target overrides.
      const sub = sc
        .setName("notify")
        .setDescription(
          "Override where one Twitch channel's notifications post (staff).",
        );
      sub.addStringOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Twitch channel")
          .setRequired(true)
          .setAutocomplete(true),
      );
      sub.addChannelOption((opt) =>
        opt
          .setName("discord_channel")
          .setDescription("Post this sub's notifications here instead")
          .setRequired(false),
      );
      sub.addRoleOption((opt) =>
        opt
          .setName("role")
          .setDescription("Mention this role on this sub's go-lives instead")
          .setRequired(false),
      );
      sub.addBooleanOption((opt) =>
        opt
          .setName("clear")
          .setDescription("Remove the overrides (use the guild defaults again)")
          .setRequired(false),
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
      // Issue #177: per-subscription notification overrides surface right on
      // the row, so an admin can see where a sub's posts actually go.
      const overrides = [
        c.notify_channel_id ? `→ <#${c.notify_channel_id}>` : null,
        c.notify_role_id ? `ping <@&${c.notify_role_id}>` : null,
      ].filter(Boolean);
      const overrideText = overrides.length
        ? ` _[${overrides.join(", ")}]_`
        : "";
      return `• **${c.display_name}** (\`${c.login}\`)${live}${flagText}${overrideText}`;
    });

    // 2000-char message cap with an honest hidden count; the footer is
    // fixed so its length comes off the budget too (#446).
    const header =
      `**Twitch subscriptions** (${channels.length})\n` +
      `Notification channel: ${notifyChannel}\n` +
      `Ping role: ${notifyRole}\n\n`;
    const footer =
      "\n\n_Toggle clip/VOD alerts with `/twitch clips` / `/twitch vod`; " +
      "route a single channel elsewhere with `/twitch notify`._";
    await commandCtx.reply({
      content:
        header + joinCapped(lines, 2000 - header.length - footer.length, "\n") + footer,
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

  if (sub === "notify") {
    // Per-subscription notification-target overrides (issue #177): the
    // override wins when set; NULL falls back to the guild-wide pair set
    // by /settwitch. Channel routing applies to every notification this sub
    // posts (go-live, clips, VODs); the role override only affects go-live
    // pings (media alerts never mention a role).
    const raw = commandCtx.options.getString("channel", true);
    const clear = commandCtx.options.getBoolean("clear") === true;
    const ch = commandCtx.options.getChannel("discord_channel", false);
    const role = commandCtx.options.getRole("role", false);
    const found = getTwitchChannel(communityId, raw);
    if (!found) {
      await commandCtx.reply({
        content: "No matching subscription found.",
        sensitive: true,
      });
      return;
    }

    if (clear && (ch || role)) {
      await commandCtx.reply({
        content:
          "`clear:true` removes the overrides on its own — drop `discord_channel`/`role` (or omit `clear`).",
        sensitive: true,
      });
      return;
    }
    if (!clear && !ch && !role) {
      await commandCtx.reply({
        content:
          "Provide a `discord_channel` and/or `role` to override for this channel, or `clear:true` to remove the overrides.",
        sensitive: true,
      });
      return;
    }

    // Validate the picker against the guild before storing (PR 4 recipe 8,
    // same as /setcommandchannel): an unresolvable channel would silently
    // black-hole every notification for this sub.
    if (ch) {
      const channelHandle = await commandCtx.outbound.fetchChannel(
        communityId,
        ch.id,
      );
      if (!channelHandle) {
        await commandCtx.reply({
          content:
            `I couldn't find <#${ch.id}> (\`${ch.id}\`) in this server — ` +
            "pick a channel from the picker and make sure the bot can view it.",
          sensitive: true,
        });
        return;
      }
    }

    const targets = clear
      ? { channelId: null, roleId: null }
      : {
          // undefined = leave that override untouched (repo contract)
          channelId: ch ? ch.id : undefined,
          roleId: role ? role.id : undefined,
        };
    const updated = setTwitchChannelNotifyTargets(
      communityId,
      found.broadcaster_id,
      targets,
    );
    if (!updated) {
      await commandCtx.reply({
        content: "No matching subscription found.",
        sensitive: true,
      });
      return;
    }

    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: clear ? "twitch.notify_override_clear" : "twitch.notify_override_set",
      targetType: "twitch_channel",
      targetId: found.broadcaster_id,
      details: {
        login: found.login,
        channel_id: clear ? null : targets.channelId ?? null,
        role_id: clear ? null : targets.roleId ?? null,
        previous_channel_id: found.notify_channel_id ?? null,
        previous_role_id: found.notify_role_id ?? null,
      },
    });

    const label = (v, kind) =>
      v ? (kind === "channel" ? `<#${v}>` : `<@&${v}>`) : "*guild default*";
    const changes = [`Channel: **${found.display_name}**`];
    if (clear) {
      if (found.notify_channel_id) {
        changes.push(
          `Notify channel: ${label(found.notify_channel_id, "channel")} → *guild default*`,
        );
      }
      if (found.notify_role_id) {
        changes.push(
          `Ping role: ${label(found.notify_role_id, "role")} → *guild default*`,
        );
      }
      if (changes.length === 1) changes.push("Nothing was overridden (noop).");
    } else {
      if (targets.channelId !== undefined) {
        changes.push(
          `Notify channel: ${label(found.notify_channel_id, "channel")} → ${label(
            updated.notify_channel_id,
            "channel",
          )}`,
        );
      }
      if (targets.roleId !== undefined) {
        changes.push(
          `Ping role: ${label(found.notify_role_id, "role")} → ${label(
            updated.notify_role_id,
            "role",
          )}`,
        );
      }
    }
    await logConfigChange(commandCtx.outbound, guildId, {
      title: clear
        ? "Twitch per-channel overrides cleared"
        : "Twitch per-channel overrides updated",
      command: "/twitch notify",
      actor: commandCtx.user,
      changes,
    }).catch(() => {});

    // Effective target of record (overrides resolved against guild defaults).
    const effective = resolveTwitchNotifyTargets(
      updated,
      getGuildSettings(communityId),
    );
    const parts = [];
    parts.push(
      `Notify channel: ${
        updated.notify_channel_id
          ? `<#${updated.notify_channel_id}> _(this sub)_`
          : `<#${effective.channelId}> _(guild default)_`
      }`,
    );
    parts.push(
      `Ping role (go-live): ${
        updated.notify_role_id
          ? `<@&${updated.notify_role_id}> _(this sub)_`
          : effective.roleId
            ? `<@&${effective.roleId}> _(guild default)_`
            : "_none_"
      }`,
    );
    await commandCtx.reply({
      content:
        (clear
          ? `Overrides for **${found.display_name}** cleared — notifications use the guild defaults again.`
          : `Notifications for **${found.display_name}**:`) +
        "\n" +
        parts.join("\n"),
      sensitive: true,
    });
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
