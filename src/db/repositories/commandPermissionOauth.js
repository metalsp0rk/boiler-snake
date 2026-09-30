/**
 * Per-community OAuth tokens for slash command permission sync.
 *
 * Keyed by the internal communities.id (roadmap/fluxer.md § Repository
 * boundary); the Discord REST API keeps using the external snowflake, which
 * the commandPermissions feature resolves via src/platform/community.js.
 */

const { db, now } = require("../connection");

// Lazy require: src/platform/community.js requires the db facade, so a
// top-level require would be a load-time cycle. See src/db/repositories/users.js.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

/**
 * @param {number} communityId
 * @returns {object|null}
 */
function getCommandPermissionOauth(communityId) {
  assertCommunityId(communityId);
  return (
    db
      .prepare(
        `
      SELECT * FROM guild_command_permission_oauth WHERE community_id=?
    `
      )
      .get(communityId) || null
  );
}

/**
 * Upsert tokens after successful OAuth authorization.
 * @param {number} communityId
 * @param {object} opts
 * @param {string} opts.refreshToken
 * @param {string} [opts.accessToken]
 * @param {number} [opts.accessExpiresAt] unix ms
 * @param {string} [opts.authorizedByUserId]
 */
function upsertCommandPermissionOauth(communityId, opts) {
  assertCommunityId(communityId);
  const t = now();
  const existing = getCommandPermissionOauth(communityId);
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
      WHERE community_id=?
    `
    ).run(
      opts.refreshToken,
      opts.accessToken ?? null,
      opts.accessExpiresAt ?? null,
      opts.authorizedByUserId ?? null,
      t,
      communityId
    );
  } else {
    db.prepare(
      `
      INSERT INTO guild_command_permission_oauth (
        community_id, refresh_token, access_token, access_expires_at,
        authorized_by_user_id, last_sync_at, last_sync_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `
    ).run(
      communityId,
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
 * @param {number} communityId
 * @param {string} accessToken
 * @param {number} accessExpiresAt unix ms
 * @param {string} [refreshToken] if Discord rotated it
 */
function updateCommandPermissionAccessToken(
  communityId,
  accessToken,
  accessExpiresAt,
  refreshToken
) {
  assertCommunityId(communityId);
  const t = now();
  if (refreshToken) {
    db.prepare(
      `
      UPDATE guild_command_permission_oauth
      SET access_token=?, access_expires_at=?, refresh_token=?, updated_at=?
      WHERE community_id=?
    `
    ).run(accessToken, accessExpiresAt, refreshToken, t, communityId);
  } else {
    db.prepare(
      `
      UPDATE guild_command_permission_oauth
      SET access_token=?, access_expires_at=?, updated_at=?
      WHERE community_id=?
    `
    ).run(accessToken, access_expiresAt ?? accessExpiresAt, t, communityId);
  }
}

/**
 * @param {number} communityId
 * @param {object} opts
 * @param {number|null} [opts.lastSyncAt]
 * @param {string|null} [opts.lastSyncError]
 */
function setCommandPermissionSyncResult(communityId, opts) {
  assertCommunityId(communityId);
  const t = now();
  db.prepare(
    `
    UPDATE guild_command_permission_oauth
    SET last_sync_at=?, last_sync_error=?, updated_at=?
    WHERE community_id=?
  `
  ).run(
    opts.lastSyncAt ?? null,
    opts.lastSyncError ?? null,
    t,
    communityId
  );
}

/**
 * @param {number} communityId
 * @returns {boolean}
 */
function deleteCommandPermissionOauth(communityId) {
  assertCommunityId(communityId);
  const result = db
    .prepare(`DELETE FROM guild_command_permission_oauth WHERE community_id=?`)
    .run(communityId);
  return result.changes > 0;
}

/**
 * @param {number} communityId
 * @returns {boolean}
 */
function hasCommandPermissionOauth(communityId) {
  assertCommunityId(communityId);
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM guild_command_permission_oauth WHERE community_id=?`
    )
    .get(communityId);
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
