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
  SELECT id, community_id, channel_name, channel_url, thumbnail_url, last_video_id, last_checked
  FROM youtube_channels
  WHERE community_id=?
  ORDER BY created_at ASC
  `).all(communityId);
}

function getAllYoutubeChannels() {
  return db.prepare(`
  SELECT id, community_id, channel_name, channel_url, thumbnail_url, last_video_id, last_checked
  FROM youtube_channels
  ORDER BY created_at ASC
  `).all();
}

function getYoutubeChannelById(communityId, channelId) {
  assertCommunityId(communityId);
  const normalized = normalizeYoutubeName(channelId);
  return db.prepare(`
  SELECT id, community_id, channel_name, channel_url, thumbnail_url, last_video_id, last_checked
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
  db.prepare(`DELETE FROM youtube_channels WHERE community_id=? AND id=?`).run(communityId, channelId);
  return !!db.prepare(`SELECT changes()`).get().changes;
}

function updateYoutubeChannelLastChecked(channelId, lastCheckedMs, lastVideoId) {
  const t = now();
  if (lastVideoId) {
    db.prepare(`
     UPDATE youtube_channels
     SET last_checked=?, last_video_id=?, updated_at=?
     WHERE id=?
     `).run(lastCheckedMs, lastVideoId, t, channelId);
  } else {
    db.prepare(`
     UPDATE youtube_channels
     SET last_checked=?, updated_at=?
     WHERE id=?
     `).run(lastCheckedMs, t, channelId);
  }
}

function cleanupOldNotifications(thresholdDays = 30) {
  const cutoff = now() - thresholdDays * 24 * 60 * 60 * 1000;
  db.prepare(`DELETE FROM youtube_channels WHERE last_checked < ?`).run(cutoff);
}

/** Cleanup malformed channel entries (non-UC/HC IDs from before normalization fix). */
function cleanupMalformedYoutubeChannels() {
  const rows = db
    .prepare(
      "SELECT community_id, channel_name FROM youtube_channels WHERE NOT id LIKE 'UC%' AND NOT id LIKE 'HC%'"
    )
    .all();

  if (!rows.length) return;

  console.log(`[youtube] Cleaning up ${rows.length} malformed channel entries...`);

  for (const row of rows) {
    db.prepare("DELETE FROM youtube_channels WHERE community_id=? AND channel_name=?").run(
      row.community_id,
      row.channel_name
    );
  }
}

module.exports = {
  normalizeYoutubeName,
  getYoutubeChannels,
  getAllYoutubeChannels,
  getYoutubeChannelById,
  addYoutubeChannel,
  removeYoutubeChannel,
  updateYoutubeChannelLastChecked,
  cleanupOldNotifications,
  cleanupMalformedYoutubeChannels,
};
