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
const { requireStaff } = require("../../core/permissions");
const { replyEphemeral } = require("../../core/interaction");
const { formatTicketRef } = require("../../core/theme");
const { startTicketHttpServer } = require("./httpServer");
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
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} ctx
 */
async function handleTicket(interaction, ctx) {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  // Panel subcommand group: /ticket panel [create|list|edit|delete]
  if (group === "panel") {
    if (!(await requireStaff(interaction))) return;
    if (sub === "create") return handlePanelCreate(interaction, ctx);
    if (sub === "list") return handlePanelList(interaction);
    if (sub === "edit") return handlePanelEdit(interaction, ctx);
    if (sub === "delete") return handlePanelDelete(interaction, ctx);
  }

  // Public
  if (sub === "create") return handleCreate(interaction, ctx);
  if (sub === "settings") return handleSettings(interaction);

  // Staff config (no subcommand group)
  if (sub === "setcategory" || sub === "setarchive" || sub === "setratelimit") {
    if (!(await requireStaff(interaction))) return;
    if (sub === "setcategory") return handleSetCategory(interaction, ctx);
    if (sub === "setarchive") return handleSetArchive(interaction, ctx);
    if (sub === "setratelimit") return handleSetRateLimit(interaction, ctx);
  }

  // Staff
  if (!(await requireStaff(interaction))) return;

  if (sub === "for") return handleFor(interaction, ctx);
  if (sub === "list") return handleList(interaction);
  if (sub === "close") return handleClose(interaction, ctx);
  if (sub === "archive") return handleArchive(interaction, ctx);
  if (sub === "claim") return handleClaim(interaction, ctx);
  if (sub === "transfer") return handleTransfer(interaction, ctx);
  if (sub === "adduser") return handleAddUser(interaction, ctx);
  if (sub === "removeuser") return handleRemoveUser(interaction, ctx);
  if (sub === "addstaff") return handleAddStaff(interaction, ctx);
  if (sub === "removestaff") return handleRemoveStaff(interaction, ctx);
  if (sub === "sensitive") return handleSensitive(interaction, ctx);
  if (sub === "unsensitive") return handleUnsensitive(interaction, ctx);
  if (sub === "info") return handleInfo(interaction, ctx);
  if (sub === "summarize") return handleSummarize(interaction, ctx);

  await replyEphemeral(interaction, {
    content: `Unknown subcommand: \`${sub}\``,
  });
}

/**
 * @param {import("discord.js").Client} client
 */
function registerEvents(client) {
  client.on(Events.ChannelDelete, (channel) => {
    try {
      if (!channel?.id) return;
      const closed = markTicketClosedByChannelDelete(channel.id);
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

/**
 * @param {import("discord.js").Client} client
 */
function start(client) {
  startTicketHttpServer();
}

module.exports = {
  name: "tickets",
  commands,
  handlers: {
    ticket: handleTicket,
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
  start,
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
