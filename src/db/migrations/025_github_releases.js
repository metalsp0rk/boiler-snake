/**
 * GitHub release notifications: per-guild watched repositories.
 * @param {import("better-sqlite3").Database} db
 */
function up(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS github_watches (
    guild_id                  TEXT NOT NULL,
    repo                      TEXT NOT NULL,
    repo_display              TEXT NOT NULL,
    channel_id                TEXT,
    role_id                   TEXT,
    token                     TEXT,
    last_release_id           INTEGER,
    last_release_published_at INTEGER,
    last_checked              INTEGER,
    created_at                INTEGER NOT NULL,
    updated_at                INTEGER NOT NULL,
    PRIMARY KEY (guild_id, repo)
  );
  CREATE INDEX IF NOT EXISTS idx_github_watches_channel
    ON github_watches(channel_id);
  `);
}

module.exports = { id: "025_github_releases", up };
