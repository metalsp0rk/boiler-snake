/**
 * Scheduled event reminders feature.
 *
 * Slash: /eventreminder …
 * Modal custom ids: er:create:<eventId>[:p1] | er:edit:<eventId>
 * Button custom ids: er-recur:<eventId> (recurring toggle on confirmations)
 */

const { startEventReminderTicker } = require("./ticker");
const { getCommunityById } = require("../../platform/community");
// Ticker plumbing lister (PR 7): candidates for reminder-bearing communities.
const { listCommunityIdsWithUsers } = require("../../db/repositories/users");
const {
  commands,
  createModalCustomId,
  parseModalCustomId,
  buildRecurringButtonRow,
  buildReminderModal,
  MODAL_PREFIX_CREATE,
  MODAL_PREFIX_EDIT,
  RECUR_BTN_PREFIX,
} = require("./ui");
const {
  handleEventReminder,
  handleEventReminderModal,
  handleRecurringButton,
  autocompleteEventReminder,
} = require("./handlers");
const { registerEvents } = require("./events");

/**
 * Count non-Discord communities that have tracked users (the set reminders
 * can ever be configured for). Spec 580: non-Discord rows are skipped, and
 * the skip is reported ONCE per process — not per row.
 * @returns {number}
 */
function countNonDiscordCommunities() {
  let count = 0;
  for (const communityId of listCommunityIdsWithUsers()) {
    const community = getCommunityById(communityId);
    if (community && community.platform !== "discord") count += 1;
  }
  return count;
}

/**
 * @param {object|null} supervisor PR 7 supervisor ({discord, fluxer, clientForCommunity})
 * @param {object} [featureCtx]
 */
function start(supervisor, featureCtx) {
  void featureCtx;
  // Delivery resolves guilds through the Discord client (guild.scheduledEvents
  // is a Discord-only surface, spec 580). A legacy raw client is honored.
  const client =
    supervisor && typeof supervisor.clientForCommunity === "function"
      ? supervisor.discord ?? null
      : supervisor && supervisor.guilds
        ? supervisor
        : null;

  const nonDiscord = countNonDiscordCommunities();
  if (nonDiscord > 0) {
    // One info line per process (spec 580) — never per row.
    console.log(
      `[eventReminders] skipping ${nonDiscord} non-Discord communities`,
    );
  }

  if (!client) {
    // Null Discord client (Discord unconfigured): reminder delivery has no
    // gateway surface, so the ticker is not armed (no-op, never throws).
    console.log(
      "[eventReminders] Discord client not configured — reminder ticker not armed",
    );
    return;
  }

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
  buttonHandlers: {
    [RECUR_BTN_PREFIX]: handleRecurringButton,
  },
  registerEvents,
  start,
  handleEventReminderModal,
  buildReminderModal,
  handleRecurringButton,
  createModalCustomId,
  parseModalCustomId,
  buildRecurringButtonRow,
  MODAL_PREFIX_CREATE,
  MODAL_PREFIX_EDIT,
  RECUR_BTN_PREFIX,
};
