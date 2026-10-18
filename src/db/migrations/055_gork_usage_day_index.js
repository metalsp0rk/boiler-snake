/**
 * Day-lead index for the gork_usage lazy prune (issue #395, DB-3).
 *
 * incrementGorkUsage ends with `DELETE FROM gork_usage WHERE day < ?` —
 * global (no community prefix), on EVERY successful gork answer. The PK
 * leads with community_id, so the predicate can only full-scan, and the
 * table it full-scans is exactly the one that accumulates every per-user
 * per-scope usage row of the busiest day. Migration 040 ("schema
 * hygiene") fixed two such scan-having scans and missed this one; the
 * prior audit's §3 carried it as a still-open hot-path residual.
 *
 * idx_gork_usage_day(day) turns every answer's prune into a two-day-bound
 * range delete (today + yesterday are kept by design — the midnight-reset
 * boundary stays explainable for a day).
 *
 * @param {import("better-sqlite3").Database} db
 */
function up(db) {
  db.exec(`
CREATE INDEX IF NOT EXISTS idx_gork_usage_day
  ON gork_usage (day);
`);
}

module.exports = { id: "055_gork_usage_day_index", up };
