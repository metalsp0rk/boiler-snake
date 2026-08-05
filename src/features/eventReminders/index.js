/**
 * Scheduled event reminders feature.
 *
 * Slash: /eventreminder …
 * Modal custom ids: er:create:<eventId> | er:edit:<eventId>
 */

const {
  SlashCommandBuilder,
  MessageFlags,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  GuildScheduledEventStatus,
  Events,
} = require("discord.js");
const {
  getGuildSettings,
  updateGuildSettings,
  createEventReminderConfig,
  updateEventReminderConfig,
  getConfigByScheduledEventId,
  getAnyConfigByScheduledEventId,
  getConfigByShortname,
  listEventReminderConfigs,
  isEventReminderOptedOut,
  setEventReminderOptOut,
  clearEventReminderOptOut,
  listActiveEventReminderRoleIds,
} = require("../../db");
const { isStaff, isAdminOrMod } = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");
const {
  OFFSET_PRESETS,
  DEFAULT_PRESET_MINUTES,
  DEFAULT_MESSAGE,
  ROLE_PREFIX,
  slugifyShortname,
  normalizeShortname,
  resolveOffsetMinutes,
  buildOffsetRows,
  formatOffsetMinutes,
  canConfigureEventReminder,
  resolveNotifyChannelId,
  createReminderRole,
  syncEventReminderRole,
  grantRoleIfEligible,
  removeRoleSafe,
  stripAllEventReminderRoles,
  cleanupEventReminder,
  isEventTerminal,
  eventStartMs,
  rescheduleUnsentOffsets,
  fetchInterestedUserIds,
} = require("./service");
const { startEventReminderTicker } = require("./ticker");

const MODAL_PREFIX_CREATE = "er:create:";
const MODAL_PREFIX_EDIT = "er:edit:";

const commands = [
  new SlashCommandBuilder()
    .setName("eventreminder")
    .setDescription("Configure and manage scheduled event reminders.")
    .addSubcommand((sc) =>
      sc
        .setName("create")
        .setDescription("Link reminders to a Discord scheduled event.")
        .addStringOption((opt) =>
          opt
            .setName("event")
            .setDescription("Scheduled event")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("edit")
        .setDescription("Edit reminder settings for a linked event.")
        .addStringOption((opt) =>
          opt
            .setName("event")
            .setDescription("Linked scheduled event")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("List active event reminder configs.")
    )
    .addSubcommand((sc) =>
      sc
        .setName("clear")
        .setDescription("Stop reminders and delete the event role.")
        .addStringOption((opt) =>
          opt
            .setName("event")
            .setDescription("Linked scheduled event")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("sync")
        .setDescription("Re-sync interested users to the event role.")
        .addStringOption((opt) =>
          opt
            .setName("event")
            .setDescription("Linked scheduled event")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("setchannel")
        .setDescription("Set the default channel for reminder posts (Manage Guild).")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Default notify channel (omit to clear)")
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("optout")
        .setDescription("Opt out of all event reminder pings in this server.")
    )
    .addSubcommand((sc) =>
      sc
        .setName("optin")
        .setDescription("Re-enable event reminder pings in this server.")
    )
    .addSubcommand((sc) =>
      sc
        .setName("status")
        .setDescription("Show your event reminder opt-out status and roles.")
    ),
];

/**
 * @param {import("discord.js").Guild} guild
 * @param {string} eventId
 */
async function fetchScheduledEvent(guild, eventId) {
  if (!guild?.scheduledEvents) return null;
  return (
    guild.scheduledEvents.cache.get(eventId) ||
    (await guild.scheduledEvents.fetch(eventId).catch(() => null))
  );
}

/**
 * @param {import("discord.js").Guild} guild
 * @returns {Promise<import("discord.js").Collection<string, import("discord.js").GuildScheduledEvent>>}
 */
async function listScheduledEvents(guild) {
  if (!guild?.scheduledEvents) return new Map();
  try {
    const fetched = await guild.scheduledEvents.fetch();
    return fetched;
  } catch {
    return guild.scheduledEvents.cache || new Map();
  }
}

/**
 * @param {string} name
 */
function modalTitle(name) {
  const base = `Reminders: ${name || "event"}`;
  return base.length <= 45 ? base : `${base.slice(0, 42)}...`;
}

/**
 * @param {object} opts
 * @param {"create"|"edit"} opts.mode
 * @param {string} opts.eventId
 * @param {string} opts.eventName
 * @param {string} [opts.shortname]
 * @param {number[]} [opts.selectedMinutes]
 * @param {string} [opts.message]
 */
function buildReminderModal(opts) {
  const customId =
    opts.mode === "edit"
      ? `${MODAL_PREFIX_EDIT}${opts.eventId}`
      : `${MODAL_PREFIX_CREATE}${opts.eventId}`;

  const shortnameDefault =
    opts.shortname || slugifyShortname(opts.eventName);
  const selected = new Set(
    opts.selectedMinutes?.length
      ? opts.selectedMinutes
      : [...DEFAULT_PRESET_MINUTES]
  );

  const shortnameInput = new TextInputBuilder()
    .setCustomId("shortname")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(80)
    .setValue(shortnameDefault.slice(0, 80));

  const offsetSelect = new StringSelectMenuBuilder()
    .setCustomId("offsets")
    .setPlaceholder("When to remind (before start)")
    .setMinValues(1)
    .setMaxValues(OFFSET_PRESETS.length)
    .addOptions(
      OFFSET_PRESETS.map((p) => ({
        label: p.label,
        value: String(p.minutes),
        default: selected.has(p.minutes),
      }))
    );

  const customOffsets = new TextInputBuilder()
    .setCustomId("offsets_custom")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("e.g. 2h, 10m")
    .setMaxLength(80);

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId("channel")
    .setPlaceholder("Notify channel override (optional)")
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(1)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

  const messageInput = new TextInputBuilder()
    .setCustomId("message")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500)
    .setPlaceholder(DEFAULT_MESSAGE.slice(0, 100));
  if (opts.message) {
    messageInput.setValue(String(opts.message).slice(0, 500));
  }

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(modalTitle(opts.eventName))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Shortname (role: event-<shortname>)")
        .setTextInputComponent(shortnameInput),
      new LabelBuilder()
        .setLabel("Reminder offsets")
        .setDescription("Default: 1 day, 1 hour, 15 min")
        .setStringSelectMenuComponent(offsetSelect),
      new LabelBuilder()
        .setLabel("Extra custom offsets (optional)")
        .setDescription("Grammar: 5m, 2h, 1d — comma-separated")
        .setTextInputComponent(customOffsets),
      new LabelBuilder()
        .setLabel("Notify channel override (optional)")
        .setDescription("Leave empty to use the guild default")
        .setChannelSelectMenuComponent(channelSelect),
      new LabelBuilder()
        .setLabel("Custom message (optional)")
        .setDescription(
          "Placeholders: {event} {location} {starts_in} {starts_at} {role}"
        )
        .setTextInputComponent(messageInput)
    );
}

async function handleEventReminder(interaction, ctx) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "This command only works in a server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "optout") return handleOptOut(interaction);
  if (sub === "optin") return handleOptIn(interaction, ctx);
  if (sub === "status") return handleStatus(interaction);
  if (sub === "setchannel") return handleSetChannel(interaction);
  if (sub === "list") return handleList(interaction);
  if (sub === "create") return handleCreate(interaction);
  if (sub === "edit") return handleEdit(interaction);
  if (sub === "clear") return handleClear(interaction);
  if (sub === "sync") return handleSync(interaction);

  await interaction.reply({
    content: `Unknown subcommand: \`${sub}\``,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSetChannel(interaction) {
  if (!isAdminOrMod(interaction)) {
    await interaction.reply({
      content: "You need **Manage Guild** to set the default reminder channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.options.getChannel("channel");
  const channelId = channel?.id ?? null;
  updateGuildSettings(interaction.guildId, {
    event_reminder_channel_id: channelId,
  });

  await logConfigChange(interaction.client, interaction.guildId, {
    title: "Event reminder default channel",
    command: "/eventreminder setchannel",
    actor: interaction.user,
    changes: [
      channelId
        ? `Default notify channel → <#${channelId}>`
        : "Default notify channel cleared",
    ],
  }).catch(() => {});

  await interaction.reply({
    content: channelId
      ? `Event reminders will post to <#${channelId}> by default (unless overridden per event).`
      : "Default event reminder channel cleared. Each config must set a channel override, or reminders will be skipped.",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleList(interaction) {
  const configs = listEventReminderConfigs(interaction.guildId, {
    activeOnly: true,
  });
  const settings = getGuildSettings(interaction.guildId);
  const defaultCh = settings.event_reminder_channel_id
    ? `<#${settings.event_reminder_channel_id}>`
    : "_not set_";

  if (!configs.length) {
    await interaction.reply({
      content:
        `**Event reminders**\nDefault channel: ${defaultCh}\n\nNo active configs. Use \`/eventreminder create\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = configs.map((c) => {
    const ch = c.channel_id
      ? `<#${c.channel_id}>`
      : `default (${defaultCh})`;
    const next = (c.offsets || [])
      .filter((o) => o.sent_at == null)
      .sort((a, b) => a.fire_at - b.fire_at)[0];
    const nextText = next
      ? `<t:${Math.floor(next.fire_at / 1000)}:R> (${formatOffsetMinutes(next.offset_minutes)} before)`
      : "_all sent / none pending_";
    const offs = (c.offsets || [])
      .map((o) => {
        const mark = o.sent_at ? "✓" : "·";
        return `${mark}${formatOffsetMinutes(o.offset_minutes)}`;
      })
      .join(" ");
    return (
      `• **${ROLE_PREFIX}${c.shortname}** (\`${c.scheduled_event_id}\`)\n` +
      `  Role: <@&${c.role_id}> · Channel: ${ch}\n` +
      `  Offsets: ${offs || "—"}\n` +
      `  Next: ${nextText}`
    );
  });

  await interaction.reply({
    content: `**Event reminders**\nDefault channel: ${defaultCh}\n\n${lines.join("\n\n")}`.slice(
      0,
      1900
    ),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCreate(interaction) {
  const eventId = interaction.options.getString("event", true);
  const scheduledEvent = await fetchScheduledEvent(interaction.guild, eventId);
  if (!scheduledEvent) {
    await interaction.reply({
      content: "Could not find that scheduled event.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!canConfigureEventReminder(interaction.member, scheduledEvent)) {
    await interaction.reply({
      content:
        "You need **Manage Guild** or be the **creator** of this scheduled event.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (isEventTerminal(scheduledEvent)) {
    await interaction.reply({
      content: "That event is completed or canceled — cannot attach reminders.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (getAnyConfigByScheduledEventId(interaction.guildId, eventId)) {
    await interaction.reply({
      content:
        "Reminders already exist for this event. Use `/eventreminder edit` or `/eventreminder clear`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const start = eventStartMs(scheduledEvent);
  if (start == null) {
    await interaction.reply({
      content: "That event has no start time.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const modal = buildReminderModal({
    mode: "create",
    eventId,
    eventName: scheduledEvent.name,
  });
  await interaction.showModal(modal);
}

async function handleEdit(interaction) {
  const eventId = interaction.options.getString("event", true);
  const config = getConfigByScheduledEventId(interaction.guildId, eventId);
  if (!config) {
    await interaction.reply({
      content: "No active reminder config for that event. Use `/eventreminder create`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const scheduledEvent = await fetchScheduledEvent(interaction.guild, eventId);
  if (!canConfigureEventReminder(interaction.member, scheduledEvent)) {
    await interaction.reply({
      content:
        "You need **Manage Guild** or be the **creator** of this scheduled event.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const selectedMinutes = (config.offsets || []).map((o) => o.offset_minutes);
  const modal = buildReminderModal({
    mode: "edit",
    eventId,
    eventName: scheduledEvent?.name || config.shortname,
    shortname: config.shortname,
    selectedMinutes,
    message: config.message_template || "",
  });
  await interaction.showModal(modal);
}

async function handleClear(interaction) {
  const eventId = interaction.options.getString("event", true);
  const config = getAnyConfigByScheduledEventId(interaction.guildId, eventId);
  if (!config) {
    await interaction.reply({
      content: "No reminder config found for that event.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const scheduledEvent = await fetchScheduledEvent(interaction.guild, eventId);
  if (!canConfigureEventReminder(interaction.member, scheduledEvent)) {
    await interaction.reply({
      content:
        "You need **Manage Guild** or be the **creator** of this scheduled event.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const cleared = await cleanupEventReminder(interaction.guild, eventId);
  await logConfigChange(interaction.client, interaction.guildId, {
    title: "Event reminder cleared",
    command: "/eventreminder clear",
    actor: interaction.user,
    changes: [
      `Event \`${eventId}\``,
      `Role \`event-${cleared?.shortname || config.shortname}\` deleted`,
    ],
  }).catch(() => {});

  await interaction.reply({
    content: `Cleared event reminders and deleted role **${ROLE_PREFIX}${cleared?.shortname || config.shortname}**.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSync(interaction) {
  const eventId = interaction.options.getString("event", true);
  const config = getConfigByScheduledEventId(interaction.guildId, eventId);
  if (!config) {
    await interaction.reply({
      content: "No active reminder config for that event.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const scheduledEvent = await fetchScheduledEvent(interaction.guild, eventId);
  if (!scheduledEvent) {
    await interaction.reply({
      content: "Could not fetch the scheduled event from Discord.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!canConfigureEventReminder(interaction.member, scheduledEvent)) {
    await interaction.reply({
      content:
        "You need **Manage Guild** or be the **creator** of this scheduled event.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await syncEventReminderRole(
    interaction.guild,
    scheduledEvent,
    config.role_id
  );
  await interaction.editReply({
    content: `Synced **${ROLE_PREFIX}${config.shortname}**: +${result.granted} / −${result.removed} members.`,
  });
}

async function handleOptOut(interaction) {
  setEventReminderOptOut(interaction.guildId, interaction.user.id);
  await stripAllEventReminderRoles(interaction.guild, interaction.user.id);
  await interaction.reply({
    content:
      "You have opted out of **all** event reminder pings in this server. Use `/eventreminder optin` to re-enable.",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleOptIn(interaction) {
  clearEventReminderOptOut(interaction.guildId, interaction.user.id);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Re-grant for events the user is still interested in
  const configs = listEventReminderConfigs(interaction.guildId, {
    activeOnly: true,
  });
  let granted = 0;
  for (const config of configs) {
    const scheduledEvent = await fetchScheduledEvent(
      interaction.guild,
      config.scheduled_event_id
    );
    if (!scheduledEvent || isEventTerminal(scheduledEvent)) continue;
    try {
      const interested = await fetchInterestedUserIds(scheduledEvent);
      if (interested.includes(interaction.user.id)) {
        const ok = await grantRoleIfEligible(
          interaction.guild,
          interaction.user.id,
          config.role_id
        );
        if (ok) granted += 1;
      }
    } catch {
      // ignore per-event errors
    }
  }

  await interaction.editReply({
    content:
      granted > 0
        ? `Opted back in. Restored **${granted}** event reminder role(s) for events you are Interested in.`
        : "Opted back in. No current Interested event roles to restore.",
  });
}

async function handleStatus(interaction) {
  const optedOut = isEventReminderOptedOut(
    interaction.guildId,
    interaction.user.id
  );
  const roleIds = listActiveEventReminderRoleIds(interaction.guildId);
  const member = interaction.member;
  const held = roleIds.filter((id) => member?.roles?.cache?.has(id));
  const heldText = held.length
    ? held.map((id) => `<@&${id}>`).join(", ")
    : "_none_";

  await interaction.reply({
    content:
      `**Event reminder status**\n` +
      `Opted out: **${optedOut ? "yes" : "no"}**\n` +
      `Event roles you hold: ${heldText}`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Modal submit for create / edit.
 * @param {import("discord.js").ModalSubmitInteraction} interaction
 * @param {object} ctx
 */
async function handleEventReminderModal(interaction, ctx) {
  const customId = interaction.customId || "";
  const isCreate = customId.startsWith(MODAL_PREFIX_CREATE);
  const isEdit = customId.startsWith(MODAL_PREFIX_EDIT);
  if (!isCreate && !isEdit) return;

  const eventId = customId.slice(
    isCreate ? MODAL_PREFIX_CREATE.length : MODAL_PREFIX_EDIT.length
  );
  const guild = interaction.guild;
  if (!guild || !eventId) {
    await interaction.reply({
      content: "Invalid modal state.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const scheduledEvent = await fetchScheduledEvent(guild, eventId);
  if (!scheduledEvent) {
    await interaction.reply({
      content: "Scheduled event no longer exists.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!canConfigureEventReminder(interaction.member, scheduledEvent)) {
    await interaction.reply({
      content:
        "You need **Manage Guild** or be the **creator** of this scheduled event.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (isEventTerminal(scheduledEvent)) {
    await interaction.reply({
      content: "That event is completed or canceled.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const start = eventStartMs(scheduledEvent);
  if (start == null) {
    await interaction.reply({
      content: "Event has no start time.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Parse fields
  let shortnameRaw = "";
  let customText = "";
  let messageText = "";
  let presetMinutes = [];
  let channelId = null;

  try {
    shortnameRaw = interaction.fields.getTextInputValue("shortname");
  } catch {
    shortnameRaw = "";
  }
  try {
    customText = interaction.fields.getTextInputValue("offsets_custom") || "";
  } catch {
    customText = "";
  }
  try {
    messageText = interaction.fields.getTextInputValue("message") || "";
  } catch {
    messageText = "";
  }
  try {
    presetMinutes = (interaction.fields.getStringSelectValues("offsets") || [])
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    presetMinutes = [...DEFAULT_PRESET_MINUTES];
  }
  try {
    const channels = interaction.fields.getSelectedChannels("channel", false);
    if (channels?.size) {
      channelId = channels.first()?.id || [...channels.keys()][0] || null;
    }
  } catch {
    channelId = null;
  }

  const nameResult = normalizeShortname(shortnameRaw);
  if (!nameResult.ok) {
    await interaction.reply({
      content: nameResult.error,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const shortname = nameResult.shortname;

  const offsetResult = resolveOffsetMinutes(presetMinutes, customText);
  if (!offsetResult.ok) {
    await interaction.reply({
      content: offsetResult.error,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { offsets, skippedPast } = buildOffsetRows(
    offsetResult.minutes,
    start
  );
  if (!offsets.length) {
    await interaction.reply({
      content:
        "All selected offsets are already in the past relative to the event start. Pick closer times or a later event.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const template =
    messageText && messageText.trim() ? messageText.trim() : null;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (isCreate) {
    if (getAnyConfigByScheduledEventId(guild.id, eventId)) {
      await interaction.editReply({
        content:
          "A config was created while the modal was open. Use `/eventreminder edit` instead.",
      });
      return;
    }

    const collision = getConfigByShortname(guild.id, shortname);
    if (collision) {
      await interaction.editReply({
        content: `Shortname \`${shortname}\` is already in use. Pick another or clear the existing config.`,
      });
      return;
    }

    let role;
    try {
      role = await createReminderRole(
        guild,
        shortname,
        `Event reminder for ${scheduledEvent.name}`
      );
    } catch (err) {
      if (err?.code === "ROLE_NAME_IN_USE") {
        await interaction.editReply({
          content: `Role name **${ROLE_PREFIX}${shortname}** is already in use on this server. Clear the old config or pick another shortname.`,
        });
        return;
      }
      console.error("[eventReminders] role create failed:", err);
      await interaction.editReply({
        content:
          "Failed to create the reminder role. Ensure the bot has **Manage Roles** and its role is high enough.",
      });
      return;
    }

    let config;
    try {
      config = createEventReminderConfig({
        guildId: guild.id,
        scheduledEventId: eventId,
        shortname,
        roleId: role.id,
        channelId,
        messageTemplate: template,
        offsets,
        createdBy: interaction.user.id,
      });
    } catch (err) {
      console.error("[eventReminders] create config failed:", err);
      try {
        await role.delete("Rollback failed event reminder create");
      } catch {
        // ignore
      }
      await interaction.editReply({
        content: "Failed to save reminder config (database error).",
      });
      return;
    }

    const sync = await syncEventReminderRole(guild, scheduledEvent, role.id);

    await logConfigChange(interaction.client, guild.id, {
      title: "Event reminder created",
      command: "/eventreminder create",
      actor: interaction.user,
      changes: [
        `Event \`${eventId}\` → <@&${role.id}> (\`${ROLE_PREFIX}${shortname}\`)`,
        `Offsets: ${offsets.map((o) => formatOffsetMinutes(o.offsetMinutes)).join(", ")}`,
      ],
    }).catch(() => {});

    const chText = resolveNotifyChannelId(guild.id, channelId)
      ? `<#${resolveNotifyChannelId(guild.id, channelId)}>`
      : "_no channel configured — set one with /eventreminder setchannel or a modal override_";

    const fireLines = offsets
      .map(
        (o) =>
          `• ${formatOffsetMinutes(o.offsetMinutes)} → <t:${Math.floor(o.fireAt / 1000)}:F>`
      )
      .join("\n");

    await interaction.editReply({
      content:
        `Created reminders for **${scheduledEvent.name}**.\n` +
        `Role: <@&${role.id}> · Channel: ${chText}\n` +
        `Synced interested members: +${sync.granted}\n` +
        (skippedPast
          ? `_Skipped ${skippedPast} offset(s) already in the past._\n`
          : "") +
        `**Fires:**\n${fireLines}`,
    });
    return;
  }

  // --- edit ---
  const existing = getConfigByScheduledEventId(guild.id, eventId);
  if (!existing) {
    await interaction.editReply({
      content: "Config no longer exists. Use `/eventreminder create`.",
    });
    return;
  }

  let roleId = existing.role_id;
  if (shortname !== existing.shortname) {
    const collision = getConfigByShortname(guild.id, shortname);
    if (collision && collision.id !== existing.id) {
      await interaction.editReply({
        content: `Shortname \`${shortname}\` is already in use.`,
      });
      return;
    }

    // Rename role if possible
    try {
      const role =
        guild.roles.cache.get(roleId) ||
        (await guild.roles.fetch(roleId).catch(() => null));
      if (role) {
        await role.setName(
          `${ROLE_PREFIX}${shortname}`,
          "Event reminder shortname edit"
        );
      } else {
        const newRole = await createReminderRole(
          guild,
          shortname,
          "Event reminder role recreate on edit"
        );
        roleId = newRole.id;
        await syncEventReminderRole(guild, scheduledEvent, roleId);
      }
    } catch (err) {
      if (err?.code === "ROLE_NAME_IN_USE") {
        await interaction.editReply({
          content: `Role name **${ROLE_PREFIX}${shortname}** is already in use.`,
        });
        return;
      }
      console.error("[eventReminders] edit rename failed:", err);
      await interaction.editReply({
        content: "Failed to update the reminder role name.",
      });
      return;
    }
  }

  updateEventReminderConfig(existing.id, {
    shortname,
    roleId,
    channelId: channelId, // may be null → means use default; empty select clears override
    messageTemplate: template,
    offsets,
  });

  await logConfigChange(interaction.client, guild.id, {
    title: "Event reminder updated",
    command: "/eventreminder edit",
    actor: interaction.user,
    changes: [
      `Event \`${eventId}\` · \`${ROLE_PREFIX}${shortname}\``,
      `${offsets.length} pending offset(s)`,
    ],
  }).catch(() => {});

  const fireLines = offsets
    .map(
      (o) =>
        `• ${formatOffsetMinutes(o.offsetMinutes)} → <t:${Math.floor(o.fireAt / 1000)}:F>`
    )
    .join("\n");

  await interaction.editReply({
    content:
      `Updated reminders for **${scheduledEvent.name}**.\n` +
      (skippedPast
        ? `_Skipped ${skippedPast} offset(s) already in the past._\n`
        : "") +
      `**Pending fires:**\n${fireLines}`,
  });
}

async function autocompleteEventReminder(interaction) {
  const focused = interaction.options.getFocused(true);
  const sub = interaction.options.getSubcommand(false);
  const guild = interaction.guild;
  if (!guild || focused.name !== "event") {
    await interaction.respond([]);
    return;
  }

  const query = String(focused.value || "").toLowerCase();

  // create: all non-terminal scheduled events
  // edit/clear/sync: configured events
  if (sub === "create") {
    const events = await listScheduledEvents(guild);
    const choices = [];
    for (const ev of events.values()) {
      if (isEventTerminal(ev)) continue;
      const name = ev.name || "Event";
      const label = name.slice(0, 100);
      if (query && !label.toLowerCase().includes(query) && !ev.id.includes(query)) {
        continue;
      }
      choices.push({ name: label, value: ev.id });
      if (choices.length >= 25) break;
    }
    await interaction.respond(choices);
    return;
  }

  const configs = listEventReminderConfigs(guild.id, {
    activeOnly: sub !== "clear",
  });
  // For clear, include any config (activeOnly true still OK — inactive are deleted)
  const allConfigs =
    sub === "clear"
      ? listEventReminderConfigs(guild.id, { activeOnly: false })
      : configs;

  const choices = [];
  for (const c of allConfigs) {
    let label = `${ROLE_PREFIX}${c.shortname}`;
    try {
      const ev = await fetchScheduledEvent(guild, c.scheduled_event_id);
      if (ev?.name) label = `${ev.name} (${ROLE_PREFIX}${c.shortname})`;
    } catch {
      // keep shortname label
    }
    label = label.slice(0, 100);
    if (
      query &&
      !label.toLowerCase().includes(query) &&
      !c.scheduled_event_id.includes(query) &&
      !c.shortname.includes(query)
    ) {
      continue;
    }
    choices.push({ name: label, value: c.scheduled_event_id });
    if (choices.length >= 25) break;
  }
  await interaction.respond(choices);
}

function registerEvents(client) {
  client.on(Events.GuildScheduledEventUserAdd, async (scheduledEvent, user) => {
    try {
      const guild = scheduledEvent.guild || client.guilds.cache.get(scheduledEvent.guildId);
      if (!guild || !user?.id) return;
      const config = getConfigByScheduledEventId(
        guild.id,
        scheduledEvent.id
      );
      if (!config) return;
      await grantRoleIfEligible(guild, user.id, config.role_id);
    } catch (err) {
      console.error(
        "[eventReminders] GuildScheduledEventUserAdd:",
        err?.message || err
      );
    }
  });

  client.on(
    Events.GuildScheduledEventUserRemove,
    async (scheduledEvent, user) => {
      try {
        const guild =
          scheduledEvent.guild ||
          client.guilds.cache.get(scheduledEvent.guildId);
        if (!guild || !user?.id) return;
        const config = getConfigByScheduledEventId(
          guild.id,
          scheduledEvent.id
        );
        if (!config) return;
        await removeRoleSafe(guild, user.id, config.role_id);
      } catch (err) {
        console.error(
          "[eventReminders] GuildScheduledEventUserRemove:",
          err?.message || err
        );
      }
    }
  );

  client.on(Events.GuildScheduledEventUpdate, async (oldEvent, newEvent) => {
    try {
      const event = newEvent || oldEvent;
      const guild = event?.guild || client.guilds.cache.get(event?.guildId);
      if (!guild || !event) return;

      if (isEventTerminal(event)) {
        await cleanupEventReminder(guild, event.id);
        return;
      }

      const oldStart = eventStartMs(oldEvent);
      const newStart = eventStartMs(event);
      if (oldStart !== newStart && newStart != null) {
        rescheduleUnsentOffsets(guild.id, event.id, newStart);
      }
    } catch (err) {
      console.error(
        "[eventReminders] GuildScheduledEventUpdate:",
        err?.message || err
      );
    }
  });

  client.on(Events.GuildScheduledEventDelete, async (scheduledEvent) => {
    try {
      const guild =
        scheduledEvent?.guild ||
        client.guilds.cache.get(scheduledEvent?.guildId);
      if (!guild || !scheduledEvent?.id) return;
      await cleanupEventReminder(guild, scheduledEvent.id);
    } catch (err) {
      console.error(
        "[eventReminders] GuildScheduledEventDelete:",
        err?.message || err
      );
    }
  });
}

function start(client) {
  startEventReminderTicker(client);
}

module.exports = {
  name: "eventReminders",
  commands,
  handlers: {
    eventreminder: handleEventReminder,
  },
  autocomplete: {
    eventreminder: autocompleteEventReminder,
  },
  modalHandlers: {
    "er:": handleEventReminderModal,
  },
  registerEvents,
  start,
  // exported for tests
  handleEventReminderModal,
  buildReminderModal,
  MODAL_PREFIX_CREATE,
  MODAL_PREFIX_EDIT,
};
