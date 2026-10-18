const { db, now } = require("../connection");

// src/platform/community.js requires the db facade (src/db/index.js), so a
// top-level require here would be a load-time cycle (partial exports). The
// lazy require resolves after boot; assertCommunityId stays single-source.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

/** Normalize YouTube @username to remove leading @ for consistent storage. */
function normalizeYoutubeName(name) {
  return name.startsWith("@") ? name.substring(1) : name;
}

function getYoutubeChannels(communityId) {
  assertCommunityId(communityId);
  return db.prepare(`
  SELECT id, community_id, channel_name, channel_url, thumbnail_url, last_video_id, last_live_id, last_checked, last_checked_at
  FROM youtube_channels
  WHERE community_id=?
  ORDER BY created_at ASC
  `).all(communityId);
}

function getAllYoutubeChannels() {
  return db.prepare(`
  SELECT id, community_id, channel_name, channel_url, thumbnail_url, last_video_id, last_live_id, last_checked, last_checked_at
  FROM youtube_channels
  ORDER BY created_at ASC
  `).all();
}

function getYoutubeChannelById(communityId, channelId) {
  assertCommunityId(communityId);
  const normalized = normalizeYoutubeName(channelId);
  return db.prepare(`
  SELECT id, community_id, channel_name, channel_url, thumbnail_url, last_video_id, last_live_id, last_checked, last_checked_at
  FROM youtube_channels
  WHERE community_id=? AND (id=? OR channel_url LIKE '%/' || ? || '/')
  `).get(communityId, normalized, normalized);
}

function addYoutubeChannel(communityId, channelId, channelName, channelUrl, thumbnailUrl) {
  assertCommunityId(communityId);
  const t = now();
  const normalizedId = normalizeYoutubeName(channelId);
  const normalizedChannelName = normalizeYoutubeName(channelName);

  const existing = getYoutubeChannelById(communityId, normalizedId);
  if (
    existing &&
    existing.channel_name === normalizedChannelName &&
    existing.channel_url === channelUrl
  ) {
    return existing;
  }

  const stmt = db.prepare(`
     INSERT INTO youtube_channels (id, community_id, channel_name, channel_url, thumbnail_url, last_video_id, last_checked, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT(community_id, channel_name) DO UPDATE SET
       id=excluded.id,
       channel_url=excluded.channel_url,
       thumbnail_url=excluded.thumbnail_url,
       updated_at=excluded.updated_at
   `);

  try {
    stmt.run(normalizedId, communityId, normalizedChannelName, channelUrl, thumbnailUrl || null, null, t, t);
  } catch (err) {
    console.error(`[youtube] DB error:`, err.message);
    throw err;
  }

  return getYoutubeChannelById(communityId, normalizedId);
}

function removeYoutubeChannel(communityId, channelId) {
  assertCommunityId(communityId);
  // #442 (audit INT-7): the old probe `SELECT changes()` yields a column
  // literally named "changes()", so `.changes` was undefined and this
  // returned FALSE EVEN WHEN THE DELETE LANDED. Both callers had to paper
  // over it with row-count diffs. Trust the run() result (the pattern the
  // twitch repo already uses).
  const res = db
    .prepare(`DELETE FROM youtube_channels WHERE community_id=? AND id=?`)
    .run(communityId, channelId);
  return res.changes > 0;
}

/**
 * Advance the watermark for ONE community's row. `youtube_channels` has a
 * composite PK (community_id, id): the same YouTube channel subscribed in
 * N communities is N rows sharing `id`, so the WHERE MUST stay community-
 * scoped (#377) — the old `WHERE id=?` let one guild's tick rewrite every
 * other guild's watermark, silently burning their pending uploads.
 */
function updateYoutubeChannelLastChecked(communityId, channelId, lastCheckedMs, lastVideoId) {
  assertCommunityId(communityId);
  const t = now();
  if (lastVideoId) {
    db.prepare(`
     UPDATE youtube_channels
     SET last_checked=?, last_video_id=?, updated_at=?
     WHERE community_id=? AND id=?
     `).run(lastCheckedMs, lastVideoId, t, communityId, channelId);
  } else {
    db.prepare(`
     UPDATE youtube_channels
     SET last_checked=?, updated_at=?
     WHERE community_id=? AND id=?
     `).run(lastCheckedMs, t, communityId, channelId);
  }
}

/**
 * Record the live stream whose alert was dispatched for ONE community's row
 * (#378). Live alerts get dedicated state because the shared
 * `last_video_id` pointer is also upload bookkeeping: one upload published
 * during a stream moves that pointer off the live entry, and the live entry
 * re-fired its @everyone alert every tick for the whole stream.
 */
function markYoutubeLiveNotified(communityId, channelId, liveVideoId) {
  assertCommunityId(communityId);
  const t = now();
  db.prepare(`
   UPDATE youtube_channels
   SET last_live_id=?, updated_at=?
   WHERE community_id=? AND id=?
  `).run(liveVideoId || null, t, communityId, channelId);
}

/**
 * Stamp the WALL-CLOCK moment this row was last swept by the ticker
 * (#379). This is the polling-interval gate's clock: `last_checked` is the
 * ordinal notification window (#380) and deliberately does not move on
 * quiet sweeps, so cadence needs its own column — nothing
 * notification-related is touched here.
 */
function markYoutubeChannelCheckedAt(communityId, channelId, checkedAtMs = now()) {
  assertCommunityId(communityId);
  const t = Number.isFinite(checkedAtMs) ? Math.trunc(checkedAtMs) : now();
  db.prepare(`
   UPDATE youtube_channels
   SET last_checked_at=?, updated_at=?
   WHERE community_id=? AND id=?
  `).run(t, t, communityId, channelId);
}

/** Cleanup malformed channel entries (non-UC/HC IDs from before normalization fix). */
function cleanupMalformedYoutubeChannels() {
  // #360 (DB-3): this used to DELETE every row whose id was not UC/HC —
  // exactly the storage shape of a pending @handle subscription, a
  // by-design product of `/youtube add` when the API cannot resolve. It
  // also ran as a hidden side effect of EVERY updateGuildSettings call, so
  // an unrelated /setcommandchannel silently unsubscribed users (no reply,
  // no audit). That call site is gone, and a sweep has nothing left to
  // legitimately delete: youtube_channels keeps ONE row per
  // (community, channel_name) — addYoutubeChannel REPLACES — so a
  // "superseded twin" of the same name cannot exist, a resolved row under a
  // different name is a DIFFERENT subscription, and unresolvable pending
  // rows are retried by the ticker (needsResolution), not debris.
  // Kept as an INERT export for facade parity (schema-hygiene-040 pins the
  // function); do NOT resurrect a predicate against non-UC ids.
}

module.exports = {
  normalizeYoutubeName,
  getYoutubeChannels,
  getAllYoutubeChannels,
  getYoutubeChannelById,
  addYoutubeChannel,
  removeYoutubeChannel,
  updateYoutubeChannelLastChecked,
  markYoutubeLiveNotified,
  markYoutubeChannelCheckedAt,
  cleanupMalformedYoutubeChannels,
};
