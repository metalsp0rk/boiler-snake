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
};
