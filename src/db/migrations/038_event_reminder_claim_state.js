/**
 * Real delivery-state machine for event-reminder offsets (audit-2026-10 H12, #196).
 *
 * `sent_at IS NULL` conflated "not sent", "can't send" and "sent", the ticker
 * did no atomic claim (two tickers could both deliver the same offset), a
 * missing channel was re-claimed every minute forever, and a transient
 * guild-fetch failure permanently discarded the reminder via
 * `markReminderSent(null)`. The offsets table gets explicit state:
 *
 *  - `status`            pending → sending (claimed) → sent | retired | failed
 *                        (retired: notify channel is gone / unsendable —
 *                        terminal on FIRST detection, never re-claimed;
 *                        failed: transient failures exhausted MAX_REMINDER_ATTEMPTS)
 *  - `attempts`          transient-failure count driving the backoff curve
 *  - `next_attempt_at`  earliest claim time for a pending row; NULL → `fire_at`
 *                        (COALESCE keeps pre-migration rows behaving identically)
 *  - `claimed_at`        lease stamp for 'sending'; older than the claim TTL
 *                        (ticker re-claims — crashed sender recovers)
 *  - `last_error`        why the row is retired/failed/retrying (ops forensics)
 *
 * Additive columns with defaults that preserve current rows' behavior
 * (convention per 037); rows already carrying `sent_at` are backfilled to
 * `sent` so they can never be re-claimed. Idempotent per the migration
 * contract (addColumnIfMissing / IF NOT EXISTS / plain UPDATE).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "event_reminder_offsets",
    "status",
    "status TEXT NOT NULL DEFAULT 'pending'"
  );
  addColumnIfMissing(
    "event_reminder_offsets",
    "attempts",
    "attempts INTEGER NOT NULL DEFAULT 0"
  );
  addColumnIfMissing(
    "event_reminder_offsets",
    "next_attempt_at",
    "next_attempt_at INTEGER"
  );
  addColumnIfMissing(
    "event_reminder_offsets",
    "claimed_at",
    "claimed_at INTEGER"
  );
  addColumnIfMissing(
    "event_reminder_offsets",
    "last_error",
    "last_error TEXT"
  );

  // Backfill: a row that was already delivered is terminal, not "pending".
  db.exec(
    `UPDATE event_reminder_offsets SET status='sent' WHERE sent_at IS NOT NULL`
  );

  // Claim-queue index: only rows a ticker can pick up are indexed.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_event_reminder_claimable
      ON event_reminder_offsets(status, next_attempt_at, fire_at)
      WHERE status IN ('pending','sending')
  `);
}

module.exports = { id: "038_event_reminder_claim_state", up };
