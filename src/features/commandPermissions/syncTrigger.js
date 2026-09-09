/**
 * Shared command-visibility SYNC TRIGGER core (subtask 31, §8.11 slash↔web
 * parity).
 *
 * WHY THIS MODULE EXISTS: the slash `/staff syncpermissions` handler
 * (src/features/staffRoles/index.js handleSyncPermissions) inlined its whole
 * trigger flow — env preconditions, stored-authorization check, defer
 * choreography, the sync itself (already shared as
 * commandPermissions/sync.js#applyGuildCommandPermissions) and the exact
 * audit entry shape. The web admin trigger (src/web/routes/syncAction.js)
 * must run the SAME flow on the SAME stored authorization, so the flow was
 * extracted HERE verbatim and BOTH call sites route through it. This is the
 * minimal additive refactor: sync.js / oauthTokens.js / the
 * guild_command_permission_oauth storage stay the single source of truth —
 * nothing is re-implemented and no second token store exists (decision 9:
 * web LOGIN tokens never touch this path; the sync always reads the guild's
 * stored slash OAuth row via oauthTokens#getValidAccessToken inside
 * applyGuildCommandPermissions).
 *
 * PARITY ANCHORS (pinned by test/web-visibility-sync.test.js):
 *  - SYNC_AUDIT_ACTION  — the one action string BOTH transports write
 *                         ("staff.sync_permissions", staffRoles/index.js
 *                         shipped vocabulary — never rename, §8.11).
 *  - buildSyncAuditDetails — the one details builder BOTH transports use:
 *                         { role_count, commands_updated } (exact shape the
 *                         slash recorded since Phase-0b; deep-equal target
 *                         of the parity test).
 *
 * CONTRACT (runCommandVisibilitySync):
 *  1. env preconditions from the EXISTING config reader — zero Discord
 *     calls, zero writes; not ready ⇒ { status: "env_not_configured",
 *     missing[] } (env-variable NAMES only — never values);
 *  2. stored authorization via hasCommandPermissionOauth — absent ⇒
 *     { status: "not_authorized" } with ZERO Discord calls (the web answer
 *     is "run /staff syncpermissions once"; the slash answer is its own
 *     authorize-link UX, which stays in the slash handler);
 *  3. onBeforeSync() runs LAST PRECONDITION PASSED, immediately before the
 *     first Discord call — the slash uses it for deferReply choreography;
 *  4. applyGuildCommandPermissions(guildId) runs UNCHANGED (token decrypt-
 *     free read of the stored row + refresh + per-command PUTs + persisting
 *     last_sync_at/last_sync_error). Throws propagate VERBATIM with their
 *     err.code ("not_authorized" | "reauth_required" | …) so each caller
 *     maps them to its own reply/slug vocabulary — the core NEVER fabricates
 *     a success and NEVER swallows a failure into one.
 *
 * The core writes NO audit row: the slash writes fail-SAFE via
 * recordSlashAudit (origin 'slash') and the web writes FAIL-CLOSED via
 * req.audit (origin 'web', insert failure ⇒ 500) — the deliberate
 * asymmetry documented in src/core/auditTrail.js. Both build the SAME entry
 * from the returned result via buildSyncAuditDetails.
 */

const { getCommandPermissionOAuthConfig } = require("./config");
const { applyGuildCommandPermissions } = require("./sync");
const { hasCommandPermissionOauth } = require("../../db");

/** The one admin_audit action string both transports write (§8.6 vocab). */
const SYNC_AUDIT_ACTION = "staff.sync_permissions";

/**
 * Slash-identical audit details ({ role_count, commands_updated },
 * staffRoles/index.js since the feature shipped). Deriving them HERE is
 * what makes the parity test's deep-equal structural rather than hopeful.
 * @param {{ roleCount: number, updated: unknown[] }} result
 */
function buildSyncAuditDetails(result) {
  return {
    role_count: result.roleCount,
    commands_updated: result.updated.length,
  };
}

/**
 * Run the full visibility-sync trigger for ONE guild (no audit, no reply —
 * the caller's transport owns both). Never throws on the precondition
 * branches; throws VERBATIM on sync failure (err.code preserved).
 *
 * @param {string} guildId server-derived by the caller
 * @param {object} [opts]
 * @param {() => (void|Promise<void>)} [opts.onBeforeSync] invoked exactly
 *   once, immediately BEFORE applyGuildCommandPermissions (defer choreography)
 * @returns {Promise<
 *   | { status: "env_not_configured", missing: string[], redirectUri: string|null }
 *   | { status: "not_authorized" }
 *   | { status: "synced", result: object }
 * >}
 */
async function runCommandVisibilitySync(guildId, opts = {}) {
  const cfg = getCommandPermissionOAuthConfig();
  if (!cfg.ready) {
    return {
      status: "env_not_configured",
      missing: Array.isArray(cfg.missing) ? cfg.missing.slice() : [],
      redirectUri: typeof cfg.redirectUri === "string" ? cfg.redirectUri : null,
    };
  }

  if (!hasCommandPermissionOauth(guildId)) {
    return { status: "not_authorized" };
  }

  if (typeof opts.onBeforeSync === "function") {
    await opts.onBeforeSync();
  }

  const result = await applyGuildCommandPermissions(guildId);
  return { status: "synced", result };
}

module.exports = {
  SYNC_AUDIT_ACTION,
  buildSyncAuditDetails,
  runCommandVisibilitySync,
};
