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

/* ── Case card (#730, epic #723) ────────────────────────────────────────────
 * The case card is the ONE staff-channel post per case (the harness
 * placeholder → edit flow guarantees the one-post invariant). Its buttons
 * carry ONLY the integer action-row id — every fact the handler needs is
 * re-read from the ledger rows (never from the embed), so an old card after
 * a restart still executes the CURRENT state. customId grammar examples:
 *   am:card:approve:41 · am:card:dismiss:41   (22 chars max — the 100-char
 *   router budget is nowhere near reached, row ids are small integers). */

/** Approve button prefix: `am:card:approve:<actionRowId>`. */
const CARD_APPROVE_PREFIX = "am:card:approve:";
/** Dismiss button prefix: `am:card:dismiss:<actionRowId>`. */
const CARD_DISMISS_PREFIX = "am:card:dismiss:";

/**
 * Button-bearing rows per card. Discord caps a message at 5 ActionRows ×
 * 5 components (25 total); the card packs two Approve+Dismiss PAIRS per row
 * (4 buttons), so 5 rows × 2 pairs = 10 pending rows = 20 buttons is the
 * honest clamp. Overflow gets the visible "**More pending rows:**" line —
 * the buttons REGENERATE on every card update, so the tail is one decision
 * away, and the one-per-(action, user) cap makes >10 pending rows rare.
 */
const AUTOMOD_CARD_MAX_BUTTON_ROWS = 10;

/** Display cap on the "**Seen, not considered:**" mention list (`… +N more`). */
const AUTOMOD_CARD_NOT_CONSIDERED_MAX = 25;

/**
 * Actions the breaker pause keeps dark on the APPROVE path (#730 contract:
 * "the breaker for kick/ban/timeout"). Sibling of #739's auto-path choke
 * point (executor.js marks the insertion spot in `runClaimedAction`) — that
 * issue owns the TRIP; the card pre-gate and the case docs already cite it.
 */
const AUTOMOD_BREAKER_ACTIONS = Object.freeze(["kick", "ban", "timeout"]);

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

/* ── LLM harness (case runner, #728, epic #723) ───────────────────────────
 * The runner shares the provider env with Gork (AI_API_KEY / AI_BASE_URL /
 * AI_MODEL via src/core/ai.js) but owns its OWN knobs — nothing here reads
 * or writes a Gork setting, queue, or budget counter (locked decision 7).
 * Fixed constants, deliberately NOT env and NOT per-guild (report to the
 * settings issue first if a knob ever needs to become configurable):      */

/**
 * Tool-round cap for ONE case run. Sibling of Gork's per-guild
 * `gork_max_tool_rounds` knob (roadmap/gork.md #705) with the same purpose
 * — a model spewing tool calls forever gets bounded — but automod runs are
 * short by design (read, consider, record), so this is a fixed constant,
 * not a setting. A run that hits the cap posts the partial decision + the
 * specific "tool-round cap (N) reached" cause and STILL commits what it
 * recorded (contract #728).
 */
const AUTOMOD_MAX_TOOL_ROUNDS = 12;

/**
 * Wall-clock budget for the whole provider tool loop of one run (every
 * round + tool execution, the chatWithTools `timeoutMs` deadline). A hung
 * provider can therefore never hold a case open past this — the run ends
 * with the provider's timeout cause and the budget stays unconsumed when
 * nothing was ever accepted.
 */
const AUTOMOD_RUN_TIMEOUT_MS = 120_000;

/** Persisted decision-log entry cap (belt — cap × calls per round can
 *  exceed it; overflow is dropped with a final `_log_truncated` marker). */
const AUTOMOD_DECISION_LOG_MAX_ENTRIES = 128;

/** Cap on tool-result strings fed back to the model (lookups can return a
 *  full record page; keep one tool result bounded like Gork's read caps). */
const AUTOMOD_TOOL_RESULT_MAX_CHARS = 4000;

/* ── Staff notes for considered users (#731, epic #723) ────────────────────
 * The one-note-per-considered-subject law: every user the model selects with
 * ANY action tool (no_action included) ends with exactly ONE staff note for
 * the case — the model's narrative when it wrote one, a harness-filled body
 * when it did not, an outcome UPDATE on the SAME row when staff decide. A
 * note call for a user with no action intent is DROPPED at commit (zero rows)
 * and the case card says so. The strings below are the shipped copy:
 * docs/automod.md quotes them verbatim — grep before renaming. */

/** Body marker on a note the harness wrote because the model recorded an
 *  action but omitted the narrative (issue #731: "marked as harness-filled"). */
const AUTOMOD_NOTE_HARNESS_FILLED =
  "**Narrative:** harness-filled — the model recorded no narrative for this user; this note is rebuilt from the structured decision.";

/** Decision-field label for a note call dropped at commit: the tool named a
 *  user with no action intent, so NO staff_notes row was written (#731). */
const AUTOMOD_NOTE_DROPPED_LABEL = "**Staff note dropped:**";

/** Section header of the outcome section a staff decision writes into the
 *  subject's SAME automod note (one header per note — re-decisions merge). */
const AUTOMOD_NOTE_OUTCOME_HEADER = "**Outcome:**";

/** Section header listing what the judge did for this subject at commit. */
const AUTOMOD_NOTE_ACTIONS_HEADER = "**Actions:**";

/** Label preceding the evidence message link inside an automod note. */
const AUTOMOD_NOTE_EVIDENCE_LABEL = "**Evidence:**";

/** Appended to narrative text the 2000-char note cap forced us to cut —
 *  truncation is EXPLICIT, never silent (#731 note-shape law). */
const AUTOMOD_NOTE_TRUNCATION_MARKER = "…[narrative truncated to fit the note cap]";

/** Per-entry cap on an action line inside the note's **Actions:** section. */
const AUTOMOD_NOTE_ACTION_ENTRY_MAX = 200;

/** Floor the assembler always keeps for the narrative when the actions
 *  section would otherwise crowd it out of the 2000-char cap. */
const AUTOMOD_NOTE_MIN_NARRATIVE = 160;

/**
 * State word on a note's **Actions:** line when the note is created by the
 * two-phase commit PRE-PASS (#733) for an AUTO-mode action: the action is
 * recorded and about to run; the real commit state lands as a merged entry
 * under the note's **Outcome:** header BEFORE the case card posts (the
 * shipped card.updateNoteOutcome merge law — identical lines never
 * duplicate). Suggest-mode pre-pass lines carry "pending approval" instead
 * (deterministic: a suggest run can only record the suggestion row), and a
 * `no_action` line is "recorded decision" from birth (it IS the decision).
 */
const AUTOMOD_NOTE_PLANNED_LABEL = "planned";

/** Slash command builders use these for their option choices. */
const MODE_CHOICES = AUTOMOD_MODES.map((m) => ({ name: m, value: m }));
const ACTION_CHOICES = AUTOMOD_ACTIONS.map((a) => ({ name: a, value: a }));

module.exports = {
  MODAL_RULES,
  MODAL_FIELD_RULES,
  // Case card (#730): button customId prefixes + the button clamp.
  CARD_APPROVE_PREFIX,
  CARD_DISMISS_PREFIX,
  AUTOMOD_CARD_MAX_BUTTON_ROWS,
  AUTOMOD_CARD_NOT_CONSIDERED_MAX,
  AUTOMOD_BREAKER_ACTIONS,
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
  // LLM harness (#728): the run's own knobs — round cap, loop deadline,
  // decision-log belt, tool-result cap. Fixed constants (no env, no setting;
  // the provider env stays the shared AI_* trio).
  AUTOMOD_MAX_TOOL_ROUNDS,
  AUTOMOD_RUN_TIMEOUT_MS,
  AUTOMOD_DECISION_LOG_MAX_ENTRIES,
  AUTOMOD_TOOL_RESULT_MAX_CHARS,
  // Staff notes (#731): the one-note law's shipped copy + assembly caps.
  AUTOMOD_NOTE_HARNESS_FILLED,
  AUTOMOD_NOTE_DROPPED_LABEL,
  AUTOMOD_NOTE_OUTCOME_HEADER,
  AUTOMOD_NOTE_ACTIONS_HEADER,
  AUTOMOD_NOTE_EVIDENCE_LABEL,
  AUTOMOD_NOTE_TRUNCATION_MARKER,
  AUTOMOD_NOTE_ACTION_ENTRY_MAX,
  AUTOMOD_NOTE_MIN_NARRATIVE,
  // Warning tool (#733): the two-phase note pre-pass state word.
  AUTOMOD_NOTE_PLANNED_LABEL,
};
