/**
 * Warning system — permanent formal disciplinary records.
 *
 * Slash: /warn add|list|info|void|count|mine|export|settings, /setwarn dm|log|expiry
 * Staff ops: requireStaff. /warn mine: any member (own history).
 * /setwarn: staff gate (requireStaff).
 */

const { requireStaff } = require("../../core/permissions");
const { replyEphemeral } = require("../../core/interaction");
const { formatWarnRef } = require("../../core/theme");
const { MAX_WARN_REASON, MAX_EVIDENCE_TEXT, MAX_EXPIRY_DAYS } = require("../../db");
const { startWarnExpiryTicker } = require("./ticker");
const { commands } = require("./commands");
const { snippet } = require("./helpers");
const { LIST_PAGE_SIZE } = require("./constants");
const {
  handleAdd,
  handleList,
  handleInfo,
  handleVoid,
  handleCount,
  handleExport,
  handleMine,
  handleSettings,
  handleSetDm,
  handleSetLog,
  handleSetExpiry,
} = require("./handlers");

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleWarn(interaction, ctx) {
  const sub = interaction.options.getSubcommand();

  if (sub === "mine") {
    return handleMine(interaction);
  }

  if (!(await requireStaff(interaction))) return;

  if (sub === "add") return handleAdd(interaction, ctx);
  if (sub === "list") return handleList(interaction);
  if (sub === "info") return handleInfo(interaction);
  if (sub === "void") return handleVoid(interaction, ctx);
  if (sub === "count") return handleCount(interaction);
  if (sub === "export") return handleExport(interaction);
  if (sub === "settings") return handleSettings(interaction);

  await replyEphemeral(interaction, {
    content: `Unknown subcommand: \`${sub}\``,
  });
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} [ctx]
 */
async function handleSetwarn(interaction, ctx) {
  if (!(await requireStaff(interaction))) return;

  const sub = interaction.options.getSubcommand();
  if (sub === "dm") return handleSetDm(interaction, ctx);
  if (sub === "log") return handleSetLog(interaction, ctx);
  if (sub === "expiry") return handleSetExpiry(interaction, ctx);

  await replyEphemeral(interaction, {
    content: `Unknown subcommand: \`${sub}\``,
  });
}

/**
 * @param {import("discord.js").Client} client
 */
function start(client) {
  startWarnExpiryTicker(client);
}

module.exports = {
  name: "warnings",
  commands,
  handlers: {
    warn: handleWarn,
    setwarn: handleSetwarn,
  },
  start,
  formatWarnRef,
  snippet,
  LIST_PAGE_SIZE,
  MAX_WARN_REASON,
  MAX_EVIDENCE_TEXT,
  MAX_EXPIRY_DAYS,
};
