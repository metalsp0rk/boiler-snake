/**
 * Auto-moderation settings repository (#725, epic #723).
 *
 * Owns the `automod_*` columns on `guild_settings` (migration 067): the
 * budget day-counter mechanics (day-rollover reset, consume-on-accept), the
 * persisted circuit-breaker pause, and the shared constants/clamps every
 * automod surface validates against.
 *
 * Budget semantics (contract for the referral #726 / harness #728 issues):
 *   - `automod_daily_case_limit` is tri-state: `-1` blocked (kill switch),
 *     `0` unlimited, `1..100000` cases per community per UTC day (clamped
 *     on write, `gork_daily_limit` posture; DEFAULT 50).
 *   - `automod_cases_today` + `automod_cases_day` (YYYY-MM-DD UTC) form the
 *     counter. When the stored day differs from the injected clock's day,
 *     the counter restarts at 0 — status reads and consumes both roll.
 *   - `consumeAutomodCase` is called EXACTLY ONCE per case, at the moment a
 *     provider call is ACCEPTED. A provider failure before acceptance must
 *     not call it (the case never counted); gate first with
 *     `getAutomodBudget`, then consume on acceptance. Blocked and exhausted
 *     consumes are refused WITHOUT incrementing.
 *
 * Breaker posture mirrors 049_honeypot_pause: the persisted pause IS the
 * incident brake; enforcement refuses while `automod_paused_at` is set, and
 * only `/automodconfig safety resume` (confirm-gated) clears it.
 *
 * Like the gork budget repo, reads return defaults instead of throwing;
 * write helpers are transactional single statements (better-sqlite3 is
 * synchronous — one writer).
 */

const { db, now } = require("../connection");
const { utcDayKey } = require("./userChannelActivity");

// Lazy require: src/platform/community.js requires the db facade, so a
// top-level require would be a load-time cycle. See src/db/repositories/users.js.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

/** The seven actions the model may combine in one case (locked decision 3). */
const AUTOMOD_ACTIONS = Object.freeze([
  "no_action",
  "warn",
  "delete_message",
  "ticket",
  "timeout",
  "kick",
  "ban",
]);

/** Mode vocabulary (locked decision 2). No mode column exists for staff notes. */
const AUTOMOD_MODES = Object.freeze(["off", "suggest", "auto"]);

/** Rules text cap — enforced service-side (#725); storage stays plain TEXT. */
const AUTOMOD_RULES_MAX_LEN = 4000;

/** Timeout cap: floor 60 s, ceiling 28 days (Discord's timeout maximum). */
const AUTOMOD_TIMEOUT_CAP_MIN = 60;
const AUTOMOD_TIMEOUT_CAP_MAX = 2_419_200;
const AUTOMOD_DEFAULT_TIMEOUT_CAP = 3600;

/** Daily case budget bounds (tri-state floor -1; generous ceiling). */
const AUTOMOD_BUDGET_MIN = -1;
const AUTOMOD_BUDGET_MAX = 100_000;
const AUTOMOD_DEFAULT_DAILY_CASE_LIMIT = 50;

/** Column name for one action's mode ('automod_mode_warn'). */
function automodModeColumn(action) {
  return AUTOMOD_ACTIONS.includes(action) ? `automod_mode_${action}` : null;
}

/** Normalize a mode string to the vocabulary, or null when invalid. */
function normalizeAutomodMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  return AUTOMOD_MODES.includes(mode) ? mode : null;
}

/**
 * Write-clamp for the timeout cap: integers only, clamped into
 * [60, 2419200]; garbage falls back to the 3600 default. Commands validate
 * FIRST with specific errors — this is the storage-side belt (same posture
 * as clampGorkDailyLimit in guildSettings.js).
 */
function clampAutomodTimeoutCap(value) {
  if (value === null || value === undefined) return AUTOMOD_DEFAULT_TIMEOUT_CAP;
  const n = Number(value);
  if (!Number.isFinite(n)) return AUTOMOD_DEFAULT_TIMEOUT_CAP;
  return Math.min(
    AUTOMOD_TIMEOUT_CAP_MAX,
    Math.max(AUTOMOD_TIMEOUT_CAP_MIN, Math.floor(n)),
  );
}

/**
 * Write-clamp for the tri-state daily case budget: -1 blocked | 0 unlimited |
 * 1..100000. Garbage (non-numeric) degrades to the 50 default (never a
 * silent block, never a silent unlimited).
 */
function clampAutomodDailyLimit(value) {
  if (value === null || value === undefined) return AUTOMOD_DEFAULT_DAILY_CASE_LIMIT;
  const n = Number(value);
  if (!Number.isFinite(n)) return AUTOMOD_DEFAULT_DAILY_CASE_LIMIT;
  return Math.min(AUTOMOD_BUDGET_MAX, Math.max(AUTOMOD_BUDGET_MIN, Math.floor(n)));
}

// ── Day-rollover case budget ───────────────────────────────────────────────

/**
 * Roll the counter when the stored UTC day is stale (shared by reads and
 * consumes so `/automod status` never shows yesterday's number after
 * midnight). Returns the (possibly re-stamped) row.
 * @param {number} communityId
 * @param {number} nowMs injectable clock (tests + callers with their own tick)
 */
function rollAutomodCaseDay(communityId, nowMs) {
  const day = utcDayKey(nowMs);
  const row = db
    .prepare(
      `SELECT automod_cases_today, automod_cases_day FROM guild_settings WHERE community_id=?`,
    )
    .get(communityId);
  if (!row || row.automod_cases_day === day) return row;
  db.prepare(
    `UPDATE guild_settings SET automod_cases_today=0, automod_cases_day=? WHERE community_id=?`,
  ).run(day, communityId);
  return { automod_cases_today: 0, automod_cases_day: day };
}

/**
 * Current daily-budget view for one community (read-only; rolls the day).
 *
 * @param {number} communityId
 * @param {number} [nowMs] injectable UTC clock
 * @returns {{ limit: number, used: number, remaining: number|null }}
 *   `limit` stored tri-state value; `used` cases counted today;
 *   `remaining`: `null` = unlimited (limit 0), `-1` = blocked (limit -1),
 *   otherwise cases still available today.
 */
function getAutomodBudget(communityId, nowMs = now()) {
  assertCommunityId(communityId);
  require("./guildSettings").ensureGuildSettings(communityId);
  const rolled = rollAutomodCaseDay(communityId, nowMs);
  const limit = Number(
    db
      .prepare(
        `SELECT automod_daily_case_limit FROM guild_settings WHERE community_id=?`,
      )
      .get(communityId)?.automod_daily_case_limit ?? AUTOMOD_DEFAULT_DAILY_CASE_LIMIT,
  );
  const used = Number(rolled?.automod_cases_today) || 0;
  let remaining;
  if (limit <= -1) remaining = -1;
  else if (limit === 0) remaining = null;
  else remaining = Math.max(0, limit - used);
  return { limit, used, remaining };
}

/**
 * Consume one case (call once per ACCEPTED provider call — see header
 * contract). Blocked (`limit < 0`) and exhausted (`used >= limit`) refuses
 * never increment.
 *
 * @param {number} communityId
 * @param {{ nowMs?: number }} [opts]
 * @returns {{ ok: true, used: number, remaining: number|null, limit: number }
 *   | { ok: false, reason: "blocked" | "exhausted", used: number, remaining: number, limit: number }}
 */
function consumeAutomodCase(communityId, { nowMs = now() } = {}) {
  assertCommunityId(communityId);
  require("./guildSettings").ensureGuildSettings(communityId);
  const budget = getAutomodBudget(communityId, nowMs);
  if (budget.limit <= -1) {
    return {
      ok: false,
      reason: "blocked",
      used: budget.used,
      remaining: -1,
      limit: budget.limit,
    };
  }
  if (budget.limit > 0 && budget.used >= budget.limit) {
    return {
      ok: false,
      reason: "exhausted",
      used: budget.used,
      remaining: 0,
      limit: budget.limit,
    };
  }
  db.prepare(
    `UPDATE guild_settings SET automod_cases_today = automod_cases_today + 1 WHERE community_id=?`,
  ).run(communityId);
  const after = rollAutomodCaseDay(communityId, nowMs);
  const used = Number(after?.automod_cases_today) || 0;
  return {
    ok: true,
    used,
    limit: budget.limit,
    remaining: budget.limit === 0 ? null : Math.max(0, budget.limit - used),
  };
}

// ── Circuit-breaker pause state (columns shipped here; trip logic is #739) ─

/**
 * Persist a breaker pause. The breaker issue (#739) owns WHEN this fires;
 * this stores timestamp + reason so a restart cannot silently re-arm.
 * @param {number} communityId
 * @param {{ pausedAt?: number, reason?: string|null }} [fields]
 */
function setAutomodPause(communityId, { pausedAt = now(), reason = null } = {}) {
  assertCommunityId(communityId);
  require("./guildSettings").ensureGuildSettings(communityId);
  db.prepare(
    `UPDATE guild_settings SET automod_paused_at=?, automod_pause_reason=? WHERE community_id=?`,
  ).run(Math.floor(Number(pausedAt)) || now(), reason ? String(reason) : null, communityId);
  return isAutomodPaused(communityId);
}

/**
 * Clear the pause (the `/automodconfig safety resume` arm — confirm-gated in
 * the handler, H2-15). Clears BOTH fields; returns the post-clear state.
 * @param {number} communityId
 */
function clearAutomodPause(communityId) {
  assertCommunityId(communityId);
  require("./guildSettings").ensureGuildSettings(communityId);
  db.prepare(
    `UPDATE guild_settings SET automod_paused_at=NULL, automod_pause_reason=NULL WHERE community_id=?`,
  ).run(communityId);
  return isAutomodPaused(communityId);
}

/**
 * @param {number} communityId
 * @returns {{ paused: boolean, pausedAt: number|null, reason: string|null }}
 */
function isAutomodPaused(communityId) {
  assertCommunityId(communityId);
  require("./guildSettings").ensureGuildSettings(communityId);
  const row = db
    .prepare(
      `SELECT automod_paused_at, automod_pause_reason FROM guild_settings WHERE community_id=?`,
    )
    .get(communityId);
  const pausedAt = Number(row?.automod_paused_at) || null;
  return {
    paused: pausedAt != null,
    pausedAt,
    reason: row?.automod_pause_reason ?? null,
  };
}

module.exports = {
  AUTOMOD_ACTIONS,
  AUTOMOD_MODES,
  AUTOMOD_RULES_MAX_LEN,
  AUTOMOD_TIMEOUT_CAP_MIN,
  AUTOMOD_TIMEOUT_CAP_MAX,
  AUTOMOD_DEFAULT_TIMEOUT_CAP,
  AUTOMOD_BUDGET_MIN,
  AUTOMOD_BUDGET_MAX,
  AUTOMOD_DEFAULT_DAILY_CASE_LIMIT,
  automodModeColumn,
  normalizeAutomodMode,
  clampAutomodTimeoutCap,
  clampAutomodDailyLimit,
  getAutomodBudget,
  consumeAutomodCase,
  setAutomodPause,
  clearAutomodPause,
  isAutomodPaused,
};
