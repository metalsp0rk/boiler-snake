/**
 * Legacy installs had youtube_channels PK on `id` only.
 * Modern schema uses PRIMARY KEY (guild_id, id).
 *
 * Only recreates the table when the old single-column PK is detected —
 * avoids rewriting youtube_channels on every startup.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function, getPrimaryKeyColumns: Function }} helpers
 */
function up(db, { tableExists, getPrimaryKeyColumns }) {
  if (!tableExists("youtube_channels")) return;

  const pkCols = getPrimaryKeyColumns("youtube_channels");
  const hasComposite =
    pkCols.length >= 2 && pkCols.includes("guild_id") && pkCols.includes("id");
  if (hasComposite) return;

  // Old or unexpected PK shape → rebuild with composite key
  db.exec(`
CREATE TABLE IF NOT EXISTS youtube_channels_new (
  guild_id TEXT NOT NULL,
  id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  channel_url TEXT NOT NULL,
  thumbnail_url TEXT,
  last_video_id TEXT,
  last_checked INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, id),
  UNIQUE(guild_id, channel_name)
);
`);

  db.prepare(`INSERT INTO youtube_channels_new SELECT * FROM youtube_channels`).run();
  db.prepare(`DROP TABLE youtube_channels`).run();
  db.prepare(`ALTER TABLE youtube_channels_new RENAME TO youtube_channels`).run();
}

module.exports = { id: "003_youtube_composite_pk", up };
