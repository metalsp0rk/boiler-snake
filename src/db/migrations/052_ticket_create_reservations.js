/**
 * Ticket-create slot reservations (#420, audit LT-3).
 *
 * The self-create rate limit was a check-then-act spanning the whole
 * channel-create REST round trip: two concurrent submits both read "no
 * recent ticket", both opened channels, and the member-facing abuse control
 * was bypassable at will (double-click, slash + panel modal). The claim is
 * now ONE statement — INSERT … ON CONFLICT DO UPDATE that only fires when no
 * live reservation exists for (community, user) — taken synchronously before
 * the first await, so a double-submit loses against the database instead of
 * both winning. A successful create keeps the row (the next claim replaces
 * it); a failed create releases exactly its own stamp, so a transient
 * channel-create failure never costs the user a wait they didn't use.
 *
 * @param {import("better-sqlite3").Database} db
 */
function up(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS ticket_create_reservations (
  community_id INTEGER NOT NULL REFERENCES communities(id),
  user_id TEXT NOT NULL,
  reserved_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id)
);
`);
}

module.exports = { id: "052_ticket_create_reservations", up };
