/**
 * Report modals for the context-menu "Report Post" / "Report User" flows
 * (#745, locked decision 1).
 *
 * A Discord modal supports TEXT INPUTS ONLY — no dropdowns, checkboxes, or
 * buttons — so each report flow is ONE modal shown directly from the
 * context-menu invoke. No preview panel, no intermediate components.
 *
 * The pending-report token rides INSIDE the modal customId
 * (`MODAL_REPORT_*_PREFIX` + 32-hex token, decision 3): modal submit is a
 * different interaction carrying nothing but that string. Assembly is a
 * one-line concatenation; 9 + 32 = 41 chars, well under Discord's 100-char
 * customId cap. The submit handlers (later subtasks) slice the token back
 * out with `customId.slice(PREFIX.length)` and consume it via
 * pendingReports.take.
 *
 * Conventions mirror buildCreateTicketModal (helpers.js): one TextInputBuilder
 * per ActionRowBuilder, builder setters chained, field customIds from
 * ./constants.js.
 */

const {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const {
  MODAL_REPORT_MESSAGE_PREFIX,
  MODAL_REPORT_USER_PREFIX,
  MODAL_REPORT_FIELD_CONTEXT,
  MODAL_REPORT_FIELD_DELETE,
} = require("./constants");

/** Additional-context field: Discord's hard text-input cap. */
const MAX_REPORT_CONTEXT = 4000;

/**
 * Delete-answer field cap. Decision 2 only understands "yes"/"y" (and keeps
 * the message for anything else, echoing the unrecognized input) — the cap
 * just keeps a paste-dump out of a one-word answer. REQUIRED, no default:
 * there is never a pre-selected disposition on a destructive question.
 */
const MAX_REPORT_DELETE_ANSWER = 10;

/**
 * Shared context input (both modals use the same field id and style; only
 * the placeholder differs).
 * @param {string} placeholder
 * @returns {TextInputBuilder}
 */
function buildReportContextInput(placeholder) {
  return new TextInputBuilder()
    .setCustomId(MODAL_REPORT_FIELD_CONTEXT)
    .setLabel("Additional context")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(MAX_REPORT_CONTEXT)
    .setPlaceholder(placeholder);
}

/**
 * Report-post modal: context + the delete question (decision 1).
 * @param {string} token pending-report token from pendingReports.put
 * @returns {ModalBuilder} customId = MODAL_REPORT_MESSAGE_PREFIX + token
 */
function buildReportMessageModal(token) {
  const deleteInput = new TextInputBuilder()
    .setCustomId(MODAL_REPORT_FIELD_DELETE)
    .setLabel("Delete original? (yes/no)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(MAX_REPORT_DELETE_ANSWER)
    .setPlaceholder("yes or no");

  return new ModalBuilder()
    .setCustomId(MODAL_REPORT_MESSAGE_PREFIX + token)
    .setTitle("Report this post")
    .addComponents(
      new ActionRowBuilder().addComponents(
        buildReportContextInput("What should staff know about this post?"),
      ),
      new ActionRowBuilder().addComponents(deleteInput),
    );
}

/**
 * Report-user modal: context only (decision 7 — never deletes anything).
 * @param {string} token pending-report token from pendingReports.put
 * @returns {ModalBuilder} customId = MODAL_REPORT_USER_PREFIX + token
 */
function buildReportUserModal(token) {
  return new ModalBuilder()
    .setCustomId(MODAL_REPORT_USER_PREFIX + token)
    .setTitle("Report this user")
    .addComponents(
      new ActionRowBuilder().addComponents(
        buildReportContextInput("What happened? Staff will see this in the ticket."),
      ),
    );
}

module.exports = {
  buildReportMessageModal,
  buildReportUserModal,
  MAX_REPORT_CONTEXT,
  MAX_REPORT_DELETE_ANSWER,
};
