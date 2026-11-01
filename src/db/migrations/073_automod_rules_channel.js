/**
 * Auto-moderation rules-channel source (rules-extraction change, epic #723).
 *
 * Purely additive `guild_settings` column (067 family — same feature, same
 * settings table):
 *
 * - `automod_rules_channel_id`: the guild's RULES CHANNEL — the source the
 *   one-time batch extraction reads to distill the judge's rules text.
 *   Operators no longer type the rules by hand: `/automodconfig rules source`
 *   stores the channel here AND runs the extraction, `rules extract` re-runs
 *   it against the stored source. The distilled result keeps living in
 *   `automod_rules` (067) — the case pipeline (referral gate → caseContext →
 *   harness prompt) never reads this column; the rules TEXT stays the single
 *   judgment input, extraction just writes it.
 *
 * NULL = no rules channel configured (fresh guilds and guilds that only ever
 * set the text via the retired manual path — existing `automod_rules` rows
 * stay valid untouched).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "guild_settings",
    "automod_rules_channel_id",
    "automod_rules_channel_id TEXT",
  );
}

module.exports = { id: "073_automod_rules_channel", up };
