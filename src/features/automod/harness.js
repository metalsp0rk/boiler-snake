/**
 * Auto-moderation LLM harness — THE case runner (#728, epic #723).
 *
 * One recorded referral → one judged run. This module owns the case
 * lifecycle (recorded→processing→complete|failed, 068 vocabulary), the
 * provider round loop (through the shared `src/core/ai.js` client —
 * function calling, same as Gork's tools), the COMMIT through the shipped
 * executor (#729), the staff-facing outcome post, and the run-metadata
 * persistence (070). NOT a Gork tool, not Gork's prompt, not Gork's queue,
 * not Gork's daily counter (locked decision 7): nothing here imports
 * `../gork/**`; the shared surface is the AI_* env trio via core/ai.js and
 * the harness's OWN budget counter (`consumeAutomodCase`, one case key per
 * community per UTC day, settings #725).
 *
 * Run lifecycle (contract #728):
 *  1. Input + case-row validation, budget PRE-GATE (blocked/exhausted
 *     refuses BEFORE any mutation so the case stays re-runnable after the
 *     day rolls — intake already gates this; the belt exists because the
 *     run may happen long after the referral).
 *  2. ATOMIC CLAIM — `UPDATE automod_cases SET status='processing'
 *     WHERE id=? AND status='recorded'`. A second run for the same case
 *     can never claim (the status guard IS the WHERE clause), which is why
 *     this is a conditional UPDATE rather than the unconditioned
 *     `setAutomodCaseStatus` facade helper.
 *  3. Placeholder post to the automod channel at start (names the
 *     referrer). A post failure is logged and the run CONTINUES — the
 *     referrer-visible surface then degrades to the completion message
 *     only (contract).
 *  4. Context via `buildCaseContext` (#727); its {ok:false} fails the run
 *     with the specific cause.
 *  5. Tool rounds through `deps.chat` (production default: core/ai
 *     `chatWithTools`; tests script every round). READ tools execute
 *     immediately; ACTION tools + the staff-note tool only RECORD INTENT
 *     during the loop — NOTHING mutates until commit (contract commit
 *     shape). Rounds capped by AUTOMOD_MAX_TOOL_ROUNDS. The #734 delete
 *     tool's allow-list is threaded here too: the case anchor + the bundle's
 *     fetched window entries (`buildAllowedMessages`) — ids outside it are
 *     refused at dispatch, so nothing re-reads Discord or the db to decide
 *     what a delete may name.
 *  6. PROVIDER ACCEPTED ⟺ the loop got a parsed provider response at some
 *     point (ok result, ≥1 executed tool call, cap, or an empty-but-2xx
 *     body). Exactly then — and exactly ONCE — `consumeAutomodCase` runs.
 *     A call that never got accepted (HTTP 4xx/5xx, network, timeout,
 *     parse) consumes NOTHING (contract; test-pinned).
 *  7. COMMIT is TWO-PHASE around the actions (#733, epic #723):
 *     a. NOTE PRE-PASS (`prepareCaseNotes`, default behind
 *        `deps.prepareNotes`): every user with action intent gets their
 *        EXACTLY-ONE case note written through the real `createStaffNote`
 *        BEFORE any action runs (author = the bot) — the model's narrative
 *        or the harness-filled marker — the body's `**Actions:**` list
 *        carries the PLANNED state per intent (suggest rows: deterministic
 *        "pending approval"; auto rows: "planned"; `no_action`: the
 *        "recorded decision" it always was). Discovery-first: an existing
 *        automod note for the case is REUSED, never doubled.
 *     b. ACTIONS: every recorded intent through `executeAutomodAction({...
 *        caseId, referrerUserId, claimant: "harness" })` — the executor owns
 *        the mode gate, guards, atomic claim, and clamp; the harness clamps
 *        nothing. A warn intent gets `params.relatedNoteId` injected from
 *        its subject's pre-pass note row (#733), so the auto run AND a
 *        later Approve replay both carry the case-note link.
 *     c. NOTE POST-PASS (`reconcileCaseNotes`, default behind
 *        `deps.reconcileNotes`): queued notes for users WITHOUT intent are
 *        DROPPED (zero rows, honest card line, locked decision 4) and each
 *        action's REAL commit outcome is MERGED into the subject's SAME
 *        note through the card's `updateNoteOutcome` law (identical lines
 *        never duplicate): auto rows gain their executed/refused entry,
 *        suggest rows already read correctly and need no merge. Both passes
 *        are guarded hooks overridable via deps — a dead one degrades to a
 *        partial-failure card line, never a dead commit.
 *  8. Outcome post (#730): the placeholder is EDITED (or a fresh post lands
 *     when the placeholder never did) into the interactive CASE CARD —
 *     per-subject outcome sections built from a FRESH re-read of the action
 *     ledger + the meta line (model · duration · rounds · tools) +
 *     Approve/Dismiss buttons per still-suggested row (`src/features/
 *     automod/card.js`; the card rebuilds from row ids alone, so old cards
 *     keep working). Provider failures name the specific cause to the
 *     referrer: `**Referred by:** <@id> — provider error: <cause>`.
 *     A card that cannot post/edit is NEVER claimed posted: the failure
 *     logs with ids and `card.recordCardPostError` leaves a structured
 *     `_card_post_error` entry on the case.
 *  9. Metadata persist (070): last_model / last_duration_ms /
 *     last_tool_names / decision_log / last_run_error.
 *
 * Status semantics (documented decisions):
 *  - clean finish (model stopped with no tool calls) → `complete`.
 *  - ROUND CAP hit → commit STILL RUNS (contract: "still passes
 *    reconciliation"); the post names `tool-round cap (12) reached`; the
 *    case ends `complete` with that cause in `last_run_error` (the run
 *    finished and committed — it just ran out of rounds).
 *  - provider failure after acceptance (a mid-loop round died) → intents
 *    commit too, the case ends `failed` with the provider cause.
 *  - provider failure without acceptance → nothing was recorded, `failed`,
 *    zero budget consumed. A no-key configuration follows the same failed
 *    path AFTER the claim (the referrer-visible post names it).
 *
 * Isolation (AGENTS.md rules 1–3 + 6): nothing here may kill the client.
 * `runAutomodCase` never throws (belt catch names the cause); the detached
 * fire lives in refer.js with its own `.catch`; the boot sweep is defensive
 * per row. Every failure logs `[automod]` with community/guild/case ids and
 * every staff-facing line carries the specific cause.
 *
 * Lifecycle SQL note (file-ownership): the claim/metadata/sweep statements
 * live HERE against the shared connection handle (precedent:
 * `src/features/bridge/service.js`) because #728 may not edit
 * `src/db/repositories/automodCases.js`; they touch ONLY the columns 068
 * and 070 own and the status vocabulary `AUTOMOD_CASE_STATUSES` pins.
 *
 * Post shapes:
 *  - `buildReviewPlaceholderPayload(caseRow)` — the start placeholder (the
 *    card EDITS this message; colors/titles follow the card's family).
 *  - the outcome post is `card.buildCardPayload({...})` (#730) — exported
 *    from `src/features/automod/card.js`, tested there.
 *  - `buildInterruptedPayload(caseRow)` — the boot-sweep notice (no card:
 *    the run died mid-flight; nothing interactive to approve).
 */

const { sliceSafe } = require("../../core/text");
const {
  db: facadeDb,
  now: facadeNow,
  getAutomodCaseById,
  getAutomodBudget,
  consumeAutomodCase,
  createStaffNote,
  listAutomodActionsForCase,
  MAX_NOTE_CONTENT,
} = require("../../db");
const { getAiConfig, chatWithTools } = require("../../core/ai");
const { buildCaseContext } = require("./caseContext");
const { executeAutomodAction } = require("./executor");
const { readSettings } = require("./settings");
const { createToolDispatcher } = require("./harnessTools");
const { buildSystemPrompt, buildUserMessage } = require("./prompt");
const card = require("./card");
// Shared case-note discovery law + the anchor jump link (#733): ONE shape for
// the note evidence line, the warn tool's default evidence URL, and the
// card/executor's note lookup (see ./caseNote.js).
const { anchorJumpLink, findCaseNoteRow } = require("./caseNote");
const {
  AUTOMOD_ACTIONS,
  AUTOMOD_MAX_TOOL_ROUNDS,
  AUTOMOD_RUN_TIMEOUT_MS,
  AUTOMOD_NOTE_HARNESS_FILLED,
  AUTOMOD_NOTE_DROPPED_LABEL,
  AUTOMOD_NOTE_ACTIONS_HEADER,
  AUTOMOD_NOTE_EVIDENCE_LABEL,
  AUTOMOD_NOTE_TRUNCATION_MARKER,
  AUTOMOD_NOTE_ACTION_ENTRY_MAX,
  AUTOMOD_NOTE_MIN_NARRATIVE,
  AUTOMOD_NOTE_PLANNED_LABEL,
} = require("./constants");

/** The boot-sweep cause, pinned by the sweep test (#728 contract copy). */
const INTERRUPTED_ERROR = "run interrupted by restart";

/** Embed palette (review yellow / decision green / failure red). */
const COLORS = Object.freeze({
  review: 0xf1c40f,
  complete: 0x57f287,
  failed: 0xed4245,
});

/** Discord embed field cap is 1024 — stay under it. */
const EMBED_FIELD_MAX = 1000;

/* ── logging + service shape (AGENTS.md rules 2/3/6) ─────────────────────── */

function idTag({ communityId, guildId, caseId, caseNumber }) {
  return (
    `(community ${communityId ?? "?"} guild ${guildId ?? "?"} case ` +
    `${caseNumber != null ? `A-${caseNumber}` : `#${caseId ?? "?"}`})`
  );
}

function logFail(what, ids, err) {
  console.error(
    `[automod] harness ${what} failed ${idTag(ids)}:`,
    err?.message || err,
  );
}

/** Empty/whitespace → null (the automod family idiom). */
function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/** The ONE pre-run failure exit (no claim happened — nothing mutated). */
function refuseRun(ids, message) {
  console.error(`[automod] harness run refused ${idTag(ids)}: ${message}`);
  return { ok: false, state: "refused", error: message };
}

/**
 * The provider's SPECIFIC failure text (contract: the referrer gets the
 * provider's own words, not "something failed"). core/ai attaches
 * `errorBody` (truncated provider body) on HTTP errors — it usually names
 * the real cause ("invalid API key", "model not found").
 */
function formatProviderCause(res) {
  const base = res?.error || (res?.reason ? `provider ${res.reason}` : "unknown error");
  const status = res?.status != null && !String(base).includes(String(res.status))
    ? ` (HTTP ${res.status})`
    : "";
  const body = optionalText(res?.errorBody);
  return `${base}${status}${body ? ` — provider said: ${sliceSafe(body, 200)}` : ""}`;
}

/* ── lifecycle SQL (claim / metadata / sweep) — harness-owned, see header ── */

function claimProcessing(dbHandle, caseId, t) {
  const info = dbHandle
    .prepare(
      `UPDATE automod_cases SET status='processing', updated_at=? WHERE id=? AND status='recorded'`,
    )
    .run(t, caseId);
  return info.changes === 1;
}

function writeRunMetadata(dbHandle, caseId, meta, t) {
  dbHandle
    .prepare(
      `UPDATE automod_cases
          SET status=?, updated_at=?, last_model=?, last_duration_ms=?,
              last_tool_names=?, decision_log=?, last_run_error=?
        WHERE id=?`,
    )
    .run(
      meta.status,
      t,
      meta.model ?? null,
      Number.isFinite(Number(meta.durationMs)) ? Math.max(0, Math.floor(Number(meta.durationMs))) : null,
      meta.toolNames ? JSON.stringify(meta.toolNames) : null,
      meta.decisionLog ? JSON.stringify(meta.decisionLog) : null,
      meta.lastRunError ?? null,
      caseId,
    );
}

/* ── post payload builders (placeholder + sweep notice; the card builder
      lives in ./card.js — the outcome post is a card, built from the
      FRESH ledger rows at finish) ────────────────────────────────────────── */

/**
 * The start placeholder — posted to the automod channel when the run
 * claims the case. The outcome run EDITS this message into the case card.
 * Shape:
 *   { allowedMentions: {parse:[]},
 *     embeds: [{ title: "Automod — case A-n — reviewing",
 *                description, fields: [{name:"Referral", value:"Referred by <@id>"}],
 *                color: 0xf1c40f }] }
 *
 * @param {object} caseRow the automod_cases row
 * @returns {object} a channel.send-able payload
 */
function buildReviewPlaceholderPayload(caseRow) {
  return {
    allowedMentions: { parse: [] },
    embeds: [
      {
        title: `Automod — case A-${caseRow.case_number} — reviewing`,
        description:
          "The judge is reading the referral, the message window, and the records. The decision posts on this message when the run finishes.",
        fields: [
          { name: "Referral", value: sliceSafe(`Referred by <@${caseRow.referrer_user_id}>`, EMBED_FIELD_MAX) },
        ],
        color: COLORS.review,
      },
    ],
  };
}

/**
 * The outcome post is `card.buildCardPayload({...})` (#730) — the harness
 * feeds it fresh ledger rows in `finishRun`. The old plain-embed decision
 * builder is gone; grep history: `buildDecisionPayload`.
 */

/** The boot-sweep notice (minimal; the case's real state is the row). */
function buildInterruptedPayload(caseRow) {
  return {
    allowedMentions: { parse: [] },
    embeds: [
      {
        title: `Automod — case A-${caseRow.case_number} — interrupted`,
        description: sliceSafe(
          `Referred by <@${caseRow.referrer_user_id}> — the review run was interrupted by a restart. The case was marked **failed** (${INTERRUPTED_ERROR}); a staff member can handle it manually.`,
          4000,
        ),
        color: COLORS.failed,
      },
    ],
  };
}

/* ── deps seams ──────────────────────────────────────────────────────────── */

/**
 * Production deps over a Discord client, every seam individually
 * overridable (executor/caseContext `buildDefaultDeps` posture). Tests
 * replace `chat`, the posts, the executor entry, the note writer, or any
 * single read — the runner itself never touches Discord directly.
 *
 * @param {{client?: object}} [over]
 */
function makeRunDeps({ client = null } = {}) {
  return {
    db: facadeDb,
    now: () => facadeNow(),
    aiConfig: () => getAiConfig(),
    /**
     * The provider seam. Same argument shape as core/ai `chatWithTools`
     * (cfg, {messages, tools, executeTool, maxToolRounds, timeoutMs}).
     * A result may carry an extra `rounds` number (the meta line prefers
     * it); the production wrapper attaches it from the round-tagged
     * capture events so fakes can pin the meta line too.
     */
    chat: (cfg, opts) => {
      let maxRound = -1;
      const wrapped = {
        ...opts,
        onEvent: (evt) => {
          if (Number.isFinite(evt?.round)) maxRound = Math.max(maxRound, evt.round);
          if (typeof opts.onEvent === "function") opts.onEvent(evt);
        },
      };
      return chatWithTools(cfg, wrapped).then((res) => ({
        ...res,
        rounds: Number.isFinite(res?.rounds) ? res.rounds : Math.max(0, maxRound + 1),
      }));
    },
    getCase: (caseId) => getAutomodCaseById(caseId),
    /** Fresh ledger read for the outcome card (the card rebuilds from rows
     *  alone — never from the in-memory commit lines). */
    listCaseActions: (communityId, caseId) => listAutomodActionsForCase(communityId, caseId),
    readSettings: (communityId) => readSettings(communityId),
    getBudget: (communityId, nowMs) => getAutomodBudget(communityId, nowMs),
    consume: (communityId, nowMs) => consumeAutomodCase(communityId, { nowMs }),
    /** seam passed THROUGH to buildCaseContext (its own buildDefaultDeps
     *  fills the rest from `client`). */
    contextDeps: { client },
    /** seam for the lookups' guild-isolation member read. */
    lookupDeps: { client },
    /** seam passed THROUGH to executeAutomodAction (its buildDefaultDeps
     *  fills the Discord mutations from `client`; tests inject `actions`). */
    actionDeps: { client },
    /** The executor entry — tests inject a recording wrapper around the
     *  REAL executor to prove commit order without mocking its guts. */
    executeAction: (input) => executeAutomodAction(input),
    /** The REAL staff-notes write (repository via the facade). */
    createNote: ({ communityId, userId, authorId, content }) =>
      createStaffNote({ communityId, userId, authorId, content }),
    botUserId: client?.user?.id ? String(client.user.id) : "automod",
    postToChannel: async (channelId, payload) => {
      if (!client?.channels?.fetch) {
        throw new Error("no Discord client — the case outcome cannot post");
      }
      const channel = await client.channels.fetch(String(channelId));
      if (!channel?.send) throw new Error(`channel ${channelId} did not resolve to a sendable channel`);
      return channel.send(payload);
    },
    editMessage: async (message, payload) => {
      if (!message || typeof message.edit !== "function") {
        throw new Error("the placeholder message cannot be edited");
      }
      return message.edit(payload);
    },
    /** The #733 TWO-PHASE note commit — PRE-PASS (see commitRunIntents):
     *  the case's exactly-one note per subject is written (or reused, via
     *  the shared discovery law) BEFORE any action runs, so a warn intent
     *  can carry its subject's note as `relatedNoteId`. Tests override or
     *  wrap this seam; a broken pre-pass degrades to a card line. */
    prepareNotes: (args) => prepareCaseNotes(args),
    /** The #731/#733 POST-PASS reconciler: drops queued notes without
     *  intent (zero rows, honest card line) and merges each action's real
     *  commit outcome into the subject's SAME note. Tests override or wrap
     *  this seam; a broken reconciler can never break the commit. */
    reconcileNotes: (args) => reconcileCaseNotes(args),
    /** The note-outcome merge law (#731, card.js) — the POST-PASS default.
     *  Real repository write through the card's cap/merge/idempotence
     *  discipline; tests may substitute the seam. */
    updateNoteOutcome: (args) => card.updateNoteOutcome(args),
  };
}

/** Merge caller deps over the production defaults (explicit seams win). */
function buildRunDeps(over = {}) {
  const base = makeRunDeps({ client: over?.client ?? null });
  return { ...base, ...over };
}

/* ── staff-note layer (#731 + #733, epic #723) — the one-note law, two-phase ─
 * Every user the model selects with ANY action tool (no_action included)
 * ends the commit with EXACTLY ONE automod staff note, written through the
 * real `createStaffNote` (author = the bot) in the PRE-PASS, BEFORE the
 * actions run (#733, so a warn carries it as relatedNoteId). Body law (#731):
 * case A-n, what was weighed (the model's narrative, or the harness-filled
 * marker when the model omitted it), the action list in its PLANNED state
 * (mode-aware: suggest "pending approval", auto "planned", no_action
 * "recorded decision"), and the evidence message link when the case has one
 * — all inside the 2000-char cap (the narrative truncates with an explicit
 * marker; the case never fails for it). The POST-PASS then merges each
 * action's REAL commit outcome into the SAME row through the card's
 * `updateNoteOutcome` law — identical lines never duplicate, so a suggest
 * run writes the note once and never touches it again, while auto rows
 * gain their executed/refused entry under **Outcome:** before the card
 * posts. A note the model queued for a user WITHOUT action intent is
 * DROPPED (zero rows) and the case card says why. Staff Approve/Dismiss
 * later UPDATE this same row (`card.updateNoteOutcome`) — never a second
 * automod note for the same case+user. */

/** The note-write actor: the bot acting for the harness (the repository
 *  stores the id verbatim; the staff surfaces render the bot user). */
function noteAuthorId(d) {
  return optionalText(d.botUserId) ?? "automod";
}

/** The discovery suffix `card.findCaseNoteRow` scans for — ONE definition. */
function automodNoteSuffix(caseRow) {
  return ` (automod case A-${caseRow?.case_number ?? "?"})`;
}

/** The referred message's jump link — the note's evidence line when present.
 *  #733: ONE shape shared with the warn tool's default evidence URL and the
 *  card's suggested-row link (./caseNote.js `anchorJumpLink`). Export kept:
 *  the note-reconcile pure test pins this name. */
function evidenceLink(guildId, caseRow) {
  return anchorJumpLink(guildId, caseRow);
}

/**
 * THE #734 DELETE ALLOW-LIST — built once per run, threaded into the tool
 * dispatcher. Contract law: the delete tool "may only name message ids that
 * are in this case's referral or fetched context window." The sources are
 * exactly two, and NEITHER is a db read:
 *  - the case row's anchor pair (the referral itself; author seeded from the
 *    intake's named target), and
 *  - the bundle's window entries — what was ACTUALLY fetched, asker-scoped
 *    (#727 decision-46 parity), each carrying its own channel + author.
 * A window entry for the anchor id OVERWRITES the seeded author with the
 * real one. The map is messageId → { channelId, authorId }; the dispatcher
 * resolves delete targets from it, so the model never names channels.
 *
 * @param {{ caseRow?: object|null, context?: object|null }} input
 * @returns {Map<string, { channelId: string|null, authorId: string|null }>}
 */
function buildAllowedMessages({ caseRow = null, context = null } = {}) {
  const allowed = new Map();
  const put = (messageId, channelId, authorId) => {
    const id = optionalText(messageId);
    if (!id) return;
    const prev = allowed.get(id) ?? {};
    allowed.set(id, {
      channelId: optionalText(channelId) ?? prev.channelId ?? null,
      authorId: optionalText(authorId) ?? prev.authorId ?? null,
    });
  };
  if (caseRow?.message_id != null && caseRow?.channel_id != null) {
    put(caseRow.message_id, caseRow.channel_id, caseRow?.target_user_id);
  }
  for (const m of Array.isArray(context?.window?.messages) ? context.window.messages : []) {
    put(m?.id, m?.channel_id ?? context?.window?.channel_id ?? null, m?.author_id);
  }
  return allowed;
}

/** Note-side state words — deliberately the SAME words the case card renders
 *  (card.js `renderRowLine`), so the note and the card never disagree. */
function noteStateLabel(intent, out) {
  if (intent?.action === "no_action") return "recorded decision";
  const state = out?.state ?? (out?.ok ? "executed" : "failed");
  if (state === "recorded_suggestion") return "pending approval";
  if (state === "suggested") return "pending approval";
  if (state === "approved" || out?.inFlight) return "in flight";
  if (state === "dismissed") return "dismissed";
  return String(state);
}

/**
 * The state word a PRE-PASS note carries for an intent that has NOT run yet
 * (#733 two-phase commit). Mode-aware, and the run's OWN settings view decides
 * (the same map the toolset was gated with — what the model was offered):
 *  - `no_action` → "recorded decision" — it IS the decision, from birth;
 *  - suggest mode → "pending approval" — deterministic: recording the intent
 *    can only land the pending suggestion row;
 *  - auto mode → AUTOMOD_NOTE_PLANNED_LABEL ("planned") — honest: the write
 *    precedes the run, and the POST-PASS merges the real executed/refused
 *    entry through the card's updateNoteOutcome law before the card posts.
 */
function plannedStateLabel(action, modes = {}) {
  if (String(action ?? "") === "no_action") return "recorded decision";
  const mode = String(modes?.[action] ?? "suggest").trim().toLowerCase();
  return mode === "auto" ? AUTOMOD_NOTE_PLANNED_LABEL : "pending approval";
}

/** One PRE-PASS `**Actions:**` line — the planned twin of `noteActionEntry`
 *  (same grammar, no outcome yet). The POST-PASS compares its TRIMMED form
 *  against the committed entry: equal ⇒ no merge (a suggest row's note is
 *  written once and never rewritten). */
function plannedNoteEntry({ intent, modes = {} } = {}) {
  const pieces = [
    `  - \`${intent?.action ?? "?"}\` — ${plannedStateLabel(intent?.action, modes)}`,
  ];
  const why = optionalText(intent?.params?.reason ?? intent?.params?.rationale);
  if (why) pieces.push(`— reason: "${sliceSafe(why, 120)}"`);
  return sliceSafe(pieces.filter(Boolean).join(" "), AUTOMOD_NOTE_ACTION_ENTRY_MAX - 16);
}

/** One `**Actions:**` line: action, commit state, the reason the model gave,
 *  and the executor's verbatim result/error when it carried one. Capped by
 *  AUTOMOD_NOTE_ACTION_ENTRY_MAX — the note never drowns the narrative. */
function noteActionEntry({ intent, out }) {
  const pieces = [
    `  - \`${intent?.action ?? "?"}\` — ${noteStateLabel(intent, out)}`,
    optionalText(out?.result) ? `— ${sliceSafe(String(out.result), 140)}` : "",
    optionalText(out?.error) ? `— ${sliceSafe(String(out.error), 140)}` : "",
  ];
  const why = optionalText(intent?.params?.reason ?? intent?.params?.rationale);
  if (why) pieces.push(`— reason: "${sliceSafe(why, 120)}"`);
  return sliceSafe(pieces.filter(Boolean).join(" "), AUTOMOD_NOTE_ACTION_ENTRY_MAX - 16);
}

/**
 * Assemble one automod note body, capped so it ALWAYS fits
 * MAX_NOTE_CONTENT (the repository throws above the cap — the note is
 * written, never the case failed): the actions block keeps its shape, the
 * narrative truncates with the explicit #731 marker when squeezed.
 *
 * Grammar (card.updateNoteOutcome replays it): narrative first, then the
 * `**Actions:**` block, then the evidence line, then the discovery suffix —
 * the staff-outcome section is appended AFTER all of it on a staff decision.
 */
function assembleAutomodNoteBody({
  narrative = "",
  harnessFilled = false,
  entryLines = [],
  evidenceUrl = null,
  suffix = "",
} = {}) {
  const budget = MAX_NOTE_CONTENT - suffix.length;
  const blocks = (list) =>
    [
      list.length ? `${AUTOMOD_NOTE_ACTIONS_HEADER}\n${list.join("\n")}` : "",
      evidenceUrl ? `${AUTOMOD_NOTE_EVIDENCE_LABEL} <${evidenceUrl}>` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  // The actions/evidence blocks may never crowd the narrative out entirely:
  // drop tail entries (with an honest marker line) until the floor is kept.
  const floor = Math.max(
    AUTOMOD_NOTE_MIN_NARRATIVE,
    harnessFilled ? AUTOMOD_NOTE_HARNESS_FILLED.length : 0,
  );
  const full = Array.isArray(entryLines) ? entryLines.filter(Boolean) : [];
  let entries = full;
  while (entries.length > 0 && blocks(entries).length + 2 > budget - floor) {
    entries = entries.slice(0, -1);
  }
  if (entries.length > 0 && entries.length < full.length) {
    entries = [...entries, "  - …[remaining actions truncated]"];
    if (blocks(entries).length + 2 > budget - floor) entries = entries.slice(0, -1);
  }
  let skeleton = blocks(entries);
  if (skeleton.length + 2 > budget - Math.min(40, floor)) {
    skeleton = sliceSafe(skeleton, Math.max(1, budget - Math.min(40, floor) - 15)) + "…[truncated]";
  }
  const baseText = harnessFilled ? AUTOMOD_NOTE_HARNESS_FILLED : String(narrative ?? "").trim();
  const room = budget - (skeleton ? skeleton.length + 2 : 0);
  let narrativeText;
  if (baseText.length <= room) {
    narrativeText = baseText;
  } else {
    const keep = Math.max(1, room - AUTOMOD_NOTE_TRUNCATION_MARKER.length - 1);
    narrativeText = sliceSafe(baseText, keep) + AUTOMOD_NOTE_TRUNCATION_MARKER;
  }
  // Belt (rule 5 in miniature): even a squeezed-to-nothing body still writes
  // SOMETHING honest rather than throwing the subject's note away.
  narrativeText = narrativeText || sliceSafe(AUTOMOD_NOTE_HARNESS_FILLED, Math.max(1, room));
  let body = [narrativeText, skeleton].filter(Boolean).join("\n\n");
  if (body.length > budget) body = sliceSafe(body, Math.max(1, budget - 13)) + "…[truncated]";
  return body + suffix;
}

/**
 * THE #733 NOTE PRE-PASS — the one-note law enforced BEFORE the actions run
 * (a warn must be able to link its case's ONE staff note, so the note exists
 * first). Default behind `deps.prepareNotes`; commitRunIntents guards it, so
 * a throwing pre-pass degrades to a partial-failure card line, never a dead
 * commit.
 *
 * Law it enforces (#731 unchanged; only the timing moved):
 *  - considered (ANY action intent, no_action included) → exactly ONE note;
 *    narrative from the queued note when the model wrote one, else the
 *    harness-filled marker body ("model omitted the narrative");
 *  - the body's `**Actions:**` list carries each intent in its PLANNED state
 *    (`plannedStateLabel`) — the POST-PASS merges the real commit outcome;
 *  - discovery-first: the case's automod note already on the books is
 *    REUSED, never doubled (the one-note law survives re-entry);
 *  - never DMs the note, never touches ticket/DM copy (that copy law lives
 *    in the note body itself + #735's scrub).
 *
 * @param {object} args the commitRunIntents hook shape: { communityId,
 *   guildId, caseRow, ids, modes, consideredUserIds, notedUserIds,
 *   noteIntents, actionIntents, deps }
 * @returns {Promise<{ lines: string[], extraLines: string[], noteResults:
 *   Array<{ ok: boolean, userId: string, row?: object, error?: string,
 *   reused?: boolean }>, notes: Map<string, object> }>}
 */
async function prepareCaseNotes({
  communityId,
  guildId = null,
  caseRow,
  noteIntents = [],
  actionIntents = [],
  modes = {},
  deps = {},
} = {}) {
  const lines = [];
  const extraLines = [];
  const noteResults = [];
  const notes = new Map(); // subject user id → the case's ONE note row

  // Subjects in FIRST-SEEN intent order (one note per subject, the body
  // lists every action against them — contract 3c).
  const subjectOrder = [];
  const bySubject = new Map();
  for (const intent of Array.isArray(actionIntents) ? actionIntents : []) {
    const subject = String(intent?.subjectUserId ?? "").trim();
    if (!subject) continue;
    if (!bySubject.has(subject)) {
      bySubject.set(subject, []);
      subjectOrder.push(subject);
    }
    bySubject.get(subject).push(intent);
  }

  const queued = new Map();
  for (const n of Array.isArray(noteIntents) ? noteIntents : []) {
    const userId = String(n?.userId ?? "").trim();
    if (userId && !queued.has(userId)) queued.set(userId, n);
  }

  const suffix = automodNoteSuffix(caseRow);
  const evidence = evidenceLink(guildId, caseRow);

  for (const userId of subjectOrder) {
    const note = queued.get(userId);
    try {
      // Discovery first (#733): an existing automod note for this case+user
      // is REUSED — never a second note, even on re-entry.
      let row = findCaseNoteRow({
        communityId,
        userId,
        caseNumber: caseRow?.case_number,
        botUserId: optionalText(deps.botUserId),
      });
      if (row) {
        notes.set(userId, row);
        noteResults.push({ ok: true, userId, row, reused: true });
        lines.push(
          `- staff note → <@${userId}>: reused (N-${row?.note_number ?? "?"}) — the case already carried its automod note.`,
        );
        continue;
      }
      row = deps.createNote({
        communityId,
        userId,
        authorId: noteAuthorId(deps),
        content: assembleAutomodNoteBody({
          narrative: note?.content ?? "",
          harnessFilled: !note,
          entryLines: (bySubject.get(userId) ?? []).map((intent) =>
            plannedNoteEntry({ intent, modes }),
          ),
          evidenceUrl: evidence,
          suffix,
        }),
      });
      notes.set(userId, row);
      noteResults.push({ ok: true, userId, row });
      lines.push(
        `- staff note → <@${userId}>: recorded (N-${row?.note_number ?? "?"})${note ? "" : " — harness-filled"}.`,
      );
    } catch (err) {
      const cause = sliceSafe(err?.message || String(err), 200);
      console.error(
        `[automod] harness staff-note commit failed (community ${communityId} user ${userId} ` +
        `case ${caseRow?.case_number != null ? `A-${caseRow.case_number}` : `#${caseRow?.id ?? "?"}`}): ${cause}`,
      );
      noteResults.push({ ok: false, userId, error: cause });
      lines.push(`- staff note → <@${userId}>: **could not record** — ${cause}`);
      extraLines.push(`- **Staff note:** could not record for <@${userId}> — ${cause}`);
    }
  }

  return { lines, extraLines, noteResults, notes };
}

/**
 * THE #731/#733 NOTE POST-PASS — the commit-time completion of the one-note
 * law (the contract: "prompt text is not enough"). Default behind
 * `deps.reconcileNotes`; commitRunIntents guards it, so a throwing
 * reconciler degrades to a partial-failure card line, never a dead commit.
 * It writes NO notes — the PRE-PASS owns writing; this pass:
 *  - queued note WITHOUT intent (a window speaker, the referrer who only
 *    filed, a lookup target) → DROPPED: zero staff_notes rows and one
 *    honest `**Staff note dropped:**` card line naming the user;
 *  - each executed action's REAL outcome MERGED into the subject's SAME
 *    note through the card's `updateNoteOutcome` law (identical lines never
 *    duplicate): auto rows gain their executed/refused entry, a suggest row
 *    whose planned line already states the truth needs NO merge;
 *  - never DMs the note, never touches ticket/DM copy (that copy law lives
 *    in the note body itself + #735's scrub).
 *
 * @param {object} args the commitRunIntents hook shape: { communityId,
 *   guildId, caseRow, ids, modes, consideredUserIds, notedUserIds,
 *   noteIntents, actionIntents, actionResults, notes, deps }
 * @returns {Promise<{ lines: string[], extraLines: string[],
 *                     noteResults: Array<{ ok: boolean, userId: string,
 *                     row?: object, dropped?: boolean, mergeError?: string }> }>}
 */
async function reconcileCaseNotes({
  communityId,
  guildId = null,
  caseRow = null,
  consideredUserIds = [],
  notedUserIds = [],
  noteIntents = [],
  actionResults = [],
  modes = {},
  notes = null,
  deps = {},
} = {}) {
  const lines = [];
  const extraLines = [];
  const noteResults = [];

  // Subject → its action results, FIRST-SEEN order (merge one entry per
  // action against the subject's single note).
  const bySubject = new Map();
  for (const r of Array.isArray(actionResults) ? actionResults : []) {
    const subject = String(r?.intent?.subjectUserId ?? "").trim();
    if (!subject) continue;
    if (!bySubject.has(subject)) bySubject.set(subject, []);
    bySubject.get(subject).push(r);
  }

  const queued = new Map();
  for (const n of Array.isArray(noteIntents) ? noteIntents : []) {
    const userId = String(n?.userId ?? "").trim();
    if (userId && !queued.has(userId)) queued.set(userId, n);
  }

  // Queued notes for users with NO action intent: dropped, never written
  // (decision 4 — filing a referral, speaking in the window, or being a
  // lookup target is not consideration).
  const considered = new Set(
    (Array.isArray(consideredUserIds) ? consideredUserIds : [])
      .map((id) => String(id ?? "").trim())
      .filter(Boolean),
  );
  for (const userId of [...queued.keys()]) {
    if (bySubject.has(userId) || considered.has(userId)) continue;
    const report =
      `- ${AUTOMOD_NOTE_DROPPED_LABEL} <@${userId}> — the note tool named them but the model recorded no action ` +
      "(not considered), so no staff note was written (locked decision 4).";
    lines.push(report);
    extraLines.push(report);
    noteResults.push({ ok: true, userId, dropped: true });
  }

  // Outcome merge (#733 two-phase law): the PRE-PASS wrote the note with
  // PLANNED states; the real commit outcome lands on the SAME row through
  // the card's merge discipline. The planned-line comparison keeps suggest
  // runs quiet (their planned line IS the truth — no edit stamp, no
  // churn); auto/executed/refused rows gain their entry under **Outcome:**
  // BEFORE the case card posts.
  const noteRows =
    notes instanceof Map ? notes : new Map(Object.entries(notes ?? {}));
  const editor = noteAuthorId(deps);
  if (typeof deps.updateNoteOutcome === "function") {
    for (const [userId, results] of bySubject) {
      const row = noteRows.get(String(userId));
      if (!row || row.note_number == null) continue; // write failed — already reported
      for (const { intent, out } of results) {
        const entry = noteActionEntry({ intent, out }).trim();
        const planned = plannedNoteEntry({ intent, modes }).trim();
        if (!entry || entry === planned) continue;
        try {
          const done = await deps.updateNoteOutcome({
            communityId,
            noteNumber: row.note_number,
            outcomeLine: entry,
            editedBy: editor,
          });
          if (!done?.ok) {
            throw new Error(done?.error || "the note refused the outcome entry");
          }
        } catch (err) {
          // Rule 5: the note EXISTS and the action outcome is on the row +
          // card — only the merge failed. Say so; keep the note ref alive.
          const cause = sliceSafe(err?.message || String(err), 200);
          console.error(
            `[automod] harness note outcome merge failed (community ${communityId} user ${userId} ` +
            `case ${caseRow?.case_number != null ? `A-${caseRow.case_number}` : `#${caseRow?.id ?? "?"}`}): ${cause}`,
          );
          const line = `- **Staff note N-${row.note_number}:** outcome merge failed for <@${userId}> — ${cause}`;
          lines.push(line);
          extraLines.push(line);
          noteResults.push({ ok: true, userId, row, mergeError: cause });
        }
      }
    }
  }

  return { lines, extraLines, noteResults, consideredUserIds, notedUserIds };
}

/* ── commit ──────────────────────────────────────────────────────────────── */

/** One commit-report line per recorded action intent, from the EXECUTOR
 *  RESULT (state + error/result verbatim). `res.commit.lines` is the
 *  runner's report surface; the CARD's Decision field renders from the
 *  ledger rows instead (#730), so a rebuild after restart looks identical. */
function formatActionLine(intent, out) {
  const state = out?.state ?? (out?.ok ? "executed" : "failed");
  const detail =
    out?.error ??
    out?.result ??
    (out?.inFlight ? "already claimed by another run" : "") ??
    "";
  const suffix = detail ? ` — ${sliceSafe(String(detail), 220)}` : "";
  return `- \`${intent.action}\` → <@${intent.subjectUserId}>: **${state}**${suffix}`;
}

/**
 * TWO-PHASE COMMIT (#733): NOTE PRE-PASS → ACTIONS → NOTE POST-PASS.
 *  a. `deps.prepareNotes` (default `prepareCaseNotes`) writes/reuses the
 *     case's exactly-one note per subject BEFORE any action, so a warn
 *     intent can carry its subject's note as `params.relatedNoteId` — the
 *     suggestion row stores it and the auto run AND a later Approve replay
 *     both pass it to `createWarning` (#733).
 *  b. ACTIONS through the executor (its own claims/dedupe own those rows);
 *     the mode gate, guards, and the clamp live there — the harness passes
 *     through.
 *  c. `deps.reconcileNotes` (default `reconcileCaseNotes`) drops queued
 *     notes without intent and merges each real commit outcome into the
 *     subject's SAME note (card `updateNoteOutcome` law; planned-equal lines
 *     never merge).
 * Overriding either hook replaces that phase (wrap the default to keep its
 * story — see test/automod-harness.test.js). Partial failures report partial
 * results (AGENTS.md rule 5) — one dead intent never cancels the rest, and
 * one dead hook never cancels the commit.
 */
async function commitRunIntents({ d, cid, gid, caseRow, referrerUserId, dispatcher, modes = {}, ids }) {
  const lines = [];
  // Lines the CASE CARD appends to its Decision field that the ledger rows
  // cannot carry: note-write failures, drop reports, and merge failures.
  const extraLines = [];
  const actionResults = [];
  const noteResults = [];

  const hookArgs = () => ({
    communityId: cid,
    guildId: gid,
    caseRow,
    ids,
    modes,
    consideredUserIds: dispatcher.consideredUserIds(),
    notedUserIds: dispatcher.noteIntents.map((n) => n.userId),
    noteIntents: dispatcher.noteIntents,
    actionIntents: dispatcher.actionIntents,
    deps: d,
  });

  // ── 1. NOTE PRE-PASS (#733) — the note exists BEFORE the actions run.
  // Guarded (rule 5): a dead pre-pass degrades to one partial-failure line;
  // the warn note-link then stays the executor's best-effort resolve.
  let notes = new Map();
  if (typeof d.prepareNotes === "function") {
    try {
      const pre = await d.prepareNotes({ ...hookArgs(), actionResults: [] });
      if (Array.isArray(pre?.lines)) lines.push(...pre.lines);
      if (Array.isArray(pre?.extraLines)) extraLines.push(...pre.extraLines);
      if (Array.isArray(pre?.noteResults)) noteResults.push(...pre.noteResults);
      if (pre?.notes instanceof Map) notes = pre.notes;
    } catch (err) {
      logFail("note pre-pass", ids, err);
      const line = `- note pre-pass: **failed** — ${sliceSafe(err?.message || String(err), 200)}`;
      lines.push(line);
      extraLines.push(line);
    }
  }

  // ── 2. ACTIONS through the executor ──────────────────────────────────────
  for (const intent of dispatcher.actionIntents) {
    // #733 warn → relatedNoteId: the subject's case note (pre-pass row) is
    // recorded ON the intent so the suggestion row carries it — Approve
    // replays it without re-discovery. A pre-pass note failure leaves the
    // link unset; the executor's own resolveCaseNoteId stays the fallback.
    let params = intent.params;
    if (intent.action === "warn" && params?.relatedNoteId == null) {
      const noteRow = notes.get(String(intent.subjectUserId ?? ""));
      if (noteRow?.id != null) {
        params = { ...(params ?? {}), relatedNoteId: noteRow.id };
        intent.params = params; // the recorded intent carries it too (report honesty)
      }
    }
    let out;
    try {
      out = await d.executeAction({
        communityId: cid,
        guildId: gid,
        caseId: caseRow.id,
        action: intent.action,
        subjectUserId: intent.subjectUserId,
        params,
        referrerUserId,
        claimant: "harness",
        deps: d.actionDeps ?? {},
      });
    } catch (err) {
      // Belt: executeAutomodAction never throws (rule 6) — an injected seam
      // that does still gets a specific line instead of killing the loop.
      logFail("action commit (executor threw)", { ...ids, caseId: caseRow.id }, err);
      out = { ok: false, state: "failed", error: `executor threw: ${err?.message || err}` };
    }
    actionResults.push({ intent, out });
    lines.push(formatActionLine(intent, out));
  }

  // ── 3. NOTE POST-PASS (#731 + #733) — the note story completes here:
  // queued notes without intent are dropped with an honest card line, and
  // each action's REAL commit outcome merges into the subject's SAME note
  // (default `reconcileCaseNotes`; `notes` is the pre-pass Map of written/
  // reused rows). `lines` report to the commit result; `extraLines` are the
  // non-ledger lines the CASE CARD must carry. Guarded (rule 5): a dead
  // reconciler degrades to one partial-failure line — the actions and the
  // notes written by the pre-pass above all stay.
  if (typeof d.reconcileNotes === "function") {
    try {
      const extra = await d.reconcileNotes({ ...hookArgs(), actionResults, notes });
      if (Array.isArray(extra?.lines)) lines.push(...extra.lines);
      if (Array.isArray(extra?.extraLines)) extraLines.push(...extra.extraLines);
      if (Array.isArray(extra?.noteResults)) noteResults.push(...extra.noteResults);
    } catch (err) {
      logFail("note reconciliation", ids, err);
      const line = `- note reconciliation: **failed** — ${sliceSafe(err?.message || String(err), 200)}`;
      lines.push(line);
      extraLines.push(line);
    }
  }

  return { lines, extraLines, actionResults, noteResults };
}

/* ── the runner ──────────────────────────────────────────────────────────── */

/**
 * Run the LLM harness for ONE recorded case. Service contract (rule 6):
 * never throws, never replies to Discord by itself outside the automod
 * channel posts, returns { ok, state, error? }.
 *
 * @param {object} input
 * @param {number} input.communityId
 * @param {string} input.guildId
 * @param {number} input.caseId                     automod_cases row id
 * @param {object} [input.deps]                     seam overrides (see makeRunDeps)
 * @param {number} [input.nowMs]
 * @returns {Promise<{ ok: boolean, state: "complete"|"failed"|"refused",
 *                     caseRef?: string, error?: string }>}
 */
async function runAutomodCase(input = {}) {
  const { communityId = null, guildId = null, caseId = null, deps = {}, nowMs } = input;
  try {
    return await runCaseInner({ communityId, guildId, caseId, deps, nowMs });
  } catch (err) {
    // Belt (rule 6): every known path returns the service shape; anything
    // escaping is a bug — name it with the ids, never a silent drop.
    logFail("unexpected run error", {
      communityId,
      guildId,
      caseId,
    }, err);
    return { ok: false, state: "failed", error: `Auto-mod harness error: ${err?.message || err}` };
  }
}

async function runCaseInner({ communityId, guildId, caseId, deps, nowMs }) {
  const cid = Number(communityId);
  const gid = optionalText(guildId);
  const caseIdNum = Number(caseId);
  const ids = { communityId: Number.isInteger(cid) ? cid : null, guildId: gid, caseId: Number.isInteger(caseIdNum) ? caseIdNum : null };
  const d = buildRunDeps(deps ?? {});
  const t0 = nowMs ?? d.now();
  const startedAt = d.now();

  // ── 1. inputs + case row (read-only) ────────────────────────────────────
  if (!Number.isInteger(cid) || cid < 1) {
    return refuseRun(ids, "A valid integer communityId is required — the run cannot start without it.");
  }
  if (!gid) {
    return refuseRun(ids, "A guildId (Discord snowflake) is required — auto-moderation is Discord-only for this milestone (#723 decision 8).");
  }
  if (!Number.isInteger(caseIdNum) || caseIdNum < 1) {
    return refuseRun(ids, "A valid integer caseId is required — one run judges exactly one recorded case.");
  }
  ids.caseId = caseIdNum;

  const loaded = (() => {
    try {
      return d.getCase(caseIdNum);
    } catch (err) {
      logFail("case load", ids, err);
      return undefined;
    }
  })();
  if (loaded === undefined) {
    return refuseRun(ids, `Could not read the case row (database error) — nothing was run.`);
  }
  if (!loaded) {
    return refuseRun(ids, `No auto-mod case row #${caseIdNum} — there is nothing to run.`);
  }
  const caseRow = loaded;
  ids.caseNumber = caseRow.case_number;
  const caseRef = `A-${caseRow.case_number}`;
  if (Number(caseRow.community_id) !== cid) {
    return refuseRun(ids, `Case ${caseRef} belongs to community ${caseRow.community_id}, not ${cid} — refusing to run a case across communities.`);
  }
  const referrerUserId = String(caseRow.referrer_user_id ?? "");

  // ── settings (modes + the automod channel) ──────────────────────────────
  const settings = d.readSettings(cid);
  if (!settings.ok) {
    return refuseRun(ids, `Could not read the automod settings: ${settings.error}`);
  }
  const modes = settings.settings.modes ?? {};
  const automodChannelId = settings.settings.channelId;

  // ── budget PRE-GATE (before any mutation; day-rollover retry stays open) ─
  const budget = (() => {
    try {
      return d.getBudget(cid, t0);
    } catch (err) {
      logFail("budget read", ids, err);
      return null;
    }
  })();
  if (!budget) {
    return refuseRun(ids, "Could not read the daily case budget (database error) — refusing to run unaccountably.");
  }
  if (budget.remaining === -1 || budget.limit <= -1) {
    return refuseRun(ids, "**Daily budget:** blocked (`-1`) — no case can run until an admin opens the budget with `/automodconfig budget`.");
  }
  if (budget.limit > 0 && budget.remaining === 0) {
    return refuseRun(ids, `**Daily budget:** exhausted — ${budget.used} of ${budget.limit} cases counted today (UTC day). The case stays recorded; the run retries after the day rolls or an admin raises the cap.`);
  }

  // ── 2. atomic claim (recorded → processing) — the status guard ──────────
  let claimed = false;
  try {
    claimed = claimProcessing(d.db, caseIdNum, t0);
  } catch (err) {
    logFail("case claim", ids, err);
    return { ok: false, state: "failed", caseRef, error: `Could not claim the case for a run (database error): ${err?.message || err}` };
  }
  if (!claimed) {
    let currentStatus = "?";
    try {
      currentStatus = d.getCase(caseIdNum)?.status ?? "?";
    } catch {
      /* display only */
    }
    return {
      ok: false,
      state: "refused",
      caseRef,
      error: `Case ${caseRef} is not runnable (status \`${currentStatus}\`) — one referral starts exactly one run.`,
    };
  }

  // ── 3. placeholder post (failure logged; the run continues) ─────────────
  let placeholder = null;
  const deliver = async (payload) => {
    if (!automodChannelId) {
      // intake required one; cleared since — logged below. #730 law: the
      // card demonstrably did not post — leave the structured record.
      card.recordCardPostError(
        caseIdNum,
        "card could not post: the automod channel setting is unset",
        { db: d.db },
      );
      return;
    }
    if (placeholder) {
      try {
        await d.editMessage(placeholder, payload);
        return;
      } catch (err) {
        logFail("placeholder edit (falling back to a fresh post)", ids, err);
      }
    }
    try {
      await d.postToChannel(automodChannelId, payload);
    } catch (err) {
      logFail("outcome post", ids, err); // degrade: the row + logs carry the truth
      // #730 send-failure law: the card did NOT post — never claim it did.
      // Log with ids and leave the structured record on the case row.
      const cause = err?.message || String(err);
      console.error(`[automod] harness ${caseRef} card post failed ${idTag(ids)}: ${cause}`);
      card.recordCardPostError(caseIdNum, `card post failed: ${cause}`, { db: d.db });
    }
  };
  if (!automodChannelId) {
    console.error(
      `[automod] harness automod channel unset ${idTag(ids)} — the outcome cannot post; the decision still runs and records.`,
    );
  } else {
    try {
      placeholder = await d.postToChannel(automodChannelId, buildReviewPlaceholderPayload(caseRow));
    } catch (err) {
      logFail("placeholder post (continuing without it)", ids, err);
      placeholder = null;
    }
  }

  /** Finish: persist metadata (070) + deliver the outcome CASE CARD, built
   *  from a FRESH ledger read (never from the in-memory commit lines — a
   *  card rebuilt after restart must look identical). */
  const finishRun = async ({
    status,
    runError = null,
    model = null,
    summaryText,
    toolNames = [],
    decisionLog = [],
    rounds = 0,
    noteRefs = {},
    extraLines = [],
    participants = null,
  }) => {
    const durationMs = d.now() - startedAt;
    // Window participants are not ledger data — persist the seen-but-not-
    // considered set as ONE structured decision_log entry so a later card
    // rebuild can replay the "**Seen, not considered:**" line (readNotConsidered).
    const persistedLog =
      participants === null
        ? decisionLog
        : [...decisionLog, card.participantsLogEntry(participants)];
    try {
      writeRunMetadata(d.db, caseIdNum, {
        status,
        model: model ?? null,
        durationMs,
        toolNames,
        decisionLog: persistedLog,
        lastRunError: runError,
      }, d.now());
    } catch (err) {
      // The outcome is already decided; a metadata failure is loud, not fatal.
      logFail("run metadata persist", ids, err);
    }
    let rows = [];
    let rowReadError = null;
    try {
      rows = d.listCaseActions(cid, caseIdNum) ?? [];
    } catch (err) {
      // The card says the ledger could not be re-read — never fakes calm.
      rowReadError = err?.message || String(err);
      logFail("action rows read (card build)", ids, err);
    }
    const subjectIds = new Set(rows.map((r) => String(r?.subject_user_id ?? "")));
    const notConsidered = (Array.isArray(participants) ? participants : [])
      .map((id) => String(id ?? "").trim())
      .filter((id) => id && !subjectIds.has(id));
    await deliver(
      card.buildCardPayload({
        caseRow,
        rows,
        meta: { model, durationMs, rounds, toolNames },
        summaryText:
          summaryText ??
          (status === "failed"
            ? `**Referred by:** <@${referrerUserId}> — automod run failed: ${runError ?? "unknown error"}`
            : `**Referred by:** <@${referrerUserId}> — review complete.`),
        failed: status === "failed",
        notConsidered,
        noteRefs,
        extraLines,
        rowReadError,
      }),
    );
    return durationMs;
  };

  // ── 4. AI config (after the claim — the referrer-visible cause is a FAILED
  //       case with zero consumption, per the #728 test contract) ──────────
  let cfg = null;
  try {
    cfg = d.aiConfig();
  } catch (err) {
    logFail("AI config read", ids, err);
  }
  if (!cfg || !cfg.apiKey) {
    const error =
      "AI not configured — no AI_API_KEY (or OPENAI_API_KEY) is set, so no provider call was made and no case was consumed. An operator must configure the provider.";
    await finishRun({ status: "failed", runError: error });
    return { ok: false, state: "failed", caseRef, error };
  }

  // ── 5. evidence bundle (#727) — its {ok:false} fails the run specifically ─
  const built = await buildCaseContext({
    communityId: cid,
    guildId: gid,
    case: caseRow,
    deps: d.contextDeps ?? {},
    nowMs: t0,
  });
  if (!built.ok) {
    await finishRun({
      status: "failed",
      runError: built.error,
      summaryText: `**Referred by:** <@${referrerUserId}> — automod could not build the case context: ${built.error}`,
      model: cfg.model,
    });
    return { ok: false, state: "failed", caseRef, error: built.error };
  }
  const context = built.context;

  // ── 6. tool rounds (schemas FROM the mode gate; intent-only during loop) ─
  // #734: the delete tool's allow-list rides the dispatcher — the case's
  // referred message + EXACTLY the window entries that were fetched. The
  // bundle is the only source (no db reads here either); anything the model
  // names outside this map refuses at dispatch with the specific cause.
  const allowedMessages = buildAllowedMessages({ caseRow, context });
  const dispatcher = createToolDispatcher({
    communityId: cid,
    guildId: gid,
    caseRow,
    modes,
    subjectUserId: context?.subject?.user_id ?? null,
    allowedMessages,
    deps: { lookupDeps: d.lookupDeps ?? {} },
  });
  const offeredActions = dispatcher.tools
    .map((t) => t?.function?.name)
    .filter((name) => AUTOMOD_ACTIONS.includes(name));

  const chatMessages = [
    {
      role: "system",
      content: buildSystemPrompt({
        rules: context.rules ?? "",
        modes,
        offeredActions,
        caseRef: context?.case?.case_ref ?? caseRef,
      }),
    },
    { role: "user", content: buildUserMessage(context) },
  ];

  let res;
  try {
    res = await d.chat(cfg, {
      messages: chatMessages,
      tools: dispatcher.tools,
      executeTool: dispatcher.executeTool,
      maxToolRounds: AUTOMOD_MAX_TOOL_ROUNDS,
      timeoutMs: AUTOMOD_RUN_TIMEOUT_MS,
    });
  } catch (err) {
    // A throwing seam is still "the provider failed": a specific cause,
    // no consumption, a failed case (rule 3).
    logFail("provider call threw", ids, err);
    res = { ok: false, reason: "network", error: `provider call threw: ${err?.message || err}`, toolCalls: 0 };
  }

  // ── 7. ACCEPTANCE → consume EXACTLY once (failed calls consume nothing) ─
  const toolCalls = Number(res?.toolCalls) || 0;
  const accepted =
    res?.ok === true || toolCalls > 0 || res?.reason === "empty" || res?.reason === "cap";
  if (accepted) {
    try {
      const consumed = d.consume(cid, d.now());
      if (consumed && consumed.ok === false) {
        // The provider call already happened — surface the accounting gap
        // loudly (the counter refused on a race: blocked/exhausted between
        // the pre-gate and acceptance). Never pretend it counted.
        console.error(
          `[automod] harness budget consume refused ${idTag(ids)}:`,
          consumed.reason ?? "unknown",
        );
      }
    } catch (err) {
      logFail("budget consume (after an accepted provider call)", ids, err);
    }
  }

  // ── 8. status/cause determination (cap commits; errors fail the case) ───
  let status = "complete";
  let runError = null;
  if (!res?.ok) {
    if (res?.reason === "cap") {
      runError = `tool-round cap (${AUTOMOD_MAX_TOOL_ROUNDS}) reached — the run committed what it had recorded`;
    } else {
      status = "failed";
      runError = `provider error: ${formatProviderCause(res)}`;
    }
  }

  // ── 9. TWO-PHASE COMMIT (nothing mutated during the rounds; from here
  //       the executor + the note pre-/post-pass own everything, #733) ────
  const commit = await commitRunIntents({
    d,
    cid,
    gid,
    caseRow,
    referrerUserId,
    dispatcher,
    modes,
    ids,
  });

  // ── 10. outcome CARD + metadata ──────────────────────────────────────────
  // Card extras: note refs from the rows the commit actually wrote, the
  // commit's non-ledger lines, and the window participants (the card shows
  // bystanders the judge saw but did not consider; the ledger rows own the
  // considered side, subtracted at finish).
  let summaryText;
  if (status === "failed") {
    // Contract naming: the referrer sees the provider's specific failure.
    summaryText = `**Referred by:** <@${referrerUserId}> — provider error: ${formatProviderCause(res)}`;
  } else if (runError) {
    summaryText =
      `**Referred by:** <@${referrerUserId}> — partial decision: the run hit the ${runError}. ` +
      "What it had recorded committed; nothing further ran.";
  } else {
    summaryText = `**Referred by:** <@${referrerUserId}> — review complete.`;
  }

  const noteRefs = {};
  for (const n of commit.noteResults) {
    // `dropped` (#731): a queued note without intent wrote NO row — the
    // user is not a card subject, only the extraLines carry the drop.
    if (n.ok && !n.dropped) noteRefs[String(n.userId)] = n.row?.note_number ?? null;
  }

  await finishRun({
    status,
    runError,
    model: cfg.model,
    summaryText,
    toolNames: dispatcher.toolNames,
    decisionLog: dispatcher.decisionLog,
    rounds: Number.isFinite(Number(res?.rounds)) ? Number(res.rounds) : toolCalls,
    noteRefs,
    extraLines: commit.extraLines,
    participants: Array.isArray(context?.participant_user_ids)
      ? context.participant_user_ids.map((id) => String(id))
      : [],
  });

  return {
    ok: status === "complete",
    state: status,
    caseRef,
    ...(runError ? { error: runError } : {}),
    commit,
  };
}

/* ── boot sweep + wiring ─────────────────────────────────────────────────── */

/**
 * Fail cases stuck in `processing` from a previous boot (the runner is
 * in-process; a restart orphans them). Best-effort channel notice naming
 * the case when the automod channel still exists — logged, never thrown.
 *
 * Synchronous DB pass + DETACHED post promises (each carries its own
 * catch), returned as `posts` so tests can await delivery; the feature
 * start hook never blocks and load.js's per-feature guard already wraps
 * the hook itself.
 *
 * @param {{client?: object, db?: object, postToChannel?: Function}} [opts]
 * @returns {{ checked: number, flipped: number, posts: Promise[] }}
 */
function sweepInterruptedRuns({ client = null, db: dbHandle = null, postToChannel = null } = {}) {
  const out = { checked: 0, flipped: 0, posts: [] };
  const handle = dbHandle ?? facadeDb;
  try {
    const rows = handle
      .prepare(`SELECT * FROM automod_cases WHERE status='processing' ORDER BY id ASC`)
      .all();
    for (const row of rows) {
      out.checked += 1;
      const ids = {
        communityId: row.community_id,
        guildId: null,
        caseId: row.id,
        caseNumber: row.case_number,
      };
      try {
        handle
          .prepare(
            `UPDATE automod_cases SET status='failed', updated_at=?, last_run_error=? WHERE id=?`,
          )
          .run(facadeNow(), INTERRUPTED_ERROR, row.id);
        out.flipped += 1;
      } catch (err) {
        logFail("boot sweep flip", ids, err);
        continue;
      }
      // Detached, best-effort, self-catching (rule 1):
      const post = (async () => {
        try {
          const channelId = (() => {
            const read = readSettings(Number(row.community_id));
            return read.ok ? read.settings.channelId : null;
          })();
          if (!channelId) return;
          const send =
            postToChannel ??
            (async (chId, payload) => {
              if (!client?.channels?.fetch) throw new Error("no Discord client for the sweep notice");
              const channel = await client.channels.fetch(String(chId));
              if (!channel?.send) throw new Error(`channel ${chId} is not sendable`);
              return channel.send(payload);
            });
          await send(channelId, buildInterruptedPayload(row));
        } catch (err) {
          logFail("boot sweep notice (best effort)", ids, err);
        }
      })();
      out.posts.push(post);
    }
    if (out.checked > 0) {
      console.log(`[automod] boot sweep: ${out.flipped}/${out.checked} case run(s) interrupted by restart marked failed.`);
    }
  } catch (err) {
    console.error("[automod] boot sweep failed:", err?.message || err);
  }
  return out;
}

/**
 * Build the refer.js run hook: the detached trigger installed on boot
 * (see index.js). It only forwards ids — the run owns every seam.
 *
 * @param {{client?: object, deps?: object}} [opts]
 * @returns {(input: {communityId: number, guildId: string, case: object}) => Promise<object>}
 */
function makeReferRunHook({ client = null, deps = {} } = {}) {
  const runDeps = { client, ...deps };
  return ({ communityId = null, guildId = null, case: caseRow = null } = {}) =>
    runAutomodCase({
      communityId,
      guildId,
      caseId: caseRow?.id ?? null,
      deps: runDeps,
    });
}

module.exports = {
  INTERRUPTED_ERROR,
  runAutomodCase,
  sweepInterruptedRuns,
  makeReferRunHook,
  makeRunDeps,
  buildRunDeps,
  // Post shapes (the outcome post itself is `card.buildCardPayload` — see
  // ./card.js; grep these in tests before changing):
  buildReviewPlaceholderPayload,
  buildInterruptedPayload,
  // Pure pieces:
  formatProviderCause,
  formatActionLine,
  commitRunIntents,
  // Staff-note layer (#731 + #733 — the PRE/POST-PASS pair is the default
  // behind `deps.prepareNotes` / `deps.reconcileNotes`; tests wrap or replace
  // the seams, and the pure pieces are pinned directly):
  prepareCaseNotes,
  reconcileCaseNotes,
  assembleAutomodNoteBody,
  noteActionEntry,
  plannedNoteEntry,
  noteStateLabel,
  plannedStateLabel,
  evidenceLink,
  automodNoteSuffix,
  // Delete tool (#734): the case-anchor + fetched-window allow-list fed to
  // the tool dispatcher (the delete tool may name nothing else).
  buildAllowedMessages,
};
