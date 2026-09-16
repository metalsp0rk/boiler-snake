/**
 * Ticket custom IDs, default panel copy, and embed colors.
 */
const { Color } = require("../../core/theme");

const COLOR_OPEN = Color.success;
const COLOR_INFO = Color.brand;
const COLOR_SENSITIVE = Color.danger;

/** Button customId: open ticket from a panel */
const BTN_OPEN = "tk:open";
/** Modal customId: submit ticket description after panel button */
const MODAL_CREATE = "tk:create";
/** Text input customId inside the create modal */
const MODAL_FIELD_REASON = "reason";

/** Button prefix: attach staff note after close — `tk:sn:<ticketId>` */
const BTN_STAFF_NOTE_PREFIX = "tk:sn:";
/** Modal prefix: staff note body after close — `tk:snm:<ticketId>` */
const MODAL_STAFF_NOTE_PREFIX = "tk:snm:";
/** Text input customId inside the post-close staff note modal */
const MODAL_FIELD_STAFF_NOTE = "staff_note";

const DEFAULT_PANEL_TITLE = "Support Tickets";
const DEFAULT_PANEL_DESCRIPTION =
  "Click **Open a ticket** below to start a private conversation with staff. " +
  "You'll be asked to describe what you need help with.";

module.exports = {
  COLOR_OPEN,
  COLOR_INFO,
  COLOR_SENSITIVE,
  BTN_OPEN,
  MODAL_CREATE,
  MODAL_FIELD_REASON,
  BTN_STAFF_NOTE_PREFIX,
  MODAL_STAFF_NOTE_PREFIX,
  MODAL_FIELD_STAFF_NOTE,
  DEFAULT_PANEL_TITLE,
  DEFAULT_PANEL_DESCRIPTION,
};
