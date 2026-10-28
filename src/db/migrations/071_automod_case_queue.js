/**
 * Auto-moderation MODERATION-QUEUE columns (#771, epic #723).
 *
 * The automod channel becomes an explicit queue: one card per reported
 * message with the reporter anonymous until staff reveal them, a per-case
 * read window captured on the referral modal, and three mutually exclusive
 * case-level resolutions. Every fact the queue renders or enforces lives ON
 * the case row (068/070 family) — the card is a projection of these columns
 * plus the ledger rows, never a second source of truth.
 *
 * Column notes (documented per the issue):
 *  - `required_context`   — the modal's optional "what the reviewer needs
 *                           to see or know" text, verbatim case input for
 *                           the harness (sibling of `note`, which the modal
 *                           now fills as the REQUIRED problem statement).
 *  - `read_before` /
 *    `read_after`         — the read window ACTUALLY used for this case
 *                           (integer message counts, each 0–500; the modal
 *                           defaults are 100 back / 20 forward). NULL on
 *                           rows created before #771: those keep the
 *                           historical Gork-owned 40/10 (caseContext.js
 *                           resolves the effective window).
 *  - `message_snippet`    — single-line content excerpt of the anchor
 *                           message captured at intake (card "**Reported
 *                           message:**" line; the jump link is derived from
 *                           channel_id/message_id, the body is not stored
 *                           anywhere else).
 *  - `incident_summary`   — the harness's closing plain-text decision
 *                           estimate for the case card's "What happened"
 *                           line (card "**What happened:**"). Written by
 *                           the harness metadata writer only (070 posture:
 *                           the run owns its own run-metadata columns).
 *  - `revealed_at` /
 *    `revealed_by_user_id`— reporter anonymity: while `revealed_at` IS NULL
 *                           the queue never shows `referrer_user_id`; the
 *                           first staff Reveal press stamps it (single-
 *                           winner UPDATE — idempotent re-presses audit
 *                           nothing).
 *  - `resolved_at` /
 *    `resolution` /
 *    `resolved_by_user_id`— the case-level resolution (first valid staff
 *                           click wins; single-winner UPDATE). Vocabulary
 *                           'recommended' | 'manual' | 'none' is enforced
 *                           by the repository (CHECK-free add-column
 *                           posture; same law as the status vocabulary).
 *
 * Posture: pure `addColumnIfMissing` appends (065/067/070 family) —
 * idempotent replay is a no-op and old rows read every new column as NULL
 * (pre-#771 cases are simply unrevealed, unresolved, and legacy-windowed).
 * The 068-order guard mirrors the 070 guard.
 *
 * @param {import("better-sqlite3").Database} _db
 * @param {{ tableExists: Function, getColumns: Function, addColumnIfMissing: Function }} helpers
 */
function up(_db, { tableExists, addColumnIfMissing }) {
  if (!tableExists("automod_cases")) {
    throw new Error(
      "071_automod_case_queue: the 'automod_cases' table is missing — migration 068_automod_cases must run first; " +
        "the queue columns are columns ON the case row and can never exist without it",
    );
  }
  addColumnIfMissing("automod_cases", "required_context", "required_context TEXT");
  addColumnIfMissing("automod_cases", "read_before", "read_before INTEGER");
  addColumnIfMissing("automod_cases", "read_after", "read_after INTEGER");
  addColumnIfMissing("automod_cases", "message_snippet", "message_snippet TEXT");
  addColumnIfMissing("automod_cases", "incident_summary", "incident_summary TEXT");
  addColumnIfMissing("automod_cases", "revealed_at", "revealed_at INTEGER");
  addColumnIfMissing("automod_cases", "revealed_by_user_id", "revealed_by_user_id TEXT");
  addColumnIfMissing("automod_cases", "resolved_at", "resolved_at INTEGER");
  addColumnIfMissing("automod_cases", "resolution", "resolution TEXT");
  addColumnIfMissing("automod_cases", "resolved_by_user_id", "resolved_by_user_id TEXT");
}

module.exports = { id: "071_automod_case_queue", up };
