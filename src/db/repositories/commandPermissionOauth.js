/**
 * Per-guild OAuth tokens for slash command permission sync.
 */

const { db, now } = require("../connection");

/**
 * @param {string} guildId
 * @returns {object|null}
 */
function getCommandPermissionOauth(guildId) {
  return (
    db
      .prepare(
        `
    SELECT * FROM guild_command_permission_oauth WHERE guild_id=?
  `
      )
      .get(guildId) || null
  );
}

/**
 * Upsert tokens after successful OAuth authorization.
 * @param {string} guildId
 * @param {object} opts
 * @param {string} opts.refreshToken
 * @param {string} [opts.accessToken]
 * @param {number} [opts.accessExpiresAt] unix ms
 * @param {string} [opts.authorizedByUserId]
 */
function upsertCommandPermissionOauth(guildId, opts) {
  const t = now();
  const existing = getCommandPermissionOauth(guildId);
  if (existing) {
    db.prepare(
      `
      UPDATE guild_command_permission_oauth
      SET refresh_token=?,
          access_token=?,
          access_expires_at=?,
          authorized_by_user_id=COALESCE(?, authorized_by_user_id),
          last_sync_error=NULL,
          updated_at=?
      WHERE guild_id=?
    `
    ).run(
      opts.refreshToken,
      opts.accessToken ?? null,
      opts.accessExpiresAt ?? null,
      opts.authorizedByUserId ?? null,
      t,
      guildId
    );
  } else {
    db.prepare(
      `
      INSERT INTO guild_command_permission_oauth (
        guild_id, refresh_token, access_token, access_expires_at,
        authorized_by_user_id, last_sync_at, last_sync_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `
    ).run(
      guildId,
      opts.refreshToken,
      opts.accessToken ?? null,
      opts.accessExpiresAt ?? null,
      opts.authorizedByUserId ?? null,
      t,
      t
    );
  }
}

/**
 * Update cached access token after refresh.
 * @param {string} guildId
 * @param {string} accessToken
 * @param {number} accessExpiresAt unix ms
 * @param {string} [refreshToken] if Discord rotated it
 */
function updateCommandPermissionAccessToken(
  guildId,
  accessToken,
  accessExpiresAt,
  refreshToken
) {
  const t = now();
  if (refreshToken) {
    db.prepare(
      `
      UPDATE guild_command_permission_oauth
      SET access_token=?, access_expires_at=?, refresh_token=?, updated_at=?
      WHERE guild_id=?
    `
    ).run(accessToken, accessExpiresAt, refreshToken, t, guildId);
  } else {
    db.prepare(
      `
      UPDATE guild_command_permission_oauth
      SET access_token=?, access_expires_at=?, updated_at=?
      WHERE guild_id=?
    `
    ).run(accessToken, accessExpiresAt, t, guildId);
  }
}

/**
 * @param {string} guildId
 * @param {object} opts
 * @param {number|null} [opts.lastSyncAt]
 * @param {string|null} [opts.lastSyncError]
 */
function setCommandPermissionSyncResult(guildId, opts) {
  const t = now();
  db.prepare(
    `
    UPDATE guild_command_permission_oauth
    SET last_sync_at=?, last_sync_error=?, updated_at=?
    WHERE guild_id=?
  `
  ).run(
    opts.lastSyncAt ?? null,
    opts.lastSyncError ?? null,
    t,
    guildId
  );
}

/**
 * @param {string} guildId
 * @returns {boolean}
 */
function deleteCommandPermissionOauth(guildId) {
  const result = db
    .prepare(`DELETE FROM guild_command_permission_oauth WHERE guild_id=?`)
    .run(guildId);
  return result.changes > 0;
}

/**
 * @param {string} guildId
 * @returns {boolean}
 */
function hasCommandPermissionOauth(guildId) {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM guild_command_permission_oauth WHERE guild_id=?`
    )
    .get(guildId);
  return !!row;
}

module.exports = {
  getCommandPermissionOauth,
  upsertCommandPermissionOauth,
  updateCommandPermissionAccessToken,
  setCommandPermissionSyncResult,
  deleteCommandPermissionOauth,
  hasCommandPermissionOauth,
};
