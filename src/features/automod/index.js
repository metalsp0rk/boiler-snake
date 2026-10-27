/**
 * Auto-moderation — staff referral, recommendations, and a gated action
 * harness (#725 slice: settings + config commands; epic #723).
 *
 * Slash: /automod status (staff) · /automodconfig
 *        channel set|clear · rules set|clear · enable on|off ·
 *        mode <action> <off|suggest|auto> · timeout-cap · budget ·
 *        safety resume (confirm:)  (admin, ManageGuild in handler too)
 * Modals: am:rules — long rules text (same idea as /note add's modal)
 *
 * Discord-only for this milestone (epic decision 8 — Fluxer is explicit
 * no-parity, stated in docs/automod.md): every arm refuses the standard
 * NOT_ON_FLUXER sentence when the context carries no raw Discord interaction
 * (the case-card surface, the @everyone overwrite read, and the modal all
 * need Discord components).
 *
 * Deliberate absences (by contract, not omission):
 *  - NO mode column/option for staff notes — the note tool is always on
 *    (locked decision 4).
 *  - NO LLM call anywhere here; the harness is #728, referrals #726.
 *  - NO new env vars — storage is the automod_* guild_settings family only.
 */

const {
  requireStaffFromContext,
  requireAdminFromContext,
} = require("../../core/permissions");
const { commands } = require("./commands");
const {
  NOT_ON_FLUXER,
  MODAL_RULES,
} = require("./constants");
const { buildStatusPayload } = require("./status");
const config = require("./config");
const settings = require("./settings");

/**
 * /automod — staff read surface (epic: staff may check state; changes are
 * all under /automodconfig).
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
  commands,
  handlers: {
    automod: handleAutomod,
    automodconfig: handleAutomodConfig,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): both slash
  // handlers receive a CommandContext; the rules modal stays on the raw
  // interaction arm (Discord-only surface).
  handlerApi: {
    automod: "context",
    automodconfig: "context",
  },
  modalHandlers: {
    [MODAL_RULES]: config.handleRulesModal,
  },
  // Exported for unit tests + later automod issues (#726 referral gate
  // reuses the settings service; #739 owns the breaker trip write).
  settings,
  status: require("./status"),
  constants: require("./constants"),
  buildStatusPayload,
  buildRulesModal: config.buildRulesModal,
};
