/**
 * Community events — recurring series + signup presets
 * (roadmap/community-events.md § Schema sketch; phase 2–3 of epic #218).
 *
 *   event_series           cadence + end condition + next occurrence cursor
 *   event_presets          guild-saved signup-option groups (by name)
 *   event_preset_options   the stored options of one preset
 *
 * A series never stores occurrence rows: occurrences are materialized
 * forward-only when `next_occurrence_at` fires (recurrence.js owns the math).
 * Deleting a series leaves posted occurrences as one-off events (their
 * `events.series_id` is cleared by the repository), matching the design's
 * "deleting the series leaves posted occurrences" rule.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function }} helpers
 */

const CREATE_EVENT_SERIES_SQL = `
CREATE TABLE IF NOT EXISTS event_series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL REFERENCES communities(id),
  template_event_id INTEGER NOT NULL REFERENCES events(id), -- occurrence that seeded the series
  cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly', 'monthly')),
  weekdays TEXT NOT NULL DEFAULT '[]',   -- weekly: JSON array of 0=Sun…6=Sat
  month_day INTEGER,                     -- monthly: 1–31, clamped to month length
  time_of_day_min INTEGER NOT NULL,      -- minutes after 00:00 UTC (E3: UTC instants)
  end_mode TEXT NOT NULL DEFAULT 'never'
    CHECK (end_mode IN ('never', 'count', 'until')),
  end_count INTEGER,                     -- end_mode=count: total occurrences
  end_at INTEGER,                        -- end_mode=until: last allowed start instant (ms)
  occurrences_created INTEGER NOT NULL DEFAULT 0,
  next_occurrence_at INTEGER,            -- cursor (ms); null + active = compute on demand
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  stopped_at INTEGER
);
`;

const CREATE_EVENT_PRESETS_SQL = `
CREATE TABLE IF NOT EXISTS event_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL REFERENCES communities(id),
  name TEXT NOT NULL COLLATE NOCASE,     -- case-insensitive: UNIQUE + lookup
  created_by TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (community_id, name)
);
`;

const CREATE_EVENT_PRESET_OPTIONS_SQL = `
CREATE TABLE IF NOT EXISTS event_preset_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preset_id INTEGER NOT NULL REFERENCES event_presets(id),
  label TEXT NOT NULL,
  emoji TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER NOT NULL DEFAULT 0,
  waitlist_on INTEGER NOT NULL DEFAULT 1,
  reminders_on INTEGER NOT NULL DEFAULT 0,
  role_whitelist TEXT NOT NULL DEFAULT '[]'
);
`;

const EVENT_SERIES_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_event_series_community ON event_series (community_id, status);
CREATE INDEX IF NOT EXISTS idx_event_series_due ON event_series (status, next_occurrence_at);
CREATE INDEX IF NOT EXISTS idx_event_preset_options_preset ON event_preset_options (preset_id, position);
`;

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function }} helpers
 * @returns {{ migrated: boolean }}
 */
function up(db, { tableExists }) {
  if (!tableExists("events")) {
    throw new Error(
      "043_events_series_presets: the 'events' table is missing — migration 042_events_core must run first",
    );
  }
  const run = db.transaction(() => {
    db.exec(CREATE_EVENT_SERIES_SQL);
    db.exec(CREATE_EVENT_PRESETS_SQL);
    db.exec(CREATE_EVENT_PRESET_OPTIONS_SQL);
    db.exec(EVENT_SERIES_INDEXES_SQL);
  });
  run();
  return { migrated: true };
}

module.exports = { id: "043_events_series_presets", up };
