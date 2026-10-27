/**
 * Context-menu report INVOKE handlers (#745 — "Report Post" / "Report User").
 *
 * Flow (both variants): requireStaff gate FIRST → resolve the interaction-
 * delivered target → snapshot into the pending store → showModal directly
 * (decision 1: no preview panel). Nothing here creates a ticket, deletes
 * anything, or DMs anyone — that is the modal-submit pipeline (subtasks
 * 06/08), which reads this snapshot back by the token carried in the modal
 * customId (see ./pendingReports.js + ./reportModals.js).
 *
 * Why snapshot HERE: a context-menu interaction carries the full target
 * message (content, author, channel, attachments incl. URLs) regardless of
 * the Message Content intent (decision 3), but the modal submit is a
 * DIFFERENT interaction holding nothing but the customId. Capture at invoke
 * is the only place the evidence exists.
 *
 * Security: the picker tier from subtask 03 is cosmetic — THESE handlers are
 * the source of truth. A non-staff invoke gets the standard ephemeral denial
 * and nothing else: no target read, no snapshot, no modal.
 *
 * Router contract: registered under the exact display names "Report Post" /
 * "Report User" with api "interaction" (the target lives only on the raw
 * interaction; CommandContext is chat-input-only). Handler throws never
 * escape — ids + cause are logged, the invoker gets a reply (error rules
 * 1–3), and a store-refused put (null token) is answered BEFORE any modal:
 * never showModal with a token the store never kept.
 */

const {
  REPORT_KINDS,
  put: putReport,
} = require("./pendingReports");
const { requireStaff } = require("../../core/permissions");
const {
  replyEphemeral,
  safeErrorReply,
} = require("../../core/interaction");
const {
  buildReportMessageModal,
  buildReportUserModal,
} = require("./reportModals");

/**
 * Shared reply for a refused snapshot put (error rule 3: the invoker learns
 * nothing was recorded and what to do — run the command again). The store
 * reports failure as `null` and never a reason (error rule 6), so this is
 * the honest truth, not an invented generic.
 */
const PUT_FAILED_REPLY =
  "Could not start that report — nothing was recorded. Run the command again.";

/**
 * Never-throwing reproducer ids for the failure logs (error rule 2). Reads
 * are defensive: the catch path must not be able to throw while reporting.
 * @param {object} interaction
 * @returns {string}
 */
function invokeIds(interaction) {
  const read = (fn, fallback = "?") => {
    try {
      const value = fn();
      return value == null || value === "" ? fallback : String(value);
    } catch {
      return fallback;
    }
  };
  return (
    `guild=${read(() => interaction?.guildId)}` +
    ` user=${read(() => interaction?.user?.id)}` +
    ` command=${read(() => interaction?.commandName, "")}`
  );
}

/**
 * Array-or-Collection/Map/Set → plain array. discord.js hands message
 * attachments/stickers over as Collections (Map subclasses); mocks may pass
 * arrays. Anything else (null, scalar) is an empty list.
 * @param {unknown} value
 * @returns {Array<unknown>}
 */
function toList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return [...value];
  if (value instanceof Map || value instanceof Set) return [...value.values()];
  if (typeof value.values === "function") {
    try {
      return [...value.values()];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Non-empty-string filter for text metadata lists (embed URLs, sticker
 * names). pendingReports.normalizeTextList would drop these anyway —
 * filtering here keeps the snapshot input honest.
 * @param {unknown} value
 * @returns {boolean}
 */
function isText(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Decision-3 snapshot of the invoke-time target message. Field names are
 * exactly what pendingReports.buildSnapshot re-picks; the store never
 * infers `subjectUserId`, so the message variant names the author here.
 * Attachment entries pass through as-is — normalizeAttachments re-picks
 * {id,name,url,size,contentType} into fresh objects, so the store retains
 * no discord.js instance.
 *
 * @param {import("discord.js").MessageContextMenuCommandInteraction} interaction
 * @param {import("discord.js").Message} message
 * @returns {object}
 */
function buildMessageSnapshot(interaction, message) {
  return {
    kind: REPORT_KINDS.MESSAGE,
    guildId: interaction.guildId ?? message.guildId ?? null,
    reporterUserId: interaction.user?.id ?? null,
    messageId: message.id ?? null,
    channelId: message.channelId ?? message.channel?.id ?? null,
    channelName: message.channel?.name ?? null,
    authorId: message.author?.id ?? null,
    content: message.content ?? null,
    attachments: toList(message.attachments),
    embedUrls: toList(message.embeds)
      .map((embed) => embed?.url)
      .filter(isText),
    stickers: toList(message.stickers)
      .map((sticker) => sticker?.name ?? sticker?.id)
      .filter(isText),
    subjectUserId: message.author?.id ?? null,
  };
}

/**
 * Show the modal with its own log+reply site (error rule 2: a dead/expired
 * interaction leaves a trace with ids + cause, never a silent drop). The
 * orphaned snapshot dies with the store's TTL — no retry path is offered.
 *
 * @param {object} interaction
 * @param {object} modal built modal (customId carries the token)
 * @param {string} kindLabel "post" | "user" (log label only)
 */
async function presentReportModal(interaction, modal, kindLabel) {
  try {
    await interaction.showModal(modal);
  } catch (err) {
    console.error(
      `[tickets] report ${kindLabel} modal show failed:`,
      invokeIds(interaction),
      err?.message || err,
    );
    await safeErrorReply(
      interaction,
      `Could not open the report form: ${err?.message || err} Run the command again.`,
    );
  }
}

/**
 * "Report Post" invoke (message context menu).
 * @param {import("discord.js").MessageContextMenuCommandInteraction} interaction
 * @param {object} [ctx] router context (unused at invoke time)
 */
async function handleReportMessage(interaction, ctx) {
  try {
    if (!(await requireStaff(interaction))) return;

    // The literal registered target-option name is "message" (lowercase) —
    // what Discord sends and what discord.js' own targetMessage getter
    // resolves (MessageContextMenuCommandInteraction → options.getMessage
    // ('message'), verified in node_modules/discord.js).
    const message = interaction.options?.getMessage?.("message") ?? null;
    if (!message) {
      await replyEphemeral(
        interaction,
        "Could not resolve the reported message — it may have been deleted. Nothing was recorded.",
      );
      return;
    }

    const token = putReport(buildMessageSnapshot(interaction, message));
    if (!token) {
      // Error rule 3: the invoker gets the truth BEFORE any modal — a modal
      // built from a refused put could only ever dead-end at submit time.
      await replyEphemeral(interaction, PUT_FAILED_REPLY);
      return;
    }

    await presentReportModal(interaction, buildReportMessageModal(token), "post");
  } catch (err) {
    console.error(
      "[tickets] report invoke failed:",
      invokeIds(interaction),
      err?.message || err,
    );
    await safeErrorReply(interaction);
  }
}

/**
 * "Report User" invoke (user context menu). Bot targets and self-reports
 * are rejected BEFORE any modal (decision 7) — ephemeral, no snapshot.
 *
 * @param {import("discord.js").UserContextMenuCommandInteraction} interaction
 * @param {object} [ctx] router context (unused at invoke time)
 */
async function handleReportUser(interaction, ctx) {
  try {
    if (!(await requireStaff(interaction))) return;

    // Literal registered target-option name "user" (lowercase) — same
    // verification as the message variant (UserContextMenuCommandInteraction
    // → options.getUser('user')).
    const target = interaction.options?.getUser?.("user") ?? null;
    if (!target) {
      await replyEphemeral(
        interaction,
        "Could not resolve the reported member — they may have left the server. Nothing was recorded.",
      );
      return;
    }

    // Mirrors handleFor's bot gate copy (create.js) verbatim.
    if (target.bot) {
      await replyEphemeral(interaction, "Cannot open a ticket for a bot.");
      return;
    }

    // A self-report has no moderation subject — point at the self-serve
    // surface instead (still no snapshot, no modal).
    if (target.id != null && target.id === interaction.user?.id) {
      await replyEphemeral(
        interaction,
        "You can't report yourself — use `/ticket create` to reach staff instead. Nothing was recorded.",
      );
      return;
    }

    const token = putReport({
      kind: REPORT_KINDS.USER,
      guildId: interaction.guildId ?? null,
      reporterUserId: interaction.user?.id ?? null,
      subjectUserId: target.id ?? null,
    });
    if (!token) {
      await replyEphemeral(interaction, PUT_FAILED_REPLY);
      return;
    }

    await presentReportModal(interaction, buildReportUserModal(token), "user");
  } catch (err) {
    console.error(
      "[tickets] report invoke failed:",
      invokeIds(interaction),
      err?.message || err,
    );
    await safeErrorReply(interaction);
  }
}

module.exports = {
  handleReportMessage,
  handleReportUser,
};
