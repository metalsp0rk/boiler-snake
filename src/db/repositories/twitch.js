const { db, now } = require("../connection");

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
  guild_id, broadcaster_id, login, display_name, profile_image_url,
  is_live, last_stream_id, last_checked,
  notify_clips, notify_vods,
  last_clip_id, last_clip_created_at,
  last_video_id, last_video_created_at
`;

function getTwitchChannels(guildId) {
  return db.prepare(`
  SELECT ${SELECT_COLUMNS}
  FROM twitch_channels
  WHERE guild_id=?
  ORDER BY created_at ASC
  `).all(guildId);
}

function getAllTwitchChannels() {
  return db.prepare(`
  SELECT ${SELECT_COLUMNS}
  FROM twitch_channels
  ORDER BY created_at ASC
  `).all();
}

function getTwitchChannel(guildId, loginOrBroadcasterId) {
  const normalized = normalizeTwitchLogin(loginOrBroadcasterId);
  const row = db.prepare(`
  SELECT ${SELECT_COLUMNS}
  FROM twitch_channels
  WHERE guild_id=? AND (login=? OR broadcaster_id=?)
  `).get(guildId, normalized, normalized);
  return row || null;
}

/**
 * Every guild subscription tracking a broadcaster (across all guilds).
 * Used by the EventSub callback (one event fans out to every guild that
 * subscribed) and by subscription pruning (delete only when no guild still
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
 * Subscribe a guild to a broadcaster (upsert by login).
 * @returns {object} the stored row
 */
function addTwitchChannel(
  guildId,
  broadcasterId,
  login,
  displayName,
  profileImageUrl,
) {
  const t = now();
  const normalizedLogin = normalizeTwitchLogin(login);
  const stmt = db.prepare(`
  INSERT INTO twitch_channels
    (guild_id, broadcaster_id, login, display_name, profile_image_url,
     is_live, last_stream_id, last_checked, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)
  ON CONFLICT(guild_id, login) DO UPDATE SET
    broadcaster_id=excluded.broadcaster_id,
    display_name=excluded.display_name,
    profile_image_url=COALESCE(excluded.profile_image_url, twitch_channels.profile_image_url),
    updated_at=excluded.updated_at
  `);
  stmt.run(
    guildId,
    broadcasterId,
    normalizedLogin,
    displayName,
    profileImageUrl || null,
    t,
    t,
  );
  return getTwitchChannel(guildId, normalizedLogin);
}

/**
 * @returns {boolean} true if a row was deleted
 */
function removeTwitchChannel(guildId, loginOrBroadcasterId) {
  const normalized = normalizeTwitchLogin(loginOrBroadcasterId);
  const res = db
    .prepare(
      "DELETE FROM twitch_channels WHERE guild_id=? AND (login=? OR broadcaster_id=?)",
    )
    .run(guildId, normalized, normalized);
  return res.changes > 0;
}

/**
 * Update live/stream state for a subscription.
 */
function updateTwitchChannelLiveState(
  guildId,
  broadcasterId,
  { isLive, lastStreamId, lastChecked },
) {
  const t = now();
  db.prepare(`
  UPDATE twitch_channels
  SET is_live=?, last_stream_id=?, last_checked=?, updated_at=?
  WHERE guild_id=? AND broadcaster_id=?
  `).run(
    isLive ? 1 : 0,
    lastStreamId ?? null,
    lastChecked ?? null,
    t,
    guildId,
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
 * @param {string} guildId
 * @param {string} broadcasterId
 * @param {{ notifyClips: boolean, notifyVods: boolean }} flags
 */
function setTwitchChannelMediaFlags(guildId, broadcasterId, { notifyClips, notifyVods }) {
  const t = now();
  const current = db
    .prepare(
      `SELECT notify_clips, notify_vods, last_clip_created_at, last_video_created_at
       FROM twitch_channels WHERE guild_id=? AND broadcaster_id=?`,
    )
    .get(guildId, broadcasterId);
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
  WHERE guild_id=? AND broadcaster_id=?
  `).run(
    notifyClips ? 1 : 0,
    notifyVods ? 1 : 0,
    clipWatermark,
    vodWatermark,
    t,
    guildId,
    broadcasterId,
  );
  return getTwitchChannel(guildId, broadcasterId);
}

/**
 * Advance the clips watermark after a poll (id kept for observability only;
 * the numeric ms stamp drives dedup).
 */
function updateTwitchChannelClipState(
  guildId,
  broadcasterId,
  { lastClipId, lastClipCreatedAt },
) {
  const t = now();
  db.prepare(`
  UPDATE twitch_channels
  SET last_clip_id=?, last_clip_created_at=?, updated_at=?
  WHERE guild_id=? AND broadcaster_id=?
  `).run(
    lastClipId ?? null,
    lastClipCreatedAt ?? null,
    t,
    guildId,
    broadcasterId,
  );
}

/** Advance the VODs watermark after a poll (same semantics as the clips one). */
function updateTwitchChannelVideoState(
  guildId,
  broadcasterId,
  { lastVideoId, lastVideoCreatedAt },
) {
  const t = now();
  db.prepare(`
  UPDATE twitch_channels
  SET last_video_id=?, last_video_created_at=?, updated_at=?
  WHERE guild_id=? AND broadcaster_id=?
  `).run(
    lastVideoId ?? null,
    lastVideoCreatedAt ?? null,
    t,
    guildId,
    broadcasterId,
  );
}

/**
 * Atomically claim an offline→live transition for a subscription. Reads the
 * prior stream id and writes the new live state in one synchronous section
 * (better-sqlite3 is sync + Node is single-threaded, so no other callback —
 * e.g. the EventSub webhook vs. the poller — can interleave between them).
 * Always refreshes is_live/last_checked; returns whether this CALLER observed
 * a NEW stream id (so exactly one caller notifies).
 *
 * @returns {boolean} true when last_stream_id actually changed to `streamId`
 */
function claimTwitchStream(guildId, broadcasterId, streamId) {
  const t = now();
  const row = db
    .prepare(
      "SELECT last_stream_id FROM twitch_channels WHERE guild_id=? AND broadcaster_id=?",
    )
    .get(guildId, broadcasterId);
  const isNew = !!row && row.last_stream_id !== streamId;
  db.prepare(`
  UPDATE twitch_channels
  SET is_live=1, last_stream_id=?, last_checked=?, updated_at=?
  WHERE guild_id=? AND broadcaster_id=?
  `).run(streamId ?? null, t, t, guildId, broadcasterId);
  return isNew;
}

/**
 * Atomically claim a live→offline transition. Always refreshes state;
 * returns whether the subscription was actually live before (so a caller can
 * log/announce the go-offline exactly once).
 * @returns {boolean}
 */
function claimTwitchOffline(guildId, broadcasterId) {
  const t = now();
  const row = db
    .prepare("SELECT is_live FROM twitch_channels WHERE guild_id=? AND broadcaster_id=?")
    .get(guildId, broadcasterId);
  const wasLive = !!row && row.is_live === 1;
  db.prepare(`
  UPDATE twitch_channels
  SET is_live=0, last_checked=?, updated_at=?
  WHERE guild_id=? AND broadcaster_id=?
  `).run(t, t, guildId, broadcasterId);
  return wasLive;
}

module.exports = {
  normalizeTwitchLogin,
  getTwitchChannels,
  getAllTwitchChannels,
  getTwitchChannel,
  getTwitchSubsByBroadcaster,
  addTwitchChannel,
  removeTwitchChannel,
  updateTwitchChannelLiveState,
  claimTwitchStream,
  claimTwitchOffline,
  setTwitchChannelMediaFlags,
  updateTwitchChannelClipState,
  updateTwitchChannelVideoState,
};
