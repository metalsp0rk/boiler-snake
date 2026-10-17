/**
 * YouTube live-alert dedup state (audit #378).
 *
 * `youtube_channels.last_video_id` is a SINGLE pointer shared by uploads and
 * live streams. The end-of-tick update stores the NEWEST feed item, so one
 * upload published during a live stream moves the pointer off the live
 * entry — and the live entry (which has no publish-window guard) re-fires
 * its @everyone alert EVERY tick for the whole stream (~36 pings in a
 * 3-hour stream).
 *
 * This adds a dedicated per-row live pointer: `last_live_id` records the
 * stream whose alert was dispatched, so live dedup stops competing with
 * upload bookkeeping for one column.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(_db, helpers) {
  if (!helpers.tableExists("youtube_channels")) {
    throw new Error(
      "046_youtube_live_pointer: the 'youtube_channels' table is missing",
    );
  }
  helpers.addColumnIfMissing("youtube_channels", "last_live_id", "last_live_id TEXT");
  return { migrated: true };
}

module.exports = { id: "046_youtube_live_pointer", up };
