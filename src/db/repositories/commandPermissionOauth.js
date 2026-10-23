/**
 * Per-community OAuth tokens for slash command permission sync.
 *
 * Keyed by the internal communities.id (roadmap/fluxer.md § Repository
 * boundary); the Discord REST API keeps using the external snowflake, which
 * the commandPermissions feature resolves via src/platform/community.js.
 *
 * AT REST the `refresh_token` / `access_token` columns hold ONLY the
 * `v1.<iv>.<tag>.<ciphertext>` AES-256-GCM envelope (audit-2026-10 C6,
 * #189): writes encrypt via src/core/thirdPartyTokens.js (TOKEN_ENCRYPTION_KEY),
 * reads decrypt back. A missing/invalid key therefore makes token-bearing
 * reads and writes FAIL LOUD with an error naming the env var — this store
 * never silently falls back to plaintext in either direction (migration 039
 * guarantees every pre-existing row was encrypted before the app booted).
 * Returned row shape is unchanged: `refresh_token` / `access_token` are the
 * decrypted plaintext values callers already compare and send to Discord.
 */

const { db, now } = require("../connection");
const tokens = require("../../core/thirdPartyTokens");

// Lazy require: src/platform/community.js requires the db facade, so a
// top-level require would be a load-time cycle. See src/db/repositories/users.js.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

/**
 * Encrypt one token column for storage. `null`/undefined stays NULL; a
 * present-but-unencryptable value (missing/invalid key) throws the actionable
 * key-missing error — the caller's handler surfaces the cause (AGENTS.md 3).
 *
 * @param {string|null|undefined} plaintext
 * @param {string} noun what is being stored (error copy)
 * @returns {string|null} envelope or NULL
 */
function encryptTokenColumn(plaintext, noun) {
  if (plaintext == null || plaintext === "") return null;
  const envelope = tokens.encryptToken(plaintext);
  if (envelope == null) throw tokens.keyMissingError(noun);
  return envelope;
}

/**
 * Decrypt one token column read from storage, tagging failures with the row
 * identity so logs alone identify the broken grant (the crypto layer keeps
 * key/envelope material out of its static messages; we keep row ids IN).
 *
 * @param {string|null} envelope
 * @param {number} communityId
 * @param {string} column
 * @returns {string|null}
 */
function decryptTokenColumn(envelope, communityId, column) {
  if (envelope == null || envelope === "") return envelope;
  try {
    return tokens.decryptToken(envelope);
  } catch (err) {
    err.message =
      `command-permission OAuth ${column} for community ${communityId} could not be decrypted: ` +
      `${err.message}`;
    throw err;
  }
}

/**
 * @param {number} communityId
 * @returns {object|null} row with DECRYPTED `refresh_token` / `access_token`
 *   (columns stay envelopes at rest; throws when a present token cannot be
 *   decrypted — never returns raw ciphertext or plaintext-mismatch garbage)
 */
function getCommandPermissionOauth(communityId) {
  assertCommunityId(communityId);
  const row =
    db
      .prepare(
        `
      SELECT * FROM guild_command_permission_oauth WHERE community_id=?
    `
      )
      .get(communityId) || null;
  if (!row) return null;
  const refreshTokenPlain = decryptTokenColumn(row.refresh_token, communityId, "refresh_token");
  const accessTokenPlain = decryptTokenColumn(row.access_token, communityId, "access_token");

  // #281 lazy forward-migration: once both columns decrypt (current key or
  // a RETIRED entry), re-seal with the CURRENT key so rows converge after
  // a rotation. A failed re-seal write never breaks the read.
  if (
    tokens.needsTokenReencrypt(row.refresh_token) ||
    tokens.needsTokenReencrypt(row.access_token)
  ) {
    const seal = (plain) =>
      plain == null || plain === "" ? plain : tokens.encryptToken(plain);
    const refreshEnc = seal(refreshTokenPlain);
    const accessEnc = seal(accessTokenPlain);
    if (
      (row.refresh_token != null && refreshEnc == null) ||
      (row.access_token != null && accessEnc == null)
    ) {
      // No usable current key (or vanished mid-read): nothing to converge
      // to. The decrypted read stands; leave the row untouched.
    } else {
      try {
        db.prepare(
          `
          UPDATE guild_command_permission_oauth
          SET refresh_token=?, access_token=?, updated_at=?
          WHERE community_id=?
        `
        ).run(refreshEnc, accessEnc, now(), communityId);
      } catch (err) {
        console.error(
          `[oauth] command-permission OAuth token re-encrypt write failed for ` +
            `community ${communityId} (key rotation #281, read still valid): ` +
            `${err?.message || err}`,
        );
      }
    }
  }

  return {
    ...row,
    refresh_token: refreshTokenPlain,
    access_token: accessTokenPlain,
  };
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
  if (typeof opts.refreshToken !== "string" || opts.refreshToken === "") {
    throw new TypeError("upsertCommandPermissionOauth: refreshToken is required");
  }
  const t = now();
  const refreshEnc = encryptTokenColumn(
    opts.refreshToken,
    "command-permission OAuth tokens"
  );
  const accessEnc = encryptTokenColumn(
    opts.accessToken ?? null,
    "command-permission OAuth tokens"
  );
  const existing = !!db
    .prepare(`SELECT 1 AS ok FROM guild_command_permission_oauth WHERE community_id=?`)
    .get(communityId);
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
      refreshEnc,
      accessEnc,
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
      refreshEnc,
      accessEnc,
      opts.accessExpiresAt ?? null,
      opts.authorizedByUserId ?? null,
      t,
      t
    );
  }
}

/**
 * Update cached access token after refresh (values encrypted at rest; the
 * optional rotated refresh token too).
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
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new TypeError("updateCommandPermissionAccessToken: accessToken is required");
  }
  const t = now();
  const accessEnc = encryptTokenColumn(
    accessToken,
    "command-permission OAuth tokens"
  );
  if (refreshToken) {
    const refreshEnc = encryptTokenColumn(
      refreshToken,
      "command-permission OAuth tokens"
    );
    db.prepare(
      `
      UPDATE guild_command_permission_oauth
      SET access_token=?, access_expires_at=?, refresh_token=?, updated_at=?
      WHERE community_id=?
    `
    ).run(accessEnc, accessExpiresAt, refreshEnc, t, communityId);
  } else {
    db.prepare(
      `
      UPDATE guild_command_permission_oauth
      SET access_token=?, access_expires_at=?, updated_at=?
      WHERE community_id=?
    `
    ).run(accessEnc, accessExpiresAt, t, communityId);
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
 * STATUS-ONLY view of the row (explicit columns, NO token material): the
 * /staff surfaces only render sync state, and per the webSessions precedent
 * (token material flows only through named paths callers can audit) they
 * must not drag decrypted tokens through pages that never show them. Also
 * means the staff pages keep working when TOKEN_ENCRYPTION_KEY is absent
 * (they never had to read token columns in the first place).
 *
 * @param {number} communityId
 * @returns {object|null}
 */
function getCommandPermissionOauthStatus(communityId) {
  assertCommunityId(communityId);
  return (
    db
      .prepare(
        `SELECT community_id, authorized_by_user_id, last_sync_at, last_sync_error,
                created_at, updated_at
         FROM guild_command_permission_oauth WHERE community_id=?`
      )
      .get(communityId) || null
  );
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
  getCommandPermissionOauthStatus,
  upsertCommandPermissionOauth,
  updateCommandPermissionAccessToken,
  setCommandPermissionSyncResult,
  deleteCommandPermissionOauth,
  hasCommandPermissionOauth,
};
