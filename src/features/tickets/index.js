/**
 * Help ticket system — private support channels with sensitive mode and archives.
 *
 * Slash: /ticket create|for|close|claim|transfer|adduser|removeuser|
 *        addstaff|removestaff|sensitive|unsensitive|list|info|
 *        setcategory|setarchive|setratelimit|settings
 *        panel create|list|edit|delete  (stored panel registry)
 * Buttons: tk:open → modal for description → same pipeline as /ticket create
 *          tk:sn:<ticketId> → modal to attach a staff note after close
 * Modals:  tk:create · tk:snm:<ticketId>
 */

const { Events } = require("discord.js");
const { markTicketClosedByChannelDelete } = require("../../db");
// Discord edge: gateway events resolve the event's guild id to the integer
// community key before touching community-scoped repositories.
const { ensureCommunity } = require("../../platform/community");
const { requireStaffFromContext } = require("../../core/permissions");
const { formatTicketRef } = require("../../core/theme");
const { commands } = require("./commands");
const {
  BTN_OPEN,
  MODAL_CREATE,
  BTN_STAFF_NOTE_PREFIX,
  MODAL_STAFF_NOTE_PREFIX,
  MODAL_FIELD_REASON,
  MODAL_FIELD_STAFF_NOTE,
} = require("./constants");
const {
  openTicketChannel,
  buildCreateTicketModal,
  buildOpenTicketButtonRow,
  buildPanelEmbed,
  buildTicketStaffNoteContent,
  buildAddStaffNoteButtonRow,
} = require("./helpers");
const {
  handleCreate,
  handleFor,
  handleOpenTicketButton,
  handleCreateTicketModal,
} = require("./create");
const {
  handlePanelCreate,
  handlePanelList,
  handlePanelEdit,
  handlePanelDelete,
} = require("./panel");
const {
  handleClose,
  handleStaffNoteButton,
  handleStaffNoteModal,
  handleArchive,
  handleClaim,
  handleTransfer,
  handleAddUser,
  handleRemoveUser,
  handleAddStaff,
  handleRemoveStaff,
  handleSensitive,
  handleUnsensitive,
} = require("./lifecycle");
const {
  handleList,
  handleInfo,
  handleSummarize,
  handleSetCategory,
  handleSetArchive,
  handleSetRateLimit,
  handleSettings,
} = require("./admin");
const { MAX_TICKET_REASON } = require("../../db");

/**
 * Standard denial for Fluxer dispatches that reach a Discord-only surface
 * (roadmap/fluxer.md § What stays Discord-only — ticket panels post
 * ActionRowBuilder buttons that Fluxer v1 has no equivalent for).
 */
const NOT_ON_FLUXER = "That command is not available on Fluxer yet.";

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} ctx
 */
async function handleTicket(commandCtx, ctx) {
  const group = commandCtx.subcommandGroup;
  const sub = commandCtx.subcommand;

  // Panel subcommand group: /ticket panel [create|list|edit|delete]
  if (group === "panel") {
    if (!(await requireStaffFromContext(commandCtx))) return;
    // Panel arms stay legacy on the real interaction (roadmap § What stays
    // Discord-only): every panel subcommand posts/edits Discord components
    // (ActionRowBuilder buttons) that Fluxer v1 cannot render. Guard via the
    // documented rawInteraction capability; Fluxer contexts never carry it.
    const raw = commandCtx.rawInteraction;
    if (!raw) {
      await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
      return;
    }
    if (sub === "create") return handlePanelCreate(raw, ctx);
    if (sub === "list") return handlePanelList(raw);
    if (sub === "edit") return handlePanelEdit(raw, ctx);
    if (sub === "delete") return handlePanelDelete(raw, ctx);
  }

  // Public
  if (sub === "create") return handleCreate(commandCtx, ctx);
  if (sub === "settings") return handleSettings(commandCtx);

  // Staff config (no subcommand group)
  if (sub === "setcategory" || sub === "setarchive" || sub === "setratelimit") {
    if (!(await requireStaffFromContext(commandCtx))) return;
    if (sub === "setcategory") return handleSetCategory(commandCtx, ctx);
    if (sub === "setarchive") return handleSetArchive(commandCtx, ctx);
    if (sub === "setratelimit") return handleSetRateLimit(commandCtx, ctx);
  }

  // Staff
  if (!(await requireStaffFromContext(commandCtx))) return;

  if (sub === "for") return handleFor(commandCtx, ctx);
  if (sub === "list") return handleList(commandCtx);
  if (sub === "close") return handleClose(commandCtx, ctx);
  if (sub === "archive") return handleArchive(commandCtx, ctx);
  if (sub === "claim") return handleClaim(commandCtx, ctx);
  if (sub === "transfer") return handleTransfer(commandCtx, ctx);
  if (sub === "adduser") return handleAddUser(commandCtx, ctx);
  if (sub === "removeuser") return handleRemoveUser(commandCtx, ctx);
  if (sub === "addstaff") return handleAddStaff(commandCtx, ctx);
  if (sub === "removestaff") return handleRemoveStaff(commandCtx, ctx);
  if (sub === "sensitive") return handleSensitive(commandCtx, ctx);
  if (sub === "unsensitive") return handleUnsensitive(commandCtx, ctx);
  if (sub === "info") return handleInfo(commandCtx, ctx);
  if (sub === "summarize") return handleSummarize(commandCtx, ctx);

  await commandCtx.reply({
    content: `Unknown subcommand: \`${sub}\``,
    sensitive: true,
  });
}

/**
 * @param {import("discord.js").Client} client
 */
function registerEvents(client) {
  client.on(Events.ChannelDelete, (channel) => {
    try {
      if (!channel?.id) return;
      // DM channels have no guild (and no tickets); guild channels map to
      // the integer community key the tickets repo is now scoped by.
      if (!channel.guild?.id) return;
      const communityId = ensureCommunity({
        platform: "discord",
        instanceKey: "discord",
        externalGuildId: channel.guild.id,
      });
      const closed = markTicketClosedByChannelDelete(communityId, channel.id);
      if (closed) {
        console.log(
          `[tickets] Channel deleted externally; closed ticket #${closed.ticket_number} (no archive)`,
        );
      }
    } catch (err) {
      console.error("[tickets] ChannelDelete handler:", err);
    }
  });
}

module.exports = {
  name: "tickets",
  commands,
  handlers: {
    ticket: handleTicket,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): the slash
  // handler receives a CommandContext. Button/modal arms (tk:open, tk:sn,
  // tk:create, tk:snm) stay on the raw interaction — roadmap
  // § What stays Discord-only.
  handlerApi: {
    ticket: "context",
  },
  buttonHandlers: {
    [BTN_OPEN]: handleOpenTicketButton,
    [BTN_STAFF_NOTE_PREFIX]: handleStaffNoteButton,
  },
  modalHandlers: {
    [MODAL_CREATE]: handleCreateTicketModal,
    [MODAL_STAFF_NOTE_PREFIX]: handleStaffNoteModal,
  },
  registerEvents,
  formatTicketRef,
  openTicketChannel,
  buildCreateTicketModal,
  buildOpenTicketButtonRow,
  buildPanelEmbed,
  buildTicketStaffNoteContent,
  buildAddStaffNoteButtonRow,
  BTN_OPEN,
  BTN_STAFF_NOTE_PREFIX,
  MODAL_CREATE,
  MODAL_STAFF_NOTE_PREFIX,
  MODAL_FIELD_REASON,
  MODAL_FIELD_STAFF_NOTE,
  MAX_TICKET_REASON,
};
