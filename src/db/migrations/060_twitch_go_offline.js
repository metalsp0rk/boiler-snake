/**
 * Per-subscription Twitch go-offline announcements (issue #179).
 *
 * `notify_offline` is the opt-in (default OFF — mirrors the clips/VOD flags).
 * `last_offline_stream_id` + `last_offline_at` are the announce watermark,
 * mirroring the `last_clip_*` discipline from 032: enabling the flag SEEDS
 * the watermark with the sub's CURRENT `last_stream_id`, so a stream that
 * was already live at opt-in time is never announced (nothing pre-dating
 * the opt-in ever posts). Recording the announced stream id is what makes
 * restart/reconcile replays (and any post-crash replay of an already
 * delivered goodnight) silent.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "twitch_channels",
    "notify_offline",
    "notify_offline INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(
    "twitch_channels",
    "last_offline_stream_id",
    "last_offline_stream_id TEXT",
  );
  addColumnIfMissing(
    "twitch_channels",
    "last_offline_at",
    "last_offline_at INTEGER",
  );
}

module.exports = { id: "060_twitch_go_offline", up };
