/**
 * Per-subscription Twitch notification overrides (issue #177).
 *
 * `twitch_channels.notify_channel_id` / `notify_role_id` let one tracked
 * stream post its notifications somewhere OTHER than the guild-wide pair
 * (`guild_settings.twitch_notification_channel_id` / `twitch_notify_role_id`):
 * the override wins when set, the guild pair is the default for every sub
 * that leaves these NULL. Both NULL pre-migration, so existing behavior is
 * byte-identical.
 *
 * Deliberately no FK / validation at the storage layer (mirrors the guild
 * settings columns): Discord ids are external; a deleted channel degrades at
 * send time — the go-live claim releases and retries per #447, and the
 * command validates pickers up front via the outbound client.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "twitch_channels",
    "notify_channel_id",
    "notify_channel_id TEXT",
  );
  addColumnIfMissing(
    "twitch_channels",
    "notify_role_id",
    "notify_role_id TEXT",
  );
}

module.exports = { id: "059_twitch_sub_overrides", up };
