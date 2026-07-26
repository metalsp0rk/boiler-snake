const { db, now } = require("../connection");

function logActivity(guildId, userId, kind, amount = 1) {
  db.prepare(`
  INSERT INTO activity_log (guild_id, user_id, kind, amount, created_at)
  VALUES (?, ?, ?, ?, ?)
  `).run(guildId, userId, kind, amount, now());
}

function countMessagesInWindow(guildId, userId, windowDays) {
  const since = now() - windowDays * 24 * 60 * 60 * 1000;
  const row = db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS c
  FROM activity_log
  WHERE guild_id=? AND user_id=? AND kind='message' AND created_at >= ?
  `).get(guildId, userId, since);
  return row?.c ?? 0;
}

module.exports = {
  logActivity,
  countMessagesInWindow,
};
