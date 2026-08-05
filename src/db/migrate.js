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
];

const helpers = {
  now,
  tableExists,
  getColumns,
  addColumnIfMissing,
  getPrimaryKeyColumns,
};

/**
 * Run all migrations in order.
 * Migrations are written to be idempotent (IF NOT EXISTS / addColumnIfMissing / gated rebuilds).
 */
function runMigrations() {
  for (const migration of migrations) {
    try {
      migration.up(db, helpers);
    } catch (err) {
      console.error(`[db] Migration ${migration.id} failed:`, err?.message || err);
      throw err;
    }
  }
}

module.exports = {
  runMigrations,
  migrations,
};
