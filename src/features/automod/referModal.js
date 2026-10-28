/**
 * Referral MODAL — the moderation-queue intake form (#771, epic #723).
 *
 * Both intake surfaces (`/automod refer` and the "Refer to automod" message
 * context menu) open ONE modal BEFORE the case exists (issue §1, replacing
 * the shipped optional `note:` slash option — design-record §13.1):
 *
 *   Problem            paragraph  REQUIRED  → the harness's `referral.note`,
 *                                            card "**Reported problem:**"
 *   Required context   paragraph  optional  → verbatim harness input, card
 *                                            "**Required context:**"
 *   Messages before    short      optional  → per-case read window (default
 *                                            100, cap 500 — clamped + said)
 *   Messages after     short      optional  → per-case read window (default
 *                                            20, cap 500)
 *
 * The submit creates the case (whole #726 refusal battery runs there, each
 * gate its own specific cause), acks EPHEMERALLY with the case id + where
 * the card posts (the ack copy is single-sourced in refer.js — it never
 * claims a card already posted), fires the harness detached, and audits
 * exactly like the shipped slash arm (`automod.refer`).
 *
 * Never silently proceed on a misread (contract, verbatim shape):
 *  - a non-integer window field refuses naming the EXACT field —
 *    "`Messages before` wasn't a number — nothing was filed.";
 *  - over 500 CLAMPS to 500 and the reply SAYS SO.
 *
 * Pending forms live in an in-memory TTL store (the token rides inside the
 * modal customId, #745's report-modal idiom). A restart loses open forms —
 * the submit then answers the honest "**Modal expired:**" refusal, never a
 * half-read intake (the durable evidence #749 needed a table for; a minutes-
 * long intake FORM is not that).
 *
 * Fluxer: explicit no-parity (epic decision 8). The dispatcher has no modal
 * path at all; the shape belt refuses with the shipped NOT_ON_FLUXER
 * sentence anyway (defense in depth, same posture as the card arms).
 */

const crypto = require("crypto");
const {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { requireStaff } = require("../../core/permissions");
const { replyEphemeral, safeErrorReply } = require("../../core/interaction");
const { sliceSafe } = require("../../core/text");
const {
  MODAL_REFER_PREFIX,
  MODAL_FIELD_PROBLEM,
  MODAL_FIELD_REQUIRED_CONTEXT,
  MODAL_FIELD_READ_BEFORE,
  MODAL_FIELD_READ_AFTER,
  MODAL_LABEL_PROBLEM,
  MODAL_LABEL_REQUIRED_CONTEXT,
  MODAL_LABEL_READ_BEFORE,
  MODAL_LABEL_READ_AFTER,
  AUTOMOD_REFER_NOTE_MAX_LEN,
  AUTOMOD_REFER_CONTEXT_MAX_LEN,
  AUTOMOD_REFER_DEFAULT_READ_BEFORE,
  AUTOMOD_REFER_DEFAULT_READ_AFTER,
  AUTOMOD_REFER_READ_MIN,
  AUTOMOD_REFER_READ_MAX,
  AUTOMOD_REFER_PENDING_TTL_MS,
  AUTOMOD_REFER_PENDING_MAX,
  NOT_ON_FLUXER,
  refusalModalExpired,
  refusalNotNumber,
  clampNote,
} = require("./constants");

/* ── pending-form store ───────────────────────────────────────────────────── */

/**
 * token → { entry, expiresAt }. In-memory on purpose (module header); the
 * entry carries everything the submit needs so the case write needs NO
 * state from the embed and NO second Discord round-trip at open time.
 * @type {Map<string, { entry: object, expiresAt: number }>}
 */
const pendingReferrals = new Map();

/** Injectable clock seam (tests drive TTL without timers). */
let clock = () => Date.now();

/** Test seam: override the clock (restore with `null`). */
function setPendingClock(fn) {
  clock = typeof fn === "function" ? fn : () => Date.now();
}

/** Drop expired forms; cap the store size (oldest-first). Never throws. */
function prunePendingReferrals() {
  const t = clock();
  for (const [token, rec] of pendingReferrals) {
    if (rec.expiresAt <= t) pendingReferrals.delete(token);
  }
  while (pendingReferrals.size >= AUTOMOD_REFER_PENDING_MAX) {
    // Map preserves insertion order — the oldest form goes first.
    const oldest = pendingReferrals.keys().next();
    if (oldest.done) break;
    pendingReferrals.delete(oldest.value);
  }
}

/**
 * File an open form and return its token (rides inside the modal customId).
 *
 * @param {object} entry
 * @param {number} entry.communityId
 * @param {string|null} entry.guildId
 * @param {string|null} entry.referrerUserId
 * @param {string|null} [entry.messageLink] slash `message:` link text
 * @param {{messageId: string|null, channelId: string|null}|null} [entry.resolvedMessage]
 *   context-menu target (already resolved by Discord)
 * @param {string|null} [entry.targetUserId] slash `user:` option
 * @returns {string} 32-hex token
 */
function putPendingReferral(entry) {
  prunePendingReferrals();
  const token = crypto.randomBytes(16).toString("hex");
  pendingReferrals.set(token, { entry, expiresAt: clock() + AUTOMOD_REFER_PENDING_TTL_MS });
  return token;
}

/**
 * One-shot pop: a submit consumes its token (double submits and replays
 * read "expired", never file twice).
 * @param {string} token
 * @returns {object|null} the entry when live
 */
function takePendingReferral(token) {
  const key = String(token ?? "");
  const rec = pendingReferrals.get(key);
  if (!rec) return null;
  pendingReferrals.delete(key);
  if (rec.expiresAt <= clock()) return null;
  return rec.entry;
}

/** Test seams: store size + full clear. */
function pendingReferralCount() {
  return pendingReferrals.size;
}

function clearPendingReferrals() {
  pendingReferrals.clear();
}

/* ── the modal builder ────────────────────────────────────────────────────── */

/**
 * The queue intake form. Discord modals are text-input-only (#745 law), so
 * the two window fields are SHORT text inputs parsed on submit — never
 * Integer options, never silent defaults on a misread.
 *
 * @param {string} token pending-form token (rides in the customId)
 * @returns {ModalBuilder}
 */
function buildReferModal(token) {
  // Labels sit inside Discord's hard 45-char TextInput label cap — the
  // explanatory text rides the placeholders.
  const problem = new TextInputBuilder()
    .setCustomId(MODAL_FIELD_PROBLEM)
    .setLabel(`${MODAL_LABEL_PROBLEM} — what is wrong?`)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(AUTOMOD_REFER_NOTE_MAX_LEN)
    .setPlaceholder("What is wrong with the reported message");
  const context = new TextInputBuilder()
    .setCustomId(MODAL_FIELD_REQUIRED_CONTEXT)
    .setLabel(`${MODAL_LABEL_REQUIRED_CONTEXT} (optional)`)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(AUTOMOD_REFER_CONTEXT_MAX_LEN)
    .setPlaceholder("What the reviewer needs to see — e.g. the thread that started this");
  const before = new TextInputBuilder()
    .setCustomId(MODAL_FIELD_READ_BEFORE)
    .setLabel(`${MODAL_LABEL_READ_BEFORE} (optional)`)
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(6)
    .setPlaceholder(`older messages to read — default ${AUTOMOD_REFER_DEFAULT_READ_BEFORE}, max ${AUTOMOD_REFER_READ_MAX}`);
  const after = new TextInputBuilder()
    .setCustomId(MODAL_FIELD_READ_AFTER)
    .setLabel(`${MODAL_LABEL_READ_AFTER} (optional)`)
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(6)
    .setPlaceholder(`newer messages to read — default ${AUTOMOD_REFER_DEFAULT_READ_AFTER}, max ${AUTOMOD_REFER_READ_MAX}`);

  return new ModalBuilder()
    .setCustomId(`${MODAL_REFER_PREFIX}${token}`)
    .setTitle("Refer to automod")
    .addComponents(
      new ActionRowBuilder().addComponents(problem),
      new ActionRowBuilder().addComponents(context),
      new ActionRowBuilder().addComponents(before),
      new ActionRowBuilder().addComponents(after),
    );
}

/* ── submit parsing ───────────────────────────────────────────────────────── */

/** Tolerant text-input reader (#745 report idiom): missing/odd → "". */
function readModalText(interaction, fieldId) {
  try {
    return String(interaction?.fields?.getTextInputValue?.(fieldId) ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * Parse one window field (contract §1/§2):
 *  - empty → null (the DEFAULT applies; caller fills + shows it nowhere —
 *    a default is not a clamp);
 *  - non-integer → refuse naming the EXACT field, nothing filed;
 *  - over the max → clamp and REPORT the clamp (reply line);
 *  - below the min → clamp to the min and report the same way.
 *
 * @param {string} raw
 * @param {string} label human field label (goes into the refusal)
 * @returns {{ ok: true, value: number|null, clamped: null|"min"|"max" }
 *          | { ok: false, error: string }}
 */
function parseWindowField(raw, label) {
  const text = String(raw ?? "").trim();
  if (text === "") return { ok: true, value: null, clamped: null };
  if (!/^-?\d{1,6}$/.test(text)) return { ok: false, error: refusalNotNumber(label) };
  let n = parseInt(text, 10);
  let clamped = null;
  if (n > AUTOMOD_REFER_READ_MAX) {
    n = AUTOMOD_REFER_READ_MAX;
    clamped = "max";
  } else if (n < AUTOMOD_REFER_READ_MIN) {
    n = AUTOMOD_REFER_READ_MIN;
    clamped = "min";
  }
  return { ok: true, value: n, clamped };
}

/* ── the submit handler (router: prefix `am:refer:`) ─────────────────────── */

/**
 * `am:refer:<token>` — shape belt → staff gate → one-shot token pop →
 * parse (exact-field refuses) → the full #726 service (whole refusal
 * battery, case write) → `automod.refer` audit → EPHEMERAL ack (+ clamp
 * notes) → the detached harness fire. Every failure names its cause; the
 * service never claimed a card posted and neither does this reply.
 *
 * @param {import("discord.js").ModalSubmitInteraction} interaction
 * @param {object} [ctx]
 */
async function handleReferModal(interaction, ctx) {
  void ctx;
  try {
    // Shape belt (defense in depth): modal components are Discord-only;
    // the Fluxer dispatcher has no modal path at all.
    if (
      typeof interaction?.isModalSubmit !== "function" ||
      !interaction.isModalSubmit?.() ||
      typeof interaction?.customId !== "string"
    ) {
      await replyEphemeral(interaction, {
        content: NOT_ON_FLUXER,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (!(await requireStaff(interaction))) return;

    const token = interaction.customId.slice(MODAL_REFER_PREFIX.length);
    const entry = takePendingReferral(token);
    if (!entry) {
      await replyEphemeral(interaction, {
        content: refusalModalExpired(),
        allowedMentions: { parse: [] },
      });
      return;
    }

    const problem = readModalText(interaction, MODAL_FIELD_PROBLEM);
    if (!problem) {
      // Discord enforces required inputs; this belt keeps a malformed
      // payload naming the field instead of filing an empty problem.
      await replyEphemeral(interaction, {
        content: `**${MODAL_LABEL_PROBLEM}:** is required — nothing was filed.`,
        allowedMentions: { parse: [] },
      });
      return;
    }
    const requiredContext = readModalText(interaction, MODAL_FIELD_REQUIRED_CONTEXT);

    const parsedBefore = parseWindowField(
      readModalText(interaction, MODAL_FIELD_READ_BEFORE),
      MODAL_LABEL_READ_BEFORE,
    );
    if (!parsedBefore.ok) {
      await replyEphemeral(interaction, {
        content: parsedBefore.error,
        allowedMentions: { parse: [] },
      });
      return;
    }
    const parsedAfter = parseWindowField(
      readModalText(interaction, MODAL_FIELD_READ_AFTER),
      MODAL_LABEL_READ_AFTER,
    );
    if (!parsedAfter.ok) {
      await replyEphemeral(interaction, {
        content: parsedAfter.error,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const readBefore =
      parsedBefore.value ?? AUTOMOD_REFER_DEFAULT_READ_BEFORE;
    const readAfter =
      parsedAfter.value ?? AUTOMOD_REFER_DEFAULT_READ_AFTER;
    const clampLines = [];
    if (parsedBefore.clamped) {
      clampLines.push(clampNote(MODAL_LABEL_READ_BEFORE, AUTOMOD_REFER_READ_MAX));
    }
    if (parsedAfter.clamped) {
      clampLines.push(clampNote(MODAL_LABEL_READ_AFTER, AUTOMOD_REFER_READ_MAX));
    }

    // Lazy direction of the refer ↔ referModal cycle.
    const refer = require("./refer");
    const result = await refer.referToAutomod({
      communityId: entry.communityId,
      guildId: entry.guildId,
      referrerUserId: entry.referrerUserId,
      messageLink: entry.messageLink ?? null,
      message: entry.resolvedMessage ?? null,
      targetUserId: entry.targetUserId ?? null,
      note: problem,
      requiredContext,
      readBefore,
      readAfter,
      deps: refer.makeDiscordDeps(interaction),
    });
    if (!result.ok) {
      await replyEphemeral(interaction, {
        content: result.error,
        allowedMentions: { parse: [] },
      });
      return;
    }

    refer.auditRefer(entry.communityId, interaction.user?.id ?? entry.referrerUserId, result);
    await replyEphemeral(interaction, {
      content: sliceSafe([result.ack, ...clampLines].filter(Boolean).join("\n"), 3900),
      allowedMentions: { parse: [] },
    });

    // #728 law: trigger AFTER the ack reply resolves — detached, own catch.
    refer.scheduleAutomodRun({
      communityId: entry.communityId,
      guildId: entry.guildId ?? null,
      caseRow: result.case,
      referrerUserId: entry.referrerUserId ?? null,
    });
  } catch (err) {
    // Rule 1/6: name the ids; the router's wrap stays the last resort.
    console.error(
      "[automod] refer modal submit failed:",
      `guild=${interaction?.guildId ?? "?"}`,
      `user=${interaction?.user?.id ?? "?"}`,
      `customId=${String(interaction?.customId ?? "?").slice(0, 120)}`,
      err?.message || err,
    );
    await safeErrorReply(interaction);
  }
}

module.exports = {
  buildReferModal,
  handleReferModal,
  putPendingReferral,
  takePendingReferral,
  pendingReferralCount,
  clearPendingReferrals,
  prunePendingReferrals,
  parseWindowField,
  readModalText,
  // test seam (TTL without timers):
  setPendingClock,
};
