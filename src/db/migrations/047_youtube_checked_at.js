/**
 * YouTube polling-interval gate (audit #379).
 *
 * `/setyoutube interval`, the web console, and the docs all drive
 * `youtube_polling_interval_minutes`, but the ticker never read it — every
 * row was swept on a hardcoded 5-minute job (silent-success lie, plus the
 * docs' quota table was fiction).
 *
 * Gating needs a WALL-CLOCK "last swept" stamp: `last_checked` has been the
 * ORDINAL notification window since #380 (it advances to the newest
 * DELIVERED publish and deliberately does not move on quiet sweeps), so it
 * cannot double as a cadence timer. `last_checked_at` records when the row
 * was last actually swept (feed fetched), which is exactly what twitch's
 * eligibility filter gets from its per-check lastChecked.
 *
 * @param {import("better-sqlite3").Database} _db
 * @param {{ tableExists: Function, addColumnIfMissing: Function }} helpers
 */
function up(_db, helpers) {
  if (!helpers.tableExists("youtube_channels")) {
    throw new Error(
      "047_youtube_checked_at: the 'youtube_channels' table is missing",
    );
  }
  helpers.addColumnIfMissing(
    "youtube_channels",
    "last_checked_at",
    "last_checked_at INTEGER",
  );
  return { migrated: true };
}

module.exports = { id: "047_youtube_checked_at", up };
