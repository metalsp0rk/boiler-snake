/**
 * Ban lifecycle constants (#772) — the pure interaction surface: command and
 * modal ids, duration bounds, the rejoin welcome window.
 *
 * Deliberately Discord-free and db-free: duration.js and dmCopy.js build on
 * these without importing anything heavier, so the whole pure layer is unit-
 * testable with a bare `node --test` require.
 *
 * customId grammar follows the tickets/automod prefix convention (the router
 * matches the longest registered prefix); the `bl:` namespace is ban-
 * lifecycle-only. #773 (appeals) lives OUTSIDE it with its own grammar: the
 * guildless DM lane `appeal:<banRecordId>` / `appeal:s:<banRecordId>` and
 * the in-ticket `ap:*` family (see src/features/banAppeals/constants.js —
 * the ban DM already accepts a components pass-through (dmCopy.buildBanDm)
 * so the appeal button needs no copy change here).
 */

/* ── Command surface ──────────────────────────────────────────────────────── */

/** Slash command names — commandVisibility.js keys carry the same names. */
const BAN_COMMAND = "ban";
const BANNOTIFY_COMMAND = "bannotify";

/** User context-menu display name — EXACT; commandVisibility keys on it. */
const BAN_CONTEXT_MENU_NAME = "Ban member";

/* ── Ban modal (Reason + Duration, #772 §1) ───────────────────────────────── */

/** Ban modal customId prefix: `bl:ban:<token>` (one-shot token, referModal idiom). */
const MODAL_BAN_PREFIX = "bl:ban:";

/** Modal text-input custom ids. */
const MODAL_FIELD_REASON = "reason";
const MODAL_FIELD_DURATION = "duration";

/**
 * Human labels — refusals quote these verbatim (#745 never-act-on-misread:
 * the reject MUST name the exact field the staffer has to fix).
 */
const MODAL_LABEL_REASON = "Reason";
const MODAL_LABEL_DURATION = "Duration";

/* ── Duration bounds (#772 §1: floor 60 s, cap 365 d) ─────────────────────── */

/** Smallest expiring ban: 60 seconds. */
const DURATION_MIN_MS = 60_000;
/** Longest expiring ban: 365 days (anything longer is `permanent`). */
const DURATION_MAX_MS = 365 * 24 * 3_600_000;

/** Grammar hint for the Duration input (rejects + modal placeholder). */
const DURATION_EXAMPLES = "24h or 7d";

/* ── Rejoin welcome window (#772 §5) ──────────────────────────────────────── */

/** A pending welcome-back DM may be retried on rejoin for 30 days. */
const REJOIN_WELCOME_WINDOW_DAYS = 30;

module.exports = {
  BAN_COMMAND,
  BANNOTIFY_COMMAND,
  BAN_CONTEXT_MENU_NAME,
  MODAL_BAN_PREFIX,
  MODAL_FIELD_REASON,
  MODAL_FIELD_DURATION,
  MODAL_LABEL_REASON,
  MODAL_LABEL_DURATION,
  DURATION_MIN_MS,
  DURATION_MAX_MS,
  DURATION_EXAMPLES,
  REJOIN_WELCOME_WINDOW_DAYS,
};
