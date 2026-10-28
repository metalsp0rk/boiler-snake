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
 * Buttons (#730): am:card:approve:<rowId> / am:card:dismiss:<rowId> on the
 *        harness case card — staff-gated arms in ./card.js execute suggested
 *        actions through the shared executor and rebuild the card from the
 *        ledger rows (raw-interaction arms; the Fluxer dispatcher has no
 *        component path — explicit no-parity).
 *
 * Discord-only for this milestone (epic decision 8 — Fluxer is explicit
 * no-parity, stated in docs/automod.md): every arm refuses the standard
 * NOT_ON_FLUXER sentence when the context carries no raw Discord interaction
 * (the case-card surface, the @everyone overwrite read, and the modal all
 * need Discord components). The context menu additionally never reaches the
 * Fluxer dispatcher (#750's chat-input-only tree filter).
 *
 * Deliberate absences (by contract, not omission):
 *  - LLM calls live in ./harness.js ONLY (#728 shipped): command handlers
 *    never touch a provider. Referral intake (#726) stops at a stored case
 *    + the ack — see ./refer.js for why the ack may never claim a
 *    recommendation was produced; the harness posts the outcome separately.
 *  - NO new env vars — storage is the automod_* guild_settings family plus
 *    the automod_cases table (068) with its run-metadata columns (070);
 *    the provider rides the shared AI_* trio via src/core/ai.js.
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
  CARD_APPROVE_PREFIX,
  CARD_DISMISS_PREFIX,
} = require("./constants");
const { buildStatusPayload } = require("./status");
const config = require("./config");
const refer = require("./refer");
const settings = require("./settings");
const harness = require("./harness");
const card = require("./card");

/**
 * BOOT HOOK (#728). Runs once at ClientReady behind load.js's per-feature
 * guard (a throw here logs `[features] automod.start failed:` and login
 * continues — keep it that way).
 *
 *  1. Installs the refer→harness trigger: every recorded-and-acked referral
 *     then fires `runAutomodCase` DETACHED (refer.js owns the fire + its
 *     catch; the harness's atomic claim keeps it one-run-per-case). A
 *     wiring failure logs and leaves intake fully working — cases just
 *     queue until the next boot.
 *  2. Boot sweep: cases stuck in `processing` from a previous boot are
 *     terminalized `failed` ("run interrupted by restart") with a
 *     best-effort channel notice. Synchronous DB pass, detached posts
 *     (each self-catching) — this hook NEVER returns a rejecting promise
 *     (load.js only guards synchronous throws, and a rejected hook promise
 *     would be an unhandled rejection at boot).
 *
 * @param {{discord?: object|null}} supervisor
 * @returns {{checked:number, flipped:number}|undefined} sweep summary (tests)
 */
function start(supervisor) {
  const client = supervisor?.discord ?? null;
  try {
    refer.setRunCaseHook(harness.makeReferRunHook({ client }));
  } catch (err) {
    console.error("[automod] harness run-hook wiring failed:", err?.message || err);
  }
  try {
    const sweep = harness.sweepInterruptedRuns({ client });
    // Every sweep post already catches internally; allSettled is the belt.
    if (Array.isArray(sweep?.posts) && sweep.posts.length > 0) {
      Promise.allSettled(sweep.posts);
    }
    return { checked: sweep.checked, flipped: sweep.flipped };
  } catch (err) {
    console.error("[automod] boot sweep crashed:", err?.message || err);
    return undefined;
  }
}

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
  // #730: the case-card buttons. The router matches customId by longest
  // prefix, so `am:card:approve:` / `am:card:dismiss:` route here. Handlers
  // are `(interaction, ctx)` on the RAW interaction (Discord components —
  // the Fluxer dispatcher has no button path at all; belt refusal inside the
  // arms, see ./card.js).
  buttonHandlers: {
    [CARD_APPROVE_PREFIX]: card.handleCardApprove,
    [CARD_DISMISS_PREFIX]: card.handleCardDismiss,
  },
  // #728: boot wiring (harness trigger + interrupted-run sweep), guarded by
  // load.js's per-feature hook isolation like every other boot surface.
  start,
  // Exported for unit tests + later automod issues (#727 case context and
  // #728 harness build on the referral service + the automod_cases rows;
  // #730's card (builders + button arms) rebuilds from the ledger rows;
  // #739 owns the breaker trip write).
  settings,
  refer,
  harness,
  card,
  status: require("./status"),
  constants: require("./constants"),
  buildStatusPayload,
  buildRulesModal: config.buildRulesModal,
};
