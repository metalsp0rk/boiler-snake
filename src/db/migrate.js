const {
  db,
  now,
  tableExists,
  getColumns,
  addColumnIfMissing,
  getPrimaryKeyColumns,
} = require("./connection");

const migrations = [
  require("./migrations/001_base_schema"),
  require("./migrations/002_guild_settings_columns"),
  require("./migrations/003_youtube_composite_pk"),
  require("./migrations/004_youtube_and_honeypot_columns"),
  require("./migrations/005_clamp_bad_xp"),
  require("./migrations/006_event_reminders"),
  require("./migrations/007_staff_notes"),
  require("./migrations/008_staff_roles"),
  require("./migrations/009_warnings"),
  require("./migrations/010_tickets"),
  require("./migrations/011_staff_role_levels"),
  require("./migrations/012_warn_log_channel"),
  require("./migrations/013_user_channel_activity"),
  require("./migrations/014_guild_activity_backfill"),
  require("./migrations/015_event_reminder_event_optouts"),
  require("./migrations/016_command_permission_oauth"),
  require("./migrations/017_event_reminder_persistent"),
  require("./migrations/018_warn_post_mvp"),
  require("./migrations/019_ticket_panels"),
  require("./migrations/020_twitch"),
  require("./migrations/021_gork"),
  require("./migrations/022_gork_access"),
  require("./migrations/023_gork_memory"),
  require("./migrations/024_staff_roles_added_by"),
  require("./migrations/025_github_releases"),
  require("./migrations/026_gork_budget"),
  require("./migrations/027_gork_interaction_log"),
  require("./migrations/028_web_sessions"),
  require("./migrations/029_admin_audit"),
  require("./migrations/030_web_session_tokens"),
  require("./migrations/031_gork_ste_enabled"),
  require("./migrations/032_twitch_eventsub_media"),
  require("./migrations/033_gork_summarize_input_tokens"),
  require("./migrations/034_communities"),
  require("./migrations/035_bridges"),
  require("./migrations/036_user_links"),
  require("./migrations/037_ticket_archive_claim"),
  require("./migrations/038_event_reminder_claim_state"),
  require("./migrations/039_encrypt_third_party_tokens"),
  require("./migrations/040_schema_hygiene"),
  require("./migrations/041_heal_partial_community_cutover"),
  require("./migrations/042_events_core"),
  require("./migrations/043_events_series_presets"),
  require("./migrations/044_event_channels_wizards"),
  require("./migrations/045_event_integrations"),
  require("./migrations/046_youtube_live_pointer"),
];

const helpers = {
  now,
  tableExists,
  getColumns,
  addColumnIfMissing,
  getPrimaryKeyColumns,
};

// ── Schema version tracking via PRAGMA user_version (audit-2026-10 #202) ──
// The model, deliberately minimal:
//   * The CORRECTNESS mechanism stays the FULL idempotent replay below: every
//     migration up() is gated (IF NOT EXISTS / addColumnIfMissing / detected
//     rebuilds), so replaying all of them on an applied DB is a no-op.
//   * `user_version` is only the RECORD of a completed full pass and the
//     fast-skip flag. After a successful pass we stamp it with the highest
//     registered version; the next boot sees a match and skips the replay.
//   * The version is the registry SIZE — migrations may only ever be
//     APPENDED to the list above (same rule as numbered migration files).
//   * Any other value runs the full replay: `0` is every pre-guard database
//     (all steps already applied but never recorded — replay is safe by the
//     idempotency contract above), and a partial version means a pass was
//     interrupted mid-way (exactly the 003-style non-transactional data-move
//     hazard 034 hardened against). We never trust a partial version to mean
//     "those steps ran cleanly"; we re-run the idempotent steps and re-stamp.
//   * A version HIGHER than this build knows means old code against a newer
//     DB — refuse to touch it and fail loudly with both numbers.
const LATEST_VERSION = migrations.length;

// ── Registry integrity (#278) ──
// Every migration must export a non-empty, unique `id`. The id is what
// failure logs and the downgrade guard name, and tests/tooling index the
// registry by it — a missing or colliding id makes those messages lie and
// lets a future append silently claim an id another entry already owns.
// This asserts the shape of the REGISTRY (not the DB), so it runs on every
// path through runMigrations(), the fast-skip included.
function assertRegistryIntegrity() {
  const seen = new Map();
  migrations.forEach((migration, index) => {
    const id = migration?.id;
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(
        `[db] Migration registry integrity: entry #${index + 1} exports no id — ` +
          `every migration must export \`id: "<NNN_name>"\` (see the neighbouring files).`
      );
    }
    if (seen.has(id)) {
      throw new Error(
        `[db] Migration registry integrity: duplicate id "${id}" (registry positions ` +
          `#${seen.get(id) + 1} and #${index + 1}) — ids must be unique.`
      );
    }
    seen.set(id, index);
  });
}

/** Current recorded schema version (`PRAGMA user_version`, 0 = never stamped). */
function readUserVersion() {
  return Number(db.pragma("user_version", { simple: true }));
}

/**
 * Run all migrations in order, recording the applied schema version.
 * Migrations are written to be idempotent (IF NOT EXISTS / addColumnIfMissing / gated rebuilds).
 *
 * @returns {{ skipped: boolean, version: number, latest: number }}
 *   `skipped` — the fast path ran because the DB already records the latest
 *   version; `version` — the version recorded after this call.
 */
function runMigrations() {
  assertRegistryIntegrity();
  const current = readUserVersion();

  if (current > LATEST_VERSION) {
    const newest = migrations[LATEST_VERSION - 1]?.id ?? `#${LATEST_VERSION}`;
    throw new Error(
      `[db] Schema version guard: database user_version=${current} is NEWER than the newest migration this build knows ` +
        `(version ${LATEST_VERSION} = ${newest}). This code is older than the database — running it would corrupt the newer schema. ` +
        `Upgrade the bot to a build that includes migration ${current}, or restore a database backup taken before it ran.`
    );
  }

  if (current === LATEST_VERSION) {
    console.log(
      `[db] Schema at version ${current}/${LATEST_VERSION} (user_version guard) — skipping migration replay`
    );
    return { skipped: true, version: current, latest: LATEST_VERSION };
  }

  for (const migration of migrations) {
    try {
      migration.up(db, helpers);
    } catch (err) {
      console.error(`[db] Migration ${migration.id} failed:`, err?.message || err);
      throw err;
    }
  }

  // Stamp AFTER the whole pass succeeds. A crash mid-pass leaves the old
  // (lower) version recorded, so the next boot replays the idempotent set
  // again instead of trusting a half-applied state.
  db.pragma(`user_version = ${LATEST_VERSION}`);
  console.log(
    `[db] Migrations applied (user_version ${current} -> ${LATEST_VERSION})`
  );
  return { skipped: false, version: LATEST_VERSION, latest: LATEST_VERSION };
}

module.exports = {
  runMigrations,
  readUserVersion,
  assertRegistryIntegrity,
  LATEST_VERSION,
  migrations,
};
