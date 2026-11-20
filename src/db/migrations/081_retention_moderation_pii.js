/**
 * Migration 081 — retention sweep indexes for the moderation-PII family (#822).
 *
 * The family shipped since audit round 2 (ban_records 074, ban_appeals 075,
 * automod_cases 068, automod_case_actions 069, ticket_reports 066) had ZERO
 * retention: erasure/GDPR requests could not be honored for the most
 * sensitive rows in the DB. #822 rides the existing TABLE_SWEEPS machinery
 * with four opt-in knobs; this migration gives each age delete an index
 * seek, per the #396/DB-4 doctrine the sweeps test pins (EXPLAIN QUERY PLAN
 * must show an index, never a full scan).
 *
 * Partial indexes mirror each sweep's state filter exactly (the same
 * posture as idx_bridge_outbox_settled / idx_event_notifications_settled):
 * only terminal rows are ever indexed, so the hot live-state rows keep
 * their plans untouched and the index stays as small as the erasure set.
 */

/**
 * @param {import("better-sqlite3").Database} db
 */
function up(db) {
  db.exec(`
CREATE INDEX IF NOT EXISTS idx_automod_cases_retention
  ON automod_cases(updated_at)
 WHERE status IN ('complete','failed');

CREATE INDEX IF NOT EXISTS idx_ban_records_retention
  ON ban_records(banned_at)
 WHERE status IN ('expired_unbanned','unbanned_manual','clemency_granted');

CREATE INDEX IF NOT EXISTS idx_ban_appeals_retention
  ON ban_appeals(updated_at)
 WHERE status IN ('granted','denied','closed');

CREATE INDEX IF NOT EXISTS idx_ticket_reports_created
  ON ticket_reports(created_at);
`);
}

module.exports = { id: "081_retention_moderation_pii", up };
