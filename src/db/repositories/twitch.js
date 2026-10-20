const { db, now } = require("../connection");

// src/platform/community.js requires the db facade (src/db/index.js), so a
// top-level require here would be a load-time cycle (partial exports). The
// lazy require resolves after boot; assertCommunityId stays single-source.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

/**
 * Normalize a Twitch login: lowercase, strip URL prefixes and query strings.
 * Accepts "twitch.tv/foo", "https://twitch.tv/foo/videos", "@foo", "foo".
 * @param {string} login
 * @returns {string}
 */
function normalizeTwitchLogin(login) {
  let s = String(login || "").trim().toLowerCase();
  s = s.replace(/^@/, "");
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.replace(/^twitch\.tv\//, "");
  s = s.split(/[/?#]/)[0];
  return s;
}

const SELECT_COLUMNS = `
  community_id, broadcaster_id, login, display_name, profile_image_url,
  is_live, last_stream_id, last_checked,
  notify_clips, notify_vods,
  last_clip_id, last_clip_created_at,
  last_video_id, last_video_created_at,
  notify_channel_id, notify_role_id
`;

function getTwitchChannels(communityId) {
  assertCommunityId(communityId);
  return db.prepare(`
  SELECT ${SELECT_COLUMNS}
  FROM twitch_channels
  WHERE community_id=?
  ORDER BY created_at ASC
  `).all(communityId);
}

function getAllTwitchChannels() {
  return db.prepare(`
  SELECT ${SELECT_COLUMNS}
  FROM twitch_channels
  ORDER BY created_at ASC
  `).all();
}

function getTwitchChannel(communityId, loginOrBroadcasterId) {
  assertCommunityId(communityId);
  const normalized = normalizeTwitchLogin(loginOrBroadcasterId);
  const row = db.prepare(`
  SELECT ${SELECT_COLUMNS}
  FROM twitch_channels
  WHERE community_id=? AND (login=? OR broadcaster_id=?)
  `).get(communityId, normalized, normalized);
  return row || null;
}

/**
 * Every community subscription tracking a broadcaster (across all communities).
 * Used by the EventSub callback (one event fans out to every community that
 * subscribed) and by subscription pruning (delete only when no community still
 * tracks the broadcaster).
 * @param {string} broadcasterId
 */
function getTwitchSubsByBroadcaster(broadcasterId) {
  return db.prepare(`
  SELECT ${SELECT_COLUMNS}
  FROM twitch_channels
  WHERE broadcaster_id=?
  ORDER BY created_at ASC
  `).all(String(broadcasterId));
}

/**
 * Subscribe a community to a broadcaster (upsert by login).
 * @param {number} communityId
 * @returns {object} the stored row
 */
function addTwitchChannel(
  communityId,
  broadcasterId,
  login,
  displayName,
  profileImageUrl,
) {
  assertCommunityId(communityId);
  const t = now();
  const normalizedLogin = normalizeTwitchLogin(login);
  const stmt = db.prepare(`
  INSERT INTO twitch_channels
    (community_id, broadcaster_id, login, display_name, profile_image_url,
     is_live, last_stream_id, last_checked, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)
  ON CONFLICT(community_id, login) DO UPDATE SET
    broadcaster_id=excluded.broadcaster_id,
    display_name=excluded.display_name,
    profile_image_url=COALESCE(excluded.profile_image_url, twitch_channels.profile_image_url),
    updated_at=excluded.updated_at
  `);
  stmt.run(
    communityId,
    broadcasterId,
    normalizedLogin,
    displayName,
    profileImageUrl || null,
    t,
    t,
  );
  return getTwitchChannel(communityId, normalizedLogin);
}

/**
 * @param {number} communityId
 * @returns {boolean} true if a row was deleted
 */
function removeTwitchChannel(communityId, loginOrBroadcasterId) {
  assertCommunityId(communityId);
  const normalized = normalizeTwitchLogin(loginOrBroadcasterId);
  const res = db
    .prepare(
      "DELETE FROM twitch_channels WHERE community_id=? AND (login=? OR broadcaster_id=?)",
    )
    .run(communityId, normalized, normalized);
  return res.changes > 0;
}

/**
 * Update live/stream state for a subscription.
 * @param {number} communityId
 */
function updateTwitchChannelLiveState(
  communityId,
  broadcasterId,
  { isLive, lastStreamId, lastChecked },
) {
  assertCommunityId(communityId);
  const t = now();
  db.prepare(`
  UPDATE twitch_channels
  SET is_live=?, last_stream_id=?, last_checked=?, updated_at=?
  WHERE community_id=? AND broadcaster_id=?
  `).run(
    isLive ? 1 : 0,
    lastStreamId ?? null,
    lastChecked ?? null,
    t,
    communityId,
    broadcasterId,
  );
}

/**
 * Toggle per-subscription clips/VODs notifications. Enabling a feed seeds
 * its dedup watermark to now when it is NULL — opting in must not replay
 * history published before the opt-in. Disabling KEEPS the watermark so a
 * re-enable can't flood with everything published while it was off.
 * The caller passes the desired state for BOTH flags (the row has one
 * UPDATE). Returns the refreshed row, or null when the sub is gone.
 *
 * @param {number} communityId
 * @param {string} broadcasterId
 * @param {{ notifyClips: boolean, notifyVods: boolean }} flags
 */
function setTwitchChannelMediaFlags(communityId, broadcasterId, { notifyClips, notifyVods }) {
  assertCommunityId(communityId);
  const t = now();
  const current = db
    .prepare(
      `SELECT notify_clips, notify_vods, last_clip_created_at, last_video_created_at
       FROM twitch_channels WHERE community_id=? AND broadcaster_id=?`,
    )
    .get(communityId, broadcasterId);
  if (!current) return null;

  const clipWatermark =
    notifyClips && current.last_clip_created_at == null
      ? t
      : current.last_clip_created_at;
  const vodWatermark =
    notifyVods && current.last_video_created_at == null
      ? t
      : current.last_video_created_at;

  db.prepare(`
  UPDATE twitch_channels
  SET notify_clips=?, notify_vods=?,
      last_clip_created_at=?, last_video_created_at=?, updated_at=?
  WHERE community_id=? AND broadcaster_id=?
  `).run(
    notifyClips ? 1 : 0,
    notifyVods ? 1 : 0,
    clipWatermark,
    vodWatermark,
    t,
    communityId,
    broadcasterId,
  );
  return getTwitchChannel(communityId, broadcasterId);
}

/**
 * Advance the clips watermark after a poll (id kept for observability only;
 * the numeric ms stamp drives dedup).
 * @param {number} communityId
 */
function updateTwitchChannelClipState(
  communityId,
  broadcasterId,
  { lastClipId, lastClipCreatedAt },
) {
  assertCommunityId(communityId);
  const t = now();
  db.prepare(`
  UPDATE twitch_channels
  SET last_clip_id=?, last_clip_created_at=?, updated_at=?
  WHERE community_id=? AND broadcaster_id=?
  `).run(
    lastClipId ?? null,
    lastClipCreatedAt ?? null,
    t,
    communityId,
    broadcasterId,
  );
}

/** Advance the VODs watermark after a poll (same semantics as the clips one).
 * @param {number} communityId
 */
function updateTwitchChannelVideoState(
  communityId,
  broadcasterId,
  { lastVideoId, lastVideoCreatedAt },
) {
  assertCommunityId(communityId);
  const t = now();
  db.prepare(`
  UPDATE twitch_channels
  SET last_video_id=?, last_video_created_at=?, updated_at=?
  WHERE community_id=? AND broadcaster_id=?
  `).run(
    lastVideoId ?? null,
    lastVideoCreatedAt ?? null,
    t,
    communityId,
    broadcasterId,
  );
}

/**
 * Set / clear the per-subscription notification-target overrides (issue #177).
 * Each argument independently:
 *   undefined → leave unchanged
 *   null      → clear (fall back to the guild-wide default)
 *   non-blank string → set the override
 * Blank/whitespace strings are coerced to clear (a picker never yields one,
 * but the repo must not store an empty id). Returns the refreshed row, or
 * null when the subscription is gone.
 *
 * @param {number} communityId
 * @param {string} broadcasterId
 * @param {{ channelId?: string|null, roleId?: string|null }} targets
 */
function setTwitchChannelNotifyTargets(communityId, broadcasterId, targets) {
  assertCommunityId(communityId);
  const current = db
    .prepare(
      `SELECT notify_channel_id, notify_role_id
       FROM twitch_channels WHERE community_id=? AND broadcaster_id=?`,
    )
    .get(communityId, broadcasterId);
  if (!current) return null;

  const clean = (v) => {
    if (v === undefined) return undefined; // leave
    if (v === null) return null; // clear
    const s = String(v).trim();
    return s || null;
  };

  const channelId = clean(targets?.channelId);
  const roleId = clean(targets?.roleId);
  const sets = [];
  const params = {};
  if (channelId !== undefined) {
    sets.push("notify_channel_id=@channel_id");
    params.channel_id = channelId;
  }
  if (roleId !== undefined) {
    sets.push("notify_role_id=@role_id");
    params.role_id = roleId;
  }
  if (!sets.length) return getTwitchChannel(communityId, broadcasterId);

  params.broadcaster_id = broadcasterId;
  params.community_id = communityId;
  params.updated_at = now();
  db.prepare(`
  UPDATE twitch_channels
  SET ${sets.join(", ")}, updated_at=@updated_at
  WHERE community_id=@community_id AND broadcaster_id=@broadcaster_id
  `).run(params);
  return getTwitchChannel(communityId, broadcasterId);
}

/**
 * Atomically claim an offline→live transition for a subscription. Reads the
 * prior stream id and writes the new live state in one synchronous section
 * (better-sqlite3 is sync + Node is single-threaded, so no other callback —
 * e.g. the EventSub webhook vs. the poller — can interleave between them).
 * Always refreshes is_live/last_checked; returns whether this CALLER observed
 * a NEW stream id (so exactly one caller notifies) PLUS the previous
 * watermark, so a failed send can release the claim (#447).
 *
 * @param {number} communityId
 * @returns {{ isNew: boolean, previousStreamId: string|null }}
 */
function claimTwitchStream(communityId, broadcasterId, streamId) {
  assertCommunityId(communityId);
  const t = now();
  const row = db
    .prepare(
      "SELECT last_stream_id FROM twitch_channels WHERE community_id=? AND broadcaster_id=?",
    )
    .get(communityId, broadcasterId);
  const isNew = !!row && row.last_stream_id !== streamId;
  const previousStreamId = row ? row.last_stream_id : null;
  db.prepare(`
  UPDATE twitch_channels
  SET is_live=1, last_stream_id=?, last_checked=?, updated_at=?
  WHERE community_id=? AND broadcaster_id=?
  `).run(streamId ?? null, t, t, communityId, broadcasterId);
  return { isNew, previousStreamId };
}

/**
 * #447 (audit INT-12): release a go-live claim whose notification send
 * FAILED (or was impossible — no notify channel configured), so the next
 * tick re-claims and retries instead of silently burning the stream
 * forever. Compare-and-release: it only restores when the watermark is
 * STILL the claimed id, so a concurrent EventSub/poller claim for a newer
 * stream is never trampled.
 *
 * @returns {boolean} true when the claim was actually released
 */
function releaseTwitchStreamClaim(
  communityId,
  broadcasterId,
  claimedStreamId,
  restoreStreamId,
) {
  assertCommunityId(communityId);
  if (!claimedStreamId) return false;
  const info = db
    .prepare(
      `UPDATE twitch_channels
          SET last_stream_id=?, updated_at=?
        WHERE community_id=? AND broadcaster_id=? AND last_stream_id=?`,
    )
    .run(restoreStreamId ?? null, now(), communityId, broadcasterId, claimedStreamId);
  return info.changes > 0;
}

/**
 * Atomically claim a live→offline transition. Always refreshes state;
 * returns whether the subscription was actually live before (so a caller can
 * log/announce the go-offline exactly once).
 * @param {number} communityId
 * @returns {boolean}
 */
function claimTwitchOffline(communityId, broadcasterId) {
  assertCommunityId(communityId);
  const t = now();
  const row = db
    .prepare("SELECT is_live FROM twitch_channels WHERE community_id=? AND broadcaster_id=?")
    .get(communityId, broadcasterId);
  const wasLive = !!row && row.is_live === 1;
  db.prepare(`
  UPDATE twitch_channels
  SET is_live=0, last_checked=?, updated_at=?
  WHERE community_id=? AND broadcaster_id=?
  `).run(t, t, communityId, broadcasterId);
  return wasLive;
}

module.exports = {
  normalizeTwitchLogin,
  getTwitchChannels,
  getAllTwitchChannels,
  getTwitchChannel,
  releaseTwitchStreamClaim,
  getTwitchSubsByBroadcaster,
  addTwitchChannel,
  removeTwitchChannel,
  updateTwitchChannelLiveState,
  claimTwitchStream,
  claimTwitchOffline,
  setTwitchChannelMediaFlags,
  setTwitchChannelNotifyTargets,
  updateTwitchChannelClipState,
  updateTwitchChannelVideoState,
};
