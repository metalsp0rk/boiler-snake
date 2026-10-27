/**
 * Context-menu report handlers (#745 — "Report Post" / "Report User").
 *
 * Flow (both variants): requireStaff gate FIRST → resolve the interaction-
 * delivered target → snapshot into the pending store → showModal directly
 * (decision 1: no preview panel). The INVOKE handlers here create no ticket
 * and delete nothing; the modal-submit pipeline (this file, subtasks 06 +
 * 08) reads the snapshot back by the token carried in the modal customId
 * (see ./pendingReports.js + ./reportModals.js).
 *
 * SUBMIT side (this file): `openReportTicket` is the shared ticket-open
 * helper both variants run — locked decision 5 EXACTLY: the existing
 * `openTicketChannel` called with creatorUserId === openedByStaffId ===
 * reporter (the "staff opened for themselves" branch, helpers.js ~L765),
 * is_sensitive untouched (stays 0, decision 6), NO DM, NO user rate-limit.
 * `handleReportUserModal` is the user variant's full submit (subtask 06);
 * `handleReportMessageModal` is the message variant beside it (subtask 08),
 * composing its evidence build / disposition / delete / insert fields
 * AROUND the same `openReportTicket` call — in the locked
 * evidence-before-delete order that IS the safety design (decision 4).
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

const { EmbedBuilder, MessageFlags } = require("discord.js");
const {
  REPORT_KINDS,
  put: putReport,
  take: takeReport,
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
const { openTicketChannel } = require("./helpers");
const {
  formatChannelCreateError,
  formatStaffRoleAccessNote,
} = require("./overwrites");
const {
  buildEvidenceMessage,
  inlineEscape,
  fencedBlock,
} = require("./reportEvidence");
const { buildMessageJumpUrl } = require("../../core/jumpUrl");
const { recordSlashAudit } = require("../../core/auditTrail");
// Discord edge: (platform, instanceKey, snowflake) → integer community id,
// resolved once per entry point (same pattern as create.js's flows).
const { ensureCommunity } = require("../../platform/community");
const {
  insertTicketReport,
  findOpenReportForMessage,
  MAX_TICKET_REASON,
} = require("../../db");
const { Color, formatTicketRef, tsFull } = require("../../core/theme");
const { sliceSafe } = require("../../core/text");
const {
  MODAL_REPORT_MESSAGE_PREFIX,
  MODAL_REPORT_USER_PREFIX,
  MODAL_REPORT_FIELD_CONTEXT,
  MODAL_REPORT_FIELD_DELETE,
} = require("./constants");

/**
 * Shared reply for a refused snapshot put (error rule 3: the invoker learns
 * nothing was recorded and what to do — run the command again). The store
 * reports failure as `null` and never a reason (error rule 6), so this is
 * the honest truth, not an invented generic.
 */
const PUT_FAILED_REPLY =
  "Could not start that report — nothing was recorded. Run the command again.";

/**
 * Never-throwing field reader for the failure logs (error rule 2 wants
 * reproducer ids, and the catch path must not be able to throw while
 * reporting). Shared by the invoke- and submit-side id strings.
 * @param {() => unknown} fn
 * @param {string} [fallback]
 * @returns {string}
 */
function readField(fn, fallback = "?") {
  try {
    const value = fn();
    return value == null || value === "" ? fallback : String(value);
  } catch {
    return fallback;
  }
}

/**
 * Reproducer ids for the invoke-side failure logs. Reads are defensive:
 * the catch path must not be able to throw while reporting.
 * @param {object} interaction
 * @returns {string}
 */
function invokeIds(interaction) {
  return (
    `guild=${readField(() => interaction?.guildId)}` +
    ` user=${readField(() => interaction?.user?.id)}` +
    ` command=${readField(() => interaction?.commandName, "")}`
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

// ---------------------------------------------------------------------------
// Modal submit — shared ticket open + BOTH variant submits. "Report User"
// landed here in subtask 06; the "Report Post" (message) submit joins beside
// it (subtask 08), composing its evidence build / disposition / delete /
// insert fields AROUND openReportTicket in the locked decision-4 order.
// ---------------------------------------------------------------------------

/** Snowflake-shaped ids (same rule as reportEvidence.js) may render mentions. */
const SNOWFLAKE_RE = /^[0-9]{1,25}$/;

/**
 * Token consumed early, unknown, expired, or already spent — the modal can
 * only be re-minted by the command (error rule 3: the submitter learns what
 * to DO, decision 3's restart-mid-flow path).
 */
const REPORT_EXPIRED_REPLY =
  "This report form has expired or was already used — run the command again.";

/** Mirrors handleFor's bot gate copy (create.js) verbatim. */
const BOT_SUBJECT_REPLY = "Cannot open a ticket for a bot.";

/** Mirrors the invoke-side self-report copy (above) verbatim. */
const SELF_SUBJECT_REPLY =
  "You can't report yourself — use `/ticket create` to reach staff instead. Nothing was recorded.";

/** Mirrors the invoke-side unresolvable-member copy (above) verbatim. */
const NO_SUBJECT_REPLY =
  "Could not resolve the reported member — they may have left the server. Nothing was recorded.";

/** Ellipsis appended when the modal context busts the tickets.reason cap. */
const REASON_MARKER = "…";

/**
 * Dep-injection seam (mirrors core/auditTrail's createAuditTrailDeps): the
 * submit pipeline's REST/DB touchpoints are overridable for tests. Production
 * always gets the real modules; tests spy or substitute a single function
 * without patching helpers.js or the db layer.
 *
 * `findOpenReportForMessage` + `buildEvidenceMessage` are the message
 * variant's additions (subtask 08): the duplicate nudge read and the
 * evidence build ride the SAME seam, so a test can force the
 * evidence-build-failure arm (→ delete must NEVER run) without patching
 * reportEvidence.js, and the nudge read can never kill the submit flow.
 *
 * @param {object} [options]
 * @returns {{
 *   openTicketChannel: Function,
 *   ensureCommunity: Function,
 *   insertTicketReport: Function,
 *   recordSlashAudit: Function,
 *   findOpenReportForMessage: Function,
 *   buildEvidenceMessage: Function,
 * }}
 */
function createReportTicketDeps(options = {}) {
  return {
    openTicketChannel: options.openTicketChannel || openTicketChannel,
    ensureCommunity: options.ensureCommunity || ensureCommunity,
    insertTicketReport: options.insertTicketReport || insertTicketReport,
    recordSlashAudit: options.recordSlashAudit || recordSlashAudit,
    findOpenReportForMessage:
      options.findOpenReportForMessage || findOpenReportForMessage,
    buildEvidenceMessage: options.buildEvidenceMessage || buildEvidenceMessage,
  };
}

/**
 * Reproducer ids for the submit-side failure logs. The customId is
 * DELIBERATELY absent: it embeds the one-shot token, which is a capability
 * for a flow that can delete a member's message (same rule as
 * ./pendingReports.js' take-failure log).
 *
 * @param {object} interaction
 * @param {string} [flow]
 * @returns {string}
 */
function submitIds(interaction, flow = "report") {
  return (
    `guild=${readField(() => interaction?.guildId)}` +
    ` user=${readField(() => interaction?.user?.id)}` +
    ` flow=${flow}`
  );
}

/**
 * Read one modal text input tolerantly. Discord enforces the field's
 * required flag at submit, so a throw/absence here means a malformed or
 * foreign modal — an empty string keeps the flow honest (the ticket opens
 * without a reason and the card says so) instead of dying in a parser.
 *
 * @param {object} interaction modal submit
 * @param {string} fieldId text-input customId (constants.js)
 * @returns {string} trimmed value, "" when absent
 */
function readModalText(interaction, fieldId) {
  try {
    const raw = interaction?.fields?.getTextInputValue?.(fieldId);
    return typeof raw === "string" ? raw.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Ticket reason for a report: the reporter's trimmed context, cut at the
 * DB cap with an ellipsis marker. The modal field allows 4000 chars but
 * `tickets.reason` enforces MAX_TICKET_REASON (createTicket would otherwise
 * throw INVALID_REASON), so the cut is unconditional, never a refusal.
 *
 * @param {string} contextText
 * @returns {string|null} null for empty context (openTicketChannel embeds
 *   "_No reason provided._")
 */
function reportTicketReason(contextText) {
  const text = typeof contextText === "string" ? contextText.trim() : "";
  if (text === "") return null;
  if (text.length <= MAX_TICKET_REASON) return text;
  return sliceSafe(text, MAX_TICKET_REASON - REASON_MARKER.length) + REASON_MARKER;
}

/**
 * create.js's translated create-failure sentence (handleFor's catch plus
 * completeSelfCreate's INVALID_REASON arm): the specific error IS the reply;
 * unknown causes get the formatChannelCreateError hint (error rule 3).
 *
 * @param {unknown} err
 * @returns {string}
 */
function reportCreateFailureMessage(err) {
  if (
    err?.code === "INVALID_REASON" ||
    err?.code === "BOT_PERMISSIONS" ||
    err?.code === "CHANNEL_CREATE"
  ) {
    return err.message;
  }
  return `Failed to open ticket: ${formatChannelCreateError(err)}`;
}

/**
 * Open the moderation ticket for a context-menu report — locked decision 5
 * EXACTLY, SHARED by both report variants.
 *
 * What it does: resolves the integer community key at this Discord edge
 * (ensureCommunity, the create.js entry-point pattern; a pre-resolved
 * `communityId` param wins), then runs the EXISTING `openTicketChannel`
 * with `creatorUserId === openedByStaffId === reporter`, so the "staff
 * opened for themselves" branch (helpers.js ~L765) grants the reporter
 * STAFF_ALLOW, every manageable senior staff_roles role STAFF_ALLOW, and
 * @everyone is denied. The reason is the trimmed report context cut to
 * MAX_TICKET_REASON with a marker.
 *
 * What it NEVER does (locked decisions 5/6, error rule — this is the safety
 * boundary): no DM to anyone (the reported user is never even added to the
 * channel; subject-facing contact stays with `/ticket open-for`), no
 * `canUserCreateTicket`/create-slot call (staff flows bypass the user rate
 * limit, exactly like handleFor), and no sensitivity flag — createTicket
 * hard-codes `is_sensitive = 0` and applyTicketOverwrites runs with
 * `sensitive: false`, which is decision 6's durability posture (the close→
 * archive pipeline mirrors the evidence media; sensitive tickets would post
 * metadata-only stubs).
 *
 * Subtask 08 (message variant) calls it with the SAME params — its snapshot
 * carries kind "message"; nothing here reads variant-specific fields. The
 * evidence-builder inputs (contextText, fetch seams), the decision-13
 * disposition line, the delete step, and the insertTicketReport fields
 * (kind / reportedMessageId / sourceChannelId / messageDeleted) are the
 * CALLER's pipeline, composed around this call:
 *
 *   const opened = await openReportTicket({ interaction, ctx, snapshot, contextText, deps });
 *   if (!opened.ok) → reply opened.error
 *   else → buildEvidenceMessage(snapshot, { reporterUserId, contextText, deleted })
 *          → channel.send → delete → insertTicketReport({ kind: "message",
 *            reportedMessageId, sourceChannelId, messageDeleted }) → audit.
 *
 * @param {object} params
 * @param {object} params.interaction modal submit (guild + user are authoritative)
 * @param {object} [params.ctx] router context (supervisor.discord → client)
 * @param {object} params.snapshot pendingReports snapshot (reporterUserId/guildId fallback)
 * @param {string} [params.contextText] modal "Additional context" input
 * @param {number|null} [params.communityId] pre-resolved integer key (tests/edges)
 * @param {object} [params.deps] createReportTicketDeps overrides (tests)
 * @returns {Promise<{ ok: true, ticket: object, channel: object,
 *   skippedStaffRoles: object[], communityId: number, reason: string|null }
 *   | { ok: false, error: string }>} never rejects (error rule 6)
 */
async function openReportTicket(params = {}) {
  const {
    interaction,
    ctx,
    snapshot,
    contextText,
    communityId: communityIdParam,
  } = params;
  const deps = createReportTicketDeps(params.deps);

  // The SUBMITTER is the reporter: they hold the one-shot token and passed
  // the staff gate just now (the snapshot's ids are the fallback only).
  const reporterUserId = interaction?.user?.id ?? snapshot?.reporterUserId ?? null;
  const guildId = interaction?.guildId ?? snapshot?.guildId ?? null;
  if (!reporterUserId || !guildId || !interaction?.guild) {
    return {
      ok: false,
      error: "Failed to open ticket: this report is missing its server or reporter.",
    };
  }

  const reason = reportTicketReason(contextText);

  try {
    const communityId = Number.isSafeInteger(communityIdParam)
      ? communityIdParam
      : deps.ensureCommunity({
          platform: "discord",
          instanceKey: "discord",
          externalGuildId: String(guildId),
        });

    const { ticket, channel, skippedStaffRoles } = await deps.openTicketChannel({
      guild: interaction.guild,
      // Same client resolution as completeSelfCreate/handleFor: supervisor's
      // raw Discord client first, the interaction's own client as fallback.
      client: ctx?.supervisor?.discord || interaction.client,
      // Decision 5: reporter on BOTH sides → the staff-self branch (reporter
      // gets STAFF_ALLOW, all manageable staff roles get STAFF_ALLOW,
      // @everyone denied). The reported user is nowhere in this call.
      creatorUserId: reporterUserId,
      reason,
      openedByStaffId: reporterUserId,
      communityId,
    });

    return { ok: true, ticket, channel, skippedStaffRoles, communityId, reason };
  } catch (err) {
    // Rule 2: ids + cause; the translated sentence goes straight into the
    // caller's reply (rule 3), so it is logged once here, not re-thrown.
    console.error(
      `[tickets] report ticket open failed (${submitIds(interaction, "report")}):`,
      err?.message || err,
    );
    return { ok: false, error: reportCreateFailureMessage(err) };
  }
}

/**
 * Mention rendered INSIDE inline code — decision 7's transcript-leak-safe
 * form (`<@!id>` as literal text: visible, inert, never pings). A non-
 * snowflake id has no meaningful mention at all, so it degrades to the
 * escaped id in the same code span (a planted payload can never close the
 * span — inlineEscape backslash-escapes every marker first).
 *
 * @param {string} id
 * @returns {string}
 */
function codeMention(id) {
  return SNOWFLAKE_RE.test(id)
    ? `\`<@!${id}>\``
    : `\`${inlineEscape(sliceSafe(id, 64))}\``;
}

/**
 * Live mention for a real participant (the reporter — mirrors
 * reportEvidence's mentionFor live branch; garbage ids degrade to escaped
 * code text, never to smuggled markup).
 *
 * @param {string} id
 * @returns {string}
 */
function liveMention(id) {
  return SNOWFLAKE_RE.test(id)
    ? `<@${id}>`
    : `\`${inlineEscape(sliceSafe(id, 64))}\``;
}

/**
 * The decision-7 reported-user card — the user variant's evidence message.
 * Code-wrapped `<@!id>` mention + raw id (transcript-safe), reporter (live
 * mention — a participant of the ticket), capture timestamp, and the
 * reporter's context fenced for markdown inertness (reportEvidence's
 * fencedBlock: the fence outlives any backtick run inside, so the chunk can
 * neither escape it nor ping). Context is capped at 4000 by the modal
 * field, so the fenced description always fits the 4096 per-embed cap —
 * no split ladder needed here (the message variant owns that machinery).
 *
 * @param {object} p
 * @param {object} p.snapshot pendingReports snapshot (capturedAt)
 * @param {string} p.reporterUserId
 * @param {string} p.subjectUserId
 * @param {string} p.contextText trimmed modal context ("" allowed)
 * @returns {{ content: string, embeds: EmbedBuilder[], allowedMentions: object }}
 */
function buildReportUserCard({ snapshot, reporterUserId, subjectUserId, contextText }) {
  const context = typeof contextText === "string" ? contextText.trim() : "";
  const stamp = Number(snapshot?.capturedAt);
  const capturedAt = Number.isFinite(stamp) && stamp > 0 ? Math.floor(stamp) : null;

  const embed = new EmbedBuilder()
    .setColor(Color.caution)
    .setTitle("Reported user")
    .setDescription(
      context === ""
        ? "_No additional context was provided._"
        : fencedBlock(context),
    )
    .addFields(
      {
        name: "Reported user",
        value: `${codeMention(subjectUserId)}\nID: \`${inlineEscape(
          sliceSafe(subjectUserId, 64),
        )}\``,
      },
      { name: "Reported by", value: liveMention(reporterUserId), inline: true },
      { name: "Reported", value: tsFull(capturedAt), inline: true },
    );
  if (capturedAt != null) embed.setTimestamp(new Date(capturedAt));

  return {
    content: `**Reported user card** — logged by ${liveMention(reporterUserId)}`,
    embeds: [embed],
    // Only the reporter may be a live mention; the reported user is NEVER
    // pinged anywhere in the report flow (decision 7).
    allowedMentions: {
      users: SNOWFLAKE_RE.test(reporterUserId) ? [reporterUserId] : [],
      repliedUser: false,
    },
  };
}

/**
 * Post the card into the fresh ticket channel. A failed post is a PARTIAL
 * failure (error rule 5): the ticket and its DB record stand, the caller
 * learns the specific cause for its reply — never a silent drop, never a
 * false "all good".
 *
 * @param {object} channel ticket channel
 * @param {object} card buildReportUserCard payload
 * @param {string} ids log id string
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function postReportUserCard(channel, card, ids) {
  try {
    await channel.send(card);
    return { ok: true };
  } catch (err) {
    console.error(
      `[tickets] report user evidence post failed (${ids}):`,
      err?.message || err,
    );
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Best-effort bot re-check of a snapshot subject at submit time. The store
 * keeps ids only (05 stored `target.id`; bot-ness was gated at invoke), so
 * the guild member is the only source: cache first, then fetch. `null`
 * (unknown — member left or REST failed) is returned as UNKNOWN and the
 * handler proceeds: a Discord account never becomes a bot after the invoke
 * refused it, and the one-shot token only ever reaches the staff invoker.
 * (Refetching at the guild edge is possible here, so this arm is defensive
 * depth, not a documented hole.)
 *
 * @param {object} guild
 * @param {string} subjectUserId
 * @returns {Promise<boolean|null>} true bot · false human · null unknown
 */
async function refetchSubjectIsBot(guild, subjectUserId) {
  try {
    const cached = guild?.members?.cache?.get?.(subjectUserId) ?? null;
    const member = cached ?? (await guild?.members?.fetch?.(subjectUserId)) ?? null;
    if (!member) return null;
    return member.user?.bot === true || member.bot === true;
  } catch {
    return null;
  }
}

/**
 * "Report User" modal submit (`tk:rep:u:<token>`).
 *
 * Order is the safety design: staff re-check FIRST (the submitter is
 * authoritative — their status may have changed since the invoke; a denial
 * has zero side effects) → one-shot token consumption (expired/consumed/
 * unknown → specific ephemeral, nothing created) → defensive bot/self
 * re-check of the snapshot subject → ephemeral defer → openReportTicket →
 * insertTicketReport → evidence card → audit → ephemeral confirmation.
 * Partial failures (record/evidence) keep the ticket and ride along in the
 * final reply (error rule 5); the ticket-create failure replies with its
 * translated cause and stops there.
 *
 * @param {import("discord.js").ModalSubmitInteraction} interaction
 * @param {object} [ctx] router context
 * @param {object} [opts] TEST/deps seam — the router only ever passes
 *   (interaction, ctx); `opts.deps` overrides createReportTicketDeps.
 */
async function handleReportUserModal(interaction, ctx, opts = {}) {
  const deps = createReportTicketDeps(opts?.deps || {});
  try {
    // 1. Staff gate on the SUBMITTER (same gate as the invoke — the picker
    //    tier is cosmetic; this handler remains the security source of truth).
    if (!(await requireStaff(interaction))) return;

    if (!interaction.guild) {
      await replyEphemeral(interaction, "Tickets can only be opened in a server.");
      return;
    }
    if (interaction.user?.bot) {
      await replyEphemeral(interaction, "Bots cannot open tickets.");
      return;
    }

    // 2. One-shot token (decision 3). A kind mismatch means this prefix was
    //    fed something else — same honest outcome as a spent token.
    const token = String(interaction.customId ?? "")
      .slice(MODAL_REPORT_USER_PREFIX.length)
      .trim();
    const snapshot = takeReport(token);
    if (!snapshot || snapshot.kind !== REPORT_KINDS.USER) {
      await replyEphemeral(interaction, REPORT_EXPIRED_REPLY);
      return;
    }

    // 3. Defensive submit-time re-check of the invoke-side guards (decision 7).
    const reporterId = interaction.user?.id ?? snapshot.reporterUserId ?? null;
    const subjectId = snapshot.subjectUserId;
    if (!subjectId) {
      await replyEphemeral(interaction, NO_SUBJECT_REPLY);
      return;
    }
    if (subjectId === reporterId || subjectId === snapshot.reporterUserId) {
      await replyEphemeral(interaction, SELF_SUBJECT_REPLY);
      return;
    }
    if ((await refetchSubjectIsBot(interaction.guild, subjectId)) === true) {
      await replyEphemeral(interaction, BOT_SUBJECT_REPLY);
      return;
    }

    // 4. Everything past this point does REST + DB work.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const contextText = readModalText(interaction, MODAL_REPORT_FIELD_CONTEXT);
    const ids = submitIds(interaction, "report_user");

    const opened = await openReportTicket({
      interaction,
      ctx,
      snapshot,
      contextText,
      deps,
    });
    if (!opened.ok) {
      // openReportTicket logged ids+cause once already (rule 2); the
      // translated cause IS the reply (rule 3, mirroring handleFor's catch).
      await interaction.editReply({ content: opened.error });
      return;
    }
    const { ticket, channel, skippedStaffRoles, communityId } = opened;

    // 5. Side record (decision 13). snapshot_note stays null by the epic
    //    contract: the context text lives on tickets.reason AND the card —
    //    the row keeps its structured fields.
    const problems = [];
    const inserted = deps.insertTicketReport({
      ticketId: ticket.id,
      kind: "user",
      subjectUserId: subjectId,
      messageDeleted: 0,
      snapshotNote: null,
    });
    if (!inserted?.ok) {
      // Rule 5: the ticket EXISTS — never pretend the whole flow failed,
      // never hide the gap either.
      console.error(
        `[tickets] report user record failed (${ids} ticket=${ticket.id}):`,
        inserted?.error || "unknown database failure",
      );
      problems.push(
        `Could not save the report record: ${inserted?.error || "unknown database failure"} — the ticket itself is intact.`,
      );
    }

    // 6. Reported-user card into the ticket (decision 7).
    const card = buildReportUserCard({
      snapshot,
      reporterUserId: reporterId,
      subjectUserId: subjectId,
      contextText,
    });
    const posted = await postReportUserCard(channel, card, ids);
    if (!posted.ok) {
      problems.push(`Could not post the evidence card: ${posted.error}`);
    }

    // 7. Audit trail (decision 13). recordSlashAudit is fail-safe by contract.
    deps.recordSlashAudit({
      interaction,
      communityId,
      action: "tickets.report_user",
      targetType: "ticket",
      targetId: String(ticket.id),
      details: {
        ticket_number: ticket.ticket_number,
        subject_user_id: subjectId,
        channel_id: channel?.id ?? null,
      },
    });

    // 8. Ephemeral confirmation — ticket ref + channel, staff-role note, and
    //    every partial failure line (rule 5: never claim total success).
    let msg = `Ticket **${formatTicketRef(ticket.ticket_number)}** opened: <#${channel.id}>`;
    if (skippedStaffRoles?.length) {
      msg += formatStaffRoleAccessNote(skippedStaffRoles);
    }
    if (problems.length) {
      msg += `\n\n${problems.map((p) => `_${p}_`).join("\n")}`;
    }
    await interaction.editReply({ content: msg });
  } catch (err) {
    console.error(
      "[tickets] report user submit failed:",
      submitIds(interaction, "report_user"),
      err?.message || err,
    );
    await safeErrorReply(interaction);
  }
}

// ---------------------------------------------------------------------------
// "Report Post" (message variant) submit — subtask 08. Composes the locked
// decision-4 pipeline AROUND openReportTicket: the evidence message is
// built and POSTED before the flow dares to delete anything, and every
// failure after the ticket exists rides into the final reply as a partial
// result (error rule 5).
// ---------------------------------------------------------------------------

/** Fallback tail for kept/deleted note lines when no jump link is buildable. */
const NO_JUMP = "jump link unavailable";

/** Decision-2 delete words (case-insensitive, post-trim) → delete. */
const DELETE_WORDS = new Set(["yes", "y"]);

/** Decision-2 keep words that echo NOTHING — recognized negative answers. */
const KEEP_WORDS = new Set(["no", "n"]);

/** Cause text inside the evidence-failure line is capped so the 2000-char
 * reply can never be busted by a pathological error message. */
const CAUSE_CAP = 300;

/**
 * Decision-2 delete-choice parse — VERBATIM safety contract: only
 * `yes`/`y` (case-insensitive) delete; ANYTHING ELSE keeps, and an
 * unrecognized non-empty input echoes
 * `input 'X' not understood — message kept`. The echo shows the submitted
 * string with surrounding whitespace stripped only (readModalText trims;
 * case is preserved — lowercasing is for the MATCH, never for the echo),
 * so the reporter re-reads exactly what they typed. NEVER destroy on a
 * misread: recognition is the only path to a destructive choice.
 *
 * @param {string} raw trimmed modal answer ("" when absent — the field is
 *   required, so that case is only reachable via a foreign modal)
 * @returns {{ deleteIntent: boolean, echoNote: string|null }}
 */
function parseDeleteChoice(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  const norm = value.toLowerCase();
  if (DELETE_WORDS.has(norm)) return { deleteIntent: true, echoNote: null };
  // "" (theoretical — required field), "no" and "n": keep, no echo.
  if (value === "" || KEEP_WORDS.has(norm)) {
    return { deleteIntent: false, echoNote: null };
  }
  return {
    deleteIntent: false,
    echoNote: `input '${value}' not understood — message kept`,
  };
}

/**
 * Plain-text jump link for the failure note / delete correction lines. The
 * evidence builder runs its own stricter id-shape gate for embed markup;
 * these lines are plain content, and a null link degrades to
 * NO_JUMP (never a dead or injected URL).
 *
 * @param {object} snapshot pendingReports snapshot
 * @param {string|null} [fallbackGuildId]
 * @returns {string|null}
 */
function reportJumpUrl(snapshot, fallbackGuildId) {
  try {
    return buildMessageJumpUrl({
      guildId: snapshot?.guildId ?? fallbackGuildId,
      channelId: snapshot?.channelId,
      messageId: snapshot?.messageId,
    });
  } catch {
    return null;
  }
}

/**
 * The ONE wording for "evidence did not land" — posted into the ticket as a
 * best-effort note AND pushed into the ephemeral problems (same sentence in
 * both places so staff cannot get two different stories). Carries the
 * specific cause (error rule 3) and the locked skip-delete statement
 * (decision 4: the original stands).
 *
 * @param {unknown} cause
 * @param {string|null} jumpLink
 * @returns {string}
 */
function evidenceFailureLine(cause, jumpLink) {
  const reason = sliceSafe(String(cause ?? "unknown failure"), CAUSE_CAP);
  return (
    `Could not post the evidence (${reason}) — the original message was NOT deleted: ` +
    `${jumpLink || NO_JUMP}`
  );
}

/**
 * Best-effort staff note into the ticket channel (evidence-failure note,
 * delete correction). A note that itself fails is logged (error rule 2) and
 * dropped — the caller's ephemeral reply already carries the same cause, so
 * the note is belt-and-braces context IN the ticket, never a second failure
 * to escalate.
 *
 * @param {object} channel ticket channel
 * @param {string} text
 * @param {string} ids log id string
 * @param {string} label which note ("evidence-failure" | "delete-correction")
 * @returns {Promise<boolean>} whether the note landed
 */
async function postReportMessageNote(channel, text, ids, label) {
  try {
    await channel.send({
      content: text,
      allowedMentions: { repliedUser: false },
    });
    return true;
  } catch (err) {
    console.error(
      `[tickets] report message ${label} note failed (${ids}):`,
      err?.message || err,
    );
    return false;
  }
}

/**
 * Post the built evidence message (embeds + re-uploaded file bytes) into
 * the ticket. Failure = { ok:false, error } with the specific cause and a
 * log (rules 2/3/6) — the CALLER owns the decision that follows: skip the
 * delete entirely (decision 4, the safety gate).
 *
 * @param {object} channel ticket channel
 * @param {{ embeds: object[], files: {attachment: Buffer, name: string}[] }} built
 * @param {string} ids log id string
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function postReportEvidence(channel, built, ids) {
  try {
    await channel.send({ embeds: built.embeds, files: built.files });
    return { ok: true };
  } catch (err) {
    console.error(
      `[tickets] report message evidence post failed (${ids}):`,
      err?.message || err,
    );
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Delete the ORIGINAL reported message — reached ONLY when the reporter
 * chose yes AND the evidence posted (decision 4). The message is not on
 * this interaction (modal submit carries nothing), so it is resolved by
 * id: guild channel cache first, then REST, then messages.fetch — an
 * already-deleted or unreachable message fails SPECIFICALLY (DiscordAPIError
 * 10008 / channel resolution) instead of silently "succeeding" (rule 3).
 *
 * discord.js 14.27's `Message#delete()` / `MessageManager#delete()` carry no
 * audit-reason parameter (verified in node_modules), so the actor record
 * lives where decision 13 put it anyway: the evidence embed's disposition
 * line and the recordSlashAudit entry — the Discord audit log shows only
 * "bot" either way.
 *
 * @param {object} guild interaction guild (cache + fetch surface)
 * @param {object} snapshot pendingReports snapshot (channelId + messageId)
 * @param {string} ids log id string
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>} never rejects
 */
async function deleteReportedMessage(guild, snapshot, ids) {
  try {
    const channelId = snapshot.channelId;
    if (!channelId) {
      return { ok: false, error: "the source channel id was not captured" };
    }
    const channel =
      (guild?.channels?.cache?.get?.(channelId) ?? null) ??
      (await guild?.channels?.fetch?.(channelId)) ??
      null;
    if (!channel) {
      return {
        ok: false,
        error: `source channel <#${channelId}> could not be resolved`,
      };
    }
    const message = await channel.messages.fetch(snapshot.messageId);
    if (!message) {
      // Defensive: real discord.js REJECTS an unknown id; a resolve-to-null
      // surface must not read as a successful delete either.
      return { ok: false, error: "the message could not be fetched" };
    }
    await message.delete();
    return { ok: true };
  } catch (err) {
    const cause = err?.message || String(err);
    // Rule 2: ids + cause. The caller turns this into the ticket correction
    // + reply warning (rules 3 + 5) — the ticket stands, the message stands.
    console.error(`[tickets] report message delete failed (${ids}):`, cause);
    return { ok: false, error: cause };
  }
}

/**
 * "Report Post" modal submit (`tk:rep:m:<token>`) — message variant.
 *
 * EXACT order (the order IS the safety design, locked decision 4):
 * staff re-check FIRST (submitter authoritative, denial = zero side
 * effects) → one-shot token consumption (expired/unknown/wrong-kind →
 * REPORT_EXPIRED_REPLY, stop) → decision-2 delete parse (recognition-only;
 * never destroys on a misread) → community resolve + duplicate nudge read
 * BEFORE creating (decision 12 — a failed nudge read only loses the note) →
 * ephemeral defer → openReportTicket (shared decision-5 core) → build +
 * POST the evidence message → ONLY THEN delete() the original, and only on
 * a yes AND a posted evidence → insertTicketReport (message_deleted = the
 * ACTUAL outcome) → audit → ephemeral confirmation with every anomaly
 * riding along.
 *
 * The documented tension, resolved on purpose: the evidence embed is
 * built with the FINAL disposition (`deleted: true` when the reporter
 * chose yes) BEFORE the delete runs — evidence-before-delete is locked, so
 * the embed can momentarily claim a deletion that then fails. The
 * `⚠ Delete failed: … original message KEPT: <jump>` correction posted
 * INTO the ticket (and the matching reply warning) closes that honesty gap
 * (rules 3 + 5); reversing the order to avoid it would risk destroying the
 * only copy of the evidence, which is the worse failure.
 *
 * Evidence build OR post failure → the delete is SKIPPED ENTIRELY (locked):
 * ticket stands, an explanatory note lands in the ticket when it can, the
 * reply carries the specific cause, the side record still writes with
 * message_deleted 0, and the audit still records (the mutation that DID
 * happen: an opened ticket).
 *
 * @param {import("discord.js").ModalSubmitInteraction} interaction
 * @param {object} [ctx] router context
 * @param {object} [opts] TEST/deps seam — the router only ever passes
 *   (interaction, ctx). `opts.deps` overrides createReportTicketDeps;
 *   `opts.fetchImpl` / `opts.resolveHost` pass through to the evidence
 *   builder's SSRF-guard seams (integration tests, subtask 09).
 */
async function handleReportMessageModal(interaction, ctx, opts = {}) {
  const deps = createReportTicketDeps(opts?.deps || {});
  try {
    // 1. Staff gate on the SUBMITTER (same gate as the invoke — the picker
    //    tier is cosmetic; this handler remains the security source of truth).
    if (!(await requireStaff(interaction))) return;

    if (!interaction.guild) {
      await replyEphemeral(interaction, "Tickets can only be opened in a server.");
      return;
    }
    if (interaction.user?.bot) {
      await replyEphemeral(interaction, "Bots cannot open tickets.");
      return;
    }

    // 2. One-shot token (decision 3). A kind mismatch means this prefix was
    //    fed something else — same honest outcome as a spent token.
    const token = String(interaction.customId ?? "")
      .slice(MODAL_REPORT_MESSAGE_PREFIX.length)
      .trim();
    const snapshot = takeReport(token);
    if (!snapshot || snapshot.kind !== REPORT_KINDS.MESSAGE) {
      await replyEphemeral(interaction, REPORT_EXPIRED_REPLY);
      return;
    }

    // 3. Delete choice, decision 2 verbatim: recognition-only, echo on garbage.
    const { deleteIntent, echoNote } = parseDeleteChoice(
      readModalText(interaction, MODAL_REPORT_FIELD_DELETE),
    );

    const ids = submitIds(interaction, "report_message");
    const reporterId = interaction.user?.id ?? snapshot.reporterUserId ?? null;
    const subjectId = snapshot.subjectUserId ?? snapshot.authorId ?? null;
    const jumpLink = reportJumpUrl(snapshot, interaction.guildId);

    // 4. Duplicate nudge BEFORE creating (decision 12). The community key
    //    resolves at this Discord edge (openReportTicket's own resolution —
    //    a pre-resolved id simply wins); a throw from either read must not
    //    kill the report, it only loses the note.
    let communityId = null;
    let dup = null;
    try {
      communityId = deps.ensureCommunity({
        platform: "discord",
        instanceKey: "discord",
        externalGuildId: String(interaction.guildId),
      });
      dup = deps.findOpenReportForMessage(communityId, snapshot.messageId);
    } catch (err) {
      console.error(
        `[tickets] report message duplicate check failed (${ids}):`,
        err?.message || err,
      );
      dup = null;
    }

    // 5. Everything past this point does REST + DB work.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // 6. The shared ticket open (decision 5): staff-self, no DM, no rate
    //    limit, is_sensitive 0. A create failure replies with its translated
    //    cause (logged once inside) and stops — nothing was destroyed.
    const contextText = readModalText(interaction, MODAL_REPORT_FIELD_CONTEXT);
    const opened = await openReportTicket({
      interaction,
      ctx,
      snapshot,
      contextText,
      communityId,
      deps,
    });
    if (!opened.ok) {
      await interaction.editReply({ content: opened.error });
      return;
    }
    const { ticket, channel, skippedStaffRoles } = opened;

    const problems = [];
    let messageDeleted = 0;
    let stopBeforeDelete = false;

    // 7. EVIDENCE FIRST (decision 4 — the safety gate): the delete below
    //    only runs when BOTH the build and the post landed.
    const evidenceOpts = {
      reporterUserId: reporterId,
      contextText,
      deleted: deleteIntent,
    };
    if (typeof opts.fetchImpl === "function") evidenceOpts.fetchImpl = opts.fetchImpl;
    if (typeof opts.resolveHost === "function") {
      evidenceOpts.resolveHost = opts.resolveHost;
    }
    const built = await deps.buildEvidenceMessage(snapshot, evidenceOpts);

    let cause = null;
    if (!built?.ok) {
      cause = built?.error || "the evidence builder returned no result";
      console.error(
        `[tickets] report message evidence build failed (${ids} ticket=${ticket.id}):`,
        cause,
      );
    } else {
      const posted = await postReportEvidence(channel, built, ids);
      if (!posted.ok) cause = posted.error;
      else if (built.warnings?.length) {
        // Rule 5: partial evidence is a partial result — one pointer line;
        // the per-file specifics ship INSIDE the evidence message itself.
        problems.push(
          `${built.warnings.length} evidence file warning(s) — recorded in the evidence message.`,
        );
      }
    }
    if (cause != null) {
      stopBeforeDelete = true;
      const line = evidenceFailureLine(cause, jumpLink);
      problems.push(line);
      await postReportMessageNote(channel, line, ids, "evidence-failure");
    }

    // 8. DELETE — only now, only on an explicit yes AND posted evidence.
    if (deleteIntent && !stopBeforeDelete) {
      const deleted = await deleteReportedMessage(interaction.guild, snapshot, ids);
      if (deleted.ok) {
        messageDeleted = 1;
      } else {
        // The posted embed already claims the deletion (built with the
        // final disposition BEFORE this call) — correct the record IN the
        // ticket and the reply (rules 3 + 5). The message stays; nothing is
        // retried behind the reporter's back.
        const line =
          `⚠ Delete failed: ${sliceSafe(deleted.error, CAUSE_CAP)} — original message KEPT: ` +
          `${jumpLink || NO_JUMP}`;
        problems.push(line);
        await postReportMessageNote(channel, line, ids, "delete-correction");
      }
    }

    // 9. Side record (decision 13). snapshot_note carries the parse echo
    //    and/or the failure summary when present — the row is the audit-
    //    adjacent record of what actually happened.
    const recordNote =
      [echoNote, ...problems].filter(Boolean).join(" · ") || null;
    const inserted = deps.insertTicketReport({
      ticketId: ticket.id,
      kind: "message",
      subjectUserId: subjectId,
      reportedMessageId: snapshot.messageId ?? null,
      sourceChannelId: snapshot.channelId ?? null,
      messageDeleted,
      snapshotNote: recordNote,
    });
    if (!inserted?.ok) {
      // Rule 5: the ticket (and possibly the deletion) DID happen — never
      // pretend the whole flow failed, never hide the gap either.
      console.error(
        `[tickets] report message record failed (${ids} ticket=${ticket.id}):`,
        inserted?.error || "unknown database failure",
      );
      problems.push(
        `Could not save the report record: ${inserted?.error || "unknown database failure"} — the ticket itself is intact.`,
      );
    }

    // 10. Audit trail (decision 13). recordSlashAudit is fail-safe by
    //     contract; the flow DID mutate (ticket + maybe a delete), so it
    //     gets audited even when a later step reported a problem.
    deps.recordSlashAudit({
      interaction,
      communityId: opened.communityId,
      action: "tickets.report_message",
      targetType: "ticket",
      targetId: String(ticket.id),
      details: {
        ticket_number: ticket.ticket_number,
        subject_user_id: subjectId,
        reported_message_id: snapshot.messageId ?? null,
        message_deleted: messageDeleted,
        channel_id: channel?.id ?? null,
      },
    });

    // 11. Ephemeral confirmation — ticket ref + channel, staff-role note,
    //     the duplicate nudge (decision 12), the decision-2 echo, and every
    //     partial-failure line (rule 5: never claim total success).
    let msg = `Ticket **${formatTicketRef(ticket.ticket_number)}** opened: <#${channel.id}>`;
    if (skippedStaffRoles?.length) {
      msg += formatStaffRoleAccessNote(skippedStaffRoles);
    }
    if (dup) {
      msg +=
        `\n\n⚠ Already reported on this message: ` +
        `**${formatTicketRef(dup.ticket_number)}** <#${dup.ticket_channel_id}>`;
    }
    if (echoNote) msg += `\n\n_${echoNote}_`;
    if (problems.length) {
      msg += `\n\n${problems.map((p) => `_${p}_`).join("\n")}`;
    }
    await interaction.editReply({ content: msg });
  } catch (err) {
    console.error(
      "[tickets] report message submit failed:",
      submitIds(interaction, "report_message"),
      err?.message || err,
    );
    await safeErrorReply(interaction);
  }
}

module.exports = {
  handleReportMessage,
  handleReportUser,
  handleReportUserModal,
  handleReportMessageModal,
  openReportTicket,
  buildReportUserCard,
  createReportTicketDeps,
};
