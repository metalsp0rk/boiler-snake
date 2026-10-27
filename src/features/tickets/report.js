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
 * subtask 08 adds the message-variant submit beside it, composing its
 * evidence build / disposition / delete / insert fields AROUND the same
 * `openReportTicket` call.
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
const { inlineEscape, fencedBlock } = require("./reportEvidence");
const { recordSlashAudit } = require("../../core/auditTrail");
// Discord edge: (platform, instanceKey, snowflake) → integer community id,
// resolved once per entry point (same pattern as create.js's flows).
const { ensureCommunity } = require("../../platform/community");
const { insertTicketReport, MAX_TICKET_REASON } = require("../../db");
const { Color, formatTicketRef, tsFull } = require("../../core/theme");
const { sliceSafe } = require("../../core/text");
const {
  MODAL_REPORT_USER_PREFIX,
  MODAL_REPORT_FIELD_CONTEXT,
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
// Modal submit — shared ticket open + "Report User" submit (subtask 06).
// The "Report Post" submit joins this section in subtask 08 and composes its
// evidence build / disposition / delete / insert fields AROUND openReportTicket.
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
 * @param {object} [options]
 * @returns {{
 *   openTicketChannel: Function,
 *   ensureCommunity: Function,
 *   insertTicketReport: Function,
 *   recordSlashAudit: Function,
 * }}
 */
function createReportTicketDeps(options = {}) {
  return {
    openTicketChannel: options.openTicketChannel || openTicketChannel,
    ensureCommunity: options.ensureCommunity || ensureCommunity,
    insertTicketReport: options.insertTicketReport || insertTicketReport,
    recordSlashAudit: options.recordSlashAudit || recordSlashAudit,
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

module.exports = {
  handleReportMessage,
  handleReportUser,
  handleReportUserModal,
  openReportTicket,
  buildReportUserCard,
  createReportTicketDeps,
};
