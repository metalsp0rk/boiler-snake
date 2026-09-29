/**
 * Per-guild /gork summarize input token budget.
 *
 * `guild_settings.gork_summarize_input_tokens`: the INPUT token budget for
 * one `/gork summarize` generation (default 80,000; clamped to 8,000–120,000
 * by the settings layer). The range reader converts it to a transcript char
 * cap (4 chars/token minus an 8,000-char prompt-zone reserve → 312,000 chars
 * at the default), replacing the old reuse of the 12,000-char read_discord
 * cap for the summarize transcript. The read_discord tool keeps its 12k cap.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "guild_settings",
    "gork_summarize_input_tokens",
    "gork_summarize_input_tokens INTEGER NOT NULL DEFAULT 80000",
  );
}

module.exports = { id: "033_gork_summarize_input_tokens", up };
