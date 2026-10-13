/**
 * Community events — event channels + DM-wizard drafts
 * (roadmap/community-events.md § Schema sketch + §12.3 event channels +
 * §12.6 DM creation wizard; epic #218).
 *
 *   event_channels   channels marked as event channels (sort/purge target;
 *                    purge defaults OFF per E7)
 *   event_wizards    one open DM-wizard draft per creator per community
 *                    (E15: resume on next /event wizard, one open at a time)
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function }} helpers
 */

const CREATE_EVENT_CHANNELS_SQL = `
CREATE TABLE IF NOT EXISTS event_channels (
  community_id INTEGER NOT NULL REFERENCES communities(id),
  channel_id TEXT NOT NULL,
  purge INTEGER NOT NULL DEFAULT 0,      -- E7: opt-in only
  created_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, channel_id)
);
`;

const CREATE_EVENT_WIZARDS_SQL = `
CREATE TABLE IF NOT EXISTS event_wizards (
  community_id INTEGER NOT NULL REFERENCES communities(id),
  user_id TEXT NOT NULL,
  event_id INTEGER,                      -- set in edit mode (re-enter at one question)
  step TEXT NOT NULL DEFAULT 'title',
  draft TEXT NOT NULL DEFAULT '{}',      -- JSON answers collected so far
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id)
);
`;

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function }} helpers
 * @returns {{ migrated: boolean }}
 */
function up(db, { tableExists }) {
  if (!tableExists("events")) {
    throw new Error(
      "044_event_channels_wizards: the 'events' table is missing — migration 042_events_core must run first",
    );
  }
  const run = db.transaction(() => {
    db.exec(CREATE_EVENT_CHANNELS_SQL);
    db.exec(CREATE_EVENT_WIZARDS_SQL);
  });
  run();
  return { migrated: true };
}

module.exports = { id: "044_event_channels_wizards", up };
