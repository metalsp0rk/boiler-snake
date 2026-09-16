/**
 * Scheduled event reminders feature.
 *
 * Slash: /eventreminder …
 * Modal custom ids: er:create:<eventId>[:p1] | er:edit:<eventId>
 * Button custom ids: er-recur:<eventId> (recurring toggle on confirmations)
 */

const { startEventReminderTicker } = require("./ticker");
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
