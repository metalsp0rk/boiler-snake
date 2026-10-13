/**
 * Community events — phase 5 integrations
 * (roadmap/community-events.md §12.5 + § Schema sketch; epic #218).
 *
 *   event_google_links         per (community, user) Google OAuth tokens —
 *                              AES-256-GCM `v1.` envelope (core/tokenCrypto,
 *                              TOKEN_ENCRYPTION_KEY), never plaintext, never
 *                              in the repo. Auto-sync owner lives on
 *                              event_guild_settings.google_auto_user_id.
 *   event_crossposts           one guild posts one of its events into another
 *                              guild only after the DESTINATION guild approved
 *                              (state machine pending → active → revoked;
 *                              revoking from either side stops future posts
 *                              and leaves messages already sent).
 *   event_crosspost_messages   the destination copy of one event (one signup
 *                              list lives on the SOURCE event; destination
 *                              buttons route to it).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function }} helpers
 */

const CREATE_EVENT_GOOGLE_LINKS_SQL = `
CREATE TABLE IF NOT EXISTS event_google_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL REFERENCES communities(id),
  user_id TEXT NOT NULL,
  email TEXT,
  calendar_id TEXT NOT NULL DEFAULT 'primary',
  access_token_enc TEXT NOT NULL,        -- v1. envelope; never plaintext
  refresh_token_enc TEXT,                -- null for short-lived/manual grants
  expiry INTEGER,                        -- access-token expiry (ms)
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (community_id, user_id)
);
`;

const CREATE_EVENT_CROSSPOSTS_SQL = `
CREATE TABLE IF NOT EXISTS event_crossposts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_community_id INTEGER NOT NULL REFERENCES communities(id),
  dest_community_id INTEGER NOT NULL REFERENCES communities(id),
  dest_channel_id TEXT,                  -- where approved posts land
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'active', 'revoked')),
  invite_code TEXT NOT NULL UNIQUE,      -- destination approves with this
  mentions TEXT NOT NULL DEFAULT '[]',   -- per-destination announce role ids (JSON)
  role_whitelist TEXT NOT NULL DEFAULT '[]', -- signups in the destination copy
  post_offset_minutes INTEGER NOT NULL DEFAULT 0, -- shift the post time per destination
  created_by TEXT,
  approved_by TEXT,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  revoked_at INTEGER,
  UNIQUE (source_community_id, dest_community_id)
);
`;

const CREATE_EVENT_CROSSPOST_MESSAGES_SQL = `
CREATE TABLE IF NOT EXISTS event_crosspost_messages (
  crosspost_id INTEGER NOT NULL REFERENCES event_crossposts(id),
  event_id INTEGER NOT NULL REFERENCES events(id),
  dest_community_id INTEGER NOT NULL,
  dest_channel_id TEXT NOT NULL,
  dest_message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (crosspost_id, event_id)
);
`;

const EVENT_INTEGRATION_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_event_crossposts_state
  ON event_crossposts (dest_community_id, state);
CREATE INDEX IF NOT EXISTS idx_event_crosspost_messages_event
  ON event_crosspost_messages (event_id);
`;

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function }} helpers
 * @returns {{ migrated: boolean }}
 */
function up(db, { tableExists }) {
  if (!tableExists("events")) {
    throw new Error(
      "045_event_integrations: the 'events' table is missing — migration 042_events_core must run first",
    );
  }
  const run = db.transaction(() => {
    db.exec(CREATE_EVENT_GOOGLE_LINKS_SQL);
    db.exec(CREATE_EVENT_CROSSPOSTS_SQL);
    db.exec(CREATE_EVENT_CROSSPOST_MESSAGES_SQL);
    db.exec(EVENT_INTEGRATION_INDEXES_SQL);
  });
  run();
  return { migrated: true };
}

module.exports = { id: "045_event_integrations", up };
