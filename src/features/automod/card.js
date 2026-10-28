/**
 * Auto-moderation CASE CARD (#730, epic #723) — the ONE staff-channel post
 * per case, its Approve/Dismiss buttons, and every outcome they cause.
 *
 * The harness (#728) already guarantees the one-post invariant: it posts a
 * `reviewing` placeholder when the run claims the case and the outcome
 * EDITS that message (fresh post only when the placeholder never landed).
 * This module owns the outcome SHAPE: an embed identifying **A-n**, the
 * referrer, and every subject — per subject the action rows with their
 * CURRENT state (executed result / pending approval / refused with the
 * guard's verbatim cause / dismissed / failed) plus the staff-note ref
 * **N-n** — the "**Seen, not considered:**" bystander line (never with
 * note refs: bystanders have none, locked decision 4), and Approve/Dismiss
 * buttons on every row still in `suggested` (except `no_action` — it is
 * already a recorded decision).
 *
 * THE CARD IS ITS ROWS. Every render (first post AND every button-click
 * rebuild) re-reads `automod_case_actions` via `listAutomodActionsForCase`
 * and regenerates the buttons from the CURRENT states — a stale embed from
 * before a restart drives nothing but its customId row id. The only pieces
 * not row-derived:
 *  - the N-n refs: on the first post they come from the commit result; on a
 *    rebuild the subject's notes are scanned for the `(automod case A-n)`
 *    suffix the harness writes (author = the bot — see `findCaseNoteRow`);
 *  - the not-considered list: window participants are not ledger data, so
 *    the harness persists them as one structured `decision_log` entry
 *    (`_card_participants`) that `readNotConsidered` replays on rebuild.
 *
 * Approve (contract #730 verbatim law): staff gate FIRST (any staff member,
 * not only the referrer), then the row must exist for THIS community, then
 * the pre-gates — master enable, the row's action mode still `suggest`/
 * `auto` (now `off` → specific refusal, zero mutation), and the breaker
 * pause for kick/ban/timeout (names the pause + reason; the trip itself and
 * the auto-path gate are #739 — executor.js marks that insertion point in
 * `runClaimedAction`, this is the card-side twin the #730 contract names).
 * Then the SHARED executor (`approveSuggestion`) re-guards mode/staff/
 * hierarchy and claims the row atomically — a double click loses the claim
 * and returns the EXISTING outcome ("already handled", never an error,
 * never a second mutation). Dismiss: staff gate, `dismissSuggestion`, zero
 * Discord calls ever. Both arms then update the card (rebuild from fresh
 * rows) and record the outcome on the subject's SAME staff note (#731 law:
 * update the note the harness wrote, never write a second one); a missing or
 * foreign note is a warning line on the clicker's reply — the card still
 * updates (AGENTS.md rule 5).
 *
 * Send-failure law (#730): a card that cannot be delivered is NEVER claimed
 * posted — the harness's placeholder-edit path degrades to a fresh post,
 * the terminal failure logs `[automod] … case A-n card post failed`, and
 * `recordCardPostError` appends a structured `_card_post_error` entry to
 * the case's `decision_log` (the run is detached; the referrer-visible
 * surface already carries the judgment copy — this is the honest record
 * that the CARD did not land). Button-click rebuild edits the card in
 * place; a dead card message falls back to a fresh automod-channel post,
 * and its failure follows the same law.
 *
 * Fluxer: explicit no-parity (epic decision 8). Buttons are Discord
 * component interactions; the Fluxer dispatcher has no component path at
 * all (#750's chat-input-only tree filter — `src/platform/fluxer` contains
 * no customId/button routing), so `am:card:*` is structurally unreachable
 * there. The arms still re-check the raw-button shape and answer the
 * shipped NOT_ON_FLUXER sentence (defense in depth, same posture as the
 * `/automod` command arms).
 */

const { ButtonBuilder, ButtonStyle } = require("discord.js");
const { sliceSafe, snippet } = require("../../core/text");
const { replyEphemeral } = require("../../core/interaction");
const { requireStaff } = require("../../core/permissions");
const { discordCommunityId } = require("../../platform/community");
const {
  db: facadeDb,
  getAutomodAction,
  getAutomodCaseById,
  listAutomodActionsForCase,
  parseAutomodActionParams,
  getStaffNote,
  updateStaffNote,
  isAutomodPaused,
  MAX_NOTE_CONTENT,
} = require("../../db");
const {
  NOT_ON_FLUXER,
  CARD_APPROVE_PREFIX,
  CARD_DISMISS_PREFIX,
  AUTOMOD_CARD_MAX_BUTTON_ROWS,
  AUTOMOD_CARD_NOT_CONSIDERED_MAX,
  AUTOMOD_BREAKER_ACTIONS,
  AUTOMOD_NOTE_OUTCOME_HEADER,
  AUTOMOD_NOTE_TRUNCATION_MARKER,
} = require("./constants");
const { readSettings } = require("./settings");
// Shared case-note discovery law + the anchor jump link (#733): card, harness,
// and executor all read the SAME `(automod case A-n)` convention.
const { findCaseNoteRow, anchorJumpLink } = require("./caseNote");
// READ-ONLY import of the shipped warnings feature (#733): the suggested-warn
// card row shows the expiry the warning WILL honour — same accessor /warn add
// uses, so the card can never promise a different date than the record lands.
const { guildWarnExpiryDays } = require("../warnings/helpers");
const { approveSuggestion, dismissSuggestion } = require("./executor");

/** Embed palette — byte-identical to the harness family (placeholder colors
 *  the card EDITS carry over: review yellow / decision green / failure red). */
const COLORS = Object.freeze({
  review: 0xf1c40f,
  complete: 0x57f287,
  failed: 0xed4245,
});

/** Discord embed field cap is 1024 — stay under it (harness parity). */
const EMBED_FIELD_MAX = 1000;

/** Structured decision-log tool tags this module writes (underscore = meta,
 *  never a model tool call; `readNotConsidered` filters on them). */
const CARD_PARTICIPANTS_TOOL = "_card_participants";
const CARD_POST_ERROR_TOOL = "_card_post_error";

/** Approve-path breaker refusal (#730 contract copy; docs/automod.md quotes
 *  it — grep before renaming). */
function refusalPaused(action, reason) {
  return (
    `**Safety paused:** the auto-moderation circuit breaker is tripped — ` +
    `\`${action}\` approvals stay dark until an admin runs ` +
    "`/automodconfig safety resume` (confirm:true). " +
    `**Pause reason:** ${reason ?? "not recorded"}`
  );
}

/** Master-switch approve refusal. */
const REFUSAL_MASTER_OFF =
  "**Automod off:** the master switch is off for this server — a suggestion " +
  "cannot be approved until an admin runs `/automodconfig enable on`.";

/** Mode-now-off approve refusal (#723 decision 2: off is unrunnable). */
function refusalModeOff(action) {
  return (
    `**Mode off:** the \`${action}\` action is now off for this server — ` +
    "approving cannot run it (locked decision 2: off is unrunnable). Set " +
    "its mode with `/automodconfig mode` or Dismiss the suggestion."
  );
}

/** no_action approve/dismiss refusal (contract: already a recorded decision). */
const REFUSAL_NO_ACTION =
  "**No action:** this row records a judgment, not a pending sanction — " +
  "there is nothing to approve or dismiss.";

/**
 * @param {object} caseRow
 * @returns {string}
 */
function caseRefOf(caseRow) {
  return `A-${caseRow?.case_number ?? "?"}`;
}

function idTag({ communityId, guildId, caseId, caseNumber }) {
  return (
    `(community ${communityId ?? "?"} guild ${guildId ?? "?"} case ` +
    `${caseNumber != null ? `A-${caseNumber}` : `#${caseId ?? "?"}`})`
  );
}

/* ── row → line renderers ─────────────────────────────────────────────────── */

/**
 * The state a button row shows the CARD renders. `suggested` renders as
 * **pending approval** (contract word) — except `no_action`, which is
 * already a recorded decision and never gets buttons.
 */
/**
 * What a suggested WARN row shows as expiry (#733): the row's own proposal
 * wins when it carries one (0 = the model proposed no expiry), else the
 * CURRENT guild setting — the same accessor `/warn add` honours, labeled so
 * staff know the setting still governs at Approve time (the warning records
 * its expiry then, not here).
 */
function warnExpiryLabel(row, params) {
  if (params?.expiresDays != null) {
    const d = Math.floor(Number(params.expiresDays));
    return d > 0
      ? `in ${d} day(s) — as proposed on this row`
      : "never — the proposal carries no expiry";
  }
  try {
    const days = guildWarnExpiryDays(Number(row.community_id));
    return days > 0
      ? `in ${days} day(s) — current guild setting`
      : "never — current guild setting";
  } catch {
    return "per the current guild setting (unreadable at render time)";
  }
}

/**
 * @param {object} row the ledger row
 * @param {object} [ctx] render context — currently `{ caseRow }`: the case's
 *   anchor supplies the warn row's evidence link when the row itself carries
 *   none (#733: "the referred message when the warning is about that
 *   message"; rebuilds render identically because the row's params ride).
 */
function renderRowLine(row, ctx = {}) {
  const act = String(row.action ?? "?");
  const detail = (() => {
    switch (row.state) {
      case "suggested": {
        if (act === "no_action") {
          const rationale = snippet(
            // #732 canonical key is `reason`; `rationale` stays readable.
            parseAutomodActionParams(row)?.params?.reason ??
              parseAutomodActionParams(row)?.params?.rationale ??
              "",
            180,
          );
          return (
            "considered, no sanction warranted — already a recorded " +
            `decision${rationale ? ` — "${rationale}"` : ""}`
          );
        }
        if (act === "warn") {
          // #733: a suggested warning is the whole member-facing record —
          // Approve files the formal reason, links the case note, honours
          // the guild's expiry, and DMs the member per the warn settings.
          // The card shows what the member will READ (the reason + the
          // evidence the row carries), never staff-note prose.
          const params = parseAutomodActionParams(row)?.params ?? {};
          const reason = snippet(
            params.reason ?? params.rationale ?? "",
            160,
          );
          const evidence =
            (typeof params.evidenceMessageUrl === "string" &&
              params.evidenceMessageUrl.trim()) ||
            anchorJumpLink(row.guild_id, ctx?.caseRow) ||
            "";
          return (
            "a staff decision is due — Approve records the formal warning " +
            "and DMs the member per the server's warn settings. " +
            (reason ? `Proposed reason: "${reason}". ` : "") +
            (evidence ? `Evidence: <${evidence}>. ` : "Evidence: none recorded. ") +
            `Expiry: ${warnExpiryLabel(row, params)}.`
          );
        }
        return "a staff decision is due — Approve runs the shared executor, Dismiss declines.";
      }
      case "approved":
        return `claimed by ${row.claimed_by ?? "staff"} — the run is in flight; another click returns its outcome, it never re-runs.`;
      case "executed":
        return String(row.result_text ?? "").trim() || "completed.";
      case "refused":
        return String(row.error_text ?? "").trim() || "a guard refused it (no cause recorded on the row).";
      case "failed":
        return String(row.error_text ?? "").trim() || "the mutation failed (no cause recorded on the row).";
      case "dismissed":
        return String(row.result_text ?? "").trim() || "dismissed by staff — the suggested action was not run.";
      default:
        return `unknown row state \`${row.state}\`.`;
    }
  })();
  const label =
    row.state === "suggested"
      ? act === "no_action"
        ? "recorded decision"
        : "pending approval"
      : String(row.state);
  return `  - \`${act}\` — **${label}** — ${detail}`;
}

/**
 * The full "Decision" field body: an honest outcome roll-up when anything
 * refused/failed (rule 5 — never total success when one mutation failed),
 * then ONE section per subject (note ref + its rows), then the run's extra
 * lines (staff-note write failures, the #731 reconciler output).
 *
 * @param {object[]} rows ledger rows, insertion order
 * @param {{ noteRefs?: Record<string, number|string|null>, extraLines?: string[], caseRow?: object|null }} opts
 *   caseRow: the automod_cases row — rows without a recorded evidence link
 *   fall back to its anchor jump link (#733 evidence default).
 */
function renderDecisionBody(rows, { noteRefs = {}, extraLines = [], caseRow = null } = {}) {
  const sections = [];

  const tally = { total: rows.length, executed: 0, suggested: 0, dismissed: 0, refused: 0, failed: 0, approved: 0 };
  for (const r of rows) {
    if (tally[r.state] != null) tally[r.state] += 1;
  }
  if (tally.refused + tally.failed > 0) {
    // Partial-failure honesty (#730 auto-mode law + AGENTS rule 5): the
    // roll-up names the split; each line carries its own specific cause.
    sections.push(
      `**Outcome:** ${tally.executed} of ${tally.total} recorded actions ran — ` +
      `${tally.refused} refused, ${tally.failed} failed, ` +
      `${tally.suggested} pending approval, ${tally.dismissed} dismissed. ` +
      "Every line below names its own cause.",
    );
  }

  /** subject user id → its rows (first-seen row order, stable) */
  const bySubject = new Map();
  for (const r of rows) {
    const subject = String(r.subject_user_id ?? "");
    if (!bySubject.has(subject)) bySubject.set(subject, []);
    bySubject.get(subject).push(r);
  }
  // Note-only entries (a note recorded while every action-row write failed —
  // the user is still part of the case; show them with the note ref).
  for (const subject of Object.keys(noteRefs ?? {})) {
    if (!bySubject.has(subject)) bySubject.set(subject, []);
  }

  for (const [subject, subjectRows] of bySubject) {
    const ref = noteRefs?.[subject];
    const noteRef = ref != null ? `N-${ref}` : "no note recorded for this case";
    const header = `**Subject:** <@${subject || "?"}> · **Staff note:** ${noteRef}`;
    const lines = subjectRows.map((r) => renderRowLine(r, { caseRow }));
    sections.push([header, ...lines].join("\n"));
  }

  const extras = (Array.isArray(extraLines) ? extraLines : []).filter(Boolean);
  const body = [...sections, ...extras].join("\n");
  return body || "_No action calls were recorded this run._";
}

/* ── buttons ──────────────────────────────────────────────────────────────── */

/**
 * Action rows → Approve/Dismiss buttons, clamped honestly.
 * `no_action` rows never get buttons ("already a recorded decision",
 * contract). Overflow rows get the "**More pending rows:**" line — the
 * buttons regenerate on every card update, so approving/dismissing the
 * front of the queue surfaces the tail.
 *
 * @param {object[]} rows
 * @returns {{ components: object[]|null, overflow: number, pendingCount: number }}
 */
function buildCardButtons(rows) {
  const pending = (Array.isArray(rows) ? rows : []).filter(
    (r) => r.state === "suggested" && r.action !== "no_action",
  );
  const clamped = pending.slice(0, AUTOMOD_CARD_MAX_BUTTON_ROWS);
  const overflow = pending.length - clamped.length;

  const buttons = clamped.flatMap((row) => [
    new ButtonBuilder()
      .setCustomId(`${CARD_APPROVE_PREFIX}${row.id}`)
      .setLabel(`Approve ${row.action}`)
      .setStyle(ButtonStyle.Primary)
      .toJSON(),
    new ButtonBuilder()
      .setCustomId(`${CARD_DISMISS_PREFIX}${row.id}`)
      .setLabel(`Dismiss ${row.action}`)
      .setStyle(ButtonStyle.Danger)
      .toJSON(),
  ]);

  // Pack four buttons (two Approve+Dismiss pairs) per ActionRow — five rows
  // × four = the 20-button clamp (AUTOMOD_CARD_MAX_BUTTON_ROWS × 2 ≤ 25).
  const components = [];
  for (let i = 0; i < buttons.length; i += 4) {
    components.push({ type: 1, components: buttons.slice(i, i + 4) });
  }
  return {
    components: components.length ? components : null,
    overflow,
    pendingCount: pending.length,
  };
}

/* ── the payload builders ─────────────────────────────────────────────────── */

/**
 * The card payload — the shape the placeholder is EDITED into.
 *
 * ```text
 * title:       Automod — case A-n — decision | run failed
 * description: harness summary line (the referrer + specific-cause copy)
 *              + optional "**Seen, not considered:** <@id> …" line
 * fields[0]:   { name: "Decision", value: outcome roll-up + per-subject
 *              sections (**Staff note:** N-n + per-row state lines) +
 *              extra lines (note-write failures, reconciler output) }
 * footer:      Model X · N ms · R round(s) · tools: …
 * components:  Approve/Dismiss per suggested row (clamped, + overflow line)
 * ```
 *
 * @param {object} input
 * @param {object} input.caseRow                     the automod_cases row
 * @param {object[]} [input.rows]                    THIS CASE's action rows (fresh from the ledger)
 * @param {object} [input.meta]                      { model, durationMs, rounds, toolNames }
 * @param {string} [input.summaryText]               the harness referrer-visible line (unchanged copy)
 * @param {boolean} [input.failed]                   red + "run failed" title
 * @param {string[]} [input.notConsidered]           participants the judge did NOT consider
 * @param {Record<string, number|string|null>} [input.noteRefs] subject → note_number (null = none)
 * @param {string[]} [input.extraLines]              run-note lines appended to the Decision field
 * @param {string|null} [input.rowReadError]         ledger re-read failed — say so, never fake calm
 * @param {boolean} [input.withButtons]              false for the failure-path post with nothing pending
 * @returns {object} a channel.send / message.edit-able payload
 */
function buildCardPayload({
  caseRow,
  rows = [],
  meta = {},
  summaryText = "",
  failed = false,
  notConsidered = [],
  noteRefs = {},
  extraLines = [],
  rowReadError = null,
  withButtons = true,
} = {}) {
  const lines = [summaryText ?? ""].filter(Boolean);
  const seen = (Array.isArray(notConsidered) ? notConsidered : [])
    .map((id) => String(id ?? "").trim())
    .filter((id) => /^\d{17,20}$/.test(id));
  if (seen.length > 0) {
    const shown = seen.slice(0, AUTOMOD_CARD_NOT_CONSIDERED_MAX).map((id) => `<@${id}>`);
    const extra = seen.length - shown.length;
    lines.push(
      `**Seen, not considered:** ${shown.join(" ")}${extra > 0 ? ` … +${extra} more` : ""}`,
    );
  }

  const bodyExtras = [...(rowReadError
    ? [`- **Action rows:** the ledger could not be re-read (${sliceSafe(String(rowReadError), 200)}) — every row still lives in the database.`]
    : []),
    ...(Array.isArray(extraLines) ? extraLines : [])];
  // The overflow line is reserved BEFORE the body truncates — a full field
  // must never chop the line that explains the missing buttons.
  const { components, overflow } = buildCardButtons(rows);
  const overflowSuffix =
    overflow > 0
      ? `\n**More pending rows:** ${overflow} pending row(s) have no buttons on this card — approve or dismiss the earlier ones and the rebuilt card carries them.`
      : "";
  const decisionValue =
    sliceSafe(
      renderDecisionBody(rows, { noteRefs, extraLines: bodyExtras, caseRow }),
      Math.max(256, EMBED_FIELD_MAX - overflowSuffix.length),
    ) + overflowSuffix;

  // '?' means UNKNOWABLE — a rebuild has no run-time rounds/duration. Note
  // Number(null) is 0, so plain isFinite(Number(v)) would lie '0' here.
  const numOrQ = (v) =>
    v == null || v === "" || !Number.isFinite(Number(v)) ? "?" : Math.floor(Number(v));
  const footerParts = [
    `Model ${meta.model ?? "?"}`,
    `${numOrQ(meta.durationMs)} ms`,
    `${numOrQ(meta.rounds)} round(s)`,
    `tools: ${(meta.toolNames ?? []).join(", ") || "none"}`,
  ];

  const payload = {
    allowedMentions: { parse: [] },
    embeds: [
      {
        title: `Automod — case A-${caseRow?.case_number ?? "?"} — ${failed ? "run failed" : "decision"}`,
        description: sliceSafe(lines.join("\n"), 4000),
        fields: [{ name: "Decision", value: decisionValue }],
        footer: { text: sliceSafe(footerParts.join(" · "), 2048) },
        color: failed ? COLORS.failed : COLORS.complete,
      },
    ],
  };
  if (withButtons && components) payload.components = components;
  return payload;
}

/* ── rebuild-from-rows ────────────────────────────────────────────────────── */

/**
 * Replay the not-considered participants from the case's persisted
 * decision_log (`_card_participants` meta entry written by the harness).
 * Unknown / absent → [] (the line is omitted — bystanders were never
 * claimed to be listed).
 *
 * @param {object} caseRow the automod_cases row
 * @returns {string[]}
 */
function readNotConsidered(caseRow) {
  const entry = readDecisionLog(caseRow).find((e) => e?.tool === CARD_PARTICIPANTS_TOOL);
  const ids = String(entry?.args_summary ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{17,20}$/.test(s));
  return [...new Set(ids)];
}

/** Parse the persisted decision_log JSON (never throws). */
function readDecisionLog(caseRow) {
  if (!caseRow?.decision_log) return [];
  try {
    const parsed = JSON.parse(caseRow.decision_log);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The participants meta entry the harness appends to the decision_log it
 * persists at finish (single structured entry, seq 0 = not a tool call).
 *
 * @param {string[]} ids not-considered participant ids (may be empty)
 */
function participantsLogEntry(ids) {
  return {
    seq: 0,
    tool: CARD_PARTICIPANTS_TOOL,
    args_summary: (Array.isArray(ids) ? ids : []).map(String).join(" "),
    state: "meta",
    result_or_error: "seen-not-considered participants for the case card (#730)",
  };
}

/**
 * Structured record that the CARD did not post (contract: never claim it
 * did). Appends one `_card_post_error` entry to the persisted decision_log.
 * Lifecycle-SQL posture (harness.js header): touches ONLY the `decision_log`
 * column the harness metadata writer owns; the shared connection handle is
 * injected. Never throws — a failed record logs and moves on; the ledger
 * rows remain the operational truth.
 *
 * @param {number} caseId automod_cases row id
 * @param {string} cause the specific failure (staff-shaped)
 * @param {{ db?: object }} [opts]
 */
function recordCardPostError(caseId, cause, { db: dbHandle = facadeDb } = {}) {
  try {
    const id = Number(caseId);
    if (!Number.isInteger(id) || id < 1) return;
    const row = dbHandle.prepare(`SELECT decision_log FROM automod_cases WHERE id=?`).get(id);
    if (!row) return;
    let log = [];
    try {
      const parsed = JSON.parse(row.decision_log ?? "[]");
      if (Array.isArray(parsed)) log = parsed;
    } catch {
      log = [];
    }
    log.push({
      seq: log.length + 1,
      tool: CARD_POST_ERROR_TOOL,
      args_summary: "",
      state: "failed",
      result_or_error: sliceSafe(String(cause ?? "unknown"), 200),
    });
    dbHandle
      .prepare(`UPDATE automod_cases SET decision_log=? WHERE id=?`)
      .run(JSON.stringify(log), id);
  } catch (err) {
    console.error(
      `[automod] card post-error record failed (case #${caseId ?? "?"}):`,
      err?.message || err,
    );
  }
}

/**
 * Fresh rebuild from the ledger — the ONLY way a button arm renders a card
 * (contract: never edit stale embed data; an OLD card after a restart shows
 * the CURRENT states and buttons regenerate only for rows still suggested).
 *
 * @param {object} input
 * @param {number} input.communityId
 * @param {number} input.caseId
 * @param {string|null} [input.botUserId] note-author anchor for the N-n scan
 * @param {object} [input.deps] read seams ({ getCase, listActions, listNotes })
 * @returns {{ ok: true, payload: object, caseRow: object, rows: object[] }
 *          | { ok: false, error: string }}
 */
function buildCardFromCase({ communityId, caseId, botUserId = null, deps = {} } = {}) {
  try {
    const caseRow = (deps.getCase ?? getAutomodCaseById)(caseId);
    if (!caseRow) {
      return { ok: false, error: `No auto-mod case row #${caseId} — there is no card to update.` };
    }
    if (Number(caseRow.community_id) !== Number(communityId)) {
      return {
        ok: false,
        error: `Case ${caseRefOf(caseRow)} belongs to community ${caseRow.community_id}, not ${communityId} — refusing to rebuild a card across communities.`,
      };
    }
    let rows = [];
    let rowReadError = null;
    try {
      rows = (deps.listActions ?? listAutomodActionsForCase)(communityId, caseRow.id) ?? [];
    } catch (err) {
      rowReadError = err?.message || String(err);
    }
    // Considered = has a row (any state). The persisted participants entry
    // is raw window authorship, so the SUBTRACTED bystander set is recomputed
    // here too — a subject gained later must never show as "not considered".
    const rowSubjects = new Set(rows.map((r) => String(r.subject_user_id ?? "")));
    const noteRefs = {};
    for (const subject of [...new Set(rows.map((r) => String(r.subject_user_id ?? "")))]) {
      if (!subject) continue;
      const note = findCaseNoteRow({
        communityId,
        userId: subject,
        caseNumber: caseRow.case_number,
        botUserId,
        deps,
      });
      noteRefs[subject] = note ? note.note_number : null;
    }
    const payload = buildCardPayload({
      caseRow,
      rows,
      meta: {
        model: caseRow.last_model ?? null,
        durationMs: caseRow.last_duration_ms ?? null,
        rounds: null, // round count is run-time data; a rebuild shows "?"
        toolNames: (() => {
          try {
            const parsed = JSON.parse(caseRow.last_tool_names ?? "[]");
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })(),
      },
      summaryText: defaultSummaryFor(caseRow),
      failed: String(caseRow.status ?? "") === "failed",
      notConsidered: readNotConsidered(caseRow).filter((id) => !rowSubjects.has(id)),
      noteRefs,
      rowReadError,
    });
    return { ok: true, payload, caseRow, rows };
  } catch (err) {
    // Belt (rule 6): a read that escaped the inner belts still returns the
    // service shape; the caller surfaces the specific cause.
    return { ok: false, error: `Could not rebuild the case card: ${err?.message || err}` };
  }
}

/**
 * The summary line a REBUILD carries (no live run behind it). It keeps the
 * harness's referrer-visible family: `**Referred by:** <@staff> — <state>`.
 */
function defaultSummaryFor(caseRow) {
  const referrer = caseRow.referrer_user_id ? `<@${caseRow.referrer_user_id}>` : "<@?>";
  switch (String(caseRow.status ?? "")) {
    case "failed":
      return `**Referred by:** ${referrer} — automod run failed: ${caseRow.last_run_error ?? "unknown error"}`;
    case "recorded":
    case "processing":
      return `**Referred by:** ${referrer} — the review run has not finished; this card reflects the rows recorded so far.`;
    default:
      return `**Referred by:** ${referrer} — review complete.`;
  }
}

/* ── staff-note ref + outcome UPDATE (#731 law: same note, updated) ───────── */

/**
 * `findCaseNoteRow` — the `(automod case A-n)` discovery law — moved to
 * `./caseNote.js` in #733 so the harness pre-pass, the executor's note-link
 * resolution, and this module share ONE reader convention (and a foreign
 * author can never receive an outcome). The import above keeps the historic
 * `card.findCaseNoteRow` export alive — the note-ref scan below, the button
 * arms, and the card tests all keep driving it from here.
 */

/**
 * Record a staff decision on the subject's automod note — by UPDATING THE
 * SAME NOTE ROW's body (#731: "same note, updated, not a second note").
 * Body grammar: the run's base body (narrative / harness-filled + the
 * actions block + evidence, ending in the `(automod case A-n)` discovery
 * suffix) plus ONE trailing `**Outcome:**` section whose entry lines are the
 * per-decision `outcomeLineFor` results. Rebuilds MERGE, never stack: a
 * repeated identical line is a no-op, a further decision on the same subject
 * (multi-action case) adds one entry UNDER the single existing header — so a
 * re-click after the terminal state can never duplicate the outcome section.
 *
 * Cap law: the rewrite stays within MAX_NOTE_CONTENT by truncating the BASE
 * body's tail with the explicit #731 marker — the outcome section stays
 * honest and the click NEVER fails for a cap squeeze. edited_at / edited_by
 * land through the real `updateStaffNote(communityId, noteNumber, { content,
 * editedBy })` — the clicking staff id is the editor.
 *
 * @param {object} input
 * @param {number} input.communityId
 * @param {number} input.noteNumber
 * @param {string} input.outcomeLine one `outcomeLineFor` result
 * @param {string} input.editedBy the clicking staff id (edited_by)
 * @param {object} [input.deps] ({ getNote, updateNote })
 * @returns {{ ok: true, noteNumber: number, unchanged?: boolean }
 *          | { ok: false, error: string }}
 */
function updateNoteOutcome({ communityId, noteNumber, outcomeLine, editedBy, deps = {} }) {
  try {
    const existing = (deps.getNote ?? getStaffNote)(communityId, noteNumber);
    if (!existing || existing.deleted_at != null) {
      return { ok: false, error: "the note is gone or was erased — the outcome was not recorded on it" };
    }
    const content = String(existing.content ?? "");
    const marker = `\n\n${AUTOMOD_NOTE_OUTCOME_HEADER}\n`;
    const at = content.lastIndexOf(marker);
    const base = at === -1 ? content : content.slice(0, at);
    const priorEntries =
      at === -1
        ? []
        : content.slice(at + marker.length).split("\n").map((l) => l.trim()).filter(Boolean);
    const line = String(outcomeLine ?? "").trim();
    if (!line) return { ok: false, error: "no outcome line to record" };

    // Idempotence: the identical decision line already sits in the section —
    // the note stays untouched (no edit stamp, no duplicate entry).
    if (priorEntries.includes(line)) {
      return { ok: true, noteNumber: Number(existing.note_number), unchanged: true };
    }

    // Cap the SECTION itself (pathological histories: many 600-char entries):
    // drop the OLDEST entries first — the newest decision always survives —
    // so the rewrite can never exceed the repository cap.
    let entryList = [...priorEntries, line];
    let section = marker + entryList.join("\n");
    const sectionLimit = MAX_NOTE_CONTENT - 64;
    while (section.length > sectionLimit && entryList.length > 1) {
      entryList = entryList.slice(1);
      section = marker + entryList.join("\n");
    }
    if (section.length > sectionLimit) {
      entryList = [
        sliceSafe(entryList[0], Math.max(1, sectionLimit - marker.length - 14)) + "…",
      ];
      section = marker + entryList.join("\n");
    }

    let body = String(base);
    const room = MAX_NOTE_CONTENT - section.length;
    if (body.length > room) {
      body =
        sliceSafe(body, Math.max(1, room - AUTOMOD_NOTE_TRUNCATION_MARKER.length - 1)) +
        AUTOMOD_NOTE_TRUNCATION_MARKER;
    }
    const update = deps.updateNote ?? updateStaffNote;
    let updated = update(communityId, noteNumber, { content: body + section, editedBy });
    if (!updated && body.length > 1) {
      // Belt: the room math already keeps us ≤ MAX_NOTE_CONTENT — a vanished
      // row gets ONE retry with a harder slice rather than failing the click
      // (recording the outcome is the note's point).
      const forced =
        sliceSafe(body, Math.max(1, MAX_NOTE_CONTENT - section.length - 14)) + "…[truncated]";
      updated = update(communityId, noteNumber, { content: forced + section, editedBy });
    }
    if (!updated) {
      return { ok: false, error: "the note vanished mid-update — the outcome was not recorded on it" };
    }
    return { ok: true, noteNumber: updated.note_number };
  } catch (err) {
    return { ok: false, error: `could not record the outcome on the note (${err?.message || err})` };
  }
}

/** The outcome line the note records (docs quote the format). */
function outcomeLineFor({ verb, staffUserId, state, detail }) {
  const who = `<@${staffUserId}>`;
  if (verb === "dismiss") {
    return `Outcome: dismissed by ${who} — the suggested action was not run.`;
  }
  const cause = detail ? sliceSafe(String(detail), 600) : "no cause recorded";
  return `Outcome: approved by ${who} — ${state}: ${cause}`;
}

/* ── button handlers ──────────────────────────────────────────────────────── */

/** Parse `am:card:<verb>:<rowId>` (longest-prefix dispatch lands here). */
function parseCardButtonId(customId, prefix) {
  const id = String(customId ?? "");
  if (!id.startsWith(prefix)) {
    return { ok: false, error: `This case-card button is malformed (customId \`${sliceSafe(id, 80)}\`) — nothing was run.` };
  }
  const tail = id.slice(prefix.length).trim();
  const rowId = Number(tail);
  if (!Number.isInteger(rowId) || rowId < 1) {
    return { ok: false, error: `This case-card button carries an invalid row id (\`${sliceSafe(tail, 40)}\`) — nothing was run.` };
  }
  return { ok: true, rowId };
}

/**
 * Shared arm preamble: the raw-button shape belt (Fluxer has NO component
 * path — this refuses anything that is not a Discord button interaction
 * with the standard Discord-only sentence), the staff gate, the community
 * map, and the row + case cross-community validation. EVERY failure here
 * happens before any mutation (contract + rule 5).
 */
async function cardArmPreamble(interaction, prefix, what) {
  if (typeof interaction?.isButton !== "function" || !interaction.isButton?.() ||
      typeof interaction?.customId !== "string") {
    // Defense in depth (epic decision 8): the Fluxer dispatcher routes chat
    // input only (#750) and src/platform/fluxer has no component/customId
    // path at all, so am:card:* cannot arrive from Fluxer — the shape belt
    // still refuses non-button arms with the shipped Discord-only sentence.
    await replyEphemeral(interaction, { content: NOT_ON_FLUXER, allowedMentions: { parse: [] } });
    return { ok: false, silent: true };
  }
  if (!(await requireStaff(interaction))) {
    // requireStaff owns the denial reply (standard MSG_DENIED). Any staff
    // member may press — the executor's guards, not the referrer, bound
    // what the click can do.
    return { ok: false, silent: true };
  }
  const parsed = parseCardButtonId(interaction.customId, prefix);
  if (!parsed.ok) {
    await replyEphemeral(interaction, { content: parsed.error, allowedMentions: { parse: [] } });
    return { ok: false, silent: true };
  }
  const guildId = interaction.guildId ?? interaction.guild?.id ?? null;
  const communityId = discordCommunityId(guildId);
  if (communityId == null) {
    await replyEphemeral(interaction, {
      content:
        `**Server not registered:** this guild (\`${sliceSafe(String(guildId), 32)}\`) has no community row — ` +
        "the bot cannot map the case it belongs to. Nothing was run.",
      allowedMentions: { parse: [] },
    });
    return { ok: false, silent: true };
  }
  const row = getAutomodAction(parsed.rowId);
  if (!row) {
    await replyEphemeral(interaction, {
      content:
        `No auto-mod action row #${parsed.rowId} — this card is from an older build or the row is gone. Nothing was run.`,
      allowedMentions: { parse: [] },
    });
    return { ok: false, silent: true };
  }
  if (Number(row.community_id) !== communityId) {
    console.error(
      `[automod] card ${what} refused (${idTag({ communityId, guildId, caseId: row.case_id })} row #${row.id}): ` +
      `the row belongs to community ${row.community_id}, not ${communityId}`,
    );
    await replyEphemeral(interaction, {
      content:
        `**Cross-community:** auto-mod row #${row.id} belongs to another community — refusing to ${what} it from this server. Nothing was run.`,
      allowedMentions: { parse: [] },
    });
    return { ok: false, silent: true };
  }
  const caseRow = row.case_id != null ? getAutomodCaseById(row.case_id) : null;
  if (!caseRow || Number(caseRow.community_id) !== communityId) {
    await replyEphemeral(interaction, {
      content:
        `Auto-mod row #${row.id} is not attached to a case of this community — the card cannot be updated. Nothing was run.`,
      allowedMentions: { parse: [] },
    });
    return { ok: false, silent: true };
  }
  return { ok: true, communityId, guildId, row, caseRow };
}

/**
 * Outcome classification for the clicker's ephemeral (contract shape:
 * **Case:** A-n · action · state/result). A deduped re-click ALWAYS reads
 * **already handled** carrying the EXISTING outcome — never an error
 * (double clicks do not double-execute; the single-winner claim did its
 * job) — and never re-writes the staff note (no `terminal` flag).
 */
function classifyOutcome(res, row) {
  if (res?.ok && res.inFlight) {
    return {
      label: "in flight",
      detail:
        "another staff click owns this run — the mutation is not repeated; its outcome lands on the card.",
      terminal: false,
      state: "approved",
    };
  }
  const state = String(res?.state ?? row?.state ?? "failed");
  const outcomeText =
    res?.result ||
    res?.error ||
    row?.result_text ||
    (row?.state === "approved"
      ? `claimed by ${row?.claimed_by ?? "staff"} — the run is in flight`
      : "") ||
    "no outcome text recorded";
  if (res?.deduped === true) {
    return { label: "already handled", detail: outcomeText, terminal: false, state };
  }
  if (res?.ok && state === "executed") {
    return { label: "executed", detail: res.result ?? "completed.", terminal: true, state };
  }
  if (res?.ok && state === "dismissed") {
    return {
      label: "dismissed",
      detail: res.result ?? "the suggested action was not run.",
      terminal: true,
      state,
    };
  }
  if (res?.ok && state === "suggested") {
    return {
      label: "already handled",
      detail: "the row is still a pending suggestion — this click did not claim it.",
      terminal: false,
      state,
    };
  }
  if (state === "refused" || state === "failed") {
    return { label: state, detail: res?.error ?? row?.error_text ?? "no cause recorded", terminal: true, state };
  }
  // Executor-level failure (row vanished, unexpected error) — still specific.
  return {
    label: "failed",
    detail: res?.error ?? "the executor refused without a state (see the log line)",
    terminal: false,
    state: "failed",
  };
}

/**
 * Post-outcome card update: rebuild from FRESH rows and edit the card
 * message in place; a dead/absent card message falls back to a fresh
 * automod-channel post; a dead channel/post follows the send-failure law
 * (log `[automod] … case A-n card post failed` with the ids + a
 * `_card_post_error` entry in the decision_log — the card was NOT posted,
 * and the case row says so). Returns the outcome so the arms can tell the
 * clicker the card did not land (never claim it posted).
 *
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function refreshCaseCard({ interaction, communityId, guildId, caseRow, client = null }) {
  const ids = idTag({ communityId, guildId, caseId: caseRow.id, caseNumber: caseRow.case_number });
  const rebuilt = buildCardFromCase({
    communityId,
    caseId: caseRow.id,
    botUserId: interaction?.client?.user?.id ?? client?.user?.id ?? null,
  });
  if (!rebuilt.ok) {
    console.error(`[automod] case ${caseRefOf(caseRow)} card post failed ${ids}: ${rebuilt.error}`);
    recordCardPostError(caseRow.id, `card rebuild failed: ${rebuilt.error}`);
    return { ok: false, error: rebuilt.error };
  }
  const describe = (err) => String(err?.message ?? err ?? "unknown");
  const message = interaction?.message;
  if (message && typeof message.edit === "function") {
    try {
      await message.edit(rebuilt.payload);
      return { ok: true };
    } catch (err) {
      console.error(
        `[automod] card message uneditable ${ids}, falling back to a fresh post:`,
        describe(err),
      );
      return postFreshCardFallback({ communityId, guildId, caseRow, payload: rebuilt.payload, ids, client });
    }
  }
  return postFreshCardFallback({ communityId, guildId, caseRow, payload: rebuilt.payload, ids, client });
}

async function postFreshCardFallback({ communityId, guildId, caseRow, payload, ids, client = null }) {
  const settings = readSettings(communityId);
  const channelId = settings.ok ? settings.settings.channelId : null;
  if (!channelId) {
    const cause = "the automod channel is unset — the rebuilt card was not posted";
    console.error(`[automod] case ${caseRefOf(caseRow)} card post failed ${ids}: ${cause}`);
    recordCardPostError(caseRow.id, `card post failed: ${cause}`);
    return { ok: false, error: cause };
  }
  try {
    if (!client?.channels?.fetch) {
      throw new Error("no Discord client — the rebuilt card cannot resolve the automod channel");
    }
    const channel = await client.channels.fetch(String(channelId));
    if (!channel?.send) {
      throw new Error(`channel ${channelId} did not resolve to a sendable channel`);
    }
    await channel.send(payload);
    return { ok: true };
  } catch (err) {
    const cause = String(err?.message ?? err);
    console.error(`[automod] case ${caseRefOf(caseRow)} card post failed ${ids}: ${cause}`);
    recordCardPostError(caseRow.id, `card post failed: ${cause}`);
    return { ok: false, error: cause };
  }
}

/* ── the arms ─────────────────────────────────────────────────────────────── */

/**
 * `am:card:approve:<actionRowId>` — staff gate → row/community validation →
 * master-enable + mode + breaker re-checks (specific refusal, ZERO
 * mutation) → the shared executor (mode/guards re-apply there; the atomic
 * claim kills double-clicks) → staff-note outcome update → card rebuild from
 * fresh rows → specific ephemeral to the clicker.
 *
 * @param {import("discord.js").ButtonInteraction} interaction
 * @param {object} [ctx] feature context ({ supervisor } in production; the
 *   client seam is `ctx.supervisor.discord ?? interaction.client`)
 */
async function handleCardApprove(interaction, ctx) {
  try {
    const pre = await cardArmPreamble(interaction, CARD_APPROVE_PREFIX, "approve");
    if (!pre.ok) return;
    const { communityId, guildId, row, caseRow } = pre;
    const staffUserId = String(interaction.user?.id ?? "unknown");
    const caseRef = caseRefOf(caseRow);
    const ids = { communityId, guildId, caseId: caseRow.id, caseNumber: caseRow.case_number };

    const finish = (message, extraLines = []) =>
      replyEphemeral(interaction, {
        content: sliceSafe([message, ...extraLines].filter(Boolean).join("\n"), 3900),
        allowedMentions: { parse: [] },
      });

    // Row already terminal? The double-click / old-card path: show the
    // EXISTING outcome (never an error, never a re-run) and re-render the
    // card from the ledger so the buttons drop off.
    if (row.state !== "suggested") {
      const outcome = classifyOutcome({ deduped: true, state: row.state }, row);
      await finish(
        `**Case:** ${caseRef} · \`${row.action}\` → **${outcome.label}** — state \`${row.state}\` — ${outcome.detail}`,
      );
      await refreshCaseCard({
        interaction,
        communityId,
        guildId,
        caseRow,
        client: ctx?.supervisor?.discord ?? interaction?.client ?? null,
      });
      return;
    }

    // ── pre-gates (contract order; each refuses with its OWN cause, ZERO
    //    mutation — the row stays suggested and re-approvable) ─────────────
    if (row.action === "no_action") {
      await finish(`**Case:** ${caseRef} · \`${row.action}\` → ${REFUSAL_NO_ACTION}`);
      return;
    }
    const settings = readSettings(communityId);
    if (!settings.ok) {
      await finish(`**Case:** ${caseRef} · could not read the automod settings — ${settings.error}`);
      return;
    }
    if (!settings.settings.enabled) {
      await finish(`**Case:** ${caseRef} · ${REFUSAL_MASTER_OFF}`);
      return;
    }
    const mode = settings.settings.modes?.[row.action] ?? "suggest";
    if (mode === "off") {
      console.error(
        `[automod] card approve refused ${idTag({ ...ids, action: row.action, row: row.id })}: the action mode is now off`,
      );
      await finish(`**Case:** ${caseRef} · \`${row.action}\` → ${refusalModeOff(row.action)}`);
      return;
    }
    if (AUTOMOD_BREAKER_ACTIONS.includes(row.action)) {
      const pause = isAutomodPaused(communityId);
      if (pause.paused) {
        // #739 owns the breaker TRIP and the auto-path gate (marked
        // insertion point in executor.js `runClaimedAction`); this is the
        // card-side pre-gate the #730 contract names for kick/ban/timeout.
        console.error(
          `[automod] card approve refused ${idTag({ ...ids, action: row.action, row: row.id })}: breaker paused (${pause.reason ?? "no reason recorded"})`,
        );
        await finish(
          `**Case:** ${caseRef} · \`${row.action}\` → ${refusalPaused(row.action, pause.reason)}`,
        );
        return;
      }
    }

    // ── the shared executor (claims atomically; re-guards mode/staff/
    //    hierarchy at run time — this arm never touches Discord itself) ────
    const res = await approveSuggestion({
      actionRowId: row.id,
      claimant: `staff:${staffUserId}`,
      deps: { client: ctx?.supervisor?.discord ?? interaction?.client ?? null },
      referrerUserId: caseRow.referrer_user_id ?? null,
    });
    const outcome = classifyOutcome(res, getAutomodAction(row.id) ?? row);

    // ── staff-note outcome UPDATE (this click's terminal transition only —
    //    a deduped re-click never writes; #731: the SAME note row, updated) ──
    const noteWarnings = [];
    if (outcome.terminal && res?.deduped !== true) {
      const note = findCaseNoteRow({
        communityId,
        userId: row.subject_user_id,
        caseNumber: caseRow.case_number,
        botUserId: interaction?.client?.user?.id ?? null,
      });
      if (!note) {
        const warn =
          "**Staff note:** no automod note for this subject — the outcome could not be recorded (the card was updated anyway).";
        noteWarnings.push(warn);
        console.error(
          `[automod] card approve note update skipped ${idTag({ ...ids, action: row.action, row: row.id, subject: row.subject_user_id })}: no harness note found for <@${row.subject_user_id}>`,
        );
      } else {
        const recorded = updateNoteOutcome({
          communityId,
          noteNumber: note.note_number,
          outcomeLine: outcomeLineFor({
            verb: "approve",
            staffUserId,
            state: outcome.state,
            detail: outcome.detail,
          }),
          editedBy: staffUserId,
        });
        if (!recorded.ok) {
          noteWarnings.push(`**Staff note N-${note.note_number}:** ${recorded.error} (the card was updated anyway).`);
          console.error(
            `[automod] card approve note update failed ${idTag({ ...ids, action: row.action, row: row.id, subject: row.subject_user_id })}: ${recorded.error}`,
          );
        }
      }
    }

    // ── the card update (fresh rows — never the stale embed) + the reply ──
    const refreshed = await refreshCaseCard({
      interaction,
      communityId,
      guildId,
      caseRow,
      client: ctx?.supervisor?.discord ?? interaction?.client ?? null,
    });
    const warnings = [...noteWarnings];
    if (!refreshed.ok) {
      warnings.push(
        `**Card:** the case card could not be updated (${refreshed.error}) — the row states above are the ledger's truth.`,
      );
    }
    const already = res?.deduped === true ? " — **already handled**: this click did not run anything again" : "";
    await finish(
      `**Case:** ${caseRef} · \`${row.action}\` → **${outcome.label}** — ${outcome.detail}${already}`,
      warnings,
    );
  } catch (err) {
    // Belt (rule 1/6): the router also wraps, but THIS arm names its own
    // failure with the ids before anything generic can answer.
    console.error(
      "[automod] card approve handler failed:",
      `guild=${interaction?.guildId ?? "?"}`,
      `user=${interaction?.user?.id ?? "?"}`,
      `customId=${String(interaction?.customId ?? "?").slice(0, 120)}`,
      err?.message || err,
    );
    throw err;
  }
}

/**
 * `am:card:dismiss:<actionRowId>` — staff gate → validation →
 * `dismissSuggestion` (zero Discord calls) → note update → card rebuild →
 * ephemeral. No master/mode/breaker pre-gates: dismissing RUNS nothing, so
 * even a paused or mis-set guild must be able to decline a suggestion.
 *
 * @param {import("discord.js").ButtonInteraction} interaction
 * @param {object} [ctx]
 */
async function handleCardDismiss(interaction, ctx) {
  try {
    const pre = await cardArmPreamble(interaction, CARD_DISMISS_PREFIX, "dismiss");
    if (!pre.ok) return;
    const { communityId, guildId, row, caseRow } = pre;
    const staffUserId = String(interaction.user?.id ?? "unknown");
    const caseRef = caseRefOf(caseRow);
    const ids = { communityId, guildId, caseId: caseRow.id, caseNumber: caseRow.case_number };

    const finish = (message, extraLines = []) =>
      replyEphemeral(interaction, {
        content: sliceSafe([message, ...extraLines].filter(Boolean).join("\n"), 3900),
        allowedMentions: { parse: [] },
      });

    if (row.action === "no_action") {
      await finish(`**Case:** ${caseRef} · \`${row.action}\` → ${REFUSAL_NO_ACTION}`);
      return;
    }
    if (row.state !== "suggested") {
      const outcome = classifyOutcome({ deduped: true, state: row.state }, row);
      await finish(
        `**Case:** ${caseRef} · \`${row.action}\` → **${outcome.label}** — state \`${row.state}\` — ${outcome.detail}`,
      );
      await refreshCaseCard({
        interaction,
        communityId,
        guildId,
        caseRow,
        client: ctx?.supervisor?.discord ?? interaction?.client ?? null,
      });
      return;
    }

    const res = await dismissSuggestion({
      actionRowId: row.id,
      claimant: `staff:${staffUserId}`,
      note: `Dismissed by <@${staffUserId}>`,
    });
    const outcome = classifyOutcome(res, getAutomodAction(row.id) ?? row);

    const noteWarnings = [];
    if (outcome.terminal && res?.deduped !== true) {
      const note = findCaseNoteRow({
        communityId,
        userId: row.subject_user_id,
        caseNumber: caseRow.case_number,
        botUserId: interaction?.client?.user?.id ?? null,
      });
      if (!note) {
        noteWarnings.push(
          "**Staff note:** no automod note for this subject — the outcome could not be recorded (the card was updated anyway).",
        );
        console.error(
          `[automod] card dismiss note update skipped ${idTag({ ...ids, action: row.action, row: row.id, subject: row.subject_user_id })}: no harness note found for <@${row.subject_user_id}>`,
        );
      } else {
        const recorded = updateNoteOutcome({
          communityId,
          noteNumber: note.note_number,
          outcomeLine: outcomeLineFor({ verb: "dismiss", staffUserId }),
          editedBy: staffUserId,
        });
        if (!recorded.ok) {
          noteWarnings.push(`**Staff note N-${note.note_number}:** ${recorded.error} (the card was updated anyway).`);
          console.error(
            `[automod] card dismiss note update failed ${idTag({ ...ids, action: row.action, row: row.id, subject: row.subject_user_id })}: ${recorded.error}`,
          );
        }
      }
    }

    const refreshed = await refreshCaseCard({
      interaction,
      communityId,
      guildId,
      caseRow,
      client: ctx?.supervisor?.discord ?? interaction?.client ?? null,
    });
    const warnings = [...noteWarnings];
    if (!refreshed.ok) {
      warnings.push(
        `**Card:** the case card could not be updated (${refreshed.error}) — the row states above are the ledger's truth.`,
      );
    }
    const already = res?.deduped === true ? " — **already handled**: the earlier decision stands" : "";
    await finish(
      `**Case:** ${caseRef} · \`${row.action}\` → **${outcome.label}** — ${outcome.detail}${already}`,
      warnings,
    );
  } catch (err) {
    console.error(
      "[automod] card dismiss handler failed:",
      `guild=${interaction?.guildId ?? "?"}`,
      `user=${interaction?.user?.id ?? "?"}`,
      `customId=${String(interaction?.customId ?? "?").slice(0, 120)}`,
      err?.message || err,
    );
    throw err;
  }
}

module.exports = {
  // Colors + caps shared with the harness post family:
  COLORS,
  EMBED_FIELD_MAX,
  // Structured decision-log tags (harness + tests read these names):
  CARD_PARTICIPANTS_TOOL,
  CARD_POST_ERROR_TOOL,
  // Payload/render layer:
  buildCardPayload,
  buildCardButtons,
  renderDecisionBody,
  renderRowLine,
  buildCardFromCase,
  defaultSummaryFor,
  // Ledger helpers:
  readNotConsidered,
  readDecisionLog,
  participantsLogEntry,
  recordCardPostError,
  findCaseNoteRow,
  updateNoteOutcome,
  outcomeLineFor,
  // Button surface:
  parseCardButtonId,
  handleCardApprove,
  handleCardDismiss,
  // Copy constants (docs quote them; tests pin them):
  REFUSAL_MASTER_OFF,
  refusalModeOff,
  refusalPaused,
  REFUSAL_NO_ACTION,
};
