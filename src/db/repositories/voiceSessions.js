const { db } = require("../connection");

function upsertVoiceSession(guildId, userId, channelId, joinedAtMs) {
  db.prepare(`
  INSERT INTO voice_sessions (guild_id, user_id, channel_id, joined_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET channel_id=excluded.channel_id, joined_at=excluded.joined_at
  `).run(guildId, userId, channelId, joinedAtMs);
}

function getVoiceSession(guildId, userId) {
  return db.prepare(`
  SELECT guild_id, user_id, channel_id, joined_at
  FROM voice_sessions
  WHERE guild_id=? AND user_id=?
  `).get(guildId, userId);
}

function deleteVoiceSession(guildId, userId) {
  db.prepare(`DELETE FROM voice_sessions WHERE guild_id=? AND user_id=?`).run(guildId, userId);
}

module.exports = {
  upsertVoiceSession,
  getVoiceSession,
  deleteVoiceSession,
};
