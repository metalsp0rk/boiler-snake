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
  // #458 (B2-9): this pass used to run BARE — a crash between the INSERT
  // and the DROP left youtube_channels_new behind, and the replay hit its
  // half-written rows with INSERT…SELECT (UNIQUE constraint failed) →
  // migration throw → boot loop until a human ran manual SQL. Every
  // crash-residue shape now heals, and the rebuild itself is atomic.
  if (tableExists("youtube_channels_new") && !tableExists("youtube_channels")) {
    // Died after the DROP, before the RENAME: the staged table IS the
    // data — completing the rename (single atomic statement) heals it.
    db.exec("ALTER TABLE youtube_channels_new RENAME TO youtube_channels");
    return;
  }
  if (!tableExists("youtube_channels")) return;

  const pkCols = getPrimaryKeyColumns("youtube_channels");
  // Fluxer PR 2: accept the post-034 shape too. Re-running this migration
  // after 034 renamed guild_id -> community_id must NOT rebuild the table
  // back to the guild-keyed schema (the "re-running migrations is safe"
  // unit test calls runMigrations() a second time).
  const hasComposite =
    pkCols.length >= 2 &&
    (pkCols.includes("guild_id") || pkCols.includes("community_id")) &&
    pkCols.includes("id");
  if (hasComposite) {
    // The rebuild already completed once — any leftover staging table is
    // worthless residue (and would collide with a future pass). Remove it.
    if (tableExists("youtube_channels_new")) db.exec("DROP TABLE youtube_channels_new");
    return;
  }

  // Old or unexpected PK shape → rebuild with composite key, in ONE
  // transaction (mirrors 034/040/041, which learned this after 003). The
  // unconditional drop clears crash residue from pre-fix installs.
  db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS youtube_channels_new");
    db.exec(`
CREATE TABLE youtube_channels_new (
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
  })();
}

module.exports = { id: "003_youtube_composite_pk", up };
