/**
 * Per-guild gork tool-round budget (issue #705).
 *
 * `guild_settings.gork_max_tool_rounds`: how many tool rounds one gork
 * answer may spend in this community (`/gork toolrounds`, 5–300).
 *
 * NULLABLE on purpose — NULL is NOT "default 50", it is "the guild never
 * chose", which is what lets the legacy global `GORK_LLM_MAX_TOOL_ROUNDS`
 * stay the fallback (#705 acceptance: "unset guilds fall back to env" and
 * "current deployments don't break"). A `NOT NULL DEFAULT 50` would have
 * silently flipped every env-pinned deployment (e.g. rounds=3) to 50 at
 * ALTER time. The effective value is resolved per job:
 * `constants.resolveMaxToolRounds(guildValue, env)` — guild value clamped
 * 5–300 when set, env knob when NULL, 50 when neither.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "guild_settings",
    "gork_max_tool_rounds",
    "gork_max_tool_rounds INTEGER",
  );
}

module.exports = { id: "065_gork_max_tool_rounds", up };
