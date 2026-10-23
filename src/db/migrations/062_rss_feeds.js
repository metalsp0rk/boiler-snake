/**
 * RSS feed subscriptions per community (issue #305).
 *
 * One row per (community, feed URL): the subscription itself plus the poll
 * state the ticker advances in place — the conditional-GET validators (`etag`
 * / `last_modified`), the watermark pair (`last_entry_key` / `last_checked`),
 * and the per-feed failure counter driving exponential backoff. The same URL
 * in two communities is two independent rows, which is exactly why the PK is
 * (community_id, url) and not the URL alone.
 *
 * The DDL is issue #305's, verbatim (`IF NOT EXISTS` is already in the spec
 * block — the house idempotency rule, migrations re-run on every boot).
 * Unlike 035/042's documentation-only `REFERENCES`, the spec asks for a REAL
 * `ON DELETE CASCADE` here: when a community row goes, its feed subscriptions
 * are meaningless, and the engine may drop them with the parent (foreign_keys
 * is ON for every connection since #202).
 *
 * `failure_count` is NOT NULL DEFAULT 0 on purpose: backoff math multiplies
 * off it every poll, so a NULL would silently poison the gate arithmetic.
 *
 * `up` refuses to run without the `communities` table (034): feeds are
 * (community_id, url) rows and must never be created unscoped — the same
 * mis-ordering guard 035_bridges / 036_user_links / 042_events_core enforce.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function }} helpers
 * @returns {{ migrated: boolean }}
 */

const CREATE_RSS_FEEDS_SQL = `
CREATE TABLE IF NOT EXISTS rss_feeds (
  community_id   INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  url            TEXT    NOT NULL,
  display_name   TEXT,
  feed_title     TEXT,
  feed_link      TEXT,
  etag           TEXT,
  last_modified  TEXT,
  last_entry_key TEXT,
  last_checked   INTEGER,
  failure_count  INTEGER NOT NULL DEFAULT 0,
  added_by       TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (community_id, url)
);
`;

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: Function }} helpers
 * @returns {{ migrated: boolean }}
 */
function up(db, { tableExists }) {
  if (!tableExists("communities")) {
    throw new Error(
      "062_rss_feeds: the 'communities' table is missing — migration 034_communities must run first; " +
        "feeds are (community_id, url) rows and must never be created unscoped",
    );
  }

  const run = db.transaction(() => {
    db.exec(CREATE_RSS_FEEDS_SQL);
  });
  run();

  return { migrated: true };
}

module.exports = { id: "062_rss_feeds", up };
