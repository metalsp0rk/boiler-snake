/**
 * Ticket report side records (#745).
 *
 * Context-menu "Report Post" / "Report User" create a staff-visible ticket
 * AND a one-row structured record beside it: the report kind (message|user),
 * the reported subject, the reported message + source channel (the
 * duplicate-open-report nudge, decision 12), whether the flow deleted the
 * original, and the reporter's modal context note. Keyed by ticket_id — one
 * ticket IS one report — and cascading with the parent ticket row: the
 * archive pipeline owns long-term evidence, this row is the lookup index.
 *
 * The partial index on reported_message_id serves the nudge query
 * (join to tickets, status='open', same community); user-kind rows carry
 * NULL there and stay out of the index (006/007/009 precedent).
 *
 * @param {import("better-sqlite3").Database} db
 */
function up(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS ticket_reports (
  ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('message','user')),
  subject_user_id TEXT NOT NULL,
  reported_message_id TEXT,
  source_channel_id TEXT,
  message_deleted INTEGER NOT NULL DEFAULT 0,
  snapshot_note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_reports_message
  ON ticket_reports(reported_message_id)
 WHERE reported_message_id IS NOT NULL;
`);
}

module.exports = { id: "066_ticket_reports", up };
