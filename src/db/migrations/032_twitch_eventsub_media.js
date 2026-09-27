/**
 * Twitch EventSub fast-path + clips/VOD hooks (roadmap/twitch-notifications.md).
 *
 * NOTE on numbering: 031 stays reserved (skipped) for gork STE answer style
 * (roadmap/gork.md §7.20 hard-pins it). This ships first, so it takes 032;
 * the fluxer "communities" migration and the bridge feature take the next
 * free ids AFTER this (033, 034 …) per the §8.5 "reserve at implementation"
 * rule — their docs only ever named 032 as "next free as of today".
 *
 * `twitch_eventsub_subs` tracks webhook subscriptions app-wide (keyed by
 * type + broadcaster, NOT per guild): one EventSub subscription per
 * broadcaster serves every guild tracking that channel, and duplicate
 * (type, condition) subscriptions collide on Twitch.
 *
 * The clip/VOD watermarks live per (guild, broadcaster) row because each
 * guild opts in independently and must not replay notifications a sibling
 * guild already consumed.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS twitch_eventsub_subs (
    type            TEXT NOT NULL,
    broadcaster_id  TEXT NOT NULL,
    subscription_id TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    last_error      TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (type, broadcaster_id)
  );
  CREATE INDEX IF NOT EXISTS idx_twitch_eventsub_subs_broadcaster
    ON twitch_eventsub_subs(broadcaster_id);
  `);

  // Per-subscription clips/VOD opt-ins + dedup watermarks (both default
  // OFF — clips fire for any viewer's clip and are noisy).
  addColumnIfMissing(
    "twitch_channels",
    "notify_clips",
    "notify_clips INTEGER NOT NULL DEFAULT 0"
  );
  addColumnIfMissing(
    "twitch_channels",
    "notify_vods",
    "notify_vods INTEGER NOT NULL DEFAULT 0"
  );
  addColumnIfMissing("twitch_channels", "last_clip_id", "last_clip_id TEXT");
  addColumnIfMissing(
    "twitch_channels",
    "last_clip_created_at",
    "last_clip_created_at INTEGER"
  );
  addColumnIfMissing("twitch_channels", "last_video_id", "last_video_id TEXT");
  // Watermark = newest VOD created_at (ms) seen. created_at (not
  // published_at) is always present and immutable, so a processing VOD can
  // never fall through the watermark.
  addColumnIfMissing(
    "twitch_channels",
    "last_video_created_at",
    "last_video_created_at INTEGER"
  );
}

module.exports = { id: "032_twitch_eventsub_media", up };
