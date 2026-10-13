/**
 * Community events core schema (roadmap/community-events.md § Schema sketch,
 * phase 1+2 of epic #218) — bot-owned events with button RSVP:
 *
 *   events                one bot-owned event (draft → posted → archived)
 *   event_options         per-event signup options (label/emoji/capacity/…)
 *   event_signups         one row per (event, option, user) held by a member
 *   event_notifications       per-event reminder rows with the SAME claim state
 *                         machine feature 2 shipped in 038 (pending → sending
 *                         → sent | failed | retired, attempts/backoff)
 *   event_mutes           per-event user mute (bot-owned events; keyed by OUR
 *                         event id — feature 2's event_reminder_event_optouts
 *                         is keyed by a Discord scheduled-event id instead)
 *   event_guild_settings  per-community defaults (reminder interval, role
 *                         gates, auto-archive, digest, google auto-sync)
 *   event_activity        per-event activity log; written from phase 1 so the
 *                         phase-4 dashboard is not empty on day one
 *
 * Guild opt-out is NOT here: E14 shares feature 2's `event_reminder_optouts`
 * row so one flag silences both systems during the overlap.
 *
 * `REFERENCES` clauses document intent only (house rule since 034/035): every
 * delete path is an explicit child-then-parent transaction in
 * src/db/repositories/events.js, never a bare parent delete.
 *
 * `up` refuses to run without the `communities` table (034): events are
 * (community_id, …) rows and must never be created unscoped.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function }} helpers
 */

const CREATE_EVENTS_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL REFERENCES communities(id),
  creator_id TEXT NOT NULL,              -- organizer's external user id
  channel_id TEXT,                       -- post target (Discord snowflake)
  message_id TEXT,                       -- set once posted
  thread_id TEXT,                        -- event thread, once it exists
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,                         -- text/address or channel mention
  start_at INTEGER NOT NULL,             -- ms UTC (E3: stored instant is UTC)
  end_at INTEGER,                        -- ms UTC; start + duration
  duration_minutes INTEGER,
  image_url TEXT,
  color INTEGER,                         -- embed color, null = theme default
  announce_role_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array of role ids
  attendee_role_id TEXT,                 -- role that means "signed up" (E6)
  attendee_role_existing TEXT,           -- existing role id (phase 3 role_mode)
  role_mode TEXT NOT NULL DEFAULT 'temp'
    CHECK (role_mode IN ('none', 'temp', 'existing')),
  series_id INTEGER,                     -- set when this is a series occurrence
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_confirm', 'posted', 'archived', 'skipped')),
  -- 'pending_confirm' = /event create preview awaiting its Confirm button (E3);
  -- 'draft' = persistent author-side draft (web save-draft, /event adopt);
  -- 'skipped' = series occurrence the organizer skipped.
  post_at INTEGER,                       -- scheduled post time (phase 3); null = now/confirm
  post_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,               -- scheduled-post backoff
  last_post_error TEXT,
  cutoff_at INTEGER,                     -- signup cutoff (null = start_at)
  role_whitelist TEXT NOT NULL DEFAULT '[]', -- event-level whitelist (JSON); [] = anyone
  multiple_signups INTEGER NOT NULL DEFAULT 0,
  thread_enabled INTEGER NOT NULL DEFAULT 1,
  thread_private INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const CREATE_EVENT_OPTIONS_SQL = `
CREATE TABLE IF NOT EXISTS event_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  label TEXT NOT NULL,
  emoji TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER NOT NULL DEFAULT 0,   -- 0 = unlimited
  waitlist_on INTEGER NOT NULL DEFAULT 1,
  reminders_on INTEGER NOT NULL DEFAULT 0, -- E6: "attending" bit
  role_whitelist TEXT NOT NULL DEFAULT '[]' -- JSON array; [] = anyone
);
`;

const CREATE_EVENT_SIGNUPS_SQL = `
CREATE TABLE IF NOT EXISTS event_signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  option_id INTEGER NOT NULL REFERENCES event_options(id),
  user_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('signed_up', 'waitlisted')),
  created_at INTEGER NOT NULL,
  updated_by TEXT,                       -- who flipped the row (self/organizer)
  UNIQUE (event_id, option_id, user_id)
);
`;

const CREATE_EVENT_REMINDERS_SQL = `
CREATE TABLE IF NOT EXISTS event_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  offset_minutes INTEGER NOT NULL,       -- minutes before start
  fire_at INTEGER NOT NULL,              -- absolute ms; rewritten on time move
  message TEXT,                          -- custom body (phase 2), null = default
  target TEXT NOT NULL DEFAULT 'attendees'
    CHECK (target IN ('attendees', 'role')),
  role_id TEXT,                          -- set when target = 'role'
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'retired')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,               -- backoff gate (null → fire_at)
  claimed_at INTEGER,                    -- sending-claim TTL anchor
  sent_at INTEGER,
  message_id TEXT,                       -- delivered message id
  last_error TEXT
);
`;

const CREATE_EVENT_MUTES_SQL = `
CREATE TABLE IF NOT EXISTS event_mutes (
  community_id INTEGER NOT NULL REFERENCES communities(id),
  event_id INTEGER NOT NULL REFERENCES events(id),
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, event_id, user_id)
);
`;

const CREATE_EVENT_GUILD_SETTINGS_SQL = `
CREATE TABLE IF NOT EXISTS event_guild_settings (
  community_id INTEGER PRIMARY KEY REFERENCES communities(id),
  default_reminder_minutes INTEGER NOT NULL DEFAULT 15,
  show_attendees INTEGER NOT NULL DEFAULT 1,
  time_zone TEXT NOT NULL DEFAULT 'UTC',  -- IANA zone for naive time entry (E3)
  create_role_id TEXT,                   -- E4 role gates; null = no extra role
  edit_role_id TEXT,
  delete_role_id TEXT,
  channels_role_id TEXT,
  options_role_id TEXT,
  thread_reminders INTEGER NOT NULL DEFAULT 1,
  reminder_channel_id TEXT,              -- fallback when no thread
  auto_archive INTEGER NOT NULL DEFAULT 0,   -- E8: default OFF
  auto_archive_delay_minutes INTEGER NOT NULL DEFAULT 120,
  digest_channel_id TEXT,
  digest_frequency TEXT NOT NULL DEFAULT 'none'
    CHECK (digest_frequency IN ('none', 'daily', 'weekly')),
  digest_hour_utc INTEGER NOT NULL DEFAULT 18,
  digest_weekday INTEGER NOT NULL DEFAULT 1, -- 0=Sun (weekly digests)
  digest_last_sent_at INTEGER,           -- once-per-window gate for the ticker
  google_auto_user_id TEXT,              -- phase 5 auto-sync owner
  google_auto_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
`;

const CREATE_EVENT_ACTIVITY_SQL = `
CREATE TABLE IF NOT EXISTS event_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  actor_id TEXT,                         -- who (null = system/ticker)
  action TEXT NOT NULL,                  -- created/posted/edited/signup/…
  detail TEXT,
  created_at INTEGER NOT NULL
);
`;

const EVENT_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_events_community ON events (community_id, status, start_at);
CREATE INDEX IF NOT EXISTS idx_events_post_due ON events (status, post_at);
CREATE INDEX IF NOT EXISTS idx_events_post_retry ON events (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_event_options_event ON event_options (event_id, position);
CREATE INDEX IF NOT EXISTS idx_event_signups_state ON event_signups (event_id, state);
CREATE INDEX IF NOT EXISTS idx_event_signups_user ON event_signups (event_id, user_id);
CREATE INDEX IF NOT EXISTS idx_event_notifications_due
  ON event_notifications (status, next_attempt_at, fire_at);
CREATE INDEX IF NOT EXISTS idx_event_activity_event ON event_activity (event_id, created_at);
`;

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function }} helpers
 * @returns {{ migrated: boolean }}
 */
function up(db, { tableExists }) {
  if (!tableExists("communities")) {
    throw new Error(
      "042_events_core: the 'communities' table is missing — migration 034_communities must run first; " +
        "events are (community_id, …) rows and must never be created unscoped",
    );
  }

  const run = db.transaction(() => {
    db.exec(CREATE_EVENTS_SQL);
    db.exec(CREATE_EVENT_OPTIONS_SQL);
    db.exec(CREATE_EVENT_SIGNUPS_SQL);
    db.exec(CREATE_EVENT_REMINDERS_SQL);
    db.exec(CREATE_EVENT_MUTES_SQL);
    db.exec(CREATE_EVENT_GUILD_SETTINGS_SQL);
    db.exec(CREATE_EVENT_ACTIVITY_SQL);
    db.exec(EVENT_INDEXES_SQL);
  });
  run();

  return { migrated: true };
}

module.exports = { id: "042_events_core", up };
