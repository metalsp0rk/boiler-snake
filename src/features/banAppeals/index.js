/**
 * Ban appeals feature module (#773) — one appeal per tracked ban, filed from
 * the ban DM, reviewed in a staff ticket, decided with clemency/deny, with a
 * two-way message ferry while it is open.
 *
 * Thin module on the load.js contract (banLifecycle twin): the slash surface
 * (/banappeals: enable/disable/status) comes from ./commands; the interaction
 * arms come from ./events:
 *
 *  - buttonHandlers `ap:` — the whole in-ticket header family (clemency /
 *    deny press / pause) through ONE arm; the registry's longest-prefix
 *    dispatch keeps the family out of every other feature (collision audited
 *    in constants.js — load.js claim() still fails boot on any shadow);
 *  - modalHandlers `ap:deny:m:` — the denial-reason modal submit;
 *  - registerEvents → ./events (the GUILDESS `appeal:`/`appeal:s:` intake
 *    lane the router can never see (:74/:142/:174 guild guard, untouched),
 *    the ferry MessageCreate lanes and the ChannelDelete plain-close);
 *  - start → the bounded boot ferry catch-up, fire-and-forget (a replay that
 *    outlives the 3s boot budget belongs to no synchronous hook; every leg
 *    logs its own failures and the cursors stay truthful for what skipped).
 *    Returns the { stop() } loop-handle shape load.js registers with
 *    core/lifecycle — nothing long-running survives start, so stop is the
 *    documented no-op.
 *
 * Explicit Fluxer NO-PARITY (#773 epic decision): the ban-DM button, the
 * statement modal, the header buttons and the ferry relay are all Discord
 * component mechanics; the /banappeals handler refuses Fluxer contexts with
 * the shipped sentence. Docs: docs/ban-appeals.md.
 */

const { LOG_PREFIX, AP_TICKET_PREFIX, AP_DENY_MODAL_PREFIX } = require("./constants");
const {
  commands,
  handlers,
  handlerApi,
} = require("./commands");
const {
  registerEvents,
  runBootCatchUp,
  handleAppealTicketButton,
  handleDenyReasonModal,
} = require("./events");

/**
 * Boot hook (guarded per-feature by load.js): replay per-direction ferry
 * history for open appeals without ever blocking boot (bounded per appeal by
 * FERRY_CATCHUP_MAX + the listOpenAppeals scan cap; one appeal's failure
 * never stops the sweep). Double-boot harmless: the cursors advance only
 * with actually-relayed messages, so a second pass is a no-op read.
 *
 * No scheduler job: catch-up is a boot-boundary repair, live traffic owns
 * everything after (documented deviation from the ticker-style features).
 *
 * @param {import("../../platform/boot").Supervisor|null} supervisor
 * @param {object} [featureCtx]
 * @returns {{ stop: () => void }} loop handle for the graceful-shutdown drain
 */
function start(supervisor, featureCtx) {
  void featureCtx;
  runBootCatchUp(supervisor).catch((err) =>
    console.error(`${LOG_PREFIX} boot ferry catch-up failed:`, err?.message || err),
  );
  return { stop() {} };
}

module.exports = {
  name: "banAppeals",
  commands,
  handlers,
  handlerApi,
  buttonHandlers: {
    [AP_TICKET_PREFIX]: handleAppealTicketButton,
  },
  modalHandlers: {
    [AP_DENY_MODAL_PREFIX]: handleDenyReasonModal,
  },
  registerEvents,
  start,
};
