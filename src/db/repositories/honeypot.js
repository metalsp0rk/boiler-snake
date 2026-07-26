const { db, now } = require("../connection");

function addHoneypotChannel(guildId, channelId) {
  db.prepare(`
  INSERT OR IGNORE INTO honeypot_channels (guild_id, channel_id, created_at)
  VALUES (?, ?, ?)
  `).run(guildId, channelId, now());
}

function getHoneypotChannel(guildId, channelId) {
  return (
    db.prepare(`
  SELECT channel_id, warning_message_id
  FROM honeypot_channels
  WHERE guild_id=? AND channel_id=?
  `).get(guildId, channelId) || null
  );
}

function setHoneypotWarningMessage(guildId, channelId, messageIdOrNull) {
  db.prepare(`
  UPDATE honeypot_channels
  SET warning_message_id=?
  WHERE guild_id=? AND channel_id=?
  `).run(messageIdOrNull, guildId, channelId);
}

function removeHoneypotChannel(guildId, channelId) {
  const existing = getHoneypotChannel(guildId, channelId);
  const result = db.prepare(`
  DELETE FROM honeypot_channels
  WHERE guild_id=? AND channel_id=?
  `).run(guildId, channelId);
  return {
    removed: result.changes > 0,
    warning_message_id: existing?.warning_message_id || null,
  };
}

function listHoneypotChannels(guildId) {
  return db.prepare(`
  SELECT channel_id, warning_message_id
  FROM honeypot_channels
  WHERE guild_id=?
  ORDER BY created_at ASC
  `).all(guildId);
}

function isHoneypotChannel(guildId, channelId) {
  const row = db.prepare(`
  SELECT 1 AS ok
  FROM honeypot_channels
  WHERE guild_id=? AND channel_id=?
  `).get(guildId, channelId);
  return !!row;
}

/** True if this message is the bot-posted honeypot warning notice. */
function isHoneypotWarningMessage(guildId, messageId) {
  if (!guildId || !messageId) return false;
  const row = db.prepare(`
  SELECT 1 AS ok
  FROM honeypot_channels
  WHERE guild_id=? AND warning_message_id=?
  `).get(guildId, messageId);
  return !!row;
}

/** All honeypot warning notices (for reaction sweeps). */
function listAllHoneypotWarnings() {
  return db.prepare(`
  SELECT guild_id, channel_id, warning_message_id
  FROM honeypot_channels
  WHERE warning_message_id IS NOT NULL AND warning_message_id != ''
  `).all();
}

function addHoneypotExemptRole(guildId, roleId) {
  db.prepare(`
  INSERT OR IGNORE INTO honeypot_exempt_roles (guild_id, role_id, created_at)
  VALUES (?, ?, ?)
  `).run(guildId, roleId, now());
}

function removeHoneypotExemptRole(guildId, roleId) {
  const result = db.prepare(`
  DELETE FROM honeypot_exempt_roles
  WHERE guild_id=? AND role_id=?
  `).run(guildId, roleId);
  return result.changes > 0;
}

function listHoneypotExemptRoles(guildId) {
  return db.prepare(`
  SELECT role_id
  FROM honeypot_exempt_roles
  WHERE guild_id=?
  ORDER BY created_at ASC
  `).all(guildId);
}

function memberHasHoneypotExemptRole(guildId, memberRoleIds) {
  if (!memberRoleIds?.length) return false;
  const rows = listHoneypotExemptRoles(guildId);
  if (!rows.length) return false;
  const exempt = new Set(rows.map((r) => r.role_id));
  return memberRoleIds.some((id) => exempt.has(id));
}

function addHoneypotBanRole(guildId, roleId) {
  db.prepare(`
  INSERT OR IGNORE INTO honeypot_ban_roles (guild_id, role_id, created_at)
  VALUES (?, ?, ?)
  `).run(guildId, roleId, now());
}

function removeHoneypotBanRole(guildId, roleId) {
  const result = db.prepare(`
  DELETE FROM honeypot_ban_roles
  WHERE guild_id=? AND role_id=?
  `).run(guildId, roleId);
  return result.changes > 0;
}

function listHoneypotBanRoles(guildId) {
  return db.prepare(`
  SELECT role_id
  FROM honeypot_ban_roles
  WHERE guild_id=?
  ORDER BY created_at ASC
  `).all(guildId);
}

function isHoneypotBanRole(guildId, roleId) {
  const row = db.prepare(`
  SELECT 1 AS ok
  FROM honeypot_ban_roles
  WHERE guild_id=? AND role_id=?
  `).get(guildId, roleId);
  return !!row;
}

/**
 * @param {string} guildId
 * @param {string[]} roleIds
 * @returns {string[]}
 */
function findHoneypotBanRolesAmong(guildId, roleIds) {
  if (!roleIds?.length) return [];
  const configured = listHoneypotBanRoles(guildId);
  if (!configured.length) return [];
  const banSet = new Set(configured.map((r) => r.role_id));
  return roleIds.filter((id) => banSet.has(id));
}

module.exports = {
  addHoneypotChannel,
  getHoneypotChannel,
  setHoneypotWarningMessage,
  removeHoneypotChannel,
  listHoneypotChannels,
  isHoneypotChannel,
  isHoneypotWarningMessage,
  listAllHoneypotWarnings,
  addHoneypotExemptRole,
  removeHoneypotExemptRole,
  listHoneypotExemptRoles,
  memberHasHoneypotExemptRole,
  addHoneypotBanRole,
  removeHoneypotBanRole,
  listHoneypotBanRoles,
  isHoneypotBanRole,
  findHoneypotBanRolesAmong,
};
