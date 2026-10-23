const { db, now } = require("../connection");

// src/platform/community.js requires the db facade (src/db/index.js), so a
// top-level require here would be a load-time cycle (partial exports). The
// lazy require resolves after boot; assertCommunityId stays single-source.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

/**
 * Bounded per-feed seen-set cap (issue #305): every feed group is pruned to
 * the ~100 newest entry keys after each poll. Mirrors migration 063's
 * contract comment — the bound is a repository guarantee, not a schema one.
 */
const SEEN_CAP = 100;

const SELECT_COLUMNS = `
  community_id, url, display_name, feed_title, feed_link,
  etag, last_modified, last_entry_key, last_checked,
  failure_count, added_by, created_at, updated_at
`;

/**
 * Feed URLs are validated CANONICALLY by the command layer (scheme check,
 * SSRF guard, parse) before they ever reach this repository. The repo only
 * trims and rejects empties: SQLite's PK is case-sensitive, so the repo must
 * store exactly what the validator approved — no lowercasing surprises that
 * would make `getFeed` disagree with `addFeed`.
 */
function normalizeFeedUrl(url) {
  const s = String(url ?? "").trim();
  if (!s) throw new Error("rss feed url required");
  return s;
}

function normalizeEntryKey(entryKey) {
  const s = String(entryKey ?? "").trim();
  if (!s) throw new Error("rss entry key required");
  return s;
}

/** Coerce a wall-clock ms stamp; anything non-finite becomes null (clear). */
function toStampMs(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// ---------------------------------------------------------------------------
// Feed subscriptions
// ---------------------------------------------------------------------------

/**
 * Subscribe a community to a feed URL (issue #305). Watermarks/validators
 * start NULL and `failure_count` takes the schema DEFAULT 0 — the first poll
 * (per the ticker's first-hour rule) seeds everything else.
 *
 * Re-adding the SAME (community, url) is a REFUSAL, not an upsert: /rss add
 * must tell staff "already subscribed" instead of silently resetting poll
 * state. Distinguishability comes from the return shape: `null` = duplicate
 * (caller replies), a stored row = inserted/refreshed read, a thrown error =
 * real DB failure. The same URL in another community is an independent row
 * (that is what the composite PK is for).
 *
 * @param {number} communityId
 * @param {string} url
 * @param {{ displayName?: string|null, feedTitle?: string|null, feedLink?: string|null, addedBy?: string|null }} [meta]
 * @returns {object|null} the stored row, or null when already subscribed
 */
function addFeed(communityId, url, meta = {}) {
  assertCommunityId(communityId);
  const cleanUrl = normalizeFeedUrl(url);
  const t = now();

  if (getFeed(communityId, cleanUrl)) return null;

  try {
    db.prepare(`
    INSERT INTO rss_feeds
      (community_id, url, display_name, feed_title, feed_link, added_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      communityId,
      cleanUrl,
      meta.displayName ?? null,
      meta.feedTitle ?? null,
      meta.feedLink ?? null,
      meta.addedBy ?? null,
      t,
      t,
    );
  } catch (err) {
    // #442 posture: log with the identifying ids so the failure is
    // reproducible from logs alone, then rethrow — the handler surfaces the
    // cause to the user (services never swallow into a generic reply).
    console.error(`[rss] addFeed DB error (community=${communityId}):`, err.message);
    throw err;
  }
  return getFeed(communityId, cleanUrl);
}

/**
 * Unsubscribe: child-then-parent house rule. rss_seen carries no FK to
 * rss_feeds (only to communities), so the community CASCADE cannot reach the
 * feed's seen rows — the removal explicitly deletes them with the feed row
 * or they would linger invisible until the community itself goes.
 *
 * @param {number} communityId
 * @returns {boolean} true when a feed row was deleted
 */
function removeFeed(communityId, url) {
  assertCommunityId(communityId);
  const cleanUrl = normalizeFeedUrl(url);
  db.prepare(
    `DELETE FROM rss_seen WHERE community_id=? AND feed_url=?`,
  ).run(communityId, cleanUrl);
  const res = db
    .prepare(`DELETE FROM rss_feeds WHERE community_id=? AND url=?`)
    .run(communityId, cleanUrl);
  return res.changes > 0;
}

/**
 * @param {number} communityId
 * @returns {object|null} one feed row, scoped to THIS community (composite
 *   PK #377 posture: every feed read/write is community-scoped)
 */
function getFeed(communityId, url) {
  assertCommunityId(communityId);
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM rss_feeds WHERE community_id=? AND url=?`)
    .get(communityId, normalizeFeedUrl(url));
  return row || null;
}

/** @returns {boolean} */
function feedExists(communityId, url) {
  return getFeed(communityId, url) !== null;
}

/** Subscription rows for one community (/rss list, feed: autocomplete). */
function listFeedsForCommunity(communityId) {
  assertCommunityId(communityId);
  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM rss_feeds WHERE community_id=? ORDER BY created_at ASC, url ASC`,
    )
    .all(communityId);
}

/**
 * ALL subscription rows across every community — the ticker's single query
 * (youtube's getAllYoutubeChannels shape: one read, then the per-community
 * interval gate and the per-feed backoff math run in the CALLER). Skips
 * cleanly via `[]` when nothing is subscribed anywhere; no per-community
 * scan.
 */
function listAllFeeds() {
  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM rss_feeds ORDER BY community_id, created_at ASC, url ASC`,
    )
    .all();
}

/** Per-community subscription count for the RSS_MAX_FEEDS_PER_COMMUNITY cap check. */
function countFeedsForCommunity(communityId) {
  assertCommunityId(communityId);
  return db
    .prepare(`SELECT COUNT(*) AS n FROM rss_feeds WHERE community_id=?`)
    .get(communityId).n;
}

// ---------------------------------------------------------------------------
// Poll state: conditional-GET validators, watermark, backoff counter
// ---------------------------------------------------------------------------

/**
 * Shared shape for the watermark/failure ops. Each field is tri-state:
 *   undefined → leave the column alone
 *   null      → clear it
 *   value     → store it (lastChecked coerced to an integer ms stamp)
 */
function buildFetchStateSet(fields) {
  const sets = [];
  const params = {};
  for (const [key, column] of [
    ["etag", "etag"],
    ["lastModified", "last_modified"],
    ["lastEntryKey", "last_entry_key"],
  ]) {
    if (fields[key] !== undefined) {
      sets.push(`${column}=@${column}`);
      params[column] = fields[key] === null ? null : String(fields[key]);
    }
  }
  if (fields.lastChecked !== undefined) {
    sets.push("last_checked=@last_checked");
    params.last_checked = toStampMs(fields.lastChecked);
  }
  return { sets, params };
}

/**
 * Advance the fetch state (etag / last-modified validators, entry watermark,
 * last-checked clock) WITHOUT touching the failure counter — e.g. the 304
 * path where the spec says "advance last_checked only".
 *
 * @param {number} communityId
 * @param {{ etag?: string|null, lastModified?: string|null, lastEntryKey?: string|null, lastChecked?: number|null }} fields
 * @returns {object|null} refreshed row, or null when the feed is gone
 */
function updateFeedWatermark(communityId, url, fields = {}) {
  assertCommunityId(communityId);
  const cleanUrl = normalizeFeedUrl(url);
  const { sets, params } = buildFetchStateSet(fields);
  if (!sets.length) return getFeed(communityId, cleanUrl);

  params.community_id = communityId;
  params.url = cleanUrl;
  params.updated_at = now();
  db.prepare(`
  UPDATE rss_feeds
  SET ${sets.join(", ")}, updated_at=@updated_at
  WHERE community_id=@community_id AND url=@url
  `).run(params);
  return getFeed(communityId, cleanUrl);
}

/**
 * One successful poll: reset the backoff counter to 0, stamp the poll clock,
 * and (optionally) advance the validators/watermark in the SAME write.
 *
 * @param {number} communityId
 * @param {{ etag?: string|null, lastModified?: string|null, lastEntryKey?: string|null, lastChecked?: number }} [fields]
 *   lastChecked defaults to now() (mirror of markYoutubeChannelCheckedAt —
 *   the polling gate needs the clock stamped on success too)
 * @returns {object|null} refreshed row, or null when the feed is gone
 */
function recordFeedSuccess(communityId, url, fields = {}) {
  assertCommunityId(communityId);
  const cleanUrl = normalizeFeedUrl(url);
  const { sets, params } = buildFetchStateSet({
    ...fields,
    lastChecked: fields.lastChecked ?? now(),
  });

  sets.unshift("failure_count=0");
  params.community_id = communityId;
  params.url = cleanUrl;
  params.updated_at = now();
  db.prepare(`
  UPDATE rss_feeds
  SET ${sets.join(", ")}, updated_at=@updated_at
  WHERE community_id=@community_id AND url=@url
  `).run(params);
  return getFeed(communityId, cleanUrl);
}

/**
 * One failed poll: increment the consecutive-failure counter (the ticker
 * derives the exponential backoff window from it — base ×2, cap 6h — that
 * math lives in the feature layer, not here) and stamp the poll clock so the
 * retry gate counts from THIS failure. Validators and the watermark stay
 * untouched: a failed fetch invalidates nothing.
 *
 * @param {number} communityId
 * @param {{ lastChecked?: number }} [fields] lastChecked defaults to now()
 * @returns {object|null} refreshed row, or null when the feed is gone
 */
function recordFeedFailure(communityId, url, fields = {}) {
  assertCommunityId(communityId);
  const cleanUrl = normalizeFeedUrl(url);
  const t =
    fields.lastChecked !== undefined ? toStampMs(fields.lastChecked) : now();
  db.prepare(`
  UPDATE rss_feeds
  SET failure_count=failure_count+1, last_checked=?, updated_at=?
  WHERE community_id=? AND url=?
  `).run(t, now(), communityId, cleanUrl);
  return getFeed(communityId, cleanUrl);
}

// ---------------------------------------------------------------------------
// Bounded per-feed seen-set
// ---------------------------------------------------------------------------

/**
 * Mark one entry key as announced. INSERT OR IGNORE: the PK IS the set
 * semantics, so a replayed/duplicate announce is a no-op, not a duplicate
 * post. Returns whether THIS call inserted the row — the poller uses false as
 * "someone already announced it, skip the send".
 *
 * @param {number} communityId
 * @param {number} [seenAt] injectable clock for tests/backdating
 * @returns {boolean} true when newly seen (row inserted)
 */
function addSeenEntry(communityId, feedUrl, entryKey, seenAt = now()) {
  assertCommunityId(communityId);
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO rss_seen (community_id, feed_url, entry_key, seen_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      communityId,
      normalizeFeedUrl(feedUrl),
      normalizeEntryKey(entryKey),
      toStampMs(seenAt) ?? now(),
    );
  return res.changes > 0;
}

/** @returns {boolean} */
function isSeenEntry(communityId, feedUrl, entryKey) {
  assertCommunityId(communityId);
  const row = db
    .prepare(
      `SELECT 1 FROM rss_seen WHERE community_id=? AND feed_url=? AND entry_key=?`,
    )
    .get(communityId, normalizeFeedUrl(feedUrl), normalizeEntryKey(entryKey));
  return !!row;
}

/**
 * The feed's current seen-set as plain key strings (caller: `new Set(...)`
 * then diff the fetched entries). Ordered oldest-first for stability.
 * @returns {string[]}
 */
function listSeenKeysForFeed(communityId, feedUrl) {
  assertCommunityId(communityId);
  return db
    .prepare(
      `SELECT entry_key FROM rss_seen
       WHERE community_id=? AND feed_url=?
       ORDER BY seen_at ASC, entry_key ASC`,
    )
    .all(communityId, normalizeFeedUrl(feedUrl))
    .map((r) => r.entry_key);
}

/**
 * Enforce the bounded set: delete the OLDEST rows (seen_at ASC, entry_key
 * tie-break) beyond `cap` for ONE feed group only. idx_rss_seen_feed_prune
 * is exactly this access path.
 *
 * @param {number} communityId
 * @param {number} [cap] kept-newest rows; floored at 1 (a 0/NaN cap would
 *   empty the set and re-open every entry to a re-post)
 * @returns {number} rows deleted
 */
function pruneSeenForFeed(communityId, feedUrl, cap = SEEN_CAP) {
  assertCommunityId(communityId);
  const cleanUrl = normalizeFeedUrl(feedUrl);
  const keep = Number.isFinite(Number(cap)) ? Math.max(1, Math.floor(Number(cap))) : SEEN_CAP;

  const { n } = db
    .prepare(`SELECT COUNT(*) AS n FROM rss_seen WHERE community_id=? AND feed_url=?`)
    .get(communityId, cleanUrl);
  const excess = n - keep;
  if (excess <= 0) return 0;

  const res = db
    .prepare(
      `DELETE FROM rss_seen
        WHERE community_id=? AND feed_url=?
          AND entry_key IN (
            SELECT entry_key FROM rss_seen
             WHERE community_id=? AND feed_url=?
             ORDER BY seen_at ASC, entry_key ASC
             LIMIT ?
          )`,
    )
    .run(communityId, cleanUrl, communityId, cleanUrl, excess);
  return res.changes;
}

/**
 * Drop a feed's ENTIRE seen-set (feed removal bookkeeping; also available to
 * a future "resubscribe re-baseline" caller). removeFeed already calls it.
 * @returns {number} rows deleted
 */
function clearSeenForFeed(communityId, feedUrl) {
  assertCommunityId(communityId);
  const res = db
    .prepare(`DELETE FROM rss_seen WHERE community_id=? AND feed_url=?`)
    .run(communityId, normalizeFeedUrl(feedUrl));
  return res.changes;
}

module.exports = {
  SEEN_CAP,
  addFeed,
  removeFeed,
  getFeed,
  feedExists,
  listFeedsForCommunity,
  listAllFeeds,
  countFeedsForCommunity,
  updateFeedWatermark,
  recordFeedSuccess,
  recordFeedFailure,
  addSeenEntry,
  isSeenEntry,
  listSeenKeysForFeed,
  pruneSeenForFeed,
  clearSeenForFeed,
};
