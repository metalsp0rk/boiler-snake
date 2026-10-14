/**
 * Community events — slash command definition, embed/button/modal builders,
 * and the rendered event message (epic #218).
 *
 * The event message is REBUILT from DB state on every change (button toggle,
 * edit, promotion) — never patched field-by-field — so what members see is
 * always exactly the signup table.
 */
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
} = require("discord.js");

const {
  baseEmbed,
  truncateField,
  truncateDescription,
  tsFull,
  tsRelative,
} = require("../../core/theme");

/** customId prefixes (all event traffic stays under ev:/evm: — router longest-prefix). */
const BTN_PREFIX = "ev:";
const MODAL_PREFIX = "evm:";

const SIGNUP_BTN = `${BTN_PREFIX}rs:`; // ev:rs:<eventId>:<optionId>
const CONFIRM_BTN = `${BTN_PREFIX}ok:`; // ev:ok:<eventId>   (confirm create preview)
const DISCARD_BTN = `${BTN_PREFIX}rm:`; // ev:rm:<eventId>    (discard preview draft)
const EDIT_BTN = `${BTN_PREFIX}ed:`; //   ev:ed:<eventId>    (opens edit modal)
const DELETE_BTN = `${BTN_PREFIX}dl:`; // ev:dl:<eventId>    (ephemeral confirm)
const DELETE_CONFIRM_BTN = `${BTN_PREFIX}dlc:`; // ev:dlc:<eventId>:<requesterId>
const SYNC_BTN = `${BTN_PREFIX}gc:`; //   ev:gc:<eventId>    (add to my Google calendar)
const EDIT_MODAL = `${MODAL_PREFIX}edit:`; // evm:edit:<eventId>

const MAX_VISIBLE_NAMES = 5; // names per option field before "and N more"
const DEFAULT_OPTIONS = [
  { label: "Yes", emoji: "✅", reminders_on: true },
  { label: "No", emoji: "❌", reminders_on: false },
  { label: "Maybe", emoji: "🤔", reminders_on: false },
];

// ── slash command ───────────────────────────────────────────────────────────

const eventOption = (name = "event", required = true) =>
  new SlashCommandOptionRef(name, required);

/** Builder assembled lazily (SlashCommandOptionRef keeps the chained code readable). */
class SlashCommandOptionRef {
  constructor(name, required) {
    this.name = name;
    this.required = required;
  }
}

/**
 * Append the required `event` integer option (event id, autocomplete).
 *
 * issue #291: options serialize in insertion order and Discord rejects any
 * payload where a required option follows an optional one
 * (APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID) — and the registration PUT
 * is atomic, so one bad subcommand darkens EVERY command. ALWAYS apply this
 * to a bare/descriptor-only subcommand builder, never after optional options.
 * test/command-option-order.test.js guards the whole registry offline.
 */
function withEvent(sc, name = "event") {
  return sc.addIntegerOption((o) =>
    o
      .setName(name)
      .setDescription("Event id from /event list or the autocomplete")
      .setRequired(true)
      .setAutocomplete(true),
  );
}

function timeOption(sc, name, description, required = false) {
  return sc.addStringOption((o) =>
    o
      .setName(name)
      .setDescription(description)
      .setRequired(required)
      .setMaxLength(80),
  );
}

/**
 * /event — the flat subcommands. The signup/config/channels groups live in
 * buildEventSignupCommand / buildEventConfigCommand / buildEventChannelsCommand
 * below: one `/event` command serialized to 21,136 chars and Discord refused
 * the registration PUT with APPLICATION_COMMAND_TOO_LARGE (max 8000). All
 * four names route to the same handleEvent — its DISPATCH keys on
 * `group-sub`/`sub`, never the top-level name, so the split is collision-free.
 * test/command-size.test.js guards every registry command < 8000 chars.
 */
function buildCommandEvent() {
  return new SlashCommandBuilder()
    .setName("event")
    .setDescription("Community events: post an event, RSVP with a button, manage reminders.")
    // ── flat subcommands ────────────────────────────────────────────────
    .addSubcommand((sc) =>
      sc
        .setName("create")
        .setDescription("Create a bot-owned event and post it (or schedule the post).")
        .addStringOption((o) =>
          o.setName("title").setDescription("Event title").setRequired(true).setMaxLength(150),
        )
        .addStringOption((o) =>
          o
            .setName("start")
            .setDescription('Start time: "in 2h", "tomorrow 7pm", "Fri 19:00", "2026-11-05T19:00Z"')
            .setRequired(true)
            .setMaxLength(80),
        )
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("Channel to post in (default: here)")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addStringOption((o) =>
          o.setName("description").setDescription("What is this event?").setMaxLength(1000),
        )
        .addStringOption((o) =>
          o.setName("duration").setDescription('e.g. "90", "1h30m", "2 hours"').setMaxLength(40),
        )
        .addStringOption((o) =>
          o
            .setName("roles")
            .setDescription("Roles to mention on post, comma-separated mentions/ids")
            .setMaxLength(300),
        )
        .addStringOption((o) =>
          o.setName("preset").setDescription("Signup preset name (default: Yes/No/Maybe)").setMaxLength(60),
        )
        .addStringOption((o) =>
          o
            .setName("signup_options")
            .setDescription('Custom options "Label|cap,Label2|cap" (cap optional)')
            .setMaxLength(300),
        )
        .addStringOption((o) =>
          o
            .setName("cutoff")
            .setDescription('Signups close: "at start", "30m before", "1h after"')
            .setMaxLength(40),
        )
        .addBooleanOption((o) =>
          o.setName("multiple").setDescription("Allow one member to hold more than one option"),
        )
        .addBooleanOption((o) =>
          o.setName("thread").setDescription("Create an event thread on post (default yes)"),
        )
        .addBooleanOption((o) =>
          o.setName("private_thread").setDescription("Make the event thread private (default no)"),
        )
        .addStringOption((o) =>
          o.setName("location").setDescription("Text location / address / channel mention").setMaxLength(200),
        )
        .addStringOption((o) =>
          o.setName("image").setDescription("Header image URL").setMaxLength(400),
        )
        .addStringOption((o) =>
          o.setName("color").setDescription("Embed color hex, e.g. #5865f2").setMaxLength(9),
        )
        .addRoleOption((o) =>
          o.setName("attendee_role").setDescription("Existing attendee role instead of a temporary one"),
        )
        .addStringOption((o) =>
          timeOptionTarget(o, "post_at", 'Post at a later time instead of now, e.g. "tomorrow 9am"'),
        )
        .addStringOption((o) =>
          o
            .setName("recurrence")
            .setDescription("Repeat this event (starts a series)")
            .addChoices(
              { name: "daily", value: "daily" },
              { name: "weekly", value: "weekly" },
              { name: "monthly", value: "monthly" },
            ),
        )
        .addStringOption((o) =>
          o
            .setName("weekdays")
            .setDescription('Weekly: days, e.g. "tue,thu"')
            .setMaxLength(60),
        )
        .addIntegerOption((o) =>
          o.setName("month_day").setDescription("Monthly: day of month (default: seed day)").setMinValue(1).setMaxValue(31),
        )
        .addStringOption((o) =>
          o
            .setName("end_mode")
            .setDescription("Series end condition")
            .addChoices(
              { name: "never", value: "never" },
              { name: "by count", value: "count" },
              { name: "until date", value: "until" },
            ),
        )
        .addIntegerOption((o) =>
          o.setName("end_count").setDescription("Series: total occurrences (end by count)").setMinValue(2).setMaxValue(1000),
        )
        .addStringOption((o) =>
          timeOptionTarget(o, "end_date", 'Series: last allowed occurrence, e.g. "Dec 31"'),
        ),
    )
    // issue #291: withEvent() applies to the bare builder first, so the
    // required `event` option precedes the optional edit fields/start/in_dm.
    .addSubcommand((sc) =>
      timeOption(
        addEditFields(
          withEvent(sc.setName("edit").setDescription("Edit an event (creator or staff).")),
        ),
        "start",
        "New start time (unsent reminders move with it)",
      ).addBooleanOption((o) =>
        o.setName("in_dm").setDescription("Edit one field through the DM wizard instead"),
      ),
    )
    .addSubcommand((sc) =>
      withEvent(
        sc
          .setName("delete")
          .setDescription("Delete an event and its signups (creator or staff)."),
      ),
    )
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("Upcoming events in this server."),
    )
    .addSubcommand((sc) =>
      sc.setName("wizard").setDescription("Create an event through a step-by-step DM conversation."),
    )
    .addSubcommand((sc) =>
      withEvent(
        sc
          .setName("duplicate")
          .setDescription("Copy an event into a draft you can edit and post (staff)."),
      ),
    )
    .addSubcommand((sc) =>
      withEvent(
        sc
          .setName("post")
          .setDescription("Post a draft now (organizer or staff; also clears a failed scheduled post)."),
      ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("adopt")
        .setDescription("Copy a Discord scheduled event into a draft bot event (staff or its creator).")
        .addStringOption((o) =>
          o
            .setName("scheduled_event")
            .setDescription("Discord scheduled event to adopt")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    );
}

/**
 * /eventsignup — groups split out of `/event` (8000-char payload cap):
 * signup options, presets, and organizer/staff member responses.
 */
function buildEventSignupCommand() {
  return new SlashCommandBuilder()
    .setName("eventsignup")
    .setDescription("Community events: manage signup options, presets, and member responses.")
    .addSubcommandGroup(responseGroup)
    .addSubcommandGroup(optionsGroup)
    .addSubcommandGroup(presetGroup);
}

/**
 * /eventconfig — server event settings, reminder controls, Google Calendar,
 * recurring series (moved out of `/event`, see buildCommandEvent).
 */
function buildEventConfigCommand() {
  return new SlashCommandBuilder()
    .setName("eventconfig")
    .setDescription("Community events: server settings, reminders, recurring series, Google Calendar.")
    .addSubcommandGroup(settingsGroup)
    .addSubcommandGroup(remindersGroup)
    .addSubcommandGroup(googleGroup)
    .addSubcommandGroup(seriesGroup);
}

/**
 * /eventchannels — event-channel marking/purge and cross-server posting
 * (moved out of `/event`, see buildCommandEvent).
 */
function buildEventChannelsCommand() {
  return new SlashCommandBuilder()
    .setName("eventchannels")
    .setDescription("Community events: mark event channels, purge past events, cross-post to other servers.")
    .addSubcommandGroup(channelGroup)
    .addSubcommandGroup(crosspostGroup);
}

// ── group builders (moved verbatim from buildCommandEvent; the split commands
// above assemble them — option order stays required-before-optional, #291) ──

/** `response` group — organizer/staff member management (/eventsignup). */
function responseGroup(g) {
  return g
    .setName("response")
    .setDescription("Organizer/staff: add, remove, or move a member on the signup list.")
    .addSubcommand((sc) =>
      withEvent(
        sc
          .setName("add")
          .setDescription("Add a member to an option (bypasses capacity/whitelist).")
          .addUserOption((o) =>
            o.setName("member").setDescription("Member to add").setRequired(true),
          )
          .addIntegerOption((o) =>
            o
              .setName("option")
              .setDescription("Signup option id (see /eventsignup options list)")
              .setRequired(true)
              .setAutocomplete(true),
          ),
      ),
    )
    .addSubcommand((sc) =>
      withEvent(
        sc
          .setName("remove")
          .setDescription("Remove a member from an option (next waiter is promoted).")
          .addUserOption((o) =>
            o.setName("member").setDescription("Member to remove").setRequired(true),
          )
          .addIntegerOption((o) =>
            o
              .setName("option")
              .setDescription("Signup option id")
              .setRequired(true)
              .setAutocomplete(true),
          ),
      ),
    )
    .addSubcommand((sc) =>
      withEvent(
        sc
          .setName("move")
          .setDescription("Move a member between options.")
          .addUserOption((o) =>
            o.setName("member").setDescription("Member to move").setRequired(true),
          )
          .addIntegerOption((o) =>
            o
              .setName("from_option")
              .setDescription("Current option id")
              .setRequired(true)
              .setAutocomplete(true),
          )
          .addIntegerOption((o) =>
            o
              .setName("to_option")
              .setDescription("Target option id")
              .setRequired(true)
              .setAutocomplete(true),
          ),
      ),
    );
}

/** `reminders` group — reminder controls (/eventconfig). */
function remindersGroup(g) {
  return g
    .setName("reminders")
    .setDescription("Reminder controls: personal opt-out, per-event mute, custom reminders.")
    .addSubcommand((sc) =>
      sc
        .setName("off")
        .setDescription("Stop event reminder pings for you everywhere in this server (shared with /eventreminder opt-out)."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("on")
        .setDescription("Resume event reminder pings for you in this server."),
    )
    .addSubcommand((sc) =>
      withEvent(
        sc
          .setName("mute")
          .setDescription("Silence reminders for one event (you only)."),
      ).addIntegerOption((o) =>
        o
          .setName("option")
          .setDescription("Only this signup option (optional)")
          .setRequired(false)
          .setAutocomplete(true),
      ),
    )
    .addSubcommand((sc) =>
      withEvent(sc.setName("unmute").setDescription("Undo /eventconfig reminders mute.")),
    )
    .addSubcommand((sc) =>
      sc
        .setName("status")
        .setDescription("Your reminder state: server opt-out, event mutes, attendee roles held."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("default")
        .setDescription("Staff: default reminder lead for newly posted events (0 = none).")
        .addIntegerOption((o) =>
          o
            .setName("minutes")
            .setDescription("Minutes before start (0 disables the default reminder)")
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(43200),
        ),
    )
    // issue #291: withEvent() first so `event` + `minutes` (both required)
    // precede the optional message/role.
    .addSubcommand((sc) =>
      withEvent(
        sc
          .setName("add")
          .setDescription("Organizer/staff: add a reminder to a posted or draft event (max 8)."),
      )
        .addIntegerOption((o) =>
          o
            .setName("minutes")
            .setDescription("Minutes before start")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(43200),
        )
        .addStringOption((o) =>
          o
            .setName("message")
            .setDescription("Custom body ({event} {starts_in} {starts_at} {role} {location} {url})")
            .setMaxLength(500),
        )
        .addRoleOption((o) =>
          o
            .setName("role")
            .setDescription("Also ping this role (role reminder, signups not required)"),
        ),
    )
    .addSubcommand((sc) =>
      withEvent(
        sc
          .setName("remove")
          .setDescription("Organizer/staff: delete an unsent reminder."),
      ).addIntegerOption((o) =>
        o
          .setName("reminder")
          .setDescription("Reminder id (see /eventconfig reminders list)")
          .setRequired(true)
          .setAutocomplete(true),
      ),
    )
    .addSubcommand((sc) =>
      withEvent(sc.setName("list").setDescription("Organizer/staff: this event's reminders.")),
    );
}

/** `settings` group — server event defaults (/eventconfig). */
function settingsGroup(g) {
  return g
    .setName("settings")
    .setDescription("Server event defaults (staff-gated per subcommand).")
    .addSubcommand((sc) =>
      sc
        .setName("show")
        .setDescription("Show the current event settings."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("show-attendees")
        .setDescription("Show/hide attendee names on the event message.")
        .addBooleanOption((o) =>
          o.setName("enabled").setDescription("Show names?").setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("timezone")
        .setDescription("IANA zone for naive time entry (e.g. America/New_York).")
        .addStringOption((o) =>
          o.setName("zone").setDescription("IANA zone name; 'UTC' resets").setRequired(true).setMaxLength(60),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("role")
        .setDescription("Require a role for an action (empty = everyone).")
        .addStringOption((o) =>
          o
            .setName("action")
            .setDescription("Which action to gate")
            .setRequired(true)
            .addChoices(
              { name: "create", value: "create" },
              { name: "edit", value: "edit" },
              { name: "delete", value: "delete" },
              { name: "event channels", value: "channels" },
              { name: "signup options", value: "options" },
            ),
        )
        .addRoleOption((o) =>
          o.setName("role").setDescription("Role required (omit with clear:true)"),
        )
        .addBooleanOption((o) =>
          o.setName("clear").setDescription("Remove the gate instead"),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("thread-reminders")
        .setDescription("Deliver reminders in the event thread (on) or the channel (off).")
        .addBooleanOption((o) =>
          o.setName("enabled").setDescription("Thread delivery?").setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("reminder-channel")
        .setDescription("Fallback channel for reminders when there is no thread.")
        .addChannelOption((o) =>
          o.setName("channel").setDescription("Channel; omit with clear:true").addChannelTypes(ChannelType.GuildText),
        )
        .addBooleanOption((o) => o.setName("clear").setDescription("Unset instead")),
    )
    .addSubcommand((sc) =>
      sc
        .setName("auto-archive")
        .setDescription("Delete the Discord message after the event ends (default off).")
        .addBooleanOption((o) =>
          o.setName("enabled").setDescription("Auto-archive on?").setRequired(true),
        )
        .addIntegerOption((o) =>
          o
            .setName("delay_minutes")
            .setDescription("Delay after end (default 120)")
            .setMinValue(0)
            .setMaxValue(43200),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("digest")
        .setDescription("Upcoming-events digest into a channel.")
        .addChannelOption((o) =>
          o.setName("channel").setDescription("Digest channel (clear:true to stop)").addChannelTypes(ChannelType.GuildText),
        )
        .addStringOption((o) =>
          o
            .setName("frequency")
            .setDescription("daily | weekly | none")
            .addChoices(
              { name: "daily", value: "daily" },
              { name: "weekly", value: "weekly" },
              { name: "none", value: "none" },
            ),
        )
        .addIntegerOption((o) =>
          o.setName("hour_utc").setDescription("UTC hour to post (0-23)").setMinValue(0).setMaxValue(23),
        )
        .addIntegerOption((o) =>
          o.setName("weekday").setDescription("Weekly only: 0=Sun…6=Sat").setMinValue(0).setMaxValue(6),
        )
        .addBooleanOption((o) => o.setName("clear").setDescription("Stop digests instead")),
    );
}

/** `options` group — custom signup options (/eventsignup). */
function optionsGroup(g) {
  return g
    .setName("options")
    .setDescription("Customize signup options (creator/staff).")
    .addSubcommand((sc) =>
      withEvent(sc.setName("list").setDescription("List this event's options with ids and counts.")),
    )
    // issue #291: withEvent() first so `event` + `label` (both required)
    // precede the optional emoji/capacity/waitlist/reminders/only_role.
    .addSubcommand((sc) =>
      withEvent(sc.setName("add").setDescription("Add a signup option."))
        .addStringOption((o) =>
          o.setName("label").setDescription("Button label").setRequired(true).setMaxLength(50),
        )
        .addStringOption((o) => o.setName("emoji").setDescription("Emoji").setMaxLength(16))
        .addIntegerOption((o) =>
          o.setName("capacity").setDescription("Capacity (0 = unlimited)").setMinValue(0).setMaxValue(100000),
        )
        .addBooleanOption((o) => o.setName("waitlist").setDescription("Waitlist when full (default yes)"))
        .addBooleanOption((o) => o.setName("reminders").setDescription("Counts as attending / gets reminders (default no)"))
        .addRoleOption((o) => o.setName("only_role").setDescription("Restrict signups to this role")),
    )
    // issue #291: withEvent() first so `event` + `option` (both required)
    // precede the optional edit fields.
    .addSubcommand((sc) =>
      withEvent(sc.setName("edit").setDescription("Edit one option."))
        .addIntegerOption((o) =>
          o.setName("option").setDescription("Option id").setRequired(true).setAutocomplete(true),
        )
        .addStringOption((o) => o.setName("label").setDescription("New label").setMaxLength(50))
        .addStringOption((o) => o.setName("emoji").setDescription("New emoji").setMaxLength(16))
        .addIntegerOption((o) =>
          o.setName("capacity").setDescription("New capacity (0 = unlimited)").setMinValue(0).setMaxValue(100000),
        )
        .addBooleanOption((o) => o.setName("waitlist").setDescription("Waitlist when full"))
        .addBooleanOption((o) => o.setName("reminders").setDescription("Counts as attending"))
        .addRoleOption((o) => o.setName("only_role").setDescription("Restrict to role (clear:true to open)"))
        .addBooleanOption((o) => o.setName("clear_role").setDescription("Remove the role restriction")),
    )
    .addSubcommand((sc) =>
      withEvent(
        sc
          .setName("remove")
          .setDescription("Remove an option (its signups go too; waiters promote).")
          .addIntegerOption((o) =>
            o.setName("option").setDescription("Option id").setRequired(true).setAutocomplete(true),
          ),
      ),
    )
    .addSubcommand((sc) =>
      withEvent(
        sc
          .setName("reorder")
          .setDescription("Reorder options by id list, e.g. `3,1,2`.")
          .addStringOption((o) =>
            o.setName("order").setDescription("Comma-separated option ids").setRequired(true).setMaxLength(120),
          ),
      ),
    )
    // issue #291: withEvent() first so the required `event` precedes the
    // optional role/clear.
    .addSubcommand((sc) =>
      withEvent(sc.setName("whitelist").setDescription("Event-wide role whitelist for all options."))
        .addRoleOption((o) => o.setName("role").setDescription("Required role"))
        .addBooleanOption((o) => o.setName("clear").setDescription("Remove the whitelist")),
    );
}

/** `preset` group — saved signup-option presets (/eventsignup). */
function presetGroup(g) {
  return g
    .setName("preset")
    .setDescription("Saved signup-option presets for this server.")
    .addSubcommand((sc) =>
      sc
        .setName("save")
        .setDescription("Save an event's current options as a preset.")
        .addIntegerOption((o) =>
          o.setName("event").setDescription("Event to copy options from").setRequired(true).setAutocomplete(true),
        )
        .addStringOption((o) =>
          o.setName("name").setDescription("Preset name").setRequired(true).setMaxLength(60),
        ),
    )
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("List this server's presets."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("delete")
        .setDescription("Delete a preset.")
        .addStringOption((o) =>
          o.setName("name").setDescription("Preset name").setRequired(true).setMaxLength(60),
        ),
    );
}

/** `series` group — recurring event series (/eventconfig). */
function seriesGroup(g) {
  return g
    .setName("series")
    .setDescription("Recurring event series.")
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("Series in this server with next occurrence times."),
    )
    .addSubcommand((sc) =>
      withEvent(
        sc
          .setName("skip")
          .setDescription("Skip one occurrence of a series (the posted ones stay)."),
      ),
    )
    .addSubcommand((sc) =>
      withEvent(
        sc
          .setName("stop")
          .setDescription("Stop a series: posted events stay as one-offs, future drafts go."),
      ),
    );
}

/** `channel` group — event channels: mark, sort, purge (/eventchannels). */
function channelGroup(g) {
  return g
    .setName("channel")
    .setDescription("Event channels: mark, sort, purge.")
    .addSubcommand((sc) =>
      sc
        .setName("mark")
        .setDescription("Mark a channel as an event channel.")
        .addChannelOption((o) =>
          o.setName("channel").setDescription("Channel to mark").addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("unmark")
        .setDescription("Unmark an event channel.")
        .addChannelOption((o) =>
          o.setName("channel").setDescription("Channel to unmark").addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("List marked event channels."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("sort")
        .setDescription("Re-pin event messages oldest-first (max 50).")
        .addChannelOption((o) =>
          o.setName("channel").setDescription("Event channel to sort").addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("purge")
        .setDescription("Purge or toggle purge for an event channel (off by default; pins survive).")
        .addChannelOption((o) =>
          o.setName("channel").setDescription("Event channel").addChannelTypes(ChannelType.GuildText),
        )
        .addBooleanOption((o) => o.setName("enabled").setDescription("Set the channel's purge flag"))
        .addBooleanOption((o) => o.setName("run").setDescription("Run one purge pass now")),
    );
}

/** `crosspost` group — cross-server event posting (/eventchannels). */
function crosspostGroup(g) {
  return g
    .setName("crosspost")
    .setDescription("Post this server's events into another server (destination must approve).")
    .addSubcommand((sc) =>
      sc
        .setName("invite")
        .setDescription("Ask a destination guild to accept cross-posts (source admin).")
        .addStringOption((o) =>
          o.setName("destination_guild_id").setDescription("Destination guild id").setRequired(true).setMaxLength(30),
        )
        .addChannelOption((o) =>
          o.setName("destination_channel").setDescription("Where their admin should allow posts"),
        )
        .addStringOption((o) =>
          o.setName("roles").setDescription("Roles to mention in the destination, comma-separated").setMaxLength(300),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("approve")
        .setDescription("Approve a cross-post invite sent to this server (destination admin).")
        .addStringOption((o) =>
          o.setName("code").setDescription("Invite code from /eventchannels crosspost list").setRequired(true).setMaxLength(20),
        )
        .addChannelOption((o) =>
          o.setName("channel").setDescription("Channel to receive posts").addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("revoke")
        .setDescription("Revoke a cross-post pair (either side).")
        .addIntegerOption((o) =>
          o.setName("id").setDescription("Cross-post id from /eventchannels crosspost list").setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("Cross-post pairs involving this server."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("config")
        .setDescription("Per-destination posts: mentions, role whitelist, post offset.")
        .addIntegerOption((o) =>
          o.setName("id").setDescription("Cross-post id").setRequired(true),
        )
        .addStringOption((o) => o.setName("roles").setDescription("Mentions, comma-separated").setMaxLength(300))
        .addRoleOption((o) => o.setName("signup_role").setDescription("Restrict destination signups to this role"))
        .addBooleanOption((o) => o.setName("clear_signup_role").setDescription("Open destination signups"))
        .addIntegerOption((o) =>
          o.setName("offset_minutes").setDescription("Post offset vs source post (-60 to 43200)").setMinValue(-43200).setMaxValue(43200),
        ),
    );
}

/** `google` group — Google Calendar integration (/eventconfig). */
function googleGroup(g) {
  return g
    .setName("google")
    .setDescription("Google Calendar integration.")
    .addSubcommand((sc) =>
      sc
        .setName("connect")
        .setDescription("Connect your own Google Calendar so you can sync events you can see."),
    )
    .addSubcommand((sc) =>
      sc.setName("status").setDescription("Your calendar link status."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("disconnect")
        .setDescription("Disconnect your Google Calendar for this server."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("autoset")
        .setDescription("Staff: auto-sync newly posted events into a connected member's calendar.")
        .addUserOption((o) =>
          o.setName("member").setDescription("Connected member whose calendar receives events"),
        )
        .addBooleanOption((o) => o.setName("off").setDescription("Turn auto-sync off")),
    );
}

/** Shared option tail for /event edit (settable fields). */
function addEditFields(sc) {
  return sc
    .addStringOption((o) => o.setName("title").setDescription("New title").setMaxLength(150))
    .addStringOption((o) => o.setName("description").setDescription("New description").setMaxLength(1000))
    .addChannelOption((o) =>
      o.setName("channel").setDescription("Move the post to another channel").addChannelTypes(ChannelType.GuildText),
    )
    .addStringOption((o) => o.setName("duration").setDescription("New duration, e.g. 1h30m").setMaxLength(40))
    .addStringOption((o) => o.setName("location").setDescription("New location").setMaxLength(200))
    .addStringOption((o) => o.setName("roles").setDescription("Announce roles (replaces)").setMaxLength(300))
    .addStringOption((o) =>
      timeOptionTarget(o, "post_at", "Reschedule the post time (drafts) or clear it with 'now'"),
    )
    .addStringOption((o) => o.setName("cutoff").setDescription('Signup cutoff: "at start", "30m before", "off"').setMaxLength(40))
    .addBooleanOption((o) => o.setName("multiple").setDescription("Allow multiple held options"))
    .addBooleanOption((o) => o.setName("thread").setDescription("Create a thread on post"))
    .addBooleanOption((o) => o.setName("private_thread").setDescription("Private thread"))
    .addStringOption((o) => o.setName("image").setDescription("Header image URL").setMaxLength(400))
    .addStringOption((o) => o.setName("color").setDescription("Embed color hex").setMaxLength(9))
    .addRoleOption((o) => o.setName("attendee_role").setDescription("Existing attendee role (role_mode becomes 'existing')"))
    .addStringOption((o) =>
      o
        .setName("role_mode")
        .setDescription("Attendee role mode")
        .addChoices(
          { name: "none", value: "none" },
          { name: "temporary", value: "temp" },
          { name: "existing (pick attendee_role)", value: "existing" },
        ),
    );
}

/** Small wrapper so time options stay uniform without repeating boilerplate. */
function timeOptionTarget(opt, name, description) {
  opt.setName(name).setDescription(description).setMaxLength(80);
  return opt;
}

// ── parsing helpers used by handlers (kept with the builders they mirror) ───

/** "#aaaaaa" / "aaaa11" / "0x5865f2" → int | null | {error} */
function parseColor(text) {
  if (text == null || String(text).trim() === "") return { ok: true, color: null };
  const m = String(text).trim().match(/^(?:#|0x)?([0-9a-f]{6})$/i);
  if (!m) return { ok: false, error: `Color \`${text}\` must be a 6-digit hex like \`#5865f2\`.` };
  return { ok: true, color: parseInt(m[1], 16) };
}

/** "@Role, 123456" → ["123", "456"] (role ids). */
function parseRoleList(text) {
  if (!text) return [];
  const ids = [];
  for (const part of String(text).split(/[,\s]+/)) {
    const m = part.match(/^<@&(\d+)>$/) || part.match(/^(\d{5,})$/);
    if (m) ids.push(m[1]);
  }
  return [...new Set(ids)];
}

/** "tue,thu" / "2,4" → [2,4] (0=Sun). */
function parseWeekdayList(text) {
  if (!text) return [];
  const table = {
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
    wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5, sat: 6, saturday: 6,
  };
  const out = [];
  for (const part of String(text).split(/[,\s]+/)) {
    const p = part.trim().toLowerCase();
    if (!p) continue;
    if (/^\d$/.test(p)) {
      const n = Number(p);
      if (n >= 0 && n <= 6) out.push(n);
    } else if (table[p] !== undefined) out.push(table[p]);
  }
  return [...new Set(out)].sort();
}

/**
 * "Label|5,Label2" → [{label, capacity}] (cap optional).
 * @returns {{ok:true, options:[{label:string, capacity:number}]}|{ok:false, error:string}}
 */
function parseSignupOptionSpec(text) {
  const parts = String(text || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return { ok: false, error: "No signup options given." };
  if (parts.length > 10) return { ok: false, error: "At most 10 signup options." };
  const options = [];
  for (const part of parts) {
    const m = part.split("|");
    const label = (m[0] || "").trim();
    if (!label) return { ok: false, error: `Option \`${part}\` has an empty label.` };
    let capacity = 0;
    if (m[1] != null && m[1].trim() !== "") {
      const cap = Number(m[1]);
      if (!Number.isInteger(cap) || cap < 0)
        return { ok: false, error: `Capacity \`${m[1]}\` in option \`${part}\` must be a whole number ≥ 0.` };
      capacity = cap;
    }
    options.push({ label: label.slice(0, 50), capacity });
  }
  // The first custom option behaves like "Yes": reminders on (E6 default).
  return {
    ok: true,
    options: options.map((o, i) => ({
      label: o.label,
      capacity: o.capacity,
      reminders_on: i === 0,
      waitlist_on: true,
    })),
  };
}

// ── buttons ─────────────────────────────────────────────────────────────────

/**
 * Button rows for an event message: option buttons (wrapped at 5/row) plus
 * the utility row.
 */
function buildEventComponents(event, options, mySignupOptionIds = new Set()) {
  const rows = [];
  let row = new ActionRowBuilder();
  let count = 0;
  for (const opt of options) {
    const mine = mySignupOptionIds.has(opt.id);
    const label = opt.label.length > 40 ? `${opt.label.slice(0, 39)}…` : opt.label;
    const btn = new ButtonBuilder()
      .setCustomId(`${SIGNUP_BTN}${event.id}:${opt.id}`)
      .setLabel(mine ? `✓ ${label}` : label)
      .setStyle(mine ? ButtonStyle.Success : ButtonStyle.Secondary);
    if (opt.emoji) btn.setEmoji(opt.emoji);
    row.addComponents(btn);
    if (++count % 5 === 0) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
  }
  if (count % 5 !== 0) rows.push(row);
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${EDIT_BTN}${event.id}`)
        .setLabel("Edit")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${DELETE_BTN}${event.id}`)
        .setLabel("Delete")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${SYNC_BTN}${event.id}`)
        .setLabel("📅 My calendar")
        .setStyle(ButtonStyle.Primary),
    ),
  );
  return rows;
}

function buildConfirmComponents(eventId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CONFIRM_BTN}${eventId}`)
        .setLabel("✅ Post it")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${DISCARD_BTN}${eventId}`)
        .setLabel("Discard")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildDeleteConfirmComponents(eventId, requesterId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${DELETE_CONFIRM_BTN}${eventId}:${requesterId}`)
        .setLabel("Confirm delete")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ── modals ──────────────────────────────────────────────────────────────────

function buildEditModal(event) {
  const modal = new ModalBuilder()
    .setCustomId(`${EDIT_MODAL}${event.id}`)
    .setTitle(`Edit: ${event.title}`.slice(0, 45));
  const title = new TextInputBuilder()
    .setCustomId("title")
    .setRequired(true)
    .setStyle(TextInputStyle.Short)
    .setMaxLength(150)
    .setValue(event.title.slice(0, 100));
  const start = new TextInputBuilder()
    .setCustomId("start")
    .setRequired(false)
    .setStyle(TextInputStyle.Short)
    .setMaxLength(80)
    .setPlaceholder("in 2h · tomorrow 7pm · 2026-11-05T19:00Z");
  const description = new TextInputBuilder()
    .setCustomId("description")
    .setRequired(false)
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000);
  const location = new TextInputBuilder()
    .setCustomId("location")
    .setRequired(false)
    .setStyle(TextInputStyle.Short)
    .setMaxLength(200);
  // Components-v2 labels: the label text lives ONLY on the LabelBuilder —
  // a TextInput nested in a Label must not carry its own `label` (Discord
  // rejects with TEXT_INPUT_COMPONENT_LABEL_IN_LABEL_COMPONENT). `required`
  // stays on the text input (LabelBuilder has no setRequired).
  const fields = [
    ["Title", title],
    ["Start time (blank = unchanged)", start],
    ["Description (blank = keep, '-' = clear)", description],
    ["Location (blank = keep, '-' = clear)", location],
  ];
  for (const [label, input] of fields) {
    modal.addLabelComponents(
      new LabelBuilder().setLabel(label).setTextInputComponent(input)
    );
  }
  return modal;
}

// ── embeds ──────────────────────────────────────────────────────────────────

/**
 * One signup option as an embed-column: `name` is the option (emoji+label),
 * `value` is the count block (total/capacity, waitlist, attendee names).
 * Rendered as an INLINE field so Discord lays options out three-per-row
 * (Yes | No | Maybe read as columns on desktop, stacking on mobile).
 */
function formatOptionColumn(opt, counts, showAttendees, nameOf) {
  const c = counts[opt.id] || { signedUp: 0, waitlisted: 0 };
  const cap = opt.capacity > 0 ? `/${opt.capacity}` : "";
  const name = `${opt.emoji ? `${opt.emoji} ` : ""}${opt.label}`.slice(0, 256);
  const lines = [`**${c.signedUp}${cap}**`];
  if (opt.capacity > 0 && opt.waitlist_on) {
    lines.push(c.waitlisted > 0 ? `waitlist ${c.waitlisted}` : "waitlist ready");
  }
  if (showAttendees && c.signedUp > 0) {
    const names = (opt._attendees || []).slice(0, MAX_VISIBLE_NAMES).map(nameOf);
    if (names.length) {
      const more = c.signedUp - names.length;
      lines.push(`${names.join(", ")}${more > 0 ? ` +${more}` : ""}`);
    }
  }
  return { name, value: truncateField(lines.join("\n")) };
}

/**
 * Render the event message (posted form). `opts` carries options with
 * per-option `_attendees` (user id arrays) preloaded, plus counts, settings,
 * and a nameOf(userId) display function.
 */
function buildEventMessage(event, { options, counts, settings, nameOf = (id) => `<@${id}>` }) {
  const embed = baseEmbed({
    title: event.title,
    description: event.description
      ? truncateDescription(event.description, 1400)
      : truncateDescription(defaultDescription(event), 1400),
    color: event.color ?? undefined,
    timestamp: new Date(event.start_at),
  });
  const whenLines = [`${tsFull(event.start_at)} (${tsRelative(event.start_at)})`];
  if (event.end_at) whenLines.push(`Ends ${tsFull(event.end_at)}`);
  if (event.cutoff_at && event.cutoff_at !== event.start_at) {
    whenLines.push(`Signups close ${tsFull(event.cutoff_at)}`);
  }
  embed.addFields({ name: "📅 When", value: truncateField(whenLines.join("\n")), index: 0 });
  const where = event.location
    ? event.location
    : event.channel_id
      ? `<#${event.channel_id}>`
      : "—";
  embed.addFields({ name: "📍 Where", value: truncateField(where), index: 1 });

  const showAttendees = settings?.show_attendees !== 0;
  if (!options.length) {
    embed.addFields({ name: "🙋 Signups", value: "_No signup options yet._", index: 2 });
  } else {
    // One INLINE field per option: Discord renders inline fields three-per-row,
    // so the default Yes/No/Maybe set reads as a column row. Extra options flow
    // to the next row; the cap keeps us well clear of the 25-field embed limit
    // (When/Where/meta take three more).
    const MAX_OPTION_COLUMNS = 15;
    const shown = options.slice(0, MAX_OPTION_COLUMNS);
    const overflow = options.length - shown.length;
    for (const opt of shown) {
      const { name, value } = formatOptionColumn(opt, counts, showAttendees, nameOf);
      embed.addFields({ name, value, inline: true });
    }
    if (overflow > 0) {
      embed.addFields({
        name: "＋",
        value: `_${overflow} more option${overflow === 1 ? "" : "s"}_`,
        inline: true,
      });
    }
  }

  const meta = [`Organizer <@${event.creator_id}>`, `Event \`${event.id}\``];
  if (event.multiple_signups) meta.push("Multiple signups allowed");
  if (event.series_id) meta.push("Series occurrence");
  // Appended last on purpose (no `index`): option columns are inserted
  // dynamically, so meta must follow by insertion order, not a fixed slot.
  embed.addFields({ name: "ℹ️", value: truncateField(meta.join(" · ")) });
  if (event.image_url) embed.setImage(event.image_url);

  return {
    embeds: [embed],
    components: buildEventComponents(event, options),
    allowedMentions: { parse: ["users", "roles"], repliedUser: false },
  };
}

function defaultDescription(event) {
  return `React-less signups! Pick an option below — reminders go to the **Yes** crowd${
    event.end_at ? "" : ""
  }.`;
}

/** Ephemeral preview for the E3 confirmation step. */
function buildPreviewEmbed(event, { options }) {
  const embed = baseEmbed({
    title: `Preview — ${event.title}`,
    color: event.color ?? undefined,
    description: event.description ? truncateDescription(event.description, 600) : null,
  });
  const lines = [
    `**Starts:** ${tsFull(event.start_at)}  (${tsRelative(event.start_at)})`,
    event.end_at ? `**Ends:** ${tsFull(event.end_at)}` : null,
    event.channel_id ? `**Channel:** <#${event.channel_id}>` : null,
    `**Options:** ${options.map((o) => o.label).join(" / ")}`,
    event.post_at ? `**Scheduled post:** ${tsFull(event.post_at)}` : null,
  ].filter(Boolean);
  embed.addFields({ name: "Details", value: truncateField(lines.join("\n")) });
  embed.addFields({
    name: "Confirm the time",
    value: `Does ${tsFull(event.start_at)} look right? Time zones localize in YOUR Discord client.`,
  });
  return { embeds: [embed] };
}

function buildListEmbed(events, { countsByEvent = {} } = {}) {
  const embed = baseEmbed({
    title: "📆 Upcoming events",
    color: undefined,
    description: events.length
      ? events
          .map((e) => {
            const c = countsByEvent[e.id];
            const signups = c ? ` · ${c.total} signed up` : "";
            return `**${e.id}** · ${e.title} · ${tsRelative(e.start_at)} · <#${e.channel_id}>${signups}${
              e.status === "draft" ? " · _draft_" : ""
            }`;
          })
          .join("\n")
      : "No upcoming events. Create one with `/event create` or the `/event wizard`.",
  });
  return { embeds: [embed] };
}

module.exports = {
  BTN_PREFIX,
  MODAL_PREFIX,
  SIGNUP_BTN,
  CONFIRM_BTN,
  DISCARD_BTN,
  EDIT_BTN,
  DELETE_BTN,
  DELETE_CONFIRM_BTN,
  SYNC_BTN,
  EDIT_MODAL,
  DEFAULT_OPTIONS,
  MAX_VISIBLE_NAMES,
  buildCommandEvent,
  buildEventSignupCommand,
  buildEventConfigCommand,
  buildEventChannelsCommand,
  buildEventComponents,
  buildEventMessage,
  buildPreviewEmbed,
  buildListEmbed,
  buildConfirmComponents,
  buildDeleteConfirmComponents,
  buildEditModal,
  parseColor,
  parseRoleList,
  parseWeekdayList,
  parseSignupOptionSpec,
};
