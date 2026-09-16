/**
 * Gork feature module (roadmap/gork.md): a goofy AI keyword Q&A bot.
 *
 * - `/gork` (staff): configure the trigger keyword, context window,
 *   per-user cooldown, staff prompt rules, the SearXNG web_search toggle,
 *   and the guild master enable switch; ban/unban/list users blocked from
 *   using gork in this guild; curate the per-person community memory
 *   (roadmap/gork.md §7.16) with `/gork memory` (off by default); manage
 *   per-scope daily usage budgets with `/gork budget` (roadmap/gork.md
 *   §7.17 — tri-state `-1/0/cap`, channel → category → guild default).
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

const { requireStaff } = require("../../core/permissions");
const { replyEphemeral } = require("../../core/interaction");
const { handleGorkMessage, gorkQueue } = require("./trigger");
const { commands } = require("./commands");
const {
  setKeyword,
  setContext,
  setCooldown,
  setRules,
  setSearch,
  setEnable,
  banUser,
  unbanUser,
  showBans,
  handleMemory,
  handleBudget,
  setInteractionLog,
  showStatus,
} = require("./handlers");

/**
 * /gork handler (staff-gated via requireStaff).
 *
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} ctx
 * @param {import("discord.js").Client} ctx.client
 */
async function handleGork(interaction, ctx) {
  if (!(await requireStaff(interaction))) return;
  const { client } = ctx || {};
  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case "keyword":
      return setKeyword(client, interaction, guildId);
    case "context":
      return setContext(client, interaction, guildId);
    case "cooldown":
      return setCooldown(client, interaction, guildId);
    case "rules":
      return setRules(client, interaction, guildId);
    case "search":
      return setSearch(client, interaction, guildId);
    case "enable":
      return setEnable(client, interaction, guildId);
    case "ban":
      return banUser(client, interaction, guildId);
    case "unban":
      return unbanUser(client, interaction, guildId);
    case "bans":
      return showBans(interaction, guildId);
    case "memory":
      return handleMemory(client, interaction, guildId);
    case "budget":
      return handleBudget(client, interaction, guildId);
    case "log":
      return setInteractionLog(client, interaction, guildId);
    case "status":
      return showStatus(interaction, guildId);
    default:
      return replyEphemeral(interaction, `Unknown gork subcommand: \`${sub}\`.`);
  }
}

module.exports = {
  name: "gork",
  commands,
  handlers: {
    gork: handleGork,
  },
  handleGorkMessage,
  gorkQueue,
};
