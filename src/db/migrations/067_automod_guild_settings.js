/**
 * Auto-moderation guild settings (#725, epic #723).
 *
 * Purely additive `guild_settings` columns (049_honeypot_pause /
 * 064_rss_guild_settings precedent — one feature, one settings family, no
 * dedicated table). Everything here is Discord-only for this milestone.
 *
 * - `automod_enabled` (DEFAULT 0): master switch, default OFF — the referral
 *   path (later issue) refuses and names this specific cause while off.
 * - `automod_channel_id` / `automod_rules`: the two things a case REQUIRES
 *   before it runs (locked decisions; rules capped 4000 chars service-side,
 *   the storage layer stays plain TEXT like every other rules column —
 *   `gork_extra_rules` precedent).
 * - `automod_mode_<action>` for the seven model-combinable actions, each
 *   'off' | 'suggest' | 'auto', DEFAULT 'suggest' so enabling the master
 *   switch never starts kicking or banning. There is DELIBERATELY no mode
 *   column for the staff-note tool — it is always on (locked decision 4).
 * - `automod_timeout_cap` (DEFAULT 3600 s): command-side floor/ceiling
 *   60 s … 2 419 200 s (28 days = Discord's timeout maximum), validated
 *   with specific errors, stored as written.
 * - `automod_daily_case_limit` (DEFAULT 50): tri-state daily case budget,
 *   SEPARATE from gork_daily_limit by design (locked decision 7 — a case
 *   must never touch Gork's queue or budget). -1 blocked, 0 unlimited.
 * - `automod_cases_today` + `automod_cases_day`: the day-rollover counter
 *   behind the budget (gork_usage day-key idiom, UTC calendar dates): when
 *   `automod_cases_day` differs from today the counter restarts. The
 *   referral/harness issues consume exactly one case per ACCEPTED provider
 *   call (a provider failure does not consume).
 * - `automod_paused_at` / `automod_pause_reason`: the persisted circuit-
 *   breaker state (049 precedent — a restart must never silently re-arm
 *   auto kick/ban/timeout). NULL = not paused; the breaker issue defines
 *   WHEN it trips, this issue only stores it plus `/automodconfig safety
 *   resume` clearing it.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "guild_settings",
    "automod_enabled",
    "automod_enabled INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing("guild_settings", "automod_channel_id", "automod_channel_id TEXT");
  addColumnIfMissing("guild_settings", "automod_rules", "automod_rules TEXT");

  // Per-action modes (locked decision 2). Column name = automod_mode_ + the
  // action id, so the code can derive the column from the action name
  // (validated against the closed action list before interpolation).
  for (const action of [
    "no_action",
    "warn",
    "delete_message",
    "ticket",
    "timeout",
    "kick",
    "ban",
  ]) {
    addColumnIfMissing(
      "guild_settings",
      `automod_mode_${action}`,
      `automod_mode_${action} TEXT NOT NULL DEFAULT 'suggest'`,
    );
  }

  addColumnIfMissing(
    "guild_settings",
    "automod_timeout_cap",
    "automod_timeout_cap INTEGER NOT NULL DEFAULT 3600",
  );
  addColumnIfMissing(
    "guild_settings",
    "automod_daily_case_limit",
    "automod_daily_case_limit INTEGER NOT NULL DEFAULT 50",
  );
  addColumnIfMissing(
    "guild_settings",
    "automod_cases_today",
    "automod_cases_today INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing("guild_settings", "automod_cases_day", "automod_cases_day TEXT");

  addColumnIfMissing("guild_settings", "automod_paused_at", "automod_paused_at INTEGER");
  addColumnIfMissing(
    "guild_settings",
    "automod_pause_reason",
    "automod_pause_reason TEXT",
  );
}

module.exports = { id: "067_automod_guild_settings", up };
