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

// Report modals (context-menu "Report Post" / "Report User", #745 decision 3).
// The pending-report token travels INSIDE the modal customId — modal submit is
// a different interaction and carries nothing else. Assembly is a one-line
// concatenation in the report modal builder (subtask 05): PREFIX + 32-hex
// token = 41 chars, well inside Discord's 100-char customId limit.
/** Modal prefix: report-post submit — `tk:rep:m:<token>` */
const MODAL_REPORT_MESSAGE_PREFIX = "tk:rep:m:";
/** Modal prefix: report-user submit — `tk:rep:u:<token>` */
const MODAL_REPORT_USER_PREFIX = "tk:rep:u:";
/** Text input customId inside both report modals: additional context */
const MODAL_REPORT_FIELD_CONTEXT = "rep_context";
/** Text input customId inside the report-post modal: delete the original? (yes/no) */
const MODAL_REPORT_FIELD_DELETE = "rep_delete";

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
  MODAL_REPORT_MESSAGE_PREFIX,
  MODAL_REPORT_USER_PREFIX,
  MODAL_REPORT_FIELD_CONTEXT,
  MODAL_REPORT_FIELD_DELETE,
  DEFAULT_PANEL_TITLE,
  DEFAULT_PANEL_DESCRIPTION,
};
