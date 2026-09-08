/**
 * Read-model for GET /g/:guildId/staff + GET /g/:guildId/commands
 * (roadmap/web-admin.md §8.6 "Staff & roles | Staff (view) | Admin | 1 view"
 * and "Command visibility: sync status | Staff (view) | Admin (sync) | 1
 * view" — subtask 19, Phase 1 READ-ONLY).
 *
 * Query-budget contract (§8.6, review-blocking):
 *  - ONE /staff page build = EXACTLY TWO bounded facade reads; the
 *    /commands page build = exactly ONE (roles are not shown there):
 *      staff_roles rows        → listStaffRoles(guildId)          (guild-scoped, indexed)
 *      command-perm OAuth row  → getCommandPermissionOauth(guildId) (PK row)
 *    No N+1, no full scans, no raw SQL here — existing src/db facade
 *    helpers ONLY (repositories stay untouched/read-only for this task).
 *    Both helpers are config-table reads (a handful of rows per guild);
 *    the staff page needs the FULL staff_roles list (slash `/staff role
 *    list` parity — that list is the whole table for one guild), so no
 *    LIMIT is invented beyond what the existing helper already bounds.
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
const OAUTH_PUBLIC_FIELDS = Object.freeze([
  "authorized",
  "authorizedByUserId",
  "authorizedAt",
  "lastSyncAt",
  "lastSyncError",
]);

/** Defensive text read: trim + cap, non-strings → null. */
function textOrNull(value, max = 512) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Finite-number read (null when absent/non-finite). */
function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

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
 * Guarded facade read: a failing cluster degrades to { available:false }
 * instead of 500ing the whole page (same discipline as settingsData).
 * @param {() => unknown} read
 * @param {string} label static label for the loud log
 */
function guardRead(read, label) {
  try {
    return { available: true, value: read() };
  } catch (err) {
    console.warn(
      `[web] staff: ${label} read failed:`,
      err?.code || err?.name || err?.message || "unknown"
    );
    return { available: false, value: null };
  }
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
   * One /staff page build: staff_roles rows + command-permission OAuth
   * status. Levels are mirrored through the FACADE's normalizeStaffLevel
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
    const { oauth } = getOauthStatus(guildId);

    const normalize = facade.normalizeStaffLevel;
    const roles = Array.isArray(rolesRes.value)
      ? rolesRes.value.map((r) => ({
          roleId: textOrNull(r?.role_id, 64),
          level: normalize(r?.level) === "junior" ? "junior" : "senior",
          addedAt: numOrNull(r?.created_at),
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
