/**
 * Ban appeals constants (#773) — the pure interaction surface: the command
 * name, the customId grammar, ferry relay caps, and the refusal copy every
 * intake/outcome refusal quotes.
 *
 * Deliberately Discord-free and db-free (banLifecycle/constants.js posture):
 * the parsers, copy builders and caps are unit-testable with a bare
 * `node --test` require — no gateway, no SQLite, no clocks.
 *
 * customId grammar (LOCKED, #773 context decision 2 + 5 — the `bl:` namespace
 * stays ban-lifecycle-only; appeals own their own two lanes):
 *
 *   DM lane (GUILDESS — the feature-owned InteractionCreate listener owns
 *   these; the command router drops guild-less interactions):
 *     appeal:<banRecordId>     the ban-DM "Appeal this ban" button
 *     appeal:s:<banRecordId>   the statement-modal submit (durable-id based,
 *                              NO token store — the 075 UNIQUE(ban_record_id)
 *                              is the one-shot belt)
 *   Ticket lane (IN-GUILD — registered router buttonHandlers, longest-prefix
 *   dispatch like am:card:* / tk:*):
 *     ap:clemency:<appealId>   grant clemency (outcome claim)
 *     ap:deny:<appealId>       deny → opens the optional-reason modal
 *     ap:deny:m:<appealId>     the denial-reason modal submit
 *     ap:pause:<appealId>      ferry pause/resume toggle
 *
 * Collision law (verified at #773 time): every currently registered router
 * prefix is `bl:ban:`, `er:`, `er-recur:`, `am:*`, `tk:*`, `note:*`, `ui:n:`,
 * `music:`, `gh:token:` — none starts with `appeal:`, `appeal:s:` or `ap:`,
 * and grep shows the three strings appear nowhere else in src/. load.js
 * claim() still fails boot loudly if a future feature ever shadows one.
 */

/* ── Logging ──────────────────────────────────────────────────────────────── */

/** One grep for the whole feature (issue §6: every failure logs with ids). */
const LOG_PREFIX = "[appeals]";

/* ── Command surface ──────────────────────────────────────────────────────── */

/** Slash command name — commandVisibility.js keys carry the same name. */
const BANAPPEALS_COMMAND = "banappeals";

/**
 * Discord-only surface (#773 explicit Fluxer no-parity — the ban-DM button,
 * the statement modal and the ferry relay are all Discord mechanics). Same
 * shipped sentence as the automod/banLifecycle gates so every refused Fluxer
 * context reads identically; hoisted here, never re-implemented inline
 * (banLifecycle/commands.js precedent: a feature-local const, not a
 * cross-feature import of another module's gate).
 */
const NOT_ON_FLUXER = "That command is not available on Fluxer yet.";

/* ── customId grammar (locked — see header) ───────────────────────────────── */

/** Ban-DM intake button: `appeal:<banRecordId>` (guildless lane). */
const APPEAL_PREFIX = "appeal:";
/** Statement modal submit: `appeal:s:<banRecordId>` (guildless lane). */
const MODAL_APPEAL_PREFIX = "appeal:s:";

/** Whole in-ticket button family (collision audits + future guards). */
const AP_TICKET_PREFIX = "ap:";
/** `ap:clemency:<appealId>` — outcome claim (first decision wins). */
const AP_CLEMENCY_PREFIX = "ap:clemency:";
/** `ap:deny:<appealId>` — opens the denial-reason modal. */
const AP_DENY_PREFIX = "ap:deny:";
/** `ap:deny:m:<appealId>` — denial-reason modal submit (longest-prefix twin). */
const AP_DENY_MODAL_PREFIX = "ap:deny:m:";
/** `ap:pause:<appealId>` — ferry pause/resume toggle. */
const AP_PAUSE_PREFIX = "ap:pause:";

/* ── customId parsers (pure; the ONLY way ids leave a customId) ───────────── */

/** A record/appeal id is digits-only — anything else is a forged/garbage id. */
const ID_RE = /^\d+$/;

/**
 * `appeal:<banRecordId>` → the digits-only record id, else null. The modal
 * prefix `appeal:s:` is a strict extension of the button prefix, so a modal
 * customId MUST NOT parse as a press — check MODAL_APPEAL_PREFIX first.
 *
 * @param {string} customId
 * @returns {string|null} the record id (digits-only) or null
 */
function parseAppealPressRecordId(customId) {
  const id =
    typeof customId === "string" && customId.startsWith(APPEAL_PREFIX)
      ? customId.slice(APPEAL_PREFIX.length)
      : null;
  if (id == null || !ID_RE.test(id)) return null;
  return id;
}

/**
 * `appeal:s:<banRecordId>` → the digits-only record id, else null.
 *
 * @param {string} customId
 * @returns {string|null} the record id (digits-only) or null
 */
function parseModalAppealRecordId(customId) {
  const id =
    typeof customId === "string" && customId.startsWith(MODAL_APPEAL_PREFIX)
      ? customId.slice(MODAL_APPEAL_PREFIX.length)
      : null;
  return id != null && ID_RE.test(id) ? id : null;
}

/**
 * One in-ticket family parser: `<familyPrefix><appealId>` → digits-only
 * appeal id, else null. The caller passes the EXACT family constant
 * (longest-prefix dispatch already ran; this is the payload audit). A
 * `ap:deny:` parse also sees `ap:deny:m:…` — reject the embedded colon so
 * the two arms can never double-handle each other's ids.
 *
 * @param {string} customId
 * @param {string} familyPrefix one of the AP_*_PREFIX constants
 * @returns {string|null} the appeal id (digits-only) or null
 */
function parseTicketAppealId(customId, familyPrefix) {
  const id =
    typeof customId === "string" &&
    typeof familyPrefix === "string" &&
    familyPrefix.startsWith(AP_TICKET_PREFIX) &&
    customId.startsWith(familyPrefix)
      ? customId.slice(familyPrefix.length)
      : null;
  if (id == null || !ID_RE.test(id)) return null;
  return id;
}

/* ── Human labels (refusals + modal chrome quote these verbatim) ──────────── */

/** Ban-DM intake button label (issue §1, exact copy). */
const APPEAL_BUTTON_LABEL = "Appeal this ban";
/** Statement modal title. */
const APPEAL_MODAL_TITLE = "Appeal this ban";
/** Statement field label + field customId (the modal's only input). */
const MODAL_LABEL_STATEMENT = "Appeal statement";
const MODAL_FIELD_STATEMENT = "statement";

/** In-ticket outcome/pause button labels (issue §2 header buttons). */
const BUTTON_LABEL_CLEMENCY = "Grant clemency";
const BUTTON_LABEL_DENY = "Appeal denied";
const BUTTON_LABEL_PAUSE = "Pause relaying";
const BUTTON_LABEL_RESUME = "Resume relaying";

/* ── Ferry relay caps (issue §3) ──────────────────────────────────────────── */

/**
 * Re-upload cap for one relayed attachment (issue §3 "Durability": 8 MB per
 * attachment — over-cap gets a SPECIFIC refusal to the sender, the relay
 * never truncates bytes). Documented deviation from mirrorTicketAssets'
 * budgets: that pipeline serves web transcript files, not live relay.
 */
const FERRY_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * User-side flood guard (issue §3 "Flooding"): minimum spacing between two
 * ferried user→ticket messages. Constant, tuned post-launch; drops are
 * silent to staff, specific to the sender. 10 s mirrors the reaction
 * cooldown's shape — long enough to blunt paste-walls, short enough that a
 * real conversation never notices it between thoughts.
 */
const FERRY_USER_COOLDOWN_MS = 10_000;

/**
 * User-side hourly ceiling (same flood law): at most this many relayed
 * user→ticket messages per rolling hour per appeal. 20 keeps a genuine
 * multi-message appeal narrative flowing while capping a sustained flood.
 */
const FERRY_USER_HOURLY_CAP = 20;

/**
 * Boot catch-up bound (issue §3 "Ordering/resume"): the most messages the
 * catch-up relays PER DIRECTION per appeal on startup — bounded so a long
 * offline period can never storm the ticket or the DM on boot. Skipped
 * messages are NOT replayed later (the cursor only advances with what was
 * actually relayed — never claim a catch-up that did not run).
 */
const FERRY_CATCHUP_MAX = 50;

/* ── Refusal copy builders (issue §1 + locked decision 6) ───────────────────
 * Every refusal names its SPECIFIC cause, ends with "Nothing was filed.",
 * and the CALLER logs `[appeals] …` with guild/user/record ids (the copy
 * never interpolates user-controlled text — ids live in the log line).
 * Reply posture: ephemeral + allowedMentions {parse: []} — the caller's.
 */

/** Presser is not the banned member (forged/stale button press). */
function refusalNotYou() {
  return (
    "**Appeal:** this button belongs to a different member's ban — only the " +
    "banned member can file their own appeal. Nothing was filed."
  );
}

/** No ban record behind the id (gone, or the ban was never tracked by #772). */
function refusalNoRecord() {
  return (
    "**Appeal:** this appeal link no longer points at a tracked ban record " +
    "— the record was removed, or the ban happened outside the bot " +
    "(honeypot and external bans carry no appeal path). Nothing was filed."
  );
}

/** Record exists but the ban is no longer active (lifted/expired/decided). */
function refusalNotActive() {
  return (
    "**Appeal:** that ban is no longer active — it was lifted, expired, or " +
    "already decided, so its appeal window is closed. Nothing was filed."
  );
}

/** Guild has ban appeals switched off (`/banappeals disable`). */
function refusalAppealsOff() {
  return (
    "**Appeals:** are turned off in this server — an admin can open them " +
    "with `/banappeals enable`. Until then this ban cannot be appealed " +
    "here. Nothing was filed."
  );
}

/**
 * One appeal per ban cycle (issue §1) — the row already exists. Status keys
 * the sentence so the user learns what actually happened to their appeal.
 * `status` comes from the database (a closed CHECK vocabulary), never from
 * user input.
 *
 * @param {string} status existing appeal status (filed|open|granted|denied|closed)
 */
function refusalAlreadyFiled(status) {
  if (status === "granted") {
    return (
      "**Appeal:** this ban's appeal was already **granted** — the ban was " +
      "lifted with clemency. Nothing was filed."
    );
  }
  if (status === "denied") {
    return (
      "**Appeal:** this ban's appeal was already **denied** — staff reviewed " +
      "it and the ban stands. Nothing was filed."
    );
  }
  if (status === "closed") {
    return (
      "**Appeal:** staff already ended this ban's appeal conversation " +
      "without a decision — the ban stands and one appeal per ban is all " +
      "this cycle gets. Nothing was filed."
    );
  }
  // filed / open: the review itself is in flight.
  return (
    "**Appeal:** an appeal for this ban already exists and staff can see it " +
    "— one appeal per ban, so press this again only after that one is " +
    "decided. Nothing was filed."
  );
}

/** Modal submitted without the required statement (belt under Discord's). */
function refusalMissingStatement() {
  return (
    `**${MODAL_LABEL_STATEMENT}:** is required — write what you want staff ` +
    "to consider before submitting. Nothing was filed."
  );
}

/** Statement over the stored cap (the modal clamps first; this is the belt). */
function refusalStatementTooLong(maxChars) {
  return (
    `**${MODAL_LABEL_STATEMENT}:** is too long (max ${maxChars} characters). ` +
    "Shorten it and submit again — nothing was filed."
  );
}

/**
 * A validation read failed (db/dependency). AGENTS.md error rule 3: the user
 * sees the CAUSE, not "check logs"; the caller logs the full context too.
 * @param {string} what short operation label (e.g. "ban record lookup")
 * @param {string} message the specific error message
 */
function refusalValidationFailed(what, message) {
  return (
    `Could not process the appeal (${what}): ${message} Nothing was filed.`
  );
}

module.exports = {
  LOG_PREFIX,
  BANAPPEALS_COMMAND,
  NOT_ON_FLUXER,
  // customId grammar
  APPEAL_PREFIX,
  MODAL_APPEAL_PREFIX,
  AP_TICKET_PREFIX,
  AP_CLEMENCY_PREFIX,
  AP_DENY_PREFIX,
  AP_DENY_MODAL_PREFIX,
  AP_PAUSE_PREFIX,
  // parsers
  parseAppealPressRecordId,
  parseModalAppealRecordId,
  parseTicketAppealId,
  // labels
  APPEAL_BUTTON_LABEL,
  APPEAL_MODAL_TITLE,
  MODAL_LABEL_STATEMENT,
  MODAL_FIELD_STATEMENT,
  BUTTON_LABEL_CLEMENCY,
  BUTTON_LABEL_DENY,
  BUTTON_LABEL_PAUSE,
  BUTTON_LABEL_RESUME,
  // ferry caps (tuned post-launch per issue §3)
  FERRY_ATTACHMENT_MAX_BYTES,
  FERRY_USER_COOLDOWN_MS,
  FERRY_USER_HOURLY_CAP,
  FERRY_CATCHUP_MAX,
  // refusal copy builders
  refusalNotYou,
  refusalNoRecord,
  refusalNotActive,
  refusalAppealsOff,
  refusalAlreadyFiled,
  refusalMissingStatement,
  refusalStatementTooLong,
  refusalValidationFailed,
};
