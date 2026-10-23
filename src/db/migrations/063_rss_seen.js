/**
 * Bounded per-feed seen-set for RSS entry dedup (issue #305).
 *
 * One row per (community, feed, entry key) already announced. The entry key
 * is the item's guid/id when present, else its permalink link (hashed when
 * very long) — decided by the repository, which is why the column is plain
 * TEXT: the schema guarantees uniqueness of whatever key the poller derived,
 * nothing more.
 *
 * The PRIMARY KEY IS the set semantics: membership checks and the poller's
 * "not seen yet" insert are single-key operations, and `INSERT OR IGNORE`
 * makes a concurrent/duplicate announce a no-op instead of a duplicate post.
 *
 * Bounded by contract: the repository prunes each (community, feed) group to
 * ~100 rows oldest-first after every poll. idx_rss_seen_feed_prune is exactly
 * that access path — the (community_id, feed_url, seen_at) order serves the
 * per-feed oldest-first DELETE scan without touching other feeds' rows (the
 * PK cannot: its trailing column is entry_key, not seen_at).
 *
 * `ON DELETE CASCADE` matches 062_rss_feeds — seen rows are meaningless
 * without their community, so the engine drops them with the parent; feed
 * removal itself is an explicit repository delete (child-then-parent, house
 * rule for everything the cascade cannot reach).
 *
 * `up` refuses to run without the `communities` table (034) — same guard as
 * 062_rss_feeds; seen rows are (community_id, …) rows and must never exist
 * unscoped.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function }} helpers
 * @returns {{ migrated: boolean }}
 */

const CREATE_RSS_SEEN_SQL = `
CREATE TABLE IF NOT EXISTS rss_seen (
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  feed_url     TEXT    NOT NULL,
  entry_key    TEXT    NOT NULL,
  seen_at      INTEGER NOT NULL,
  PRIMARY KEY (community_id, feed_url, entry_key)
);
`;

// Per-feed oldest-first prune path (see header); the PK lead already covers
// the community/feed prefix, so the value this index adds is the seen_at
// ordering inside one feed's group.
const RSS_SEEN_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_rss_seen_feed_prune
  ON rss_seen (community_id, feed_url, seen_at);
`;

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function }} helpers
 * @returns {{ migrated: boolean }}
 */
function up(db, { tableExists }) {
  if (!tableExists("communities")) {
    throw new Error(
      "063_rss_seen: the 'communities' table is missing — migration 034_communities must run first; " +
        "seen-set rows are (community_id, feed_url, entry_key) triples and must never be created unscoped",
    );
  }

  const run = db.transaction(() => {
    db.exec(CREATE_RSS_SEEN_SQL);
    db.exec(RSS_SEEN_INDEXES_SQL);
  });
  run();

  return { migrated: true };
}

module.exports = { id: "063_rss_seen", up };
