/**
 * OAuth tokens for Discord application command permission sync
 * (applications.commands.permissions.update Bearer flow).
 */

/**
 * @param {import("better-sqlite3").Database} database
 */
function up(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS guild_command_permission_oauth (
      guild_id TEXT PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      access_token TEXT,
      access_expires_at INTEGER,
      authorized_by_user_id TEXT,
      last_sync_at INTEGER,
      last_sync_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

module.exports = { up };
