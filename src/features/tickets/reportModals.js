/**
 * Report modals for the context-menu "Report Post" / "Report User" flows
 * (#745; modal-components shape per #877).
 *
 * Discord's modal components support real choice widgets via the LABEL
 * component (type 18) — string selects included (#877 obsoletes #745
 * decision 1's "TEXT INPUTS ONLY" premise). Both report modals are built
 * with `addLabelComponents`: every field is a Label wrapping its component,
 * the shape Discord's modal-components docs show and discord.js 14.28 parses
 * symmetrically on submit (`ModalSubmitFields` reads label-wrapped fields).
 *
 * The Report Post delete question is a REQUIRED single-select
 * (`rep_delete`, #877): `Keep the original` → `keep`, `Delete after evidence
 * posts` → `yes`. There are NO option defaults, and `setRequired(true)`
 * blocks submit until an explicit choice is made — a destructive question is
 * never pre-answered (#745 decision 2, still locked; only its input widget
 * changed — the submit-side value-equality contract lives in ./report.js).
 *
 * The pending-report token still rides INSIDE the modal customId
 * (`MODAL_REPORT_*_PREFIX` + 32-hex token, decision 3): modal submit is a
 * different interaction carrying nothing but that string. Assembly is a
 * one-line concatenation; 9 + 32 = 41 chars, well under Discord's 100-char
 * customId cap. The submit handlers slice the token back out with
 * `customId.slice(PREFIX.length)` and consume it via pendingReports.take.
 */

const {
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const {
  MODAL_REPORT_MESSAGE_PREFIX,
  MODAL_REPORT_USER_PREFIX,
  MODAL_REPORT_FIELD_CONTEXT,
  MODAL_REPORT_FIELD_DELETE,
  MODAL_REPORT_DELETE_OPTION_KEEP,
  MODAL_REPORT_DELETE_OPTION_YES,
} = require("./constants");

/** Additional-context field: Discord's hard text-input cap. */
const MAX_REPORT_CONTEXT = 4000;

/**
 * Shared context field (both modals use the same field id and style; only
 * the placeholder differs): Label-wrapped paragraph TextInput, required.
 * @param {string} placeholder
 * @returns {LabelBuilder}
 */
function buildReportContextField(placeholder) {
  const input = new TextInputBuilder()
    .setCustomId(MODAL_REPORT_FIELD_CONTEXT)
    .setLabel("Additional context")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(MAX_REPORT_CONTEXT)
    .setPlaceholder(placeholder);

  return new LabelBuilder()
    .setLabel("Additional context")
    .setTextInputComponent(input);
}

/**
 * Delete-question field (#877): REQUIRED single-select with exactly the two
 * dispositions and NO default selection — Discord blocks submit until the
 * reporter explicitly picks one. Values are the constants' option ids; the
 * submit side matches them by value equality (never destroys on anything
 * but the exact `yes`).
 * @returns {LabelBuilder}
 */
function buildReportDeleteField() {
  const select = new StringSelectMenuBuilder()
    .setCustomId(MODAL_REPORT_FIELD_DELETE)
    .setPlaceholder("Choose what happens to the original post")
    .setRequired(true)
    .addOptions(
      { label: "Keep the original", value: MODAL_REPORT_DELETE_OPTION_KEEP },
      {
        label: "Delete after evidence posts",
        value: MODAL_REPORT_DELETE_OPTION_YES,
      },
    );

  return new LabelBuilder()
    .setLabel("Delete original?")
    .setStringSelectMenuComponent(select);
}

/**
 * Report-post modal: context + the delete select (decision 1 superseded by
 * #877 — two Label components, well inside the 5-component cap).
 * @param {string} token pending-report token from pendingReports.put
 * @returns {ModalBuilder} customId = MODAL_REPORT_MESSAGE_PREFIX + token
 */
function buildReportMessageModal(token) {
  return new ModalBuilder()
    .setCustomId(MODAL_REPORT_MESSAGE_PREFIX + token)
    .setTitle("Report this post")
    .addLabelComponents(
      buildReportContextField("What should staff know about this post?"),
      buildReportDeleteField(),
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
    .addLabelComponents(
      buildReportContextField(
        "What happened? Staff will see this in the ticket.",
      ),
    );
}

module.exports = {
  buildReportMessageModal,
  buildReportUserModal,
  MAX_REPORT_CONTEXT,
};
