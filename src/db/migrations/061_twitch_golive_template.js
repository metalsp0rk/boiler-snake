/**
 * Per-guild custom Twitch go-live message templates (issue #178).
 *
 * The template lives on the per-community settings row (`guild_settings`),
 * next to the `twitch_*` settings trio from 020_twitch — the template is
 * guild-wide configuration (roadmap/twitch-notifications.md §3.5 puts the
 * notification channel / role / interval there; per-SUBSCRIPTION template
 * overrides are explicitly out of scope for #178).
 *
 * NULL means "use the built-in default template" — the shipped copy
 * (`**{streamer}** is live!`) so an unset column keeps today's exact
 * go-live content. Rendered placeholder values are never stored; only the
 * admin-authored template text (validated ≤ 2000 chars at the settings
 * repo + command layer — this column is deliberately unconstrained SQL-wise,
 * same as the other free-text settings).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "guild_settings",
    "twitch_golive_template",
    "twitch_golive_template TEXT",
  );
}

module.exports = { id: "061_twitch_golive_template", up };
