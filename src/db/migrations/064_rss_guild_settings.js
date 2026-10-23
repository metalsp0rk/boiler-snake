/**
 * Per-community RSS notification settings (issue #305).
 *
 * The settings trio lives on `guild_settings` exactly like the YouTube and
 * Twitch pairs before it (001 / 020): `rss_notification_channel_id` is the
 * per-community announce target — deliberately INDEPENDENT of the YouTube/
 * Twitch channel columns, one feature one channel — and `rss_notify_role_id`
 * is the optional role to mention on every new-entry post. NULL on both
 * pre-migration is the only pre-state: no channel configured means the
 * feature idles, no role means no mention at all (never an @everyone
 * fallback). Both store plain id strings — no FK, Discord ids are external
 * and a deleted channel/role degrades at send time (same reasoning as the
 * twitch pair).
 *
 * `rss_polling_interval_minutes` follows the youtube/twitch interval shape
 * (`INTEGER NOT NULL DEFAULT n`): the ticker runs on a fixed cadence and
 * gates per community on this value (default 15, command-clamped 1–60).
 * NOT NULL + DEFAULT means existing rows get a real interval at ALTER time —
 * no NULL-handling branch ever needed in the gate.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "guild_settings",
    "rss_notification_channel_id",
    "rss_notification_channel_id TEXT",
  );
  addColumnIfMissing(
    "guild_settings",
    "rss_notify_role_id",
    "rss_notify_role_id TEXT",
  );
  addColumnIfMissing(
    "guild_settings",
    "rss_polling_interval_minutes",
    "rss_polling_interval_minutes INTEGER NOT NULL DEFAULT 15",
  );
}

module.exports = { id: "064_rss_guild_settings", up };
