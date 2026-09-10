/**
 * Read-model for GET /g/:guildId/staff + GET /g/:guildId/commands
 * (roadmap/web-admin.md §8.6 "Staff & roles | Staff (view) | Admin | 1 view"
 * and "Command visibility: sync status | Staff (view) | Admin (sync) | 1
 * view" — subtask 19, Phase 1 READ-ONLY).
 *
 * Query-budget contract (§8.6, review-blocking):
 *  - ONE /staff page build = EXACTLY THREE bounded facade reads; the
 *    /commands page build = exactly ONE (roles are not shown there):
 *      staff_roles rows        → listStaffRoles(guildId)          (guild-scoped, indexed)
 *      level_roles rows        → listLevelRoles(guildId)          (guild-scoped, indexed —
 *                                Phase 2 staff page: the level→role config the
 *                                subtask-25 forms act on)
 *      command-perm OAuth row  → getCommandPermissionOauth(guildId) (PK row)
 *    No N+1, no full scans, no raw SQL here — existing src/db facade
 *    helpers ONLY (repositories stay untouched/read-only for this task).
 *    All three are config-table reads (a handful of rows per guild);
 *    the staff page needs the FULL staff_roles list (slash `/staff role
 *    list` parity — that list is the whole table for one guild), so no
 *    LIMIT is invented beyond what the existing helper already bounds.
 *    The read pin lives in test/web-routes-staff.test.js (3 reads) and the
 *    statement-count ratchet in test/web-phase1-gate.test.js (/staff 7).
 *  - no caching layer: every read is a single indexed per-guild lookup
 *    (same discipline as data/moderation.js), and sync status changes
 *    outside this process (slash sync), so a stale cached panel would be
 *    actively misleading. The read budget is pinned by
 *    test/web-routes-staff.test.js with a counting facade proxy.
 *
 * Secrets contract (§8.1-9 / §8.7) — THE reason this module exists:
 * getCommandPermissionOauth() is a `SELECT *` whose row carries
 * `refresh_token` / `access_token` columns. {@link projectOauthView}
 * whitelist-projects the row onto NON-SECRET STATUS FIELDS ONLY; token
 * columns are dropped by construction and can never reach a view. The
 * projection output field list is exported (OAUTH_PUBLIC_FIELDS) so the
 * test can pin "no token/secret-shaped field ever leaves this module".
 *
 * Design: pure factory (db injectable, methods looked up per call so
 * monkey-patched facade proxies are what actually run — same contract as
 * data/settingsData.js).
 */

/** Columns projectOauthView() may ever emit — pinned secret-free by tests. */
const { textOrNull, numOrNull, makeGuardRead } = require("./_shared");


const guardRead = makeGuardRead("staff");
const OAUTH_PUBLIC_FIELDS = Object.freeze([
  "authorized",
  "authorizedByUserId",
  "authorizedAt",
  "lastSyncAt",
  "lastSyncError",
]);



/**
 * Whitelist-project the raw guild_command_permission_oauth row onto the
 * STATUS-ONLY view model (token columns dropped by construction — the
 * projection has no way to emit them). null/undefined row ⇒ null (never
 * authorized).
 * @param {object|null|undefined} row
 */
function projectOauthView(row) {
  if (!row || typeof row !== "object") return null;
  return {
    authorized: true,
    authorizedByUserId: textOrNull(row.authorized_by_user_id, 64),
    authorizedAt: numOrNull(row.created_at),
    lastSyncAt: numOrNull(row.last_sync_at),
    // Raw string kept VERBATIM (not truncated): the view escapes it, and
    // sync.js already caps stored errors at 500 chars.
    lastSyncError: typeof row.last_sync_error === "string" && row.last_sync_error
      ? row.last_sync_error
      : null,
  };
}


/**
 * Pure factory for the staff/command-visibility read-model.
 * @param {object} [options]
 * @param {object} [options.db] src/db facade (methods looked up per call;
 *   tests inject a counting proxy)
 * @returns {{ getStaffView: (guildId: string) => object, getOauthStatus: (guildId: string) => object }}
 */
function createStaffData(options = {}) {
  const facade = options.db || require("../../db");

  /**
   * Command-visibility sync status for ONE guild — the /commands page read
   * (ONE bounded PK lookup; staff roles are NOT read here because that
   * page never shows them — §8.6 query budget applies per SURFACE).
   * @param {string} guildId
   */
  function getOauthStatus(guildId) {
    const oauthRes = guardRead(
      () => facade.getCommandPermissionOauth(guildId),
      "command-permission oauth"
    );
    return {
      guildId,
      oauth: {
        available: oauthRes.available,
        // Whitelisted status projection ONLY — never the token columns.
        status: projectOauthView(oauthRes.value),
      },
    };
  }

  /**
   * One /staff page build: staff_roles rows + level→role mappings (Phase 2,
   * subtask 25 — the config the level-role forms act on) + command-permission
   * OAuth status. Levels are mirrored through the FACADE's normalizeStaffLevel
   * (the exact function the slash /staff pages use) so the web list can
   * never diverge from slash level semantics (junior | senior, default
   * senior).
   * @param {string} guildId
   */
  function getStaffView(guildId) {
    const rolesRes = guardRead(
      () => facade.listStaffRoles(guildId),
      "staff roles"
    );
    const levelRolesRes = guardRead(
      () => facade.listLevelRoles(guildId),
      "level roles"
    );
    const { oauth } = getOauthStatus(guildId);

    const normalize = facade.normalizeStaffLevel;
    const roles = Array.isArray(rolesRes.value)
      ? rolesRes.value.map((r) => ({
          roleId: textOrNull(r?.role_id, 64),
          level: normalize(r?.level) === "junior" ? "junior" : "senior",
          addedAt: numOrNull(r?.created_at),
        }))
      : [];

    const levelRoles = Array.isArray(levelRolesRes.value)
      ? levelRolesRes.value.map((r) => ({
          roleId: textOrNull(r?.role_id, 64),
          levelRequired: numOrNull(r?.level_required),
          dropGraceDays: numOrNull(r?.drop_grace_days),
        }))
      : [];

    return {
      guildId,
      roles: {
        available: rolesRes.available,
        rows: roles,
        seniors: roles.filter((r) => r.level === "senior").length,
        juniors: roles.filter((r) => r.level === "junior").length,
      },
      levelRoles: {
        available: levelRolesRes.available,
        rows: levelRoles,
      },
      oauth,
    };
  }

  return { getStaffView, getOauthStatus };
}

module.exports = {
  OAUTH_PUBLIC_FIELDS,
  projectOauthView,
  createStaffData,
};
