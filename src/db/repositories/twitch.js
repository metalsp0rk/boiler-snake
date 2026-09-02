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

function getTwitchChannels(guildId) {
  return db.prepare(`
  SELECT guild_id, broadcaster_id, login, display_name, profile_image_url,
         is_live, last_stream_id, last_checked
  FROM twitch_channels
  WHERE guild_id=?
  ORDER BY created_at ASC
  `).all(guildId);
}

function getAllTwitchChannels() {
  return db.prepare(`
  SELECT guild_id, broadcaster_id, login, display_name, profile_image_url,
         is_live, last_stream_id, last_checked
  FROM twitch_channels
  ORDER BY created_at ASC
  `).all();
}

function getTwitchChannel(guildId, loginOrBroadcasterId) {
  const normalized = normalizeTwitchLogin(loginOrBroadcasterId);
  const row = db.prepare(`
  SELECT guild_id, broadcaster_id, login, display_name, profile_image_url,
         is_live, last_stream_id, last_checked
  FROM twitch_channels
  WHERE guild_id=? AND (login=? OR broadcaster_id=?)
  `).get(guildId, normalized, normalized);
  return row || null;
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

module.exports = {
  normalizeTwitchLogin,
  getTwitchChannels,
  getAllTwitchChannels,
  getTwitchChannel,
  addTwitchChannel,
  removeTwitchChannel,
  updateTwitchChannelLiveState,
};
