/**
 * Archive-claim marker for the ticket archive pipeline (audit-2026-10 #197).
 *
 * `tickets.archived` was read-then-written without CAS: two concurrent
 * closes/transitions could both pass the `archived === 0` check and both do
 * the archive work (double transcript embeds, double DMs, double channel
 * deletes). The archive gets a dedicated claim column instead of reusing
 * `archived`:
 *
 *  - `archived` keeps its exact meaning for every existing reader (web
 *    transcript routes/index require archived + transcript_token, /ticket
 *    list, gork open-ticket blackout, the sensitive invariant that sensitive
 *    rows never carry archived=1) — those semantics are pinned by tests
 *    (e.g. "closeTicketArchived without transcript path sets archived=0"),
 *    so the flag cannot double as the mid-work claim marker;
 *  - `archive_claimed_at` is internal to the pipeline: the first caller flips
 *    it from NULL (claimTicketArchive), every later caller no-ops.
 *
 * Additive nullable column only — `001_base_schema` stays frozen; fresh DBs
 * get the column when this migration runs (convention per 031/034).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "tickets",
    "archive_claimed_at",
    "archive_claimed_at INTEGER"
  );
}

module.exports = { id: "037_ticket_archive_claim", up };
