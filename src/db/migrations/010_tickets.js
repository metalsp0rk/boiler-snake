/**
 * Help ticket system: tickets, members, named staff, archived messages,
 * and guild_settings columns for category / archive channel / rate limit.
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "guild_settings",
    "ticket_category_id",
    "ticket_category_id TEXT"
  );
  addColumnIfMissing(
    "guild_settings",
    "ticket_archive_channel_id",
    "ticket_archive_channel_id TEXT"
  );
  addColumnIfMissing(
    "guild_settings",
    "ticket_rate_limit_minutes",
    "ticket_rate_limit_minutes INTEGER NOT NULL DEFAULT 60"
  );

  db.exec(`
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  ticket_number INTEGER NOT NULL,
  channel_id TEXT UNIQUE,
  creator_user_id TEXT NOT NULL,
  staff_owner_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  is_sensitive INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  close_reason TEXT,
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  closed_by_user_id TEXT,
  opened_by_staff_id TEXT,
  transcript_token TEXT UNIQUE,
  transcript_path TEXT,
  archive_message_id TEXT,
  ai_summary_json TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  UNIQUE (guild_id, ticket_number)
);
CREATE INDEX IF NOT EXISTS idx_tickets_guild_status
  ON tickets(guild_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_creator
  ON tickets(guild_id, creator_user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_creator_created
  ON tickets(guild_id, creator_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tickets_channel
  ON tickets(channel_id);

CREATE TABLE IF NOT EXISTS ticket_members (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  added_by TEXT,
  PRIMARY KEY (ticket_id, user_id)
);

CREATE TABLE IF NOT EXISTS ticket_staff (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  added_by TEXT,
  PRIMARY KEY (ticket_id, user_id)
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_tag TEXT NOT NULL,
  content TEXT,
  attachment_urls TEXT,
  embeds_json TEXT,
  sent_at INTEGER NOT NULL,
  UNIQUE (ticket_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket
  ON ticket_messages(ticket_id);
`);
}

module.exports = { id: "010_tickets", up };
