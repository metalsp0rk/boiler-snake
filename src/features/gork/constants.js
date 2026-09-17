/**
 * Caps and list limits for /gork (clamped again in the settings layer).
 */
const KEYWORD_MAX = 50;
const CONTEXT_MIN = 1;
const CONTEXT_MAX = 50;
const COOLDOWN_MIN = 0;
const COOLDOWN_MAX = 3600;
const RULES_MAX = 500;
/** Max banned users listed by `/gork bans` (rest summarized). */
const BANS_LIST_MAX = 25;
/** Max memory rows listed by `/gork memory show` (guild view). */
const MEMORIES_LIST_MAX = 25;
/** Body preview length in a `/gork memory show` line (rest becomes `…`). */
const MEMORY_BODY_MAX = 120;
/** Char budget for the whole `/gork memory show` listing (then "…and N more"). */
const MEMORY_LIST_TOTAL_MAX = 3800;
/** Tri-state budget bounds (roadmap §7.17.2, decision 31). */
const BUDGET_MIN = -1;
const BUDGET_MAX = 1000;
/** Max budget rules listed by `/gork budget list` (rest summarized). */
const BUDGET_RULES_LIST_MAX = 25;

/* read_discord windows & caps (roadmap §7.19.2, decision 45) */
/** Channel reads: the N most recent messages. */
const READ_DISCORD_CHANNEL_WINDOW = 50;
/** Message-link reads: up to N messages before the anchor. */
const READ_DISCORD_BEFORE_WINDOW = 40;
/** Message-link reads: up to N messages after the anchor. */
const READ_DISCORD_AFTER_WINDOW = 10;
/** Per-message content cap (same family as the context caps). */
const READ_DISCORD_MESSAGE_CHAR_CAP = 500;
/** Total output cap for one read (code-point-safe via sliceSafe). */
const READ_DISCORD_TOTAL_CHAR_CAP = 12000;

module.exports = {
  KEYWORD_MAX,
  CONTEXT_MIN,
  CONTEXT_MAX,
  COOLDOWN_MIN,
  COOLDOWN_MAX,
  RULES_MAX,
  BANS_LIST_MAX,
  MEMORIES_LIST_MAX,
  MEMORY_BODY_MAX,
  MEMORY_LIST_TOTAL_MAX,
  BUDGET_MIN,
  BUDGET_MAX,
  BUDGET_RULES_LIST_MAX,
  READ_DISCORD_CHANNEL_WINDOW,
  READ_DISCORD_BEFORE_WINDOW,
  READ_DISCORD_AFTER_WINDOW,
  READ_DISCORD_MESSAGE_CHAR_CAP,
  READ_DISCORD_TOTAL_CHAR_CAP,
};
