/**
 * Ban appeals settings service (#773 issue §1 + §5) — the single
 * validation/write seam over the per-guild `ban_appeals` toggle (migration
 * 075, DEFAULT 1: appeals ship ON, non-destructively).
 *
 * Contract (automod/settings.js shape, AGENTS.md error rule 6): every
 * function returns `{ ok: true, ... }` or `{ ok: false, error }` with a
 * SPECIFIC, actionable message — it never throws and never replies to a
 * platform; handlers decide how to surface the error.
 *
 * Audit law (issue §5): every toggle MUTATION lands exactly one
 * recordSlashAudit row (`banAppeals.toggle_set`, the banLifecycle.* verb
 * family) plus the /automodconfig-style logConfigChange embed on the guild's
 * audit stream. The embed is best-effort (the admin_audit row is the record,
 * auditTrail.js §8.1) — a stream hiccup never fails the mutation, and the
 * audit trail write itself is fail-safe by core/auditTrail's contract.
 */

const { getGuildSettings, updateGuildSettings } = require("../../db");
const { recordSlashAudit } = require("../../core/auditTrail");
const { logConfigChange } = require("../logs/auditLog");
const { LOG_PREFIX } = require("./constants");

/** admin_audit action vocabulary entry (feature.verb, snake_case verb). */
const AUDIT_ACTION_TOGGLE_SET = "banAppeals.toggle_set";

/** The guild_settings column this whole service owns. */
const SETTING_COLUMN = "ban_appeals";

/**
 * Normalized toggle view for `/banappeals status` and the intake gate.
 * Never throws. Defaults are ON — `Number(x ?? 1) !== 0`, the exact reader
 * idiom the banLifecycle notice seam pins (a missing row or NULL column
 * reads as enabled; only an explicit 0 turns appeals off).
 *
 * @param {number} communityId
 * @returns {{ ok: true, settings: { appealsEnabled: boolean } }
 *          | { ok: false, error: string }}
 */
function readSettings(communityId) {
  try {
    const s = getGuildSettings(communityId) || {};
    return {
      ok: true,
      settings: { appealsEnabled: Number(s[SETTING_COLUMN] ?? 1) !== 0 },
    };
  } catch (err) {
    console.error(
      `${LOG_PREFIX} appeals settings read failed community=${communityId}:`,
      err?.message || err,
    );
    return {
      ok: false,
      error: `Could not read the ban-appeals setting: ${err?.message || "database error"}`,
    };
  }
}

/**
 * Persist the toggle (the repository write-belt normalizes 0/1 through
 * normalizeBanNotifyFlag). Strict boolean — no silent truthiness.
 *
 * @param {number} communityId
 * @param {boolean} enabled
 * @returns {{ ok: true, column: string, enabled: boolean }
 *          | { ok: false, error: string }}
 */
function setEnabled(communityId, enabled) {
  if (typeof enabled !== "boolean") {
    return {
      ok: false,
      error: "Choose `enable` or `disable` for ban appeals — no other value is valid.",
    };
  }
  try {
    updateGuildSettings(communityId, { [SETTING_COLUMN]: enabled ? 1 : 0 });
    return { ok: true, column: SETTING_COLUMN, enabled };
  } catch (err) {
    console.error(
      `${LOG_PREFIX} ${SETTING_COLUMN} write failed community=${communityId}:`,
      err?.message || err,
    );
    return {
      ok: false,
      error: `Could not save the ban-appeals setting (${SETTING_COLUMN}): ${err?.message || "database error"}`,
    };
  }
}

/**
 * The audited mutation arm (the /banappeals enable|disable handler calls
 * THIS; tests may drive the pure setEnabled above). Write → one
 * recordSlashAudit row → logConfigChange embed (best-effort, never flips a
 * committed toggle into a failure). Never replies, never rejects.
 *
 * @param {object} opts
 * @param {number} opts.communityId
 * @param {string} opts.guildId Discord guild snowflake (audit target + embed stream)
 * @param {boolean} opts.enabled
 * @param {string} opts.actorUserId invoking admin (slash audit attribution)
 * @param {object} [opts.outbound] platform outbound for the audit-stream embed
 * @param {object} [opts.actor] user-shaped object the embed renders
 * @returns {Promise<{ ok: true, enabled: boolean, column: string }
 *                 | { ok: false, error: string }>}
 */
async function toggleAppeals(opts = {}) {
  const { communityId, guildId, enabled, actorUserId, outbound, actor } = opts;
  const write = setEnabled(communityId, enabled);
  if (!write.ok) return write;

  recordSlashAudit({
    communityId,
    actorUserId,
    action: AUDIT_ACTION_TOGGLE_SET,
    targetType: "guild",
    targetId: String(guildId ?? ""),
    details: { [SETTING_COLUMN]: enabled ? 1 : 0 },
  });
  if (outbound) {
    await logConfigChange(outbound, guildId, {
      title: "Ban appeals changed",
      command: `/banappeals ${enabled ? "enable" : "disable"}`,
      actor,
      changes: [`Ban appeals: ${enabled ? "on" : "off"}`],
    }).catch(() => {});
  }
  return { ok: true, column: SETTING_COLUMN, enabled };
}

module.exports = {
  LOG_PREFIX,
  AUDIT_ACTION_TOGGLE_SET,
  SETTING_COLUMN,
  readSettings,
  setEnabled,
  toggleAppeals,
};
