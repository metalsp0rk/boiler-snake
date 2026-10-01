/**
 * Warning system — permanent formal disciplinary records.
 *
 * Slash: /warn add|list|info|void|count|mine|export|settings, /setwarn dm|log|expiry
 * Staff ops: requireStaffFromContext. /warn mine: any member (own history).
 * /setwarn: staff gate (requireStaffFromContext).
 */

const { requireStaffFromContext } = require("../../core/permissions");
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
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleWarn(commandCtx, featureCtx) {
  const sub = commandCtx.subcommand;

  if (sub === "mine") {
    return handleMine(commandCtx, featureCtx);
  }

  if (!(await requireStaffFromContext(commandCtx))) return;

  if (sub === "add") return handleAdd(commandCtx, featureCtx);
  if (sub === "list") return handleList(commandCtx, featureCtx);
  if (sub === "info") return handleInfo(commandCtx, featureCtx);
  if (sub === "void") return handleVoid(commandCtx, featureCtx);
  if (sub === "count") return handleCount(commandCtx, featureCtx);
  if (sub === "export") return handleExport(commandCtx, featureCtx);
  if (sub === "settings") return handleSettings(commandCtx, featureCtx);

  await commandCtx.reply({
    content: `Unknown subcommand: \`${sub}\``,
    sensitive: true,
  });
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleSetwarn(commandCtx, featureCtx) {
  if (!(await requireStaffFromContext(commandCtx))) return;

  const sub = commandCtx.subcommand;
  if (sub === "dm") return handleSetDm(commandCtx, featureCtx);
  if (sub === "log") return handleSetLog(commandCtx, featureCtx);
  if (sub === "expiry") return handleSetExpiry(commandCtx, featureCtx);

  await commandCtx.reply({
    content: `Unknown subcommand: \`${sub}\``,
    sensitive: true,
  });
}

/**
 * @param {object|null} supervisor PR 7 supervisor ({discord, fluxer, clientForCommunity})
 * @param {object} [featureCtx]
 */
function start(supervisor, featureCtx) {
  void featureCtx;
  startWarnExpiryTicker(supervisor);
}

module.exports = {
  name: "warnings",
  commands,
  handlers: {
    warn: handleWarn,
    setwarn: handleSetwarn,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): both slash
  // handlers receive a CommandContext.
  handlerApi: {
    warn: "context",
    setwarn: "context",
  },
  start,
  formatWarnRef,
  snippet,
  LIST_PAGE_SIZE,
  MAX_WARN_REASON,
  MAX_EVIDENCE_TEXT,
  MAX_EXPIRY_DAYS,
};
