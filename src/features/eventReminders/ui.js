/**
 * Event-reminder slash command, modal, and recurring-toggle button builders.
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
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
  setEventReminderMute,
  clearEventReminderMute,
  isEventReminderMuted,
  listEventReminderMutes,
  listActiveEventReminderRoleIds,
} = require("../../db");
const { isStaff } = require("../../core/permissions");
const { replyDenied, replyEphemeral } = require("../../core/interaction");
const { logConfigChange } = require("../logs/auditLog");
const {
  OFFSET_PRESETS,
  DEFAULT_PRESET_MINUTES,
  DEFAULT_EMBED_DESCRIPTION,
  ROLE_PREFIX,
  suggestShortname,
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


const MODAL_PREFIX_CREATE = "er:create:";
const MODAL_PREFIX_EDIT = "er:edit:";
/** Toggle button on create/edit confirmations: er-recur:<eventId> */
const RECUR_BTN_PREFIX = "er-recur:";
const PERSISTENT_SUFFIX = ":p1";

function createModalCustomId(eventId, persistent) {
  return `${MODAL_PREFIX_CREATE}${eventId}${persistent ? PERSISTENT_SUFFIX : ""}`;
}

/**
 * @param {string} customId
 * @returns {{ mode: "create"|"edit", eventId: string, persistent: boolean }|null}
 */
function parseModalCustomId(customId) {
  if (typeof customId !== "string") return null;
  if (customId.startsWith(MODAL_PREFIX_EDIT)) {
    return {
      mode: "edit",
      eventId: customId.slice(MODAL_PREFIX_EDIT.length),
      persistent: false,
    };
  }
  if (customId.startsWith(MODAL_PREFIX_CREATE)) {
    let rest = customId.slice(MODAL_PREFIX_CREATE.length);
    let persistent = false;
    if (rest.endsWith(PERSISTENT_SUFFIX)) {
      persistent = true;
      rest = rest.slice(0, -PERSISTENT_SUFFIX.length);
    }
    return { mode: "create", eventId: rest, persistent };
  }
  return null;
}

/**
 * @param {string} eventId
 * @param {boolean} persistent
 */
function buildRecurringButtonRow(eventId, persistent) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RECUR_BTN_PREFIX}${eventId}`)
      .setLabel(persistent ? "♾️ Recurring: on" : "♾️ Recurring: off")
      .setStyle(persistent ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
}

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
            .setAutocomplete(true),
        )
        .addBooleanOption((opt) =>
          opt
            .setName("persistent")
            .setDescription(
              "Keep role alive across recurring occurrences (default: no)",
            )
            .setRequired(false),
        ),
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
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("List active event reminder configs."),
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
            .setAutocomplete(true),
        ),
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
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("setchannel")
        .setDescription(
          "Set the default channel for reminder posts (Manage Guild).",
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Default notify channel (omit to clear)")
            .setRequired(false)
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            ),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("optout")
        .setDescription("Opt out of all event reminder pings in this server."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("optin")
        .setDescription("Re-enable event reminder pings in this server."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("mute")
        .setDescription("Mute reminder pings for one linked event.")
        .addStringOption((opt) =>
          opt
            .setName("event")
            .setDescription("Linked scheduled event to mute")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("unmute")
        .setDescription("Unmute reminder pings for one linked event.")
        .addStringOption((opt) =>
          opt
            .setName("event")
            .setDescription("Linked scheduled event to unmute")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("status")
        .setDescription("Show your event reminder opt-out, mutes, and roles."),
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
 * @param {boolean} [opts.persistent] create-mode only; encoded in the modal
 *   customId (Discord caps modals at 5 label components — no modal field).
 */
function buildReminderModal(opts) {
  const customId =
    opts.mode === "edit"
      ? `${MODAL_PREFIX_EDIT}${opts.eventId}`
      : createModalCustomId(opts.eventId, opts.persistent);

  const shortnameDefault = (opts.shortname || "event").slice(0, 80);
  const selected = new Set(
    opts.selectedMinutes?.length
      ? opts.selectedMinutes
      : [...DEFAULT_PRESET_MINUTES],
  );

  const shortnameInput = new TextInputBuilder()
    .setCustomId("shortname")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(80)
    .setValue(shortnameDefault);

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
      })),
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
    .setPlaceholder(DEFAULT_EMBED_DESCRIPTION.slice(0, 100));
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
        .setLabel("Custom embed description (optional)")
        .setDescription(
          "{event} {location} {starts_in} {starts_at} {url} {description} {offset} {role}",
        )
        .setTextInputComponent(messageInput),
    );
}

module.exports = {
  MODAL_PREFIX_CREATE,
  MODAL_PREFIX_EDIT,
  RECUR_BTN_PREFIX,
  PERSISTENT_SUFFIX,
  commands,
  createModalCustomId,
  parseModalCustomId,
  buildRecurringButtonRow,
  fetchScheduledEvent,
  listScheduledEvents,
  modalTitle,
  buildReminderModal,
};
