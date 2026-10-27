/**
 * Auto-moderation config command constants (#725, epic #723).
 *
 * customId grammar follows the tickets/staffNotes prefix convention
 * (registry matches longest prefix). The `am:` namespace is automod-only.
 */

/** Modal customId: rules-text submit (`/automodconfig rules set` without text) */
const MODAL_RULES = "am:rules";
/** Text input customId inside the rules modal */
const MODAL_FIELD_RULES = "rules";

// Vocabulary and caps are owned by the db repositories (single source of
// truth shared by #726/#728 consumers); this module only re-exports what the
// command layer renders, so readers of the FEATURE module find them here.
const {
  AUTOMOD_ACTIONS,
  AUTOMOD_MODES,
  AUTOMOD_RULES_MAX_LEN,
  AUTOMOD_TIMEOUT_CAP_MIN,
  AUTOMOD_TIMEOUT_CAP_MAX,
  AUTOMOD_DEFAULT_TIMEOUT_CAP,
  AUTOMOD_BUDGET_MIN,
  AUTOMOD_BUDGET_MAX,
  AUTOMOD_DEFAULT_DAILY_CASE_LIMIT,
  automodModeColumn,
  normalizeAutomodMode,
} = require("../../db/repositories/automodSettings");
const {
  AUTOMOD_CASE_STATUSES,
  AUTOMOD_REFER_NOTE_MAX_LEN,
} = require("../../db/repositories/automodCases");

/**
 * Standard denial for Fluxer dispatches reaching this Discord-only surface
 * (epic #723 decision 8: Discord only for this milestone, explicit
 * no-parity; same sentence as tickets/gork/bridge).
 */
const NOT_ON_FLUXER = "That command is not available on Fluxer yet.";

/** Slash command builders use these for their option choices. */
const MODE_CHOICES = AUTOMOD_MODES.map((m) => ({ name: m, value: m }));
const ACTION_CHOICES = AUTOMOD_ACTIONS.map((a) => ({ name: a, value: a }));

module.exports = {
  MODAL_RULES,
  MODAL_FIELD_RULES,
  NOT_ON_FLUXER,
  AUTOMOD_ACTIONS,
  AUTOMOD_MODES,
  AUTOMOD_RULES_MAX_LEN,
  AUTOMOD_TIMEOUT_CAP_MIN,
  AUTOMOD_TIMEOUT_CAP_MAX,
  AUTOMOD_DEFAULT_TIMEOUT_CAP,
  AUTOMOD_BUDGET_MIN,
  AUTOMOD_BUDGET_MAX,
  AUTOMOD_DEFAULT_DAILY_CASE_LIMIT,
  MODE_CHOICES,
  ACTION_CHOICES,
  automodModeColumn,
  normalizeAutomodMode,
  // Case intake (#726): status vocabulary + the referrer-note cap, owned by
  // src/db/repositories/automodCases.js.
  AUTOMOD_CASE_STATUSES,
  AUTOMOD_REFER_NOTE_MAX_LEN,
};
