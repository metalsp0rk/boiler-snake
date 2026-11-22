/**
 * #905 item 6 (audit r4 F10f-a) — an age stamp for IN-FLIGHT outbox sends.
 *
 * `requeueStaleOutbox` healed `sending → pending` with NO age floor. Safe
 * only because its sole caller is boot recovery (a single-process crash
 * means every 'sending' row IS dead). The first live sweeper to call it
 * would re-queue rows a worker is actively sending — duplicate relays of
 * real traffic. The table had no send-start timestamp at all, so an age
 * floor was unexpressible; `enqueued_at` is the WRONG witness (a row
 * queued long ago that just entered its send is exactly the live case).
 *
 * `sending_at` numbers every claim (claimOutboxRow stamps it; a requeue
 * clears it). Rows claimed by a pre-migration build carry NULL — no live
 * sender can own one (old builds are gone by definition), so the age
 * floor reads them as stale. Boot recovery passes an explicit
 * `olderThanMs: 0` (its single-process crash law: everything 'sending' is
 * dead, regardless of age); the floor only bites the future sweeper.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "bridge_outbox",
    "sending_at",
    "sending_at INTEGER",
  );
}

module.exports = { id: "082_bridge_sending_at", up };
