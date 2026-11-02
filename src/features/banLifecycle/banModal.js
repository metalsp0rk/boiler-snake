/**
 * Ban MODAL — the shared Reason/Duration intake form (#772 §1).
 *
 * Both ban surfaces open THIS one modal before a member is banned:
 *  - `/ban` when `reason` and/or `duration` is missing (the slash-provided
 *    duration was already validated in commands.js — an invalid one never
 *    reaches the modal, it rejects inline with the same copy);
 *  - the "Ban member" user context menu ALWAYS (the menu carries no options).
 *
 * Fields (issue §1 table, locked):
 *   Reason    paragraph  REQUIRED  → the ban record + the Discord ban reason
 *   Duration  short      optional  → `permanent`/empty → no expiry; else
 *                                    `<n><s|m|h|d>` via ./duration.js
 *                                    (floor 60 s, cap 365 d)
 *
 * Never act on a misread (#745): an unparseable Duration answers with the
 * parseDuration refusal — it names the exact field ("**Duration:**"), gives
 * the example (`24h or 7d`) and states "Nothing was banned." — and the
 * service is NEVER called: zero outbound, zero DB writes on a reject.
 *
 * Pending forms live in an in-memory TTL store (the one-shot token rides
 * inside the modal customId `bl:ban:<token>`, the referModal/#745 idiom).
 * A restart loses open forms — the submit then answers the honest
 * "**Modal expired:**" refusal, never a half-read ban. A consumed token is
 * deleted (double submits and replays read "expired", never ban twice).
 *
 * Fluxer: explicit no-parity (#772). The Fluxer dispatcher has no modal
 * path at all; the shape belt refuses with the shipped NOT_ON_FLUXER
 * sentence anyway (defense in depth, referModal posture).
 *
 * Module direction: commands.js requires THIS module at load time; the
 * shared ban core (runTrackedBan/formatBanResult) + NOT_ON_FLUXER live in
 * commands.js and are pulled with a LAZY require inside the submit handler
 * — the sanctioned lazy direction of the cycle (refer ↔ referModal
 * exemplar), so requiring either module standalone never half-loads the
 * other.
 */

const crypto = require("crypto");
const {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require("discord.js");
const { requireAdmin } = require("../../core/permissions");
const { replyEphemeral, safeErrorReply } = require("../../core/interaction");
const { getDiscordOutbound } = require("../../platform/discord/outbound");
const {
  MODAL_BAN_PREFIX,
  MODAL_FIELD_REASON,
  MODAL_FIELD_DURATION,
  MODAL_LABEL_REASON,
  MODAL_LABEL_DURATION,
  BAN_CONTEXT_MENU_NAME,
  DURATION_EXAMPLES,
} = require("./constants");
const { parseDuration } = require("./duration");
// LOG_PREFIX only — banService keeps its db/audit requires call-time, so
// this import opens nothing heavier than the pure layer.
const { LOG_PREFIX } = require("./banService");

/* ── pending-form store (referModal idiom) ────────────────────────────────── */

/** Open-form lifetime. A minutes-long intake FORM is not durable state. */
const BAN_MODAL_TTL_MS = 10 * 60_000;
/** Hard cap on concurrently open forms (oldest-first eviction). */
const BAN_MODAL_PENDING_MAX = 200;

/**
 * token → { entry, expiresAt }. The entry carries everything the submit
 * needs (community, target, slash-time reason/duration intents) so the ban
 * write needs NO state from the modal payload itself.
 * @type {Map<string, { entry: object, expiresAt: number }>}
 */
const pendingBans = new Map();

/** Injectable clock seam (tests drive TTL without timers). */
let clock = () => Date.now();

/** Test seam: override the clock (restore with `null`). */
function setPendingClock(fn) {
  clock = typeof fn === "function" ? fn : () => Date.now();
}

/** Drop expired forms; cap the store size (oldest-first). Never throws. */
function prunePendingBans() {
  const t = clock();
  for (const [token, rec] of pendingBans) {
    if (rec.expiresAt <= t) pendingBans.delete(token);
  }
  while (pendingBans.size >= BAN_MODAL_PENDING_MAX) {
    // Map preserves insertion order — the oldest form goes first.
    const oldest = pendingBans.keys().next();
    if (oldest.done) break;
    pendingBans.delete(oldest.value);
  }
}

/**
 * File an open form and return its token (rides inside the modal customId).
 *
 * @param {object} entry
 * @param {number} entry.communityId integer communities.id (resolved at the
 *   slash/menu edge — the submit never re-resolves)
 * @param {string} entry.guildId Discord guild snowflake
 * @param {string|null} [entry.guildName] display name for the ban DM
 * @param {string} entry.targetUserId member to ban (menu target or `member:`)
 * @param {string|null} [entry.reason] slash-provided reason (belt fallback;
 *   the modal's own required Reason field wins)
 * @param {string|null} [entry.durationRaw] slash-provided duration, already
 *   validated pre-modal; an empty modal Duration field falls back to it
 * @returns {string} 32-hex token
 */
function putPendingBan(entry) {
  prunePendingBans();
  const token = crypto.randomBytes(16).toString("hex");
  pendingBans.set(token, { entry, expiresAt: clock() + BAN_MODAL_TTL_MS });
  return token;
}

/**
 * One-shot pop: a submit consumes its token (double submits and replays
 * read "expired", never ban twice).
 * @param {string} token
 * @returns {object|null} the entry when live
 */
function takePendingBan(token) {
  const key = String(token ?? "");
  const rec = pendingBans.get(key);
  if (!rec) return null;
  pendingBans.delete(key);
  if (rec.expiresAt <= clock()) return null;
  return rec.entry;
}

/** Test seams: store size + full clear. */
function pendingBanCount() {
  return pendingBans.size;
}

function clearPendingBans() {
  pendingBans.clear();
}

/* ── refusal copy ─────────────────────────────────────────────────────────── */

/** Expired-form refusal: names what closed and the re-open path; nothing
 * was banned (#745 tone mirrors the automod refusal helpers). */
function refusalModalExpired() {
  return (
    "**Modal expired:** the ban form closed — nothing was banned. " +
    "Open it again with `/ban` or the **Ban member** menu."
  );
}

/* ── the modal builder ────────────────────────────────────────────────────── */

/**
 * The ban intake form (Reason paragraph REQUIRED + Duration short).
 * Discord modals are text-input-only (#745 law); the Duration bound grammar
 * rides the placeholder and is parsed on submit — never silently defaulted.
 *
 * @param {string} token pending-form token (rides in the customId)
 * @returns {ModalBuilder}
 */
function buildBanModal(token) {
  // Lazy: the Reason cap mirrors the ban record's MAX_BAN_REASON and the db
  // facade opens SQLite at require time (#699 law) — read it at open time,
  // never at module load (banService exemplar).
  const { MAX_BAN_REASON } = require("../../db");
  const reason = new TextInputBuilder()
    .setCustomId(MODAL_FIELD_REASON)
    .setLabel(`${MODAL_LABEL_REASON} — required`)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(MAX_BAN_REASON)
    .setPlaceholder(
      "Why is this ban happening? Goes to the ban record and Discord",
    );
  const duration = new TextInputBuilder()
    .setCustomId(MODAL_FIELD_DURATION)
    .setLabel(`${MODAL_LABEL_DURATION} (blank = permanent)`)
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(32)
    .setPlaceholder(`blank = permanent — or e.g. ${DURATION_EXAMPLES}`);

  return new ModalBuilder()
    .setCustomId(`${MODAL_BAN_PREFIX}${token}`)
    .setTitle(BAN_CONTEXT_MENU_NAME)
    .addComponents(
      new ActionRowBuilder().addComponents(reason),
      new ActionRowBuilder().addComponents(duration),
    );
}

/* ── submit parsing ───────────────────────────────────────────────────────── */

/** Tolerant text-input reader (#745 report idiom): missing/odd → "". */
function readModalText(interaction, fieldId) {
  try {
    return String(
      interaction?.fields?.getTextInputValue?.(fieldId) ?? "",
    ).trim();
  } catch {
    return "";
  }
}

/* ── the submit handler (router: prefix `bl:ban:`) ────────────────────────── */

/**
 * `bl:ban:<token>` — shape belt → admin gate → one-shot token pop → parse
 * (exact-field refuses, ZERO service calls) → defer ephemerally (the ban
 * runs DM + Discord + record — comfortably past 3 s) → the ONE
 * banService.banUser call via commands.runTrackedBan → ephemeral result
 * reply carrying the specific cause on every failure path.
 *
 * @param {import("discord.js").ModalSubmitInteraction} interaction
 * @param {object} [ctx] router feature context (supervisor resolves the client)
 */
async function handleBanModal(interaction, ctx) {
  try {
    // Lazy direction of the commands ↔ banModal cycle (referModal/refer
    // exemplar): commands.js owns the shared ban core + the Fluxer refusal.
    const commands = require("./commands");

    // Shape belt (defense in depth): modal components are Discord-only;
    // the Fluxer dispatcher has no modal path at all.
    if (
      typeof interaction?.isModalSubmit !== "function" ||
      !interaction.isModalSubmit?.() ||
      typeof interaction?.customId !== "string"
    ) {
      await replyEphemeral(interaction, {
        content: commands.NOT_ON_FLUXER,
        allowedMentions: { parse: [] },
      });
      return;
    }
    // Admin gate on the RAW arm (ManageGuild), same source of truth as the
    // slash surface — permissions may have changed between open and submit.
    if (!(await requireAdmin(interaction))) return;

    const token = interaction.customId.slice(MODAL_BAN_PREFIX.length);
    const entry = takePendingBan(token);
    if (!entry) {
      await replyEphemeral(interaction, {
        content: refusalModalExpired(),
        allowedMentions: { parse: [] },
      });
      return;
    }

    const reason =
      readModalText(interaction, MODAL_FIELD_REASON) || entry.reason || "";
    if (!reason) {
      // Discord enforces required inputs; this belt keeps a malformed
      // payload naming the field instead of banning without a reason.
      await replyEphemeral(interaction, {
        content: `**${MODAL_LABEL_REASON}:** is required — nothing was banned.`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    // Modal Duration wins; blank falls back to the slash-provided duration
    // (validated pre-modal, re-parsed here so the expiry anchors at the
    // actual ban); both empty → permanent (parseDuration's "" → no expiry).
    const modalDuration = readModalText(interaction, MODAL_FIELD_DURATION);
    const parsed = parseDuration(
      modalDuration !== "" ? modalDuration : (entry.durationRaw ?? ""),
    );
    if (!parsed.ok) {
      // #745 never-act-on-misread: names "Duration", gives the example,
      // states nothing was banned — and performs ZERO outbound/DB writes.
      await replyEphemeral(interaction, {
        content: parsed.error,
        allowedMentions: { parse: [] },
      });
      return;
    }

    // The ban itself is slow by design (guard reads → DM → ban → record);
    // defer first so the eventual reply never races the 3 s window.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const client = ctx?.supervisor?.discord ?? interaction.client ?? null;
    const result = await commands.runTrackedBan({
      communityId: entry.communityId,
      userId: entry.targetUserId,
      moderatorId:
        interaction.user?.id != null ? String(interaction.user.id) : "",
      reason,
      expiresAtMs: parsed.expiresAtMs,
      outbound: client ? getDiscordOutbound(client) : null,
      guildId: entry.guildId,
      guildName: entry.guildName ?? interaction.guild?.name ?? null,
      client,
    });

    // Success or the service's SPECIFIC cause (duplicate ban, staff-subject
    // guard, hierarchy translation, …) — never a generic sentence.
    await interaction.editReply({
      content: result.ok
        ? commands.formatBanResult(result, entry.targetUserId)
        : result.error,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    // Rule 1/6: name the ids; the router's wrap stays the last resort.
    console.error(
      `${LOG_PREFIX} ban modal submit failed:`,
      `guild=${interaction?.guildId ?? "?"}`,
      `user=${interaction?.user?.id ?? "?"}`,
      `customId=${String(interaction?.customId ?? "?").slice(0, 120)}`,
      err?.message || err,
    );
    await safeErrorReply(interaction);
  }
}

module.exports = {
  buildBanModal,
  handleBanModal,
  putPendingBan,
  takePendingBan,
  pendingBanCount,
  clearPendingBans,
  prunePendingBans,
  readModalText,
  refusalModalExpired,
  // test seam (TTL without timers):
  setPendingClock,
  // tuning constants (pinned by tests / docs):
  BAN_MODAL_TTL_MS,
  BAN_MODAL_PENDING_MAX,
};
