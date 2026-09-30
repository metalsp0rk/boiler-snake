/**
 * Gork feature module (roadmap/gork.md): a goofy AI keyword Q&A bot.
 *
 * - `/gork` (staff): configure the trigger keyword, context window,
 *   per-user cooldown, staff prompt rules, the SearXNG web_search toggle,
 *   the STE anti-slop answer style (§7.20), and the guild master enable
 *   switch; ban/unban/list users blocked from
 *   using gork in this guild; curate the per-person community memory
 *   (roadmap/gork.md §7.16) with `/gork memory` (off by default); manage
 *   per-scope daily usage budgets with `/gork budget` (roadmap/gork.md
 *   §7.17 — tri-state `-1/0/cap`, channel → category → guild default);
 *   set the /gork summarize input token budget with
 *   `/gork summarize-budget` (8,000–120,000; default 80,000 tokens).
 * - `handleGorkMessage`: the onMessageCreate pipeline hook — answers
 *   keyword triggers using conversation context and optional web search.
 *
 * Gork is live whenever `AI_API_KEY` is set and the guild's `gork_enabled`
 * switch is on; triggers in open ticket channels are ignored
 * (roadmap/gork.md §7.1, decisions 7, 19).
 *
 * Banned users (guild `gork_user_blocks`) still see the locked
 * LLM-failure canned reply, so a ban is indistinguishable from a normal
 * failure; unlike the cooldown, staff status does NOT bypass a ban.
 */

const { requireStaffFromContext } = require("../../core/permissions");
const { handleGorkMessage, gorkQueue } = require("./trigger");
const { commands } = require("./commands");
const {
  setKeyword,
  setContext,
  setCooldown,
  setRules,
  setSearch,
  setSte,
  setEnable,
  banUser,
  unbanUser,
  showBans,
  handleMemory,
  handleBudget,
  setInteractionLog,
  showStatus,
  handleSummarize,
  setSummarizeBudget,
} = require("./handlers");

/**
 * /gork handler (staff-gated via requireStaffFromContext).
 *
 * Migrated to the CommandContext seam (roadmap/fluxer.md § CommandContext):
 * the dispatcher reads the subcommand off the context and hands `commandCtx`
 * (which carries communityId/externalGuildId/outbound) to every sub-handler —
 * the spec is explicit that contextual handlers never destructure `client`
 * from the feature context (that path lives on until the PR 7 cutover, for
 * unmigrated readers only).
 *
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleGork(commandCtx, featureCtx) {
  // The context arm is fully served by commandCtx + the documented
  // rawInteraction escape hatch inside handlers.js — featureCtx.client is
  // deliberately NOT consumed here (spec PR 5).
  void featureCtx;
  if (!(await requireStaffFromContext(commandCtx))) return;
  // Repository key (integer) and display/audit key (external snowflake) ride
  // on the context; handlers read them from commandCtx.
  const sub = commandCtx.subcommand;

  switch (sub) {
    case "keyword":
      return setKeyword(commandCtx);
    case "context":
      return setContext(commandCtx);
    case "cooldown":
      return setCooldown(commandCtx);
    case "rules":
      return setRules(commandCtx);
    case "search":
      return setSearch(commandCtx);
    case "ste":
      return setSte(commandCtx);
    case "enable":
      return setEnable(commandCtx);
    case "ban":
      return banUser(commandCtx);
    case "unban":
      return unbanUser(commandCtx);
    case "bans":
      return showBans(commandCtx);
    case "memory":
      return handleMemory(commandCtx);
    case "budget":
      return handleBudget(commandCtx);
    case "log":
      return setInteractionLog(commandCtx);
    case "summarize":
      // requireStaffFromContext above gates the whole /gork family (decision
      // 53: the rundown is staff-only); the handler owns the mode/cooldown/
      // budget gates and the queue + post pipeline.
      return handleSummarize(commandCtx, featureCtx);
    case "summarize-budget":
      return setSummarizeBudget(commandCtx);
    case "status":
      return showStatus(commandCtx);
    default:
      return commandCtx.reply({
        content: `Unknown gork subcommand: \`${sub}\`.`,
        sensitive: true,
      });
  }
}

module.exports = {
  name: "gork",
  commands,
  handlers: {
    gork: handleGork,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): the slash
  // handler receives a CommandContext. The pipeline hook (handleGorkMessage)
  // is not a slash handler and keeps its signature.
  handlerApi: {
    gork: "context",
  },
  handleGorkMessage,
  gorkQueue,
};
