const { db, now } = require("../connection");

function addAllowedCommandChannel(guildId, channelId) {
  db.prepare(`
  INSERT OR IGNORE INTO allowed_command_channels (guild_id, channel_id, created_at)
  VALUES (?, ?, ?)
  `).run(guildId, channelId, now());
}

function removeAllowedCommandChannel(guildId, channelId) {
  db.prepare(`
  DELETE FROM allowed_command_channels
  WHERE guild_id=? AND channel_id=?
  `).run(guildId, channelId);
}

function listAllowedCommandChannels(guildId) {
  return db.prepare(`
  SELECT channel_id
  FROM allowed_command_channels
  WHERE guild_id=?
  ORDER BY created_at ASC
  `).all(guildId);
}

module.exports = {
  addAllowedCommandChannel,
  removeAllowedCommandChannel,
  listAllowedCommandChannels,
};
