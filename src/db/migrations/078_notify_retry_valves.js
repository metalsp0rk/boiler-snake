/**
 * #827 — retry valves for the release/upload notifiers.
 *
 * The #380 redesign made delivery retry-correct: oldest-first, the
 * watermark advances ONLY past delivered items, the first failure stops
 * the line. Correct — but unbounded and undifferentiated: one PERMANENT
 * failure (deleted notify channel, revoked send perms, content rejected)
 * fails identically every tick and blocks every newer item on that row
 * forever. Two append-only counters give the valves their state:
 *
 *  - `youtube_channels.notify_failures` — per-subscription CONSECUTIVE
 *    delivery-failure count (any success resets it). At the ceiling the
 *    poison head item is skipped (watermark advanced past it with a named
 *    warning + audit row) so the line moves.
 *  - `github_watches.notify_failures` — the same valve on the release
 *    watch row (pointer advanced past the poison release).
 *
 * Gone destinations (10003/10004) skip the budget entirely: youtube
 * clears the community notify-channel setting, github clears the ROW's
 * channel_id — both keep the watermark so pending items resume after
 * staff reconfigure. Purely additive; DEFAULT 0 keeps every existing row
 * eligible for retry exactly as today.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "youtube_channels",
    "notify_failures",
    "notify_failures INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(
    "github_watches",
    "notify_failures",
    "notify_failures INTEGER NOT NULL DEFAULT 0",
  );
}

module.exports = { id: "078_notify_retry_valves", up };
