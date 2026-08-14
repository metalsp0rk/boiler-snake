/**
 * Ticket panel registry: store posted panels so they can be listed, edited, and deleted.
 */
function up(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS ticket_panels (
  guild_id     TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  title        TEXT,
  description  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (guild_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_panels_guild
  ON ticket_panels(guild_id);
`);
}

module.exports = { id: "019_ticket_panels", up };
