/**
 * Auto-moderation — staff referral, recommendations, and a gated action
 * harness (#725 settings/config slice + #726 referral intake; epic #723).
 *
 * Slash: /automod status | refer (staff) · /automodconfig
 *        channel set|clear · rules set|clear · enable on|off ·
 *        mode <action> <off|suggest|auto> · timeout-cap · budget ·
 *        safety resume (confirm:)  (admin, ManageGuild in handler too)
 * Context menu (#726): "Refer to automod" on a message (staff gate first in
 *        the handler; api "interaction" — the target only exists on the raw
 *        interaction, so it is deliberately absent from handlerApi below).
 * Modals: am:rules — long rules text (same idea as /note add's modal)
 *
 * Discord-only for this milestone (epic decision 8 — Fluxer is explicit
 * no-parity, stated in docs/automod.md): every arm refuses the standard
 * NOT_ON_FLUXER sentence when the context carries no raw Discord interaction
 * (the case-card surface, the @everyone overwrite read, and the modal all
 * need Discord components). The context menu additionally never reaches the
 * Fluxer dispatcher (#750's chat-input-only tree filter).
 *
 * Deliberate absences (by contract, not omission):
 *  - NO LLM call anywhere here; the harness is #728. Referral intake (#726)
 *    stops at a stored case + the ack — see ./refer.js for why the ack may
 *    never claim a recommendation was produced.
 *  - NO new env vars — storage is the automod_* guild_settings family plus
 *    the automod_cases table (068).
 */

const {
  requireStaffFromContext,
  requireAdminFromContext,
} = require("../../core/permissions");
const { commands } = require("./commands");
const { referContextMenu } = require("./contextMenu");
const {
  NOT_ON_FLUXER,
  MODAL_RULES,
} = require("./constants");
const { buildStatusPayload } = require("./status");
const config = require("./config");
const refer = require("./refer");
const settings = require("./settings");

/**
 * /automod — staff surface (epic: staff may check state and file referrals;
 * changes are all under /automodconfig).
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleAutomod(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireStaffFromContext(commandCtx))) return;

  // Discord-only surface (epic decision 8): Fluxer contexts never carry
  // rawInteraction and never get the automod command surface.
  if (!commandCtx.rawInteraction) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }

  const sub = commandCtx.subcommand;
  if (sub === "status") {
    const built = buildStatusPayload(commandCtx.communityId);
    if (!built.ok) {
      await commandCtx.reply({ content: built.error, sensitive: true });
      return;
    }
    await commandCtx.reply(built.payload);
    return;
  }
  if (sub === "refer") {
    // #726: the only slash intake. Gates ran above (requireStaff first,
    // then NOT_ON_FLUXER — the shipped idiom); the service runs the whole
    // refusal battery and the case write.
    return refer.handleReferCommand(commandCtx);
  }

  await commandCtx.reply({
    content: `Unknown subcommand: \`${sub}\``,
    sensitive: true,
  });
}

/**
 * /automodconfig — admin config surface. ManageGuild is enforced in the
 * HANDLER (issue #725) as well as via the admin picker tier, so a Fluxer
 * context or a mis-tiered overwrite can never reach a mutation.
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleAutomodConfig(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireAdminFromContext(commandCtx))) return;

  if (!commandCtx.rawInteraction) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }

  const group = commandCtx.subcommandGroup;
  const sub = commandCtx.subcommand;

  if (group === "channel") {
    if (sub === "set") return config.handleChannelSet(commandCtx);
    if (sub === "clear") return config.handleChannelClear(commandCtx);
  } else if (group === "rules") {
    if (sub === "set") return config.handleRulesSet(commandCtx);
    if (sub === "clear") return config.handleRulesClear(commandCtx);
  } else if (group === "safety") {
    if (sub === "resume") return config.handleSafetyResume(commandCtx);
  } else if (sub === "enable") {
    return config.handleEnable(commandCtx);
  } else if (sub === "mode") {
    return config.handleMode(commandCtx);
  } else if (sub === "timeout-cap") {
    return config.handleTimeoutCap(commandCtx);
  } else if (sub === "budget") {
    return config.handleBudget(commandCtx);
  }

  await commandCtx.reply({
    content: `Unknown subcommand: \`${group ? `${group} ` : ""}${sub}\``,
    sensitive: true,
  });
}

module.exports = {
  name: "automod",
  // Slash builders + the #726 "Refer to automod" message context menu. The
  // Fluxer tree filter (#750) drops the non-chat-input entry, so the prefix
  // surface never sees it.
  commands: [...commands, referContextMenu],
  handlers: {
    automod: handleAutomod,
    automodconfig: handleAutomodConfig,
    // #726: message context menu intake. Key is the exact registered display
    // name (the router dispatches context menus by interaction.commandName).
    "Refer to automod": refer.handleReferContextMenu,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): both slash
  // handlers receive a CommandContext; the rules modal and the context-menu
  // intake stay on the raw interaction arm (Discord-only surfaces).
  handlerApi: {
    automod: "context",
    automodconfig: "context",
  },
  modalHandlers: {
    [MODAL_RULES]: config.handleRulesModal,
  },
  // Exported for unit tests + later automod issues (#727 case context and
  // #728 harness build on the referral service + the automod_cases rows;
  // #739 owns the breaker trip write).
  settings,
  refer,
  status: require("./status"),
  constants: require("./constants"),
  buildStatusPayload,
  buildRulesModal: config.buildRulesModal,
};
