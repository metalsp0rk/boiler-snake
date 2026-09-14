/**
 * Gork daily usage budget repository (roadmap/gork.md §7.17, decisions 30–37).
 *
 * Three scope layers, most specific wins (decision 30):
 *   channel rule → category rule → guild default → unlimited (limit 0).
 * The winning scope is the ONLY counter that increments per call.
 *
 * Tri-state limits (decision 31): `-1` blocked (kill switch, staff included),
 * `0` unlimited (the default everywhere — opt-in feature), `1..1000`
 * successful answers per user per UTC day (clamped on write).
 *
 * Usage rows live in the DB on purpose (decision 37): a restart must not
 * refund budgets. Days are UTC calendar dates of the trigger message
 * (decision 36); anything older than yesterday is pruned lazily on the
 * write path, keeping the table bounded without a ticker.
 *
 * Reads return [] / null / 0 instead of throwing (same idiom as gorkAccess
 * and gorkMemory).
 */

const { db, now } = require("../connection");
const { utcDayKey, utcDayKeyDaysAgo } = require("./userChannelActivity");

/** Tri-state bounds (decision 31). */
const BUDGET_MIN = -1;
const BUDGET_MAX = 1000;
/** Guild-default scope rows store this as scope_id (no channel/category id). */
const GUILD_SCOPE_ID = "0";
const SCOPE_KINDS = new Set(["channel", "category"]);

/**
 * Clamp a tri-state daily limit: -1 blocked | 0 unlimited | 1..1000.
 * Garbage (non-numeric) degrades to 0 = unlimited (the feature-off default,
 * never a silent block); fractional values floor toward -1.
 *
 * @param {unknown} value
 * @returns {number} -1 | 0..1000
 */
function clampDailyLimit(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, Math.floor(n)));
}

/**
 * @param {unknown} kind
 * @returns {"channel"|"category"|null}
 */
function normalizeScopeKind(kind) {
  const k = String(kind ?? "").toLowerCase();
  return SCOPE_KINDS.has(k) ? k : null;
}

/**
 * Resolve the effective budget for one call (PURE — decision 30).
 *
 * channel rule → category rule → guild default; the most specific scope
 * wins and defines which single counter applies. `defaultLimit` is the
 * guild setting (`gork_daily_limit`), clamped here so a caller that skipped
 * the settings layer still gets tri-state semantics.
 *
 * @param {{ scope_kind: string, target_id: string|number, daily_limit: number }[]} rules listGorkBudgetRules() output (other kinds ignored)
 * @param {string|null|undefined} channelId message channel/thread id
 * @param {string|null|undefined} categoryId channel's parent category id (null when unfiled)
 * @param {unknown} defaultLimit guild `gork_daily_limit`
 * @returns {{ scopeKind: "channel"|"category"|"guild", scopeId: string, limit: number }}
 */
function resolveBudget(rules, channelId, categoryId, defaultLimit) {
  const rows = Array.isArray(rules) ? rules : [];
  const channelRule =
    channelId != null
      ? rows.find(
          (r) => r && r.scope_kind === "channel" && String(r.target_id) === String(channelId),
        )
      : null;
  if (channelRule) {
    return {
      scopeKind: "channel",
      scopeId: String(channelId),
      limit: clampDailyLimit(channelRule.daily_limit),
    };
  }
  const categoryRule =
    categoryId != null
      ? rows.find(
          (r) => r && r.scope_kind === "category" && String(r.target_id) === String(categoryId),
        )
      : null;
  if (categoryRule) {
    return {
      scopeKind: "category",
      scopeId: String(categoryId),
      limit: clampDailyLimit(categoryRule.daily_limit),
    };
  }
  return { scopeKind: "guild", scopeId: GUILD_SCOPE_ID, limit: clampDailyLimit(defaultLimit) };
}

/**
 * Add or replace a channel/category budget rule (clamp on write).
 *
 * @param {string} guildId
 * @param {"channel"|"category"} scopeKind
 * @param {string} targetId
 * @param {number} dailyLimit tri-state; clamped to -1..1000
 * @param {string|null} [createdBy] staff user id provenance (audit + `/gork budget list`)
 * @returns {boolean} false when scopeKind/targetId is unusable
 */
function upsertGorkBudgetRule(guildId, scopeKind, targetId, dailyLimit, createdBy = null) {
  const kind = normalizeScopeKind(scopeKind);
  const target = targetId == null ? "" : String(targetId).trim();
  if (!guildId || !kind || !target) return false;
  db.prepare(`
  INSERT INTO gork_budget_rules (guild_id, scope_kind, target_id, daily_limit, created_by, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(guild_id, scope_kind, target_id) DO UPDATE SET
    daily_limit=excluded.daily_limit,
    created_by=excluded.created_by,
    created_at=excluded.created_at
  `).run(guildId, kind, target, clampDailyLimit(dailyLimit), createdBy ?? null, now());
  return true;
}

/**
 * Drop a budget rule (channels then fall back to category → guild default).
 *
 * @param {string} guildId
 * @param {"channel"|"category"} scopeKind
 * @param {string} targetId
 * @returns {boolean} true when a rule actually existed and was removed
 */
function deleteGorkBudgetRule(guildId, scopeKind, targetId) {
  const kind = normalizeScopeKind(scopeKind);
  const target = targetId == null ? "" : String(targetId).trim();
  if (!guildId || !kind || !target) return false;
  const result = db.prepare(`
  DELETE FROM gork_budget_rules
  WHERE guild_id=? AND scope_kind=? AND target_id=?
  `).run(guildId, kind, target);
  return result.changes > 0;
}

/**
 * All rules in a guild, channel rules first, then oldest rule first.
 *
 * @param {string} guildId
 * @returns {{ scope_kind: string, target_id: string, daily_limit: number, created_by: string|null, created_at: number }[]}
 */
function listGorkBudgetRules(guildId) {
  if (!guildId) return [];
  return db.prepare(`
  SELECT scope_kind, target_id, daily_limit, created_by, created_at
  FROM gork_budget_rules
  WHERE guild_id=?
  ORDER BY CASE scope_kind WHEN 'channel' THEN 0 ELSE 1 END, created_at ASC, target_id ASC
  `).all(guildId);
}

/**
 * Successful answers used by one user in one scope on one UTC day.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {"channel"|"category"|"guild"} scopeKind
 * @param {string} scopeId guild-default scope uses GUILD_SCOPE_ID ("0")
 * @param {string} day YYYY-MM-DD UTC (utcDayKey)
 * @returns {number} 0 when no row (or garbage ids)
 */
function getGorkUsage(guildId, userId, scopeKind, scopeId, day) {
  if (!guildId || !userId || !scopeKind || scopeId == null || !day) return 0;
  const row = db.prepare(`
  SELECT count
  FROM gork_usage
  WHERE guild_id=? AND user_id=? AND scope_kind=? AND scope_id=? AND day=?
  `).get(guildId, userId, String(scopeKind), String(scopeId), day);
  return row ? Number(row.count) || 0 : 0;
}

/**
 * Record one successful answer in the winning scope's counter and return the
 * new total (decision 32: exactly once per trigger message, after every
 * reply chunk delivered). Upsert keeps concurrent-ish writers honest; the
 * same write path lazily prunes days older than yesterday so the table
 * stays bounded without a ticker (decision 37).
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {"channel"|"category"|"guild"} scopeKind
 * @param {string} scopeId
 * @param {string} day YYYY-MM-DD UTC (the trigger message's day)
 * @returns {number} the post-increment count for this user+scope+day
 */
function incrementGorkUsage(guildId, userId, scopeKind, scopeId, day) {
  db.prepare(`
  INSERT INTO gork_usage (guild_id, user_id, scope_kind, scope_id, day, count)
  VALUES (?, ?, ?, ?, ?, 1)
  ON CONFLICT(guild_id, user_id, scope_kind, scope_id, day) DO UPDATE SET count = count + 1
  `).run(guildId, userId, String(scopeKind), String(scopeId), day);
  // Lazy prune: keep today + yesterday, drop everything older. Yesterday is
  // kept so the "resets 00:00 UTC" boundary stays explainable for a day.
  db.prepare(`
  DELETE FROM gork_usage WHERE day < ?
  `).run(utcDayKeyDaysAgo(1, now()));
  return getGorkUsage(guildId, userId, scopeKind, scopeId, day);
}

module.exports = {
  BUDGET_MIN,
  BUDGET_MAX,
  GUILD_SCOPE_ID,
  clampDailyLimit,
  normalizeScopeKind,
  resolveBudget,
  upsertGorkBudgetRule,
  deleteGorkBudgetRule,
  listGorkBudgetRules,
  getGorkUsage,
  incrementGorkUsage,
  utcDayKey,
};
