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

/* ── Case-context gathering caps (#727, epic #723) ─────────────────────────
 * The ANCHOR window deliberately does NOT get automod-specific sizes: the
 * contract names Gork's `read_discord` decision-45 window as the cap, so
 * `caseContext.js` imports READ_DISCORD_BEFORE_WINDOW (40) /
 * READ_DISCORD_AFTER_WINDOW (10) / READ_DISCORD_MESSAGE_CHAR_CAP (500)
 * straight from `../gork/constants` (single source, gork stays read-only).
 * The constants below size the USER-ONLY scan, which has no gork twin (a
 * referral without an anchor message is automod-only intake shape) — they
 * exist to make "bounded, never the whole server" a provable bound:
 * worst case = AUTOMOD_CONTEXT_USER_SCAN_MAX_CHANNELS message fetches, each
 * ≤ AUTOMOD_CONTEXT_USER_SCAN_PER_CHANNEL messages, and at most
 * AUTOMOD_CONTEXT_USER_SCAN_MAX_MESSAGES SUBJECT messages survive into the
 * bundle. */

/** Channels the user-only scan may FETCH (visible + non-ticket) at most. */
const AUTOMOD_CONTEXT_USER_SCAN_MAX_CHANNELS = 15;
/** Per-channel fetch cap (recent messages pulled per scanned channel). */
const AUTOMOD_CONTEXT_USER_SCAN_PER_CHANNEL = 25;
/** Collected subject-message cap across the whole user-only scan. */
const AUTOMOD_CONTEXT_USER_SCAN_MAX_MESSAGES = 100;
/** Warnings / staff-notes preload page cap (repository non-export max). */
const AUTOMOD_CONTEXT_RECORDS_PAGE_MAX = 100;

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
  // Case-context gathering caps (#727): the user-only scan bounds and the
  // records-preload page. The anchor window caps are GORK-owned — import
  // READ_DISCORD_* from ../gork/constants (see the block comment above).
  AUTOMOD_CONTEXT_USER_SCAN_MAX_CHANNELS,
  AUTOMOD_CONTEXT_USER_SCAN_PER_CHANNEL,
  AUTOMOD_CONTEXT_USER_SCAN_MAX_MESSAGES,
  AUTOMOD_CONTEXT_RECORDS_PAGE_MAX,
};
