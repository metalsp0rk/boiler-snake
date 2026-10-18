/**
 * Retention-sweep indexes for the #399 (B2-7) table coverage (issue #399).
 *
 * The hourly retention sweep grows four more tables (#399): settled
 * `bridge_outbox` rows, `bridge_message_links`, `event_activity`, and
 * settled `event_notifications`. None of the existing indexes leads with
 * the sweep's filter columns — without these, every hourly sweep would
 * full-scan the very tables it is meant to cheaply bound (the §3 residual
 * #395/#396 made into doctrine: an age delete is only sweep-safe when an
 * index leads with the age column).
 *
 *  - idx_bridge_outbox_settled        — (state, enqueued_at): the sweep's
 *    `state IN ('done','failed') AND enqueued_at < cutoff` becomes two
 *    index seeks; the live queue ('pending'/'sending') never enters the
 *    range at all. The worker's idx_bridge_outbox_queue stays untouched.
 *  - idx_bridge_message_links_created — (created_at): plain age prune.
 *  - idx_event_activity_created       — (created_at): idx_event_activity_
 *    event leads with event_id, which is useless for a global age delete.
 *  - idx_event_notifications_settled  — (status, fire_at): the due ticker's
 *    idx_event_notifications_due leads (status, next_attempt_at, fire_at),
 *    so 'sent'/'retired' age filters scanned next_attempt_at first.
 *
 * @param {import("better-sqlite3").Database} db
 */
function up(db) {
  db.exec(`
CREATE INDEX IF NOT EXISTS idx_bridge_outbox_settled
  ON bridge_outbox (state, enqueued_at);
CREATE INDEX IF NOT EXISTS idx_bridge_message_links_created
  ON bridge_message_links (created_at);
CREATE INDEX IF NOT EXISTS idx_event_activity_created
  ON event_activity (created_at);
CREATE INDEX IF NOT EXISTS idx_event_notifications_settled
  ON event_notifications (status, fire_at);
`);
}

module.exports = { id: "053_retention_sweep_indexes", up };
